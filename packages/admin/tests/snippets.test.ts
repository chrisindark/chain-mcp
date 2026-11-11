import { describe, expect, it } from "vitest";
import { generateClientExportSnippets } from "../src/snippets.js";

describe("generateClientExportSnippets", () => {
  it("generates stdio client export snippets matching official schemas", async () => {
    const result = await generateClientExportSnippets({
      serverName: "my-petstore",
      configPath: "/workspace/petstore.yaml",
      transport: "stdio",
    });

    expect(result.ok).toBe(true);
    expect(result.serverName).toBe("my-petstore");
    expect(result.transport).toBe("stdio");

    // 1. Claude Desktop
    const claude = result.snippets.claudeDesktop;
    expect(claude.client).toBe("claude-desktop");
    expect(claude.filename).toBe("claude_desktop_config.json");
    expect(claude.configPathGuide?.darwin).toContain(
      "Library/Application Support/Claude",
    );
    expect(claude.json).toEqual({
      mcpServers: {
        "my-petstore": {
          command: "npx",
          args: [
            "-y",
            "@chainmcp/cli",
            "serve",
            "--config",
            "/workspace/petstore.yaml",
          ],
        },
      },
    });

    // 2. Cursor
    const cursor = result.snippets.cursor;
    expect(cursor.client).toBe("cursor");
    expect(cursor.filename).toBe(".cursor/mcp.json");
    expect(cursor.configPathGuide?.darwin).toBe(".cursor/mcp.json");
    expect(cursor.json).toEqual({
      mcpServers: {
        "my-petstore": {
          command: "npx",
          args: [
            "-y",
            "@chainmcp/cli",
            "serve",
            "--config",
            "/workspace/petstore.yaml",
          ],
        },
      },
    });

    // 3. Claude Code CLI
    const code = result.snippets.claudeCode;
    expect(code.client).toBe("claude-code");
    expect(code.snippet).toBe(
      'claude mcp add my-petstore -- npx -y @chainmcp/cli serve --config "/workspace/petstore.yaml"',
    );
  });

  it("generates sse client export snippets matching remote schemas", async () => {
    const result = await generateClientExportSnippets({
      serverName: "remote-gateway",
      sseUrl: "https://mcp.example.com/sse",
      transport: "sse",
    });

    expect(result.ok).toBe(true);
    expect(result.transport).toBe("sse");

    // Claude Desktop uses mcp-remote bridge for SSE
    expect(result.snippets.claudeDesktop.json).toEqual({
      mcpServers: {
        "remote-gateway": {
          command: "npx",
          args: ["-y", "mcp-remote", "https://mcp.example.com/sse"],
        },
      },
    });

    // Cursor supports native url in .cursor/mcp.json
    expect(result.snippets.cursor.json).toEqual({
      mcpServers: {
        "remote-gateway": {
          url: "https://mcp.example.com/sse",
          headers: {
            Authorization: "Bearer ${env:CHAINMCP_TOKEN}",
          },
        },
      },
    });

    // Claude Code CLI supports direct sse url
    expect(result.snippets.claudeCode.snippet).toBe(
      'claude mcp add remote-gateway "https://mcp.example.com/sse"',
    );
  });

  it("redacts literal credentials and enforces zero secret leakage", async () => {
    const rawConfigWithSecrets = {
      upstream: {
        baseUrl: "https://api.example.com",
        authentication: {
          type: "bearer",
          token: "super-secret-token-12345",
          password: "my-plain-password",
        },
      },
    };

    const result = await generateClientExportSnippets({
      serverName: "secret-server",
      configPath: "/etc/chainmcp/config.yaml",
      configObject: rawConfigWithSecrets,
      token: "ephemeral-admin-token-9999",
    });

    expect(result.ok).toBe(true);

    // Assert that raw secret values are NEVER present anywhere in snippets or output
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("super-secret-token-12345");
    expect(serialized).not.toContain("my-plain-password");
    expect(serialized).not.toContain("ephemeral-admin-token-9999");

    // Assert redacted config has secrets replaced
    if (result.redactedConfig) {
      const redactedStr = JSON.stringify(result.redactedConfig);
      expect(redactedStr).toContain("[REDACTED]");
      expect(redactedStr).not.toContain("super-secret-token-12345");
      expect(redactedStr).not.toContain("my-plain-password");
    }

    // Assert token instruction does not leak the token value
    const tokenInst = result.envInstructions.find(
      (i) => i.variable === "CHAINMCP_TOKEN",
    );
    expect(tokenInst).toBeDefined();
    expect(tokenInst?.bashExport).not.toContain("ephemeral-admin-token-9999");
    expect(tokenInst?.bashExport).toContain("your-chainmcp-token-here");
  });

  it("discovers environment variable references and provides secure host setup instructions", async () => {
    const configWithEnvRefs = {
      upstream: {
        baseUrl: "https://api.example.com",
        authentication: {
          type: "apiKey",
          key: "${API_KEY_SECRET}",
        },
      },
      destination: {
        header: "${CUSTOM_HEADER_AUTH}",
      },
    };

    const result = await generateClientExportSnippets({
      serverName: "env-server",
      configPath: "/workspace/config.yaml",
      configObject: configWithEnvRefs,
    });

    expect(result.ok).toBe(true);

    // Environment variables discovered
    const varNames = result.envInstructions.map((i) => i.variable);
    expect(varNames).toContain("API_KEY_SECRET");

    // Check envInstructions format for bash and PowerShell
    const apiKeyInst = result.envInstructions.find(
      (i) => i.variable === "API_KEY_SECRET",
    );
    expect(apiKeyInst).toBeDefined();
    expect(apiKeyInst?.bashExport).toBe(
      'export API_KEY_SECRET="your-api_key_secret-here"',
    );
    expect(apiKeyInst?.powershellExport).toBe(
      '$env:API_KEY_SECRET="your-api_key_secret-here"',
    );

    // Claude Desktop maps env
    const claudeJson = result.snippets.claudeDesktop.json as {
      mcpServers: { [key: string]: { env: Record<string, string> } };
    };
    expect(claudeJson.mcpServers["env-server"]?.env?.API_KEY_SECRET).toBe(
      "${API_KEY_SECRET}",
    );

    // Cursor maps env with ${env:VAR}
    const cursorJson = result.snippets.cursor.json as {
      mcpServers: { [key: string]: { env: Record<string, string> } };
    };
    expect(cursorJson.mcpServers["env-server"]?.env?.API_KEY_SECRET).toBe(
      "${env:API_KEY_SECRET}",
    );

    // Claude Code CLI flags include -e
    expect(result.snippets.claudeCode.snippet).toContain(
      '-e API_KEY_SECRET="${API_KEY_SECRET}"',
    );
  });

  it("sanitizes invalid characters from serverName", async () => {
    const result = await generateClientExportSnippets({
      serverName: "invalid name with spaces & symbols!",
    });
    expect(result.serverName).toBe("invalid-name-with-spaces---symbols-");
  });
});

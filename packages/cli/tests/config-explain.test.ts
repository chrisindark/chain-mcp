import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { configExplainCommand } from "../src/commands/config.js";
import { loadGatewayConfig } from "../src/commands/gateway-serve.js";
import { validateCommand } from "../src/commands/validate.js";
import { runCli } from "../src/cli.js";
import { renderServerTs } from "../src/templates.js";

const CONFIG_WITH_SECRETS = `version: 1
name: catalog
security:
  allowedUpstreamHosts:
    - api.example.com
auth:
  inbound:
    requireInboundAuth: true
    tokens:
      "\${INBOUND_TOKEN}":
        tenantId: tenant-1
        principalId: client-1
  upstream:
    providers:
      - type: oauth
        tokenUrl: https://auth.example.com/token
        clientId: client-id
        clientSecret: "\${OAUTH_CLIENT_SECRET}"
`;

describe("chainmcp config explain", () => {
  let tempDir: string;
  let configPath: string;
  let specPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "chainmcp-config-explain-"));
    configPath = join(tempDir, "chainmcp.config.yaml");
    specPath = join(tempDir, "openapi.yaml");
    await writeFile(configPath, CONFIG_WITH_SECRETS, "utf8");
    await writeFile(
      specPath,
      `openapi: "3.1.0"
info:
  title: Catalog
  version: "1.0.0"
servers:
  - url: https://api.example.com
paths:
  /items:
    get:
      operationId: listItems
      responses:
        "200":
          description: OK
`,
      "utf8",
    );
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns a redacted config and value-free secret provenance", async () => {
    const result = await configExplainCommand({
      cwd: tempDir,
      env: {
        INBOUND_TOKEN: "super-secret-token",
        OAUTH_CLIENT_SECRET: "super-secret-client",
      },
    });

    expect(result.ok).toBe(true);
    expect(result.configPath).toBe(configPath);

    const serialized = JSON.stringify(result.config);
    expect(serialized).not.toContain("super-secret-token");
    expect(serialized).not.toContain("super-secret-client");
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).toContain("[REDACTED:1]");

    expect(result.secretSources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "auth.inbound.tokens[#1]",
          variables: ["INBOUND_TOKEN"],
          literal: false,
        }),
        expect.objectContaining({
          field: "auth.upstream.providers[0].clientSecret",
          variables: ["OAUTH_CLIENT_SECRET"],
          literal: false,
        }),
      ]),
    );
  });

  it("fails with the field and variable when a secret is missing", async () => {
    const result = await configExplainCommand({
      cwd: tempDir,
      env: { INBOUND_TOKEN: "super-secret-token" },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("[SECRET_UNRESOLVED]");
    expect(result.error).toContain("auth.upstream.providers[0].clientSecret");
    expect(result.error).toContain("OAUTH_CLIENT_SECRET");
    expect(result.error).not.toContain("super-secret-token");
  });

  it("prints no secret values to stdout", async () => {
    vi.stubEnv("INBOUND_TOKEN", "super-secret-token");
    vi.stubEnv("OAUTH_CLIENT_SECRET", "super-secret-client");

    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runCli(["config", "explain", "--config", configPath], {
      stdout: (msg) => stdout.push(msg),
      stderr: (msg) => stderr.push(msg),
    });

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    const output = stdout.join("\n");
    expect(output).not.toContain("super-secret-token");
    expect(output).not.toContain("super-secret-client");
    expect(output).toContain("[REDACTED]");
    expect(output).toContain("${INBOUND_TOKEN}");
    expect(output).toContain("${OAUTH_CLIENT_SECRET}");
  });

  it("emits redacted JSON with --json", async () => {
    vi.stubEnv("INBOUND_TOKEN", "super-secret-token");
    vi.stubEnv("OAUTH_CLIENT_SECRET", "super-secret-client");

    const stdout: string[] = [];
    const code = await runCli(
      ["config", "explain", "--config", configPath, "--json"],
      { stdout: (msg) => stdout.push(msg), stderr: () => undefined },
    );

    expect(code).toBe(0);
    const parsed = JSON.parse(stdout.join("\n")) as {
      config: unknown;
      secretSources: unknown[];
    };
    const serialized = JSON.stringify(parsed.config);
    expect(serialized).not.toContain("super-secret-token");
    expect(serialized).not.toContain("super-secret-client");
    expect(parsed.secretSources).toHaveLength(2);
  });

  it("exits non-zero when a referenced variable is missing", async () => {
    vi.stubEnv("INBOUND_TOKEN", "super-secret-token");

    const stderr: string[] = [];
    const code = await runCli(["config", "explain", "--config", configPath], {
      stdout: () => undefined,
      stderr: (msg) => stderr.push(msg),
    });

    expect(code).toBe(1);
    expect(stderr.join("\n")).toContain("OAUTH_CLIENT_SECRET");
  });

  it("rejects unknown subcommands", async () => {
    const stderr: string[] = [];
    const code = await runCli(["config", "print"], {
      stdout: () => undefined,
      stderr: (msg) => stderr.push(msg),
    });

    expect(code).toBe(1);
    expect(stderr.join("\n")).toContain("Expected 'chainmcp config explain'");
  });
});

describe("secret resolution in config loaders", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "chainmcp-secret-loaders-"));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("validateCommand resolves inbound tokens before schema validation", async () => {
    const configPath = join(tempDir, "chainmcp.config.yaml");
    const specPath = join(tempDir, "openapi.yaml");
    await writeFile(configPath, CONFIG_WITH_SECRETS, "utf8");
    await writeFile(
      specPath,
      `openapi: "3.1.0"
info:
  title: Catalog
  version: "1.0.0"
servers:
  - url: https://api.example.com
paths:
  /items:
    get:
      operationId: listItems
      responses:
        "200":
          description: OK
`,
      "utf8",
    );
    vi.stubEnv("INBOUND_TOKEN", "resolved-token");
    vi.stubEnv("OAUTH_CLIENT_SECRET", "resolved-client");

    const result = await validateCommand({ cwd: tempDir });

    expect(result.ok).toBe(true);
    expect(Object.keys(result.config?.auth.inbound.tokens ?? {})).toEqual([
      "resolved-token",
    ]);
    expect(result.config?.auth.upstream.providers[0]).toMatchObject({
      clientSecret: "resolved-client",
    });
  });

  it("validateCommand reports SECRET_UNRESOLVED for a missing variable", async () => {
    const configPath = join(tempDir, "chainmcp.config.yaml");
    await writeFile(
      configPath,
      `version: 1
name: catalog
security:
  allowedUpstreamHosts:
    - api.example.com
auth:
  inbound:
    jwt:
      secret: "\${MISSING_JWT_SECRET}"
`,
      "utf8",
    );

    const result = await validateCommand({ cwd: tempDir });
    const diagnostic = result.diagnostics.find(
      (entry) => entry.code === "SECRET_UNRESOLVED",
    );

    expect(result.ok).toBe(false);
    expect(diagnostic?.message).toContain("MISSING_JWT_SECRET");
    expect(diagnostic?.message).toContain("auth.inbound.jwt.secret");
  });

  it("loadGatewayConfig resolves OAuth client secrets", async () => {
    const gatewayPath = join(tempDir, "gateway.config.yaml");
    await writeFile(
      gatewayPath,
      `version: 1
name: gateway
auth:
  upstream:
    providers:
      - type: oauth
        tokenUrl: https://auth.example.com/token
        clientId: client-id
        clientSecret: "\${GATEWAY_CLIENT_SECRET}"
`,
      "utf8",
    );
    vi.stubEnv("GATEWAY_CLIENT_SECRET", "gateway-secret");

    const { config } = await loadGatewayConfig(gatewayPath);

    expect(config.auth.upstream.providers[0]).toMatchObject({
      type: "oauth",
      clientSecret: "gateway-secret",
    });
  });

  it("generated servers resolve secrets before parsing config", () => {
    const source = renderServerTs({ version: "9.9.9" });
    expect(source).toContain("resolveConfigSecrets(rawConfig).config");
  });
});

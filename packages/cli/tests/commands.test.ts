import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildCommand } from "../src/commands/build.js";
import { devCommand } from "../src/commands/dev.js";
import { diffCommand } from "../src/commands/diff.js";
import { exportCommand } from "../src/commands/export.js";
import { gatewayServeCommand } from "../src/commands/gateway-serve.js";
import { initCommand } from "../src/commands/init.js";
import { serveCommand } from "../src/commands/serve.js";
import { validateCommand } from "./../src/commands/validate.js";

const SAMPLE_SPEC = `
openapi: "3.1.0"
info:
  title: Pet Catalog API
  version: "1.0.0"
servers:
  - url: https://api.petstore.test/v1
paths:
  /pets:
    get:
      operationId: listPets
      summary: List all pets
      responses:
        "200":
          description: A list of pets
          content:
            application/json:
              schema:
                type: array
                items:
                  type: object
                  properties:
                    id:
                      type: string
`;

describe("CLI Commands", () => {
  let tempDir: string;
  let specPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "chainmcp-cli-test-"));
    specPath = join(tempDir, "openapi.yaml");
    await writeFile(specPath, SAMPLE_SPEC, "utf8");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("initCommand", () => {
    it("scaffolds a new project from an OpenAPI spec", async () => {
      const targetDir = join(tempDir, "my-server");
      const result = await initCommand({
        spec: specPath,
        output: targetDir,
        cwd: tempDir,
      });

      expect(result.ok).toBe(true);
      expect(result.projectName).toBe("pet-catalog-api");
      expect(result.toolCount).toBe(1);
      expect(result.createdFiles).toContain("chainmcp.config.yaml");
      expect(result.createdFiles).toContain("package.json");
      expect(result.createdFiles).toContain("src/server.ts");
      expect(result.createdFiles).toContain("Dockerfile");
      expect(result.createdFiles).toContain("README.md");

      const configText = await readFile(
        join(targetDir, "chainmcp.config.yaml"),
        "utf8",
      );
      expect(configText).toContain("name: pet-catalog-api");
      expect(configText).toContain("api.petstore.test");
    });

    it("fails if target already has config without --force", async () => {
      const targetDir = join(tempDir, "existing");
      await initCommand({
        spec: specPath,
        output: targetDir,
        cwd: tempDir,
      });

      const second = await initCommand({
        spec: specPath,
        output: targetDir,
        cwd: tempDir,
      });

      expect(second.ok).toBe(false);
      expect(second.error).toContain("already contains");

      const forced = await initCommand({
        spec: specPath,
        output: targetDir,
        force: true,
        cwd: tempDir,
      });
      expect(forced.ok).toBe(true);
    });

    it("fails if spec does not exist", async () => {
      const result = await initCommand({
        spec: join(tempDir, "nonexistent.yaml"),
        cwd: tempDir,
      });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("was not found");
    });

    it("scaffolds a blank code-first project with --blank and no contract", async () => {
      const targetDir = join(tempDir, "blank-server");
      const result = await initCommand({
        blank: true,
        output: targetDir,
        name: "my-code-first-server",
        cwd: tempDir,
      });

      expect(result.ok).toBe(true);
      expect(result.projectName).toBe("my-code-first-server");
      expect(result.toolCount).toBe(1);
      expect(result.specPath).toBe("");
      expect(result.createdFiles).toContain("chainmcp.config.yaml");
      expect(result.createdFiles).toContain("package.json");
      expect(result.createdFiles).toContain("src/tools.ts");
      expect(result.createdFiles).toContain("src/server.ts");
      expect(result.createdFiles).not.toContain("spec/openapi.yaml");

      // Verify chainmcp.config.yaml has no contract section
      const configText = await readFile(
        join(targetDir, "chainmcp.config.yaml"),
        "utf8",
      );
      expect(configText).toContain("name: my-code-first-server");
      expect(configText).not.toContain("contract:");

      // Verify src/tools.ts contains defineTool and greet tool
      const toolsText = await readFile(
        join(targetDir, "src", "tools.ts"),
        "utf8",
      );
      expect(toolsText).toContain(
        'import { defineTool } from "@chainmcp/authoring";',
      );
      expect(toolsText).toContain("greetTool");

      // Verify package.json contains authoring and zod
      const pkgText = await readFile(join(targetDir, "package.json"), "utf8");
      expect(pkgText).toContain("@chainmcp/authoring");
      expect(pkgText).toContain("zod");
    });
  });

  describe("validateCommand", () => {
    it("validates a project configuration and contract", async () => {
      const targetDir = join(tempDir, "validate-test");
      await initCommand({
        spec: specPath,
        output: targetDir,
        cwd: tempDir,
      });

      const result = await validateCommand({
        cwd: targetDir,
      });

      expect(result.ok).toBe(true);
      expect(result.toolCount).toBe(1);
      expect(result.toolNames).toContain("listPets");
      expect(result.contractRevision).toBeDefined();
      expect(result.toolsetHash).toBeDefined();
    });

    it("reports diagnostics when contract contains errors", async () => {
      const badSpec = join(tempDir, "bad-spec.yaml");
      await writeFile(
        badSpec,
        `
openapi: "3.1.0"
info:
  title: Bad API
  version: "1.0.0"
paths:
  /pets:
    get:
      responses:
        invalid_code:
          description: error
`,
        "utf8",
      );

      const result = await validateCommand({
        spec: badSpec,
        cwd: tempDir,
      });

      expect(result.ok).toBe(false);
      expect(result.diagnostics.length).toBeGreaterThan(0);
    });

    it("warns when security.allowedUpstreamHosts is empty", async () => {
      const emptySecurityConfig = join(tempDir, "chainmcp.config.yaml");
      await writeFile(
        emptySecurityConfig,
        `
version: 1
name: test
contract:
  source: ./openapi.yaml
security:
  allowedUpstreamHosts: []
`,
        "utf8",
      );

      const result = await validateCommand({
        config: emptySecurityConfig,
        spec: specPath,
        cwd: tempDir,
      });

      expect(result.ok).toBe(true);
      expect(
        result.diagnostics.some(
          (d) =>
            d.severity === "warning" &&
            d.message.includes("allowedUpstreamHosts is empty"),
        ),
      ).toBe(true);
    });
  });

  describe("buildCommand", () => {
    it("compiles contract and produces manifest and tools JSON", async () => {
      const targetDir = join(tempDir, "build-test");
      await initCommand({
        spec: specPath,
        output: targetDir,
        cwd: tempDir,
      });

      const outDir = join(targetDir, "dist");
      const buildResult = await buildCommand({
        cwd: targetDir,
        outDir,
      });

      expect(buildResult.ok).toBe(true);
      expect(buildResult.toolCount).toBe(1);
      expect(buildResult.manifest.toolCount).toBe(1);
      expect(buildResult.manifest.tools[0]?.name).toBe("listPets");

      const manifestOnDisk = JSON.parse(
        await readFile(join(outDir, "chainmcp.manifest.json"), "utf8"),
      );
      expect(manifestOnDisk.toolsetHash).toBe(buildResult.manifest.toolsetHash);
    });

    it("verifies reproducibility with --check", async () => {
      const targetDir = join(tempDir, "repro-build");
      await initCommand({
        spec: specPath,
        output: targetDir,
        cwd: tempDir,
      });

      const outDir = join(targetDir, "dist");
      // First build
      await buildCommand({ cwd: targetDir, outDir });

      // Second build with --check
      const checkResult = await buildCommand({
        cwd: targetDir,
        outDir,
        check: true,
      });
      expect(checkResult.ok).toBe(true);
      expect(checkResult.verifiedReproducible).toBe(true);
    });

    it("fails reproducibility check when manifest is tampered with", async () => {
      const targetDir = join(tempDir, "tampered-build");
      await initCommand({
        spec: specPath,
        output: targetDir,
        cwd: tempDir,
      });

      const outDir = join(targetDir, "dist");
      await buildCommand({ cwd: targetDir, outDir });

      // Tamper manifest
      const manifestPath = join(outDir, "chainmcp.manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      manifest.sourceHash =
        "0000000000000000000000000000000000000000000000000000000000000000";
      await writeFile(manifestPath, JSON.stringify(manifest), "utf8");

      const tamperedCheck = await buildCommand({
        cwd: targetDir,
        outDir,
        check: true,
      });
      expect(tamperedCheck.ok).toBe(false);
      expect(tamperedCheck.error).toContain("Reproducibility check failed");
    });
  });

  describe("exportCommand", () => {
    it("exports a portable, standalone server project", async () => {
      const exportDir = join(tempDir, "exported-server");
      const exportResult = await exportCommand({
        spec: specPath,
        output: exportDir,
        check: true,
        cwd: tempDir,
      });

      expect(exportResult.ok).toBe(true);
      expect(exportResult.verifiedReproducible).toBe(true);
      expect(exportResult.filesWritten).toContain("spec/openapi.yaml");
      expect(exportResult.filesWritten).toContain("chainmcp.manifest.json");
      expect(exportResult.filesWritten).toContain("chainmcp.config.yaml");
      expect(exportResult.filesWritten).toContain("src/server.ts");
      expect(exportResult.filesWritten).toContain("Dockerfile");
      expect(exportResult.filesWritten).toContain("package.json");

      const manifestContent = JSON.parse(
        await readFile(join(exportDir, "chainmcp.manifest.json"), "utf8"),
      );
      expect(manifestContent.manifestVersion).toBe(1);
      expect(manifestContent.toolCount).toBe(1);
      expect(manifestContent.tools[0].name).toBe("listPets");
    });

    it("fails if target is not empty without --force", async () => {
      const exportDir = join(tempDir, "non-empty-export");
      await exportCommand({
        spec: specPath,
        output: exportDir,
        cwd: tempDir,
      });

      const failResult = await exportCommand({
        spec: specPath,
        output: exportDir,
        cwd: tempDir,
      });
      expect(failResult.ok).toBe(false);
      expect(failResult.error).toContain("is not empty");

      const forceResult = await exportCommand({
        spec: specPath,
        output: exportDir,
        force: true,
        cwd: tempDir,
      });
      expect(forceResult.ok).toBe(true);
    });
  });

  describe("serveCommand", () => {
    it("serves stdio transport with mock streams and shuts down cleanly", async () => {
      const targetDir = join(tempDir, "serve-test");
      await initCommand({
        spec: specPath,
        output: targetDir,
        cwd: tempDir,
      });

      const stdin = new PassThrough();
      const stdout = new PassThrough();

      const serverHandle = await serveCommand({
        cwd: targetDir,
        stdin,
        stdout,
      });

      expect(serverHandle.ok).toBe(true);
      expect(serverHandle.serverName).toBe("pet-catalog-api");
      // 1 API tool + 4 JSON navigation tools = 5 tools
      expect(serverHandle.toolCount).toBe(5);

      // Close server
      await serverHandle.close();
      await serverHandle.closed;
    });

    it("refuses to bind HTTP server to non-loopback host without authentication", async () => {
      const targetDir = join(tempDir, "serve-http-fail-closed");
      await initCommand({
        spec: specPath,
        output: targetDir,
        cwd: tempDir,
      });

      await expect(
        serveCommand({
          cwd: targetDir,
          transport: "http",
          host: "0.0.0.0",
          port: 0,
        }),
      ).rejects.toThrow(
        /Refusing to bind HTTP server to non-loopback host "0\.0\.0\.0" without authentication.*security\.allowUnauthenticatedHttp/,
      );
    });

    it("starts HTTP server on non-loopback host when allowUnauthenticatedHttp is true and warns", async () => {
      const targetDir = join(tempDir, "serve-http-allow-unauth");
      await initCommand({
        spec: specPath,
        output: targetDir,
        cwd: tempDir,
      });

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const serverHandle = await serveCommand({
          cwd: targetDir,
          transport: "http",
          host: "0.0.0.0",
          port: 0,
          allowUnauthenticatedHttp: true,
        });

        expect(serverHandle.ok).toBe(true);
        expect(serverHandle.url).toBeDefined();
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining("[SECURITY WARNING]"),
        );

        await serverHandle.close();
        await serverHandle.closed;
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("starts HTTP server on loopback host without auth and warns", async () => {
      const targetDir = join(tempDir, "serve-http-loopback");
      await initCommand({
        spec: specPath,
        output: targetDir,
        cwd: tempDir,
      });

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const serverHandle = await serveCommand({
          cwd: targetDir,
          transport: "http",
          host: "127.0.0.1",
          port: 0,
        });

        expect(serverHandle.ok).toBe(true);
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining("[SECURITY WARNING]"),
        );

        await serverHandle.close();
        await serverHandle.closed;
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("fails fast at startup when requireInboundAuth is true but no verifier is provided", async () => {
      const targetDir = join(tempDir, "serve-http-no-verifier");
      await initCommand({
        spec: specPath,
        output: targetDir,
        cwd: tempDir,
      });

      const configPath = join(targetDir, "chainmcp.config.yaml");
      const configYaml = `
version: 1
name: test-auth-server
contract:
  source: ./spec/openapi.yaml
security:
  requireInboundAuth: true
  allowedUpstreamHosts:
    - api.petstore.test
auth:
  inbound:
    authorizer: none
`;
      await writeFile(configPath, configYaml, "utf8");

      await expect(
        serveCommand({
          cwd: targetDir,
          transport: "http",
          port: 0,
        }),
      ).rejects.toThrow(
        /HTTP inbound authentication is required \("security\.requireInboundAuth: true"\), but no inbound verifier is configured/,
      );
    });

    it("fails fast at startup when authorizer is scope but no verifier is provided", async () => {
      const targetDir = join(tempDir, "serve-http-scope-no-verifier");
      await initCommand({
        spec: specPath,
        output: targetDir,
        cwd: tempDir,
      });

      const configPath = join(targetDir, "chainmcp.config.yaml");
      const configYaml = `
version: 1
name: test-auth-server
contract:
  source: ./spec/openapi.yaml
security:
  requireInboundAuth: true
  allowedUpstreamHosts:
    - api.petstore.test
auth:
  inbound:
    authorizer: scope
`;
      await writeFile(configPath, configYaml, "utf8");

      await expect(
        serveCommand({
          cwd: targetDir,
          transport: "http",
          port: 0,
        }),
      ).rejects.toThrow(
        /Inbound authorizer is configured as "scope", but no inbound verifier is configured\. Scope authorization requires an authenticated principal/,
      );
    });
  });

  describe("devCommand", () => {
    it("starts dev server and registers custom programmatic tools and JSON navigation", async () => {
      const stdin = new PassThrough();
      const stdout = new PassThrough();

      const customTool = {
        name: "test_dev_tool",
        description: "Test dev tool",
        inputSchema: { type: "object", additionalProperties: false },
        operation: {},
        execute: async () => ({ status: "dev_ok" }),
      };

      const devHandle = await devCommand({
        cwd: tempDir,
        tools: [customTool],
        stdin,
        stdout,
      });

      expect(devHandle.ok).toBe(true);
      expect(devHandle.toolNames).toContain("test_dev_tool");
      // 1 custom tool + 4 JSON navigation tools = 5 tools
      expect(devHandle.toolCount).toBe(5);

      await devHandle.close();
      await devHandle.closed;
    });
  });

  describe("gatewayServeCommand", () => {
    it("loads gateway configuration, publishes contracts, and serves over stdio", async () => {
      const specFile = join(tempDir, "service.yaml");
      await writeFile(specFile, SAMPLE_SPEC, "utf8");

      const gwConfigFile = join(tempDir, "gateway.config.yaml");
      const gwConfig = `
version: 1
name: test-dynamic-gw
server:
  transport: stdio
contracts:
  - name: pets
    tenantId: tenant-alpha
    spec: service.yaml
    destination:
      baseUrl: https://api.petstore.test
      allowedHosts:
        - api.petstore.test
`;
      await writeFile(gwConfigFile, gwConfig, "utf8");

      const stdin = new PassThrough();
      const stdout = new PassThrough();

      const gwHandle = await gatewayServeCommand({
        cwd: tempDir,
        config: "gateway.config.yaml",
        stdin,
        stdout,
      });

      expect(gwHandle.ok).toBe(true);
      expect(gwHandle.serverName).toBe("test-dynamic-gw");
      expect(gwHandle.contractCount).toBe(1);
      expect(gwHandle.totalToolCount).toBe(1);

      await gwHandle.close();
      await gwHandle.closed;
    });

    it("serves gateway over HTTP transport with health check", async () => {
      const specFile = join(tempDir, "service.yaml");
      await writeFile(specFile, SAMPLE_SPEC, "utf8");

      const gwConfigFile = join(tempDir, "gateway.config.yaml");
      const gwConfig = `
version: 1
name: test-http-gw
server:
  transport: http
  port: 3333
  host: 127.0.0.1
  path: /mcp
contracts:
  - name: pets
    tenantId: tenant-alpha
    spec: service.yaml
    destination:
      baseUrl: https://api.petstore.test
      allowedHosts:
        - api.petstore.test
`;
      await writeFile(gwConfigFile, gwConfig, "utf8");

      const gwHandle = await gatewayServeCommand({
        cwd: tempDir,
        config: "gateway.config.yaml",
        port: 0,
      });

      expect(gwHandle.ok).toBe(true);
      expect(gwHandle.url).toBeDefined();

      // Test /health endpoint
      const healthUrl = new URL("/health", gwHandle.url!);
      const res = await fetch(healthUrl.toString());
      expect(res.status).toBe(200);
      const json = (await res.json()) as { status: string };
      expect(json.status).toBe("ok");

      await gwHandle.close();
      await gwHandle.closed;
    });

    it("refuses to bind gateway to non-loopback host without authentication", async () => {
      const specFile = join(tempDir, "service-gw-fail.yaml");
      await writeFile(specFile, SAMPLE_SPEC, "utf8");

      const gwConfigFile = join(tempDir, "gateway-fail-closed.config.yaml");
      const gwConfig = `
version: 1
name: test-fail-gw
server:
  transport: http
  port: 3333
  host: 0.0.0.0
contracts:
  - name: pets
    tenantId: tenant-alpha
    spec: service-gw-fail.yaml
    destination:
      baseUrl: https://api.petstore.test
      allowedHosts:
        - api.petstore.test
`;
      await writeFile(gwConfigFile, gwConfig, "utf8");

      await expect(
        gatewayServeCommand({
          cwd: tempDir,
          config: "gateway-fail-closed.config.yaml",
          port: 0,
        }),
      ).rejects.toThrow(
        /Refusing to bind HTTP server to non-loopback host "0\.0\.0\.0" without authentication.*security\.allowUnauthenticatedHttp/,
      );
    });

    it("starts gateway on non-loopback host when allowUnauthenticatedHttp is true and warns", async () => {
      const specFile = join(tempDir, "service-gw-allow.yaml");
      await writeFile(specFile, SAMPLE_SPEC, "utf8");

      const gwConfigFile = join(tempDir, "gateway-allow-unauth.config.yaml");
      const gwConfig = `
version: 1
name: test-allow-gw
server:
  transport: http
  port: 3333
  host: 0.0.0.0
security:
  allowUnauthenticatedHttp: true
contracts:
  - name: pets
    tenantId: tenant-alpha
    spec: service-gw-allow.yaml
    destination:
      baseUrl: https://api.petstore.test
      allowedHosts:
        - api.petstore.test
`;
      await writeFile(gwConfigFile, gwConfig, "utf8");

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const gwHandle = await gatewayServeCommand({
          cwd: tempDir,
          config: "gateway-allow-unauth.config.yaml",
          port: 0,
        });

        expect(gwHandle.ok).toBe(true);
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining("[SECURITY WARNING]"),
        );

        await gwHandle.close();
        await gwHandle.closed;
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("fails fast when gateway config has requireInboundAuth: true without verifier", async () => {
      const specFile = join(tempDir, "service-gw-no-verifier.yaml");
      await writeFile(specFile, SAMPLE_SPEC, "utf8");

      const gwConfigFile = join(tempDir, "gateway-no-verifier.config.yaml");
      const gwConfig = `
version: 1
name: test-no-verifier-gw
server:
  transport: http
  port: 3333
  host: 127.0.0.1
security:
  requireInboundAuth: true
  allowedUpstreamHosts:
    - api.petstore.test
contracts:
  - name: pets
    tenantId: tenant-alpha
    spec: service-gw-no-verifier.yaml
    destination:
      baseUrl: https://api.petstore.test
      allowedHosts:
        - api.petstore.test
`;
      await writeFile(gwConfigFile, gwConfig, "utf8");

      await expect(
        gatewayServeCommand({
          cwd: tempDir,
          config: "gateway-no-verifier.config.yaml",
          port: 0,
        }),
      ).rejects.toThrow(
        /Inbound authorizer is configured as "scope", but no inbound verifier is configured|HTTP inbound authentication is required/,
      );
    });
  });

  describe("diffCommand and URL specifications", () => {
    let mockServer: ReturnType<typeof createServer>;
    let mockUrl: string;

    beforeEach(async () => {
      mockServer = createServer((req, res) => {
        if (req.url === "/openapi.yaml") {
          res.writeHead(200, { "Content-Type": "application/yaml" });
          res.end(SAMPLE_SPEC);
        } else if (req.url === "/modified.yaml") {
          const modified = SAMPLE_SPEC.replace(
            "operationId: listPets",
            "operationId: listAllPets",
          );
          res.writeHead(200, { "Content-Type": "application/yaml" });
          res.end(modified);
        } else {
          res.writeHead(404);
          res.end("Not Found");
        }
      });

      await new Promise<void>((resolve) => {
        mockServer.listen(0, "127.0.0.1", () => resolve());
      });

      const addr = mockServer.address() as { port: number };
      mockUrl = `http://127.0.0.1:${addr.port}`;
    });

    afterEach(async () => {
      await new Promise<void>((resolve) => mockServer.close(() => resolve()));
    });

    it("fetches OpenAPI specification from URL in initCommand", async () => {
      const targetDir = join(tempDir, "url-init-project");
      const result = await initCommand({
        spec: `${mockUrl}/openapi.yaml`,
        output: targetDir,
        cwd: tempDir,
      });

      expect(result.ok).toBe(true);
      expect(result.toolCount).toBe(1);
      const copiedSpec = await readFile(
        join(targetDir, "spec", "openapi.yaml"),
        "utf8",
      );
      expect(copiedSpec).toContain("listPets");
    });

    it("fetches OpenAPI specification from URL in validateCommand", async () => {
      const result = await validateCommand({
        spec: `${mockUrl}/openapi.yaml`,
        cwd: tempDir,
      });

      expect(result.ok).toBe(true);
      expect(result.toolCount).toBe(1);
      expect(result.toolNames).toContain("listPets");
    });

    it("diffs contract with no baseline", async () => {
      const result = await diffCommand({
        spec: specPath,
        cwd: tempDir,
      });

      expect(result.ok).toBe(true);
      expect(result.hasChanges).toBe(false);
      expect(result.hasBreakingChanges).toBe(false);
      expect(result.addedTools).toContain("listPets");
    });

    it("diffs identical specs with against option", async () => {
      const result = await diffCommand({
        spec: specPath,
        against: specPath,
        cwd: tempDir,
      });

      expect(result.ok).toBe(true);
      expect(result.hasChanges).toBe(false);
      expect(result.hasBreakingChanges).toBe(false);
      expect(result.unchangedTools).toContain("listPets");
      expect(result.addedTools).toHaveLength(0);
      expect(result.removedTools).toHaveLength(0);
    });

    it("detects tool changes and breaking deletions against baseline manifest", async () => {
      const baselineManifest = {
        manifestVersion: 1,
        openapiVersion: "3.1.0",
        toolsetHash: "dummy-hash",
        toolCount: 2,
        tools: [
          { name: "listPets", hash: "hash-old" },
          { name: "deletePet", hash: "hash-delete" },
        ],
      };
      const baselinePath = join(tempDir, "baseline-manifest.json");
      await writeFile(baselinePath, JSON.stringify(baselineManifest), "utf8");

      const result = await diffCommand({
        spec: specPath,
        against: "baseline-manifest.json",
        cwd: tempDir,
      });

      expect(result.ok).toBe(true);
      expect(result.hasChanges).toBe(true);
      expect(result.hasBreakingChanges).toBe(true);
      expect(result.removedTools).toContain("deletePet");
    });

    it("diffs against a remote spec URL", async () => {
      const result = await diffCommand({
        spec: specPath,
        against: `${mockUrl}/modified.yaml`,
        cwd: tempDir,
      });

      expect(result.ok).toBe(true);
      expect(result.hasChanges).toBe(true);
      expect(result.addedTools).toContain("listPets");
      expect(result.removedTools).toContain("listAllPets");
    });
  });
});

import * as http from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  gatewayServeCommand,
  resolveGatewayConfigFile,
} from "../src/commands/gateway-serve.js";
import { exportCommand } from "../src/commands/export.js";
import { loadSpec } from "../src/spec-loader.js";

const SAMPLE_SPEC = `
openapi: "3.1.0"
info:
  title: Pet API
  version: "1.0.0"
servers:
  - url: https://api.petstore.test/v1
paths:
  /pets:
    get:
      operationId: listPets
      responses:
        "200":
          description: OK
`;

describe("spec-loader and gateway-serve additional coverage", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "chainmcp-cli-extra-"));
  });

  afterEach(async () => {
    delete process.env.CHAINMCP_GATEWAY_CONFIG;
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("resolveGatewayConfigFile", () => {
    it("throws if explicit path does not exist", async () => {
      await expect(
        resolveGatewayConfigFile("nonexistent.yaml", tempDir),
      ).rejects.toThrow(/Gateway config file not found/);
    });

    it("resolves from CHAINMCP_GATEWAY_CONFIG environment variable if present", async () => {
      const customConfig = join(tempDir, "custom-gw.yaml");
      await writeFile(customConfig, "version: 1\n", "utf8");
      process.env.CHAINMCP_GATEWAY_CONFIG = "custom-gw.yaml";

      const resolved = await resolveGatewayConfigFile(undefined, tempDir);
      expect(resolved).toBe(customConfig);
    });

    it("throws if no candidate gateway config file exists in cwd", async () => {
      await expect(
        resolveGatewayConfigFile(undefined, tempDir),
      ).rejects.toThrow(/No gateway configuration found in/);
    });
  });

  describe("gatewayServeCommand edge cases", () => {
    it("fails when configured contract spec does not exist", async () => {
      const gwConfigFile = join(tempDir, "gateway.config.yaml");
      const gwConfig = `
version: 1
name: missing-spec-gw
tenant: tenant-alpha
server:
  transport: stdio
contracts:
  - name: missing
    tenantId: tenant-alpha
    spec: nonexistent-spec.yaml
    destination:
      baseUrl: https://api.petstore.test
      allowedHosts:
        - api.petstore.test
`;
      await writeFile(gwConfigFile, gwConfig, "utf8");

      await expect(
        gatewayServeCommand({
          cwd: tempDir,
          config: "gateway.config.yaml",
        }),
      ).rejects.toThrow(
        /OpenAPI specification file not found for contract 'missing'/,
      );
    });

    it("fails when neither verifier nor tenant is configured", async () => {
      const specFile = join(tempDir, "service.yaml");
      await writeFile(specFile, SAMPLE_SPEC, "utf8");

      const gwConfigFile = join(tempDir, "gateway.config.yaml");
      const gwConfig = `
version: 1
name: no-tenant-gw
server:
  transport: stdio
auth:
  inbound:
    authorizer: none
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

      await expect(
        gatewayServeCommand({
          cwd: tempDir,
          config: "gateway.config.yaml",
        }),
      ).rejects.toThrow(/Dynamic gateway requires a tenant resolver/);
    });

    it("initializes gateway with cache, analytics, and token metrics enabled", async () => {
      const specFile = join(tempDir, "service.yaml");
      await writeFile(specFile, SAMPLE_SPEC, "utf8");

      const gwConfigFile = join(tempDir, "gateway.config.yaml");
      const gwConfig = `
version: 1
name: full-features-gw
tenant: tenant-1
server:
  transport: stdio
cache:
  enabled: true
  provider: memory
  maxEntries: 100
  ttlSeconds: 60
analytics:
  enabled: true
  retentionDays: 1
  openTelemetry:
    enabled: true
    serviceName: gw-analytics-test
    tracing:
      enabled: true
      sampleRatio: 1.0
projection:
  enabled: true
tokenMetrics:
  enabled: true
  tokenizer: approximate
contracts:
  - name: pets
    tenantId: tenant-1
    spec: service.yaml
    destination:
      baseUrl: https://api.petstore.test
      allowedHosts:
        - api.petstore.test
`;
      await writeFile(gwConfigFile, gwConfig, "utf8");

      const stdin = new PassThrough();
      const stdout = new PassThrough();

      const handle = await gatewayServeCommand({
        cwd: tempDir,
        config: "gateway.config.yaml",
        stdin,
        stdout,
      });

      expect(handle.ok).toBe(true);
      expect(handle.contractCount).toBe(1);
      expect(handle.totalToolCount).toBe(1);

      await handle.close();
      await handle.closed;
    });
  });

  describe("spec-loader security and network branches", () => {
    it("rejects specification files exceeding maxBytes", async () => {
      const specPath = join(tempDir, "huge-spec.yaml");
      await writeFile(
        specPath,
        "openapi: 3.1.0\n" + "x-pad: ".padEnd(200, "a"),
        "utf8",
      );

      await expect(
        loadSpec({
          source: specPath,
          maxBytes: 50,
        }),
      ).rejects.toThrow(/Spec size exceeds limit of 50 bytes/);
    });

    it("rejects nonexistent file with descriptive error", async () => {
      await expect(
        loadSpec({
          source: join(tempDir, "does-not-exist.yaml"),
        }),
      ).rejects.toThrow(/OpenAPI specification file was not found/);
    });

    it("rejects remote URL containing credentials", async () => {
      await expect(
        loadSpec({
          source: "https://user:pass@api.example.com/openapi.yaml",
        }),
      ).rejects.toThrow(/must not contain credentials/);
    });

    it("rejects public host using plain HTTP", async () => {
      await expect(
        loadSpec({
          source: "http://8.8.8.8/openapi.yaml",
          allowHttp: true,
          resolver: async () => ["8.8.8.8"],
        }),
      ).rejects.toThrow(/Plain HTTP is not permitted for public hosts/);
    });

    it("rejects host that resolves to private address when allowPrivateHosts is false", async () => {
      await expect(
        loadSpec({
          source: "https://private.internal/openapi.yaml",
          resolver: async () => ["10.0.0.1"],
        }),
      ).rejects.toThrow(
        /resolves to private or restricted address \(10\.0\.0\.1\)/,
      );
    });

    it("rejects host that resolves to invalid or unspecified address (0.0.0.0)", async () => {
      await expect(
        loadSpec({
          source: "https://invalid.test/openapi.yaml",
          resolver: async () => ["0.0.0.0"],
        }),
      ).rejects.toThrow(/resolves to invalid\/unspecified address/);
    });

    it("rejects non-loopback hostname resolving to loopback address (SSRF / DNS rebinding)", async () => {
      await expect(
        loadSpec({
          source: "https://evil-rebinding.test/openapi.yaml",
          resolver: async () => ["127.0.0.1"],
        }),
      ).rejects.toThrow(
        /Security error: Host 'evil-rebinding\.test' resolves to loopback address/,
      );
    });

    it("rejects resolver returning no addresses", async () => {
      await expect(
        loadSpec({
          source: "https://empty-dns.test/openapi.yaml",
          resolver: async () => [],
        }),
      ).rejects.toThrow(/resolved to no addresses/);
    });

    it("rejects redirect response with missing Location header", async () => {
      const server = http.createServer((_req, res) => {
        res.writeHead(302); // missing Location header
        res.end();
      });

      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const port = (server.address() as { port: number }).port;

      try {
        await expect(
          loadSpec({
            source: `http://127.0.0.1:${port}/redirect-no-location`,
            allowHttp: true,
          }),
        ).rejects.toThrow(/HTTP 302 redirect without Location header/);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it("rejects HTTP 500 server error response", async () => {
      const server = http.createServer((_req, res) => {
        res.writeHead(500, "Internal Server Error");
        res.end("server broke");
      });

      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const port = (server.address() as { port: number }).port;

      try {
        await expect(
          loadSpec({
            source: `http://127.0.0.1:${port}/error`,
            allowHttp: true,
          }),
        ).rejects.toThrow(/Failed to fetch spec from.*HTTP 500/);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it("rejects response when Content-Length header exceeds maxBytes", async () => {
      const server = http.createServer((_req, res) => {
        res.writeHead(200, {
          "content-type": "application/yaml",
          "content-length": "99999",
        });
        res.end("short body");
      });

      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const port = (server.address() as { port: number }).port;

      try {
        await expect(
          loadSpec({
            source: `http://127.0.0.1:${port}/too-large`,
            allowHttp: true,
            maxBytes: 100,
          }),
        ).rejects.toThrow(/Spec size exceeds limit of 100 bytes/);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it("rejects when caller signal is pre-aborted", async () => {
      const controller = new AbortController();
      controller.abort();

      await expect(
        loadSpec({
          source: "https://127.0.0.1:9999/spec.yaml",
          signal: controller.signal,
        }),
      ).rejects.toThrow(/Request was aborted/);
    });
  });

  describe("exportCommand option validation", () => {
    it("fails when both --local-deps and --workspace-deps are set", async () => {
      const res = await exportCommand({
        spec: "spec.yaml",
        localDeps: "./packages",
        workspaceDependencies: true,
        cwd: tempDir,
      });

      expect(res.ok).toBe(false);
      expect(res.error).toContain("Choose either --local-deps");
    });

    it("fails when output directory exists and is non-empty without --force", async () => {
      const outputDir = join(tempDir, "existing-output");
      await mkdir(outputDir, { recursive: true });
      await writeFile(join(outputDir, "dummy.txt"), "hello", "utf8");

      const specFile = join(tempDir, "service.yaml");
      await writeFile(specFile, SAMPLE_SPEC, "utf8");

      const res = await exportCommand({
        spec: specFile,
        output: outputDir,
        force: false,
        cwd: tempDir,
      });

      expect(res.ok).toBe(false);
      expect(res.error).toContain("is not empty. Use --force to overwrite.");
    });
  });
});

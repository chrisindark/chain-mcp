import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildCommand } from "../src/commands/build.js";
import { exportCommand } from "../src/commands/export.js";
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
  });
});

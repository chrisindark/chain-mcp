import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ToolDefinition } from "@chainmcp/core";
import { runCli } from "../src/cli.js";
import { buildCommand } from "../src/commands/build.js";
import { exportCommand } from "../src/commands/export.js";
import { initCommand } from "../src/commands/init.js";
import { serveCommand } from "../src/commands/serve.js";
import { validateCommand } from "../src/commands/validate.js";

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

const mockCalculatorTool: ToolDefinition = {
  name: "calculate",
  description: "Calculates expressions",
  inputSchema: {
    type: "object",
    properties: {
      a: { type: "number" },
      b: { type: "number" },
    },
    required: ["a", "b"],
    additionalProperties: false,
  },
  operation: {},
  execute: async (input: unknown) => {
    const { a, b } = input as { a: number; b: number };
    return { result: a + b };
  },
};

describe("RM-08: Code-first projects support across CLI commands", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "chainmcp-code-first-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("init with no spec (blank mode) -> validate succeeds and reports code-first", async () => {
    const projectDir = join(tempDir, "blank-project");
    const initResult = await initCommand({
      blank: true,
      output: projectDir,
      cwd: tempDir,
    });
    expect(initResult.ok).toBe(true);

    const valResult = await validateCommand({
      cwd: projectDir,
    });

    expect(valResult.ok).toBe(true);
    expect(valResult.contractKind).toBe("code-first");
    expect(valResult.toolCount).toBeGreaterThanOrEqual(1);
    expect(valResult.toolNames).toContain("greet");
    expect(valResult.entrypointPath).toBeDefined();
    expect(valResult.entrypointPath).toContain("src/tools.ts");
  });

  it("--require-contract on a contract-free project fails explicitly with clear error", async () => {
    const projectDir = join(tempDir, "blank-project-strict");
    await initCommand({
      blank: true,
      output: projectDir,
      cwd: tempDir,
    });

    const valResult = await validateCommand({
      cwd: projectDir,
      requireContract: true,
    });

    expect(valResult.ok).toBe(false);
    expect(valResult.contractKind).toBe("openapi");
    expect(valResult.error).toContain("Contract specification file not found");
    expect(
      valResult.diagnostics.some((d) => d.code === "DOCUMENT_INVALID"),
    ).toBe(true);
  });

  it("validate --json states which mode was validated", async () => {
    const projectDir = join(tempDir, "blank-json-project");
    await initCommand({
      blank: true,
      output: projectDir,
      cwd: tempDir,
    });

    const outputLines: string[] = [];
    const exitCode = await runCli(
      [
        "validate",
        "--json",
        "--config",
        join(projectDir, "chainmcp.config.yaml"),
      ],
      {
        stdout: (msg) => outputLines.push(msg),
      },
    );

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(outputLines.join("\n"));
    expect(parsed.ok).toBe(true);
    expect(parsed.contractKind).toBe("code-first");
    expect(parsed.toolCount).toBeGreaterThanOrEqual(1);
  });

  it("contract-driven project validate --json reports contractKind openapi", async () => {
    const specPath = join(tempDir, "openapi.yaml");
    await writeFile(specPath, SAMPLE_SPEC, "utf8");

    const projectDir = join(tempDir, "contract-project");
    await initCommand({
      spec: specPath,
      output: projectDir,
      cwd: tempDir,
    });

    const outputLines: string[] = [];
    const exitCode = await runCli(
      [
        "validate",
        "--json",
        "--config",
        join(projectDir, "chainmcp.config.yaml"),
      ],
      {
        stdout: (msg) => outputLines.push(msg),
      },
    );

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(outputLines.join("\n"));
    expect(parsed.ok).toBe(true);
    expect(parsed.contractKind).toBe("openapi");
    expect(parsed.contractRevision).toBeDefined();
    expect(parsed.toolCount).toBe(1);
    expect(parsed.toolNames).toContain("listPets");
  });

  it("code-first project -> serve starts in-process over stdio and lists code-defined tools", async () => {
    const projectDir = join(tempDir, "code-first-serve-stdio");
    await initCommand({
      blank: true,
      output: projectDir,
      cwd: tempDir,
    });

    const stdin = new PassThrough();
    const stdout = new PassThrough();

    const serverHandle = await serveCommand({
      cwd: projectDir,
      tools: [mockCalculatorTool],
      stdin,
      stdout,
    });

    expect(serverHandle.ok).toBe(true);
    // 1 custom tool + 4 JSON navigation tools = 5 tools
    expect(serverHandle.toolCount).toBe(5);

    await serverHandle.close();
    await serverHandle.closed;
  });

  it("code-first project -> serve supports --transport http with shared runtime", async () => {
    const projectDir = join(tempDir, "code-first-serve-http");
    await initCommand({
      blank: true,
      output: projectDir,
      cwd: tempDir,
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const serverHandle = await serveCommand({
        cwd: projectDir,
        tools: [mockCalculatorTool],
        transport: "http",
        host: "127.0.0.1",
        port: 0,
      });

      expect(serverHandle.ok).toBe(true);
      expect(serverHandle.url).toBeDefined();
      expect(serverHandle.toolCount).toBe(5);

      await serverHandle.close();
      await serverHandle.closed;
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("code-first project -> serve does not silently fall back to empty tool set", async () => {
    const projectDir = join(tempDir, "code-first-empty-tools");
    await initCommand({
      blank: true,
      output: projectDir,
      cwd: tempDir,
    });

    // Overwrite tools.ts with empty export
    await writeFile(
      join(projectDir, "src", "tools.ts"),
      "export const tools = [];",
      "utf8",
    );

    await expect(
      serveCommand({
        cwd: projectDir,
      }),
    ).rejects.toThrow(/Cannot serve code-first project: no tools found/);
  });

  it("code-first project -> export produces a runnable directory with code-first manifest and templates", async () => {
    const projectDir = join(tempDir, "code-first-export-src");
    await initCommand({
      blank: true,
      output: projectDir,
      cwd: tempDir,
    });

    const exportDir = join(tempDir, "exported-code-first");
    const exportResult = await exportCommand({
      cwd: projectDir,
      output: exportDir,
      tools: [mockCalculatorTool],
      check: true,
    });

    expect(exportResult.ok).toBe(true);
    expect(exportResult.verifiedReproducible).toBe(true);
    expect(exportResult.filesWritten).toContain("chainmcp.manifest.json");
    expect(exportResult.filesWritten).toContain("chainmcp.config.yaml");
    expect(exportResult.filesWritten).toContain("package.json");
    expect(exportResult.filesWritten).toContain("src/server.ts");
    expect(exportResult.filesWritten).toContain("src/tools.ts");
    expect(exportResult.filesWritten).toContain("Dockerfile");
    expect(exportResult.filesWritten).toContain("README.md");

    const manifest = JSON.parse(
      await readFile(join(exportDir, "chainmcp.manifest.json"), "utf8"),
    );
    expect(manifest.manifestVersion).toBe(1);
    expect(manifest.toolCount).toBe(1);
    expect(manifest.tools[0].name).toBe("calculate");
    expect(manifest.toolsetHash).toBeDefined();

    const dockerfile = await readFile(join(exportDir, "Dockerfile"), "utf8");
    // Does not copy spec directory
    expect(dockerfile).not.toContain("COPY spec ./spec");
    expect(dockerfile).toContain("COPY src ./src");
  });

  it("code-first project -> build emits manifest and compiled-tools.json", async () => {
    const projectDir = join(tempDir, "code-first-build");
    await initCommand({
      blank: true,
      output: projectDir,
      cwd: tempDir,
    });

    const outDir = join(projectDir, "dist");
    // Initial build
    const buildResult = await buildCommand({
      cwd: projectDir,
      outDir,
      tools: [mockCalculatorTool],
    });

    expect(buildResult.ok).toBe(true);
    expect(buildResult.toolCount).toBe(1);

    // Second build with --check
    const checkResult = await buildCommand({
      cwd: projectDir,
      outDir,
      tools: [mockCalculatorTool],
      check: true,
    });
    expect(checkResult.ok).toBe(true);
    expect(checkResult.verifiedReproducible).toBe(true);

    const manifest = JSON.parse(
      await readFile(join(outDir, "chainmcp.manifest.json"), "utf8"),
    );
    expect(manifest.manifestVersion).toBe(1);
    expect(manifest.toolCount).toBe(1);
    expect(manifest.tools[0].name).toBe("calculate");

    const toolsJson = JSON.parse(
      await readFile(join(outDir, "compiled-tools.json"), "utf8"),
    );
    expect(toolsJson).toHaveLength(1);
    expect(toolsJson[0].name).toBe("calculate");
  });

  it("code-first project -> build fails with specific documented error when no tools are found", async () => {
    const emptyDir = join(tempDir, "completely-empty");
    await initCommand({
      blank: true,
      output: emptyDir,
      cwd: tempDir,
    });
    // Replace tools with empty array
    await writeFile(
      join(emptyDir, "src", "tools.ts"),
      "export const tools = [];",
      "utf8",
    );

    const buildResult = await buildCommand({
      cwd: emptyDir,
    });

    expect(buildResult.ok).toBe(false);
    expect(buildResult.error).toContain(
      "Cannot build code-first project: no tools could be loaded from entrypoint",
    );
  });

  it("regression: contract-based project -> all four commands remain unchanged", async () => {
    const specPath = join(tempDir, "openapi.yaml");
    await writeFile(specPath, SAMPLE_SPEC, "utf8");

    const projectDir = join(tempDir, "regression-contract");
    await initCommand({
      spec: specPath,
      output: projectDir,
      cwd: tempDir,
    });

    // 1. validate
    const val = await validateCommand({ cwd: projectDir });
    expect(val.ok).toBe(true);
    expect(val.contractKind).toBe("openapi");
    expect(val.toolCount).toBe(1);

    // 2. build
    const bld = await buildCommand({ cwd: projectDir, check: true });
    expect(bld.ok).toBe(true);
    expect(bld.toolCount).toBe(1);
    expect(bld.manifest.contractRevision).toBeDefined();

    // 3. export
    const expDir = join(tempDir, "exp-contract");
    const exp = await exportCommand({
      cwd: projectDir,
      output: expDir,
      check: true,
    });
    expect(exp.ok).toBe(true);
    expect(exp.filesWritten).toContain("spec/openapi.yaml");

    // 4. serve
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const srv = await serveCommand({ cwd: projectDir, stdin, stdout });
    expect(srv.ok).toBe(true);
    expect(srv.toolCount).toBe(5); // 1 operation + 4 JSON navigation
    await srv.close();
    await srv.closed;
  });

  it("CLI flags: validate, build, serve, export reject contract-free project when --require-contract is set", async () => {
    const projectDir = join(tempDir, "cli-flags-project");
    await initCommand({
      blank: true,
      output: projectDir,
      cwd: tempDir,
    });

    const errLogs: string[] = [];
    const configPath = join(projectDir, "chainmcp.config.yaml");

    const code1 = await runCli(
      ["validate", "--config", configPath, "--require-contract"],
      {
        stderr: (msg) => errLogs.push(msg),
      },
    );
    expect(code1).toBe(1);

    const code2 = await runCli(
      ["build", "--config", configPath, "--require-contract"],
      {
        stderr: (msg) => errLogs.push(msg),
      },
    );
    expect(code2).toBe(1);

    const code3 = await runCli(
      ["serve", "--config", configPath, "--require-contract"],
      {
        stderr: (msg) => errLogs.push(msg),
      },
    );
    expect(code3).toBe(1);

    const code4 = await runCli(
      ["export", "--config", configPath, "--require-contract"],
      {
        stderr: (msg) => errLogs.push(msg),
      },
    );
    expect(code4).toBe(1);
  });
});

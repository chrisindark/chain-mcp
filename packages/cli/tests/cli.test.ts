import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runCli } from "../src/cli.js";
import { CLI_VERSION } from "../src/types.js";

const MINIMAL_SPEC = `
openapi: "3.1.0"
info:
  title: Cli Test API
  version: "1.0.0"
servers:
  - url: https://api.example.com
paths:
  /status:
    get:
      operationId: getStatus
      responses:
        "200":
          description: OK
`;

describe("CLI entry point (runCli)", () => {
  let tempDir: string;
  let specPath: string;
  let outLogs: string[];
  let errLogs: string[];

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "chainmcp-runcli-test-"));
    specPath = join(tempDir, "openapi.yaml");
    await writeFile(specPath, MINIMAL_SPEC, "utf8");

    outLogs = [];
    errLogs = [];
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const io = {
    stdout: (msg: string) => outLogs.push(msg),
    stderr: (msg: string) => errLogs.push(msg),
  };

  it("handles --version", async () => {
    const code = await runCli(["--version"], io);
    expect(code).toBe(0);
    expect(outLogs.some((l) => l.includes(`chainmcp v${CLI_VERSION}`))).toBe(
      true,
    );
  });

  it("handles --help", async () => {
    const code = await runCli(["--help"], io);
    expect(code).toBe(0);
    expect(outLogs.some((l) => l.includes("Usage:"))).toBe(true);
  });

  it("fails on unknown command", async () => {
    const code = await runCli(["foobar"], io);
    expect(code).toBe(1);
    expect(errLogs.some((l) => l.includes("Unknown command"))).toBe(true);
  });

  it("runs init command via CLI", async () => {
    const projectDir = join(tempDir, "scaffold");
    const code = await runCli(
      ["init", "--spec", specPath, "--output", projectDir],
      io,
    );
    expect(code).toBe(0);
    expect(
      outLogs.some((l) => l.includes("Initialized ChainMcp project")),
    ).toBe(true);
  });

  it("runs validate command via CLI", async () => {
    const projectDir = join(tempDir, "val-proj");
    await runCli(["init", "--spec", specPath, "--output", projectDir], io);

    const valCode = await runCli(
      ["validate", "--config", join(projectDir, "chainmcp.config.yaml")],
      io,
    );
    expect(valCode).toBe(0);
    expect(outLogs.some((l) => l.includes("Validation passed"))).toBe(true);
  });

  it("runs validate command via CLI with --json", async () => {
    const valCode = await runCli(
      ["validate", "--spec", specPath, "--json"],
      io,
    );
    expect(valCode).toBe(0);
    const jsonOutput = outLogs.find((l) => {
      try {
        const parsed = JSON.parse(l);
        return parsed && parsed.ok === true;
      } catch {
        return false;
      }
    });
    expect(jsonOutput).toBeDefined();
    const parsed = JSON.parse(jsonOutput!);
    expect(parsed.ok).toBe(true);
    expect(parsed.resolvedSource).toBe(specPath);
    expect(parsed.specBytes).toBeGreaterThan(0);
    expect(parsed.toolCount).toBe(1);
  });

  it("runs build command via CLI", async () => {
    const projectDir = join(tempDir, "build-proj");
    await runCli(["init", "--spec", specPath, "--output", projectDir], io);

    const buildCode = await runCli(
      [
        "build",
        "--config",
        join(projectDir, "chainmcp.config.yaml"),
        "--out-dir",
        join(projectDir, "dist"),
      ],
      io,
    );
    expect(buildCode).toBe(0);
    expect(outLogs.some((l) => l.includes("Build succeeded"))).toBe(true);
  });

  it("runs export command via CLI", async () => {
    const exportTarget = join(tempDir, "exported");
    const exportCode = await runCli(
      ["export", "--spec", specPath, "--output", exportTarget, "--check"],
      io,
    );
    expect(exportCode).toBe(0);
    expect(outLogs.some((l) => l.includes("Export succeeded"))).toBe(true);
    expect(outLogs.some((l) => l.includes("Reproducibility: verified"))).toBe(
      true,
    );
  });

  it("runs init --blank via CLI", async () => {
    const blankDir = join(tempDir, "blank-cli-proj");
    const initCode = await runCli(
      ["init", "--blank", "--name", "my-blank-app", "--output", blankDir],
      io,
    );
    expect(initCode).toBe(0);
    expect(
      outLogs.some((l) =>
        l.includes("Blank code-first project initialized with example tool"),
      ),
    ).toBe(true);
  });

  it("reports error when gateway config is missing", async () => {
    const missingCode = await runCli(
      ["gateway", "serve", "--config", "nonexistent.yaml"],
      io,
    );
    expect(missingCode).toBe(1);
    expect(
      errLogs.some((l) => l.includes("Gateway config file not found")),
    ).toBe(true);
  });

  it("runs diff command via CLI", async () => {
    const diffCode = await runCli(
      ["diff", "--spec", specPath, "--against", specPath],
      io,
    );
    expect(diffCode).toBe(0);
    expect(outLogs.some((l) => l.includes("No schema changes detected"))).toBe(
      true,
    );
  });

  it("supports --fail-on, --fail-on-breaking, and --json with breaking-change taxonomy", async () => {
    const baseSpec = `
openapi: "3.1.0"
info:
  title: Pet API
  version: "1.0.0"
servers:
  - url: https://api.example.com
paths:
  /pets:
    get:
      operationId: listPets
      parameters:
        - name: limit
          in: query
          required: false
          schema:
            type: integer
      responses:
        "200":
          description: OK
`;
    const breakingSpec = `
openapi: "3.1.0"
info:
  title: Pet API
  version: "1.0.0"
servers:
  - url: https://api.example.com
paths:
  /pets:
    get:
      operationId: listPets
      parameters:
        - name: limit
          in: query
          required: false
          schema:
            type: integer
        - name: token
          in: query
          required: true
          schema:
            type: string
      responses:
        "200":
          description: OK
`;
    const potentialSpec = `
openapi: "3.1.0"
info:
  title: Pet API
  version: "1.0.0"
servers:
  - url: https://api.example.com
paths:
  /pets:
    get:
      operationId: listPets
      parameters:
        - name: limit
          in: query
          required: true
          schema:
            type: integer
      responses:
        "200":
          description: OK
`;

    const basePath = join(tempDir, "base.yaml");
    const breakingPath = join(tempDir, "breaking.yaml");
    const potentialPath = join(tempDir, "potential.yaml");

    await writeFile(basePath, baseSpec, "utf8");
    await writeFile(breakingPath, breakingSpec, "utf8");
    await writeFile(potentialPath, potentialSpec, "utf8");

    // 1. Breaking change defaults to exit 1
    outLogs = [];
    errLogs = [];
    const defaultBreakCode = await runCli(
      ["diff", "--spec", breakingPath, "--against", basePath],
      io,
    );
    expect(defaultBreakCode).toBe(1);
    expect(
      errLogs.some((l) =>
        l.includes("Diff failed: contract changes exceed allowed threshold"),
      ),
    ).toBe(true);

    // 2. Breaking change with --fail-on-breaking exits 1
    outLogs = [];
    errLogs = [];
    const aliasBreakCode = await runCli(
      [
        "diff",
        "--spec",
        breakingPath,
        "--against",
        basePath,
        "--fail-on-breaking",
      ],
      io,
    );
    expect(aliasBreakCode).toBe(1);

    // 3. Breaking change with --fail-on none exits 0
    outLogs = [];
    errLogs = [];
    const noneBreakCode = await runCli(
      [
        "diff",
        "--spec",
        breakingPath,
        "--against",
        basePath,
        "--fail-on",
        "none",
      ],
      io,
    );
    expect(noneBreakCode).toBe(0);

    // 4. Potentially breaking change with --fail-on breaking exits 0, with breaking+potential exits 1
    outLogs = [];
    errLogs = [];
    const potBreakingOnlyCode = await runCli(
      [
        "diff",
        "--spec",
        potentialPath,
        "--against",
        basePath,
        "--fail-on",
        "breaking",
      ],
      io,
    );
    expect(potBreakingOnlyCode).toBe(0);

    outLogs = [];
    errLogs = [];
    const potPlusBreakCode = await runCli(
      [
        "diff",
        "--spec",
        potentialPath,
        "--against",
        basePath,
        "--fail-on",
        "breaking+potential",
      ],
      io,
    );
    expect(potPlusBreakCode).toBe(1);

    // 5. Machine-readable JSON output contains schemaVersion: 1 and changes
    outLogs = [];
    errLogs = [];
    await runCli(
      [
        "diff",
        "--spec",
        breakingPath,
        "--against",
        basePath,
        "--json",
        "--fail-on",
        "none",
      ],
      io,
    );
    const jsonStr = outLogs.join("\n");
    const parsed = JSON.parse(jsonStr) as {
      schemaVersion: number;
      breaking: Array<{ code: string }>;
      potentiallyBreaking: unknown[];
      nonBreaking: unknown[];
    };
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.breaking.some((c) => c.code === "INPUT_REQUIRED_ADDED")).toBe(
      true,
    );
  });
});

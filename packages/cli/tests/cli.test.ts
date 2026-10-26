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
});

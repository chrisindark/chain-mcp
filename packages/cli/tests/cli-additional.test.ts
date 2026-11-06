import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runCli } from "../src/cli.js";

vi.mock("@chainmcp/admin", () => ({
  startDeclarativeAdminServer: vi.fn().mockResolvedValue({
    url: "http://127.0.0.1:8787",
    close: vi.fn(),
  }),
}));

const SPEC_A = `
openapi: "3.1.0"
info:
  title: API A
  version: "1.0.0"
servers:
  - url: https://api.example.com
paths:
  /items:
    get:
      operationId: getItems
      responses:
        "200":
          description: OK
  /old:
    get:
      operationId: oldItem
      responses:
        "200":
          description: OK
`;

const SPEC_B = `
openapi: "3.1.0"
info:
  title: API B
  version: "2.0.0"
servers:
  - url: https://api.example.com
paths:
  /items:
    get:
      operationId: getItems
      summary: Updated summary non-breaking
      responses:
        "200":
          description: OK
  /new:
    post:
      operationId: createNew
      responses:
        "201":
          description: Created
`;

const CONFIG_YAML = `version: 1
name: test-app
security:
  allowedUpstreamHosts:
    - api.example.com
`;

describe("CLI Additional Execution Tests (cli.ts)", () => {
  let tempDir: string;
  let outLogs: string[];
  let errLogs: string[];
  const originalAdminToken = process.env.CHAINMCP_ADMIN_TOKEN;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "chainmcp-cli-additional-"));
    process.env.CHAINMCP_ADMIN_TOKEN = "test-admin-token";
    outLogs = [];
    errLogs = [];
  });

  afterEach(async () => {
    if (originalAdminToken !== undefined) {
      process.env.CHAINMCP_ADMIN_TOKEN = originalAdminToken;
    } else {
      delete process.env.CHAINMCP_ADMIN_TOKEN;
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  const io = {
    stdout: (msg: string) => outLogs.push(msg),
    stderr: (msg: string) => errLogs.push(msg),
  };

  it("prints human-readable diff with added, removed, and modified tools", async () => {
    const specAPath = join(tempDir, "specA.yaml");
    const specBPath = join(tempDir, "specB.yaml");
    await writeFile(specAPath, SPEC_A, "utf8");
    await writeFile(specBPath, SPEC_B, "utf8");

    // Run diff without --json and fail-on none so it logs all sections
    const code = await runCli(
      [
        "diff",
        "--spec",
        specBPath,
        "--against",
        specAPath,
        "--fail-on",
        "none",
      ],
      io,
    );

    expect(code).toBe(0);
    expect(outLogs.some((l) => l.includes("Contract diff detected:"))).toBe(
      true,
    );
    expect(outLogs.some((l) => l.includes("Added tools"))).toBe(true);
    expect(outLogs.some((l) => l.includes("Removed tools (BREAKING)"))).toBe(
      true,
    );
    expect(outLogs.some((l) => l.includes("Breaking changes"))).toBe(true);
  });

  it("handles diff errors when baseline file is not found", async () => {
    const specPath = join(tempDir, "spec.yaml");
    await writeFile(specPath, SPEC_A, "utf8");

    const code = await runCli(
      ["diff", "--spec", specPath, "--against", join(tempDir, "missing.yaml")],
      io,
    );

    expect(code).toBe(1);
    expect(errLogs.some((l) => l.includes("Diff error:"))).toBe(true);
  });

  it("handles unknown gateway subcommands", async () => {
    const code = await runCli(["gateway", "stop"], io);
    expect(code).toBe(1);
    expect(
      errLogs.some((l) => l.includes("Unknown gateway subcommand: 'stop'")),
    ).toBe(true);
  });

  it("handles unknown config subcommands", async () => {
    const code = await runCli(["config", "inspect"], io);
    expect(code).toBe(1);
    expect(
      errLogs.some((l) => l.includes("Unknown config subcommand: 'inspect'")),
    ).toBe(true);
  });

  it("runs config explain command with and without --json", async () => {
    const configPath = join(tempDir, "chainmcp.config.yaml");
    await writeFile(configPath, CONFIG_YAML, "utf8");

    // Human-readable config explain
    const codeHuman = await runCli(
      ["config", "explain", "--config", configPath],
      io,
    );
    expect(codeHuman).toBe(0);
    expect(outLogs.some((l) => l.includes("Resolved configuration"))).toBe(
      true,
    );

    // JSON config explain
    outLogs = [];
    const codeJson = await runCli(
      ["config", "explain", "--config", configPath, "--json"],
      io,
    );
    expect(codeJson).toBe(0);
    const parsed = JSON.parse(outLogs[0]!);
    expect(parsed.config.name).toBe("test-app");
  });

  it("handles admin command with and without --json", async () => {
    const codeHuman = await runCli(["admin"], io);
    expect(codeHuman).toBe(0);
    expect(
      outLogs.some((l) => l.includes("Admin console: http://127.0.0.1:8787")),
    ).toBe(true);

    outLogs = [];
    const codeJson = await runCli(["admin", "--json"], io);
    expect(codeJson).toBe(0);
    const parsed = JSON.parse(outLogs[0]!);
    expect(parsed.ok).toBe(true);
  });

  it("handles doctor command with and without --json", async () => {
    const configPath = join(tempDir, "chainmcp.config.yaml");
    await writeFile(configPath, CONFIG_YAML, "utf8");

    const codeHuman = await runCli(["doctor", "--config", configPath], io);
    expect(codeHuman).toBe(0);
    expect(outLogs.some((l) => l.startsWith("OK"))).toBe(true);

    outLogs = [];
    const codeJson = await runCli(
      ["doctor", "--config", configPath, "--json"],
      io,
    );
    expect(codeJson).toBe(0);
    const parsed = JSON.parse(outLogs[0]!);
    expect(parsed.ok).toBe(true);
    expect(Array.isArray(parsed.checks)).toBe(true);
  });

  it("handles export failure when spec file is missing", async () => {
    const code = await runCli(
      [
        "export",
        "--spec",
        join(tempDir, "nonexistent.yaml"),
        "--output",
        join(tempDir, "out"),
      ],
      io,
    );
    expect(code).toBe(1);
    expect(errLogs.some((l) => l.includes("Export failed:"))).toBe(true);
  });

  it("handles validate failure when spec file is missing", async () => {
    const code = await runCli(
      ["validate", "--spec", join(tempDir, "nonexistent.yaml")],
      io,
    );
    expect(code).toBe(1);
    expect(errLogs.some((l) => l.includes("Validation failed"))).toBe(true);
  });

  it("handles gateway serve error through runCli", async () => {
    const code = await runCli(
      ["gateway", "serve", "--config", join(tempDir, "nonexistent-gw.yaml")],
      io,
    );
    expect(code).toBe(1);
    expect(errLogs.some((l) => l.includes("Gateway serve error:"))).toBe(true);
  });

  it("handles export success logging through runCli", async () => {
    const specPath = join(tempDir, "spec.yaml");
    await writeFile(specPath, SPEC_A, "utf8");
    const outDir = join(tempDir, "exported-app");

    const code = await runCli(
      ["export", "--spec", specPath, "--output", outDir],
      io,
    );
    expect(code).toBe(0);
    expect(outLogs.some((l) => l.includes("Export succeeded:"))).toBe(true);
    expect(outLogs.some((l) => l.includes("Exported project to:"))).toBe(true);
    expect(outLogs.some((l) => l.includes("Files written:"))).toBe(true);
    expect(outLogs.some((l) => l.includes("Tools compiled:"))).toBe(true);
  });

  it("handles build failure when spec file is missing", async () => {
    const code = await runCli(
      ["build", "--spec", join(tempDir, "nonexistent.yaml")],
      io,
    );
    expect(code).toBe(1);
    expect(errLogs.some((l) => l.includes("Build failed:"))).toBe(true);
  });
});

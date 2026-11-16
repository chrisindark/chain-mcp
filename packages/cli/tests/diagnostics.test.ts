import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStorageDriver } from "@chainmcp/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runCli } from "../src/cli.js";
import { diagnosticsCommand } from "../src/commands/diagnostics.js";

describe("CLI Diagnostics Command (M14-3)", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "chainmcp-diag-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("exposes --help documentation including diagnostics command and options", async () => {
    const logs: string[] = [];
    const exitCode = await runCli(["--help"], {
      stdout: (msg) => logs.push(msg),
    });

    expect(exitCode).toBe(0);
    const combined = logs.join("\n");
    expect(combined).toContain("diagnostics");
    expect(combined).toContain(
      "Analyze telemetry events and surface actionable optimization hints",
    );
    expect(combined).toContain("--token-bloat-threshold");
    expect(combined).toContain("--window");
  });

  it("fails fast if configuration file cannot be found", async () => {
    const errLogs: string[] = [];
    const result = await diagnosticsCommand({
      config: join(tempDir, "nonexistent.yaml"),
      cwd: tempDir,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Configuration file not found");

    const cliExit = await runCli(
      ["diagnostics", "--config", join(tempDir, "nonexistent.yaml")],
      {
        stderr: (msg) => errLogs.push(msg),
      },
    );
    expect(cliExit).toBe(1);
  });

  it("analyzes telemetry events in SQLite storage and surfaces optimization hints", async () => {
    const sqlitePath = join(tempDir, "diagnostics-test.sqlite");
    const storageDriver = new SqliteStorageDriver({ path: sqlitePath });
    await storageDriver.init();
    const ring = storageDriver.getTelemetryRingBuffer();

    const now = Date.now();

    // 1. Bloated tool output events (> 1000 tokens)
    for (let i = 0; i < 6; i++) {
      await ring.push({
        id: `bloat-${i}`,
        timestamp: now - 1000 * i,
        tenantId: "tenant-primary",
        toolName: "list_transactions",
        tokenCount: 2400,
        durationMs: 150,
        cached: false,
        metadata: {
          observedKeys: [
            "id",
            "amount",
            "status",
            "debug",
            "trace",
            "rawPayload",
          ],
        },
      });
    }

    // 2. High-volume idempotent read with zero cache hits
    for (let i = 0; i < 12; i++) {
      await ring.push({
        id: `cache-${i}`,
        timestamp: now - 500 * i,
        tenantId: "tenant-primary",
        toolName: "get_account_balance",
        tokenCount: 150,
        durationMs: 80,
        cached: false,
      });
    }

    await storageDriver.close();

    // Create pet OpenAPI spec and gateway config
    const specPath = join(tempDir, "banking.yaml");
    await writeFile(
      specPath,
      `
openapi: "3.0.3"
info:
  title: Banking Service
  version: "1.0.0"
paths:
  /transactions:
    get:
      operationId: list_transactions
      summary: List account transactions
      responses:
        '200':
          description: OK
  /balance:
    get:
      operationId: get_account_balance
      summary: Get account balance
      responses:
        '200':
          description: OK
`,
      "utf8",
    );

    const configPath = join(tempDir, "gateway.config.yaml");
    await writeFile(
      configPath,
      `
version: 1
name: test-banking-gateway
contracts:
  - name: banking-api
    tenantId: tenant-primary
    spec: ./banking.yaml
    destination:
      baseUrl: https://api.bank.test
      allowedHosts:
        - api.bank.test
storage:
  enabled: true
  driver: sqlite
  path: ${sqlitePath}
`,
      "utf8",
    );

    const result = await diagnosticsCommand({
      config: configPath,
      cwd: tempDir,
      tokenBloatThreshold: 800,
    });

    expect(result.ok).toBe(true);
    expect(result.report).toBeDefined();

    const report = result.report!;
    expect(report.totalEventsAnalyzed).toBe(18);
    expect(report.summary.totalHints).toBeGreaterThanOrEqual(2);
    expect(report.summary.tokenBloatHints).toBe(1);
    expect(report.summary.cacheOpportunityHints).toBeGreaterThanOrEqual(1);

    const bloatHint = report.hints.find((h) => h.category === "token_bloat")!;
    expect(bloatHint.toolName).toBe("list_transactions");
    expect(bloatHint.recommendation.action).toBe("configure_projection");
    expect(bloatHint.recommendation.suggestedOutputFields).toEqual({
      exclude: ["debug", "trace"],
    });

    const cacheHint = report.hints.find(
      (h) => h.category === "cache_opportunity",
    )!;
    expect(cacheHint.toolName).toBe("get_account_balance");
    expect(cacheHint.recommendation.action).toBe("configure_cache");
    expect(cacheHint.recommendation.suggestedCacheTtlSeconds).toBe(120);

    // Verify CLI --json mode
    const logs: string[] = [];
    const exitCode = await runCli(
      ["diagnostics", "--config", configPath, "--json"],
      {
        stdout: (msg) => logs.push(msg),
      },
    );

    expect(exitCode).toBe(0);
    const parsedJson = JSON.parse(logs.join("\n"));
    expect(parsedJson.summary.tokenBloatHints).toBe(1);
    expect(parsedJson.summary.cacheOpportunityHints).toBeGreaterThanOrEqual(1);
  });
});

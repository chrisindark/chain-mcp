import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StorageDescriptorRevisionStore } from "@chainmcp/admin";
import { SqliteStorageDriver } from "@chainmcp/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runCli } from "../src/cli.js";
import { proposalsCommand } from "../src/commands/proposals.js";

const DUMMY_SPEC = `
openapi: "3.1.0"
info:
  title: Pet Service
  version: "1.0.0"
paths:
  /pets:
    get:
      operationId: listPets
      responses:
        '200':
          description: OK
`;

describe("CLI Proposals Command (HITL Approval Gates M14-4)", () => {
  let tempDir: string;
  let configPath: string;
  let sqlitePath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "chainmcp-prop-test-"));
    sqlitePath = join(tempDir, "proposals.sqlite");
    await writeFile(join(tempDir, "pet-service.yaml"), DUMMY_SPEC, "utf8");

    const configContent = `
version: 1
name: test-proposals-gateway
storage:
  enabled: true
  driver: sqlite
  path: ${sqlitePath}
contracts:
  - name: pet-service
    tenantId: tenant-alpha
    spec: ./pet-service.yaml
    destination:
      baseUrl: https://api.petstore.test/v1
      allowedHosts:
        - api.petstore.test
`;
    configPath = join(tempDir, "gateway.config.yaml");
    await writeFile(configPath, configContent, "utf8");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("exposes --help documentation including proposals command and options", async () => {
    const logs: string[] = [];
    const exitCode = await runCli(["--help"], {
      stdout: (msg) => logs.push(msg),
    });

    expect(exitCode).toBe(0);
    const combined = logs.join("\n");
    expect(combined).toContain("proposals");
    expect(combined).toContain(
      "Manage Human-in-the-Loop (HITL) agent proposals",
    );
    expect(combined).toContain(
      "list                 List pending agent proposals",
    );
    expect(combined).toContain("diff <revisionId>");
    expect(combined).toContain("approve <revisionId>");
    expect(combined).toContain("reject <revisionId>");
    expect(combined).toContain("--comment <text>");
    expect(combined).toContain("--reason <text>");
    expect(combined).toContain("--require-approval");
    expect(combined).toContain("--no-require-approval");
  });

  it("fails fast if configuration file cannot be found", async () => {
    const errLogs: string[] = [];
    const result = await proposalsCommand({
      action: "list",
      config: join(tempDir, "nonexistent.yaml"),
      cwd: tempDir,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Configuration file not found");

    const cliExit = await runCli(
      ["proposals", "list", "--config", join(tempDir, "nonexistent.yaml")],
      {
        stderr: (msg) => errLogs.push(msg),
      },
    );
    expect(cliExit).toBe(1);
  });

  it("lists, diffs, approves, and rejects proposals via CLI", async () => {
    // 1. Initialize SQLite storage and seed an active revision and a proposal
    const storageDriver = new SqliteStorageDriver({ path: sqlitePath });
    await storageDriver.init();
    const repo = await StorageDescriptorRevisionStore.open(storageDriver);

    const hash0 = "0".repeat(64);
    const hash1 = "1".repeat(64);
    const revisionId = "dset_0000000000000002";

    // Active baseline
    await repo.createRevision({
      revisionId: "dset_0000000000000001",
      tenantId: "tenant-alpha",
      contractName: "pet-service",
      createdAt: 1000,
      status: "candidate",
      toolsetHash: hash0,
      descriptors: [
        {
          descriptorVersion: 1,
          name: "list_pets",
          description: "List all pets",
          request: { method: "GET", path: "/pets", parameters: [] },
          inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {},
          },
        },
      ],
      toolRevisions: [{ name: "list_pets", revision: `sha256:${hash0}` }],
    });
    await repo.activateRevision(
      "tenant-alpha",
      "pet-service",
      "dset_0000000000000001",
      "gw-active-1",
    );

    // Agent Proposal
    await repo.createRevision({
      revisionId,
      tenantId: "tenant-alpha",
      contractName: "pet-service",
      createdAt: 2000,
      status: "proposal",
      toolsetHash: hash1,
      descriptors: [
        {
          descriptorVersion: 1,
          name: "list_pets",
          description: "List all pets",
          request: { method: "GET", path: "/pets", parameters: [] },
          inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {},
          },
          policy: {
            outputFields: { exclude: ["debugLogs", "traceId"] },
          },
        },
      ],
      toolRevisions: [{ name: "list_pets", revision: `sha256:${hash1}` }],
      proposedBy: "agent-optimizer",
      proposalReason: "Strip bloated debugLogs to reduce prompt context",
      estimatedTokenSavings: 600,
    });
    await storageDriver.close();

    // 2. Test 'chainmcp proposals list' CLI command
    const listLogs: string[] = [];
    const listRes = await proposalsCommand({
      action: "list",
      config: configPath,
      cwd: tempDir,
      io: { stdout: (msg) => listLogs.push(msg) },
    });
    expect(listRes.ok).toBe(true);
    expect(listRes.proposals).toHaveLength(1);
    expect(
      (listRes.proposals?.[0] as { revisionId?: string })?.revisionId,
    ).toBe(revisionId);
    expect(listLogs.join("\n")).toContain(revisionId);
    expect(listLogs.join("\n")).toContain("Strip bloated debugLogs");

    // 3. Test 'chainmcp proposals diff --revision dset_0000000000000002' CLI command
    const diffLogs: string[] = [];
    const diffRes = (await proposalsCommand({
      action: "diff",
      revisionId,
      config: configPath,
      cwd: tempDir,
      io: { stdout: (msg) => diffLogs.push(msg) },
    })) as {
      ok: boolean;
      diff?: {
        changedToolsCount: number;
        toolDiffs: Array<{ toolName: string }>;
      };
    };
    expect(diffRes.ok).toBe(true);
    expect(diffRes.diff?.changedToolsCount).toBe(1);
    expect(diffRes.diff?.toolDiffs[0]?.toolName).toBe("list_pets");
    expect(diffLogs.join("\n")).toContain("list_pets");
    expect(diffLogs.join("\n")).toContain("Estimated Token Savings");

    // 4. Test 'chainmcp proposals approve --revision dset_0000000000000002 --comment "LGTM"'
    const approveLogs: string[] = [];
    const approveRes = (await proposalsCommand({
      action: "approve",
      revisionId,
      comment: "LGTM approved by senior operator",
      config: configPath,
      cwd: tempDir,
      io: { stdout: (msg) => approveLogs.push(msg) },
    })) as {
      ok: boolean;
      result?: { revisionId: string; status: string };
    };
    expect(approveRes.ok).toBe(true);
    expect(approveRes.result?.revisionId).toBe(revisionId);
    expect(approveRes.result?.status).toBe("active");
    expect(approveLogs.join("\n")).toContain("approved");

    // Verify through storage that the approved revision is now active
    const verifyDriver = new SqliteStorageDriver({ path: sqlitePath });
    await verifyDriver.init();
    const verifyRepo = await StorageDescriptorRevisionStore.open(verifyDriver);
    const activeRec = await verifyRepo.getActive("tenant-alpha", "pet-service");
    expect(activeRec?.revisionId).toBe(revisionId);
    expect(activeRec?.reviewedBy).toBe("cli-operator");
    expect(activeRec?.reviewComment).toBe("LGTM approved by senior operator");

    // List proposals should now be empty
    const remaining = await verifyRepo.listProposals(
      "tenant-alpha",
      "pet-service",
    );
    expect(remaining).toHaveLength(0);

    // 5. Create a new proposal and test rejection
    await verifyRepo.createRevision({
      revisionId: "dset_0000000000000003",
      tenantId: "tenant-alpha",
      contractName: "pet-service",
      createdAt: 3000,
      status: "proposal",
      toolsetHash: hash1,
      descriptors: [
        {
          descriptorVersion: 1,
          name: "list_pets",
          description: "List all pets",
          enabled: false,
          request: { method: "GET", path: "/pets", parameters: [] },
          inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {},
          },
        },
      ],
      toolRevisions: [{ name: "list_pets", revision: `sha256:${hash1}` }],
      proposedBy: "agent-optimizer",
      proposalReason: "Disable list_pets",
    });
    await verifyDriver.close();

    const rejectLogs: string[] = [];
    const rejectRes = (await proposalsCommand({
      action: "reject",
      revisionId: "dset_0000000000000003",
      reason: "Do not disable this tool",
      config: configPath,
      cwd: tempDir,
      io: { stdout: (msg) => rejectLogs.push(msg) },
    })) as {
      ok: boolean;
      result?: { status: string };
    };
    expect(rejectRes.ok).toBe(true);
    expect(rejectRes.result?.status).toBe("rejected");
    expect(rejectLogs.join("\n")).toContain("rejected");

    // Active remains dset_0000000000000002
    const finalDriver = new SqliteStorageDriver({ path: sqlitePath });
    await finalDriver.init();
    const finalRepo = await StorageDescriptorRevisionStore.open(finalDriver);
    const finalActive = await finalRepo.getActive(
      "tenant-alpha",
      "pet-service",
    );
    expect(finalActive?.revisionId).toBe(revisionId);
    await finalDriver.close();
  });

  it("outputs valid JSON when --json flag is provided", async () => {
    const listRes = await proposalsCommand({
      action: "list",
      config: configPath,
      cwd: tempDir,
      json: true,
    });

    expect(listRes.ok).toBe(true);
    expect(listRes.proposals).toBeDefined();
  });
});

import { describe, expect, it } from "vitest";
import { MemoryStorageDriver, SqliteStorageDriver } from "@chainmcp/storage";
import type { ToolContext } from "@chainmcp/core";
import { RESULT_HANDLE_EXPIRED, ResultHandleRegistry } from "../src/handles.js";
import { createJsonNavigationTools } from "../src/tools.js";

const alice = { tenantId: "tenant-alpha", principalId: "alice" };
const bob = { tenantId: "tenant-alpha", principalId: "bob" };
const eve = { tenantId: "tenant-beta", principalId: "alice" };

describe("ResultHandleRegistry with @chainmcp/storage", () => {
  it("survives restart using MemoryStorageDriver", async () => {
    const driver = new MemoryStorageDriver();
    await driver.init();

    const testHmacSeed = "test-hmac-seed-for-restart-check"; // gitleaks:allow

    // 1. First registry instance mints and stores a handle
    const registry1 = new ResultHandleRegistry({
      storageDriver: driver,
      secret: testHmacSeed,
    });
    const doc = { hello: "world", count: 42, items: [1, 2, 3] };
    const handle = await registry1.storeAsync(doc, alice);
    expect(handle).toMatch(/^rhv1\./);

    // Verify instance 1 resolves from in-memory cache
    expect(await registry1.resolve(handle, alice)).toEqual(doc);

    // 2. Second registry instance simulates a process restart with clean in-memory cache
    const registry2 = new ResultHandleRegistry({
      storageDriver: driver,
      secret: testHmacSeed,
    });

    // In instance 2, in-memory cache is initially empty
    expect(registry2.size).toBe(0);

    // Resolves document from storage driver!
    const resolved = await registry2.resolve(handle, alice);
    expect(resolved).toEqual(doc);

    // After resolution, it is cached in instance 2's LRU
    expect(registry2.size).toBe(1);

    await driver.close();
  });

  it("survives restart using SqliteStorageDriver in WAL mode", async () => {
    const driver = new SqliteStorageDriver({ path: ":memory:" });
    await driver.init();

    const sqliteHmacSeed = "test-sqlite-hmac-seed-for-wal-test"; // gitleaks:allow

    const registry1 = new ResultHandleRegistry({
      storageDriver: driver,
      secret: sqliteHmacSeed,
    });
    const doc = {
      apiResponse: { records: [{ id: "rec_1" }, { id: "rec_2" }] },
    };
    const handle = await registry1.storeAsync(doc, alice);

    // New registry simulating restart
    const registry2 = new ResultHandleRegistry({
      storageDriver: driver,
      secret: sqliteHmacSeed,
    });

    const resolved = await registry2.resolve(handle, alice);
    expect(resolved).toEqual(doc);

    await driver.close();
  });

  it("enforces tenant and principal boundaries in persistent store", async () => {
    const driver = new MemoryStorageDriver();
    await driver.init();

    const boundaryHmacSeed = "test-hmac-seed-for-boundary-test"; // gitleaks:allow
    const registry1 = new ResultHandleRegistry({
      storageDriver: driver,
      secret: boundaryHmacSeed,
    });
    const handle = await registry1.storeAsync({ data: "confidential" }, alice);

    const registry2 = new ResultHandleRegistry({
      storageDriver: driver,
      secret: boundaryHmacSeed,
    });

    // Different principal, same tenant
    await expect(registry2.resolve(handle, bob)).rejects.toThrowError(
      RESULT_HANDLE_EXPIRED,
    );

    // Different tenant, same principal ID
    await expect(registry2.resolve(handle, eve)).rejects.toThrowError(
      RESULT_HANDLE_EXPIRED,
    );

    await driver.close();
  });

  it("rejects tampered handle in persistent store", async () => {
    const driver = new MemoryStorageDriver();
    await driver.init();

    const tamperHmacSeed = "test-hmac-seed-for-tamper-test"; // gitleaks:allow
    const registry = new ResultHandleRegistry({
      storageDriver: driver,
      secret: tamperHmacSeed,
    });
    const handle = await registry.storeAsync({ value: 123 }, alice);

    const parts = handle.split(".");
    // Tamper with tag
    const tampered = `${parts[0]}.${parts[1]}.badbadbadbadbadbadbadbad`;

    await expect(registry.resolve(tampered, alice)).rejects.toThrowError(
      RESULT_HANDLE_EXPIRED,
    );

    await driver.close();
  });

  it("executes JSON navigation tools end-to-end with storage across restart", async () => {
    const driver = new MemoryStorageDriver();
    await driver.init();

    const toolsHmacSeed = "test-hmac-seed-for-navigation-tools"; // gitleaks:allow
    const registry1 = new ResultHandleRegistry({
      storageDriver: driver,
      secret: toolsHmacSeed,
    });
    const tools1 = createJsonNavigationTools(undefined, registry1);
    const createHandleTool = tools1.find(
      (t) => t.name === "json_create_handle",
    )!;

    const context: ToolContext = {
      requestId: "req-test-1",
      tenantId: "tenant-alpha",
      principal: { id: "alice", scopes: ["user"] },
      signal: new AbortController().signal,
    };

    // Mint handle through json_create_handle tool
    const rawDocument = [
      { id: 1, name: "Alice", active: true },
      { id: 2, name: "Bob", active: false },
      { id: 3, name: "Charlie", active: true },
    ];
    const createResult = (await createHandleTool.execute(
      { json: rawDocument },
      context,
    )) as { handle: string; bytes: number };

    expect(createResult.handle).toMatch(/^rhv1\./);
    expect(createResult.bytes).toBeGreaterThan(0);

    // Simulate process restart: new registry and new tools backed by same storage
    const registry2 = new ResultHandleRegistry({
      storageDriver: driver,
      secret: toolsHmacSeed,
    });
    const tools2 = createJsonNavigationTools(undefined, registry2);
    const selectPathTool = tools2.find((t) => t.name === "json_select_path")!;
    const filterTool = tools2.find((t) => t.name === "json_filter")!;

    // Query path using handle from previous process
    const selectResult = await selectPathTool.execute(
      { handle: createResult.handle, path: "$[0].name" },
      context,
    );
    expect(selectResult).toEqual("Alice");

    // Filter using handle from previous process
    const filterResult = await filterTool.execute(
      {
        handle: createResult.handle,
        field: "active",
        op: "eq",
        value: true,
      },
      context,
    );
    expect(filterResult).toEqual([
      { id: 1, name: "Alice", active: true },
      { id: 3, name: "Charlie", active: true },
    ]);

    await driver.close();
  });
});

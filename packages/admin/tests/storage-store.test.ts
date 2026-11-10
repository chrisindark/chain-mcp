import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { parseDeclarativeToolDescriptor } from "@chainmcp/declarative";
import { MemoryStorageDriver, SqliteStorageDriver } from "@chainmcp/storage";
import { DynamicGateway } from "@chainmcp/gateway";
import { afterEach, describe, expect, it } from "vitest";

import {
  DeclarativeAdmin,
  DescriptorStoreError,
  StorageDescriptorRevisionStore,
  type StoredDescriptorRevision,
} from "../src/index.js";
import {
  ADMIN_TOKEN,
  adminRequest,
  authSchemes,
  makeBinding,
  makeDescriptor,
} from "./fixtures.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function makeStoredRevision(
  tenantId: string,
  contractName: string,
  revisionId: string,
  overrides: Partial<StoredDescriptorRevision> = {},
): StoredDescriptorRevision {
  const descriptor = parseDeclarativeToolDescriptor(makeDescriptor(), {
    authSchemes,
  }).descriptor;
  return {
    revisionId,
    tenantId,
    contractName,
    createdAt: Date.now(),
    status: "candidate",
    toolsetHash: "a".repeat(64),
    descriptors: [descriptor],
    toolRevisions: [{ name: "get_user", revision: `sha256:${"0".repeat(64)}` }],
    ...overrides,
  };
}

describe("StorageDescriptorRevisionStore", () => {
  it("rejects invalid constructor/open arguments", async () => {
    // @ts-expect-error invalid input
    await expect(StorageDescriptorRevisionStore.open(null)).rejects.toThrow(
      TypeError,
    );
    await expect(StorageDescriptorRevisionStore.open({})).rejects.toThrow(
      TypeError,
    );
  });

  it("manages lifecycle with MemoryStorageDriver", async () => {
    const driver = new MemoryStorageDriver();
    await driver.init();

    const store = await StorageDescriptorRevisionStore.open(driver);
    expect(store.kind).toBe("storage");
    expect(store.driver).toBe(driver);

    const rev1 = makeStoredRevision(
      "tenant-a",
      "users",
      "dset_0000000000000001",
    );
    await store.createRevision(rev1);

    const list = await store.listRevisions("tenant-a", "users");
    expect(list).toHaveLength(1);
    expect(list[0]!.revisionId).toBe("dset_0000000000000001");
    expect(list[0]!.status).toBe("candidate");

    await store.activateRevision(
      "tenant-a",
      "users",
      "dset_0000000000000001",
      "gw_rev_1",
    );
    const active = await store.getActive("tenant-a", "users");
    expect(active?.revisionId).toBe("dset_0000000000000001");
    expect(active?.status).toBe("active");
    expect(active?.gatewayRevisionId).toBe("gw_rev_1");

    const rev2 = makeStoredRevision(
      "tenant-a",
      "users",
      "dset_0000000000000002",
    );
    await store.createRevision(rev2);
    await store.failRevision("tenant-a", "users", "dset_0000000000000002");

    const failed = await store.getRevision(
      "tenant-a",
      "users",
      "dset_0000000000000002",
    );
    expect(failed?.status).toBe("failed");
  });

  it("persists and survives restarts with SqliteStorageDriver (WAL mode)", async () => {
    const dir = join(tmpdir(), `chainmcp-admin-storage-${randomUUID()}`);
    temporaryDirectories.push(dir);
    const dbPath = join(dir, "admin.db");

    // Phase 1: Create store, insert revisions, activate one
    {
      const driver = new SqliteStorageDriver({ path: dbPath });
      await driver.init();
      const store = await StorageDescriptorRevisionStore.open(driver);

      const rev1 = makeStoredRevision(
        "tenant-a",
        "users",
        "dset_0000000000000001",
      );
      await store.createRevision(rev1);
      await store.activateRevision(
        "tenant-a",
        "users",
        "dset_0000000000000001",
        "gw_rev_1",
      );

      const rev2 = makeStoredRevision(
        "tenant-a",
        "users",
        "dset_0000000000000002",
      );
      await store.createRevision(rev2);

      await store.close();
    }

    // Phase 2: Re-open from disk with new driver and store instance
    {
      const driver = new SqliteStorageDriver({ path: dbPath });
      await driver.init();
      const store = await StorageDescriptorRevisionStore.open(driver);

      const active = await store.getActive("tenant-a", "users");
      expect(active?.revisionId).toBe("dset_0000000000000001");
      expect(active?.status).toBe("active");
      expect(active?.gatewayRevisionId).toBe("gw_rev_1");

      const list = await store.listRevisions("tenant-a", "users");
      expect(list).toHaveLength(2);
      expect(list.map((r) => r.revisionId).sort()).toEqual([
        "dset_0000000000000001",
        "dset_0000000000000002",
      ]);

      // Phase 3: Activate rev2 -> rev1 becomes superseded
      await store.activateRevision(
        "tenant-a",
        "users",
        "dset_0000000000000002",
        "gw_rev_2",
      );
      const newActive = await store.getActive("tenant-a", "users");
      expect(newActive?.revisionId).toBe("dset_0000000000000002");

      const oldActive = await store.getRevision(
        "tenant-a",
        "users",
        "dset_0000000000000001",
      );
      expect(oldActive?.status).toBe("superseded");

      await store.close();
    }

    // Phase 4: Verify superseded and new active persist across restart
    {
      const driver = new SqliteStorageDriver({ path: dbPath });
      await driver.init();
      const store = await StorageDescriptorRevisionStore.open(driver);

      const active = await store.getActive("tenant-a", "users");
      expect(active?.revisionId).toBe("dset_0000000000000002");
      expect(active?.status).toBe("active");

      const rev1 = await store.getRevision(
        "tenant-a",
        "users",
        "dset_0000000000000001",
      );
      expect(rev1?.status).toBe("superseded");

      await store.close();
    }
  });

  it("isolates multiple tenants and contracts", async () => {
    const driver = new MemoryStorageDriver();
    await driver.init();
    const store = await StorageDescriptorRevisionStore.open(driver);

    const t1c1 = makeStoredRevision(
      "tenant-1",
      "contract-a",
      "dset_0000000000000001",
    );
    const t1c2 = makeStoredRevision(
      "tenant-1",
      "contract-b",
      "dset_0000000000000002",
    );
    const t2c1 = makeStoredRevision(
      "tenant-2",
      "contract-a",
      "dset_0000000000000003",
    );

    await store.createRevision(t1c1);
    await store.createRevision(t1c2);
    await store.createRevision(t2c1);

    expect(await store.listRevisions("tenant-1", "contract-a")).toHaveLength(1);
    expect(await store.listRevisions("tenant-1", "contract-b")).toHaveLength(1);
    expect(await store.listRevisions("tenant-2", "contract-a")).toHaveLength(1);
    expect(await store.listRevisions("tenant-2", "contract-b")).toHaveLength(0);
  });

  it("integrates with DeclarativeAdmin and DynamicGateway", async () => {
    const driver = new MemoryStorageDriver();
    await driver.init();
    const store = await StorageDescriptorRevisionStore.open(driver);
    const gateway = new DynamicGateway();

    const admin = new DeclarativeAdmin({
      gateway,
      tokens: [{ id: "admin", token: ADMIN_TOKEN, tenants: "*" }],
      contracts: [makeBinding()],
      repository: store,
    });

    const descriptor = makeDescriptor();
    const publishRes = await admin.handle(
      adminRequest("/api/v1/tenants/tenant-a/contracts/users/publish", "POST", {
        token: ADMIN_TOKEN,
        body: { descriptors: [descriptor] },
      }),
    );
    expect(publishRes.status).toBe(201);
    const publishBody = (await publishRes.json()) as { revisionId: string };
    const revisionId = publishBody.revisionId;

    const active = await store.getActive("tenant-a", "users");
    expect(active?.revisionId).toBe(revisionId);
    expect(active?.status).toBe("active");
  });

  it("wraps storage IO failures into DescriptorStoreError", async () => {
    const dir = join(tmpdir(), `chainmcp-admin-fail-${randomUUID()}`);
    temporaryDirectories.push(dir);
    const dbPath = join(dir, "fail.db");

    const driver = new SqliteStorageDriver({ path: dbPath });
    await driver.init();
    const store = await StorageDescriptorRevisionStore.open(driver);

    // Close SQLite database so writes fail
    await driver.close();

    const rev = makeStoredRevision(
      "tenant-a",
      "users",
      "dset_0000000000000001",
    );
    await expect(store.createRevision(rev)).rejects.toThrow(
      DescriptorStoreError,
    );
  });
});

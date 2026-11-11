import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createMemoryStorageDriver,
  createSqliteStorageDriver,
  StoragePayloadTooLargeError,
} from "../src/index.js";

describe("Storage Package (@chainmcp/storage)", () => {
  describe("MemoryStorageDriver", () => {
    let storage: ReturnType<typeof createMemoryStorageDriver>;

    beforeEach(async () => {
      storage = createMemoryStorageDriver();
      await storage.init();
    });

    afterEach(async () => {
      await storage.close();
    });

    it("verifies lifecycle and ping", async () => {
      expect(storage.isConnected).toBe(true);
      expect(await storage.ping()).toBe(true);

      await storage.close();
      expect(storage.isConnected).toBe(false);
      expect(await storage.ping()).toBe(false);
    });

    it("handles KeyValueStore CRUD with tenant isolation and TTL", async () => {
      const kv = storage.getKeyValueStore<{ name: string }>("test-kv");

      // Set tenant-a and tenant-b values
      await kv.set("item-1", { name: "Alice" }, { tenantId: "tenant-a" });
      await kv.set("item-1", { name: "Bob" }, { tenantId: "tenant-b" });
      await kv.set("global-1", { name: "Global" });

      // Tenant isolation
      expect(await kv.get("item-1", "tenant-a")).toEqual({ name: "Alice" });
      expect(await kv.get("item-1", "tenant-b")).toEqual({ name: "Bob" });
      expect(await kv.get("item-1")).toBeNull();
      expect(await kv.get("global-1")).toEqual({ name: "Global" });

      // List
      const listA = await kv.list({ tenantId: "tenant-a" });
      expect(listA).toEqual([{ key: "item-1", value: { name: "Alice" } }]);

      // Delete
      expect(await kv.delete("item-1", "tenant-a")).toBe(true);
      expect(await kv.get("item-1", "tenant-a")).toBeNull();
      expect(await kv.get("item-1", "tenant-b")).toEqual({ name: "Bob" });

      // TTL expiration
      await kv.set("short-lived", { name: "Fast" }, { ttlMs: 10 });
      expect(await kv.get("short-lived")).toEqual({ name: "Fast" });
      await new Promise((r) => setTimeout(r, 25));
      expect(await kv.get("short-lived")).toBeNull();

      // Clear
      await kv.clear("tenant-b");
      expect(await kv.get("item-1", "tenant-b")).toBeNull();
    });

    it("handles BlobPayloadStore with size limits and TTL", async () => {
      const blobs = storage.getBlobPayloadStore("test-blobs");

      // Size cap error
      const bigString = "x".repeat(100);
      await expect(
        blobs.put("h-large", bigString, { maxByteSize: 50 }),
      ).rejects.toThrow(StoragePayloadTooLargeError);

      // Normal put and get
      const saved = await blobs.put("rhv1.1", JSON.stringify({ ok: true }), {
        tenantId: "tenant-a",
        principalId: "p1",
      });
      expect(saved.handle).toBe("rhv1.1");
      expect(saved.byteSize).toBeGreaterThan(0);

      // Scoped get
      const retrieved = await blobs.get("rhv1.1", {
        tenantId: "tenant-a",
        principalId: "p1",
      });
      expect(retrieved?.data).toBe(JSON.stringify({ ok: true }));

      // Principal mismatch
      expect(
        await blobs.get("rhv1.1", {
          tenantId: "tenant-a",
          principalId: "p2",
        }),
      ).toBeNull();

      // TTL and prune
      await blobs.put("rhv1.expired", "temp", { ttlMs: 10 });
      await new Promise((r) => setTimeout(r, 25));
      expect(await blobs.get("rhv1.expired")).toBeNull();
      const pruned = await blobs.pruneExpired();
      expect(pruned).toBe(0); // already removed on read
    });

    it("handles TelemetryRingBuffer with batching and capacity limits", async () => {
      const buffer = storage.getTelemetryRingBuffer({ maxEntries: 3 });

      await buffer.push({
        id: "ev-1",
        timestamp: 100,
        tenantId: "t1",
        toolName: "fetch_data",
        durationMs: 12.5,
      });

      await buffer.pushBatch([
        { id: "ev-2", timestamp: 200, tenantId: "t1", toolName: "post_data" },
        { id: "ev-3", timestamp: 300, tenantId: "t2", toolName: "fetch_data" },
        { id: "ev-4", timestamp: 400, tenantId: "t1", toolName: "fetch_data" },
      ]);

      // Buffer ring dropped oldest (ev-1)
      const all = await buffer.query();
      expect(all.map((e) => e.id)).toEqual(["ev-2", "ev-3", "ev-4"]);

      // Filter by tenant
      const t1Only = await buffer.query({ tenantId: "t1" });
      expect(t1Only.map((e) => e.id)).toEqual(["ev-2", "ev-4"]);

      // Filter by tool
      const fetchOnly = await buffer.query({ toolName: "fetch_data" });
      expect(fetchOnly.map((e) => e.id)).toEqual(["ev-3", "ev-4"]);

      // Filter by until, isError, and order
      await buffer.push({
        id: "ev-5",
        timestamp: 500,
        tenantId: "t1",
        toolName: "fetch_data",
        isError: true,
      });

      const errs = await buffer.query({ isError: true });
      expect(errs.map((e) => e.id)).toEqual(["ev-5"]);

      const timeBounded = await buffer.query({ since: 250, until: 450 });
      expect(timeBounded.map((e) => e.id)).toEqual(["ev-3", "ev-4"]);

      const descOrdered = await buffer.query({ order: "desc", limit: 2 });
      expect(descOrdered.map((e) => e.id)).toEqual(["ev-5", "ev-4"]);

      const offsetDesc = await buffer.query({
        order: "desc",
        offset: 1,
        limit: 2,
      });
      expect(offsetDesc.map((e) => e.id)).toEqual(["ev-4", "ev-3"]);
    });
  });

  describe("SqliteStorageDriver", () => {
    describe("in-memory mode (:memory:)", () => {
      let storage: ReturnType<typeof createSqliteStorageDriver>;

      beforeEach(async () => {
        storage = createSqliteStorageDriver({ path: ":memory:" });
        await storage.init();
      });

      afterEach(async () => {
        await storage.close();
      });

      it("verifies health check and uninitialized guard", async () => {
        expect(await storage.ping()).toBe(true);

        const uninitStorage = createSqliteStorageDriver();
        expect(() => uninitStorage.getKeyValueStore("test")).toThrow(
          "Storage driver is not initialized",
        );
      });

      it("handles KeyValueStore CRUD, upsert, and tenant isolation", async () => {
        const kv = storage.getKeyValueStore<{ count: number }>("kv-test");

        await kv.set("counter", { count: 1 }, { tenantId: "tenant-1" });
        expect(await kv.get("counter", "tenant-1")).toEqual({ count: 1 });

        // Upsert update
        await kv.set("counter", { count: 2 }, { tenantId: "tenant-1" });
        expect(await kv.get("counter", "tenant-1")).toEqual({ count: 2 });

        // Tenant 2 isolation
        expect(await kv.get("counter", "tenant-2")).toBeNull();

        // Listing with prefix
        await kv.set("pref_a", { count: 10 }, { tenantId: "tenant-1" });
        await kv.set("pref_b", { count: 20 }, { tenantId: "tenant-1" });
        const listPref = await kv.list({
          tenantId: "tenant-1",
          prefix: "pref_",
        });
        expect(listPref).toHaveLength(2);

        // Delete
        expect(await kv.delete("counter", "tenant-1")).toBe(true);
        expect(await kv.get("counter", "tenant-1")).toBeNull();

        // TTL
        await kv.set("ttl-key", { count: 99 }, { ttlMs: 15 });
        expect(await kv.get("ttl-key")).toEqual({ count: 99 });
        await new Promise((r) => setTimeout(r, 25));
        expect(await kv.get("ttl-key")).toBeNull();
      });

      it("handles BlobPayloadStore with caps and deletion", async () => {
        const blobs = storage.getBlobPayloadStore("blobs-test");

        // Payload cap
        await expect(
          blobs.put("toolarge", "xyz", { maxByteSize: 2 }),
        ).rejects.toThrow(StoragePayloadTooLargeError);

        // Put and retrieve
        await blobs.put("rhv1.abc", '{"status":"ok"}', {
          tenantId: "t1",
          principalId: "user-1",
        });

        const entry = await blobs.get("rhv1.abc", {
          tenantId: "t1",
          principalId: "user-1",
        });
        expect(entry).not.toBeNull();
        expect(entry?.data).toBe('{"status":"ok"}');

        // Delete with principal verification
        expect(
          await blobs.delete("rhv1.abc", {
            tenantId: "t1",
            principalId: "wrong",
          }),
        ).toBe(false);
        expect(
          await blobs.delete("rhv1.abc", {
            tenantId: "t1",
            principalId: "user-1",
          }),
        ).toBe(true);
        expect(await blobs.get("rhv1.abc", { tenantId: "t1" })).toBeNull();
      });

      it("handles TelemetryRingBuffer with pruning", async () => {
        const ring = storage.getTelemetryRingBuffer({ maxEntries: 2 });

        await ring.pushBatch([
          { id: "e1", timestamp: 1000, toolName: "t_one", isError: false },
          { id: "e2", timestamp: 2000, toolName: "t_two", isError: true },
          { id: "e3", timestamp: 3000, toolName: "t_three", isError: false },
        ]);

        const events = await ring.query();
        expect(events).toHaveLength(2);
        expect(events.map((e) => e.id)).toEqual(["e2", "e3"]);

        const filtered = await ring.query({ since: 2500 });
        expect(filtered.map((e) => e.id)).toEqual(["e3"]);

        const errs = await ring.query({ isError: true });
        expect(errs.map((e) => e.id)).toEqual(["e2"]);

        const descOrdered = await ring.query({ order: "desc" });
        expect(descOrdered.map((e) => e.id)).toEqual(["e3", "e2"]);

        await ring.clear();
        expect(await ring.query()).toHaveLength(0);
      });
    });

    describe("file-backed WAL mode", () => {
      let tempDir: string;
      let dbPath: string;

      beforeEach(async () => {
        tempDir = await mkdtemp(join(tmpdir(), "chainmcp-storage-test-"));
        dbPath = join(tempDir, "studio.db");
      });

      afterEach(async () => {
        await rm(tempDir, { recursive: true, force: true });
      });

      it("initializes SQLite with WAL mode and survives restart", async () => {
        const driver1 = createSqliteStorageDriver({ path: dbPath });
        await driver1.init();

        const kv1 = driver1.getKeyValueStore("contracts");
        await kv1.set(
          "order_api",
          { version: "1.0.0" },
          { tenantId: "tenant-xyz" },
        );

        const blobs1 = driver1.getBlobPayloadStore();
        await blobs1.put("rhv1.persistent", "payload-data", {
          tenantId: "tenant-xyz",
        });

        await driver1.close();

        // Reconnect new driver to same DB file
        const driver2 = createSqliteStorageDriver({ path: dbPath });
        await driver2.init();

        const kv2 = driver2.getKeyValueStore("contracts");
        const persisted = await kv2.get("order_api", "tenant-xyz");
        expect(persisted).toEqual({ version: "1.0.0" });

        const blobs2 = driver2.getBlobPayloadStore();
        const persistedBlob = await blobs2.get("rhv1.persistent", {
          tenantId: "tenant-xyz",
        });
        expect(persistedBlob?.data).toBe("payload-data");

        await driver2.close();
      });
    });
  });
});

import { describe, expect, it } from "vitest";

import { createCacheKey, InMemoryCacheStore } from "../src/index.js";

const keyParts = {
  tenantId: "tenant-a",
  principalId: "principal-1",
  authorizationPartition: "effective-grants-read-v1",
  contractRevision: "catalog-r1",
  toolName: "lookup_item",
  arguments: { id: "item-1" },
};

function key(
  overrides: Partial<Omit<typeof keyParts, "arguments">> & {
    arguments?: unknown;
  } = {},
): string {
  return createCacheKey({ ...keyParts, ...overrides });
}

describe("InMemoryCacheStore", () => {
  it("expires entries using an injected monotonic clock", async () => {
    let now = 10;
    const cache = new InMemoryCacheStore({ monotonicNow: () => now });
    const cacheKey = key();
    await cache.set(cacheKey, { result: "cached" }, 1);

    expect(await cache.get(cacheKey)).toEqual({ result: "cached" });
    now = 1_010;
    expect(await cache.get(cacheKey)).toBeUndefined();
  });

  it("evicts least-recently-used entries at the entry-count bound", async () => {
    const cache = new InMemoryCacheStore({ maxEntries: 2 });
    const first = key({ arguments: { id: "first" } });
    const second = key({ arguments: { id: "second" } });
    const third = key({ arguments: { id: "third" } });
    await cache.set(first, "first", 60);
    await cache.set(second, "second", 60);
    expect(await cache.get(first)).toBe("first");

    await cache.set(third, "third", 60);

    expect(await cache.get(first)).toBe("first");
    expect(await cache.get(second)).toBeUndefined();
    expect(await cache.get(third)).toBe("third");
  });

  it("evicts least-recently-used entries at the retained-byte bound", async () => {
    const values = ["a".repeat(20), "b".repeat(20), "c".repeat(20)];
    const keys = values.map((value) => key({ arguments: { value } }));
    const entryBytes = values.map(
      (value, index) =>
        Buffer.byteLength(keys[index] ?? "", "utf8") +
        Buffer.byteLength(JSON.stringify(value) ?? "", "utf8"),
    );
    const maxBytes = (entryBytes[0] ?? 0) + (entryBytes[1] ?? 0);
    const cache = new InMemoryCacheStore({
      maxBytes,
      maxEntryBytes: Math.max(...entryBytes),
    });
    for (let index = 0; index < values.length; index += 1) {
      const cacheKey = keys[index];
      const value = values[index];
      if (cacheKey !== undefined && value !== undefined) {
        await cache.set(cacheKey, value, 60);
      }
    }

    expect(await cache.get(keys[0] ?? "")).toBeUndefined();
    expect(await cache.get(keys[1] ?? "")).toBe(values[1]);
    expect(await cache.get(keys[2] ?? "")).toBe(values[2]);
  });

  it("bounds retained bytes and does not replace an entry with an oversized value", async () => {
    const cache = new InMemoryCacheStore({
      maxBytes: 256,
      maxEntryBytes: 128,
    });
    const cacheKey = key();
    await cache.set(cacheKey, "retained", 60);

    await expect(cache.set(cacheKey, "x".repeat(200), 60)).rejects.toThrow(
      "Cache entry exceeds the maximum",
    );
    expect(await cache.get(cacheKey)).toBe("retained");
  });

  it("rejects invalid TTLs and unsafe keys", async () => {
    const cache = new InMemoryCacheStore({ maxTtlSeconds: 30 });
    await expect(cache.set(key(), "value", 0)).rejects.toThrow("ttlSeconds");
    await expect(cache.set(key(), "value", 31)).rejects.toThrow("ttlSeconds");
    await expect(
      cache.set("Bearer credential-value", "value", 30),
    ).rejects.toThrow("current-version SHA-256 digests");
    await expect(cache.get("Bearer credential-value")).rejects.toThrow(
      "current-version SHA-256 digests",
    );
    await expect(cache.delete("tenant-a:principal-1")).rejects.toThrow(
      "current-version SHA-256 digests",
    );
    await expect(cache.get(key().replace(":v2:", ":v1:"))).rejects.toThrow(
      "current-version SHA-256 digests",
    );
  });

  it("validates constructor bounds and the clock injection", () => {
    expect(() => new InMemoryCacheStore({ maxEntries: 0 })).toThrow(
      "maxEntries",
    );
    expect(() => new InMemoryCacheStore({ maxBytes: 1.5 })).toThrow("maxBytes");
    expect(
      () => new InMemoryCacheStore({ maxBytes: 128, maxEntryBytes: 256 }),
    ).toThrow("maxEntryBytes must not exceed maxBytes");
    expect(
      () =>
        new InMemoryCacheStore({
          monotonicNow: "now" as unknown as () => number,
        }),
    ).toThrow("monotonicNow");
  });

  it("deletes entries explicitly", async () => {
    const cache = new InMemoryCacheStore();
    const cacheKey = key();
    await cache.set(cacheKey, "value", 60);
    await cache.delete(cacheKey);
    expect(await cache.get(cacheKey)).toBeUndefined();
    await expect(cache.delete(cacheKey)).resolves.toBeUndefined();
  });

  it("rejects non-JSON values rather than normalizing them into cache entries", async () => {
    const cache = new InMemoryCacheStore();
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;

    await expect(cache.set(key(), undefined, 60)).rejects.toThrow(
      "JSON-serializable",
    );
    await expect(cache.set(key(), 1n, 60)).rejects.toThrow("JSON-serializable");
    await expect(cache.set(key(), cyclic, 60)).rejects.toThrow("cycles");
    await expect(cache.set(key(), { count: Number.NaN }, 60)).rejects.toThrow(
      "finite numbers",
    );
    await expect(cache.set(key(), { optional: undefined }, 60)).rejects.toThrow(
      "JSON-serializable",
    );
    await expect(cache.set(key(), new Array(1), 60)).rejects.toThrow("sparse");
    await expect(cache.set(key(), new Date(0), 60)).rejects.toThrow(
      "plain objects",
    );
    const accessor = Object.defineProperty({}, "value", {
      enumerable: true,
      get: () => "must not execute",
    });
    await expect(cache.set(key(), accessor, 60)).rejects.toThrow("accessors");
  });

  it("rejects callable toJSON so serialization cannot bypass value bounds", async () => {
    const cache = new InMemoryCacheStore();
    const enumerable = { value: 1, toJSON: () => ({ evil: true }) };
    const nonEnumerable = { value: 1 };
    Object.defineProperty(nonEnumerable, "toJSON", {
      value: () => ({ evil: true }),
    });
    let accessorCalled = false;
    const accessor = { value: 1 };
    Object.defineProperty(accessor, "toJSON", {
      get: () => {
        accessorCalled = true;
        return () => ({ evil: true });
      },
    });

    await expect(cache.set(key(), enumerable, 60)).rejects.toThrow("toJSON");
    await expect(cache.set(key(), nonEnumerable, 60)).rejects.toThrow("toJSON");
    await expect(cache.set(key(), accessor, 60)).rejects.toThrow("toJSON");
    expect(accessorCalled).toBe(false);
  });

  it("bounds value depth and node count before retaining entries", async () => {
    const cache = new InMemoryCacheStore();
    let deeplyNested: Record<string, unknown> = { leaf: true };
    for (let depth = 0; depth < 70; depth += 1) {
      deeplyNested = { next: deeplyNested };
    }

    await expect(cache.set(key(), deeplyNested, 60)).rejects.toThrow(
      "maximum depth",
    );
    await expect(
      cache.set(key(), new Array(50_000).fill("node"), 60),
    ).rejects.toThrow("maximum of 50000 nodes");
  });

  it("returns isolated JSON copies on each hit", async () => {
    const cache = new InMemoryCacheStore();
    const cacheKey = key();
    await cache.set(cacheKey, { nested: { value: 1 } }, 60);

    const first = await cache.get<{ nested: { value: number } }>(cacheKey);
    if (!first) throw new Error("expected a cache hit");
    first.nested.value = 9;

    expect(await cache.get(cacheKey)).toEqual({ nested: { value: 1 } });
  });

  it("partitions cached values by tenant and effective authorization context", async () => {
    const cache = new InMemoryCacheStore();
    const tenantKey = key({ tenantId: "tenant-b" });
    const authorizationKey = key({
      authorizationPartition: "effective-grants-admin-v1",
    });
    const originalKey = key();
    await cache.set(originalKey, { secret: "tenant-a-read" }, 60);

    expect(tenantKey).not.toBe(originalKey);
    expect(authorizationKey).not.toBe(originalKey);
    expect(await cache.get(tenantKey)).toBeUndefined();
    expect(await cache.get(authorizationKey)).toBeUndefined();
    expect(await cache.get(originalKey)).toEqual({
      secret: "tenant-a-read",
    });
    expect(originalKey).not.toContain("tenant-a");
    expect(originalKey).not.toContain("effective-grants-read-v1");
  });
});

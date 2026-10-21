import { describe, expect, it, vi } from "vitest";

import {
  createCacheKey,
  InMemoryToolRuntime,
  type ToolContext,
  type ToolDefinition,
} from "@chainmcp/core";

import {
  DEFAULT_REDIS_COMMAND_TIMEOUT_MS,
  RedisCacheStore,
  type RedisCacheClient,
} from "../src/index.js";

function cacheKey(argumentsValue: unknown = {}): string {
  return createCacheKey({
    tenantId: "tenant-1",
    principalId: "user-1",
    authorizationPartition: "read",
    contractRevision: "rev-1",
    toolName: "lookup_item",
    arguments: argumentsValue,
  });
}

interface FakeClient {
  client: RedisCacheClient;
  data: Map<string, string>;
  calls: Array<{
    operation: "get" | "set" | "delete";
    key: string;
    value?: string;
    ttlMilliseconds?: number;
  }>;
}

function fakeClient(overrides: Partial<RedisCacheClient> = {}): FakeClient {
  const data = new Map<string, string>();
  const calls: FakeClient["calls"] = [];
  const client: RedisCacheClient = {
    async get(key) {
      calls.push({ operation: "get", key });
      return data.get(key) ?? null;
    },
    async set(key, value, ttlMilliseconds) {
      calls.push({ operation: "set", key, value, ttlMilliseconds });
      data.set(key, value);
    },
    async delete(key) {
      calls.push({ operation: "delete", key });
      data.delete(key);
    },
    ...overrides,
  };
  return { client, data, calls };
}

describe("RedisCacheStore", () => {
  it("stores JSON with a millisecond TTL and reads it back", async () => {
    const { client, data, calls } = fakeClient();
    const store = new RedisCacheStore({ client, keyPrefix: "chainmcp:test:" });
    const key = cacheKey();

    await store.set(key, { value: "fresh" }, 60);

    expect(data.get(`chainmcp:test:${key}`)).toBe('{"value":"fresh"}');
    expect(calls[0]).toMatchObject({
      operation: "set",
      key: `chainmcp:test:${key}`,
      value: '{"value":"fresh"}',
      ttlMilliseconds: 60_000,
    });
    await expect(store.get(key)).resolves.toEqual({ value: "fresh" });
  });

  it("returns undefined for a miss", async () => {
    const { client } = fakeClient();
    const store = new RedisCacheStore({ client });

    await expect(store.get(cacheKey())).resolves.toBeUndefined();
  });

  it("returns isolated values on every read", async () => {
    const { client } = fakeClient();
    const store = new RedisCacheStore({ client });
    const key = cacheKey();
    await store.set(key, { nested: { value: "fresh" } }, 60);

    const first = (await store.get<{ nested: { value: string } }>(key))!;
    first.nested.value = "mutated";

    await expect(store.get(key)).resolves.toEqual({
      nested: { value: "fresh" },
    });
  });

  it("deletes the prefixed storage key", async () => {
    const { client, data, calls } = fakeClient();
    const store = new RedisCacheStore({ client, keyPrefix: "p:" });
    const key = cacheKey();
    await store.set(key, { value: "fresh" }, 60);

    await store.delete(key);

    expect(data.has(`p:${key}`)).toBe(false);
    expect(calls.at(-1)).toEqual({ operation: "delete", key: `p:${key}` });
  });

  it("rejects keys that are not current hashed cache keys", async () => {
    const { client } = fakeClient();
    const store = new RedisCacheStore({ client });

    for (const operation of [
      () => store.get("not-a-key"),
      () => store.set("not-a-key", { value: "fresh" }, 60),
      () => store.delete("not-a-key"),
    ]) {
      await expect(operation()).rejects.toBeInstanceOf(TypeError);
    }
  });

  it("rejects invalid TTLs and oversized entries", async () => {
    const { client } = fakeClient();
    const store = new RedisCacheStore({
      client,
      maxTtlSeconds: 60,
      maxEntryBytes: 200,
    });
    const key = cacheKey();

    for (const ttl of [0, -1, Number.NaN, Infinity, 61]) {
      await expect(
        store.set(key, { value: "fresh" }, ttl),
      ).rejects.toBeInstanceOf(TypeError);
    }
    await expect(
      store.set(key, { value: "x".repeat(200) }, 60),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it("rejects non-JSON and unbounded values before calling Redis", async () => {
    const { client, calls } = fakeClient();
    const store = new RedisCacheStore({ client });
    const key = cacheKey();
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    const callableToJSON = { toJSON: () => ({ value: "fresh" }) };

    for (const value of [undefined, cyclic, BigInt(1), callableToJSON]) {
      await expect(store.set(key, value, 60)).rejects.toBeInstanceOf(TypeError);
    }
    expect(calls).toHaveLength(0);
  });

  it("rejects corrupt, deeply nested, or oversized values returned by Redis", async () => {
    const key = cacheKey();
    for (const [raw, maxEntryBytes] of [
      ["not-json", 200],
      [`${"[".repeat(70)}0${"]".repeat(70)}`, 500],
      [JSON.stringify({ value: "x".repeat(200) }), 200],
    ] as const) {
      const { client } = fakeClient({
        get: async () => raw,
      });
      const store = new RedisCacheStore({ client, maxEntryBytes });
      await expect(store.get(key)).rejects.toBeInstanceOf(TypeError);
    }

    const { client } = fakeClient({
      get: async () => 123 as never,
    });
    const store = new RedisCacheStore({ client });
    await expect(store.get(key)).rejects.toBeInstanceOf(TypeError);
  });

  it("propagates client failures to the caller", async () => {
    const { client } = fakeClient({
      get: async () => {
        throw new Error("redis unavailable");
      },
    });
    const store = new RedisCacheStore({ client });

    await expect(store.get(cacheKey())).rejects.toThrow("redis unavailable");
  });

  it("bounds commands that never settle", async () => {
    const { client } = fakeClient({
      get: async () => new Promise<string | null>(() => {}),
    });
    const store = new RedisCacheStore({ client, commandTimeoutMs: 5 });

    await expect(store.get(cacheKey())).rejects.toThrow(
      /Redis cache get timed out after 5ms/,
    );
  });

  it("validates constructor options", () => {
    expect(() => new RedisCacheStore({} as never)).toThrow(TypeError);
    expect(
      () =>
        new RedisCacheStore({
          client: { get: async () => null } as never,
        }),
    ).toThrow(TypeError);
    for (const keyPrefix of [
      "",
      "with space",
      "x".repeat(129),
      "snowman-\u2603",
    ]) {
      expect(
        () =>
          new RedisCacheStore({
            client: fakeClient().client,
            keyPrefix,
          }),
      ).toThrow(TypeError);
    }
    for (const options of [
      { maxEntryBytes: 0 },
      { maxEntryBytes: 1.5 },
      { maxTtlSeconds: 0 },
      { commandTimeoutMs: 0 },
    ]) {
      expect(
        () =>
          new RedisCacheStore({
            client: fakeClient().client,
            ...options,
          }),
      ).toThrow(TypeError);
    }
  });

  it("serves runtime cache hits through the Redis store", async () => {
    const { client, data } = fakeClient();
    const runtime = new InMemoryToolRuntime({
      cache: {
        store: new RedisCacheStore({ client, keyPrefix: "runtime:" }),
        authorizationPartition: () => "read",
      },
    });
    const context: ToolContext = {
      requestId: "req-1",
      tenantId: "tenant-1",
      principal: { id: "user-1", scopes: ["read"] },
    };
    const execute = vi.fn(async () => ({ value: "fresh" }));
    const definition: ToolDefinition = {
      name: "lookup_item",
      description: "Look up a test item",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        additionalProperties: false,
      },
      operation: {},
      contractRevision: "rev-1",
      cache: { ttlSeconds: 60 },
      execute,
    };
    runtime.register(definition);

    await expect(
      runtime.callTool("lookup_item", { id: "a" }, context),
    ).resolves.toEqual({ value: "fresh" });
    await expect(
      runtime.callTool("lookup_item", { id: "a" }, context),
    ).resolves.toEqual({ value: "fresh" });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(data.size).toBe(1);
    expect([...data.keys()][0]).toMatch(/^runtime:chainmcp:cache:v2:/);
  });

  it("exports the default command timeout", () => {
    expect(DEFAULT_REDIS_COMMAND_TIMEOUT_MS).toBe(1_000);
  });
});

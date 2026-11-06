import { describe, expect, it } from "vitest";
import { createCacheKey } from "@chainmcp/core";
import {
  createSimpleRedisClient,
  redactRedisUrl,
  sanitizeError,
  sanitizeString,
} from "../src/client.js";
import { RedisCacheStore, type RedisCacheClient } from "../src/index.js";

function validKey(): string {
  return createCacheKey({
    tenantId: "tenant-1",
    principalId: "user-1",
    authorizationPartition: "part",
    contractRevision: "rev-1",
    toolName: "myTool",
    arguments: { q: "test" },
  });
}

describe("Cache Redis Additional Tests (index.ts and client.ts)", () => {
  describe("redactRedisUrl and sanitize helpers", () => {
    it("redactRedisUrl handles malformed URLs safely", () => {
      expect(redactRedisUrl("not a valid url :// ::")).toBe("[REDACTED_URL]");
    });

    it("sanitizeString handles URL-encoded secret characters", () => {
      const secret = "pass@word#123";
      const sanitized = sanitizeString(
        "Connecting with pass@word#123 and pass%40word%23123",
        [secret],
      );
      expect(sanitized).toBe("Connecting with [REDACTED] and [REDACTED]");
    });

    it("sanitizeError recursively sanitizes error cause", () => {
      const secret = "super_secret_token";
      const cause = new Error(`Root cause leaked ${secret}`);
      const parent = new Error(`Parent failed with ${secret}`, { cause });

      sanitizeError(parent, [secret]);
      expect(parent.message).not.toContain(secret);
      expect(parent.message).toContain("[REDACTED]");
      expect(cause.message).not.toContain(secret);
      expect(cause.message).toContain("[REDACTED]");
    });
  });

  describe("RedisCacheStore constructor and option validation", () => {
    it("rejects invalid client implementations", () => {
      expect(
        () =>
          new RedisCacheStore(null as unknown as { client: RedisCacheClient }),
      ).toThrow("RedisCacheStore requires a client");

      expect(
        () =>
          new RedisCacheStore({
            client: { get: async () => null } as unknown as RedisCacheClient,
          }),
      ).toThrow("RedisCacheStore requires a client with get, set, and delete");
    });

    it("validates keyPrefix constraints", () => {
      const client: RedisCacheClient = {
        get: async () => null,
        set: async () => {},
        delete: async () => {},
      };

      expect(() => new RedisCacheStore({ client, keyPrefix: "" })).toThrow(
        "keyPrefix must be 1-128 printable ASCII characters",
      );

      expect(
        () => new RedisCacheStore({ client, keyPrefix: "a".repeat(129) }),
      ).toThrow("keyPrefix must be 1-128 printable ASCII characters");

      expect(
        () => new RedisCacheStore({ client, keyPrefix: "bad\nprefix" }),
      ).toThrow("keyPrefix must be 1-128 printable ASCII characters");

      // Valid prefix works
      const store = new RedisCacheStore({ client, keyPrefix: "valid:prefix:" });
      expect(store).toBeDefined();
    });

    it("validates positive safe integer bounds for numeric options", () => {
      const client: RedisCacheClient = {
        get: async () => null,
        set: async () => {},
        delete: async () => {},
      };

      expect(() => new RedisCacheStore({ client, maxEntryBytes: 0 })).toThrow(
        "maxEntryBytes must be a positive safe integer",
      );

      expect(() => new RedisCacheStore({ client, maxTtlSeconds: -5 })).toThrow(
        "maxTtlSeconds must be a positive safe integer",
      );

      expect(
        () => new RedisCacheStore({ client, commandTimeoutMs: 1.5 }),
      ).toThrow("commandTimeoutMs must be a positive safe integer");
    });
  });

  describe("RedisCacheStore get, set, and delete edge cases", () => {
    it("rejects get when key is not a current-version SHA-256 digest", async () => {
      const client: RedisCacheClient = {
        get: async () => null,
        set: async () => {},
        delete: async () => {},
      };
      const store = new RedisCacheStore({ client });

      await expect(store.get("invalid-raw-key")).rejects.toThrow(
        "Redis cache keys must be current-version SHA-256 digests from createCacheKey",
      );
    });

    it("rejects get when raw value is not a string", async () => {
      const client: RedisCacheClient = {
        get: async () => 12345 as unknown as string,
        set: async () => {},
        delete: async () => {},
      };
      const store = new RedisCacheStore({ client });

      await expect(store.get(validKey())).rejects.toThrow(
        "Redis cache values must be strings",
      );
    });

    it("rejects get when entry bytes exceed maxEntryBytes", async () => {
      const client: RedisCacheClient = {
        get: async () => JSON.stringify({ large: "x".repeat(200) }),
        set: async () => {},
        delete: async () => {},
      };
      const store = new RedisCacheStore({ client, maxEntryBytes: 100 });

      await expect(store.get(validKey())).rejects.toThrow(
        "Redis cache entry exceeds the maximum of 100 bytes",
      );
    });

    it("rejects get when value is not valid JSON", async () => {
      const client: RedisCacheClient = {
        get: async () => "{ invalid json syntax",
        set: async () => {},
        delete: async () => {},
      };
      const store = new RedisCacheStore({ client });

      await expect(store.get(validKey())).rejects.toThrow(
        "Redis cache value is not valid JSON",
      );
    });

    it("validates set ttlSeconds bounds", async () => {
      const client: RedisCacheClient = {
        get: async () => null,
        set: async () => {},
        delete: async () => {},
      };
      const store = new RedisCacheStore({ client, maxTtlSeconds: 300 });

      await expect(store.set(validKey(), { a: 1 }, 0)).rejects.toThrow(
        "ttlSeconds must be greater than 0 and at most 300",
      );
      await expect(store.set(validKey(), { a: 1 }, -10)).rejects.toThrow(
        "ttlSeconds must be greater than 0 and at most 300",
      );
      await expect(store.set(validKey(), { a: 1 }, 301)).rejects.toThrow(
        "ttlSeconds must be greater than 0 and at most 300",
      );
      await expect(store.set(validKey(), { a: 1 }, Number.NaN)).rejects.toThrow(
        "ttlSeconds must be greater than 0 and at most 300",
      );
    });

    it("rejects set when value is not JSON-serializable", async () => {
      const client: RedisCacheClient = {
        get: async () => null,
        set: async () => {},
        delete: async () => {},
      };
      const store = new RedisCacheStore({ client });

      const circular: Record<string, unknown> = {};
      circular.self = circular;

      await expect(store.set(validKey(), circular, 60)).rejects.toThrow(
        "Redis cache values must be JSON-serializable",
      );

      await expect(
        store.set(validKey(), BigInt(123) as unknown as number, 60),
      ).rejects.toThrow("Redis cache values must be JSON-serializable");
    });

    it("rejects set when serialized entry exceeds maxEntryBytes", async () => {
      const client: RedisCacheClient = {
        get: async () => null,
        set: async () => {},
        delete: async () => {},
      };
      const store = new RedisCacheStore({ client, maxEntryBytes: 80 });

      await expect(
        store.set(validKey(), { data: "large payload string" }, 60),
      ).rejects.toThrow("Redis cache entry exceeds the maximum of 80 bytes");
    });

    it("times out slow commands using commandTimeoutMs", async () => {
      const client: RedisCacheClient = {
        get: () =>
          new Promise((resolve) => setTimeout(() => resolve(null), 200)),
        set: async () => {},
        delete: async () => {},
      };
      const store = new RedisCacheStore({ client, commandTimeoutMs: 20 });

      await expect(store.get(validKey())).rejects.toThrow(
        "Redis cache get timed out after 20ms",
      );
    });
  });

  describe("SimpleRedisClient closed state and status", () => {
    it("reports client status and rejects commands after close", async () => {
      const client = createSimpleRedisClient({
        host: "127.0.0.1",
        port: 6379,
        timeoutMs: 100,
      });

      const initialStatus = client.getStatus();
      expect(initialStatus.isClosed).toBe(false);
      expect(initialStatus.totalConnections).toBe(0);

      await client.close();

      const closedStatus = client.getStatus();
      expect(closedStatus.isClosed).toBe(true);

      await expect(client.get("test")).rejects.toThrow(
        "Redis client is closed",
      );
      await expect(client.set("test", "val", 1000)).rejects.toThrow(
        "Redis client is closed",
      );
      await expect(client.delete("test")).rejects.toThrow(
        "Redis client is closed",
      );
      await expect(client.eval("return 1", [], [])).rejects.toThrow(
        "Redis client is closed",
      );
    });
  });
});

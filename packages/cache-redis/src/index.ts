import {
  assertJsonCacheValue,
  DEFAULT_CACHE_MAX_ENTRY_BYTES,
  DEFAULT_CACHE_MAX_TTL_SECONDS,
  isCurrentCacheKey,
  type CacheStore,
} from "@chainmcp/core";

/**
 * The Redis commands the adapter needs, with values passed as strings so the
 * adapter can enforce serialization, size, and TTL policy itself.
 *
 * `set` receives a TTL in milliseconds. For `node-redis`:
 *
 * ```ts
 * set: (key, value, ttlMs) => client.set(key, value, { PX: ttlMs }),
 * delete: (key) => client.del(key),
 * ```
 *
 * For `ioredis`, use `set(key, value, "PX", ttlMs)` and `del`.
 */
export interface RedisCacheClient {
  get(key: string): Promise<string | null | undefined>;
  set(key: string, value: string, ttlMilliseconds: number): Promise<unknown>;
  delete(key: string): Promise<unknown>;
}

export interface RedisCacheStoreOptions {
  /** Redis client wrapper implementing the three required commands. */
  client: RedisCacheClient;
  /**
   * Optional literal prefix added to every storage key, for example
   * `chainmcp:prod:`. It must be 1-128 printable ASCII characters. Changing it
   * makes existing entries unreachable; rotate it deliberately.
   */
  keyPrefix?: string;
  /** Maximum key plus serialized-value bytes. Defaults to 256 KiB. */
  maxEntryBytes?: number;
  /** Maximum accepted TTL. Defaults to 3,600 seconds. */
  maxTtlSeconds?: number;
  /** Per-command latency bound. Defaults to 1,000 ms. */
  commandTimeoutMs?: number;
}

export const DEFAULT_REDIS_COMMAND_TIMEOUT_MS = 1_000;

/**
 * Redis-backed `CacheStore` for deployments that need a shared cache. The
 * adapter validates current-version hashed keys, serializes values itself,
 * enforces TTL and entry-size caps, and bounds each Redis command.
 *
 * It does not manage the Redis connection, retries, TLS, credentials, or
 * cluster topology; those belong to the supplied client. A store outage or a
 * corrupt value is reported as a rejection, which the runtime treats as a
 * cache bypass or miss rather than an invocation failure.
 */
export class RedisCacheStore implements CacheStore {
  private readonly client: RedisCacheClient;
  private readonly keyPrefix: string;
  private readonly maxEntryBytes: number;
  private readonly maxTtlSeconds: number;
  private readonly commandTimeoutMs: number;

  constructor(options: RedisCacheStoreOptions) {
    if (options === null || typeof options !== "object") {
      throw new TypeError("RedisCacheStore requires a client");
    }
    const client = options.client;
    if (
      client === null ||
      typeof client !== "object" ||
      typeof client.get !== "function" ||
      typeof client.set !== "function" ||
      typeof client.delete !== "function"
    ) {
      throw new TypeError(
        "RedisCacheStore requires a client with get, set, and delete",
      );
    }
    this.client = client;
    this.keyPrefix = parseKeyPrefix(options.keyPrefix);
    this.maxEntryBytes = positiveSafeInteger(
      options.maxEntryBytes ?? DEFAULT_CACHE_MAX_ENTRY_BYTES,
      "maxEntryBytes",
    );
    this.maxTtlSeconds = positiveSafeInteger(
      options.maxTtlSeconds ?? DEFAULT_CACHE_MAX_TTL_SECONDS,
      "maxTtlSeconds",
    );
    this.commandTimeoutMs = positiveSafeInteger(
      options.commandTimeoutMs ?? DEFAULT_REDIS_COMMAND_TIMEOUT_MS,
      "commandTimeoutMs",
    );
  }

  async get<T>(key: string): Promise<T | undefined> {
    const storageKey = this.storageKey(key);
    const raw = await this.run("get", () => this.client.get(storageKey));
    if (raw === null || raw === undefined) return undefined;
    if (typeof raw !== "string") {
      throw new TypeError("Redis cache values must be strings");
    }
    if (
      Buffer.byteLength(storageKey, "utf8") + Buffer.byteLength(raw, "utf8") >
      this.maxEntryBytes
    ) {
      throw new TypeError(
        `Redis cache entry exceeds the maximum of ${this.maxEntryBytes} bytes`,
      );
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new TypeError("Redis cache value is not valid JSON");
    }
    try {
      assertJsonCacheValue(value);
    } catch (error) {
      throw new TypeError("Redis cache value is not a valid cache value", {
        cause: error,
      });
    }
    return value as T;
  }

  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    const storageKey = this.storageKey(key);
    if (
      !Number.isFinite(ttlSeconds) ||
      ttlSeconds <= 0 ||
      ttlSeconds > this.maxTtlSeconds
    ) {
      throw new TypeError(
        `ttlSeconds must be greater than 0 and at most ${this.maxTtlSeconds}`,
      );
    }
    try {
      assertJsonCacheValue(value);
    } catch (error) {
      throw new TypeError("Redis cache values must be JSON-serializable", {
        cause: error,
      });
    }
    let serializedValue: string | undefined;
    try {
      serializedValue = JSON.stringify(value);
    } catch {
      throw new TypeError("Redis cache values must be JSON-serializable");
    }
    if (serializedValue === undefined) {
      throw new TypeError("Redis cache values must be JSON-serializable");
    }
    const bytes =
      Buffer.byteLength(storageKey, "utf8") +
      Buffer.byteLength(serializedValue, "utf8");
    if (bytes > this.maxEntryBytes) {
      throw new TypeError(
        `Redis cache entry exceeds the maximum of ${this.maxEntryBytes} bytes`,
      );
    }
    const ttlMilliseconds = Math.max(1, Math.ceil(ttlSeconds * 1_000));
    await this.run("set", () =>
      this.client.set(storageKey, serializedValue, ttlMilliseconds),
    );
  }

  async delete(key: string): Promise<void> {
    const storageKey = this.storageKey(key);
    await this.run("delete", () => this.client.delete(storageKey));
  }

  private storageKey(key: string): string {
    if (!isCurrentCacheKey(key)) {
      throw new TypeError(
        "Redis cache keys must be current-version SHA-256 digests from createCacheKey",
      );
    }
    return `${this.keyPrefix}${key}`;
  }

  /**
   * Commands are bounded even when the Redis client has no command timeout.
   * A timed-out command rejects; the underlying client call is not forcibly
   * cancelled, so clients should still configure their own socket timeouts.
   */
  private async run<T>(
    operation: string,
    command: () => Promise<T>,
  ): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(command),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(
              new Error(
                `Redis cache ${operation} timed out after ${this.commandTimeoutMs}ms`,
              ),
            );
          }, this.commandTimeoutMs);
          timer.unref();
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

function parseKeyPrefix(value: unknown): string {
  if (value === undefined) return "";
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 128 ||
    /[^\u0021-\u007e]/.test(value)
  ) {
    throw new TypeError("keyPrefix must be 1-128 printable ASCII characters");
  }
  return value;
}

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

export * from "./client.js";

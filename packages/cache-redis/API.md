# API Reference: @chainmcp/cache-redis

## `@chainmcp/cache-redis`

Optional Redis-backed `CacheStore` for shared caches:

```ts
export interface RedisCacheClient {
  get(key: string): Promise<string | null | undefined>;
  set(key: string, value: string, ttlMilliseconds: number): Promise<unknown>;
  delete(key: string): Promise<unknown>;
}

export interface RedisCacheStoreOptions {
  client: RedisCacheClient;
  keyPrefix?: string;
  maxEntryBytes?: number;
  maxTtlSeconds?: number;
  commandTimeoutMs?: number;
}

export interface SimpleRedisTlsOptions {
  ca?: string | Buffer | undefined;
  cert?: string | Buffer | undefined;
  key?: string | Buffer | undefined;
  rejectUnauthorized?: boolean | undefined;
  servername?: string | undefined;
}

export interface SimpleRedisOptions {
  url?: string | undefined;
  host?: string | undefined;
  port?: number | undefined;
  username?: string | undefined;
  password?: string | undefined;
  database?: number | undefined;
  timeoutMs?: number | undefined;
  tls?: boolean | SimpleRedisTlsOptions | undefined;
  ca?: string | Buffer | undefined;
  cert?: string | Buffer | undefined;
  key?: string | Buffer | undefined;
  rejectUnauthorized?: boolean | undefined;
  minConnections?: number | undefined;
  maxConnections?: number | undefined;
  maxRetries?: number | undefined;
  retryBaseMs?: number | undefined;
  retryCapMs?: number | undefined;
  healthCheckOnCheckout?: boolean | undefined;
}

export interface SimpleRedisClientStatus {
  totalConnections: number;
  idleConnections: number;
  activeConnections: number;
  waitQueueLength: number;
  isClosed: boolean;
}

export interface SimpleRedisClient extends RedisCacheClient {
  eval(script: string, keys: string[], args: string[]): Promise<unknown>;
  close(): Promise<void>;
  disconnect(): Promise<void>;
  getStatus(): SimpleRedisClientStatus;
}

export function createSimpleRedisClient(
  urlOrOptions: string | SimpleRedisOptions,
): SimpleRedisClient;

export const createSimpleRedisCacheClient = createSimpleRedisClient;

export function redactRedisUrl(urlString: string): string;

export class RedisCacheStore implements CacheStore {
  constructor(options: RedisCacheStoreOptions);
  readonly client: RedisCacheClient;
}

export const DEFAULT_REDIS_COMMAND_TIMEOUT_MS = 1_000;
```

The client is a narrow command wrapper, not a connection manager. It must
implement `get`, `set`, and `delete`, with `set` receiving a TTL in milliseconds.
For `node-redis`:

```ts
const store = new RedisCacheStore({
  client: {
    get: (key) => client.get(key),
    set: (key, value, ttlMs) => client.set(key, value, { PX: ttlMs }),
    delete: (key) => client.del(key),
  },
});
```

The adapter accepts only current-version hashed keys from `createCacheKey`,
serializes and validates values with `assertJsonCacheValue`, and enforces entry
size (default 256 KiB) and TTL (default 3,600 seconds). `get` returns `undefined`
for a Redis `null`/`undefined` and parses each value into an isolated object; a
corrupt, oversized, or non-JSON value rejects, and the runtime treats that as a
cache bypass. `delete` removes one exact entry.

`keyPrefix` is an optional literal namespace of 1-128 printable ASCII
characters, prepended to every storage key. Changing it makes old entries
unreachable, so rotate it deliberately. Each Redis command is bounded by
`commandTimeoutMs` (default 1,000 ms). The timeout rejects the adapter promise
but does not cancel the underlying client command; configure socket and command
timeouts in the client as well. The adapter does not manage connections,
credentials, TLS, retries, eviction policy, or cluster topology. See
`docs/caching.md` and ADR 0014.

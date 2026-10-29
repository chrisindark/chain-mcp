# Rate Limiting and Concurrency Control

ChainMcp provides quota management and concurrency control to protect both upstream APIs and MCP servers from resource exhaustion.

## 1. Principles

1. **Explicit Decisions:** Rate limiting produces a `{ allowed: boolean, retryAfterSeconds?: number }` decision. Thrown errors are treated as infrastructure failures (`UPSTREAM_FAILURE`) rather than rate limits.
2. **Retry-After:** Denied calls expose `RuntimeError.retryAfterSeconds`. Quota denials report the time until the oldest request leaves the window. Concurrency denials report a conservative lower bound of one second, because a permit may be released sooner or later than that. MCP clients see the value in the error text (`RATE_LIMITED: Rate limit exceeded. Retry after N seconds`) when it is a whole number of seconds no greater than one day.
3. **Partitioned Scoping:** Limits can be configured globally, by tenant, by principal, or by tool.
4. **Distributed Accounting:** The distributed adapter (`DistributedRateLimiter`) uses atomic Redis Lua scripts so multiple server processes share the same quota counters and concurrency slots. All matching scopes are evaluated per call, and a denial rolls back the scopes that were already recorded, so a rejected call never consumes another scope's budget. For the same rules and clock, in-memory and distributed decisions agree; only the storage and multi-process visibility differ.
5. **No Concurrency Leaks:** Concurrency slots are acquired before execution and released in a `finally` block upon completion (success, error, timeout, or cancellation). Redis concurrency keys use safety TTLs (default 60 seconds) so a crashed process cannot hold permits forever, though it can hold them for up to the TTL.

## 2. In-Memory Rate Limiter

For local development or single-process deployments, use `InMemoryRateLimiter`:

```ts
import { InMemoryRateLimiter } from "@chainmcp/rate-limit";
import { InMemoryToolRuntime } from "@chainmcp/core";

const rateLimiter = new InMemoryRateLimiter({
  globalQuota: { maxRequests: 100, windowMs: 60_000 },
  globalConcurrency: 10,
  tenantQuota: (tenantId) => ({ maxRequests: 50, windowMs: 60_000 }),
  toolQuota: (toolName) =>
    toolName === "expensive_sync"
      ? { maxRequests: 5, windowMs: 60_000 }
      : undefined,
  maxTrackedWindows: 10_000,
});

const runtime = new InMemoryToolRuntime({ rateLimiter });
```

### Bounded local memory

Every quota scope keeps one sliding window per partition (per tenant, principal, or tool). A caller that keeps presenting new identities would otherwise grow that map without limit, so the limiter retains at most `maxTrackedWindows` windows (default 10,000) and evicts the least recently used one first. Windows whose timestamps have all expired are dropped immediately.

Eviction trades strictness for memory: an evicted identity starts a fresh window, so it can make one extra request before its window is rebuilt. Keep the default for normal deployments; raise the cap when many active identities must stay strictly counted, or use `DistributedRateLimiter`, where Redis owns the counters and expiry. `trackedWindowCount` exposes the current size for monitoring and tests.

## 3. Distributed Rate Limiter

In multi-process or clustered deployments, use `DistributedRateLimiter` with a Redis backend.

### Configuration via `chainmcp.config.yaml`

```yaml
rateLimit:
  enabled: true
  provider: redis
  failurePolicy: fail-closed # fail-closed (default) | fail-open
  requestsPerMinute: 60
  concurrency: 10
  redis:
    url: redis://127.0.0.1:6379 # Or omit to use CHAINMCP_REDIS_URL
    keyPrefix: "chainmcp:prod:ratelimit:"
    commandTimeoutMs: 1000
```

When `provider: redis` is configured:

1. `createRateLimiterFromConfig` auto-constructs a zero-dependency RESP2 Redis client using `options.redisClient`, `options.redisUrl`, `config.redis.url`, or `process.env.CHAINMCP_REDIS_URL`. If none is supplied, startup fails fast with a helpful error naming both `rateLimit.redis.url` and `CHAINMCP_REDIS_URL`.
2. **Hardened Redis Client (RM-16):**
   - **TLS & Encryption:** Supports `rediss://` for TLS connections with configurable certificate verification (`tls.rejectUnauthorized`, `tls.ca`, `tls.cert`, `tls.key`, `tls.servername`).
   - **ACL Support:** Full support for Redis ACL users (`redis://username:password@host:port`), password-only auth (`redis://:password@host:port`), and database indexing (`/0`, `/1`).
   - **Connection Pooling:** Sockets are managed by an internal pool (default 2–4 connections) with lazy connect, checkout health verification (`PING`), exponential backoff with jitter on reconnects, and graceful pool drain on shutdown.
   - **Credential Redaction:** Passwords and credentials embedded in Redis URLs are automatically sanitized from all error messages and stack traces. `CHAINMCP_REDIS_URL` may contain sensitive credentials and must not be logged.
3. **Shared Redis Client:** When both rate limiting and caching are Redis-backed, `buildRuntimeOptions` shares the same underlying Redis client instance between `@chainmcp/rate-limit` and `@chainmcp/cache-redis`, preventing duplicate socket connections and connection pool exhaustion.
4. **Startup Health Logging:** The server logs connection health at startup (`provider`, `reachability: "reachable" | "unreachable"`, `keyPrefix`, and quota summary). Secrets and credentials in the Redis connection URL are strictly excluded from logs.

### Programmatic Usage

```ts
import {
  DistributedRateLimiter,
  type RedisRateLimitClient,
} from "@chainmcp/rate-limit";
import { InMemoryToolRuntime } from "@chainmcp/core";

// Inject any Redis client wrapper with eval support
const redisClient: RedisRateLimitClient = {
  eval: (script, keys, args) =>
    ioredisClient.eval(script, keys.length, ...keys, ...args),
};

const rateLimiter = new DistributedRateLimiter({
  client: redisClient,
  keyPrefix: "chainmcp:prod:ratelimit:",
  commandTimeoutMs: 1_000,
  failurePolicy: "fail-closed", // "fail-closed" (default) or "fail-open"
  tenantQuota: { maxRequests: 60, windowMs: 60_000 },
  tenantConcurrency: 5,
});

const runtime = new InMemoryToolRuntime({ rateLimiter });
```

### Outage Failure Policy

When Redis experiences an outage, network partition, or command timeout:

- **`failurePolicy: "fail-closed"` (Default):** Re-throws an `UPSTREAM_FAILURE` `RuntimeError`, blocking requests to guarantee quotas and concurrency limits are never exceeded. Any concurrency slots acquired prior to the failure are rolled back.
- **`failurePolicy: "fail-open"`:** Logs an outage warning at `warn` level with the underlying error cause and permits the request to proceed (`{ allowed: true }`), prioritizing API availability over strict quota enforcement.

### Atomic Lua Scripts

`DistributedRateLimiter` executes atomic Lua scripts on Redis:

- **Rolling Quota:** Uses Redis sorted sets (`ZADD`, `ZREMRANGEBYSCORE`, `ZCARD`) to track request timestamps within the rolling window. If the quota is exceeded, it inspects the oldest timestamp to compute `retryAfterSeconds` without multiple round-trips. Each recorded entry carries a per-request member and a key TTL of twice the window.
- **Quota Rollback:** When a later scope denies the call, `ZREM` removes the entries this call already recorded, so a rejected request is invisible to every scope. Rollback failures are isolated and can only over-count, which fails closed.
- **Concurrency Control:** Atomically compares and increments the active execution counter with an automatic TTL (`EXPIRE`). Releasing decrements the counter.

### Command Timeouts and Safety TTLs

When configuring `commandTimeoutMs` on `DistributedRateLimiter`, note that local client-side promise timeouts abort waiting for the Redis response but do not cancel or roll back TCP commands that have already been dispatched across the wire to the Redis server. If a network partition or transient latency spike causes a local timeout while Redis actually executed the `INCR` script:

- `DistributedRateLimiter.check()` traps errors and runs an immediate rollback for permits tracked before the failing command.
- For in-flight commands that completed on Redis after client-side abort, the concurrency key's safety TTL (`ttlSeconds`, defaulting to 60 seconds) acts as the fail-safe boundary to prevent permanent permit leaks.

The scripts are covered by unit tests against a JavaScript fake and by an opt-in integration suite that runs them against a real Redis (`CHAINMCP_TEST_REDIS_URL`, see `DEVELOPMENT.md`); CI runs that suite in a dedicated job.

- Production deployments should configure socket-level timeouts on their underlying Redis client (e.g. `connectTimeout` and `commandTimeout` in ioredis) aligned with `commandTimeoutMs`.

## 4. Runtime Pipeline Integration

Rate limiting runs at stage 6 of the execution sequence:

1. `Authorizer` runs and grants access.
2. Input arguments are validated.
3. `RateLimiter.check(context, toolName)` evaluates quotas and concurrency.
   - If denied, `RuntimeError("RATE_LIMITED")` is thrown with `retryAfterSeconds`.
   - If allowed, a concurrency permit is marked as acquired.
4. Tool executes (with cache lookup if eligible).
5. In the `finally` block, if a permit was acquired, `rateLimiter.release(context, toolName)` releases concurrency slots.

## 5. Metrics and Observability

A rate-limited call produces a `tool_invocation` event:

- `outcome: "rate_limited"`
- `errorCode: "RATE_LIMITED"`
- Causes and internal Redis keys are omitted from client responses.

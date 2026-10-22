# Rate Limiting and Concurrency Control

ChainMcp provides quota management and concurrency control to protect both upstream APIs and MCP servers from resource exhaustion.

## 1. Principles

1. **Explicit Decisions:** Rate limiting produces a `{ allowed: boolean, retryAfterSeconds?: number }` decision. Thrown errors are treated as infrastructure failures (`UPSTREAM_FAILURE`) rather than rate limits.
2. **Deterministic Retry-After:** Denied calls calculate the exact number of seconds until window reset or permit availability, exposed on `RuntimeError.retryAfterSeconds`.
3. **Partitioned Scoping:** Limits can be configured globally, by tenant, by principal, or by tool.
4. **Distributed Parity:** The distributed adapter (`DistributedRateLimiter`) uses atomic Redis Lua scripts so multiple server processes share the exact same quota counters and concurrency slots.
5. **No Concurrency Leaks:** Concurrency slots are acquired before execution and released in a `finally` block upon completion (success, error, timeout, or cancellation). Redis concurrency keys use safety TTLs to prevent leaks if a process crashes.

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
});

const runtime = new InMemoryToolRuntime({ rateLimiter });
```

## 3. Distributed Rate Limiter

In multi-process or clustered deployments, use `DistributedRateLimiter` with a Redis client:

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
  tenantQuota: { maxRequests: 60, windowMs: 60_000 },
  tenantConcurrency: 5,
});

const runtime = new InMemoryToolRuntime({ rateLimiter });
```

### Atomic Lua Scripts

`DistributedRateLimiter` executes atomic Lua scripts on Redis:

- **Rolling Quota:** Uses Redis sorted sets (`ZADD`, `ZREMRANGEBYSCORE`, `ZCARD`) to track request timestamps within the rolling window. If the quota is exceeded, it inspects the oldest timestamp to compute `retryAfterSeconds` without multiple round-trips.
- **Concurrency Control:** Atomically compares and increments the active execution counter with an automatic TTL (`EXPIRE`). Releasing decrements the counter.

### Command Timeouts and Safety TTLs

When configuring `commandTimeoutMs` on `DistributedRateLimiter`, note that local client-side promise timeouts abort waiting for the Redis response but do not cancel or roll back TCP commands that have already been dispatched across the wire to the Redis server. If a network partition or transient latency spike causes a local timeout while Redis actually executed the `INCR` script:

- `DistributedRateLimiter.check()` traps errors and runs an immediate rollback for permits tracked before the failing command.
- For in-flight commands that completed on Redis after client-side abort, the concurrency key's safety TTL (`ttlSeconds`, defaulting to 300 seconds / 5 minutes) acts as the fail-safe boundary to prevent permanent permit leaks.
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

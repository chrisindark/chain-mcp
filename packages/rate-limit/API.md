# API Reference: @chainmcp/rate-limit

## `@chainmcp/rate-limit`

The rate-limit package provides quota and concurrency control for single-process and distributed deployments:

```ts
export interface QuotaPolicy {
  maxRequests: number;
  windowMs: number;
}

export interface ConcurrencyPolicy {
  maxConcurrent: number;
  ttlSeconds?: number;
}

export interface InMemoryRateLimiterOptions extends RateLimitRules {
  now?: () => number;
  maxTrackedWindows?: number; // default 10,000
}

export class InMemoryRateLimiter implements RateLimiter {
  constructor(options?: InMemoryRateLimiterOptions);
  check(context: ToolContext, toolName: string): Promise<RateLimitDecision>;
  release(context: ToolContext, toolName: string): Promise<void>;
  reset(): void;
  readonly trackedWindowCount: number;
}

export interface RedisRateLimitClient {
  eval(script: string, keys: string[], args: string[]): Promise<unknown>;
}

export class DistributedRateLimiter implements RateLimiter {
  constructor(options: DistributedRateLimiterOptions);
  readonly client: RedisRateLimitClient;
  readonly failurePolicy: "fail-closed" | "fail-open";
  check(context: ToolContext, toolName: string): Promise<RateLimitDecision>;
  release(context: ToolContext, toolName: string): Promise<void>;
}
```

Quotas and concurrency can be partitioned globally, by tenant, by principal, or by tool. Denied calls produce `{ allowed: false, retryAfterSeconds }`. Quota denials report when the oldest request leaves the window; concurrency denials report a conservative lower bound of one second.

`InMemoryRateLimiter` retains at most `maxTrackedWindows` sliding windows (default 10,000) and evicts the least recently used one first, which bounds memory when callers keep presenting new identities. Eviction forgets that identity's history, so it can make one extra request before its window is rebuilt; use `DistributedRateLimiter` when strict counting across many identities matters more than local memory. Expired windows are dropped immediately and `trackedWindowCount` reports the current size.

In distributed deployments, atomic Redis Lua scripts ensure quota and concurrency limits are enforced across server processes without race conditions. Every matching scope is evaluated for each call and the scopes recorded before a denial are rolled back, so a rejected call never consumes another scope's budget; rollback failures are isolated and can only over-count. Concurrency slots are acquired before tool execution and released in a `finally` block upon completion, with a safety TTL (default 60 seconds) for crashed holders. The Lua scripts are proven against a real Redis by the opt-in integration suite described in `DEVELOPMENT.md`.

export interface QuotaPolicy {
  /** Maximum number of requests allowed within the window. */
  maxRequests: number;
  /** Length of the rolling window in milliseconds. */
  windowMs: number;
}

export interface ConcurrencyPolicy {
  /** Maximum number of concurrent executions permitted. */
  maxConcurrent: number;
  /** Safety TTL in seconds for concurrency locks. Defaults to 60s. */
  ttlSeconds?: number;
}

export interface RateLimitRules {
  /** Quota applied globally across all calls. */
  globalQuota?: QuotaPolicy;
  /** Concurrency limit applied globally across all calls. */
  globalConcurrency?: number | ConcurrencyPolicy;
  /** Quotas partitioned by tenant ID (static policy or resolver function). */
  tenantQuota?: QuotaPolicy | ((tenantId: string) => QuotaPolicy | undefined);
  /** Concurrency limits partitioned by tenant ID (static limit or resolver function). */
  tenantConcurrency?:
    | number
    | ConcurrencyPolicy
    | ((tenantId: string) => number | ConcurrencyPolicy | undefined);
  /** Quotas partitioned by principal ID (static policy or resolver function). */
  principalQuota?:
    | QuotaPolicy
    | ((principalId: string, tenantId: string) => QuotaPolicy | undefined);
  /** Concurrency limits partitioned by principal ID (static limit or resolver function). */
  principalConcurrency?:
    | number
    | ConcurrencyPolicy
    | ((
        principalId: string,
        tenantId: string,
      ) => number | ConcurrencyPolicy | undefined);
  /** Quotas partitioned by tool name (static policy or resolver function). */
  toolQuota?: QuotaPolicy | ((toolName: string) => QuotaPolicy | undefined);
  /** Concurrency limits partitioned by tool name (static limit or resolver function). */
  toolConcurrency?:
    | number
    | ConcurrencyPolicy
    | ((toolName: string) => number | ConcurrencyPolicy | undefined);
}

export interface InMemoryRateLimiterOptions extends RateLimitRules {
  /** Clock provider for testing. Defaults to `Date.now`. */
  now?: () => number;
  /**
   * Maximum number of sliding windows retained in memory. Defaults to 10,000.
   *
   * Windows are evicted least-recently-used first, so a caller that keeps
   * presenting new tenant, principal, or tool identities cannot grow the map
   * without bound. Eviction forgets the history of the evicted identity, so it
   * can make one extra request before its window is rebuilt; use the
   * distributed limiter when strict counting matters more than local memory.
   */
  maxTrackedWindows?: number;
}

export interface RedisRateLimitClient {
  eval(script: string, keys: string[], args: string[]): Promise<unknown>;
}

export interface DistributedRateLimiterOptions extends RateLimitRules {
  /** Injectable Redis client with eval capability. */
  client: RedisRateLimitClient;
  /** Optional key prefix for Redis keys. Defaults to `chainmcp:ratelimit:`. */
  keyPrefix?: string;
  /** Per-command timeout in milliseconds. Defaults to 1,000ms. */
  commandTimeoutMs?: number;
  /** Clock provider for testing. Defaults to `Date.now`. */
  now?: () => number;
}

import type {
  RateLimitDecision,
  RateLimiter,
  ToolContext,
} from "@chainmcp/core";
import type {
  ConcurrencyPolicy,
  InMemoryRateLimiterOptions,
  QuotaPolicy,
} from "./types.js";

interface ActiveQuotaCheck {
  key: string;
  policy: QuotaPolicy;
}

interface ActiveConcurrencyCheck {
  key: string;
  policy: ConcurrencyPolicy;
}

export class InMemoryRateLimiter implements RateLimiter {
  private readonly options: InMemoryRateLimiterOptions;
  private readonly now: () => number;
  private readonly maxTrackedWindows: number;

  private readonly slidingWindows = new Map<string, number[]>();
  private readonly activeConcurrency = new Map<string, number>();

  constructor(options: InMemoryRateLimiterOptions = {}) {
    this.options = options;
    this.now = options.now ?? (() => Date.now());
    const maxTrackedWindows =
      options.maxTrackedWindows ?? DEFAULT_MAX_TRACKED_WINDOWS;
    if (!Number.isSafeInteger(maxTrackedWindows) || maxTrackedWindows < 1) {
      throw new TypeError("maxTrackedWindows must be a positive integer");
    }
    this.maxTrackedWindows = maxTrackedWindows;
  }

  /** Number of sliding windows currently retained. */
  get trackedWindowCount(): number {
    return this.slidingWindows.size;
  }

  async check(
    context: ToolContext,
    toolName: string,
  ): Promise<RateLimitDecision> {
    const currentTime = this.now();
    const concurrencyChecks = this.resolveConcurrencyChecks(context, toolName);
    const quotaChecks = this.resolveQuotaChecks(context, toolName);

    // 1. Check concurrency limits first
    for (const check of concurrencyChecks) {
      const active = this.activeConcurrency.get(check.key) ?? 0;
      if (active >= check.policy.maxConcurrent) {
        return {
          allowed: false,
          retryAfterSeconds: 1,
        };
      }
    }

    // 2. Check quota limits across all matching scopes
    let maxRetryAfterSeconds = 0;
    for (const check of quotaChecks) {
      const windowStart = currentTime - check.policy.windowMs;
      const timestamps = this.slidingWindows.get(check.key);
      const validTimestamps =
        timestamps === undefined
          ? []
          : timestamps.filter((ts) => ts > windowStart);
      if (timestamps !== undefined) {
        // Pruning is also the eviction point: an empty window holds no
        // information, and a touched window becomes the most recently used.
        if (validTimestamps.length === 0) {
          this.slidingWindows.delete(check.key);
        } else {
          this.setWindow(check.key, validTimestamps);
        }
      }

      if (validTimestamps.length >= check.policy.maxRequests) {
        const oldestInWindow = validTimestamps[0] ?? currentTime;
        const resetMs = oldestInWindow + check.policy.windowMs - currentTime;
        const retryAfter = Math.max(1, Math.ceil(resetMs / 1000));
        if (retryAfter > maxRetryAfterSeconds) {
          maxRetryAfterSeconds = retryAfter;
        }
      }
    }

    if (maxRetryAfterSeconds > 0) {
      return {
        allowed: false,
        retryAfterSeconds: maxRetryAfterSeconds,
      };
    }

    // 3. Acquire quota and concurrency permits
    for (const check of quotaChecks) {
      const timestamps = this.slidingWindows.get(check.key) ?? [];
      timestamps.push(currentTime);
      this.setWindow(check.key, timestamps);
    }

    for (const check of concurrencyChecks) {
      const current = this.activeConcurrency.get(check.key) ?? 0;
      this.activeConcurrency.set(check.key, current + 1);
    }

    return { allowed: true };
  }

  async release(context: ToolContext, toolName: string): Promise<void> {
    const concurrencyChecks = this.resolveConcurrencyChecks(context, toolName);
    for (const check of concurrencyChecks) {
      const current = this.activeConcurrency.get(check.key) ?? 0;
      if (current <= 1) {
        this.activeConcurrency.delete(check.key);
      } else {
        this.activeConcurrency.set(check.key, current - 1);
      }
    }
  }

  reset(): void {
    this.slidingWindows.clear();
    this.activeConcurrency.clear();
  }

  /**
   * Stores a window and marks it most recently used.
   *
   * `Map` keeps insertion order, so re-inserting after a delete moves the key to
   * the tail. Eviction removes from the head (least recently used).
   */
  private setWindow(key: string, timestamps: number[]): void {
    this.slidingWindows.delete(key);
    this.slidingWindows.set(key, timestamps);
    while (this.slidingWindows.size > this.maxTrackedWindows) {
      const oldest = this.slidingWindows.keys().next();
      if (oldest.done === true) break;
      this.slidingWindows.delete(oldest.value);
    }
  }

  private resolveQuotaChecks(
    context: ToolContext,
    toolName: string,
  ): ActiveQuotaCheck[] {
    const checks: ActiveQuotaCheck[] = [];

    if (this.options.globalQuota) {
      checks.push({
        key: "global:quota",
        policy: this.options.globalQuota,
      });
    }

    if (this.options.tenantQuota) {
      const policy =
        typeof this.options.tenantQuota === "function"
          ? this.options.tenantQuota(context.tenantId)
          : this.options.tenantQuota;
      if (policy) {
        checks.push({
          key: `tenant:${context.tenantId}:quota`,
          policy,
        });
      }
    }

    if (this.options.principalQuota && context.principal?.id) {
      const policy =
        typeof this.options.principalQuota === "function"
          ? this.options.principalQuota(context.principal.id, context.tenantId)
          : this.options.principalQuota;
      if (policy) {
        checks.push({
          key: `principal:${context.tenantId}:${context.principal.id}:quota`,
          policy,
        });
      }
    }

    if (this.options.toolQuota) {
      const policy =
        typeof this.options.toolQuota === "function"
          ? this.options.toolQuota(toolName)
          : this.options.toolQuota;
      if (policy) {
        checks.push({
          key: `tool:${toolName}:quota`,
          policy,
        });
      }
    }

    return checks;
  }

  private resolveConcurrencyChecks(
    context: ToolContext,
    toolName: string,
  ): ActiveConcurrencyCheck[] {
    const checks: ActiveConcurrencyCheck[] = [];

    if (this.options.globalConcurrency !== undefined) {
      const policy = normalizeConcurrencyPolicy(this.options.globalConcurrency);
      if (policy) {
        checks.push({ key: "global:concurrency", policy });
      }
    }

    if (this.options.tenantConcurrency !== undefined) {
      const raw =
        typeof this.options.tenantConcurrency === "function"
          ? this.options.tenantConcurrency(context.tenantId)
          : this.options.tenantConcurrency;
      const policy = normalizeConcurrencyPolicy(raw);
      if (policy) {
        checks.push({ key: `tenant:${context.tenantId}:concurrency`, policy });
      }
    }

    if (
      this.options.principalConcurrency !== undefined &&
      context.principal?.id
    ) {
      const raw =
        typeof this.options.principalConcurrency === "function"
          ? this.options.principalConcurrency(
              context.principal.id,
              context.tenantId,
            )
          : this.options.principalConcurrency;
      const policy = normalizeConcurrencyPolicy(raw);
      if (policy) {
        checks.push({
          key: `principal:${context.tenantId}:${context.principal.id}:concurrency`,
          policy,
        });
      }
    }

    if (this.options.toolConcurrency !== undefined) {
      const raw =
        typeof this.options.toolConcurrency === "function"
          ? this.options.toolConcurrency(toolName)
          : this.options.toolConcurrency;
      const policy = normalizeConcurrencyPolicy(raw);
      if (policy) {
        checks.push({ key: `tool:${toolName}:concurrency`, policy });
      }
    }

    return checks;
  }
}

const DEFAULT_MAX_TRACKED_WINDOWS = 10_000;

function normalizeConcurrencyPolicy(
  policy: number | ConcurrencyPolicy | undefined,
): ConcurrencyPolicy | undefined {
  if (typeof policy === "number") {
    return { maxConcurrent: Math.max(0, policy) };
  }
  if (typeof policy === "object" && policy !== null) {
    return {
      maxConcurrent: Math.max(0, policy.maxConcurrent),
      ...(policy.ttlSeconds !== undefined
        ? { ttlSeconds: policy.ttlSeconds }
        : {}),
    };
  }
  return undefined;
}

import {
  RuntimeError,
  type RateLimitDecision,
  type RateLimiter,
  type ToolContext,
} from "@chainmcp/core";
import type {
  ConcurrencyPolicy,
  DistributedRateLimiterOptions,
  QuotaPolicy,
  RedisRateLimitClient,
} from "./types.js";

const DEFAULT_COMMAND_TIMEOUT_MS = 1_000;
const DEFAULT_KEY_PREFIX = "chainmcp:ratelimit:";
const DEFAULT_CONCURRENCY_TTL_SECONDS = 60;

const SLIDING_WINDOW_LUA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local maxRequests = tonumber(ARGV[3])
local requestId = ARGV[4]

local windowStart = now - windowMs
redis.call('ZREMRANGEBYSCORE', key, '-inf', windowStart)
local count = redis.call('ZCARD', key)

if count >= maxRequests then
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local retryAfterMs = 1000
  if oldest and #oldest >= 2 then
    retryAfterMs = math.max(1000, tonumber(oldest[2]) + windowMs - now)
  end
  return {0, retryAfterMs}
end

redis.call('ZADD', key, now, requestId)
local expireMs = math.ceil(windowMs * 2)
redis.call('PEXPIRE', key, expireMs)
return {1, 0}
`;

const ACQUIRE_CONCURRENCY_LUA = `
local key = KEYS[1]
local maxConcurrent = tonumber(ARGV[1])
local ttlSeconds = tonumber(ARGV[2])

local current = tonumber(redis.call('GET', key) or '0')
if current >= maxConcurrent then
  return 0
end

redis.call('INCR', key)
redis.call('EXPIRE', key, ttlSeconds)
return 1
`;

const RELEASE_CONCURRENCY_LUA = `
local key = KEYS[1]
local current = tonumber(redis.call('GET', key) or '0')
if current > 1 then
  redis.call('DECR', key)
else
  redis.call('DEL', key)
end
return 1
`;

interface ActiveQuotaCheck {
  key: string;
  policy: QuotaPolicy;
}

interface ActiveConcurrencyCheck {
  key: string;
  policy: ConcurrencyPolicy;
}

export class DistributedRateLimiter implements RateLimiter {
  private readonly client: RedisRateLimitClient;
  private readonly options: DistributedRateLimiterOptions;
  private readonly keyPrefix: string;
  private readonly commandTimeoutMs: number;
  private readonly now: () => number;

  constructor(options: DistributedRateLimiterOptions) {
    if (!options || typeof options !== "object") {
      throw new TypeError("DistributedRateLimiter requires options");
    }
    if (!options.client || typeof options.client.eval !== "function") {
      throw new TypeError(
        "DistributedRateLimiter requires a Redis client with eval",
      );
    }

    this.client = options.client;
    this.options = options;
    this.keyPrefix = options.keyPrefix ?? DEFAULT_KEY_PREFIX;
    this.commandTimeoutMs =
      options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.now = options.now ?? (() => Date.now());
  }

  async check(
    context: ToolContext,
    toolName: string,
  ): Promise<RateLimitDecision> {
    const currentTime = this.now();
    const concurrencyChecks = this.resolveConcurrencyChecks(context, toolName);
    const quotaChecks = this.resolveQuotaChecks(context, toolName);

    // 1. Check concurrency limits across distributed processes
    const acquiredConcurrencyKeys: string[] = [];
    try {
      for (const check of concurrencyChecks) {
        const fullKey = `${this.keyPrefix}concurrency:${check.key}`;
        const ttl = check.policy.ttlSeconds ?? DEFAULT_CONCURRENCY_TTL_SECONDS;

        const acquired = await this.runWithTimeout("acquire_concurrency", () =>
          this.client.eval(
            ACQUIRE_CONCURRENCY_LUA,
            [fullKey],
            [String(check.policy.maxConcurrent), String(ttl)],
          ),
        );

        if (Number(acquired) !== 1) {
          // Rollback any concurrency permits acquired in this check
          await this.rollbackConcurrency(acquiredConcurrencyKeys);
          return {
            allowed: false,
            retryAfterSeconds: 1,
          };
        }
        acquiredConcurrencyKeys.push(fullKey);
      }

      // 2. Check quota limits across distributed processes
      const requestId = `${context.requestId}:${currentTime}:${Math.random().toString(36).slice(2, 8)}`;
      let maxRetryAfterSeconds = 0;

      for (const check of quotaChecks) {
        const fullKey = `${this.keyPrefix}quota:${check.key}`;
        const result = (await this.runWithTimeout("quota_check", () =>
          this.client.eval(
            SLIDING_WINDOW_LUA,
            [fullKey],
            [
              String(currentTime),
              String(check.policy.windowMs),
              String(check.policy.maxRequests),
              requestId,
            ],
          ),
        )) as [number, number];

        const allowed = Number(result?.[0]);
        if (allowed !== 1) {
          const retryAfterMs = Number(result?.[1] ?? 1000);
          const retryAfterSec = Math.max(1, Math.ceil(retryAfterMs / 1000));
          if (retryAfterSec > maxRetryAfterSeconds) {
            maxRetryAfterSeconds = retryAfterSec;
          }
        }
      }

      if (maxRetryAfterSeconds > 0) {
        // Rollback concurrency slots acquired
        await this.rollbackConcurrency(acquiredConcurrencyKeys);
        return {
          allowed: false,
          retryAfterSeconds: maxRetryAfterSeconds,
        };
      }

      return { allowed: true };
    } catch (error) {
      if (acquiredConcurrencyKeys.length > 0) {
        await this.rollbackConcurrency(acquiredConcurrencyKeys);
      }
      throw error;
    }
  }

  async release(context: ToolContext, toolName: string): Promise<void> {
    const concurrencyChecks = this.resolveConcurrencyChecks(context, toolName);
    for (const check of concurrencyChecks) {
      const fullKey = `${this.keyPrefix}concurrency:${check.key}`;
      try {
        await this.runWithTimeout("release_concurrency", () =>
          this.client.eval(RELEASE_CONCURRENCY_LUA, [fullKey], []),
        );
      } catch {
        // Release failures must not alter tool results
      }
    }
  }

  private async rollbackConcurrency(keys: readonly string[]): Promise<void> {
    for (const key of keys) {
      try {
        await this.runWithTimeout("rollback_concurrency", () =>
          this.client.eval(RELEASE_CONCURRENCY_LUA, [key], []),
        );
      } catch {
        // Rollback error isolated
      }
    }
  }

  private async runWithTimeout<T>(
    operation: string,
    action: () => Promise<T>,
  ): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new RuntimeError(
            "UPSTREAM_FAILURE",
            `Redis rate limiter command '${operation}' timed out after ${this.commandTimeoutMs}ms`,
          ),
        );
      }, this.commandTimeoutMs);
    });

    try {
      return await Promise.race([action(), timeoutPromise]);
    } catch (error) {
      if (error instanceof RuntimeError) throw error;
      throw new RuntimeError(
        "UPSTREAM_FAILURE",
        `Redis rate limiter command '${operation}' failed`,
        { cause: error },
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private resolveQuotaChecks(
    context: ToolContext,
    toolName: string,
  ): ActiveQuotaCheck[] {
    const checks: ActiveQuotaCheck[] = [];

    if (this.options.globalQuota) {
      checks.push({
        key: "global",
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
          key: `tenant:${context.tenantId}`,
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
          key: `principal:${context.tenantId}:${context.principal.id}`,
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
          key: `tool:${toolName}`,
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
        checks.push({ key: "global", policy });
      }
    }

    if (this.options.tenantConcurrency !== undefined) {
      const raw =
        typeof this.options.tenantConcurrency === "function"
          ? this.options.tenantConcurrency(context.tenantId)
          : this.options.tenantConcurrency;
      const policy = normalizeConcurrencyPolicy(raw);
      if (policy) {
        checks.push({ key: `tenant:${context.tenantId}`, policy });
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
          key: `principal:${context.tenantId}:${context.principal.id}`,
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
        checks.push({ key: `tool:${toolName}`, policy });
      }
    }

    return checks;
  }
}

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

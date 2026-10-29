import type { ToolContext } from "@chainmcp/core";
import { describe, expect, it } from "vitest";
import { InMemoryRateLimiter } from "../src/index.js";
import {
  DistributedRateLimiter,
  type RedisRateLimitClient,
} from "../src/index.js";

class MockRedisClient implements RedisRateLimitClient {
  private readonly zsets = new Map<
    string,
    Array<{ score: number; member: string }>
  >();
  private readonly strings = new Map<string, number>();

  /** Number of recorded quota entries for a key, for assertions. */
  quotaEntries(key: string): number {
    return (this.zsets.get(key) ?? []).length;
  }

  async eval(script: string, keys: string[], args: string[]): Promise<unknown> {
    const key = keys[0]!;

    if (script.includes("chainmcp:quota_rollback")) {
      // Quota rollback: remove only this request's entry.
      const requestId = args[0]!;
      const set = (this.zsets.get(key) ?? []).filter(
        (entry) => entry.member !== requestId,
      );
      this.zsets.set(key, set);
      return 1;
    }

    if (script.includes("ZREMRANGEBYSCORE")) {
      // Sliding window quota script
      const now = Number(args[0]);
      const windowMs = Number(args[1]);
      const maxRequests = Number(args[2]);
      const requestId = args[3]!;

      const windowStart = now - windowMs;
      let set = this.zsets.get(key) ?? [];
      set = set.filter((entry) => entry.score > windowStart);
      this.zsets.set(key, set);

      if (set.length >= maxRequests) {
        const oldest = set[0];
        const retryAfterMs = oldest
          ? Math.max(1000, oldest.score + windowMs - now)
          : 1000;
        return [0, retryAfterMs];
      }

      set.push({ score: now, member: requestId });
      set.sort((a, b) => a.score - b.score);
      this.zsets.set(key, set);
      return [1, 0];
    }

    if (
      script.includes("ACQUIRE_CONCURRENCY") ||
      (args.length === 2 && script.includes("INCR"))
    ) {
      const maxConcurrent = Number(args[0]);
      const current = this.strings.get(key) ?? 0;
      if (current >= maxConcurrent) {
        return 0;
      }
      this.strings.set(key, current + 1);
      return 1;
    }

    if (script.includes("RELEASE_CONCURRENCY") || script.includes("DECR")) {
      const current = this.strings.get(key) ?? 0;
      if (current > 1) {
        this.strings.set(key, current - 1);
      } else {
        this.strings.delete(key);
      }
      return 1;
    }

    throw new Error(`Unhandled script in MockRedisClient: ${script}`);
  }
}

const context = (tenantId = "tenant-1"): ToolContext => ({
  requestId: "req-1",
  tenantId,
  principal: { id: "user-1", scopes: [] },
});

describe("DistributedRateLimiter across multiple processes", () => {
  it("enforces shared quota across multiple limiter instances", async () => {
    let mockTime = 1_000_000;
    const now = () => mockTime;

    const sharedRedis = new MockRedisClient();

    // Instance 1 representing Server Process A
    const processA = new DistributedRateLimiter({
      client: sharedRedis,
      now,
      tenantQuota: { maxRequests: 3, windowMs: 15_000 },
    });

    // Instance 2 representing Server Process B
    const processB = new DistributedRateLimiter({
      client: sharedRedis,
      now,
      tenantQuota: { maxRequests: 3, windowMs: 15_000 },
    });

    const ctx = context("tenant-shared");

    // Process A makes 2 requests
    expect((await processA.check(ctx, "tool-1")).allowed).toBe(true);
    expect((await processA.check(ctx, "tool-1")).allowed).toBe(true);

    // Process B makes 1 request -> total 3 requests, allowed
    expect((await processB.check(ctx, "tool-1")).allowed).toBe(true);

    // Process B attempts 4th request -> quota exceeded across both processes!
    const deniedB = await processB.check(ctx, "tool-1");
    expect(deniedB.allowed).toBe(false);
    expect(deniedB.retryAfterSeconds).toBe(15);

    // Process A is also denied!
    const deniedA = await processA.check(ctx, "tool-1");
    expect(deniedA.allowed).toBe(false);

    // Advance time past the 15s window
    mockTime += 15_001;

    // Both processes can now make requests again
    expect((await processA.check(ctx, "tool-1")).allowed).toBe(true);
    expect((await processB.check(ctx, "tool-1")).allowed).toBe(true);
  });

  it("enforces shared concurrency limits across multiple limiter instances", async () => {
    const sharedRedis = new MockRedisClient();

    // Concurrency limit of 2 across the entire cluster
    const processA = new DistributedRateLimiter({
      client: sharedRedis,
      globalConcurrency: 2,
    });

    const processB = new DistributedRateLimiter({
      client: sharedRedis,
      globalConcurrency: 2,
    });

    const ctx = context();

    // Process A acquires slot 1
    expect((await processA.check(ctx, "tool-x")).allowed).toBe(true);

    // Process B acquires slot 2
    expect((await processB.check(ctx, "tool-y")).allowed).toBe(true);

    // Neither process can acquire slot 3
    expect((await processA.check(ctx, "tool-z")).allowed).toBe(false);
    expect((await processB.check(ctx, "tool-z")).allowed).toBe(false);

    // Process A completes and releases slot
    await processA.release(ctx, "tool-x");

    // Process B can now acquire a slot!
    expect((await processB.check(ctx, "tool-z")).allowed).toBe(true);
  });

  it("handles redis command timeout by failing closed with UPSTREAM_FAILURE", async () => {
    const hangingClient: RedisRateLimitClient = {
      eval: () => new Promise(() => {}), // never resolves
    };

    const limiter = new DistributedRateLimiter({
      client: hangingClient,
      commandTimeoutMs: 10,
      globalConcurrency: 5,
    });

    await expect(limiter.check(context(), "tool")).rejects.toMatchObject({
      code: "UPSTREAM_FAILURE",
    });
  });

  it("rolls back acquired concurrency permits when quota check throws", async () => {
    const sharedRedis = new MockRedisClient();
    let throwOnQuota = true;

    const failingQuotaClient: RedisRateLimitClient = {
      eval: async (script, keys, args) => {
        if (script.includes("ZREMRANGEBYSCORE") && throwOnQuota) {
          throw new Error("Redis cluster failover during quota check");
        }
        return sharedRedis.eval(script, keys, args);
      },
    };

    const limiter = new DistributedRateLimiter({
      client: failingQuotaClient,
      globalConcurrency: 1,
      globalQuota: { maxRequests: 5, windowMs: 10_000 },
    });

    const ctx = context();

    // Check fails because quota check throws
    await expect(limiter.check(ctx, "tool-1")).rejects.toMatchObject({
      code: "UPSTREAM_FAILURE",
      cause: expect.objectContaining({
        message: "Redis cluster failover during quota check",
      }),
    });

    // Concurrency permit should have been rolled back, NOT leaked.
    // If it leaked, a subsequent check with maxConcurrent: 1 would fail concurrency check.
    throwOnQuota = false;
    const retry = await limiter.check(ctx, "tool-1");
    expect(retry.allowed).toBe(true);
  });
});

describe("DistributedRateLimiter multi-scope accounting", () => {
  it("does not consume quota in an allowed scope when a later scope denies", async () => {
    let mockTime = 500_000;
    const sharedRedis = new MockRedisClient();
    const limiter = new DistributedRateLimiter({
      client: sharedRedis,
      now: () => mockTime,
      tenantQuota: { maxRequests: 2, windowMs: 60_000 },
      toolQuota: { maxRequests: 1, windowMs: 1_000 },
    });
    const ctx = context("tenant-multi-scope");
    const tenantKey = "chainmcp:ratelimit:quota:tenant:tenant-multi-scope";

    // First call consumes one tenant and one tool permit.
    expect((await limiter.check(ctx, "tool-1")).allowed).toBe(true);
    expect(sharedRedis.quotaEntries(tenantKey)).toBe(1);

    // Second call is denied by the tool quota. The tenant permit it recorded
    // before reaching the tool scope must be rolled back.
    const denied = await limiter.check(ctx, "tool-1");
    expect(denied.allowed).toBe(false);
    expect(sharedRedis.quotaEntries(tenantKey)).toBe(1);

    // After the tool window passes, the tenant budget still allows one call.
    mockTime += 1_001;
    expect((await limiter.check(ctx, "tool-1")).allowed).toBe(true);
    expect(sharedRedis.quotaEntries(tenantKey)).toBe(2);

    // The tenant quota is now exhausted.
    mockTime += 1_001;
    expect((await limiter.check(ctx, "tool-1")).allowed).toBe(false);
    expect(sharedRedis.quotaEntries(tenantKey)).toBe(2);
  });

  it("matches the in-memory limiter for multi-scope decisions", async () => {
    let mockTime = 700_000;
    const redis = new MockRedisClient();
    const rules = {
      tenantQuota: { maxRequests: 2, windowMs: 60_000 },
      toolQuota: { maxRequests: 1, windowMs: 1_000 },
    };
    const distributed = new DistributedRateLimiter({
      client: redis,
      now: () => mockTime,
      ...rules,
    });
    const inMemory = new InMemoryRateLimiter({ now: () => mockTime, ...rules });
    const ctx = context("tenant-parity");

    const decisions: boolean[] = [];
    for (const step of [0, 0, 1_001, 1_001, 1_002]) {
      mockTime += step;
      const [distributedDecision, inMemoryDecision] = await Promise.all([
        distributed.check(ctx, "tool-1"),
        inMemory.check(ctx, "tool-1"),
      ]);
      expect(distributedDecision.allowed).toBe(inMemoryDecision.allowed);
      decisions.push(distributedDecision.allowed);
    }

    expect(decisions).toEqual([true, false, true, false, false]);
  });

  it("enforces tenant quota isolation between distinct tenants", async () => {
    const mockTime = 1_000_000;
    const redis = new MockRedisClient();
    const limiter = new DistributedRateLimiter({
      client: redis,
      now: () => mockTime,
      tenantQuota: { maxRequests: 1, windowMs: 60_000 },
    });

    const ctxA = context("tenant-a");
    const ctxB = context("tenant-b");

    // First call for tenant A succeeds
    expect((await limiter.check(ctxA, "tool-1")).allowed).toBe(true);
    // Second call for tenant A is denied
    expect((await limiter.check(ctxA, "tool-1")).allowed).toBe(false);

    // Call for tenant B succeeds despite tenant A exhaustion
    expect((await limiter.check(ctxB, "tool-1")).allowed).toBe(true);
    // Second call for tenant B is denied
    expect((await limiter.check(ctxB, "tool-1")).allowed).toBe(false);
  });

  it("fails closed on Redis outage by default with UPSTREAM_FAILURE", async () => {
    const brokenClient: RedisRateLimitClient = {
      async eval() {
        throw new Error("ECONNREFUSED 127.0.0.1:6379");
      },
    };

    const limiter = new DistributedRateLimiter({
      client: brokenClient,
      globalQuota: { maxRequests: 10, windowMs: 60_000 },
      failurePolicy: "fail-closed",
    });

    await expect(limiter.check(context("t1"), "tool-1")).rejects.toMatchObject({
      code: "UPSTREAM_FAILURE",
      message: expect.stringContaining("Redis rate limiter command"),
    });
  });

  it("fails open on Redis outage when configured with failurePolicy: fail-open and logs warning", async () => {
    const brokenClient: RedisRateLimitClient = {
      async eval() {
        throw new Error("ETIMEDOUT 127.0.0.1:6379");
      },
    };

    const warnings: Array<{
      message: string;
      context?: Record<string, unknown> | undefined;
    }> = [];
    const mockLogger = {
      warn(message: string, context?: Record<string, unknown>) {
        warnings.push({
          message,
          ...(context !== undefined ? { context } : {}),
        });
      },
      error() {},
    };

    const limiter = new DistributedRateLimiter({
      client: brokenClient,
      globalQuota: { maxRequests: 10, windowMs: 60_000 },
      failurePolicy: "fail-open",
      logger: mockLogger,
    });

    const decision = await limiter.check(context("t1"), "tool-1");
    expect(decision.allowed).toBe(true);
    expect(warnings.length).toBe(1);
    expect(warnings[0]?.message).toContain(
      "Redis rate limiter encountered an outage; failing open",
    );
    expect(warnings[0]?.context?.error).toContain("ETIMEDOUT");
  });
});

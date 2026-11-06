import type { ToolContext } from "@chainmcp/core";
import { describe, expect, it } from "vitest";

import {
  DistributedRateLimiter,
  type DistributedRateLimiterOptions,
  InMemoryRateLimiter,
  type RedisRateLimitClient,
} from "../src/index.js";

const context = (
  tenantId = "tenant-1",
  principalId = "user-1",
): ToolContext => ({
  requestId: "req-1",
  tenantId,
  principal: { id: principalId, scopes: [] },
});

class MockRedisClient implements RedisRateLimitClient {
  private readonly zsets = new Map<
    string,
    Array<{ score: number; member: string }>
  >();
  private readonly strings = new Map<string, number>();

  quotaEntries(key: string): number {
    return (this.zsets.get(key) ?? []).length;
  }

  async eval(script: string, keys: string[], args: string[]): Promise<unknown> {
    const key = keys[0]!;

    if (script.includes("chainmcp:quota_rollback")) {
      const requestId = args[0]!;
      const set = (this.zsets.get(key) ?? []).filter(
        (entry) => entry.member !== requestId,
      );
      this.zsets.set(key, set);
      return 1;
    }

    if (script.includes("ZREMRANGEBYSCORE")) {
      const now = Number(args[0]);
      const windowMs = Number(args[1]);
      const maxRequests = Number(args[2]);
      const requestId = args[3]!;

      const windowStart = now - windowMs;
      let set = this.zsets.get(key) ?? [];
      set = set.filter((entry) => entry.score > windowStart);
      this.zsets.set(key, set);

      if (set.length >= maxRequests) {
        return [0, 1000];
      }

      set.push({ score: now, member: requestId });
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

    return null;
  }
}

describe("InMemoryRateLimiter additional coverage", () => {
  it("clears all tracking on reset()", async () => {
    const limiter = new InMemoryRateLimiter({
      globalConcurrency: 1,
      globalQuota: { maxRequests: 1, windowMs: 10_000 },
    });
    const ctx = context();

    const first = await limiter.check(ctx, "tool-1");
    expect(first.allowed).toBe(true);

    const second = await limiter.check(ctx, "tool-1");
    expect(second.allowed).toBe(false);

    limiter.reset();

    const afterReset = await limiter.check(ctx, "tool-1");
    expect(afterReset.allowed).toBe(true);
  });

  it("evaluates functional and object quotas for tenants and principals", async () => {
    const nowTime = 1_000;
    const limiter = new InMemoryRateLimiter({
      now: () => nowTime,
      tenantQuota: (tId) =>
        tId === "t-special" ? { maxRequests: 2, windowMs: 5_000 } : undefined,
      principalQuota: (pId) =>
        pId === "vip"
          ? { maxRequests: 3, windowMs: 5_000 }
          : { maxRequests: 1, windowMs: 5_000 },
    });

    const vipCtx = context("t-special", "vip");
    const normalCtx = context("t-other", "user-2");

    expect((await limiter.check(vipCtx, "tool")).allowed).toBe(true);
    expect((await limiter.check(vipCtx, "tool")).allowed).toBe(true);
    expect((await limiter.check(vipCtx, "tool")).allowed).toBe(false);

    expect((await limiter.check(normalCtx, "tool")).allowed).toBe(true);
    expect((await limiter.check(normalCtx, "tool")).allowed).toBe(false);
  });

  it("evaluates functional and object concurrency policies across levels", async () => {
    const limiter = new InMemoryRateLimiter({
      tenantConcurrency: (tId) => (tId === "t1" ? { maxConcurrent: 2 } : 1),
      principalConcurrency: { maxConcurrent: 2, ttlSeconds: 30 },
      toolConcurrency: (toolName) =>
        toolName === "heavy" ? { maxConcurrent: 1 } : undefined,
    });

    const ctx = context("t1", "p1");

    expect((await limiter.check(ctx, "heavy")).allowed).toBe(true);
    const denied = await limiter.check(ctx, "heavy");
    expect(denied.allowed).toBe(false);

    await limiter.release(ctx, "heavy");
    expect((await limiter.check(ctx, "heavy")).allowed).toBe(true);
    await limiter.release(ctx, "heavy");
  });

  it("handles concurrency release when current count drops to 0 or was not tracked", async () => {
    const limiter = new InMemoryRateLimiter({ globalConcurrency: 1 });
    const ctx = context();

    await limiter.release(ctx, "tool-not-tracked");

    await limiter.check(ctx, "tool-1");
    await limiter.release(ctx, "tool-1");
    await limiter.release(ctx, "tool-1");
  });
});

describe("DistributedRateLimiter additional coverage", () => {
  it("validates constructor options", () => {
    expect(
      () =>
        new DistributedRateLimiter(
          null as unknown as DistributedRateLimiterOptions,
        ),
    ).toThrow("DistributedRateLimiter requires options");

    expect(
      () =>
        new DistributedRateLimiter({
          client: {} as unknown as RedisRateLimitClient,
        }),
    ).toThrow("DistributedRateLimiter requires a Redis client with eval");
  });

  it("evaluates functional quotas for tenants, tools, and principals", async () => {
    const client = new MockRedisClient();
    const limiter = new DistributedRateLimiter({
      client,
      tenantQuota: () => ({ maxRequests: 2, windowMs: 10_000 }),
      toolQuota: () => ({ maxRequests: 2, windowMs: 10_000 }),
      principalQuota: () => ({ maxRequests: 2, windowMs: 10_000 }),
    });

    const ctx = context("t1", "p1");
    const decision = await limiter.check(ctx, "search");
    expect(decision.allowed).toBe(true);
  });

  it("evaluates functional concurrency policies across levels", async () => {
    const client = new MockRedisClient();
    const limiter = new DistributedRateLimiter({
      client,
      tenantConcurrency: () => ({ maxConcurrent: 1 }),
      principalConcurrency: () => ({ maxConcurrent: 1 }),
      toolConcurrency: () => ({ maxConcurrent: 1 }),
    });

    const ctx = context("t1", "p1");
    const decision = await limiter.check(ctx, "compute");
    expect(decision.allowed).toBe(true);

    await limiter.release(ctx, "compute");
  });

  it("rolls back quota when a subsequent concurrency check denies the request", async () => {
    const client = new MockRedisClient();
    const limiter = new DistributedRateLimiter({
      client,
      globalQuota: { maxRequests: 5, windowMs: 60_000 },
      globalConcurrency: 0, // Immediately denies
    });

    const ctx = context("t1", "p1");
    const decision = await limiter.check(ctx, "tool-1");
    expect(decision.allowed).toBe(false);

    expect(client.quotaEntries("chainmcp:rl:global:quota")).toBe(0);
  });

  it("isolates release and rollback errors without failing callers", async () => {
    const brokenClient: RedisRateLimitClient = {
      async eval(script) {
        if (script.includes("HDEL") || script.includes("quota_rollback")) {
          throw new Error("Redis connection dropped during cleanup");
        }
        return [1, 0];
      },
    };

    const limiter = new DistributedRateLimiter({
      client: brokenClient,
      globalConcurrency: 1,
    });

    const ctx = context("t1", "p1");
    await expect(limiter.release(ctx, "tool-1")).resolves.toBeUndefined();
  });
});

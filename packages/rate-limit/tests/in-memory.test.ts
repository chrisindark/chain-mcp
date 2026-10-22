import {
  InMemoryToolRuntime,
  RuntimeError,
  type ToolContext,
  type ToolDefinition,
} from "@chainmcp/core";
import { describe, expect, it } from "vitest";
import { InMemoryRateLimiter } from "../src/index.js";

const context = (
  tenantId = "tenant-1",
  principalId = "user-1",
): ToolContext => ({
  requestId: "req-1",
  tenantId,
  principal: { id: principalId, scopes: [] },
});

function tool(name = "test_tool"): ToolDefinition {
  return {
    name,
    description: "test",
    inputSchema: { type: "object" },
    operation: {},
    execute: async (input) => input,
  };
}

describe("InMemoryRateLimiter", () => {
  it("enforces tenant, principal, tool, and global quotas", async () => {
    let mockTime = 100_000;
    const now = () => mockTime;

    const limiter = new InMemoryRateLimiter({
      now,
      tenantQuota: { maxRequests: 2, windowMs: 10_000 },
      toolQuota: (toolName) =>
        toolName === "expensive_tool"
          ? { maxRequests: 1, windowMs: 5_000 }
          : undefined,
    });

    const ctx = context("tenant-1");

    // 1. Tool-level quota check
    expect((await limiter.check(ctx, "expensive_tool")).allowed).toBe(true);
    const toolDenied = await limiter.check(ctx, "expensive_tool");
    expect(toolDenied.allowed).toBe(false);
    expect(toolDenied.retryAfterSeconds).toBe(5);

    // Call cheap_tool: tenant quota is now at 1 request used (from expensive_tool)
    expect((await limiter.check(ctx, "cheap_tool")).allowed).toBe(true);

    // Third call for tenant-1: exceeds tenant quota (maxRequests: 2)
    const tenantDenied = await limiter.check(ctx, "cheap_tool");
    expect(tenantDenied.allowed).toBe(false);
    expect(tenantDenied.retryAfterSeconds).toBe(10);

    // Advance time past tenant window (10s)
    mockTime += 10_001;
    expect((await limiter.check(ctx, "cheap_tool")).allowed).toBe(true);
  });

  it("enforces concurrency limits and releases permits upon completion", async () => {
    const limiter = new InMemoryRateLimiter({
      globalConcurrency: 2,
    });

    const ctx = context();

    // Acquire 2 slots
    expect((await limiter.check(ctx, "tool-1")).allowed).toBe(true);
    expect((await limiter.check(ctx, "tool-2")).allowed).toBe(true);

    // 3rd attempt exceeds concurrency
    const denied = await limiter.check(ctx, "tool-3");
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBe(1);

    // Release 1 slot
    await limiter.release(ctx, "tool-1");

    // Can now acquire
    expect((await limiter.check(ctx, "tool-3")).allowed).toBe(true);
  });

  it("integrates seamlessly with ToolRuntime pipeline and attaches retryAfterSeconds to RuntimeError", async () => {
    const mockTime = 50_000;
    const limiter = new InMemoryRateLimiter({
      now: () => mockTime,
      globalQuota: { maxRequests: 1, windowMs: 20_000 },
    });

    const runtime = new InMemoryToolRuntime({
      rateLimiter: limiter,
    });
    runtime.register(tool("my_tool"));

    const ctx = context();
    await expect(runtime.callTool("my_tool", {}, ctx)).resolves.toEqual({});

    // Second call rejected with RATE_LIMITED carrying retryAfterSeconds
    const error = await runtime
      .callTool("my_tool", {}, ctx)
      .catch((err) => err);
    expect(error).toBeInstanceOf(RuntimeError);
    const runtimeError = error as RuntimeError;
    expect(runtimeError.code).toBe("RATE_LIMITED");
    expect(runtimeError.retryAfterSeconds).toBe(20);
  });
});

describe("InMemoryRateLimiter window bounds", () => {
  it("evicts the least recently used window when the cap is reached", async () => {
    const mockTime = 900_000;
    const limiter = new InMemoryRateLimiter({
      now: () => mockTime,
      toolQuota: { maxRequests: 1, windowMs: 60_000 },
      maxTrackedWindows: 2,
    });
    const ctx = context();

    expect((await limiter.check(ctx, "a")).allowed).toBe(true);
    expect((await limiter.check(ctx, "b")).allowed).toBe(true);
    expect(limiter.trackedWindowCount).toBe(2);

    // Adding a third tool evicts the oldest window and stays within the cap.
    expect((await limiter.check(ctx, "c")).allowed).toBe(true);
    expect(limiter.trackedWindowCount).toBe(2);

    // Retained windows still enforce their quota.
    expect((await limiter.check(ctx, "b")).allowed).toBe(false);
    expect((await limiter.check(ctx, "c")).allowed).toBe(false);

    // The evicted window was forgotten, so its identity can call once more
    // before the rebuilt window applies. This is the documented trade-off.
    expect((await limiter.check(ctx, "a")).allowed).toBe(true);
    expect((await limiter.check(ctx, "a")).allowed).toBe(false);
    expect(limiter.trackedWindowCount).toBe(2);
  });

  it("drops a window once every timestamp has expired", async () => {
    let mockTime = 400_000;
    const limiter = new InMemoryRateLimiter({
      now: () => mockTime,
      toolQuota: { maxRequests: 1, windowMs: 1_000 },
    });
    const ctx = context();

    expect((await limiter.check(ctx, "slow_tool")).allowed).toBe(true);
    expect(limiter.trackedWindowCount).toBe(1);

    mockTime += 1_001;
    expect((await limiter.check(ctx, "slow_tool")).allowed).toBe(true);
    expect(limiter.trackedWindowCount).toBe(1);
  });

  it("rejects an invalid window cap", () => {
    expect(() => new InMemoryRateLimiter({ maxTrackedWindows: 0 })).toThrow(
      TypeError,
    );
    expect(() => new InMemoryRateLimiter({ maxTrackedWindows: 1.5 })).toThrow(
      TypeError,
    );
  });
});

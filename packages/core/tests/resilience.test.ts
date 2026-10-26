import { describe, expect, it, vi } from "vitest";
import {
  InMemoryToolRuntime,
  RuntimeError,
  type CacheStore,
  type Logger,
  type MetricsSink,
  type RateLimiter,
  type ToolContext,
  type ToolDefinition,
} from "../src/index.js";

const context: ToolContext = {
  requestId: "req-resilience-1",
  tenantId: "tenant-resilience",
  principal: { id: "user-resilience", scopes: ["read"] },
};

function createMockTool(
  name: string,
  execute: ToolDefinition["execute"] = async (input) => input,
  overrides: Partial<ToolDefinition> = {},
): ToolDefinition {
  return {
    name,
    description: `Resilience test tool ${name}`,
    inputSchema: {
      type: "object",
      properties: {
        val: { type: "string" },
        id: { type: "integer" },
      },
      additionalProperties: true,
    },
    operation: { requiredScopes: ["read"] },
    contractRevision: "rev-resilience-1",
    execute,
    ...overrides,
  };
}

describe("Core Runtime Resilience and Fault Injection", () => {
  describe("Cache store fault injection", () => {
    it("gracefully degrades to bypass when cache store get() throws", async () => {
      let executionCount = 0;
      const failingStore: CacheStore = {
        get: vi.fn(async () => {
          throw new Error(
            "Redis connection refused: ECONNREFUSED 127.0.0.1:6379",
          );
        }),
        set: vi.fn(async () => {}),
        delete: vi.fn(async () => {}),
      };

      const runtime = new InMemoryToolRuntime({
        cache: {
          store: failingStore,
          authorizationPartition: () => "auth-partition-1",
        },
      });

      const tool = createMockTool(
        "cached_lookup",
        async (input) => {
          executionCount++;
          return { data: input, computed: true };
        },
        {
          cache: { ttlSeconds: 60 },
        },
      );

      runtime.register(tool);

      // Invoke tool: store.get throws, runtime catches and degrades to bypass
      const result = await runtime.callTool(
        "cached_lookup",
        { val: "test-query" },
        context,
      );

      expect(result).toEqual({ data: { val: "test-query" }, computed: true });
      expect(executionCount).toBe(1);
      expect(failingStore.get).toHaveBeenCalledTimes(1);
      // It also attempted to write the cached result
      expect(failingStore.set).toHaveBeenCalledTimes(1);
    });

    it("gracefully completes tool call when cache store set() throws", async () => {
      let executionCount = 0;
      const failingStore: CacheStore = {
        get: vi.fn(async () => undefined), // cache miss
        set: vi.fn(async () => {
          throw new Error(
            "OOM: command not allowed when used memory > 'maxmemory'",
          );
        }),
        delete: vi.fn(async () => {}),
      };

      const runtime = new InMemoryToolRuntime({
        cache: {
          store: failingStore,
          authorizationPartition: () => "auth-partition-1",
        },
      });

      const tool = createMockTool(
        "cached_write_test",
        async (input) => {
          executionCount++;
          return { success: true, payload: input };
        },
        {
          cache: { ttlSeconds: 120 },
        },
      );

      runtime.register(tool);

      const result = await runtime.callTool(
        "cached_write_test",
        { val: "hello" },
        context,
      );

      expect(result).toEqual({ success: true, payload: { val: "hello" } });
      expect(executionCount).toBe(1);
      expect(failingStore.set).toHaveBeenCalledTimes(1);
    });

    it("gracefully bypasses cache when authorizationPartition throws", async () => {
      let executionCount = 0;
      const store: CacheStore = {
        get: vi.fn(async () => undefined),
        set: vi.fn(async () => {}),
        delete: vi.fn(async () => {}),
      };

      const runtime = new InMemoryToolRuntime({
        cache: {
          store,
          authorizationPartition: () => {
            throw new Error("Auth partition derivation failed");
          },
        },
      });

      const tool = createMockTool(
        "partition_fail_tool",
        async (input) => {
          executionCount++;
          return { ok: true, input };
        },
        {
          cache: { ttlSeconds: 60 },
        },
      );

      runtime.register(tool);

      const result = await runtime.callTool(
        "partition_fail_tool",
        { val: "bypass-test" },
        context,
      );

      expect(result).toEqual({ ok: true, input: { val: "bypass-test" } });
      expect(executionCount).toBe(1);
      // Store get should NOT have been called because cacheKey could not be created
      expect(store.get).not.toHaveBeenCalled();
    });
  });

  describe("Rate limiter fault injection", () => {
    it("fails closed with UPSTREAM_FAILURE when rate limiter check() throws", async () => {
      const failingLimiter: RateLimiter = {
        check: vi.fn(async () => {
          throw new Error("Rate limiter backend unavailable");
        }),
      };

      const runtime = new InMemoryToolRuntime({
        rateLimiter: failingLimiter,
      });

      let executed = false;
      const tool = createMockTool("guarded_tool", async () => {
        executed = true;
        return { ok: true };
      });

      runtime.register(tool);

      await expect(
        runtime.callTool("guarded_tool", {}, context),
      ).rejects.toMatchObject({
        code: "UPSTREAM_FAILURE",
        message: expect.stringContaining(
          "Rate limiter for tool 'guarded_tool' failed",
        ),
      });

      expect(executed).toBe(false);
    });

    it("enforces denial with RATE_LIMITED when rate limiter denies request", async () => {
      const denyingLimiter: RateLimiter = {
        check: vi.fn(async () => ({
          allowed: false,
          retryAfterSeconds: 30,
        })),
      };

      const runtime = new InMemoryToolRuntime({
        rateLimiter: denyingLimiter,
      });

      let executed = false;
      const tool = createMockTool("denied_tool", async () => {
        executed = true;
        return { ok: true };
      });

      runtime.register(tool);

      const error = await runtime
        .callTool("denied_tool", {}, context)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(RuntimeError);
      expect(error).toMatchObject({
        code: "RATE_LIMITED",
        retryAfterSeconds: 30,
      });
      expect(executed).toBe(false);
    });

    it("safely completes invocation when rate limiter release() throws", async () => {
      const faultyReleaseLimiter: RateLimiter = {
        check: vi.fn(async () => ({ allowed: true })),
        release: vi.fn(async () => {
          throw new Error("Concurrency permit release failed in redis");
        }),
      };

      const runtime = new InMemoryToolRuntime({
        rateLimiter: faultyReleaseLimiter,
      });

      const tool = createMockTool("release_test_tool", async () => ({
        success: true,
      }));

      runtime.register(tool);

      // Should complete successfully even though release threw
      const result = await runtime.callTool("release_test_tool", {}, context);
      expect(result).toEqual({ success: true });
      expect(faultyReleaseLimiter.release).toHaveBeenCalledTimes(1);
    });
  });

  describe("Observability sink fault isolation", () => {
    it("safely completes tool call when logger methods throw", async () => {
      const throwingLogger: Logger = {
        debug: vi.fn(() => {
          throw new Error("Logger debug error");
        }),
        info: vi.fn(() => {
          throw new Error("Logger info error");
        }),
        warn: vi.fn(() => {
          throw new Error("Logger warn error");
        }),
        error: vi.fn(() => {
          throw new Error("Logger error error");
        }),
        audit: vi.fn(() => {
          throw new Error("Logger audit error");
        }),
      };

      const runtime = new InMemoryToolRuntime({
        logger: throwingLogger,
      });

      const tool = createMockTool("logging_tool", async () => ({
        done: true,
      }));

      runtime.register(tool);

      const result = await runtime.callTool("logging_tool", {}, context);
      expect(result).toEqual({ done: true });
      expect(throwingLogger.info).toHaveBeenCalled();
    });

    it("safely completes tool call when metrics record() throws or rejects", async () => {
      const throwingMetrics: MetricsSink = {
        record: vi.fn(async () => {
          throw new Error("StatsD UDP socket error");
        }),
      };

      const runtime = new InMemoryToolRuntime({
        metrics: throwingMetrics,
      });

      const tool = createMockTool("metrics_tool", async () => ({
        recorded: true,
      }));

      runtime.register(tool);

      const result = await runtime.callTool("metrics_tool", {}, context);
      expect(result).toEqual({ recorded: true });
      expect(throwingMetrics.record).toHaveBeenCalled();
    });
  });

  describe("Cancellation and Timeout", () => {
    it("immediately aborts when invoked with an already-cancelled signal", async () => {
      const runtime = new InMemoryToolRuntime();
      let executed = false;
      const tool = createMockTool("abort_tool", async () => {
        executed = true;
        return { ok: true };
      });
      runtime.register(tool);

      const abortController = new AbortController();
      abortController.abort(new Error("Operation aborted by user"));

      await expect(
        runtime.callTool(
          "abort_tool",
          {},
          {
            ...context,
            signal: abortController.signal,
          },
        ),
      ).rejects.toMatchObject({
        code: "CANCELLED",
      });

      expect(executed).toBe(false);
    });

    it("aborts when signal is triggered while tool execution is in flight", async () => {
      const runtime = new InMemoryToolRuntime();
      const abortController = new AbortController();

      const tool = createMockTool("async_abort_tool", async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { ok: true };
      });
      runtime.register(tool);

      const callPromise = runtime.callTool(
        "async_abort_tool",
        {},
        {
          ...context,
          signal: abortController.signal,
        },
      );

      // Abort after 10ms while still in flight
      setTimeout(() => {
        abortController.abort(new Error("User cancelled"));
      }, 10);

      await expect(callPromise).rejects.toMatchObject({
        code: "CANCELLED",
      });
    });

    it("enforces tool execution timeout with UPSTREAM_TIMEOUT", async () => {
      const runtime = new InMemoryToolRuntime({
        defaultTimeoutMs: 50,
      });

      const tool = createMockTool("slow_tool", async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return { ok: true };
      });
      runtime.register(tool);

      await expect(
        runtime.callTool("slow_tool", {}, context),
      ).rejects.toMatchObject({
        code: "UPSTREAM_TIMEOUT",
      });
    });
  });

  describe("High-concurrency multi-tenant load test", () => {
    it("executes 100 concurrent requests across 10 tenants without corruption or cross-talk", async () => {
      const runtime = new InMemoryToolRuntime();

      const tool = createMockTool("worker_tool", async (input) => {
        const payload = input as { tenant: string; id: number };
        // Small async jitter to test interleaving
        await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 5)));
        return {
          echoTenant: payload.tenant,
          echoId: payload.id,
          timestamp: Date.now(),
        };
      });
      runtime.register(tool);

      const totalRequests = 100;
      const tasks: Promise<unknown>[] = [];

      for (let i = 0; i < totalRequests; i++) {
        const tenantId = `tenant-${i % 10}`;
        const reqContext: ToolContext = {
          requestId: `load-req-${i}`,
          tenantId,
          principal: { id: `principal-${i}`, scopes: ["read"] },
        };

        tasks.push(
          runtime
            .callTool("worker_tool", { tenant: tenantId, id: i }, reqContext)
            .then((res) => {
              const data = res as { echoTenant: string; echoId: number };
              expect(data.echoTenant).toBe(tenantId);
              expect(data.echoId).toBe(i);
            }),
        );
      }

      await Promise.all(tasks);
    });
  });
});

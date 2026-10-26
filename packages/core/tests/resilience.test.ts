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

  describe("Production load and fault-injection harness", () => {
    it("executes 1,000 concurrent requests across 50 tenants with strict isolation and caching", async () => {
      let executionCount = 0;
      const runtime = new InMemoryToolRuntime({
        cache: {
          store: {
            get: vi.fn(async () => undefined),
            set: vi.fn(async () => {}),
            delete: vi.fn(async () => {}),
          },
          authorizationPartition: (ctx) => ctx.tenantId,
        },
      });

      const tool = createMockTool(
        "worker_tool",
        async (input, ctx) => {
          executionCount++;
          const payload = input as { tenant: string; id: number };
          // Random 0-2ms async jitter to simulate asynchronous concurrency
          if (payload.id % 5 === 0) {
            await new Promise((r) => setTimeout(r, 1));
          }
          return {
            echoTenant: payload.tenant,
            echoId: payload.id,
            echoPrincipal: ctx.principal?.id,
            requestId: ctx.requestId,
          };
        },
        { cache: { ttlSeconds: 60 } },
      );
      runtime.register(tool);

      const totalRequests = 1000;
      const numTenants = 50;
      const tasks: Promise<void>[] = [];

      for (let i = 0; i < totalRequests; i++) {
        const tenantId = `tenant-${i % numTenants}`;
        const principalId = `user-${i % 25}`;
        const reqContext: ToolContext = {
          requestId: `load-req-${i}`,
          tenantId,
          principal: { id: principalId, scopes: ["read"] },
        };

        tasks.push(
          runtime
            .callTool("worker_tool", { tenant: tenantId, id: i }, reqContext)
            .then((res) => {
              const data = res as {
                echoTenant: string;
                echoId: number;
                echoPrincipal: string;
                requestId: string;
              };
              expect(data.echoTenant).toBe(tenantId);
              expect(data.echoId).toBe(i);
              expect(data.echoPrincipal).toBe(principalId);
              expect(data.requestId).toBe(`load-req-${i}`);
            }),
        );
      }

      await Promise.all(tasks);
      expect(executionCount).toBe(totalRequests);
    });

    it("runs concurrent chaos harness with 500 mixed requests (faults, timeouts, schema errors, healthy calls)", async () => {
      const runtime = new InMemoryToolRuntime();

      // 1. Healthy tool
      runtime.register(
        createMockTool("healthy_tool", async (input) => ({
          status: "ok",
          echo: input,
        })),
      );

      // 2. Intermittent upstream failure tool
      let flakyCount = 0;
      runtime.register(
        createMockTool("flaky_tool", async () => {
          flakyCount++;
          if (flakyCount % 2 === 0) {
            throw new RuntimeError(
              "UPSTREAM_FAILURE",
              "Upstream gateway 503 Service Unavailable",
            );
          }
          return { status: "recovered" };
        }),
      );

      // 3. Upstream timeout tool
      runtime.register(
        createMockTool(
          "timeout_tool",
          async () => {
            await new Promise((r) => setTimeout(r, 100));
            return { status: "slow" };
          },
          { timeoutMs: 10 },
        ),
      );

      const totalChaosRequests = 500;
      const tasks: Promise<{
        type: string;
        success: boolean;
        errorCode?: string;
      }>[] = [];

      for (let i = 0; i < totalChaosRequests; i++) {
        const tenantId = `chaos-tenant-${i % 20}`;
        const reqContext: ToolContext = {
          requestId: `chaos-req-${i}`,
          tenantId,
          principal: { id: `chaos-user-${i % 10}`, scopes: ["read"] },
        };

        const scenario = i % 4;

        if (scenario === 0) {
          // Healthy
          tasks.push(
            runtime
              .callTool("healthy_tool", { val: `val-${i}` }, reqContext)
              .then(() => ({ type: "healthy", success: true }))
              .catch((err) => ({
                type: "healthy",
                success: false,
                errorCode: err instanceof RuntimeError ? err.code : "UNKNOWN",
              })),
          );
        } else if (scenario === 1) {
          // Flaky upstream (expecting either success or UPSTREAM_UNAVAILABLE)
          tasks.push(
            runtime
              .callTool("flaky_tool", { val: `flaky-${i}` }, reqContext)
              .then(() => ({ type: "flaky", success: true }))
              .catch((err) => ({
                type: "flaky",
                success: false,
                errorCode: err instanceof RuntimeError ? err.code : "UNKNOWN",
              })),
          );
        } else if (scenario === 2) {
          // Timeout tool (expecting UPSTREAM_TIMEOUT)
          tasks.push(
            runtime
              .callTool("timeout_tool", {}, reqContext)
              .then(() => ({ type: "timeout", success: true }))
              .catch((err) => ({
                type: "timeout",
                success: false,
                errorCode: err instanceof RuntimeError ? err.code : "UNKNOWN",
              })),
          );
        } else {
          // Invalid schema inputs (expecting INPUT_INVALID)
          tasks.push(
            runtime
              .callTool(
                "healthy_tool",
                { val: 12345 /* invalid type */ },
                reqContext,
              )
              .then(() => ({ type: "schema", success: true }))
              .catch((err) => ({
                type: "schema",
                success: false,
                errorCode: err instanceof RuntimeError ? err.code : "UNKNOWN",
              })),
          );
        }
      }

      const results = await Promise.all(tasks);

      // Verify healthy scenario had 100% success rate
      const healthyResults = results.filter((r) => r.type === "healthy");
      expect(healthyResults.every((r) => r.success)).toBe(true);

      // Verify timeouts failed cleanly with UPSTREAM_TIMEOUT
      const timeoutResults = results.filter((r) => r.type === "timeout");
      expect(
        timeoutResults.every(
          (r) => !r.success && r.errorCode === "UPSTREAM_TIMEOUT",
        ),
      ).toBe(true);

      // Verify schema violations failed cleanly with INPUT_INVALID
      const schemaResults = results.filter((r) => r.type === "schema");
      expect(
        schemaResults.every(
          (r) => !r.success && r.errorCode === "INPUT_INVALID",
        ),
      ).toBe(true);

      // Verify flaky tool handled failures without uncaught crash
      const flakyResults = results.filter((r) => r.type === "flaky");
      expect(
        flakyResults.some((r) => r.success) &&
          flakyResults.some(
            (r) => !r.success && r.errorCode === "UPSTREAM_FAILURE",
          ),
      ).toBe(true);
    });

    it("survives cache store intermittent failure under concurrent load (fail-open)", async () => {
      let cacheFailures = 0;
      let executedCalls = 0;

      const flakyCache: CacheStore = {
        get: vi.fn(async () => {
          if (Math.random() < 0.4) {
            cacheFailures++;
            throw new Error("Simulated Redis connection drop on read");
          }
          return undefined;
        }),
        set: vi.fn(async () => {
          if (Math.random() < 0.4) {
            cacheFailures++;
            throw new Error("Simulated Redis timeout on write");
          }
        }),
        delete: vi.fn(async () => {}),
      };

      const runtime = new InMemoryToolRuntime({
        cache: {
          store: flakyCache,
          authorizationPartition: (ctx) => ctx.tenantId,
        },
      });
      const tool = createMockTool(
        "resilient_tool",
        async (input) => {
          executedCalls++;
          return { echo: input };
        },
        { cache: { ttlSeconds: 60 } },
      );
      runtime.register(tool);

      const tasks: Promise<unknown>[] = [];
      const concurrentCalls = 200;

      for (let i = 0; i < concurrentCalls; i++) {
        const reqContext: ToolContext = {
          requestId: `failopen-req-${i}`,
          tenantId: `tenant-${i % 5}`,
          principal: { id: "user", scopes: ["read"] },
        };
        tasks.push(runtime.callTool("resilient_tool", { id: i }, reqContext));
      }

      // All 200 requests MUST succeed despite cache errors
      const results = await Promise.all(tasks);
      expect(results).toHaveLength(concurrentCalls);
      expect(cacheFailures).toBeGreaterThan(0);
      expect(executedCalls).toBe(concurrentCalls);
    });

    it("enforces rate limiter concurrency backpressure and recovers cleanly", async () => {
      let inFlight = 0;
      let maxSeenConcurrency = 0;
      const concurrencyLimit = 10;

      const limiter: RateLimiter = {
        check: vi.fn(async () => {
          if (inFlight >= concurrencyLimit) {
            return {
              allowed: false,
              limit: concurrencyLimit,
              remaining: 0,
              resetSeconds: 1,
              retryAfterSeconds: 1,
            };
          }
          inFlight++;
          maxSeenConcurrency = Math.max(maxSeenConcurrency, inFlight);
          return {
            allowed: true,
            limit: concurrencyLimit,
            remaining: concurrencyLimit - inFlight,
            resetSeconds: 1,
          };
        }),
        release: vi.fn(async () => {
          inFlight = Math.max(0, inFlight - 1);
        }),
      };

      const runtime = new InMemoryToolRuntime({ rateLimiter: limiter });
      const tool = createMockTool("limited_tool", async () => {
        await new Promise((r) => setTimeout(r, 20));
        return { status: "processed" };
      });
      runtime.register(tool);

      // Fire 40 simultaneous requests
      const tasks = Array.from({ length: 40 }, (_, i) => {
        const reqContext: ToolContext = {
          requestId: `limited-req-${i}`,
          tenantId: "tenant-concurrency",
          principal: { id: "user-concurrency", scopes: ["read"] },
        };
        return runtime
          .callTool("limited_tool", {}, reqContext)
          .then(() => ({ success: true }))
          .catch((err) => ({
            success: false,
            code: err instanceof RuntimeError ? err.code : "ERR",
            retryAfter: err instanceof RuntimeError ? err.retryAfterSeconds : 0,
          }));
      });

      const results = await Promise.all(tasks);
      const successful = results.filter((r) => r.success);
      const rateLimited = results.filter(
        (
          r,
        ): r is {
          success: false;
          code: string;
          retryAfter: number | undefined;
        } => !r.success,
      );

      expect(successful.length).toBe(concurrencyLimit);
      expect(rateLimited.length).toBe(30);
      expect(maxSeenConcurrency).toBe(concurrencyLimit);
      for (const rl of rateLimited) {
        expect(rl.code).toBe("RATE_LIMITED");
        expect(rl.retryAfter).toBe(1);
      }

      // Concurrency lock is released cleanly
      expect(inFlight).toBe(0);

      // Subsequent requests now succeed
      const followUp = await runtime.callTool(
        "limited_tool",
        {},
        {
          requestId: "followup-req",
          tenantId: "tenant-concurrency",
          principal: { id: "user", scopes: ["read"] },
        },
      );
      expect(followUp).toEqual({ status: "processed" });
    });

    it("handles throwing observability sinks under high concurrent load without caller failure", async () => {
      const failingSink: MetricsSink = {
        record: vi.fn(() => {
          throw new Error("Telemetry agent buffer overflow");
        }),
      };

      const failingLogger: Logger = {
        debug: vi.fn(),
        info: vi.fn(() => {
          throw new Error("Disk full writing stdout log buffer");
        }),
        warn: vi.fn(),
        error: vi.fn(),
      };

      const runtime = new InMemoryToolRuntime({
        metrics: failingSink,
        logger: failingLogger,
      });

      const tool = createMockTool("obs_tool", async (input) => ({
        result: input,
      }));
      runtime.register(tool);

      const tasks = Array.from({ length: 100 }, (_, i) =>
        runtime.callTool(
          "obs_tool",
          { id: i },
          {
            requestId: `obs-req-${i}`,
            tenantId: `tenant-${i % 5}`,
            principal: { id: "user", scopes: ["read"] },
          },
        ),
      );

      const results = await Promise.all(tasks);
      expect(results).toHaveLength(100);
      expect(failingSink.record).toHaveBeenCalled();
    });
  });
});

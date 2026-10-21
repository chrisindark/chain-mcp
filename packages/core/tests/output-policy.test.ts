import { describe, expect, it, vi } from "vitest";

import {
  InMemoryToolRuntime,
  RuntimeError,
  type CacheStore,
  type ResultProjector,
  type RuntimeEvent,
  type Tokenizer,
  type ToolContext,
  type ToolDefinition,
} from "../src/index.js";

const context: ToolContext = {
  requestId: "req-1",
  tenantId: "tenant-1",
  principal: { id: "user-1", scopes: ["read"] },
};

function tool(
  execute: ToolDefinition["execute"],
  overrides: Partial<ToolDefinition> = {},
): ToolDefinition {
  return {
    name: "lookup_item",
    description: "Look up a test item",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" } },
      additionalProperties: false,
    },
    operation: {},
    execute,
    ...overrides,
  };
}

function cacheableTool(
  execute: ToolDefinition["execute"],
  overrides: Partial<ToolDefinition> = {},
): ToolDefinition {
  return tool(execute, {
    contractRevision: "rev-1",
    cache: { ttlSeconds: 60 },
    ...overrides,
  });
}

function tokenizer(overrides: Partial<Tokenizer> = {}): Tokenizer {
  return {
    id: "test-exact",
    measurement: "exact",
    count: (text) => text.length,
    ...overrides,
  };
}

function recorder(): {
  events: RuntimeEvent[];
  metrics: { record(event: RuntimeEvent): void };
} {
  const events: RuntimeEvent[] = [];
  return {
    events,
    metrics: {
      record: (event) => {
        events.push(event);
      },
    },
  };
}

function memoryStore(order?: string[]): {
  store: CacheStore;
  entries: Map<string, unknown>;
} {
  const entries = new Map<string, unknown>();
  return {
    store: {
      async get<T>(key: string): Promise<T | undefined> {
        order?.push("cache.get");
        return entries.get(key) as T | undefined;
      },
      async set<T>(key: string, value: T): Promise<void> {
        order?.push("cache.set");
        entries.set(key, value);
      },
      async delete(key: string): Promise<void> {
        entries.delete(key);
      },
    },
    entries,
  };
}

describe("output projection", () => {
  it("applies the projector only to tools that opt in", async () => {
    const projector = vi.fn(({ result }) => ({ projected: result }));
    const runtime = new InMemoryToolRuntime({
      projector: { project: projector },
    });
    runtime.register(tool(async () => ({ value: "raw" })));

    await expect(
      runtime.callTool("lookup_item", { id: "a" }, context),
    ).resolves.toEqual({ value: "raw" });
    expect(projector).not.toHaveBeenCalled();
  });

  it("returns and caches only the projected result", async () => {
    const { store, entries } = memoryStore();
    const execute = vi.fn(async () => ({
      public: "visible",
      secret: "must-not-leak",
    }));
    const projector = vi.fn(() => ({ public: "visible" }));
    const runtime = new InMemoryToolRuntime({
      projector: { project: projector },
      cache: { store, authorizationPartition: () => "read" },
    });
    runtime.register(cacheableTool(execute, { output: {} }));

    await expect(
      runtime.callTool("lookup_item", { id: "a" }, context),
    ).resolves.toEqual({ public: "visible" });
    await expect(
      runtime.callTool("lookup_item", { id: "a" }, context),
    ).resolves.toEqual({ public: "visible" });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(projector).toHaveBeenCalledTimes(1);
    expect([...entries.values()]).toEqual([{ public: "visible" }]);
  });

  it("records token usage for a projected result without a budget", async () => {
    const { events, metrics } = recorder();
    const projected = { value: "fresh" };
    const runtime = new InMemoryToolRuntime({
      projector: { project: () => projected },
      tokenizer: tokenizer({ id: "test-estimate", measurement: "estimate" }),
      metrics,
    });
    runtime.register(tool(async () => ({ value: "raw" }), { output: {} }));

    await runtime.callTool("lookup_item", { id: "a" }, context);

    const text = JSON.stringify(projected);
    expect(events[0]?.tokenUsage).toEqual({
      count: text.length,
      measurement: "estimate",
      tokenizer: "test-estimate",
      payloadBytes: Buffer.byteLength(text, "utf8"),
    });
  });

  it("omits token usage when a budget-less projection cannot be counted", async () => {
    const { events, metrics } = recorder();
    const runtime = new InMemoryToolRuntime({
      projector: { project: () => ({ value: "fresh" }) },
      tokenizer: tokenizer({
        count: () => {
          throw new Error("tokenizer down");
        },
      }),
      metrics,
    });
    runtime.register(tool(async () => ({ value: "raw" }), { output: {} }));

    await expect(
      runtime.callTool("lookup_item", { id: "a" }, context),
    ).resolves.toEqual({ value: "fresh" });
    expect(events[0]?.outcome).toBe("success");
    expect(events[0]).not.toHaveProperty("tokenUsage");
  });

  it("fails closed when projection returns an unserializable result", async () => {
    const { store, entries } = memoryStore();
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    for (const projected of [undefined, cyclic, BigInt(1)]) {
      const runtime = new InMemoryToolRuntime({
        projector: { project: () => projected },
        cache: { store, authorizationPartition: () => "read" },
      });
      runtime.register(
        cacheableTool(async () => ({ value: "raw" }), { output: {} }),
      );

      await expect(
        runtime.callTool("lookup_item", { id: "a" }, context),
      ).rejects.toMatchObject({ code: "OUTPUT_POLICY_VIOLATION" });
    }
    expect(entries.size).toBe(0);
  });

  it("rejects a thenable projection instead of serializing a Promise", async () => {
    const { store, entries } = memoryStore();
    const runtime = new InMemoryToolRuntime({
      projector: {
        project: async () => ({ value: "fresh" }),
      },
      cache: { store, authorizationPartition: () => "read" },
    });
    runtime.register(
      cacheableTool(async () => ({ value: "raw" }), { output: {} }),
    );

    await expect(
      runtime.callTool("lookup_item", { id: "a" }, context),
    ).rejects.toMatchObject({ code: "OUTPUT_POLICY_VIOLATION" });
    expect(entries.size).toBe(0);
  });

  it("fails closed when the projector throws and preserves typed errors", async () => {
    const untyped = new InMemoryToolRuntime({
      projector: {
        project: () => {
          throw new Error("policy engine down");
        },
      },
    });
    untyped.register(tool(async () => ({ value: "raw" }), { output: {} }));
    await expect(
      untyped.callTool("lookup_item", { id: "a" }, context),
    ).rejects.toMatchObject({ code: "OUTPUT_POLICY_VIOLATION" });

    const typed = new RuntimeError("AUTH_FORBIDDEN", "Access denied");
    const typedRuntime = new InMemoryToolRuntime({
      projector: {
        project: () => {
          throw typed;
        },
      },
    });
    typedRuntime.register(tool(async () => ({ value: "raw" }), { output: {} }));
    await expect(
      typedRuntime.callTool("lookup_item", { id: "a" }, context),
    ).rejects.toBe(typed);
  });
});

describe("token budgets", () => {
  it("checks the budget against the projected result", async () => {
    const { store, entries } = memoryStore();
    const projected = { value: "ok" };
    const budget = JSON.stringify(projected).length;
    const runtime = new InMemoryToolRuntime({
      projector: { project: () => projected },
      tokenizer: tokenizer(),
      cache: { store, authorizationPartition: () => "read" },
    });
    runtime.register(
      cacheableTool(async () => ({ value: "x".repeat(1_000), secret: "raw" }), {
        output: { maxTokens: budget },
      }),
    );

    await expect(
      runtime.callTool("lookup_item", { id: "a" }, context),
    ).resolves.toEqual(projected);
    expect([...entries.values()]).toEqual([projected]);
  });

  it("allows a result at the budget and rejects one token over", async () => {
    const projected = { value: "fresh" };
    const count = JSON.stringify(projected).length;
    const atBudget = new InMemoryToolRuntime({
      projector: { project: () => projected },
      tokenizer: tokenizer(),
    });
    atBudget.register(
      tool(async () => ({ value: "raw" }), {
        output: { maxTokens: count },
      }),
    );
    await expect(
      atBudget.callTool("lookup_item", { id: "a" }, context),
    ).resolves.toEqual(projected);

    const overBudget = new InMemoryToolRuntime({
      projector: { project: () => projected },
      tokenizer: tokenizer(),
    });
    overBudget.register(
      tool(async () => ({ value: "raw" }), {
        output: { maxTokens: count - 1 },
      }),
    );
    await expect(
      overBudget.callTool("lookup_item", { id: "a" }, context),
    ).rejects.toMatchObject({ code: "OUTPUT_LIMIT_EXCEEDED" });
  });

  it("fails closed before caching when the budget is exceeded", async () => {
    const { store, entries } = memoryStore();
    const { events, metrics } = recorder();
    const set = vi.spyOn(store, "set");
    const runtime = new InMemoryToolRuntime({
      projector: { project: () => ({ value: "fresh" }) },
      tokenizer: tokenizer({ count: () => 100 }),
      cache: { store, authorizationPartition: () => "read" },
      metrics,
    });
    runtime.register(
      cacheableTool(async () => ({ value: "raw" }), {
        output: { maxTokens: 10 },
      }),
    );

    await expect(
      runtime.callTool("lookup_item", { id: "a" }, context),
    ).rejects.toMatchObject({
      code: "OUTPUT_LIMIT_EXCEEDED",
      message: "Tool 'lookup_item' output exceeds the token budget",
    });
    expect(set).not.toHaveBeenCalled();
    expect(entries.size).toBe(0);
    expect(events[0]).toMatchObject({
      outcome: "error",
      errorCode: "OUTPUT_LIMIT_EXCEEDED",
      cacheOutcome: "miss",
    });
    expect(events[0]).not.toHaveProperty("tokenUsage");
  });

  it("fails closed when a budget cannot be verified", async () => {
    const counts: Array<() => number> = [
      () => {
        throw new Error("tokenizer down");
      },
      () => -1,
      () => 1.5,
      () => Number.NaN,
      () => Number.POSITIVE_INFINITY,
    ];
    for (const count of counts) {
      const { store, entries } = memoryStore();
      const runtime = new InMemoryToolRuntime({
        projector: { project: () => ({ value: "fresh" }) },
        tokenizer: tokenizer({ count }),
        cache: { store, authorizationPartition: () => "read" },
      });
      runtime.register(
        cacheableTool(async () => ({ value: "raw" }), {
          output: { maxTokens: 10 },
        }),
      );

      await expect(
        runtime.callTool("lookup_item", { id: "a" }, context),
      ).rejects.toMatchObject({ code: "OUTPUT_POLICY_VIOLATION" });
      expect(entries.size).toBe(0);
    }
  });

  it("runs authorization, projection, budget, cache, measurement, and metrics in order", async () => {
    const order: string[] = [];
    const { store } = memoryStore(order);
    const { events } = recorder();
    const projected = { value: "fresh" };
    const budget = JSON.stringify(projected).length;
    const execute = vi.fn(async () => {
      order.push("execute");
      return { value: "raw" };
    });
    const runtime = new InMemoryToolRuntime({
      authorizer: {
        authorize: () => {
          order.push("authorize");
        },
      },
      rateLimiter: {
        check: () => {
          order.push("rate_limit");
          return { allowed: true };
        },
      },
      projector: {
        project: () => {
          order.push("project");
          return projected;
        },
      },
      tokenizer: tokenizer({
        count: (text) => {
          order.push("count");
          return text.length;
        },
      }),
      cache: { store, authorizationPartition: () => "read" },
      metrics: {
        record: (event) => {
          order.push("metrics");
          events.push(event);
        },
      },
    });
    runtime.register(cacheableTool(execute, { output: { maxTokens: budget } }));

    await runtime.callTool("lookup_item", { id: "a" }, context);
    expect(order).toEqual([
      "authorize",
      "rate_limit",
      "cache.get",
      "execute",
      "project",
      "count",
      "cache.set",
      "metrics",
    ]);

    order.length = 0;
    await runtime.callTool("lookup_item", { id: "a" }, context);
    expect(order).toEqual([
      "authorize",
      "rate_limit",
      "cache.get",
      "count",
      "metrics",
    ]);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(events[1]?.cacheOutcome).toBe("hit");
  });
});

describe("output policy configuration", () => {
  it("rejects an output policy when the runtime has no projector", () => {
    const runtime = new InMemoryToolRuntime();
    expect(() =>
      runtime.register(tool(async () => ({ value: "raw" }), { output: {} })),
    ).toThrowError(expect.objectContaining({ code: "CONTRACT_INVALID" }));
  });

  it("rejects a budget when the runtime has no tokenizer", () => {
    const runtime = new InMemoryToolRuntime({
      projector: { project: (request) => request.result },
    });
    expect(() =>
      runtime.register(
        tool(async () => ({ value: "raw" }), {
          output: { maxTokens: 10 },
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: "CONTRACT_INVALID" }));
  });

  it("rejects invalid budgets", () => {
    for (const maxTokens of [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      const runtime = new InMemoryToolRuntime({
        projector: { project: (request) => request.result },
        tokenizer: tokenizer(),
      });
      expect(() =>
        runtime.register(
          tool(async () => ({ value: "raw" }), { output: { maxTokens } }),
        ),
      ).toThrowError(expect.objectContaining({ code: "CONTRACT_INVALID" }));
    }
  });

  it("rejects an invalid projector configuration", () => {
    expect(
      () =>
        new InMemoryToolRuntime({
          projector: { project: undefined as never } as ResultProjector,
        }),
    ).toThrowError(expect.objectContaining({ code: "CONFIG_INVALID" }));
  });

  it("accepts a positive integer budget", () => {
    const runtime = new InMemoryToolRuntime({
      projector: { project: (request) => request.result },
      tokenizer: tokenizer(),
    });
    expect(() =>
      runtime.register(
        tool(async () => ({ value: "raw" }), { output: { maxTokens: 1 } }),
      ),
    ).not.toThrow();
  });
});

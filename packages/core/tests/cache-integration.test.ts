import { describe, expect, it, vi } from "vitest";

import {
  createCacheKey,
  InMemoryCacheStore,
  InMemoryToolRuntime,
  RuntimeError,
  type CacheStore,
  type RuntimeCacheOptions,
  type RuntimeEvent,
  type ToolContext,
  type ToolDefinition,
} from "../src/index.js";

const context: ToolContext = {
  requestId: "req-1",
  tenantId: "tenant-1",
  principal: { id: "user-1", scopes: ["read"] },
};

function cacheableTool(
  execute: ToolDefinition["execute"] = async (input) => input,
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
    contractRevision: "rev-1",
    cache: { ttlSeconds: 60 },
    execute,
    ...overrides,
  };
}

function cacheOptions(
  store: CacheStore = new InMemoryCacheStore(),
  authorizationPartition: RuntimeCacheOptions["authorizationPartition"] = (
    caller,
  ) => caller.principal.scopes.join(","),
): RuntimeCacheOptions {
  return { store, authorizationPartition };
}

describe("runtime invocation caching", () => {
  it("serves a repeated eligible call from cache and executes once", async () => {
    const execute = vi.fn(async () => ({ value: "fresh" }));
    const runtime = new InMemoryToolRuntime({ cache: cacheOptions() });
    runtime.register(cacheableTool(execute));

    await expect(
      runtime.callTool("lookup_item", { id: "a" }, context),
    ).resolves.toEqual({ value: "fresh" });
    await expect(
      runtime.callTool("lookup_item", { id: "a" }, context),
    ).resolves.toEqual({ value: "fresh" });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("builds the versioned key with tenant, principal, partition, revision, tool, and arguments", async () => {
    const store = new InMemoryCacheStore();
    const getSpy = vi.spyOn(store, "get");
    const setSpy = vi.spyOn(store, "set");
    const runtime = new InMemoryToolRuntime({ cache: cacheOptions(store) });
    const execute = vi.fn(async () => ({ value: "fresh" }));
    runtime.register(cacheableTool(execute));
    const input = { id: "a" };

    await runtime.callTool("lookup_item", input, context);

    const expectedKey = createCacheKey({
      tenantId: context.tenantId,
      principalId: context.principal.id,
      authorizationPartition: "read",
      contractRevision: "rev-1",
      toolName: "lookup_item",
      arguments: input,
    });
    expect(getSpy).toHaveBeenCalledWith(expectedKey);
    expect(setSpy).toHaveBeenCalledWith(expectedKey, { value: "fresh" }, 60);
  });

  it("does not cache tools that do not opt in", async () => {
    const execute = vi.fn(async (input) => input);
    const runtime = new InMemoryToolRuntime({ cache: cacheOptions() });
    const uncached = cacheableTool(execute);
    delete uncached.cache;
    runtime.register(uncached);

    await runtime.callTool("lookup_item", { id: "a" }, context);
    await runtime.callTool("lookup_item", { id: "a" }, context);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("keeps cache declarations inert when the runtime has no cache configured", async () => {
    const execute = vi.fn(async (input) => input);
    const runtime = new InMemoryToolRuntime();
    runtime.register(cacheableTool(execute));

    await runtime.callTool("lookup_item", { id: "a" }, context);
    await runtime.callTool("lookup_item", { id: "a" }, context);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("authorizes and rate-limits every call, including cached hits", async () => {
    const authorize = vi.fn();
    const check = vi.fn(() => ({ allowed: true }));
    const execute = vi.fn(async (input) => input);
    const runtime = new InMemoryToolRuntime({
      authorizer: { authorize },
      rateLimiter: { check },
      cache: cacheOptions(),
    });
    runtime.register(cacheableTool(execute));

    await runtime.callTool("lookup_item", { id: "a" }, context);
    await runtime.callTool("lookup_item", { id: "a" }, context);

    expect(authorize).toHaveBeenCalledTimes(2);
    expect(check).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("validates every call before a cache lookup", async () => {
    const execute = vi.fn(async (input) => input);
    const runtime = new InMemoryToolRuntime({ cache: cacheOptions() });
    runtime.register(cacheableTool(execute));

    await runtime.callTool("lookup_item", { id: "a" }, context);
    await expect(
      runtime.callTool("lookup_item", { id: 3 }, context),
    ).rejects.toMatchObject({ code: "INPUT_INVALID" });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("does not serve a cached result after authorization or rate-limit denial", async () => {
    let authorized = true;
    let allowed = true;
    const execute = vi.fn(async (input) => input);
    const runtime = new InMemoryToolRuntime({
      authorizer: {
        authorize: () => {
          if (!authorized) throw new Error("policy failure");
        },
      },
      rateLimiter: { check: () => ({ allowed }) },
      cache: cacheOptions(),
    });
    runtime.register(cacheableTool(execute));

    await runtime.callTool("lookup_item", { id: "a" }, context);
    authorized = false;
    await expect(
      runtime.callTool("lookup_item", { id: "a" }, context),
    ).rejects.toMatchObject({ code: "AUTH_FORBIDDEN" });

    authorized = true;
    allowed = false;
    await expect(
      runtime.callTool("lookup_item", { id: "a" }, context),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("partitions entries by tenant, principal, partition, and arguments", async () => {
    const execute = vi.fn(async (input) => input);
    const runtime = new InMemoryToolRuntime({ cache: cacheOptions() });
    runtime.register(cacheableTool(execute));

    await runtime.callTool("lookup_item", { id: "a" }, context);
    await runtime.callTool(
      "lookup_item",
      { id: "a" },
      { ...context, tenantId: "tenant-2" },
    );
    await runtime.callTool(
      "lookup_item",
      { id: "a" },
      { ...context, principal: { id: "user-2", scopes: ["read"] } },
    );
    await runtime.callTool(
      "lookup_item",
      { id: "a" },
      { ...context, principal: { id: "user-1", scopes: ["write"] } },
    );
    await runtime.callTool("lookup_item", { id: "b" }, context);
    expect(execute).toHaveBeenCalledTimes(5);

    // The original entry is still a hit and was not evicted by the others.
    await runtime.callTool("lookup_item", { id: "a" }, context);
    expect(execute).toHaveBeenCalledTimes(5);
  });

  it("keeps tenants isolated in multi-tenant mode", async () => {
    const tenantOne = vi.fn(async () => ({ tenant: "one" }));
    const tenantTwo = vi.fn(async () => ({ tenant: "two" }));
    const runtime = new InMemoryToolRuntime({
      tenantMode: "multi-tenant",
      authorizer: { authorize: () => {} },
      cache: cacheOptions(),
    });
    runtime.register(cacheableTool(tenantOne, { ownerTenantId: "tenant-1" }));
    runtime.register(cacheableTool(tenantTwo, { ownerTenantId: "tenant-2" }));

    await expect(
      runtime.callTool("lookup_item", { id: "a" }, context),
    ).resolves.toEqual({ tenant: "one" });
    await expect(
      runtime.callTool(
        "lookup_item",
        { id: "a" },
        { ...context, tenantId: "tenant-2" },
      ),
    ).resolves.toEqual({ tenant: "two" });
    expect(tenantOne).toHaveBeenCalledTimes(1);
    expect(tenantTwo).toHaveBeenCalledTimes(1);
  });

  it("bypasses caching when the partition is unavailable or ambiguous", async () => {
    const execute = vi.fn(async (input) => input);
    const bypassing = new InMemoryToolRuntime({
      cache: cacheOptions(new InMemoryCacheStore(), () => undefined),
    });
    bypassing.register(cacheableTool(execute));
    await bypassing.callTool("lookup_item", { id: "a" }, context);
    await bypassing.callTool("lookup_item", { id: "a" }, context);
    expect(execute).toHaveBeenCalledTimes(2);

    const failing = new InMemoryToolRuntime({
      cache: cacheOptions(new InMemoryCacheStore(), () => {
        throw new Error("partition unavailable");
      }),
    });
    failing.register(cacheableTool(execute));
    await expect(
      failing.callTool("lookup_item", { id: "a" }, context),
    ).resolves.toEqual({ id: "a" });
    await expect(
      failing.callTool("lookup_item", { id: "a" }, context),
    ).resolves.toEqual({ id: "a" });
    expect(execute).toHaveBeenCalledTimes(4);
  });

  it("bypasses caching for input that cannot be canonicalized", async () => {
    const execute = vi.fn(async (input) => input);
    const runtime = new InMemoryToolRuntime({ cache: cacheOptions() });
    runtime.register(
      cacheableTool(execute, {
        inputSchema: { type: "object", properties: { id: { type: "string" } } },
      }),
    );
    const input = { id: "a", callback: () => {} };

    await expect(runtime.callTool("lookup_item", input, context)).resolves.toBe(
      input,
    );
    await expect(runtime.callTool("lookup_item", input, context)).resolves.toBe(
      input,
    );
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("degrades cache read and write failures to a miss without failing the call", async () => {
    const store: CacheStore = {
      get: async () => {
        throw new Error("cache unavailable");
      },
      set: async () => {
        throw new Error("cache unavailable");
      },
      delete: async () => {},
    };
    const execute = vi.fn(async () => ({ value: "fresh" }));
    const runtime = new InMemoryToolRuntime({ cache: cacheOptions(store) });
    runtime.register(cacheableTool(execute));

    await expect(
      runtime.callTool("lookup_item", { id: "a" }, context),
    ).resolves.toEqual({ value: "fresh" });
    await expect(
      runtime.callTool("lookup_item", { id: "a" }, context),
    ).resolves.toEqual({ value: "fresh" });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("expires entries according to the tool TTL", async () => {
    let now = 0;
    const store = new InMemoryCacheStore({ monotonicNow: () => now });
    const execute = vi.fn(async (input) => input);
    const runtime = new InMemoryToolRuntime({ cache: cacheOptions(store) });
    runtime.register(cacheableTool(execute, { cache: { ttlSeconds: 60 } }));

    await runtime.callTool("lookup_item", { id: "a" }, context);
    await runtime.callTool("lookup_item", { id: "a" }, context);
    expect(execute).toHaveBeenCalledTimes(1);

    now = 60_000;
    await runtime.callTool("lookup_item", { id: "a" }, context);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("does not cache failures or undefined results", async () => {
    const failing = vi
      .fn<(..._args: unknown[]) => Promise<unknown>>()
      .mockRejectedValueOnce(new Error("upstream down"))
      .mockResolvedValueOnce({ value: "recovered" });
    const runtime = new InMemoryToolRuntime({ cache: cacheOptions() });
    runtime.register(cacheableTool(failing));

    await expect(
      runtime.callTool("lookup_item", { id: "a" }, context),
    ).rejects.toMatchObject({ code: "UPSTREAM_FAILURE" });
    await expect(
      runtime.callTool("lookup_item", { id: "a" }, context),
    ).resolves.toEqual({ value: "recovered" });
    expect(failing).toHaveBeenCalledTimes(2);

    const store = new InMemoryCacheStore();
    const setSpy = vi.spyOn(store, "set");
    const undefinedRuntime = new InMemoryToolRuntime({
      cache: cacheOptions(store),
    });
    const returnsUndefined = vi.fn(async () => undefined);
    undefinedRuntime.register(cacheableTool(returnsUndefined));
    await undefinedRuntime.callTool("lookup_item", { id: "a" }, context);
    await undefinedRuntime.callTool("lookup_item", { id: "a" }, context);
    expect(returnsUndefined).toHaveBeenCalledTimes(2);
    expect(setSpy).not.toHaveBeenCalled();
  });

  it("rejects a cached hit once the caller has aborted", async () => {
    const execute = vi.fn(async (input) => input);
    const runtime = new InMemoryToolRuntime({ cache: cacheOptions() });
    runtime.register(cacheableTool(execute));
    await runtime.callTool("lookup_item", { id: "a" }, context);

    const controller = new AbortController();
    controller.abort();
    await expect(
      runtime.callTool(
        "lookup_item",
        { id: "a" },
        { ...context, signal: controller.signal },
      ),
    ).rejects.toMatchObject({ code: "CANCELLED" });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid cache metadata at registration", () => {
    const invalid = [
      { cache: { ttlSeconds: 0 } },
      { cache: { ttlSeconds: -1 } },
      { cache: { ttlSeconds: Number.NaN } },
      { cache: {} },
      { cache: { ttlSeconds: 60 }, contractRevision: undefined },
      { cache: { ttlSeconds: 60 }, contractRevision: "   " },
      { contractRevision: "   " },
    ];
    for (const overrides of invalid) {
      const runtime = new InMemoryToolRuntime();
      expect(() =>
        runtime.register(
          cacheableTool(async (input) => input, overrides as never),
        ),
      ).toThrowError(expect.objectContaining({ code: "CONTRACT_INVALID" }));
    }
  });

  it("rejects invalid runtime cache configuration", () => {
    expect(
      () =>
        new InMemoryToolRuntime({
          cache: { store: {} as CacheStore, authorizationPartition: () => "x" },
        }),
    ).toThrowError(expect.objectContaining({ code: "CONFIG_INVALID" }));
    expect(
      () =>
        new InMemoryToolRuntime({
          cache: {
            store: new InMemoryCacheStore(),
            authorizationPartition: undefined as never,
          },
        }),
    ).toThrowError(expect.objectContaining({ code: "CONFIG_INVALID" }));
  });

  it("still reports authorization denials with the established error codes", async () => {
    const runtime = new InMemoryToolRuntime({
      authorizer: {
        authorize: () => {
          throw new RuntimeError("AUTH_FORBIDDEN", "Access denied");
        },
      },
      cache: cacheOptions(),
    });
    runtime.register(cacheableTool(async (input) => input));

    await expect(
      runtime.callTool("lookup_item", { id: "a" }, context),
    ).rejects.toMatchObject({ code: "AUTH_FORBIDDEN" });
  });
});

function metricsRecorder(): {
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

describe("cache observability", () => {
  it("labels a miss followed by a hit without changing the invocation outcome", async () => {
    const { events, metrics } = metricsRecorder();
    const runtime = new InMemoryToolRuntime({ cache: cacheOptions(), metrics });
    runtime.register(cacheableTool(vi.fn(async (input) => input)));

    await runtime.callTool("lookup_item", { id: "a" }, context);
    await runtime.callTool("lookup_item", { id: "a" }, context);

    expect(events.map((event) => event.cacheOutcome)).toEqual(["miss", "hit"]);
    expect(events.map((event) => event.outcome)).toEqual([
      "success",
      "success",
    ]);
    expect(
      events.filter((event) => event.cacheOutcome === "hit").length /
        events.filter((event) => event.cacheOutcome !== "bypass").length,
    ).toBe(0.5);
  });

  it("omits the cache outcome for tools that are not cache-eligible", async () => {
    const { events, metrics } = metricsRecorder();
    const runtime = new InMemoryToolRuntime({ cache: cacheOptions(), metrics });
    const tool = cacheableTool(vi.fn(async (input) => input));
    delete tool.cache;
    runtime.register(tool);

    await runtime.callTool("lookup_item", { id: "a" }, context);

    expect(events).toHaveLength(1);
    expect(events[0]).not.toHaveProperty("cacheOutcome");
  });

  it("reports bypass when the partition or store prevents a lookup", async () => {
    const bypassEvents = metricsRecorder();
    const bypassing = new InMemoryToolRuntime({
      cache: cacheOptions(new InMemoryCacheStore(), () => undefined),
      metrics: bypassEvents.metrics,
    });
    bypassing.register(cacheableTool(vi.fn(async (input) => input)));
    await bypassing.callTool("lookup_item", { id: "a" }, context);
    expect(bypassEvents.events[0]?.cacheOutcome).toBe("bypass");

    const failingEvents = metricsRecorder();
    const failing = new InMemoryToolRuntime({
      cache: cacheOptions({
        get: async () => {
          throw new Error("cache unavailable");
        },
        set: async () => {},
        delete: async () => {},
      }),
      metrics: failingEvents.metrics,
    });
    failing.register(cacheableTool(vi.fn(async (input) => input)));
    await failing.callTool("lookup_item", { id: "a" }, context);
    expect(failingEvents.events[0]?.cacheOutcome).toBe("bypass");
  });

  it("keeps the miss label when execution fails after a miss", async () => {
    const { events, metrics } = metricsRecorder();
    const runtime = new InMemoryToolRuntime({ cache: cacheOptions(), metrics });
    runtime.register(
      cacheableTool(async () => {
        throw new Error("upstream down");
      }),
    );

    await expect(
      runtime.callTool("lookup_item", { id: "a" }, context),
    ).rejects.toMatchObject({ code: "UPSTREAM_FAILURE" });

    expect(events[0]).toMatchObject({
      outcome: "error",
      cacheOutcome: "miss",
      errorCode: "UPSTREAM_FAILURE",
    });
  });

  it("does not relabel a miss when the cache write fails", async () => {
    const { events, metrics } = metricsRecorder();
    const runtime = new InMemoryToolRuntime({
      cache: cacheOptions({
        get: async () => undefined,
        set: async () => {
          throw new Error("write failed");
        },
        delete: async () => {},
      }),
      metrics,
    });
    runtime.register(cacheableTool(vi.fn(async (input) => input)));

    await expect(
      runtime.callTool("lookup_item", { id: "a" }, context),
    ).resolves.toEqual({ id: "a" });

    expect(events[0]).toMatchObject({
      outcome: "success",
      cacheOutcome: "miss",
    });
  });
});

describe("cache invalidation", () => {
  it("evicts the exact cached result so the next call executes", async () => {
    const execute = vi.fn(async (input) => input);
    const runtime = new InMemoryToolRuntime({ cache: cacheOptions() });
    runtime.register(cacheableTool(execute));

    await runtime.callTool("lookup_item", { id: "a" }, context);
    await runtime.invalidateCachedResult("lookup_item", { id: "a" }, context);
    await runtime.callTool("lookup_item", { id: "a" }, context);

    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("does not evict entries for other arguments, tenants, or partitions", async () => {
    const execute = vi.fn(async (input) => input);
    const runtime = new InMemoryToolRuntime({ cache: cacheOptions() });
    runtime.register(cacheableTool(execute));
    await runtime.callTool("lookup_item", { id: "a" }, context);

    await runtime.invalidateCachedResult("lookup_item", { id: "b" }, context);
    await runtime.invalidateCachedResult(
      "lookup_item",
      { id: "a" },
      {
        ...context,
        tenantId: "tenant-2",
      },
    );
    await runtime.invalidateCachedResult(
      "lookup_item",
      { id: "a" },
      {
        ...context,
        principal: { id: "user-1", scopes: ["write"] },
      },
    );
    await runtime.callTool("lookup_item", { id: "a" }, context);

    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when caching is unavailable or the tool is not eligible", async () => {
    const store = new InMemoryCacheStore();
    const deleteSpy = vi.spyOn(store, "delete");
    const runtime = new InMemoryToolRuntime({ cache: cacheOptions(store) });
    const uncached = cacheableTool(vi.fn(async (input) => input));
    delete uncached.cache;
    runtime.register(uncached);
    await runtime.invalidateCachedResult("lookup_item", { id: "a" }, context);
    expect(deleteSpy).not.toHaveBeenCalled();

    const noCache = new InMemoryToolRuntime();
    noCache.register(cacheableTool(vi.fn(async (input) => input)));
    await expect(
      noCache.invalidateCachedResult("lookup_item", { id: "a" }, context),
    ).resolves.toBeUndefined();

    const bypassing = new InMemoryToolRuntime({
      cache: cacheOptions(new InMemoryCacheStore(), () => undefined),
    });
    bypassing.register(cacheableTool(vi.fn(async (input) => input)));
    await expect(
      bypassing.invalidateCachedResult("lookup_item", { id: "a" }, context),
    ).resolves.toBeUndefined();
  });

  it("scopes invalidation to the caller tenant in multi-tenant mode", async () => {
    const runtime = new InMemoryToolRuntime({
      tenantMode: "multi-tenant",
      authorizer: { authorize: () => {} },
      cache: cacheOptions(),
    });
    runtime.register(
      cacheableTool(
        vi.fn(async (input) => input),
        {
          ownerTenantId: "tenant-1",
        },
      ),
    );

    await expect(
      runtime.invalidateCachedResult(
        "lookup_item",
        { id: "a" },
        {
          ...context,
          tenantId: "tenant-2",
        },
      ),
    ).rejects.toMatchObject({ code: "TOOL_NOT_FOUND" });
    await expect(
      runtime.invalidateCachedResult("missing", { id: "a" }, context),
    ).rejects.toMatchObject({ code: "TOOL_NOT_FOUND" });
  });

  it("does not run authorization and propagates store deletion failures", async () => {
    const authorize = vi.fn();
    const store = {
      get: async () => undefined,
      set: async () => {},
      delete: async () => {
        throw new Error("delete failed");
      },
    };
    const runtime = new InMemoryToolRuntime({
      authorizer: { authorize },
      cache: cacheOptions(store),
    });
    runtime.register(cacheableTool(vi.fn(async (input) => input)));

    await expect(
      runtime.invalidateCachedResult("lookup_item", { id: "a" }, context),
    ).rejects.toThrow("delete failed");
    expect(authorize).not.toHaveBeenCalled();

    const bypassOnDelete = new InMemoryToolRuntime({
      cache: cacheOptions(store, () => undefined),
    });
    bypassOnDelete.register(cacheableTool(vi.fn(async (input) => input)));
    await expect(
      bypassOnDelete.invalidateCachedResult(
        "lookup_item",
        { id: "a" },
        context,
      ),
    ).resolves.toBeUndefined();
  });

  it("denies cross-tenant invalidation in a pinned single-tenant runtime", async () => {
    const runtime = new InMemoryToolRuntime({
      tenantId: "tenant-1",
      cache: cacheOptions(),
    });
    runtime.register(cacheableTool(vi.fn(async (input) => input)));

    await expect(
      runtime.invalidateCachedResult(
        "lookup_item",
        { id: "a" },
        {
          ...context,
          tenantId: "tenant-2",
        },
      ),
    ).rejects.toMatchObject({ code: "AUTH_FORBIDDEN" });
  });
});

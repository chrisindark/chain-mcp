import { describe, expect, it, vi } from "vitest";
import {
  createCacheKey,
  InMemoryToolRuntime,
  type ToolContext,
  type ToolDefinition,
} from "./index.js";

const context: ToolContext = {
  requestId: "req-1",
  tenantId: "tenant-1",
  principal: { id: "user-1", scopes: ["read"] },
};

function tool(
  execute: ToolDefinition["execute"] = async (input) => input,
): ToolDefinition {
  return {
    name: "lookup_item",
    description: "Look up a test item",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" }, count: { type: "integer" } },
      additionalProperties: false,
    },
    operation: { requiredScopes: ["read"] },
    execute,
  };
}

describe("InMemoryToolRuntime", () => {
  it("registers and discovers tools", () => {
    const runtime = new InMemoryToolRuntime();
    runtime.register(tool());
    expect(runtime.listTools().map(({ name }) => name)).toEqual([
      "lookup_item",
    ]);
  });

  it("rejects duplicate names and unknown tools with stable codes", async () => {
    const runtime = new InMemoryToolRuntime();
    runtime.register(tool());
    expect(() => runtime.register(tool())).toThrowError(
      expect.objectContaining({ code: "TOOL_ALREADY_REGISTERED" }),
    );
    await expect(
      runtime.callTool("missing", {}, context),
    ).rejects.toMatchObject({ code: "TOOL_NOT_FOUND" });
  });

  it("validates input before executing", async () => {
    const execute = vi.fn(async (input: unknown) => input);
    const runtime = new InMemoryToolRuntime();
    runtime.register(tool(execute));
    await expect(
      runtime.callTool("lookup_item", { id: 3 }, context),
    ).rejects.toMatchObject({
      code: "INPUT_INVALID",
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("runs authorization and rate-limit hooks and emits metrics", async () => {
    const authorize = vi.fn();
    const check = vi.fn();
    const record = vi.fn();
    const runtime = new InMemoryToolRuntime({
      authorizer: { authorize },
      rateLimiter: { check },
      metrics: { record },
    });
    runtime.register(tool());
    await expect(
      runtime.callTool("lookup_item", { id: "x" }, context),
    ).resolves.toEqual({ id: "x" });
    expect(authorize).toHaveBeenCalledOnce();
    expect(check).toHaveBeenCalledOnce();
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "success", tenantId: "tenant-1" }),
    );
  });

  it("does not execute a tool when authorization rejects it", async () => {
    const execute = vi.fn(async () => "should not run");
    const runtime = new InMemoryToolRuntime({
      authorizer: {
        authorize: () => {
          throw new Error("private authorization detail");
        },
      },
    });
    runtime.register(tool(execute));
    await expect(
      runtime.callTool("lookup_item", { id: "x" }, context),
    ).rejects.toMatchObject({
      code: "UPSTREAM_FAILURE",
      message: "Tool 'lookup_item' failed",
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("enforces execution timeouts and propagates cancellation", async () => {
    const runtime = new InMemoryToolRuntime({ defaultTimeoutMs: 5 });
    runtime.register(
      tool(
        (_input, executionContext) =>
          new Promise((_resolve, reject) => {
            executionContext.signal?.addEventListener(
              "abort",
              () => reject(new Error("aborted")),
              { once: true },
            );
          }),
      ),
    );
    await expect(
      runtime.callTool("lookup_item", { id: "x" }, context),
    ).rejects.toMatchObject({
      code: "UPSTREAM_TIMEOUT",
    });

    const controller = new AbortController();
    controller.abort();
    const cancelled = new InMemoryToolRuntime();
    cancelled.register(
      tool((_input, executionContext) =>
        Promise.reject(executionContext.signal?.reason),
      ),
    );
    await expect(
      cancelled.callTool(
        "lookup_item",
        { id: "x" },
        { ...context, signal: controller.signal },
      ),
    ).rejects.toBeDefined();

    const pendingController = new AbortController();
    const ignoresAbort = new InMemoryToolRuntime();
    ignoresAbort.register(tool(() => new Promise(() => {})));
    const pendingCall = ignoresAbort.callTool(
      "lookup_item",
      { id: "x" },
      {
        ...context,
        signal: pendingController.signal,
      },
    );
    pendingController.abort();
    await expect(pendingCall).rejects.toMatchObject({ code: "CANCELLED" });
  });
});

describe("cache key serialization", () => {
  it("canonicalizes object key order and partitions by identity and revision", () => {
    const base = {
      tenantId: "t",
      principalId: "p",
      contractRevision: "r1",
      toolName: "x",
      arguments: { b: 2, a: 1 },
    };
    expect(createCacheKey(base)).toBe(
      createCacheKey({ ...base, arguments: { a: 1, b: 2 } }),
    );
    expect(createCacheKey(base)).not.toBe(
      createCacheKey({ ...base, tenantId: "other" }),
    );
  });

  it("rejects values that cannot be deterministically represented", () => {
    expect(() =>
      createCacheKey({
        tenantId: "t",
        principalId: "p",
        contractRevision: "r",
        toolName: "x",
        arguments: 1n,
      }),
    ).toThrow("JSON-compatible");
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() =>
      createCacheKey({
        tenantId: "t",
        principalId: "p",
        contractRevision: "r",
        toolName: "x",
        arguments: cyclic,
      }),
    ).toThrow("cycles");
  });
});

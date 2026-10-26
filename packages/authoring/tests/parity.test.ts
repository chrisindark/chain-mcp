import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  InMemoryToolRuntime,
  RuntimeError,
  type Authorizer,
  type CacheStore,
  type RateLimiter,
  type ToolContext,
  type ToolDefinition,
} from "@chainmcp/core";
import { defineTool } from "../src/index.js";

const commonInputSchema = {
  type: "object",
  required: ["query"],
  properties: {
    query: { type: "string", minLength: 2 },
  },
  additionalProperties: false,
} as const;

function createManualTool(
  execute: (
    input: { query: string },
    context: ToolContext,
  ) => Promise<unknown> = async (i) => ({ result: i.query }),
  overrides?: Partial<Parameters<typeof defineTool>[0]>,
): ToolDefinition {
  return defineTool({
    name: "manual_search",
    description: "Manual search tool",
    schema: z.object({
      query: z.string().min(2),
    }),
    execute,
    ...overrides,
  });
}

function createCompiledTool(
  execute: (input: unknown, context: ToolContext) => Promise<unknown> = async (
    i,
  ) => ({ result: (i as { query?: string })?.query }),
  overrides?: Partial<ToolDefinition>,
): ToolDefinition {
  return {
    name: "compiled_search",
    description: "Compiled search tool",
    inputSchema: commonInputSchema,
    operation: {},
    execute,
    ...overrides,
  };
}

describe("Policy Parity between Manual and Compiled Tools", () => {
  const callerContext: ToolContext = {
    requestId: "req-1",
    tenantId: "tenant-main",
    principal: { id: "user-1", scopes: ["read:data"] },
  };

  it("enforces identical input validation and rejection", async () => {
    const runtime = new InMemoryToolRuntime();
    runtime.register(createManualTool());
    runtime.register(createCompiledTool());

    // Both succeed with valid input
    await expect(
      runtime.callTool("manual_search", { query: "valid" }, callerContext),
    ).resolves.toEqual({ result: "valid" });
    await expect(
      runtime.callTool("compiled_search", { query: "valid" }, callerContext),
    ).resolves.toEqual({ result: "valid" });

    // Both fail with too short query (< minLength 2)
    const manualShortErr = (await runtime
      .callTool("manual_search", { query: "a" }, callerContext)
      .catch((e: unknown) => e)) as RuntimeError;
    const compiledShortErr = (await runtime
      .callTool("compiled_search", { query: "a" }, callerContext)
      .catch((e: unknown) => e)) as RuntimeError;

    expect(manualShortErr).toBeInstanceOf(RuntimeError);
    expect(compiledShortErr).toBeInstanceOf(RuntimeError);
    expect(manualShortErr.code).toBe("INPUT_INVALID");
    expect(compiledShortErr.code).toBe("INPUT_INVALID");

    // Both fail with unrecognized property (additionalProperties: false)
    const manualExtraErr = (await runtime
      .callTool("manual_search", { query: "valid", extra: 123 }, callerContext)
      .catch((e: unknown) => e)) as RuntimeError;
    const compiledExtraErr = (await runtime
      .callTool(
        "compiled_search",
        { query: "valid", extra: 123 },
        callerContext,
      )
      .catch((e: unknown) => e)) as RuntimeError;

    expect(manualExtraErr.code).toBe("INPUT_INVALID");
    expect(compiledExtraErr.code).toBe("INPUT_INVALID");
  });

  it("enforces identical authorization policy checks", async () => {
    const authorizer: Authorizer = {
      authorize: vi.fn(async (tool, ctx) => {
        const required = tool.operation.requiredScopes ?? [];
        for (const req of required) {
          if (!ctx.principal.scopes.includes(req)) {
            throw new RuntimeError("AUTH_FORBIDDEN", "Forbidden scope");
          }
        }
      }),
    };

    const runtime = new InMemoryToolRuntime({ authorizer });
    runtime.register(
      createManualTool(undefined, {
        operation: { requiredScopes: ["admin:write"] },
      }),
    );
    runtime.register(
      createCompiledTool(undefined, {
        operation: { requiredScopes: ["admin:write"] },
      }),
    );

    // Caller with "read:data" scope gets AUTH_FORBIDDEN on both
    const manualAuthErr = (await runtime
      .callTool("manual_search", { query: "test" }, callerContext)
      .catch((e: unknown) => e)) as RuntimeError;
    const compiledAuthErr = (await runtime
      .callTool("compiled_search", { query: "test" }, callerContext)
      .catch((e: unknown) => e)) as RuntimeError;

    expect(manualAuthErr.code).toBe("AUTH_FORBIDDEN");
    expect(compiledAuthErr.code).toBe("AUTH_FORBIDDEN");

    // Caller with "admin:write" succeeds on both
    const adminContext: ToolContext = {
      ...callerContext,
      principal: { id: "admin", scopes: ["admin:write"] },
    };

    await expect(
      runtime.callTool("manual_search", { query: "test" }, adminContext),
    ).resolves.toEqual({ result: "test" });
    await expect(
      runtime.callTool("compiled_search", { query: "test" }, adminContext),
    ).resolves.toEqual({ result: "test" });
  });

  it("enforces identical rate limiting decisions", async () => {
    let allowed = true;
    const rateLimiter: RateLimiter = {
      check: vi.fn(async () => ({
        allowed,
        ...(allowed ? {} : { retryAfterSeconds: 30 }),
      })),
      release: vi.fn(),
    };

    const runtime = new InMemoryToolRuntime({ rateLimiter });
    runtime.register(createManualTool());
    runtime.register(createCompiledTool());

    // Both succeed when allowed
    await runtime.callTool("manual_search", { query: "ok" }, callerContext);
    await runtime.callTool("compiled_search", { query: "ok" }, callerContext);
    expect(rateLimiter.release).toHaveBeenCalledTimes(2);

    // Both get denied when quota exceeded
    allowed = false;
    const manualLimitErr = (await runtime
      .callTool("manual_search", { query: "ok" }, callerContext)
      .catch((e: unknown) => e)) as RuntimeError;
    const compiledLimitErr = (await runtime
      .callTool("compiled_search", { query: "ok" }, callerContext)
      .catch((e: unknown) => e)) as RuntimeError;

    expect(manualLimitErr.code).toBe("RATE_LIMITED");
    expect(manualLimitErr.retryAfterSeconds).toBe(30);
    expect(compiledLimitErr.code).toBe("RATE_LIMITED");
    expect(compiledLimitErr.retryAfterSeconds).toBe(30);
  });

  it("enforces identical timeout and cancellation handling", async () => {
    const manualTool = createManualTool(
      async (_input, ctx) => {
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve({ done: true }), 100);
          ctx.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new RuntimeError("CANCELLED", "Operation aborted"));
          });
        });
      },
      { timeoutMs: 20 },
    );

    const compiledTool = createCompiledTool(
      async (_input, ctx) => {
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve({ done: true }), 100);
          ctx.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new RuntimeError("CANCELLED", "Operation aborted"));
          });
        });
      },
      { timeoutMs: 20 },
    );

    const runtime = new InMemoryToolRuntime();
    runtime.register(manualTool);
    runtime.register(compiledTool);

    const manualTimeoutErr = (await runtime
      .callTool("manual_search", { query: "test" }, callerContext)
      .catch((e: unknown) => e)) as RuntimeError;
    const compiledTimeoutErr = (await runtime
      .callTool("compiled_search", { query: "test" }, callerContext)
      .catch((e: unknown) => e)) as RuntimeError;

    expect(manualTimeoutErr.code).toBe("UPSTREAM_TIMEOUT");
    expect(compiledTimeoutErr.code).toBe("UPSTREAM_TIMEOUT");
  });

  it("enforces identical output projection", async () => {
    const projector = {
      project: vi.fn(({ result }: { result: unknown }) => ({
        sanitized: true,
        original: result,
      })),
    };

    const runtime = new InMemoryToolRuntime({ projector });
    runtime.register(
      createManualTool(async () => ({ secret: "hidden", visible: "shown" }), {
        output: {},
      }),
    );
    runtime.register(
      createCompiledTool(async () => ({ secret: "hidden", visible: "shown" }), {
        output: {},
      }),
    );

    const manualResult = await runtime.callTool(
      "manual_search",
      { query: "hello" },
      callerContext,
    );
    const compiledResult = await runtime.callTool(
      "compiled_search",
      { query: "hello" },
      callerContext,
    );

    expect(manualResult).toEqual({
      sanitized: true,
      original: { secret: "hidden", visible: "shown" },
    });
    expect(compiledResult).toEqual({
      sanitized: true,
      original: { secret: "hidden", visible: "shown" },
    });
  });

  it("enforces identical result caching and hit behavior", async () => {
    const memory = new Map<string, unknown>();
    const store: CacheStore = {
      get: async <T>(key: string): Promise<T | undefined> =>
        memory.get(key) as T | undefined,
      set: async (key: string, val: unknown) => {
        memory.set(key, val);
      },
      delete: async (key: string) => {
        memory.delete(key);
      },
    };

    const metrics = vi.fn();
    const runtime = new InMemoryToolRuntime({
      cache: {
        store,
        authorizationPartition: (ctx) => ctx.principal.id,
      },
      metrics: { record: metrics },
    });

    const manualExec = vi.fn(async () => ({ time: Date.now() }));
    const compiledExec = vi.fn(async () => ({ time: Date.now() }));

    runtime.register(
      createManualTool(manualExec, {
        cache: { ttlSeconds: 60 },
        contractRevision: "rev-1",
      }),
    );
    runtime.register(
      createCompiledTool(compiledExec, {
        cache: { ttlSeconds: 60 },
        contractRevision: "rev-1",
      }),
    );

    // Call 1: Miss & Execute for both
    const mRes1 = await runtime.callTool(
      "manual_search",
      { query: "cats" },
      callerContext,
    );
    const cRes1 = await runtime.callTool(
      "compiled_search",
      { query: "cats" },
      callerContext,
    );
    expect(manualExec).toHaveBeenCalledTimes(1);
    expect(compiledExec).toHaveBeenCalledTimes(1);

    // Call 2: Cache Hit for both
    const mRes2 = await runtime.callTool(
      "manual_search",
      { query: "cats" },
      callerContext,
    );
    const cRes2 = await runtime.callTool(
      "compiled_search",
      { query: "cats" },
      callerContext,
    );
    expect(manualExec).toHaveBeenCalledTimes(1); // not called again
    expect(compiledExec).toHaveBeenCalledTimes(1); // not called again
    expect(mRes2).toEqual(mRes1);
    expect(cRes2).toEqual(cRes1);
  });

  it("enforces identical safe error concealing without leaking internal details", async () => {
    const runtime = new InMemoryToolRuntime();
    runtime.register(
      createManualTool(async () => {
        throw new Error(
          "Secret DB password postgres://admin:secret@db.internal failed",
        );
      }),
    );
    runtime.register(
      createCompiledTool(async () => {
        throw new Error("Secret Upstream API key 12345 exploded");
      }),
    );

    const manualErr = (await runtime
      .callTool("manual_search", { query: "safe" }, callerContext)
      .catch((e: unknown) => e)) as RuntimeError;
    const compiledErr = (await runtime
      .callTool("compiled_search", { query: "safe" }, callerContext)
      .catch((e: unknown) => e)) as RuntimeError;

    expect(manualErr).toBeInstanceOf(RuntimeError);
    expect(compiledErr).toBeInstanceOf(RuntimeError);

    expect(manualErr.code).toBe("UPSTREAM_FAILURE");
    expect(compiledErr.code).toBe("UPSTREAM_FAILURE");

    // Internal messages must NOT leak to the client error message
    expect(manualErr.message).not.toContain("Secret DB password");
    expect(compiledErr.message).not.toContain("Secret Upstream API key");
    expect(manualErr.message).toBe("Tool 'manual_search' failed");
    expect(compiledErr.message).toBe("Tool 'compiled_search' failed");

    // Both preserve internal cause for diagnostic logging
    expect(manualErr.cause).toBeDefined();
    expect(compiledErr.cause).toBeDefined();
  });
});

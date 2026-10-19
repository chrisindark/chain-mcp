import { describe, expect, it, vi } from "vitest";
import {
  auditInputSchema,
  CACHE_KEY_VERSION,
  createCacheKey,
  InMemoryToolRuntime,
  MAX_CACHE_KEY_INPUT_BYTES,
  MAX_SCHEMA_DEPTH,
  RuntimeError,
  type ToolContext,
  type ToolDefinition,
} from "../src/index.js";

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

function toolWithSchema(
  inputSchema: ToolDefinition["inputSchema"],
  execute: ToolDefinition["execute"] = async (input) => input,
): ToolDefinition {
  return { ...tool(execute), inputSchema };
}

function expectContractInvalid(schema: unknown): void {
  const runtime = new InMemoryToolRuntime();
  expect(() =>
    runtime.register(toolWithSchema(schema as ToolDefinition["inputSchema"])),
  ).toThrowError(expect.objectContaining({ code: "CONTRACT_INVALID" }));
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

  it("validates array-valued type declarations", async () => {
    const runtime = new InMemoryToolRuntime();
    runtime.register(
      toolWithSchema({
        type: "object",
        required: ["value"],
        properties: { value: { type: ["string", "null"] } },
        additionalProperties: false,
      }),
    );

    await expect(
      runtime.callTool("lookup_item", { value: "x" }, context),
    ).resolves.toEqual({ value: "x" });
    await expect(
      runtime.callTool("lookup_item", { value: null }, context),
    ).resolves.toEqual({ value: null });
    await expect(
      runtime.callTool("lookup_item", { value: 1 }, context),
    ).rejects.toMatchObject({ code: "INPUT_INVALID" });
  });

  it("enforces object keywords when type is omitted", async () => {
    const runtime = new InMemoryToolRuntime();
    runtime.register(
      toolWithSchema({
        required: ["id"],
        properties: { id: { type: "string" } },
        additionalProperties: false,
      }),
    );

    await expect(
      runtime.callTool("lookup_item", { id: "x" }, context),
    ).resolves.toEqual({ id: "x" });
    await expect(
      runtime.callTool("lookup_item", {}, context),
    ).rejects.toMatchObject({ code: "INPUT_INVALID" });
    await expect(
      runtime.callTool("lookup_item", { id: 3 }, context),
    ).rejects.toMatchObject({ code: "INPUT_INVALID" });
    await expect(
      runtime.callTool("lookup_item", { id: "x", extra: true }, context),
    ).rejects.toMatchObject({ code: "INPUT_INVALID" });
  });

  it("enforces enum values and additionalProperties: false", async () => {
    const runtime = new InMemoryToolRuntime();
    runtime.register(
      toolWithSchema({
        type: "object",
        required: ["mode"],
        properties: {
          mode: { type: "string", enum: ["read", "write"] },
          id: { type: "string" },
        },
        additionalProperties: false,
      }),
    );

    await expect(
      runtime.callTool("lookup_item", { mode: "read" }, context),
    ).resolves.toEqual({ mode: "read" });
    await expect(
      runtime.callTool("lookup_item", { mode: "delete" }, context),
    ).rejects.toMatchObject({ code: "INPUT_INVALID" });
    await expect(
      runtime.callTool("lookup_item", { mode: "read", extra: true }, context),
    ).rejects.toMatchObject({ code: "INPUT_INVALID" });
  });

  it("reports nested object validation failures", async () => {
    const execute = vi.fn(async (input: unknown) => input);
    const runtime = new InMemoryToolRuntime();
    runtime.register(
      toolWithSchema(
        {
          type: "object",
          required: ["filter"],
          properties: {
            filter: {
              type: "object",
              required: ["name"],
              properties: {
                name: { type: "string" },
                limit: { type: "integer" },
              },
              additionalProperties: false,
            },
          },
          additionalProperties: false,
        },
        execute,
      ),
    );

    await expect(
      runtime.callTool("lookup_item", { filter: { name: 3 } }, context),
    ).rejects.toMatchObject({
      code: "INPUT_INVALID",
      message: expect.stringContaining("$.filter.name must be string"),
    });
    await expect(
      runtime.callTool("lookup_item", { filter: {} }, context),
    ).rejects.toMatchObject({
      code: "INPUT_INVALID",
      message: expect.stringContaining("$.filter.name is required"),
    });
    await expect(
      runtime.callTool(
        "lookup_item",
        { filter: { name: "x", extra: true } },
        context,
      ),
    ).rejects.toMatchObject({
      code: "INPUT_INVALID",
      message: expect.stringContaining("$.filter.extra is not allowed"),
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("enforces array items when type is omitted", async () => {
    const runtime = new InMemoryToolRuntime();
    runtime.register(toolWithSchema({ items: { type: "integer" } }));

    await expect(
      runtime.callTool("lookup_item", [1, 2], context),
    ).resolves.toEqual([1, 2]);
    await expect(
      runtime.callTool("lookup_item", [1, "2"], context),
    ).rejects.toMatchObject({ code: "INPUT_INVALID" });
  });

  it("rejects empty, malformed, or unknown type declarations at registration", () => {
    for (const type of [[], 42, "unsupported"]) {
      expectContractInvalid({ type });
    }
  });

  it.each<[string, ToolDefinition["inputSchema"]]>([
    ["$ref", { $ref: "#/definitions/item" }],
    ["anyOf", { anyOf: [{ type: "string" }] }],
    ["oneOf", { oneOf: [{ type: "string" }] }],
    ["allOf", { allOf: [{ type: "string" }] }],
    ["const", { const: "fixed" }],
    ["not", { not: { type: "string" } }],
    ["minimum", { type: "number", minimum: 0 }],
    ["maximum", { type: "number", maximum: 10 }],
    ["exclusiveMinimum", { type: "number", exclusiveMinimum: 0 }],
    ["exclusiveMaximum", { type: "number", exclusiveMaximum: 10 }],
    ["multipleOf", { type: "number", multipleOf: 2 }],
    ["minLength", { type: "string", minLength: 1 }],
    ["maxLength", { type: "string", maxLength: 10 }],
    ["pattern", { type: "string", pattern: "^a" }],
    ["format", { type: "string", format: "email" }],
    ["minItems", { type: "array", minItems: 1 }],
    ["maxItems", { type: "array", maxItems: 10 }],
    ["uniqueItems", { type: "array", uniqueItems: true }],
    ["contains", { type: "array", contains: { type: "string" } }],
    ["patternProperties", { type: "object", patternProperties: {} }],
    ["propertyNames", { type: "object", propertyNames: { type: "string" } }],
    ["if", { if: { type: "string" }, then: { const: "x" } }],
    ["nullable", { type: "string", nullable: true }],
    ["$schema", { $schema: "https://json-schema.org/draft/2020-12/schema" }],
  ])(
    "rejects unsupported schema keyword %s at registration",
    (_keyword, schema) => {
      expectContractInvalid(schema);
    },
  );

  it.each<[string, unknown]>([
    ["boolean root schema", false],
    ["boolean items", { type: "array", items: false }],
    ["tuple items", { type: "array", items: [{ type: "string" }] }],
    [
      "object-valued additionalProperties",
      { type: "object", additionalProperties: { type: "string" } },
    ],
    ["empty enum", { enum: [] }],
    ["object enum entry", { enum: [{ value: 1 }] }],
    ["non-array required", { required: "id" }],
    ["non-object properties", { properties: [] }],
  ])("rejects unsupported schema form %s at registration", (_form, schema) => {
    expectContractInvalid(schema);
  });

  it("rejects cyclic schemas at registration", () => {
    const cyclic: Record<string, unknown> = { type: "object" };
    cyclic.properties = { self: cyclic };
    expectContractInvalid(cyclic);
  });

  it("rejects schemas beyond the maximum nesting depth", () => {
    let schema: ToolDefinition["inputSchema"] = { type: "string" };
    for (let depth = 0; depth < 33; depth += 1) {
      schema = { type: "object", properties: { nested: schema } };
    }
    expectContractInvalid(schema);
  });

  it("accepts supported annotation keywords", () => {
    const runtime = new InMemoryToolRuntime();
    runtime.register(
      toolWithSchema({
        title: "Item",
        description: "An item",
        default: {},
        examples: [{}],
        deprecated: false,
        readOnly: false,
        writeOnly: false,
        $comment: "annotation",
        type: "object",
      }),
    );
  });

  it("passes unknown keys to the tool when additionalProperties is not false", async () => {
    const execute = vi.fn(async (input: unknown) => input);
    const runtime = new InMemoryToolRuntime();
    runtime.register(
      toolWithSchema(
        { type: "object", properties: { id: { type: "string" } } },
        execute,
      ),
    );
    const input = { id: "x", extra: { nested: true } };
    await expect(runtime.callTool("lookup_item", input, context)).resolves.toBe(
      input,
    );
    expect(execute).toHaveBeenCalledWith(input, expect.anything());
  });

  it("runs authorization and rate-limit hooks and emits metrics", async () => {
    const authorize = vi.fn();
    const check = vi.fn(() => ({ allowed: true }));
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

  it("runs authorization, validation, rate limiting, and execution in order", async () => {
    const calls: string[] = [];
    const execute = vi.fn(async () => {
      calls.push("execute");
      return "ok";
    });
    const runtime = new InMemoryToolRuntime({
      authorizer: {
        authorize: () => {
          calls.push("authorize");
        },
      },
      rateLimiter: {
        check: async () => {
          calls.push("rate-limit");
          return { allowed: true };
        },
      },
    });
    runtime.register(tool(execute));

    await expect(
      runtime.callTool("lookup_item", { id: "x" }, context),
    ).resolves.toBe("ok");
    expect(calls).toEqual(["authorize", "rate-limit", "execute"]);

    calls.length = 0;
    const invalidExecute = vi.fn(async () => "should not run");
    const invalidRuntime = new InMemoryToolRuntime({
      authorizer: {
        authorize: () => {
          calls.push("authorize");
        },
      },
      rateLimiter: {
        check: async () => {
          calls.push("rate-limit");
          return { allowed: true };
        },
      },
    });
    invalidRuntime.register(tool(invalidExecute));

    await expect(
      invalidRuntime.callTool("lookup_item", { id: 3 }, context),
    ).rejects.toMatchObject({ code: "INPUT_INVALID" });
    expect(calls).toEqual(["authorize"]);
    expect(invalidExecute).not.toHaveBeenCalled();
  });

  it("maps only an explicit rate-limit denial to the rate_limited outcome", async () => {
    const execute = vi.fn(async () => "should not run");
    const record = vi.fn();
    const runtime = new InMemoryToolRuntime({
      rateLimiter: {
        check: () => ({ allowed: false }),
      },
      metrics: { record },
    });
    runtime.register(tool(execute));

    await expect(
      runtime.callTool("lookup_item", { id: "x" }, context),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(execute).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "rate_limited",
        errorCode: "RATE_LIMITED",
        toolName: "lookup_item",
      }),
    );
  });

  it("classifies limiter failures as errors rather than rate limiting", async () => {
    const record = vi.fn();
    const cause = new Error("redis unavailable");
    const runtime = new InMemoryToolRuntime({
      rateLimiter: {
        check: () => {
          throw cause;
        },
      },
      metrics: { record },
    });
    runtime.register(tool());

    const error = await runtime
      .callTool("lookup_item", { id: "x" }, context)
      .then(
        () => {
          throw new Error("expected the call to reject");
        },
        (caught: unknown) => caught,
      );

    expect(error).toMatchObject({
      code: "UPSTREAM_FAILURE",
      message: "Rate limiter for tool 'lookup_item' failed",
      cause,
    });
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "error",
        errorCode: "UPSTREAM_FAILURE",
      }),
    );
  });

  it("fails closed when a rate limiter returns no decision", async () => {
    const execute = vi.fn(async () => "should not run");
    const record = vi.fn();
    const runtime = new InMemoryToolRuntime({
      rateLimiter: {
        // Simulates an adapter written against the former void contract.
        check: () => undefined as unknown as { allowed: boolean },
      },
      metrics: { record },
    });
    runtime.register(tool(execute));

    await expect(
      runtime.callTool("lookup_item", { id: "x" }, context),
    ).rejects.toMatchObject({
      code: "UPSTREAM_FAILURE",
      message:
        "Rate limiter for tool 'lookup_item' returned an invalid decision",
    });
    expect(execute).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "error",
        errorCode: "UPSTREAM_FAILURE",
      }),
    );
  });

  it("does not trust a RATE_LIMITED thrown by a limiter as a denial", async () => {
    const record = vi.fn();
    const runtime = new InMemoryToolRuntime({
      rateLimiter: {
        check: () => {
          throw new RuntimeError("RATE_LIMITED", "redis script failed");
        },
      },
      metrics: { record },
    });
    runtime.register(tool());

    await expect(
      runtime.callTool("lookup_item", { id: "x" }, context),
    ).rejects.toMatchObject({
      code: "UPSTREAM_FAILURE",
      message: "Rate limiter for tool 'lookup_item' failed",
    });
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "error",
        errorCode: "UPSTREAM_FAILURE",
      }),
    );
  });

  it("classifies upstream rate limits as errors with a RATE_LIMITED code", async () => {
    const record = vi.fn();
    const runtime = new InMemoryToolRuntime({
      rateLimiter: { check: () => ({ allowed: true }) },
      metrics: { record },
    });
    runtime.register(
      tool(async () => {
        throw new RuntimeError("RATE_LIMITED", "upstream throttled the call");
      }),
    );

    await expect(
      runtime.callTool("lookup_item", { id: "x" }, context),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "error",
        errorCode: "RATE_LIMITED",
      }),
    );
  });

  it("ignores metrics sinks that throw or reject", async () => {
    const throwing = new InMemoryToolRuntime({
      metrics: {
        record: () => {
          throw new Error("metrics unavailable");
        },
      },
    });
    throwing.register(tool(async (input) => input));
    await expect(
      throwing.callTool("lookup_item", { id: "x" }, context),
    ).resolves.toEqual({ id: "x" });

    const rejecting = new InMemoryToolRuntime({
      metrics: {
        record: () => Promise.reject(new Error("metrics unavailable")),
      },
    });
    rejecting.register(tool(async (input) => input));
    await expect(
      rejecting.callTool("lookup_item", { id: "x" }, context),
    ).resolves.toEqual({ id: "x" });
    await Promise.resolve();
  });

  it("maps untyped authorization failures to AUTH_FORBIDDEN", async () => {
    const execute = vi.fn(async () => "should not run");
    const record = vi.fn();
    const cause = new Error("private authorization detail");
    const runtime = new InMemoryToolRuntime({
      authorizer: {
        authorize: () => {
          throw cause;
        },
      },
      metrics: { record },
    });
    runtime.register(tool(execute));

    const error = await runtime
      .callTool("lookup_item", { id: "x" }, context)
      .then(
        () => {
          throw new Error("expected the call to reject");
        },
        (caught: unknown) => caught,
      );

    expect(error).toMatchObject({
      code: "AUTH_FORBIDDEN",
      message: "Access denied",
      cause,
    });
    expect(execute).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "error",
        errorCode: "AUTH_FORBIDDEN",
        toolName: "lookup_item",
      }),
    );
  });

  it("preserves typed authorization adapter failures", async () => {
    const record = vi.fn();
    const runtime = new InMemoryToolRuntime({
      authorizer: {
        authorize: () => {
          throw new RuntimeError(
            "UPSTREAM_FAILURE",
            "identity provider unavailable",
          );
        },
      },
      metrics: { record },
    });
    runtime.register(tool());

    await expect(
      runtime.callTool("lookup_item", { id: "x" }, context),
    ).rejects.toMatchObject({
      code: "UPSTREAM_FAILURE",
      message: "identity provider unavailable",
    });
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "error",
        errorCode: "UPSTREAM_FAILURE",
      }),
    );
  });

  it("authorizes before validating so unauthorized callers cannot probe schemas", async () => {
    const authorize = vi.fn(() => {
      throw new RuntimeError("AUTH_FORBIDDEN", "Access denied");
    });
    const execute = vi.fn(async () => "should not run");
    const runtime = new InMemoryToolRuntime({ authorizer: { authorize } });
    runtime.register(tool(execute));

    // This input fails validation (id must be a string). If validation ran
    // first, the caller would receive INPUT_INVALID and learn the schema.
    await expect(
      runtime.callTool("lookup_item", { id: 3 }, context),
    ).rejects.toMatchObject({
      code: "AUTH_FORBIDDEN",
      message: "Access denied",
    });

    expect(authorize).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects on timeout and aborts the execution signal", async () => {
    const runtime = new InMemoryToolRuntime({ defaultTimeoutMs: 5 });
    let executionSignal: AbortSignal | undefined;
    runtime.register(
      tool(
        (_input, executionContext) =>
          new Promise((_resolve, reject) => {
            executionSignal = executionContext.signal;
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
    expect(executionSignal?.aborted).toBe(true);
  });

  it("uses a per-tool timeoutMs override", async () => {
    const runtime = new InMemoryToolRuntime({ defaultTimeoutMs: 1_000 });
    runtime.register({
      ...tool(() => new Promise(() => {})),
      timeoutMs: 5,
    });

    await expect(
      runtime.callTool("lookup_item", { id: "x" }, context),
    ).rejects.toMatchObject({ code: "UPSTREAM_TIMEOUT" });
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "wraps invalid timeoutMs %s as UPSTREAM_FAILURE without executing",
    async (timeoutMs) => {
      const execute = vi.fn(async () => "should not run");
      const runtime = new InMemoryToolRuntime();
      runtime.register({ ...tool(execute), timeoutMs });

      const error = await runtime
        .callTool("lookup_item", { id: "x" }, context)
        .then(
          () => {
            throw new Error("expected the call to reject");
          },
          (caught: unknown) => caught,
        );

      expect(error).toMatchObject({ code: "UPSTREAM_FAILURE" });
      expect((error as RuntimeError).cause).toBeInstanceOf(TypeError);
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it("rejects a cancellation that arrives before execution", async () => {
    const controller = new AbortController();
    controller.abort();
    const execute = vi.fn(async (input: unknown) => input);
    const cancelled = new InMemoryToolRuntime();
    cancelled.register(tool(execute));
    await expect(
      cancelled.callTool(
        "lookup_item",
        { id: "x" },
        { ...context, signal: controller.signal },
      ),
    ).rejects.toMatchObject({ code: "CANCELLED" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects with CANCELLED when the caller aborts, even if the tool ignores the signal", async () => {
    const pendingController = new AbortController();
    const ignoresAbort = new InMemoryToolRuntime();
    let executionSignal: AbortSignal | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    ignoresAbort.register(
      tool((_input, executionContext) => {
        executionSignal = executionContext.signal;
        markStarted?.();
        return new Promise(() => {});
      }),
    );
    const pendingCall = ignoresAbort.callTool(
      "lookup_item",
      { id: "x" },
      {
        ...context,
        signal: pendingController.signal,
      },
    );
    await started;
    pendingController.abort();
    await expect(pendingCall).rejects.toMatchObject({ code: "CANCELLED" });
    expect(executionSignal?.aborted).toBe(true);
  });
});

describe("schema audit", () => {
  it("returns no diagnostics for a supported schema", () => {
    expect(
      auditInputSchema({
        type: ["object", "null"],
        required: ["id"],
        properties: {
          id: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      }),
    ).toEqual({ supported: true, diagnostics: [] });
  });

  it("reports unsupported keywords without throwing", () => {
    const result = auditInputSchema({ anyOf: [{ type: "string" }] });

    expect(result.supported).toBe(false);
    expect(result.diagnostics).toEqual([
      {
        code: "SCHEMA_UNSUPPORTED_KEYWORD",
        path: "$",
        message: "Schema keyword 'anyOf' at $ is not supported",
      },
    ]);
  });

  it("collects multiple diagnostics with nested paths", () => {
    const result = auditInputSchema({
      type: "object",
      properties: {
        name: { type: "string", format: "email" },
        count: { type: "number", minimum: 0 },
      },
      additionalProperties: { type: "string" },
    });

    expect(
      result.diagnostics.map(({ code, path }) => ({ code, path })),
    ).toEqual([
      { code: "SCHEMA_UNSUPPORTED_KEYWORD", path: "$.properties.name" },
      { code: "SCHEMA_UNSUPPORTED_KEYWORD", path: "$.properties.count" },
      {
        code: "SCHEMA_INVALID_ADDITIONAL_PROPERTIES",
        path: "$",
      },
    ]);
  });

  it("uses the same first diagnostic message that registration throws", () => {
    const schema = { type: "array" as const, items: false };
    const result = auditInputSchema(schema);
    expect(result.diagnostics).toHaveLength(1);
    const first = result.diagnostics[0];

    const runtime = new InMemoryToolRuntime();
    expect(() => runtime.register(toolWithSchema(schema))).toThrowError(
      expect.objectContaining({
        code: "CONTRACT_INVALID",
        message: first?.message,
      }),
    );
  });

  it("reports cycles and excessive depth", () => {
    const cyclic: Record<string, unknown> = { type: "object" };
    cyclic.properties = { self: cyclic };
    expect(auditInputSchema(cyclic).diagnostics).toContainEqual(
      expect.objectContaining({
        code: "SCHEMA_CYCLE",
        path: "$.properties.self",
      }),
    );

    let deep: ToolDefinition["inputSchema"] = { type: "string" };
    for (let depth = 0; depth <= MAX_SCHEMA_DEPTH; depth += 1) {
      deep = { type: "object", properties: { nested: deep } };
    }
    expect(auditInputSchema(deep).diagnostics).toContainEqual(
      expect.objectContaining({ code: "SCHEMA_TOO_DEEP" }),
    );
  });
});

describe("cache key serialization", () => {
  const base = {
    tenantId: "tenant-secret",
    principalId: "principal-secret",
    contractRevision: "revision-secret",
    toolName: "tool-secret",
    arguments: { b: 2, a: 1, account: "arg-secret" },
  };

  it("pins the key format for the current version", () => {
    expect(
      createCacheKey({
        tenantId: "t",
        principalId: "p",
        contractRevision: "r1",
        toolName: "x",
        arguments: { b: 2, a: 1 },
      }),
    ).toBe(
      "chainmcp:cache:v1:cd555bbe0d1b8725cb873129fd6b98f0656c4baee6e2e74408d927ef37a3894d",
    );
  });

  it("returns a fixed-length versioned digest without raw identity or arguments", () => {
    const key = createCacheKey(base);

    expect(key).toMatch(
      new RegExp(`^chainmcp:cache:${CACHE_KEY_VERSION}:[0-9a-f]{64}$`),
    );
    for (const raw of [
      "tenant-secret",
      "principal-secret",
      "revision-secret",
      "tool-secret",
      "arg-secret",
    ]) {
      expect(key).not.toContain(raw);
    }

    expect(createCacheKey(base)).toBe(
      createCacheKey({
        ...base,
        arguments: { account: "arg-secret", a: 1, b: 2 },
      }),
    );
    expect(createCacheKey(base)).not.toBe(
      createCacheKey({ ...base, tenantId: "other" }),
    );
    expect(createCacheKey(base)).not.toBe(
      createCacheKey({ ...base, principalId: "other" }),
    );
    expect(createCacheKey(base)).not.toBe(
      createCacheKey({ ...base, contractRevision: "other" }),
    );
    expect(createCacheKey(base)).not.toBe(
      createCacheKey({ ...base, toolName: "other" }),
    );
    expect(createCacheKey(base)).not.toBe(
      createCacheKey({ ...base, arguments: { ...base.arguments, a: 99 } }),
    );
  });

  it("omits undefined object properties but rejects undefined at the root or in arrays", () => {
    expect(
      createCacheKey({ ...base, arguments: { a: 1, optional: undefined } }),
    ).toBe(createCacheKey({ ...base, arguments: { a: 1 } }));
    expect(
      createCacheKey({
        ...base,
        arguments: { nested: { a: 1, optional: undefined } },
      }),
    ).toBe(createCacheKey({ ...base, arguments: { nested: { a: 1 } } }));

    expect(() => createCacheKey({ ...base, arguments: undefined })).toThrow(
      "JSON-compatible",
    );
    expect(() => createCacheKey({ ...base, arguments: [undefined] })).toThrow(
      "undefined array items",
    );
    expect(() => createCacheKey({ ...base, arguments: new Array(1) })).toThrow(
      "undefined array items",
    );
  });

  it("rejects values that cannot be deterministically represented", () => {
    expect(() =>
      createCacheKey({
        ...base,
        arguments: 1n,
      }),
    ).toThrow("JSON-compatible");
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() =>
      createCacheKey({
        ...base,
        arguments: cyclic,
      }),
    ).toThrow("cycles");
  });

  it("rejects canonical input beyond the size limit", () => {
    expect(() =>
      createCacheKey({
        ...base,
        arguments: "x".repeat(MAX_CACHE_KEY_INPUT_BYTES + 1),
      }),
    ).toThrow(`maximum of ${MAX_CACHE_KEY_INPUT_BYTES} bytes`);
  });
});

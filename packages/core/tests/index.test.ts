import { describe, expect, it, vi } from "vitest";
import {
  auditInputSchema,
  createCacheKey,
  InMemoryToolRuntime,
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

  it("validates union types declared as an array", async () => {
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

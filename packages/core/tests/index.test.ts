import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  auditInputSchema,
  CACHE_KEY_VERSION,
  createCacheKey,
  createFieldProjector,
  InMemoryToolRuntime,
  InMemoryCacheStore,
  MAX_CACHE_KEY_INPUT_BYTES,
  MAX_SCHEMA_DEPTH,
  RuntimeError,
  type ToolContext,
  type ToolDefinition,
  type ToolSource,
  type ToolSpan,
  type ToolTracer,
  validateJsonSchema,
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

  it("enforces maxToolInputBytes before schema validation runs", async () => {
    const execute = vi.fn(async (input: unknown) => input);
    const runtime = new InMemoryToolRuntime({ maxToolInputBytes: 50 });
    runtime.register(tool(execute));

    // Input is > 50 bytes and also violates schema (missing required `id`, extra invalid property)
    const oversizedPayload = { invalidField: "x".repeat(60) };

    await expect(
      runtime.callTool("lookup_item", oversizedPayload, context),
    ).rejects.toMatchObject({
      code: "INPUT_TOO_LARGE",
      message: expect.stringContaining("exceeds the limit of 50 bytes"),
      cause: expect.objectContaining({
        limitBytes: 50,
      }),
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("accepts input exactly at maxToolInputBytes and rejects at limit + 1", async () => {
    const execute = vi.fn(async (input: unknown) => input);
    const runtime = new InMemoryToolRuntime({ maxToolInputBytes: 15 });
    runtime.register(tool(execute));

    // '{"id":"123456"}' is exactly 15 bytes
    const exactInput = { id: "123456" };
    expect(Buffer.byteLength(JSON.stringify(exactInput), "utf8")).toBe(15);
    const res = await runtime.callTool("lookup_item", exactInput, context);
    expect(res).toEqual(exactInput);
    expect(execute).toHaveBeenCalledTimes(1);

    // '{"id":"1234567"}' is 16 bytes (15 + 1)
    const overInput = { id: "1234567" };
    expect(Buffer.byteLength(JSON.stringify(overInput), "utf8")).toBe(16);
    await expect(
      runtime.callTool("lookup_item", overInput, context),
    ).rejects.toMatchObject({
      code: "INPUT_TOO_LARGE",
      message: expect.stringContaining("exceeds the limit of 15 bytes"),
      cause: expect.objectContaining({
        limitBytes: 15,
      }),
    });
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

  it("enforces string length, pattern, and format constraints", async () => {
    const runtime = new InMemoryToolRuntime();
    runtime.register(
      toolWithSchema({
        type: "object",
        required: ["name", "email", "id", "when", "emoji"],
        properties: {
          name: {
            type: "string",
            minLength: 2,
            maxLength: 4,
            pattern: "^[a-z]+$",
          },
          email: { type: "string", format: "email" },
          id: { type: "string", format: "uuid" },
          when: { type: "string", format: "date-time" },
          emoji: { type: "string", maxLength: 1 },
          note: { type: "string", format: "int32" },
        },
        additionalProperties: false,
      }),
    );

    const valid = {
      name: "test",
      email: "user@example.test",
      id: "123e4567-e89b-12d3-a456-426614174000",
      when: "2026-10-21T12:34:56Z",
      emoji: "😀",
      note: "annotation-only",
    };
    await expect(
      runtime.callTool("lookup_item", valid, context),
    ).resolves.toEqual(valid);

    await expect(
      runtime.callTool("lookup_item", { ...valid, name: "x" }, context),
    ).rejects.toMatchObject({ code: "INPUT_INVALID" });
    await expect(
      runtime.callTool("lookup_item", { ...valid, name: "TOOLONG" }, context),
    ).rejects.toMatchObject({ code: "INPUT_INVALID" });
    await expect(
      runtime.callTool("lookup_item", { ...valid, name: "UPPER" }, context),
    ).rejects.toMatchObject({ code: "INPUT_INVALID" });
    await expect(
      runtime.callTool(
        "lookup_item",
        { ...valid, email: "not-an-email" },
        context,
      ),
    ).rejects.toMatchObject({ code: "INPUT_INVALID" });
    await expect(
      runtime.callTool("lookup_item", { ...valid, id: "not-a-uuid" }, context),
    ).rejects.toMatchObject({ code: "INPUT_INVALID" });
    await expect(
      runtime.callTool(
        "lookup_item",
        { ...valid, when: "2026-02-30T12:34:56Z" },
        context,
      ),
    ).rejects.toMatchObject({ code: "INPUT_INVALID" });
    await expect(
      runtime.callTool("lookup_item", { ...valid, emoji: "😀😀" }, context),
    ).rejects.toMatchObject({ code: "INPUT_INVALID" });
  });

  it("enforces numeric and array constraints", async () => {
    const runtime = new InMemoryToolRuntime();
    runtime.register(
      toolWithSchema({
        type: "object",
        required: ["ratio", "values"],
        properties: {
          ratio: {
            type: "number",
            exclusiveMinimum: 0,
            exclusiveMaximum: 10,
            multipleOf: 0.5,
          },
          values: {
            type: "array",
            minItems: 2,
            maxItems: 3,
            uniqueItems: true,
            items: { type: "integer", minimum: 1 },
          },
        },
        additionalProperties: false,
      }),
    );

    await expect(
      runtime.callTool("lookup_item", { ratio: 1.5, values: [1, 2] }, context),
    ).resolves.toEqual({ ratio: 1.5, values: [1, 2] });
    await expect(
      runtime.callTool("lookup_item", { ratio: 0, values: [1, 2] }, context),
    ).rejects.toMatchObject({ code: "INPUT_INVALID" });
    await expect(
      runtime.callTool("lookup_item", { ratio: 10, values: [1, 2] }, context),
    ).rejects.toMatchObject({ code: "INPUT_INVALID" });
    await expect(
      runtime.callTool("lookup_item", { ratio: 1.25, values: [1, 2] }, context),
    ).rejects.toMatchObject({ code: "INPUT_INVALID" });
    await expect(
      runtime.callTool("lookup_item", { ratio: 1, values: [1] }, context),
    ).rejects.toMatchObject({ code: "INPUT_INVALID" });
    await expect(
      runtime.callTool(
        "lookup_item",
        { ratio: 1, values: [1, 2, 3, 4] },
        context,
      ),
    ).rejects.toMatchObject({ code: "INPUT_INVALID" });
    await expect(
      runtime.callTool("lookup_item", { ratio: 1, values: [1, 1] }, context),
    ).rejects.toMatchObject({ code: "INPUT_INVALID" });
    await expect(
      runtime.callTool("lookup_item", { ratio: 1, values: [1, 0] }, context),
    ).rejects.toMatchObject({ code: "INPUT_INVALID" });

    const largeRuntime = new InMemoryToolRuntime();
    largeRuntime.register(
      toolWithSchema({
        type: "number",
        multipleOf: 1,
      }),
    );
    await expect(
      largeRuntime.callTool("lookup_item", 1_000_000_000_000_000.5, context),
    ).rejects.toMatchObject({ code: "INPUT_INVALID" });
  });

  it("compares uniqueItems structurally and enforces object property counts", async () => {
    const runtime = new InMemoryToolRuntime();
    runtime.register(
      toolWithSchema({
        type: "object",
        required: ["items", "record"],
        properties: {
          items: {
            type: "array",
            uniqueItems: true,
            items: {
              type: "object",
              properties: { a: { type: "integer" }, b: { type: "integer" } },
            },
          },
          record: {
            type: "object",
            minProperties: 1,
            maxProperties: 2,
            properties: { a: { type: "integer" }, b: { type: "integer" } },
          },
        },
        additionalProperties: false,
      }),
    );

    await expect(
      runtime.callTool(
        "lookup_item",
        { items: [{ a: 1, b: 2 }], record: { a: 1 } },
        context,
      ),
    ).resolves.toEqual({ items: [{ a: 1, b: 2 }], record: { a: 1 } });
    await expect(
      runtime.callTool(
        "lookup_item",
        {
          items: [
            { a: 1, b: 2 },
            { b: 2, a: 1 },
          ],
          record: { a: 1 },
        },
        context,
      ),
    ).rejects.toMatchObject({ code: "INPUT_INVALID" });
    await expect(
      runtime.callTool("lookup_item", { items: [], record: {} }, context),
    ).rejects.toMatchObject({ code: "INPUT_INVALID" });
    await expect(
      runtime.callTool(
        "lookup_item",
        { items: [], record: { a: 1, b: 2, extra: 3 } },
        context,
      ),
    ).rejects.toMatchObject({ code: "INPUT_INVALID" });
  });

  it("rejects malformed constraint declarations at registration", () => {
    for (const schema of [
      { type: "string", minLength: -1 },
      { type: "string", maxLength: 1.5 },
      { type: "string", pattern: "(" },
      { type: "string", pattern: "(?=a)" },
      { type: "string", format: 1 },
      { type: "number", minimum: "zero" },
      { type: "number", exclusiveMinimum: true },
      { type: "number", multipleOf: 0 },
      { type: "array", uniqueItems: "yes" },
      { type: "object", minProperties: -1 },
    ]) {
      expectContractInvalid(schema);
    }
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
    ["NaN enum entry", { enum: [Number.NaN] }],
    ["Infinity enum entry", { enum: [Number.POSITIVE_INFINITY] }],
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

  it("compares keys as own properties, not through the prototype chain", async () => {
    const runtime = new InMemoryToolRuntime();
    runtime.register(
      toolWithSchema({
        type: "object",
        required: ["id"],
        properties: { id: { type: "string" } },
        additionalProperties: false,
      }),
    );

    await expect(
      runtime.callTool("lookup_item", { id: "x" }, context),
    ).resolves.toEqual({ id: "x" });

    // Inherited Object.prototype names are not declared properties, so an
    // undeclared key must be rejected rather than treated as known. JSON.parse
    // and computed keys both produce own properties for these names.
    for (const key of ["toString", "constructor", "valueOf", "__proto__"]) {
      await expect(
        runtime.callTool("lookup_item", { id: "x", [key]: "x" }, context),
      ).rejects.toMatchObject({
        code: "INPUT_INVALID",
        message: expect.stringContaining(`$.${key} is not allowed`),
      });
    }

    // A required name that exists only on the prototype is still missing.
    const phantom = new InMemoryToolRuntime();
    phantom.register(toolWithSchema({ type: "object", required: ["valueOf"] }));
    await expect(
      phantom.callTool("lookup_item", {}, context),
    ).rejects.toMatchObject({
      code: "INPUT_INVALID",
      message: expect.stringContaining("$.valueOf is required"),
    });
  });

  it("bounds the number of reported validation issues", async () => {
    const runtime = new InMemoryToolRuntime();
    runtime.register(
      toolWithSchema({ type: "array", items: { type: "string" } }),
    );

    const error = await runtime
      .callTool(
        "lookup_item",
        Array.from({ length: 5_000 }, () => 1),
        context,
      )
      .then(
        () => {
          throw new Error("expected the call to reject");
        },
        (caught: unknown) => caught,
      );

    expect(error).toMatchObject({
      code: "INPUT_INVALID",
      message: expect.stringContaining("further issues omitted after 20"),
    });
    expect(error).toBeInstanceOf(RuntimeError);
    if (!(error instanceof RuntimeError)) throw new Error("unreachable");
    expect(error.message.length).toBeLessThan(1_000);
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
        check: () => ({ allowed: false, retryAfterSeconds: 30 }),
      },
      metrics: { record },
    });
    runtime.register(tool(execute));

    const rejection = await runtime
      .callTool("lookup_item", { id: "x" }, context)
      .catch((error) => error);
    expect(rejection).toBeInstanceOf(RuntimeError);
    expect(rejection).toMatchObject({
      code: "RATE_LIMITED",
      retryAfterSeconds: 30,
    });
    expect(execute).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "rate_limited",
        errorCode: "RATE_LIMITED",
        toolName: "lookup_item",
      }),
    );
  });

  it("calls limiter release on tool success and tool failure", async () => {
    const release = vi.fn();
    const runtime = new InMemoryToolRuntime({
      rateLimiter: {
        check: () => ({ allowed: true }),
        release,
      },
    });
    runtime.register(tool(async () => "success-result"));
    await runtime.callTool("lookup_item", { id: "x" }, context);
    expect(release).toHaveBeenCalledWith(context, "lookup_item");

    release.mockClear();
    const failingRuntime = new InMemoryToolRuntime({
      rateLimiter: {
        check: () => ({ allowed: true }),
        release,
      },
    });
    failingRuntime.register(
      tool(async () => {
        throw new Error("failure");
      }),
    );
    await expect(
      failingRuntime.callTool("lookup_item", { id: "x" }, context),
    ).rejects.toThrow();
    expect(release).toHaveBeenCalledWith(context, "lookup_item");
  });

  it("does not call limiter release when rate limit is denied", async () => {
    const release = vi.fn();
    const runtime = new InMemoryToolRuntime({
      rateLimiter: {
        check: () => ({ allowed: false }),
        release,
      },
    });
    runtime.register(tool());
    await expect(
      runtime.callTool("lookup_item", { id: "x" }, context),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(release).not.toHaveBeenCalled();
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

  it("measures durationMs on a monotonic clock and timestamp on the wall clock", async () => {
    const record = vi.fn();
    // A backwards wall-clock jump must not produce a negative or wrong duration.
    const wallReadings = [1_000_000, 999_000, 998_000];
    const now = vi.fn(() => wallReadings.shift() ?? 0);
    const monotonicNow = vi
      .fn<() => number>()
      .mockReturnValueOnce(10)
      .mockReturnValueOnce(35);
    const runtime = new InMemoryToolRuntime({
      metrics: { record },
      now,
      monotonicNow,
    });
    runtime.register(tool());

    await expect(
      runtime.callTool("lookup_item", { id: "x" }, context),
    ).resolves.toEqual({ id: "x" });

    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ timestamp: 1_000_000, durationMs: 25 }),
    );
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

  it("maps untyped context factory failures to AUTH_FORBIDDEN", async () => {
    const record = vi.fn();
    const runtime = new InMemoryToolRuntime({ metrics: { record } });
    runtime.register(tool());

    await expect(
      runtime.callTool("lookup_item", { id: "x" }, () => {
        throw new Error("private identity provider detail");
      }),
    ).rejects.toMatchObject({
      code: "AUTH_FORBIDDEN",
      message: "Access denied",
    });
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "error",
        errorCode: "AUTH_FORBIDDEN",
        tenantId: "unknown",
      }),
    );
  });

  it("preserves typed context factory failures instead of flattening them", async () => {
    const record = vi.fn();
    const runtime = new InMemoryToolRuntime({ metrics: { record } });
    runtime.register(tool());

    await expect(
      runtime.callTool("lookup_item", { id: "x" }, () => {
        throw new RuntimeError(
          "UPSTREAM_FAILURE",
          "identity provider unavailable",
        );
      }),
    ).rejects.toMatchObject({
      code: "UPSTREAM_FAILURE",
      message: "identity provider unavailable",
    });
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "error",
        errorCode: "UPSTREAM_FAILURE",
        tenantId: "unknown",
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
        name: { type: "string", patternProperties: {} },
        count: { type: "number", minimum: "zero" },
      },
      additionalProperties: { type: "string" },
    });

    expect(
      result.diagnostics.map(({ code, path }) => ({ code, path })),
    ).toEqual([
      { code: "SCHEMA_UNSUPPORTED_KEYWORD", path: "$.properties.name" },
      { code: "SCHEMA_INVALID_CONSTRAINT", path: "$.properties.count" },
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

  it("rejects non-finite enum entries that could never match", () => {
    expect(auditInputSchema({ enum: [Number.NaN, "ok"] }).diagnostics).toEqual([
      {
        code: "SCHEMA_INVALID_ENUM",
        path: "$",
        message:
          "Schema 'enum' at $ must contain only finite numbers; NaN and Infinity cannot be represented",
      },
    ]);
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
    authorizationPartition: "grants-read-v1",
    contractRevision: "revision-secret",
    toolName: "tool-secret",
    arguments: { b: 2, a: 1, account: "arg-secret" },
  };

  it("pins the key format for the current version", () => {
    expect(
      createCacheKey({
        tenantId: "t",
        principalId: "p",
        authorizationPartition: "authz-v1",
        contractRevision: "r1",
        toolName: "x",
        arguments: { b: 2, a: 1 },
      }),
    ).toBe(
      "chainmcp:cache:v2:d23cc364e19223a75bff2d865d061442ff00f1ce8c1321b4a4c0f17b8ad67572",
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
      createCacheKey({ ...base, authorizationPartition: "different-grants" }),
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

  it("requires a non-empty authorization partition", () => {
    expect(() =>
      createCacheKey({ ...base, authorizationPartition: "" }),
    ).toThrow("authorizationPartition");
    expect(() =>
      createCacheKey({ ...base, authorizationPartition: "   " }),
    ).toThrow("authorizationPartition");
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

describe("tenant binding and tenancy modes (ADR 0008)", () => {
  const tenantContext = (tenantId: string): ToolContext => ({
    requestId: `req-${tenantId}`,
    tenantId,
    principal: { id: `user-${tenantId}`, scopes: ["read"] },
  });

  const ownedTool = (
    ownerTenantId: string,
    name = "lookup_item",
    execute: ToolDefinition["execute"] = async (input) => input,
  ): ToolDefinition => ({
    ...tool(execute),
    name,
    ownerTenantId,
  });

  const authorizer = vi.fn();

  beforeEach(() => {
    authorizer.mockReset();
  });

  it("preserves the Milestone 2 unpinned single-tenant behavior", async () => {
    const execute = vi.fn(async (input: unknown) => input);
    const runtime = new InMemoryToolRuntime();
    runtime.register(tool(execute));
    await expect(
      runtime.callTool("lookup_item", { id: "a" }, tenantContext("tenant-1")),
    ).resolves.toEqual({ id: "a" });
    await expect(
      runtime.callTool("lookup_item", { id: "b" }, tenantContext("tenant-2")),
    ).resolves.toEqual({ id: "b" });
    expect(runtime.listTools().map(({ name }) => name)).toEqual([
      "lookup_item",
    ]);
  });

  it("stamps unstamped tools with the pinned tenant", () => {
    const runtime = new InMemoryToolRuntime({ tenantId: "tenant-1" });
    expect(() => runtime.register(tool())).not.toThrow();
    expect(() =>
      runtime.register(ownedTool("tenant-1", "description_tool")),
    ).not.toThrow();
  });

  it("rejects a tool bound to a foreign tenant in a pinned runtime", () => {
    const runtime = new InMemoryToolRuntime({ tenantId: "tenant-1" });
    expect(() => runtime.register(ownedTool("tenant-2"))).toThrowError(
      expect.objectContaining({ code: "CONFIG_INVALID" }),
    );
  });

  it("rejects invalid tenancy construction options", () => {
    expect(
      () =>
        new InMemoryToolRuntime({
          tenantId: "",
        }),
    ).toThrowError(expect.objectContaining({ code: "CONFIG_INVALID" }));
    expect(
      () =>
        new InMemoryToolRuntime({
          tenantMode: "multi-tenant",
        }),
    ).toThrowError(expect.objectContaining({ code: "CONFIG_INVALID" }));
    expect(
      () =>
        new InMemoryToolRuntime({
          tenantMode: "multi-tenant",
          tenantId: "tenant-1",
          authorizer: { authorize: authorizer },
        }),
    ).toThrowError(expect.objectContaining({ code: "CONFIG_INVALID" }));
    expect(
      () =>
        // @ts-expect-error -- exercising runtime validation of unknown modes
        new InMemoryToolRuntime({ tenantMode: "multitenant" }),
    ).toThrowError(expect.objectContaining({ code: "CONFIG_INVALID" }));
  });

  it("denies pinned-tenant callers from another tenant before adapters run", async () => {
    const execute = vi.fn(async (input: unknown) => input);
    const metrics = vi.fn();
    const runtime = new InMemoryToolRuntime({
      tenantId: "tenant-1",
      authorizer: { authorize: authorizer },
      metrics: { record: metrics },
    });
    runtime.register(tool(execute));
    const failure = await runtime
      .callTool("lookup_item", { id: "a" }, tenantContext("tenant-2"))
      .then(
        () => {
          throw new Error("cross-tenant call unexpectedly succeeded");
        },
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(RuntimeError);
    const denial = failure as RuntimeError;
    expect(denial.code).toBe("AUTH_FORBIDDEN");
    expect(denial.message).toBe("Access denied");
    expect(denial.cause).toBeUndefined();
    expect(authorizer).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(metrics).toHaveBeenCalledOnce();
    expect(metrics).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "error",
        errorCode: "AUTH_FORBIDDEN",
        tenantId: "tenant-2",
      }),
    );
  });

  it("requires tenant binding for registration in multi-tenant mode", () => {
    const runtime = new InMemoryToolRuntime({
      tenantMode: "multi-tenant",
      authorizer: { authorize: () => {} },
    });
    expect(() => runtime.register(tool())).toThrowError(
      expect.objectContaining({ code: "CONFIG_INVALID" }),
    );
    expect(() => runtime.register(ownedTool("", "lookup_item"))).toThrowError(
      expect.objectContaining({ code: "CONFIG_INVALID" }),
    );
    expect(() => runtime.register(ownedTool("tenant-1"))).not.toThrow();
    expect(() => runtime.register(ownedTool("tenant-1"))).toThrowError(
      expect.objectContaining({ code: "TOOL_ALREADY_REGISTERED" }),
    );
    // A duplicate name under a different tenant is a different tool.
    expect(() =>
      runtime.register(ownedTool("tenant-2", "lookup_item")),
    ).not.toThrow();
  });

  it("scopes multi-tenant listing to the caller's tenant", () => {
    const runtime = new InMemoryToolRuntime({
      tenantMode: "multi-tenant",
      authorizer: { authorize: () => {} },
    });
    runtime.register(ownedTool("tenant-1", "tool_1"));
    runtime.register(ownedTool("tenant-2", "tool_2"));
    expect(
      runtime.listTools(tenantContext("tenant-1")).map(({ name }) => name),
    ).toEqual(["tool_1"]);
    expect(
      runtime.listTools(tenantContext("tenant-2")).map(({ name }) => name),
    ).toEqual(["tool_2"]);
    expect(runtime.listTools(tenantContext("tenant-9"))).toEqual([]);
    expect(() => runtime.listTools()).toThrowError(
      expect.objectContaining({ code: "AUTH_REQUIRED" }),
    );
  });

  it("makes cross-tenant calls indistinguishable from unknown tools", async () => {
    const execute = vi.fn(async (input: unknown) => input);
    const metrics = vi.fn();
    const runtime = new InMemoryToolRuntime({
      tenantMode: "multi-tenant",
      authorizer: { authorize: authorizer },
      metrics: { record: metrics },
    });
    runtime.register(ownedTool("tenant-2", "secret_tool", execute));
    await expect(
      runtime.callTool("secret_tool", { id: "a" }, tenantContext("tenant-1")),
    ).rejects.toMatchObject({
      code: "TOOL_NOT_FOUND",
      message: "Tool 'secret_tool' was not found",
    });
    expect(authorizer).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(metrics).not.toHaveBeenCalled();
  });

  it("keeps same-tenant calls working in multi-tenant mode", async () => {
    const execute = vi.fn(async (input: unknown) => input);
    const runtime = new InMemoryToolRuntime({
      tenantMode: "multi-tenant",
      authorizer: { authorize: authorizer },
    });
    runtime.register(ownedTool("tenant-1", "lookup_item", execute));
    await expect(
      runtime.callTool("lookup_item", { id: "a" }, tenantContext("tenant-1")),
    ).resolves.toEqual({ id: "a" });
    expect(authorizer).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
  });

  describe("structured logger integration", () => {
    it("emits correlated info log on successful tool execution", async () => {
      const info = vi.fn();
      const logger = {
        debug: vi.fn(),
        info,
        warn: vi.fn(),
        error: vi.fn(),
        audit: vi.fn(),
      };
      const runtime = new InMemoryToolRuntime({ logger });
      const myTool = {
        ...tool(async () => ({ status: "ok" })),
        contractRevision: "rev-123",
      };
      runtime.register(myTool);
      const ctx = tenantContext("tenant-abc");
      await runtime.callTool("lookup_item", { id: "1" }, ctx);

      expect(info).toHaveBeenCalledOnce();
      expect(info).toHaveBeenCalledWith(
        "Tool 'lookup_item' completed successfully",
        expect.objectContaining({
          requestId: ctx.requestId,
          tenantId: "tenant-abc",
          principalId: ctx.principal.id,
          toolName: "lookup_item",
          contractRevision: "rev-123",
          outcome: "success",
        }),
      );
    });

    it("emits warn and audit log on rate limit denial", async () => {
      const warn = vi.fn();
      const audit = vi.fn();
      const logger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn,
        error: vi.fn(),
        audit,
      };
      const rateLimiter = {
        check: vi
          .fn()
          .mockResolvedValue({ allowed: false, retryAfterSeconds: 30 }),
      };
      const runtime = new InMemoryToolRuntime({ logger, rateLimiter });
      runtime.register(tool());
      const ctx = tenantContext("tenant-xyz");

      await expect(
        runtime.callTool("lookup_item", { id: "1" }, ctx),
      ).rejects.toMatchObject({ code: "RATE_LIMITED" });

      expect(warn).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith(
        "Tool 'lookup_item' was rate limited",
        expect.objectContaining({
          outcome: "rate_limited",
          errorCode: "RATE_LIMITED",
        }),
      );
      expect(audit).toHaveBeenCalledOnce();
      expect(audit).toHaveBeenCalledWith(
        "Rate limit exceeded for tool 'lookup_item'",
        expect.objectContaining({
          outcome: "rate_limited",
        }),
      );
    });

    it("emits error and audit log on auth denial", async () => {
      const errorLog = vi.fn();
      const audit = vi.fn();
      const logger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: errorLog,
        audit,
      };
      const denyingAuthorizer = {
        authorize: vi
          .fn()
          .mockRejectedValue(new RuntimeError("AUTH_FORBIDDEN", "Forbidden")),
      };
      const runtime = new InMemoryToolRuntime({
        logger,
        authorizer: denyingAuthorizer,
      });
      runtime.register(tool());
      const ctx = tenantContext("tenant-xyz");

      await expect(
        runtime.callTool("lookup_item", { id: "1" }, ctx),
      ).rejects.toMatchObject({ code: "AUTH_FORBIDDEN" });

      expect(errorLog).toHaveBeenCalledOnce();
      expect(errorLog).toHaveBeenCalledWith(
        "Tool 'lookup_item' failed with error AUTH_FORBIDDEN",
        expect.objectContaining({
          errorCode: "AUTH_FORBIDDEN",
          outcome: "error",
        }),
      );
      expect(audit).toHaveBeenCalledOnce();
      expect(audit).toHaveBeenCalledWith(
        "Authorization denied for tool 'lookup_item'",
        expect.objectContaining({
          errorCode: "AUTH_FORBIDDEN",
        }),
      );
    });

    it("isolates logger failures so tool results and errors are not altered", async () => {
      const throwingLogger = {
        debug: vi.fn(),
        info: vi.fn().mockImplementation(() => {
          throw new Error("Logger sink exploded");
        }),
        warn: vi.fn().mockImplementation(() => {
          throw new Error("Logger sink exploded");
        }),
        error: vi.fn().mockImplementation(() => {
          throw new Error("Logger sink exploded");
        }),
        audit: vi.fn().mockImplementation(() => {
          throw new Error("Audit sink exploded");
        }),
      };
      const runtime = new InMemoryToolRuntime({ logger: throwingLogger });
      runtime.register(tool(async () => "successful result"));
      const ctx = tenantContext("t-1");

      await expect(
        runtime.callTool("lookup_item", { id: "1" }, ctx),
      ).resolves.toBe("successful result");
    });
  });

  describe("ToolSource and registerSource", () => {
    it("registers tools returned from a synchronous ToolSource", async () => {
      const runtime = new InMemoryToolRuntime();
      const testTool: ToolDefinition = {
        name: "sync_tool",
        description: "Synchronous source tool",
        inputSchema: { type: "object", additionalProperties: false },
        operation: {},
        execute: async () => ({ status: "ok" }),
      };
      const source: ToolSource = {
        getTools: () => [testTool],
      };

      await runtime.registerSource(source);
      const tools = runtime.listTools();
      expect(tools).toHaveLength(1);
      expect(tools[0]?.name).toBe("sync_tool");

      const result = await runtime.callTool("sync_tool", {}, context);
      expect(result).toEqual({ status: "ok" });
    });

    it("registers tools returned from an asynchronous ToolSource", async () => {
      const runtime = new InMemoryToolRuntime();
      const testTool: ToolDefinition = {
        name: "async_tool",
        description: "Asynchronous source tool",
        inputSchema: { type: "object", additionalProperties: false },
        operation: {},
        execute: async () => ({ data: 42 }),
      };
      const source: ToolSource = {
        getTools: async () => [testTool],
      };

      await runtime.registerSource(source);
      const tools = runtime.listTools();
      expect(tools).toHaveLength(1);
      expect(tools[0]?.name).toBe("async_tool");

      const result = await runtime.callTool("async_tool", {}, context);
      expect(result).toEqual({ data: 42 });
    });

    it("rejects an invalid ToolSource missing getTools", async () => {
      const runtime = new InMemoryToolRuntime();
      // @ts-expect-error -- testing invalid source object
      await expect(runtime.registerSource({})).rejects.toThrowError(
        expect.objectContaining({
          code: "CONFIG_INVALID",
          message: "Tool source must provide a getTools() function",
        }),
      );
    });

    it("rejects a ToolSource returning a non-array", async () => {
      const runtime = new InMemoryToolRuntime();
      const invalidSource = {
        getTools: () => ({ name: "not_an_array" }),
      };
      // @ts-expect-error -- testing runtime non-array return
      await expect(runtime.registerSource(invalidSource)).rejects.toThrowError(
        expect.objectContaining({
          code: "CONFIG_INVALID",
          message: "Tool source getTools() must return an array of tools",
        }),
      );
    });

    it("propagates registration validation errors from tools in the source", async () => {
      const runtime = new InMemoryToolRuntime();
      const invalidTool: ToolDefinition = {
        name: "invalid name with spaces",
        description: "Invalid",
        inputSchema: { type: "object" },
        operation: {},
        execute: async () => {},
      };
      const source: ToolSource = {
        getTools: () => [invalidTool],
      };
      await expect(runtime.registerSource(source)).rejects.toThrow(TypeError);
    });
  });

  describe("tool tracer integration", () => {
    it("starts tool span with name, context, and revision, propagates context, and ends span on success", async () => {
      const startToolSpan = vi.fn();
      const endToolSpan = vi.fn();
      const withSpan = vi.fn((span, fn) => fn());
      const mockSpan: ToolSpan = {
        spanContext: () => ({ traceId: "trace-1", spanId: "span-1" }),
        end: vi.fn(),
      };
      startToolSpan.mockReturnValue(mockSpan);

      const tracer: ToolTracer = {
        startToolSpan,
        endToolSpan,
        withSpan,
      };

      const runtime = new InMemoryToolRuntime({ tracer });
      const myTool = {
        ...tool(async () => ({ ok: true })),
        contractRevision: "rev-99",
      };
      runtime.register(myTool);

      const ctx = tenantContext("tenant-test");
      const result = await runtime.callTool("lookup_item", { id: "1" }, ctx);
      expect(result).toEqual({ ok: true });

      expect(startToolSpan).toHaveBeenCalledOnce();
      expect(startToolSpan).toHaveBeenCalledWith("lookup_item", ctx, "rev-99");
      expect(withSpan).toHaveBeenCalledOnce();
      expect(withSpan).toHaveBeenCalledWith(mockSpan, expect.any(Function));
      expect(endToolSpan).toHaveBeenCalledOnce();
      expect(endToolSpan).toHaveBeenCalledWith(
        mockSpan,
        expect.objectContaining({
          outcome: "success",
          cached: false,
        }),
      );
    });

    it("ends span with error outcome and passes error on failure", async () => {
      const startToolSpan = vi.fn();
      const endToolSpan = vi.fn();
      const mockSpan: ToolSpan = {
        spanContext: () => ({ traceId: "trace-err", spanId: "span-err" }),
        end: vi.fn(),
      };
      startToolSpan.mockReturnValue(mockSpan);

      const tracer: ToolTracer = {
        startToolSpan,
        endToolSpan,
      };

      const runtime = new InMemoryToolRuntime({ tracer });
      const failingTool = tool(async () => {
        throw new Error("Tool execution failed");
      });
      runtime.register(failingTool);

      const ctx = tenantContext("tenant-err");
      await expect(
        runtime.callTool("lookup_item", { id: "1" }, ctx),
      ).rejects.toThrow("Tool 'lookup_item' failed");

      expect(startToolSpan).toHaveBeenCalledOnce();
      expect(endToolSpan).toHaveBeenCalledOnce();
      expect(endToolSpan).toHaveBeenCalledWith(
        mockSpan,
        expect.objectContaining({
          outcome: "error",
          error: expect.any(Error),
        }),
      );
    });

    it("ends span with cancelled outcome when context signal is aborted", async () => {
      const startToolSpan = vi.fn();
      const endToolSpan = vi.fn();
      const mockSpan: ToolSpan = {
        spanContext: () => ({ traceId: "trace-abort", spanId: "span-abort" }),
        end: vi.fn(),
      };
      startToolSpan.mockReturnValue(mockSpan);

      const tracer: ToolTracer = {
        startToolSpan,
        endToolSpan,
      };

      const runtime = new InMemoryToolRuntime({ tracer });
      const slowTool = tool(async () => {
        return new Promise((resolve) => setTimeout(resolve, 50));
      });
      runtime.register(slowTool);

      const controller = new AbortController();
      controller.abort();

      const ctx = {
        ...tenantContext("tenant-abort"),
        signal: controller.signal,
      };

      await expect(
        runtime.callTool("lookup_item", { id: "1" }, ctx),
      ).rejects.toThrow();

      expect(startToolSpan).toHaveBeenCalledOnce();
      expect(endToolSpan).toHaveBeenCalledOnce();
      expect(endToolSpan).toHaveBeenCalledWith(
        mockSpan,
        expect.objectContaining({
          outcome: "cancelled",
        }),
      );
    });

    it("creates and ends child spans for cache, upstream call, and projection", async () => {
      const childSpans: Array<{ name: string; details?: unknown }> = [];
      const startChildSpan = vi.fn((name) => {
        const span: ToolSpan = {
          spanContext: () => ({ traceId: "t-child", spanId: `s-${name}` }),
          end: vi.fn(),
        };
        childSpans.push({ name });
        return span;
      });
      const endSpan = vi.fn((span, details) => {
        const found = childSpans.find(
          (s) => `s-${s.name}` === span.spanContext().spanId,
        );
        if (found) {
          found.details = details;
        }
      });
      const mockSpan: ToolSpan = {
        spanContext: () => ({ traceId: "t-root", spanId: "s-root" }),
        end: vi.fn(),
      };
      const tracer: ToolTracer = {
        startToolSpan: vi.fn().mockReturnValue(mockSpan),
        endToolSpan: vi.fn(),
        startChildSpan,
        endSpan,
      };

      const store = new InMemoryCacheStore();
      const runtime = new InMemoryToolRuntime({
        tracer,
        cache: {
          store,
          authorizationPartition: () => "public",
        },
        projector: createFieldProjector(),
      });

      const cachedTool = {
        ...tool(async () => ({ data: "value", secret: "drop" })),
        contractRevision: "rev-cache-1",
        cache: { ttlSeconds: 60 },
        output: { fields: { include: ["data"] } },
      };
      runtime.register(cachedTool);

      const ctx = tenantContext("t-1");
      const res = await runtime.callTool("lookup_item", { id: "1" }, ctx);
      expect(res).toEqual({ data: "value" });

      const names = childSpans.map((s) => s.name);
      expect(names).toContain("cache.read");
      expect(names).toContain("upstream.call");
      expect(names).toContain("projection");
      expect(names).toContain("cache.write");
      expect(endSpan).toHaveBeenCalledTimes(4);
    });

    it("does not start tool span when tool cannot be found", async () => {
      const startToolSpan = vi.fn();
      const endToolSpan = vi.fn();
      const tracer: ToolTracer = {
        startToolSpan,
        endToolSpan,
      };
      const runtime = new InMemoryToolRuntime({ tracer });
      const ctx = tenantContext("t-1");
      await expect(
        runtime.callTool("nonexistent", {}, ctx),
      ).rejects.toMatchObject({
        code: "TOOL_NOT_FOUND",
      });
      expect(startToolSpan).not.toHaveBeenCalled();
      expect(endToolSpan).not.toHaveBeenCalled();
    });
  });
});

describe("validateJsonSchema", () => {
  it("validates conforming objects and primitives", () => {
    const schema = {
      type: "object",
      required: ["name", "age"],
      properties: {
        name: { type: "string" },
        age: { type: "integer" },
        tags: { type: "array", items: { type: "string" } },
      },
      additionalProperties: false,
    };

    const validResult = validateJsonSchema(schema, {
      name: "alice",
      age: 30,
      tags: ["admin", "dev"],
    });
    expect(validResult.valid).toBe(true);
    expect(validResult.issues).toHaveLength(0);
  });

  it("returns issues for missing required properties, wrong types, and unexpected fields", () => {
    const schema = {
      type: "object",
      required: ["name", "age"],
      properties: {
        name: { type: "string" },
        age: { type: "integer" },
      },
      additionalProperties: false,
    };

    const invalidResult = validateJsonSchema(schema, {
      name: 123,
      extra: "not allowed",
    });
    expect(invalidResult.valid).toBe(false);
    expect(invalidResult.issues.length).toBeGreaterThanOrEqual(3);
    expect(
      invalidResult.issues.some((i) => i.includes("$.age is required")),
    ).toBe(true);
    expect(
      invalidResult.issues.some((i) => i.includes("$.name must be string")),
    ).toBe(true);
    expect(
      invalidResult.issues.some((i) => i.includes("$.extra is not allowed")),
    ).toBe(true);
  });

  it("truncates issues when exceeding maxIssues", () => {
    const schema = {
      type: "array",
      items: { type: "string" },
    };

    const invalidArray = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const result = validateJsonSchema(schema, invalidArray, 3);
    expect(result.valid).toBe(false);
    expect(result.issues).toHaveLength(4);
    expect(result.issues[3]).toBe("further issues omitted after 3");
  });
});

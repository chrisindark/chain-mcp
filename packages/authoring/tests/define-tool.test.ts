import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineTool } from "../src/index.js";

describe("defineTool", () => {
  it("defines a tool with Zod schema and executes handler with parsed data", async () => {
    const tool = defineTool({
      name: "calculate_sum",
      description: "Calculates the sum of two numbers",
      schema: z.object({
        a: z.number(),
        b: z.number().default(10),
      }),
      execute: async ({ a, b }) => ({ sum: a + b }),
    });

    expect(tool.name).toBe("calculate_sum");
    expect(tool.description).toBe("Calculates the sum of two numbers");
    expect(tool.inputSchema.type).toBe("object");
    expect(tool.inputSchema.properties).toBeDefined();

    const result = await tool.execute(
      { a: 5 } as unknown as { a: number; b: number },
      {
        requestId: "r-1",
        tenantId: "t-1",
        principal: { id: "p-1", scopes: [] },
      },
    );
    expect(result).toEqual({ sum: 15 });
  });

  it("defines a tool with raw JSON Schema", async () => {
    const tool = defineTool({
      name: "echo_string",
      description: "Echoes a string value",
      inputSchema: {
        type: "object",
        required: ["message"],
        properties: {
          message: { type: "string" },
        },
        additionalProperties: false,
      },
      execute: async (input: { message: string }) => input.message,
    });

    expect(tool.name).toBe("echo_string");
    const result = await tool.execute(
      { message: "hello" },
      {
        requestId: "r-1",
        tenantId: "t-1",
        principal: { id: "p-1", scopes: [] },
      },
    );
    expect(result).toBe("hello");
  });

  it("defaults to empty object schema when neither schema nor inputSchema is passed", () => {
    const tool = defineTool({
      name: "ping",
      description: "Healthcheck ping tool",
      execute: async () => ({ status: "ok" }),
    });

    expect(tool.inputSchema).toEqual({
      type: "object",
      additionalProperties: false,
    });
  });

  it("validates tool name format", () => {
    expect(() =>
      defineTool({
        name: "invalid name with spaces",
        description: "Test",
        execute: async () => {},
      }),
    ).toThrow(TypeError);

    expect(() =>
      defineTool({
        name: "",
        description: "Test",
        execute: async () => {},
      }),
    ).toThrow(TypeError);
  });

  it("validates description and execute", () => {
    expect(() =>
      defineTool({
        name: "valid_name",
        description: "   ",
        execute: async () => {},
      }),
    ).toThrow(TypeError);

    expect(() =>
      defineTool({
        name: "valid_name",
        description: "Test",
        // @ts-expect-error -- testing invalid execute
        execute: "not a function",
      }),
    ).toThrow(TypeError);
  });

  it("rejects when both schema and inputSchema are provided", () => {
    expect(() =>
      defineTool({
        name: "ambiguous_tool",
        description: "Test",
        schema: z.object({ x: z.string() }),
        inputSchema: { type: "object" },
        execute: async () => {},
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "INVALID_TOOL_DEFINITION",
      }),
    );
  });

  it("rejects non-object raw inputSchema", () => {
    expect(() =>
      defineTool({
        name: "bad_schema",
        description: "Test",
        // @ts-expect-error -- testing non-object
        inputSchema: "not-an-object",
        execute: async () => {},
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "SCHEMA_NOT_OBJECT",
      }),
    );

    expect(() =>
      defineTool({
        name: "bad_type",
        description: "Test",
        inputSchema: { type: "string" },
        execute: async () => {},
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "SCHEMA_NOT_OBJECT",
      }),
    );
  });

  it("rejects unaudited constructs in raw inputSchema at definition time", () => {
    expect(() =>
      defineTool({
        name: "unsupported_keyword",
        description: "Test",
        inputSchema: {
          type: "object",
          $ref: "#/definitions/Foo",
        },
        execute: async () => {},
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "SCHEMA_AUDIT_FAILED",
      }),
    );
  });

  it("preserves tool metadata like cache, operation, and version", () => {
    const tool = defineTool({
      name: "cached_tool",
      description: "Cached tool",
      version: "rev-1",
      cache: { ttlSeconds: 60 },
      operation: { requiredScopes: ["read:data"] },
      ownerTenantId: "tenant-a",
      timeoutMs: 3000,
      execute: async () => "cached",
    });

    expect(tool.contractRevision).toBe("rev-1");
    expect(tool.cache?.ttlSeconds).toBe(60);
    expect(tool.operation.requiredScopes).toEqual(["read:data"]);
    expect(tool.ownerTenantId).toBe("tenant-a");
    expect(tool.timeoutMs).toBe(3000);
  });
});

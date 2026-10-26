import { describe, expect, it } from "vitest";
import { z } from "zod";
import { zodToJsonSchema } from "../src/index.js";

describe("zodToJsonSchema", () => {
  it("lowers primitive fields and constraints", () => {
    const schema = z.object({
      str: z.string().min(2).max(50),
      num: z.number().min(0).max(100),
      int: z.number().int().positive(),
      bool: z.boolean(),
      choice: z.enum(["alpha", "beta", "gamma"]),
      tags: z.array(z.string()).min(1).max(10),
    });

    const lowered = zodToJsonSchema(schema);

    expect(lowered.type).toBe("object");
    expect(lowered.$schema).toBeUndefined();
    expect(lowered.$id).toBeUndefined();

    const props = lowered.properties as Record<string, Record<string, unknown>>;
    expect(props["str"]?.["type"]).toBe("string");
    expect(props["str"]?.["minLength"]).toBe(2);
    expect(props["str"]?.["maxLength"]).toBe(50);

    expect(props["num"]?.["type"]).toBe("number");
    expect(props["num"]?.["minimum"]).toBe(0);
    expect(props["num"]?.["maximum"]).toBe(100);

    expect(props["int"]?.["type"]).toBe("integer");
    expect(props["int"]?.["exclusiveMinimum"]).toBe(0);

    expect(props["bool"]?.["type"]).toBe("boolean");

    expect(props["choice"]?.["type"]).toBe("string");
    expect(props["choice"]?.["enum"]).toEqual(["alpha", "beta", "gamma"]);

    expect(props["tags"]?.["type"]).toBe("array");
    expect(props["tags"]?.["minItems"]).toBe(1);
    expect(props["tags"]?.["maxItems"]).toBe(10);
    const tagsItems = props["tags"]?.["items"] as Record<string, unknown>;
    expect(tagsItems?.["type"]).toBe("string");
  });

  it("handles optional and default fields in required array", () => {
    const schema = z.object({
      req: z.string(),
      opt: z.string().optional(),
      def: z.number().default(42),
    });

    const lowered = zodToJsonSchema(schema);
    const required = lowered.required as string[];

    expect(required).toContain("req");
    expect(required).toContain("def");
    expect(required).not.toContain("opt");
  });

  it("supports string formats like email and datetime", () => {
    const schema = z.object({
      email: z.string().email(),
      created: z.string().datetime(),
    });

    const lowered = zodToJsonSchema(schema);
    const props = lowered.properties as Record<string, Record<string, unknown>>;

    expect(props["email"]?.["format"]).toBe("email");
    expect(props["created"]?.["format"]).toBe("date-time");
  });

  it("rejects non-object root schemas", () => {
    expect(() => zodToJsonSchema(z.string())).toThrowError(
      expect.objectContaining({
        code: "SCHEMA_NOT_OBJECT",
      }),
    );

    expect(() => zodToJsonSchema(z.array(z.string()))).toThrowError(
      expect.objectContaining({
        code: "SCHEMA_NOT_OBJECT",
      }),
    );
  });

  it("rejects non-Zod input", () => {
    // @ts-expect-error -- testing invalid input
    expect(() => zodToJsonSchema({})).toThrowError(
      expect.objectContaining({
        code: "SCHEMA_LOWERING_FAILED",
      }),
    );
  });

  it("rejects unsupported constructs like z.record with propertyNames", () => {
    const schema = z.object({
      dict: z.record(z.string(), z.string()),
    });

    expect(() => zodToJsonSchema(schema)).toThrowError(
      expect.objectContaining({
        code: "SCHEMA_AUDIT_FAILED",
      }),
    );
  });

  it("rejects recursive schemas with $ref", () => {
    const treeNodeSchema: z.ZodTypeAny = z.lazy(() =>
      z.object({
        val: z.string(),
        children: z.array(treeNodeSchema).optional(),
      }),
    );

    expect(() => zodToJsonSchema(treeNodeSchema)).toThrowError(
      expect.objectContaining({
        code: "SCHEMA_AUDIT_FAILED",
      }),
    );
  });
});

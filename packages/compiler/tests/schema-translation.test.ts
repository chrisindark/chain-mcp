import { describe, expect, it } from "vitest";
import type { CompileDiagnostic } from "../src/types.js";
import {
  translateInputSchema,
  translateOutputSchema,
  type SchemaTranslationContext,
} from "../src/schema.js";

function createContext(overrides: Partial<SchemaTranslationContext> = {}): {
  context: SchemaTranslationContext;
  diagnostics: CompileDiagnostic[];
} {
  const diagnostics: CompileDiagnostic[] = [];
  const context: SchemaTranslationContext = {
    document: { openapi: "3.1.0" },
    version: "3.1",
    strict: false,
    maxRefDepth: 5,
    diagnostics,
    ...overrides,
  };
  return { context, diagnostics };
}

describe("Compiler Schema Translation (translateInputSchema & translateOutputSchema)", () => {
  describe("translateInputSchema validations & composition", () => {
    it("rejects non-object schema with SCHEMA_INVALID", () => {
      const { context, diagnostics } = createContext();
      const res = translateInputSchema("invalid", context);
      expect(res).toBeUndefined();
      expect(diagnostics[0]?.code).toBe("SCHEMA_INVALID");
    });

    it("translates additionalProperties as boolean and object schema", () => {
      const { context } = createContext();
      const boolRes = translateInputSchema(
        { type: "object", additionalProperties: false },
        context,
      );
      expect(boolRes?.additionalProperties).toBe(false);

      const objRes = translateInputSchema(
        {
          type: "object",
          additionalProperties: { type: "string", maxLength: 20 },
        },
        context,
      );
      expect(objRes?.additionalProperties).toEqual({
        type: "string",
        maxLength: 20,
      });
    });

    it("rejects invalid additionalProperties type", () => {
      const { context, diagnostics } = createContext();
      const res = translateInputSchema(
        { type: "object", additionalProperties: 123 },
        context,
      );
      expect(res).toBeUndefined();
      expect(diagnostics[0]?.code).toBe("SCHEMA_UNSUPPORTED");
    });

    it("translates anyOf, oneOf, and not composition keywords", () => {
      const { context } = createContext();
      const res = translateInputSchema(
        {
          anyOf: [{ type: "string" }, { type: "number" }],
          oneOf: [{ minimum: 0 }, { maximum: 100 }],
          not: { type: "null" },
        },
        context,
      );
      expect(res?.anyOf).toEqual([{ type: "string" }, { type: "number" }]);
      expect(res?.oneOf).toEqual([{ minimum: 0 }, { maximum: 100 }]);
      expect(res?.not).toEqual({ type: "null" });
    });

    it("rejects empty or non-array anyOf / oneOf", () => {
      const { context, diagnostics } = createContext();
      const res = translateInputSchema({ anyOf: [] }, context);
      expect(res).toBeUndefined();
      expect(diagnostics[0]?.code).toBe("SCHEMA_INVALID");
    });

    it("translates if, then, else conditional keywords", () => {
      const { context } = createContext();
      const res = translateInputSchema(
        {
          if: { properties: { kind: { const: "admin" } } },
          then: { required: ["adminKey"] },
          else: { required: ["userKey"] },
        },
        context,
      );
      expect(res?.if).toBeDefined();
      expect(res?.then).toBeDefined();
      expect(res?.else).toBeDefined();
    });

    it("translates dependentRequired and dependentSchemas", () => {
      const { context } = createContext();
      const res = translateInputSchema(
        {
          type: "object",
          dependentRequired: { creditCard: ["billingAddress"] },
          dependentSchemas: {
            creditCard: { properties: { cvv: { type: "string" } } },
          },
        },
        context,
      );
      expect(res?.dependentRequired).toEqual({
        creditCard: ["billingAddress"],
      });
      expect(res?.dependentSchemas).toEqual({
        creditCard: { properties: { cvv: { type: "string" } } },
      });
    });

    it("translates propertyNames, contains, minContains, maxContains", () => {
      const { context } = createContext();
      const res = translateInputSchema(
        {
          type: "array",
          contains: { type: "number" },
          minContains: 1,
          maxContains: 5,
          propertyNames: { pattern: "^[a-z]+$" },
        },
        context,
      );
      expect(res?.contains).toEqual({ type: "number" });
      expect(res?.minContains).toBe(1);
      expect(res?.maxContains).toBe(5);
      expect(res?.propertyNames).toEqual({ pattern: "^[a-z]+$" });
    });

    it("translates items tuple form to prefixItems", () => {
      const { context } = createContext();
      const res = translateInputSchema(
        {
          type: "array",
          items: [{ type: "string" }, { type: "number" }],
        },
        context,
      );
      expect(res?.prefixItems).toEqual([
        { type: "string" },
        { type: "number" },
      ]);
    });

    it("translates patternProperties", () => {
      const { context } = createContext();
      const res = translateInputSchema(
        {
          type: "object",
          patternProperties: {
            "^S_": { type: "string" },
            "^I_": { type: "integer" },
          },
        },
        context,
      );
      expect(res?.patternProperties).toEqual({
        "^S_": { type: "string" },
        "^I_": { type: "integer" },
      });
    });

    it("handles pattern validity: drops non-RE2 in permissive mode, fails in strict", () => {
      // permissive mode
      const { context: permContext, diagnostics: permDiag } = createContext({
        strict: false,
      });
      const permRes = translateInputSchema(
        { type: "string", pattern: "(?<=abc)def" }, // lookbehind is invalid in RE2
        permContext,
      );
      expect(permRes?.pattern).toBeUndefined();
      expect(permDiag[0]?.severity).toBe("warning");

      // strict mode
      const { context: strictContext, diagnostics: strictDiag } = createContext(
        { strict: true },
      );
      const strictRes = translateInputSchema(
        { type: "string", pattern: "(?<=abc)def" },
        strictContext,
      );
      expect(strictRes).toBeUndefined();
      expect(strictDiag[0]?.severity).toBe("error");
    });

    it("detects circular $ref and reports REF_CYCLE", () => {
      const doc = {
        components: {
          schemas: {
            Node: {
              type: "object",
              properties: {
                next: { $ref: "#/components/schemas/Node" },
              },
            },
          },
        },
      };
      const { context, diagnostics } = createContext({ document: doc });
      const res = translateInputSchema(
        { $ref: "#/components/schemas/Node" },
        context,
      );
      expect(res).toBeDefined(); // properties.next triggers cycle check
      expect(diagnostics.some((d) => d.code === "REF_CYCLE")).toBe(true);
    });

    it("reports REF_DEPTH_EXCEEDED when ref chain exceeds maxRefDepth", () => {
      const doc = {
        components: {
          schemas: {
            A: { $ref: "#/components/schemas/B" },
            B: { $ref: "#/components/schemas/C" },
            C: { type: "string" },
          },
        },
      };
      const { context, diagnostics } = createContext({
        document: doc,
        maxRefDepth: 1, // shallow depth
      });
      translateInputSchema({ $ref: "#/components/schemas/A" }, context);
      expect(diagnostics.some((d) => d.code === "REF_DEPTH_EXCEEDED")).toBe(
        true,
      );
    });

    it("reports REF_SIBLINGS_UNSUPPORTED when sibling validation keyword conflicts", () => {
      const doc = {
        components: {
          schemas: {
            Target: { type: "string", maxLength: 10 },
          },
        },
      };
      const { context, diagnostics } = createContext({ document: doc });
      translateInputSchema(
        {
          $ref: "#/components/schemas/Target",
          maxLength: 20, // conflicting validation keyword
        },
        context,
      );
      expect(
        diagnostics.some((d) => d.code === "REF_SIBLINGS_UNSUPPORTED"),
      ).toBe(true);
    });

    it("rejects allOf combined with nullable: true in OpenAPI 3.0", () => {
      const { context, diagnostics } = createContext({ version: "3.0" });
      const res = translateInputSchema(
        {
          type: "object",
          allOf: [{ type: "object" }],
          nullable: true,
        },
        context,
      );
      expect(res).toBeUndefined();
      expect(diagnostics[0]?.code).toBe("SCHEMA_COMPOSITION_UNSUPPORTED");
    });
  });

  describe("translateOutputSchema", () => {
    it("omits writeOnly properties in response schemas", () => {
      const { context } = createContext();
      const res = translateOutputSchema(
        {
          type: "object",
          properties: {
            id: { type: "string" },
            password: { type: "string", writeOnly: true },
          },
          required: ["id", "password"],
        },
        context,
      );
      expect(res?.properties).toHaveProperty("id");
      expect(res?.properties).not.toHaveProperty("password");
      expect(res?.required).toEqual(["id"]);
    });

    it("preserves composition and schema structures in output schema", () => {
      const { context } = createContext();
      const res = translateOutputSchema(
        {
          type: "object",
          oneOf: [{ properties: { typeA: { type: "string" } } }],
          anyOf: [{ properties: { typeB: { type: "number" } } }],
          additionalProperties: { type: "boolean" },
          items: { type: "string" },
          prefixItems: [{ type: "number" }],
        },
        context,
      );
      expect(res?.oneOf).toBeDefined();
      expect(res?.anyOf).toBeDefined();
      expect(res?.additionalProperties).toEqual({ type: "boolean" });
      expect(res?.items).toEqual({ type: "string" });
      expect(res?.prefixItems).toEqual([{ type: "number" }]);
    });
  });
});

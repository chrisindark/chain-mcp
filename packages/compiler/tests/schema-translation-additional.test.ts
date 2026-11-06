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

describe("Compiler Schema Translation Additional Coverage", () => {
  describe("translateInputSchema patternProperties and dependencies", () => {
    it("validates patternProperties object and entries", () => {
      const { context: ctx1, diagnostics: diag1 } = createContext();
      const res1 = translateInputSchema(
        { patternProperties: "not an object" },
        ctx1,
      );
      expect(res1).toBeUndefined();
      expect(diag1[0]?.message).toContain(
        "Schema 'patternProperties' must be an object",
      );

      const { context: ctx2, diagnostics: diag2 } = createContext();
      const res2 = translateInputSchema(
        { patternProperties: { "^s_": "not an object schema" } },
        ctx2,
      );
      expect(res2).toBeUndefined();
      expect(diag2[0]?.message).toContain(
        "Schema 'patternProperties' values must be objects",
      );

      const { context: ctx3 } = createContext();
      const res3 = translateInputSchema(
        {
          patternProperties: {
            "^s_": { type: "string" },
            "^n_": { type: "number" },
          },
        },
        ctx3,
      );
      expect(res3?.patternProperties).toEqual({
        "^s_": { type: "string" },
        "^n_": { type: "number" },
      });
    });

    it("validates required array and drops readOnly fields", () => {
      const { context: ctx1, diagnostics: diag1 } = createContext();
      const res1 = translateInputSchema({ required: "not an array" }, ctx1);
      expect(res1).toBeUndefined();
      expect(diag1[0]?.message).toContain(
        "Schema 'required' must be an array of strings",
      );

      const { context: ctx2 } = createContext();
      const res2 = translateInputSchema(
        {
          type: "object",
          properties: {
            id: { type: "string", readOnly: true },
            name: { type: "string" },
          },
          required: ["id", "name"],
        },
        ctx2,
      );
      expect(res2?.properties).toEqual({ name: { type: "string" } });
      expect(res2?.required).toEqual(["name"]);
    });

    it("validates pattern keyword and RE2 syntax", () => {
      const { context: ctx1, diagnostics: diag1 } = createContext();
      const res1 = translateInputSchema({ pattern: 12345 }, ctx1);
      expect(res1).toBeUndefined();
      expect(diag1[0]?.message).toContain("Schema 'pattern' must be a string");

      // Invalid regex in strict mode
      const { context: ctxStrict, diagnostics: diagStrict } = createContext({
        strict: true,
      });
      const resStrict = translateInputSchema(
        { pattern: "(?<=invalid)lookbehind" },
        ctxStrict,
      );
      expect(resStrict).toBeUndefined();
      expect(diagStrict[0]?.code).toBe("SCHEMA_UNSUPPORTED");
      expect(diagStrict[0]?.severity).toBe("error");

      // Invalid regex in permissive mode
      const { context: ctxPermissive, diagnostics: diagPermissive } =
        createContext({ strict: false });
      const resPermissive = translateInputSchema(
        { pattern: "(?<=invalid)lookbehind" },
        ctxPermissive,
      );
      expect(resPermissive).toBeDefined();
      expect(resPermissive?.pattern).toBeUndefined();
      expect(diagPermissive[0]?.severity).toBe("warning");
    });

    it("validates dependentRequired and dependentSchemas", () => {
      const { context: ctx1, diagnostics: diag1 } = createContext();
      const res1 = translateInputSchema({ dependentRequired: "invalid" }, ctx1);
      expect(res1).toBeUndefined();
      expect(diag1[0]?.message).toContain(
        "Schema 'dependentRequired' must be an object",
      );

      const { context: ctx2, diagnostics: diag2 } = createContext();
      const res2 = translateInputSchema({ dependentSchemas: "invalid" }, ctx2);
      expect(res2).toBeUndefined();
      expect(diag2[0]?.message).toContain(
        "Schema 'dependentSchemas' must be an object",
      );

      const { context: ctx3 } = createContext();
      const res3 = translateInputSchema(
        {
          dependentRequired: { creditCard: ["billingAddress"] },
          dependentSchemas: {
            flag: { properties: { extra: { type: "string" } } },
          },
        },
        ctx3,
      );
      expect(res3?.dependentRequired).toEqual({
        creditCard: ["billingAddress"],
      });
      expect(res3?.dependentSchemas).toEqual({
        flag: { properties: { extra: { type: "string" } } },
      });
    });

    it("validates prefixItems array of schemas", () => {
      const { context: ctx1, diagnostics: diag1 } = createContext();
      const res1 = translateInputSchema({ prefixItems: "not an array" }, ctx1);
      expect(res1).toBeUndefined();
      expect(diag1[0]?.message).toContain(
        "Schema 'prefixItems' must be an array of schemas",
      );

      const { context: ctx2 } = createContext();
      const res2 = translateInputSchema(
        {
          prefixItems: [{ type: "string" }, { type: "number" }],
        },
        ctx2,
      );
      expect(res2?.prefixItems).toEqual([
        { type: "string" },
        { type: "number" },
      ]);
    });

    it("rejects unsupported composition and unknown keywords", () => {
      const { context: ctxUneval, diagnostics: diagUneval } = createContext();
      const resUneval = translateInputSchema(
        { unevaluatedProperties: true },
        ctxUneval,
      );
      expect(resUneval).toBeUndefined();
      expect(diagUneval[0]?.code).toBe("SCHEMA_COMPOSITION_UNSUPPORTED");

      const { context: ctxUnknown, diagnostics: diagUnknown } = createContext();
      const resUnknown = translateInputSchema(
        { customUnknownKeyword: 123 },
        ctxUnknown,
      );
      expect(resUnknown).toBeUndefined();
      expect(diagUnknown[0]?.code).toBe("SCHEMA_UNSUPPORTED");
    });
  });

  describe("translateOutputSchema validations & reference resolution", () => {
    it("rejects non-object output schemas", () => {
      const { context, diagnostics } = createContext();
      const res = translateOutputSchema("not an object", context);
      expect(res).toBeUndefined();
      expect(diagnostics[0]?.code).toBe("SCHEMA_INVALID");
    });

    it("drops writeOnly fields in response output schemas and retains readOnly fields", () => {
      const { context } = createContext();
      const res = translateOutputSchema(
        {
          type: "object",
          properties: {
            id: { type: "string", readOnly: true },
            password: { type: "string", writeOnly: true },
            email: { type: "string" },
          },
          required: ["id", "password", "email"],
        },
        context,
      );

      expect(res?.properties).toEqual({
        id: { type: "string", readOnly: true },
        email: { type: "string" },
      });
      expect(res?.required).toEqual(["id", "email"]);
    });

    it("resolves valid output $ref pointers", () => {
      const document = {
        openapi: "3.1.0",
        components: {
          schemas: {
            User: {
              type: "object",
              properties: {
                id: { type: "string" },
                secret: { type: "string", writeOnly: true },
              },
            },
          },
        },
      };

      const { context } = createContext({ document });
      const res = translateOutputSchema(
        { $ref: "#/components/schemas/User" },
        context,
      );

      expect(res?.properties).toEqual({
        id: { type: "string" },
      });
    });

    it("rejects invalid, circular, or non-existent output $refs", () => {
      const document = {
        openapi: "3.1.0",
        components: {
          schemas: {
            CycleA: { $ref: "#/components/schemas/CycleB" },
            CycleB: { $ref: "#/components/schemas/CycleA" },
          },
        },
      };

      // Non-string $ref
      const { context: ctx1, diagnostics: diag1 } = createContext({ document });
      expect(translateOutputSchema({ $ref: 123 }, ctx1)).toBeUndefined();
      expect(diag1[0]?.code).toBe("REF_INVALID");

      // Non-existent $ref
      const { context: ctx2, diagnostics: diag2 } = createContext({ document });
      expect(
        translateOutputSchema({ $ref: "#/components/schemas/NotFound" }, ctx2),
      ).toBeUndefined();
      expect(diag2[0]?.code).toBe("REF_INVALID");

      // Circular $ref
      const { context: ctx3, diagnostics: diag3 } = createContext({ document });
      expect(
        translateOutputSchema({ $ref: "#/components/schemas/CycleA" }, ctx3),
      ).toBeUndefined();
      expect(diag3.some((d) => d.code === "REF_CYCLE")).toBe(true);
    });

    it("translates patternProperties and dependentSchemas in output schemas", () => {
      const { context } = createContext();
      const res = translateOutputSchema(
        {
          patternProperties: {
            "^meta_": { type: "string" },
          },
          dependentSchemas: {
            fieldA: { properties: { fieldB: { type: "number" } } },
          },
        },
        context,
      );

      expect(res?.patternProperties).toEqual({ "^meta_": { type: "string" } });
      expect(res?.dependentSchemas).toEqual({
        fieldA: { properties: { fieldB: { type: "number" } } },
      });
    });
  });
});

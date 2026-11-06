import { describe, expect, it } from "vitest";
import { compileOpenApi } from "../src/compile.js";
import {
  translateInputSchema,
  translateOutputSchema,
  type SchemaTranslationContext,
} from "../src/schema.js";
import type { CompileDiagnostic } from "../src/types.js";

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

describe("Compiler Deep Coverage (schema.ts and compile.ts)", () => {
  describe("translateInputSchema recursion, references, and validation limits", () => {
    it("rejects schemas exceeding MAX_SCHEMA_DEPTH (32)", () => {
      const { context, diagnostics } = createContext();
      let deeplyNested: Record<string, unknown> = { type: "string" };
      for (let i = 0; i < 35; i++) {
        deeplyNested = { type: "object", properties: { child: deeplyNested } };
      }
      translateInputSchema(deeplyNested, context);
      expect(
        diagnostics.some((d) => d.message.includes("maximum depth of 32")),
      ).toBe(true);
    });

    it("rejects circular object references", () => {
      const { context, diagnostics } = createContext();
      const circular: Record<string, unknown> = {
        type: "object",
        properties: {},
      };
      (circular["properties"] as Record<string, unknown>)["self"] = circular;

      translateInputSchema(circular, context);
      expect(
        diagnostics.some((d) => d.message.includes("Schema contains a cycle")),
      ).toBe(true);
    });

    it("validates properties keyword must be an object", () => {
      const { context, diagnostics } = createContext();
      const res = translateInputSchema(
        { type: "object", properties: "invalid" },
        context,
      );
      expect(res).toBeUndefined();
      expect(
        diagnostics.some((d) =>
          d.message.includes("Schema 'properties' must be an object"),
        ),
      ).toBe(true);
    });

    it("validates minContains and maxContains integers", () => {
      const { context: ctx1, diagnostics: diag1 } = createContext();
      const res1 = translateInputSchema(
        { type: "array", minContains: -1 },
        ctx1,
      );
      expect(res1).toBeUndefined();
      expect(diag1[0]?.message).toContain(
        "must be a non-negative safe integer",
      );

      const { context: ctx2, diagnostics: diag2 } = createContext();
      const res2 = translateInputSchema(
        { type: "array", maxContains: "five" },
        ctx2,
      );
      expect(res2).toBeUndefined();
      expect(diag2[0]?.message).toContain(
        "must be a non-negative safe integer",
      );
    });

    it("validates items must be an object or array", () => {
      const { context, diagnostics } = createContext();
      const res = translateInputSchema({ type: "array", items: 123 }, context);
      expect(res).toBeUndefined();
      expect(diagnostics[0]?.message).toContain(
        "Schema 'items' must be an object or an array of schemas",
      );
    });

    it("validates $ref format and resolved target type", () => {
      const { context: ctx1, diagnostics: diag1 } = createContext();
      const res1 = translateInputSchema({ $ref: 12345 }, ctx1);
      expect(res1).toBeUndefined();
      expect(diag1[0]?.message).toContain("Schema '$ref' must be a string");

      const { context: ctx2, diagnostics: diag2 } = createContext({
        document: {
          openapi: "3.1.0",
          components: {
            schemas: {
              invalidTarget: "just a string not an object",
            },
          },
        },
      });
      const res2 = translateInputSchema(
        { $ref: "#/components/schemas/invalidTarget" },
        ctx2,
      );
      expect(res2).toBeUndefined();
      expect(diag2[0]?.message).toContain("must resolve to a schema object");
    });

    it("validates allOf constraints, composition, and flattening", () => {
      // Empty allOf
      const { context: ctx1, diagnostics: diag1 } = createContext();
      const res1 = translateInputSchema({ allOf: [] }, ctx1);
      expect(res1).toBeUndefined();
      expect(diag1[0]?.message).toContain(
        "Schema 'allOf' must be a non-empty array of schemas",
      );

      // allOf combined with nullable: true in OpenAPI 3.0
      const { context: ctx2, diagnostics: diag2 } = createContext({
        version: "3.0",
      });
      const res2 = translateInputSchema(
        { allOf: [{ type: "object" }], type: "object", nullable: true },
        ctx2,
      );
      expect(res2).toBeUndefined();
      expect(diag2[0]?.message).toContain(
        "cannot be combined with 'nullable: true'",
      );

      // Incompatible property schemas in allOf members
      const { context: ctx3, diagnostics: diag3 } = createContext();
      const res3 = translateInputSchema(
        {
          allOf: [
            { type: "object", properties: { id: { type: "string" } } },
            { type: "object", properties: { id: { type: "number" } } },
          ],
        },
        ctx3,
      );
      expect(res3).toBeUndefined();
      expect(diag3[0]?.message).toContain(
        "declare incompatible schemas for property 'id'",
      );

      // Closed member does not declare property in another member
      const { context: ctx4, diagnostics: diag4 } = createContext();
      const res4 = translateInputSchema(
        {
          allOf: [
            {
              type: "object",
              properties: { a: { type: "string" } },
              additionalProperties: false,
            },
            { type: "object", properties: { b: { type: "string" } } },
          ],
        },
        ctx4,
      );
      expect(res4).toBeUndefined();
      expect(diag4[0]?.message).toContain(
        "cannot be flattened because a closed member does not declare property 'b'",
      );
    });
  });

  describe("translateOutputSchema recursion and references", () => {
    it("rejects output schemas exceeding MAX_SCHEMA_DEPTH (32)", () => {
      const { context, diagnostics } = createContext();
      let deeplyNested: Record<string, unknown> = { type: "string" };
      for (let i = 0; i < 35; i++) {
        deeplyNested = { type: "object", properties: { child: deeplyNested } };
      }
      const res = translateOutputSchema(deeplyNested, context);
      expect(res).toBeUndefined();
      expect(
        diagnostics.some((d) => d.message.includes("maximum depth of 32")),
      ).toBe(true);
    });

    it("rejects output circular references", () => {
      const { context, diagnostics } = createContext();
      const circular: Record<string, unknown> = {
        type: "object",
        properties: {},
      };
      (circular["properties"] as Record<string, unknown>)["self"] = circular;

      const res = translateOutputSchema(circular, context);
      expect(res).toBeUndefined();
      expect(
        diagnostics.some((d) => d.message.includes("Schema contains a cycle")),
      ).toBe(true);
    });

    it("validates output properties must be an object", () => {
      const { context, diagnostics } = createContext();
      const res = translateOutputSchema(
        { type: "object", properties: "not-an-object" },
        context,
      );
      expect(res).toBeUndefined();
      expect(
        diagnostics.some((d) =>
          d.message.includes("Schema 'properties' must be an object"),
        ),
      ).toBe(true);
    });

    it("validates output $ref depth and target object", () => {
      const { context: ctx1, diagnostics: diag1 } = createContext({
        maxRefDepth: 1,
        document: {
          openapi: "3.1.0",
          components: {
            schemas: {
              step1: { $ref: "#/components/schemas/step2" },
              step2: { type: "string" },
            },
          },
        },
      });
      const res1 = translateOutputSchema(
        { $ref: "#/components/schemas/step1" },
        ctx1,
      );
      expect(res1).toBeUndefined();
      expect(diag1.some((d) => d.code === "REF_DEPTH_EXCEEDED")).toBe(true);

      const { context: ctx2, diagnostics: diag2 } = createContext({
        document: {
          openapi: "3.1.0",
          components: {
            schemas: {
              invalidTarget: 9999,
            },
          },
        },
      });
      const res2 = translateOutputSchema(
        { $ref: "#/components/schemas/invalidTarget" },
        ctx2,
      );
      expect(res2).toBeUndefined();
      expect(diag2[0]?.message).toContain("must resolve to a schema object");
    });
  });

  describe("compileOpenApi parameter and operation validation branches", () => {
    it("reports error on unsupported operation fields", () => {
      const spec = `
openapi: "3.1.0"
info:
  title: API
  version: "1.0.0"
servers:
  - url: https://api.example.com
paths:
  /test:
    get:
      operationId: getTest
      unsupportedField: "disallowed"
      responses:
        "200":
          description: OK
`;
      const result = compileOpenApi(spec);
      expect(
        result.diagnostics.some(
          (d) =>
            d.code === "OPERATION_INVALID" &&
            d.message.includes("unsupportedField"),
        ),
      ).toBe(true);
    });

    it("validates parameters field must be an array", () => {
      const spec = `
openapi: "3.1.0"
info:
  title: API
  version: "1.0.0"
servers:
  - url: https://api.example.com
paths:
  /test:
    get:
      operationId: getTest
      parameters: "not an array"
      responses:
        "200":
          description: OK
`;
      const result = compileOpenApi(spec);
      expect(result.ok).toBe(false);
      expect(
        result.diagnostics.some(
          (d) =>
            d.code === "PARAMETER_INVALID" &&
            d.message.includes("Parameters must be an array"),
        ),
      ).toBe(true);
    });

    it("validates parameter name, in, and required properties", () => {
      const spec = `
openapi: "3.1.0"
info:
  title: API
  version: "1.0.0"
servers:
  - url: https://api.example.com
paths:
  /empty-name:
    get:
      operationId: emptyName
      parameters:
        - name: ""
          in: query
          schema:
            type: string
      responses:
        "200":
          description: OK
  /invalid-in:
    get:
      operationId: invalidIn
      parameters:
        - name: validName
          in: invalidLocation
          schema:
            type: string
      responses:
        "200":
          description: OK
  /path-not-required:
    get:
      operationId: pathNotRequired
      parameters:
        - name: id
          in: path
          required: false
          schema:
            type: string
      responses:
        "200":
          description: OK
`;
      const result = compileOpenApi(spec);
      expect(result.ok).toBe(false);
      expect(
        result.diagnostics.some((d) =>
          d.message.includes("Parameter 'name' must be a non-empty string"),
        ),
      ).toBe(true);
      expect(
        result.diagnostics.some((d) =>
          d.message.includes(
            "Parameter 'in' must be path, query, header, or cookie",
          ),
        ),
      ).toBe(true);
      expect(
        result.diagnostics.some((d) =>
          d.message.includes("Path parameters must declare required: true"),
        ),
      ).toBe(true);
    });

    it("validates content-encoded parameter media types", () => {
      const spec = `
openapi: "3.1.0"
info:
  title: API
  version: "1.0.0"
servers:
  - url: https://api.example.com
paths:
  /test:
    get:
      operationId: getTest
      parameters:
        - name: xmlParam
          in: query
          content:
            application/xml:
              schema:
                type: string
      responses:
        "200":
          description: OK
`;
      const result = compileOpenApi(spec);
      expect(result.ok).toBe(false);
      expect(
        result.diagnostics.some((d) =>
          d.message.includes(
            "only a single application/json entry is supported",
          ),
        ),
      ).toBe(true);
    });

    it("validates parameter style and explode combinations", () => {
      const spec = `
openapi: "3.1.0"
info:
  title: API
  version: "1.0.0"
servers:
  - url: https://api.example.com
paths:
  /test:
    get:
      operationId: getTest
      parameters:
        - name: cookieParam
          in: cookie
          style: matrix
          schema:
            type: string
        - name: spaceParam
          in: query
          style: spaceDelimited
          explode: true
          schema:
            type: array
            items:
              type: string
        - name: deepParam
          in: query
          style: deepObject
          explode: false
          schema:
            type: object
      responses:
        "200":
          description: OK
`;
      const result = compileOpenApi(spec, { strict: false });
      expect(
        result.diagnostics.some((d) =>
          d.message.includes("specifies unsupported style 'matrix'"),
        ),
      ).toBe(true);
      expect(
        result.diagnostics.some((d) =>
          d.message.includes(
            "unsupported explode: true for style 'spaceDelimited'",
          ),
        ),
      ).toBe(true);
      expect(
        result.diagnostics.some((d) =>
          d.message.includes(
            "unsupported explode: false for style 'deepObject'",
          ),
        ),
      ).toBe(true);
    });

    it("validates allowReserved and allowEmptyValue parameter options", () => {
      const spec = `
openapi: "3.1.0"
info:
  title: API
  version: "1.0.0"
servers:
  - url: https://api.example.com
paths:
  /test:
    get:
      operationId: getTest
      parameters:
        - name: headerParam
          in: header
          allowReserved: true
          schema:
            type: string
        - name: queryReserved
          in: query
          allowReserved: true
          schema:
            type: string
        - name: headerEmpty
          in: header
          allowEmptyValue: true
          schema:
            type: string
      responses:
        "200":
          description: OK
`;
      const result = compileOpenApi(spec, { strict: false });
      expect(
        result.diagnostics.some((d) =>
          d.message.includes(
            "allowReserved is only valid for query parameters",
          ),
        ),
      ).toBe(true);
      expect(
        result.diagnostics.some((d) =>
          d.message.includes("specifies unsupported allowReserved: true"),
        ),
      ).toBe(true);
      expect(
        result.diagnostics.some((d) =>
          d.message.includes(
            "allowEmptyValue is only valid for query parameters",
          ),
        ),
      ).toBe(true);
    });

    it("rejects unsupported composition keyword in parameter schema", () => {
      const spec = `
openapi: "3.1.0"
info:
  title: API
  version: "1.0.0"
servers:
  - url: https://api.example.com
paths:
  /search:
    get:
      operationId: searchItems
      parameters:
        - name: q
          in: query
          required: true
          schema:
            type: string
            unevaluatedProperties: false
      responses:
        "200":
          description: OK
`;
      const result = compileOpenApi(spec, { strict: false });
      expect(result.ok).toBe(false);
      expect(
        result.diagnostics.some(
          (d) =>
            d.code === "SCHEMA_COMPOSITION_UNSUPPORTED" &&
            d.message.includes("unevaluatedProperties"),
        ),
      ).toBe(true);
    });
  });
});

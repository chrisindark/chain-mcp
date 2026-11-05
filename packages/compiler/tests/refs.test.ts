import { describe, expect, it } from "vitest";
import type { CompileDiagnostic } from "../src/types.js";
import {
  resolveExternalPointer,
  resolveLocalPointer,
  resolveObjectReference,
} from "../src/refs.js";

describe("Compiler Reference Resolution (resolveLocalPointer, resolveObjectReference, resolveExternalPointer)", () => {
  describe("resolveLocalPointer", () => {
    const doc = {
      openapi: "3.1.0",
      info: { title: "Test API", version: "1.0.0" },
      paths: {
        "/users": {
          get: { summary: "Get users" },
        },
      },
      components: {
        schemas: {
          User: { type: "object", properties: { id: { type: "string" } } },
          "item/with/slashes": { type: "string" },
          "item~with~tildes": { type: "number" },
        },
      },
      list: [{ name: "first" }, { name: "second" }],
    };

    it("rejects non-string or empty references with REF_INVALID", () => {
      expect(resolveLocalPointer(doc, null)).toEqual({
        ok: false,
        code: "REF_INVALID",
        message: "Reference must be a non-empty string",
      });
      expect(resolveLocalPointer(doc, "")).toEqual({
        ok: false,
        code: "REF_INVALID",
        message: "Reference must be a non-empty string",
      });
      expect(resolveLocalPointer(doc, "   ")).toEqual({
        ok: false,
        code: "REF_INVALID",
        message: "Reference must be a non-empty string",
      });
    });

    it("returns whole document for '#'", () => {
      const res = resolveLocalPointer(doc, "#");
      expect(res).toEqual({ ok: true, value: doc });
    });

    it("rejects remote or non-local references with REF_REMOTE_UNSUPPORTED", () => {
      expect(
        resolveLocalPointer(doc, "https://example.com/schema.json"),
      ).toEqual({
        ok: false,
        code: "REF_REMOTE_UNSUPPORTED",
        message:
          "Remote or non-local reference 'https://example.com/schema.json' is not supported",
      });
      expect(
        resolveLocalPointer(doc, "external.yaml#/components/schemas/Pet"),
      ).toEqual({
        ok: false,
        code: "REF_REMOTE_UNSUPPORTED",
        message:
          "Remote or non-local reference 'external.yaml#/components/schemas/Pet' is not supported",
      });
    });

    it("resolves nested object pointers", () => {
      const res = resolveLocalPointer(doc, "#/components/schemas/User");
      expect(res).toEqual({
        ok: true,
        value: doc.components.schemas.User,
      });
    });

    it("decodes RFC 6901 escaped characters (~1 for /, ~0 for ~)", () => {
      const resSlash = resolveLocalPointer(
        doc,
        "#/components/schemas/item~1with~1slashes",
      );
      expect(resSlash).toEqual({
        ok: true,
        value: { type: "string" },
      });

      const resTilde = resolveLocalPointer(
        doc,
        "#/components/schemas/item~0with~0tildes",
      );
      expect(resTilde).toEqual({
        ok: true,
        value: { type: "number" },
      });
    });

    it("resolves array elements by numeric index", () => {
      const res = resolveLocalPointer(doc, "#/list/1");
      expect(res).toEqual({ ok: true, value: { name: "second" } });
    });

    it("rejects invalid array index syntax or out-of-bounds indices", () => {
      expect(resolveLocalPointer(doc, "#/list/abc")).toEqual({
        ok: false,
        code: "REF_INVALID",
        message: "Reference '#/list/abc' does not resolve to a document value",
      });
      expect(resolveLocalPointer(doc, "#/list/99")).toEqual({
        ok: false,
        code: "REF_INVALID",
        message: "Reference '#/list/99' does not resolve to a document value",
      });
    });

    it("rejects navigation into non-existent properties or primitives", () => {
      expect(
        resolveLocalPointer(doc, "#/components/schemas/NonExistent"),
      ).toEqual({
        ok: false,
        code: "REF_INVALID",
        message:
          "Reference '#/components/schemas/NonExistent' does not resolve to a document value",
      });
      expect(resolveLocalPointer(doc, "#/info/version/subProperty")).toEqual({
        ok: false,
        code: "REF_INVALID",
        message:
          "Reference '#/info/version/subProperty' does not resolve to a document value",
      });
    });
  });

  describe("resolveObjectReference", () => {
    const doc = {
      components: {
        parameters: {
          LimitParam: { name: "limit", in: "query", required: false },
          PrimitiveVal: "not-an-object",
        },
      },
    };

    it("returns value directly if it is an object without $ref", () => {
      const diagnostics: CompileDiagnostic[] = [];
      const val = { name: "offset", in: "query" };
      const res = resolveObjectReference(val, doc, diagnostics, "#/test");
      expect(res).toBe(val);
      expect(diagnostics).toHaveLength(0);
    });

    it("emits diagnostic and returns undefined if value is not an object", () => {
      const diagnostics: CompileDiagnostic[] = [];
      const res = resolveObjectReference("string", doc, diagnostics, "#/test");
      expect(res).toBeUndefined();
      expect(diagnostics).toEqual([
        {
          severity: "error",
          code: "REF_INVALID",
          message: "Value at #/test must be an object",
          location: "#/test",
        },
      ]);
    });

    it("resolves valid $ref and ignores allowed sibling annotations", () => {
      const diagnostics: CompileDiagnostic[] = [];
      const val = {
        $ref: "#/components/parameters/LimitParam",
        description: "Override description",
        summary: "Summary annotation",
        title: "Title annotation",
        example: 10,
        examples: [10, 20],
        $comment: "Internal comment",
        default: 10,
      };
      const res = resolveObjectReference(val, doc, diagnostics, "#/test");
      expect(res).toEqual({ name: "limit", in: "query", required: false });
      expect(diagnostics).toHaveLength(0);
    });

    it("emits REF_SIBLINGS_UNSUPPORTED when unexpected sibling keys are present", () => {
      const diagnostics: CompileDiagnostic[] = [];
      const val = {
        $ref: "#/components/parameters/LimitParam",
        schema: { type: "integer" },
        required: true,
      };
      const res = resolveObjectReference(val, doc, diagnostics, "#/test");
      expect(res).toBeUndefined();
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatchObject({
        severity: "error",
        code: "REF_SIBLINGS_UNSUPPORTED",
      });
      expect(diagnostics[0]?.message).toContain("schema, required");
    });

    it("emits diagnostic when $ref cannot be resolved", () => {
      const diagnostics: CompileDiagnostic[] = [];
      const val = { $ref: "#/components/parameters/UnknownParam" };
      const res = resolveObjectReference(val, doc, diagnostics, "#/test");
      expect(res).toBeUndefined();
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatchObject({
        severity: "error",
        code: "REF_INVALID",
      });
    });

    it("emits diagnostic when $ref resolves to a primitive rather than an object", () => {
      const diagnostics: CompileDiagnostic[] = [];
      const val = { $ref: "#/components/parameters/PrimitiveVal" };
      const res = resolveObjectReference(val, doc, diagnostics, "#/test");
      expect(res).toBeUndefined();
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatchObject({
        severity: "error",
        code: "REF_INVALID",
        message:
          "Reference '#/components/parameters/PrimitiveVal' at #/test must resolve to an object",
      });
    });
  });

  describe("resolveExternalPointer", () => {
    const externalDocs = {
      "https://example.com/common.yaml": {
        components: {
          schemas: {
            ErrorModel: {
              type: "object",
              properties: { code: { type: "number" } },
            },
          },
        },
      },
      "schemas/pet.json": {
        title: "Pet",
        type: "object",
      },
    };

    it("rejects empty or non-string reference", () => {
      expect(resolveExternalPointer(externalDocs, null)).toEqual({
        ok: false,
        code: "REF_INVALID",
        message: "Reference must be a non-empty string",
      });
      expect(resolveExternalPointer(externalDocs, "   ")).toEqual({
        ok: false,
        code: "REF_INVALID",
        message: "Reference must be a non-empty string",
      });
    });

    it("rejects purely local references starting with #", () => {
      expect(
        resolveExternalPointer(externalDocs, "#/components/schemas/Pet"),
      ).toEqual({
        ok: false,
        code: "REF_REMOTE_UNSUPPORTED",
        message:
          "Remote or non-local reference '#/components/schemas/Pet' is not supported",
      });
    });

    it("rejects external documents not supplied in externalDocuments map", () => {
      expect(
        resolveExternalPointer(
          externalDocs,
          "https://unknown.com/schema.yaml#/foo",
        ),
      ).toEqual({
        ok: false,
        code: "REF_REMOTE_UNSUPPORTED",
        message:
          "External document 'https://unknown.com/schema.yaml' was not supplied via CompileOptions.externalDocuments",
      });
    });

    it("resolves pointer into supplied external document", () => {
      const res = resolveExternalPointer(
        externalDocs,
        "https://example.com/common.yaml#/components/schemas/ErrorModel",
      );
      expect(res).toEqual({
        ok: true,
        value: { type: "object", properties: { code: { type: "number" } } },
      });
    });

    it("resolves external document without hash pointer (defaults to entire document '#')", () => {
      const res = resolveExternalPointer(externalDocs, "schemas/pet.json");
      expect(res).toEqual({
        ok: true,
        value: { title: "Pet", type: "object" },
      });
    });
  });
});

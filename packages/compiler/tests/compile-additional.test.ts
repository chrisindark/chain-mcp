import { describe, expect, it } from "vitest";
import {
  compileOpenApi,
  diffManifests,
  type CompileManifest,
  type CompileResult,
} from "../src/index.js";

type ObjectMap = Record<string, unknown>;

function baseDocument(
  paths: ObjectMap,
  extra: ObjectMap = {},
  version = "3.1.0",
): ObjectMap {
  return {
    openapi: version,
    info: { title: "Compiler Test API", version: "1.0.0" },
    paths,
    ...extra,
  };
}

function compileDoc(
  doc: unknown,
  options?: Parameters<typeof compileOpenApi>[1],
): CompileResult {
  return compileOpenApi(JSON.stringify(doc), options);
}

describe("Compiler Additional Features & Edge Cases (compile.ts)", () => {
  describe("Server URL and variable validation", () => {
    it("rejects empty servers array and non-array servers field", () => {
      const res1 = compileDoc(baseDocument({}, { servers: [] }));
      expect(
        res1.diagnostics.some(
          (d) =>
            d.code === "DOCUMENT_INVALID" &&
            d.message.includes("non-empty array"),
        ),
      ).toBe(true);

      const res2 = compileDoc(baseDocument({}, { servers: "not an array" }));
      expect(res2.diagnostics.some((d) => d.code === "DOCUMENT_INVALID")).toBe(
        true,
      );
    });

    it("rejects non-object or missing url in server entries", () => {
      const res = compileDoc(baseDocument({}, { servers: [{ url: 123 }] }));
      expect(
        res.diagnostics.some(
          (d) =>
            d.code === "DOCUMENT_INVALID" &&
            d.message.includes("must be an object with a string 'url'"),
        ),
      ).toBe(true);
    });

    it("validates server variables and enum definitions", () => {
      const res1 = compileDoc(
        baseDocument(
          {},
          {
            servers: [
              { url: "https://api.example.com", variables: "bad variables" },
            ],
          },
        ),
      );
      expect(
        res1.diagnostics.some((d) =>
          d.message.includes("'variables' must be an object"),
        ),
      ).toBe(true);

      const res2 = compileDoc(
        baseDocument(
          {},
          {
            servers: [
              {
                url: "https://api.example.com",
                variables: { env: { default: 123 } },
              },
            ],
          },
        ),
      );
      expect(
        res2.diagnostics.some((d) =>
          d.message.includes("must declare a string 'default'"),
        ),
      ).toBe(true);

      const res3 = compileDoc(
        baseDocument(
          {},
          {
            servers: [
              {
                url: "https://api.example.com",
                variables: { env: { default: "prod", enum: "not an array" } },
              },
            ],
          },
        ),
      );
      expect(
        res3.diagnostics.some((d) =>
          d.message.includes("'enum' must be an array of strings"),
        ),
      ).toBe(true);
    });

    it("rejects server URLs with credentials or non-http protocols", () => {
      const resCreds = compileDoc(
        baseDocument(
          {},
          {
            servers: [{ url: "https://user:password@api.example.com" }],
          },
        ),
      );
      expect(
        resCreds.diagnostics.some(
          (d) =>
            d.code === "DOCUMENT_INVALID" &&
            d.message.includes("without credentials"),
        ),
      ).toBe(true);

      const resFtp = compileDoc(
        baseDocument(
          {},
          {
            servers: [{ url: "ftp://api.example.com/data" }],
          },
        ),
      );
      expect(
        resFtp.diagnostics.some(
          (d) =>
            d.code === "DOCUMENT_INVALID" &&
            d.message.includes("absolute http(s) URL"),
        ),
      ).toBe(true);
    });

    it("accepts server URLs with variable templates and relative URLs", () => {
      const res = compileDoc(
        baseDocument(
          {
            "/items": {
              get: {
                operationId: "getItems",
                responses: { "200": { description: "ok" } },
              },
            },
          },
          {
            servers: [
              {
                url: "https://{env}.example.com/{version}",
                variables: {
                  env: { default: "api", enum: ["api", "stage"] },
                  version: { default: "v1" },
                },
              },
              { url: "/relative/path" },
            ],
          },
        ),
      );
      expect(
        res.diagnostics.filter((d) => d.severity === "error"),
      ).toHaveLength(0);
      expect(res.tools).toHaveLength(1);
    });

    it("rejects relative server URL that contains '://'", () => {
      const res = compileDoc(
        baseDocument(
          {},
          {
            servers: [{ url: "/https://bad.example.com" }],
          },
        ),
      );
      expect(
        res.diagnostics.some(
          (d) =>
            d.code === "DOCUMENT_INVALID" &&
            d.message.includes(
              "must be an absolute http(s) URL or a path-relative",
            ),
        ),
      ).toBe(true);
    });
  });

  describe("Parameter validations and forbidden headers", () => {
    it("rejects forbidden transport and credential headers", () => {
      const res1 = compileDoc(
        baseDocument({
          "/test1": {
            get: {
              operationId: "getTest1",
              parameters: [
                {
                  name: "Authorization",
                  in: "header",
                  required: true,
                  schema: { type: "string" },
                },
              ],
              responses: { "200": { description: "ok" } },
            },
          },
        }),
      );
      expect(
        res1.diagnostics.some(
          (d) =>
            d.code === "PARAMETER_UNSUPPORTED" &&
            d.message.includes("transport- or credential-controlled"),
        ),
      ).toBe(true);

      const res2 = compileDoc(
        baseDocument({
          "/test2": {
            get: {
              operationId: "getTest2",
              parameters: [
                {
                  name: "Content-Length",
                  in: "header",
                  schema: { type: "integer" },
                },
              ],
              responses: { "200": { description: "ok" } },
            },
          },
        }),
      );
      expect(
        res2.diagnostics.some(
          (d) =>
            d.code === "PARAMETER_UNSUPPORTED" &&
            d.message.includes("transport- or credential-controlled"),
        ),
      ).toBe(true);
    });

    it("validates cookie parameter name RFC 6265 token conformance", () => {
      const resInvalid = compileDoc(
        baseDocument({
          "/auth": {
            get: {
              operationId: "authCheck",
              parameters: [
                {
                  name: "invalid cookie name",
                  in: "cookie",
                  schema: { type: "string" },
                },
              ],
              responses: { "200": { description: "ok" } },
            },
          },
        }),
      );
      expect(
        resInvalid.diagnostics.some(
          (d) =>
            d.code === "PARAMETER_INVALID" &&
            d.message.includes("RFC 6265 token"),
        ),
      ).toBe(true);

      const resValid = compileDoc(
        baseDocument({
          "/auth": {
            get: {
              operationId: "authCheck",
              parameters: [
                {
                  name: "session_id.v2",
                  in: "cookie",
                  schema: { type: "string" },
                },
              ],
              responses: { "200": { description: "ok" } },
            },
          },
        }),
      );
      expect(
        resValid.diagnostics.filter((d) => d.severity === "error"),
      ).toHaveLength(0);
      expect(resValid.tools).toHaveLength(1);
    });

    it("detects collisions between parameter 'body' and requestBody", () => {
      const res = compileDoc(
        baseDocument({
          "/items": {
            post: {
              operationId: "createItem",
              parameters: [
                {
                  name: "body",
                  in: "query",
                  schema: { type: "string" },
                },
              ],
              requestBody: {
                required: true,
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: { name: { type: "string" } },
                    },
                  },
                },
              },
              responses: { "200": { description: "ok" } },
            },
          },
        }),
      );
      expect(
        res.diagnostics.some(
          (d) =>
            d.code === "PARAMETER_DUPLICATE" &&
            d.message.includes("collides with a parameter named 'body'"),
        ),
      ).toBe(true);
    });

    it("rejects unsupported parameter content media types", () => {
      const resXml = compileDoc(
        baseDocument({
          "/items": {
            get: {
              operationId: "getItemsXml",
              parameters: [
                {
                  name: "filter",
                  in: "query",
                  content: {
                    "application/xml": { schema: { type: "string" } },
                  },
                },
              ],
              responses: { "200": { description: "ok" } },
            },
          },
        }),
      );
      expect(
        resXml.diagnostics.some(
          (d) =>
            d.code === "PARAMETER_UNSUPPORTED" &&
            d.message.includes(
              "uses unsupported content media type 'application/xml'",
            ),
        ),
      ).toBe(true);

      const resEmpty = compileDoc(
        baseDocument({
          "/items": {
            get: {
              operationId: "getItemsEmpty",
              parameters: [
                {
                  name: "filter",
                  in: "query",
                  content: {},
                },
              ],
              responses: { "200": { description: "ok" } },
            },
          },
        }),
      );
      expect(
        resEmpty.diagnostics.some(
          (d) =>
            d.code === "PARAMETER_UNSUPPORTED" &&
            d.message.includes("Content-encoded parameters are not supported"),
        ),
      ).toBe(true);
    });
  });

  describe("Operation validations and limits", () => {
    it("handles callbacks in strict vs non-strict mode", () => {
      const docWithCallbacks = baseDocument({
        "/webhook": {
          post: {
            operationId: "postWebhook",
            callbacks: {
              myCallback: {},
            },
            responses: { "200": { description: "ok" } },
          },
        },
      });

      const resStrict = compileDoc(docWithCallbacks, { strict: true });
      expect(
        resStrict.diagnostics.some(
          (d) => d.code === "UNSUPPORTED_CALLBACKS" && d.severity === "error",
        ),
      ).toBe(true);
      expect(resStrict.tools).toHaveLength(0);

      const resNonStrict = compileDoc(docWithCallbacks, { strict: false });
      expect(
        resNonStrict.diagnostics.some(
          (d) => d.code === "UNSUPPORTED_CALLBACKS" && d.severity === "warning",
        ),
      ).toBe(true);
      expect(resNonStrict.tools).toHaveLength(1);
    });

    it("validates deprecated operation flag type", () => {
      const res = compileDoc(
        baseDocument({
          "/test": {
            get: {
              operationId: "getTest",
              deprecated: "not a boolean",
              responses: { "200": { description: "ok" } },
            },
          },
        }),
      );
      expect(
        res.diagnostics.some(
          (d) =>
            d.code === "OPERATION_INVALID" &&
            d.message.includes("must be a boolean"),
        ),
      ).toBe(true);
    });

    it("enforces maxOperations limit", () => {
      const paths: ObjectMap = {};
      for (let i = 0; i < 5; i++) {
        paths[`/path-${i}`] = {
          get: {
            operationId: `op_${i}`,
            responses: { "200": { description: "ok" } },
          },
        };
      }
      const res = compileDoc(baseDocument(paths), { maxOperations: 3 });
      expect(
        res.diagnostics.some(
          (d) =>
            d.code === "OPERATION_LIMIT_EXCEEDED" &&
            d.message.includes("exceeds the maximum of 3 operations"),
        ),
      ).toBe(true);
      expect(res.tools.length).toBeLessThanOrEqual(3);
    });

    it("rejects path without leading slash and unsupported path-item keys", () => {
      const resNoSlash = compileDoc(
        baseDocument({
          "invalid-path": {
            get: {
              operationId: "op",
              responses: { "200": { description: "ok" } },
            },
          },
        }),
      );
      expect(
        resNoSlash.diagnostics.some(
          (d) =>
            d.code === "PATH_INVALID" &&
            d.message.includes("must start with '/'"),
        ),
      ).toBe(true);

      const resUnsupportedField = compileDoc(
        baseDocument({
          "/valid": {
            unsupportedKey: "invalid",
            get: {
              operationId: "op",
              responses: { "200": { description: "ok" } },
            },
          },
        }),
      );
      expect(
        resUnsupportedField.diagnostics.some(
          (d) =>
            d.code === "PATH_INVALID" &&
            d.message.includes("Unsupported path-item field"),
        ),
      ).toBe(true);
    });

    it("validates info title and version", () => {
      const resNoTitle = compileDoc({
        openapi: "3.1.0",
        info: { version: "1.0.0" },
        paths: {},
      });
      expect(
        resNoTitle.diagnostics.some(
          (d) =>
            d.code === "DOCUMENT_INVALID" &&
            d.message.includes("'info.title' must be a non-empty string"),
        ),
      ).toBe(true);

      const resNoVersion = compileDoc({
        openapi: "3.1.0",
        info: { title: "API" },
        paths: {},
      });
      expect(
        resNoVersion.diagnostics.some(
          (d) =>
            d.code === "DOCUMENT_INVALID" &&
            d.message.includes("'info.version' must be a non-empty string"),
        ),
      ).toBe(true);
    });
  });

  describe("diffManifests", () => {
    it("throws TypeError if inputs are not version 1 manifests", () => {
      expect(() =>
        diffManifests(
          {} as unknown as CompileManifest,
          {} as unknown as CompileManifest,
        ),
      ).toThrow("Both manifests must be version 1 manifests");
      expect(() =>
        diffManifests(
          { manifestVersion: 2, tools: [] } as unknown as CompileManifest,
          { manifestVersion: 1, tools: [] } as unknown as CompileManifest,
        ),
      ).toThrow("Both manifests must be version 1 manifests");
    });

    it("accurately categorizes added, removed, changed, and unchanged tools", () => {
      const prev: CompileManifest = {
        manifestVersion: 1,
        compilerVersion: "0.2.0",
        openapiVersion: "3.1",
        sourceHash: "hash1",
        contractRevision: "rev-1",
        toolsetHash: "ts1",
        toolCount: 3,
        tools: [
          {
            name: "keptSame",
            hash: "sameHash",
          },
          {
            name: "willChange",
            hash: "oldHash",
          },
          {
            name: "willRemove",
            hash: "delHash",
          },
        ],
      };

      const next: CompileManifest = {
        manifestVersion: 1,
        compilerVersion: "0.2.0",
        openapiVersion: "3.1",
        sourceHash: "hash2",
        contractRevision: "rev-2",
        toolsetHash: "ts2",
        toolCount: 3,
        tools: [
          {
            name: "keptSame",
            hash: "sameHash",
          },
          {
            name: "willChange",
            hash: "newHash",
          },
          {
            name: "brandNew",
            hash: "newToolHash",
          },
        ],
      };

      const diff = diffManifests(prev, next);
      expect(diff).toEqual({
        added: ["brandNew"],
        removed: ["willRemove"],
        changed: ["willChange"],
        unchanged: ["keptSame"],
      });
    });
  });
});

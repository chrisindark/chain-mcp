import { describe, expect, it } from "vitest";
import type { CompiledOperation } from "@chainmcp/compiler";
import { RuntimeError } from "@chainmcp/core";
import {
  createUpstreamExecutor,
  isReservedRequestHeader,
  isValidRequestHeaderName,
  serializeFormUrlEncoded,
  serializeMultipartFormData,
  classifyAddress,
  type UpstreamExecutorOptions,
  type UpstreamTransport,
  type UpstreamTransportResponse,
} from "../src/index.js";

const context = {
  requestId: "req-1",
  tenantId: "tenant-1",
  principal: { id: "user-1", scopes: [] },
};

function baseOp(overrides: Partial<CompiledOperation> = {}): CompiledOperation {
  return {
    name: "testOp",
    description: "Deep coverage test op",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: true,
    },
    operation: {},
    method: "get",
    path: "/items",
    readOnly: true,
    deprecated: false,
    parameters: [],
    responses: [],
    security: [],
    authentication: { alternatives: [], allowsAnonymous: true },
    sourceLocation: "#/paths/~1items/get",
    ...overrides,
  };
}

function jsonResponse(
  body: unknown = { ok: true },
  status = 200,
  headers: Record<string, string> = { "content-type": "application/json" },
): UpstreamTransportResponse {
  return {
    status,
    headers,
    body: Buffer.from(JSON.stringify(body)),
  };
}

function makeOptions(
  transport: UpstreamTransport,
  overrides: Partial<UpstreamExecutorOptions> = {},
): UpstreamExecutorOptions {
  return {
    baseUrl: "https://api.example.com",
    allowedHosts: ["api.example.com"],
    resolveHost: async () => ["8.8.8.8"],
    transport,
    contractRevision: "rev-1",
    ...overrides,
  };
}

function getCauseMessage(err: unknown): string {
  if (err instanceof RuntimeError) {
    return (err.cause as Error | undefined)?.message ?? err.message;
  }
  return (err as Error).message;
}

describe("Executor Deep Coverage", () => {
  describe("Header syntax and reserved checks", () => {
    it("identifies reserved request headers", () => {
      expect(isReservedRequestHeader("authorization")).toBe(true);
      expect(isReservedRequestHeader("Authorization")).toBe(true);
      expect(isReservedRequestHeader("Host")).toBe(true);
      expect(isReservedRequestHeader("content-length")).toBe(true);
      expect(isReservedRequestHeader("x-custom-header")).toBe(false);
    });

    it("validates RFC 7230 header field-name syntax", () => {
      expect(isValidRequestHeaderName("X-Api-Key")).toBe(true);
      expect(isValidRequestHeaderName("Content-Type")).toBe(true);
      expect(isValidRequestHeaderName("Bad Header")).toBe(false);
      expect(isValidRequestHeaderName("Header:Colon")).toBe(false);
      expect(isValidRequestHeaderName("")).toBe(false);
    });
  });

  describe("normalizeOptions validation", () => {
    const dummyTransport: UpstreamTransport = {
      request: async () => jsonResponse(),
    };

    it("rejects non-object options", () => {
      expect(() =>
        createUpstreamExecutor(null as unknown as UpstreamExecutorOptions),
      ).toThrow(/Executor options must be an object/);
      expect(() =>
        createUpstreamExecutor([] as unknown as UpstreamExecutorOptions),
      ).toThrow(/Executor options must be an object/);
      expect(() =>
        createUpstreamExecutor("invalid" as unknown as UpstreamExecutorOptions),
      ).toThrow(/Executor options must be an object/);
    });

    it("rejects invalid baseUrl formats", () => {
      expect(() =>
        createUpstreamExecutor(
          makeOptions(dummyTransport, { baseUrl: "not-a-url" }),
        ),
      ).toThrow(/Executor baseUrl must be an absolute URL/);

      expect(() =>
        createUpstreamExecutor(
          makeOptions(dummyTransport, {
            baseUrl: "https://user:pass@api.example.com",
          }),
        ),
      ).toThrow(/Executor baseUrl must not contain credentials/);

      expect(() =>
        createUpstreamExecutor(
          makeOptions(dummyTransport, { baseUrl: "ftp://api.example.com" }),
        ),
      ).toThrow(/Executor baseUrl must use HTTP or HTTPS/);

      expect(() =>
        createUpstreamExecutor(
          makeOptions(dummyTransport, {
            baseUrl: "https://api.example.com?query=1",
          }),
        ),
      ).toThrow(/Executor baseUrl must not contain a query or fragment/);

      expect(() =>
        createUpstreamExecutor(
          makeOptions(dummyTransport, {
            baseUrl: "https://api.example.com#hash",
          }),
        ),
      ).toThrow(/Executor baseUrl must not contain a query or fragment/);

      expect(() =>
        createUpstreamExecutor(
          makeOptions(dummyTransport, { baseUrl: "https://api.example.com:0" }),
        ),
      ).toThrow(/Executor baseUrl port is invalid/);
    });

    it("validates allowInsecureHttp flag and protocol match", () => {
      expect(() =>
        createUpstreamExecutor(
          makeOptions(dummyTransport, {
            allowInsecureHttp: "yes" as unknown as boolean,
          }),
        ),
      ).toThrow(/Executor option 'allowInsecureHttp' must be a boolean/);

      expect(() =>
        createUpstreamExecutor(
          makeOptions(dummyTransport, {
            baseUrl: "http://api.example.com",
            allowInsecureHttp: false,
          }),
        ),
      ).toThrow(/Executor baseUrl uses HTTP; set allowInsecureHttp to opt in/);
    });

    it("validates allowedHosts array and host membership", () => {
      expect(() =>
        createUpstreamExecutor(
          makeOptions(dummyTransport, {
            allowedHosts: [] as unknown as string[],
          }),
        ),
      ).toThrow(/Executor option 'allowedHosts' must be a non-empty array/);

      expect(() =>
        createUpstreamExecutor(
          makeOptions(dummyTransport, {
            allowedHosts: "api.example.com" as unknown as string[],
          }),
        ),
      ).toThrow(/Executor option 'allowedHosts' must be a non-empty array/);

      expect(() =>
        createUpstreamExecutor(
          makeOptions(dummyTransport, { allowedHosts: ["other.example.com"] }),
        ),
      ).toThrow(/Executor baseUrl host must be allowlisted/);
    });

    it("supports IPv6 bracketed hosts in baseUrl", () => {
      const executor = createUpstreamExecutor({
        baseUrl: "http://[::1]:8080",
        allowedHosts: ["::1"],
        allowInsecureHttp: true,
        resolveHost: async () => ["::1"],
        transport: dummyTransport,
        contractRevision: "rev-1",
      });
      expect(executor).toBeDefined();
    });

    it("validates ownerTenantId, credentialProvider, and validateResponses", () => {
      expect(() =>
        createUpstreamExecutor(
          makeOptions(dummyTransport, { ownerTenantId: "   " }),
        ),
      ).toThrow(/Executor option 'ownerTenantId' must be a non-empty string/);

      expect(() =>
        createUpstreamExecutor(
          makeOptions(dummyTransport, {
            credentialProvider: "bad" as unknown as NonNullable<
              UpstreamExecutorOptions["credentialProvider"]
            >,
          }),
        ),
      ).toThrow(
        /Executor option 'credentialProvider' must be an object with resolveCredential/,
      );

      expect(() =>
        createUpstreamExecutor(
          makeOptions(dummyTransport, {
            validateResponses: "invalid-mode" as unknown as NonNullable<
              UpstreamExecutorOptions["validateResponses"]
            >,
          }),
        ),
      ).toThrow(
        /Executor option 'validateResponses' must be 'off', 'warn', or 'enforce'/,
      );
    });
  });

  describe("validateOperation checks", () => {
    const dummyTransport: UpstreamTransport = {
      request: async () => jsonResponse(),
    };
    const executor = createUpstreamExecutor(makeOptions(dummyTransport));

    it("rejects non-object operations", () => {
      expect(() =>
        executor.createTool(null as unknown as CompiledOperation),
      ).toThrow(/Compiled operation must be an object/);
    });

    it("rejects missing or empty operation name", () => {
      expect(() => executor.createTool(baseOp({ name: "" }))).toThrow(
        /Compiled operation requires a name/,
      );
    });

    it("rejects non-string method or unsupported HTTP methods", () => {
      expect(() =>
        executor.createTool(
          baseOp({ method: 123 as unknown as CompiledOperation["method"] }),
        ),
      ).toThrow(/Compiled operation method must be a string/);

      expect(() =>
        executor.createTool(
          baseOp({
            method: "INVALID" as unknown as CompiledOperation["method"],
          }),
        ),
      ).toThrow(/Compiled operation method is not supported/);
    });

    it("rejects paths not starting with / or containing ? or #", () => {
      expect(() => executor.createTool(baseOp({ path: "items" }))).toThrow(
        /Compiled operation path must start with '\/'/,
      );

      expect(() =>
        executor.createTool(baseOp({ path: "/items?filter=1" })),
      ).toThrow(/Compiled operation path must not contain a query or fragment/);

      expect(() =>
        executor.createTool(baseOp({ path: "/items#frag" })),
      ).toThrow(/Compiled operation path must not contain a query or fragment/);
    });

    it("rejects invalid operation parameter metadata", () => {
      expect(() =>
        executor.createTool(
          baseOp({
            parameters:
              "not-array" as unknown as CompiledOperation["parameters"],
          }),
        ),
      ).toThrow(/Compiled operation requires parameter metadata/);

      expect(() =>
        executor.createTool(
          baseOp({
            parameters: [{ name: "", in: "query", required: true }],
          }),
        ),
      ).toThrow(/Compiled operation has invalid parameter metadata/);

      expect(() =>
        executor.createTool(
          baseOp({
            parameters: [
              {
                name: "p1",
                in: "body" as unknown as "query",
                required: true,
              },
            ],
          }),
        ),
      ).toThrow(/Compiled operation has invalid parameter metadata/);
    });

    it("rejects invalid request body metadata", () => {
      expect(() =>
        executor.createTool(
          baseOp({
            requestBody: {
              mediaType: 123 as unknown as string,
              required: true,
            },
          }),
        ),
      ).toThrow(/Compiled operation has invalid request body metadata/);
    });
  });

  describe("Request building & parameter encoding edge cases", () => {
    it("rejects non-object input", async () => {
      const dummyTransport: UpstreamTransport = {
        request: async () => jsonResponse(),
      };
      const executor = createUpstreamExecutor(makeOptions(dummyTransport));
      const tool = executor.createTool(baseOp());

      const err = await tool
        .execute("not-an-object" as unknown as Record<string, unknown>, context)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RuntimeError);
      expect(getCauseMessage(err)).toContain("Input must be an object");
    });

    it("rejects undeclared or missing path parameters", async () => {
      const dummyTransport: UpstreamTransport = {
        request: async () => jsonResponse(),
      };
      const executor = createUpstreamExecutor(makeOptions(dummyTransport));

      // Path has {id} but parameters does not declare it
      const tool1 = executor.createTool(baseOp({ path: "/items/{id}" }));
      const err1 = await tool1
        .execute({ id: "123" }, context)
        .catch((e: unknown) => e);
      expect(getCauseMessage(err1)).toContain(
        "Operation path has an undeclared parameter",
      );

      // Declared path parameter missing in input
      const tool2 = executor.createTool(
        baseOp({
          path: "/items/{id}",
          parameters: [{ name: "id", in: "path", required: true }],
        }),
      );
      const err2 = await tool2.execute({}, context).catch((e: unknown) => e);
      expect(getCauseMessage(err2)).toContain("Path parameter is missing");
    });

    it("rejects invalid path parameter syntax, backslashes, control characters, or dot segments", async () => {
      const dummyTransport: UpstreamTransport = {
        request: async () => jsonResponse(),
      };
      const executor = createUpstreamExecutor(makeOptions(dummyTransport));

      // Operation path with backslash
      const toolBackslash = executor.createTool(
        baseOp({ path: "/items\\bad" }),
      );
      const errBackslash = await toolBackslash
        .execute({}, context)
        .catch((e: unknown) => e);
      expect(getCauseMessage(errBackslash)).toContain(
        "Operation path contains invalid characters",
      );

      // Dot segments in path parameter
      const tool = executor.createTool(
        baseOp({
          path: "/items/{id}",
          parameters: [{ name: "id", in: "path", required: true }],
        }),
      );
      const errDot = await tool
        .execute({ id: ".." }, context)
        .catch((e: unknown) => e);
      expect(getCauseMessage(errDot)).toContain(
        "Operation path contains a dot segment",
      );
    });

    it("rejects unexpected body input when operation accepts no request body", async () => {
      const dummyTransport: UpstreamTransport = {
        request: async () => jsonResponse(),
      };
      const executor = createUpstreamExecutor(makeOptions(dummyTransport));
      const tool = executor.createTool(baseOp());

      const err = await tool
        .execute({ body: { name: "test" } }, context)
        .catch((e: unknown) => e);
      expect(getCauseMessage(err)).toContain(
        "Operation does not accept a request body",
      );
    });

    it("handles cookie parameters: object serialization, primitives, and missing required checks", async () => {
      let capturedHeaders: Record<string, string> = {};
      const transport: UpstreamTransport = {
        request: async (req) => {
          capturedHeaders = req.headers;
          return jsonResponse();
        },
      };
      const executor = createUpstreamExecutor(makeOptions(transport));

      const tool = executor.createTool(
        baseOp({
          parameters: [
            { name: "session", in: "cookie", required: false },
            { name: "prefs", in: "cookie", required: false },
          ],
        }),
      );

      // Valid cookie with object value & number/boolean primitives
      await tool.execute(
        {
          session: "abc123",
          prefs: { theme: "dark", count: 42, active: true },
        },
        context,
      );

      expect(capturedHeaders["cookie"]).toContain("session=abc123");
      expect(capturedHeaders["cookie"]).toContain(
        "theme,dark,count,42,active,true",
      );

      // Missing required cookie
      const toolReq = executor.createTool(
        baseOp({
          parameters: [{ name: "token", in: "cookie", required: true }],
        }),
      );
      const errMissing = await toolReq
        .execute({}, context)
        .catch((e: unknown) => e);
      expect(getCauseMessage(errMissing)).toContain(
        "Cookie parameter is missing",
      );

      // Cookie value containing invalid semicolon or newline
      const errInvalidChar = await toolReq
        .execute({ token: "abc;def" }, context)
        .catch((e: unknown) => e);
      expect(getCauseMessage(errInvalidChar)).toContain(
        "contains invalid characters",
      );

      // Non-primitive cookie value (symbol)
      const errNonPrim = await toolReq
        .execute({ token: Symbol("bad") as unknown as string }, context)
        .catch((e: unknown) => e);
      expect(getCauseMessage(errNonPrim)).toContain(
        "must be a string, number, or boolean",
      );
    });

    it("rejects request body JSON serialization failure (BigInt)", async () => {
      const dummyTransport: UpstreamTransport = {
        request: async () => jsonResponse(),
      };
      const executor = createUpstreamExecutor(makeOptions(dummyTransport));
      const tool = executor.createTool(
        baseOp({
          method: "post",
          requestBody: { mediaType: "application/json", required: true },
        }),
      );

      const err = await tool
        .execute({ body: { big: 10n } }, context)
        .catch((e: unknown) => e);
      expect(getCauseMessage(err)).toContain(
        "Request body could not be serialized",
      );
    });
  });

  describe("Form URL-encoded and Multipart serialization", () => {
    it("validates serializeFormUrlEncoded inputs", () => {
      expect(() =>
        serializeFormUrlEncoded("bad" as unknown as Record<string, unknown>),
      ).toThrow(
        /Request body must be an object for application\/x-www-form-urlencoded/,
      );
      expect(() =>
        serializeFormUrlEncoded(null as unknown as Record<string, unknown>),
      ).toThrow(
        /Request body must be an object for application\/x-www-form-urlencoded/,
      );

      // Primitive types, null, prototype skip
      const encoded = serializeFormUrlEncoded({
        str: "hello world",
        num: 123,
        flag: true,
        empty: null,
        __proto__: { hacked: true },
      });
      const decoded = new TextDecoder().decode(encoded);
      expect(decoded).toContain("str=hello%20world");
      expect(decoded).toContain("num=123");
      expect(decoded).toContain("flag=true");
      expect(decoded).toContain("empty=");
      expect(decoded).not.toContain("hacked");
    });

    it("validates serializeMultipartFormData inputs and part options", () => {
      expect(() =>
        serializeMultipartFormData("bad" as unknown as Record<string, unknown>),
      ).toThrow(/Request body must be an object for multipart\/form-data/);

      // Invalid boundary
      expect(() =>
        serializeMultipartFormData({}, undefined, 1000, 1000, "bad\rboundary"),
      ).toThrow(/Multipart boundary is invalid/);

      // Part name with invalid characters
      expect(() => serializeMultipartFormData({ 'bad"name': "val" })).toThrow(
        /contains invalid characters/,
      );

      // Part with Uint8Array, base64 data object, JSON object, primitives
      const result = serializeMultipartFormData({
        file1: new Uint8Array([1, 2, 3]),
        file2: {
          filename: "test.txt",
          contentType: "text/plain",
          data: "SGVsbG8=",
          encoding: "base64",
        },
        payload: { nested: "json", count: 5 },
        str: "plain text",
        num: 99,
        __proto__: { bad: true },
      });

      expect(result.contentType).toContain("multipart/form-data; boundary=");
      const text = new TextDecoder().decode(result.body);
      expect(text).toContain('name="file1"');
      expect(text).toContain("application/octet-stream");
      expect(text).toContain('filename="test.txt"');
      expect(text).toContain("text/plain");
      expect(text).toContain("Hello");
      expect(text).toContain('name="payload"');
      expect(text).toContain("application/json");
      expect(text).toContain('name="str"');
      expect(text).toContain("plain text");
      expect(text).toContain('name="num"');
      expect(text).toContain("99");
      expect(text).not.toContain("bad");
    });

    it("rejects invalid multipart part content and filenames", () => {
      // Filename with newline
      expect(() =>
        serializeMultipartFormData({
          file: { filename: "bad\nname.txt", content: "data" },
        }),
      ).toThrow(/Multipart filename contains invalid characters/);

      // Invalid part content (neither string nor Uint8Array)
      expect(() =>
        serializeMultipartFormData({
          file: { data: 12345 },
        }),
      ).toThrow(/content must be a string or Uint8Array/);

      // Part Content-Type with control char
      expect(() =>
        serializeMultipartFormData({
          file: { content: "test", contentType: "bad\r\ntype" },
        }),
      ).toThrow(/Content-Type contains invalid characters/);

      // Part exceeding maxMultipartPartBytes
      expect(() =>
        serializeMultipartFormData(
          { large: new Uint8Array(100) },
          undefined,
          50, // maxMultipartPartBytes
          1000,
        ),
      ).toThrow(/exceeded the size limit/);
    });
  });

  describe("Execution lifecycle, redirects, cancellation, and response handling", () => {
    it("aborts immediately when context.signal is already aborted", async () => {
      const dummyTransport: UpstreamTransport = {
        request: async () => jsonResponse(),
      };
      const executor = createUpstreamExecutor(makeOptions(dummyTransport));
      const tool = executor.createTool(baseOp());

      const controller = new AbortController();
      controller.abort(new Error("Manual abort"));

      const err = await tool
        .execute({}, { ...context, signal: controller.signal })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RuntimeError);
      expect((err as RuntimeError).code).toBe("CANCELLED");
      expect((err as RuntimeError).message).toBe("Tool call was cancelled");
    });

    it("handles 301/302 redirect for POST by switching method to GET and dropping body", async () => {
      let step = 0;
      let secondMethod = "";
      let secondBody: unknown = "unset";

      const transport: UpstreamTransport = {
        request: async (req) => {
          step++;
          if (step === 1) {
            return {
              status: 302,
              headers: { location: "/redirected" },
              body: Buffer.from(""),
            };
          }
          secondMethod = req.method;
          secondBody = req.body;
          return jsonResponse({ redirected: true });
        },
      };

      const executor = createUpstreamExecutor(makeOptions(transport));
      const tool = executor.createTool(
        baseOp({
          method: "post",
          requestBody: { mediaType: "application/json", required: false },
        }),
      );

      const result = await tool.execute({ body: { foo: "bar" } }, context);

      expect(result).toEqual({ redirected: true });
      expect(secondMethod).toBe("GET");
      expect(secondBody).toBeUndefined();
    });

    it("rejects upstream redirect with empty location or invalid location URL", async () => {
      const emptyLocationTransport: UpstreamTransport = {
        request: async () => ({
          status: 302,
          headers: { location: "   " },
          body: Buffer.from(""),
        }),
      };
      const executor1 = createUpstreamExecutor(
        makeOptions(emptyLocationTransport),
      );
      const tool1 = executor1.createTool(baseOp());
      const err1 = await tool1.execute({}, context).catch((e: unknown) => e);
      expect(err1).toBeInstanceOf(RuntimeError);
      expect(getCauseMessage(err1)).toContain(
        "Upstream redirect had no location",
      );

      const invalidLocationTransport: UpstreamTransport = {
        request: async () => ({
          status: 302,
          headers: { location: "http://[invalid:ipv6" },
          body: Buffer.from(""),
        }),
      };
      const executor2 = createUpstreamExecutor(
        makeOptions(invalidLocationTransport),
      );
      const tool2 = executor2.createTool(baseOp());
      const err2 = await tool2.execute({}, context).catch((e: unknown) => e);
      expect(err2).toBeInstanceOf(RuntimeError);
      expect(getCauseMessage(err2)).toContain(
        "Upstream redirect location is invalid",
      );
    });

    it("rejects non-UTF-8 response body", async () => {
      const badUtf8Transport: UpstreamTransport = {
        request: async () => ({
          status: 200,
          headers: { "content-type": "application/json" },
          // 0xFF 0xFF is invalid UTF-8
          body: Buffer.from([0xff, 0xff]),
        }),
      };
      const executor = createUpstreamExecutor(makeOptions(badUtf8Transport));
      const tool = executor.createTool(baseOp());
      const err = await tool.execute({}, context).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RuntimeError);
      expect(getCauseMessage(err)).toContain(
        "Upstream response is not valid UTF-8",
      );
    });

    it("matches 'default' status schema fallback in response validation", async () => {
      let loggedWarning = false;
      const transport: UpstreamTransport = {
        request: async () => jsonResponse({ unknownField: true }, 202),
      };
      const executor = createUpstreamExecutor(
        makeOptions(transport, {
          validateResponses: "warn",
          logger: {
            debug: () => {},
            info: () => {},
            warn: (msg) => {
              if (msg.includes("did not match response schema"))
                loggedWarning = true;
            },
            error: () => {},
            audit: () => {
              throw new Error("Audit log failure should not alter execution");
            },
          },
        }),
      );

      const opWithDefault = baseOp({
        responses: [
          {
            status: "default",
            description: "Default response schema",
            mediaType: "application/json",
            schema: {
              type: "object",
              properties: { expectedField: { type: "string" } },
              required: ["expectedField"],
            },
          },
        ],
      });

      const tool = executor.createTool(opWithDefault);
      const res = await tool.execute({}, context);
      expect(res).toEqual({ unknownField: true });
      expect(loggedWarning).toBe(true);
    });
  });

  describe("classifyAddress special ranges", () => {
    it("identifies NAT64 prefix as reserved", () => {
      // 64:ff9b::1 is NAT64 well-known prefix
      expect(classifyAddress("64:ff9b::1")).toBe("reserved");
    });

    it("identifies IPv6 address outside 2000::/3 as reserved", () => {
      // 4000::1 is outside global unicast prefix
      expect(classifyAddress("4000::1")).toBe("reserved");
    });
  });
});

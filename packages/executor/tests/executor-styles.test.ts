import { describe, expect, it } from "vitest";
import type { CompiledOperation } from "@chainmcp/compiler";
import { RuntimeError } from "@chainmcp/core";
import {
  createUpstreamExecutor,
  type UpstreamExecutorOptions,
  type UpstreamTransport,
  type UpstreamTransportRequest,
  type UpstreamTransportResponse,
} from "../src/index.js";

const context = {
  requestId: "req-1",
  tenantId: "tenant-1",
  principal: { id: "user-1", scopes: [] },
};

function baseOp(overrides: Partial<CompiledOperation> = {}): CompiledOperation {
  return {
    name: "testStyleOp",
    description: "Style test op",
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

function jsonResponse(body: unknown = { ok: true }): UpstreamTransportResponse {
  return {
    status: 200,
    headers: { "content-type": "application/json" },
    body: Buffer.from(JSON.stringify(body)),
  };
}

function makeOptions(
  transport: UpstreamTransport,
  overrides: Partial<UpstreamExecutorOptions> = {},
): UpstreamExecutorOptions {
  return {
    baseUrl: "https://api.example.com",
    allowedHosts: [
      "api.example.com",
      "fallback.example.com",
      "default.example.com",
    ],
    resolveHost: async () => ["8.8.8.8"],
    transport,
    contractRevision: "rev-1",
    ...overrides,
  };
}

async function expectBuildFailure(
  promise: Promise<unknown>,
  causeMessage: string,
): Promise<void> {
  const err: unknown = await promise.catch((e) => e);
  expect(err).toBeInstanceOf(RuntimeError);
  const runtimeErr = err as RuntimeError;
  expect(runtimeErr.code).toBe("UPSTREAM_FAILURE");
  expect(runtimeErr.message).toBe("Upstream request could not be constructed");
  expect((runtimeErr.cause as Error | undefined)?.message).toContain(
    causeMessage,
  );
}

describe("Executor Operation Server Overrides & Parameter Styles", () => {
  describe("Operation server overrides (resolveEffectiveBaseUrl)", () => {
    it("substitutes server variables and uses operation server", async () => {
      let capturedUrl = "";
      const transport: UpstreamTransport = {
        request: async (req: UpstreamTransportRequest) => {
          capturedUrl = req.url.toString();
          return jsonResponse();
        },
      };

      const executor = createUpstreamExecutor(
        makeOptions(transport, {
          allowedHosts: ["api.example.com"],
        }),
      );

      const op = baseOp({
        servers: [
          {
            url: "https://{env}.example.com:{port}/v1",
            variables: {
              env: { default: "api" },
              port: { default: "443" },
            },
          },
        ],
      });

      const tool = executor.createTool(op);
      await tool.execute({}, context);
      expect(capturedUrl).toContain("https://api.example.com/v1/items");
    });

    it("resolves relative server URLs against the fallback base URL", async () => {
      let capturedUrl = "";
      const transport: UpstreamTransport = {
        request: async (req: UpstreamTransportRequest) => {
          capturedUrl = req.url.toString();
          return jsonResponse();
        },
      };

      const executor = createUpstreamExecutor(
        makeOptions(transport, {
          baseUrl: "https://fallback.example.com/api",
        }),
      );

      const op = baseOp({
        servers: [{ url: "/v2/prefix" }],
      });

      const tool = executor.createTool(op);
      await tool.execute({}, context);
      expect(capturedUrl).toBe("https://fallback.example.com/v2/prefix/items");
    });

    it("rejects server URL containing user/password credentials", async () => {
      const transport: UpstreamTransport = {
        request: async () => jsonResponse(),
      };
      const executor = createUpstreamExecutor(makeOptions(transport));

      const op = baseOp({
        servers: [{ url: "https://user:pass@evil.example.com" }],
      });

      const tool = executor.createTool(op);
      await expectBuildFailure(
        tool.execute({}, context),
        "Operation server URL must not contain credentials",
      );
    });

    it("rejects non-HTTP server protocol", async () => {
      const transport: UpstreamTransport = {
        request: async () => jsonResponse(),
      };
      const executor = createUpstreamExecutor(makeOptions(transport));

      const op = baseOp({
        servers: [{ url: "ftp://files.example.com" }],
      });

      const tool = executor.createTool(op);
      await expectBuildFailure(
        tool.execute({}, context),
        "Operation server URL must use HTTP or HTTPS",
      );
    });

    it("rejects HTTP server protocol when allowInsecureHttp is false", async () => {
      const transport: UpstreamTransport = {
        request: async () => jsonResponse(),
      };
      const executor = createUpstreamExecutor(
        makeOptions(transport, { allowInsecureHttp: false }),
      );

      const op = baseOp({
        servers: [{ url: "http://insecure.example.com" }],
      });

      const tool = executor.createTool(op);
      await expectBuildFailure(
        tool.execute({}, context),
        "Operation server URL uses HTTP; set allowInsecureHttp to opt in",
      );
    });

    it("rejects unparseable server URL", async () => {
      const transport: UpstreamTransport = {
        request: async () => jsonResponse(),
      };
      const executor = createUpstreamExecutor(makeOptions(transport));

      const op = baseOp({
        servers: [{ url: "https://[invalid-host:abc" }],
      });

      const tool = executor.createTool(op);
      await expectBuildFailure(
        tool.execute({}, context),
        "Operation server URL could not be built",
      );
    });
  });

  describe("Path parameter styles (label, matrix, simple)", () => {
    let capturedUrl = "";
    const transport: UpstreamTransport = {
      request: async (req: UpstreamTransportRequest) => {
        capturedUrl = req.url.toString();
        return jsonResponse();
      },
    };

    const executor = createUpstreamExecutor(makeOptions(transport));

    it("serializes label path style (primitive, array, record)", async () => {
      // 1. label exploded primitive & array & record
      const op1 = baseOp({
        path: "/users{val}",
        parameters: [
          {
            name: "val",
            in: "path",
            required: true,
            style: "label",
            explode: true,
          },
        ],
      });

      await executor.createTool(op1).execute({ val: "alice" }, context);
      expect(capturedUrl).toBe("https://api.example.com/users.alice");

      await executor.createTool(op1).execute({ val: ["a", "b"] }, context);
      expect(capturedUrl).toBe("https://api.example.com/users.a.b");

      await executor
        .createTool(op1)
        .execute({ val: { x: "1", y: "2" } }, context);
      expect(capturedUrl).toBe("https://api.example.com/users.x=1.y=2");

      // 2. label non-exploded
      const op2 = baseOp({
        path: "/users{val}",
        parameters: [
          {
            name: "val",
            in: "path",
            required: true,
            style: "label",
            explode: false,
          },
        ],
      });
      await executor.createTool(op2).execute({ val: ["a", "b"] }, context);
      expect(capturedUrl).toBe("https://api.example.com/users.a,b");

      await executor
        .createTool(op2)
        .execute({ val: { x: "1", y: "2" } }, context);
      expect(capturedUrl).toBe("https://api.example.com/users.x,1,y,2");
    });

    it("serializes matrix path style (primitive, array, record)", async () => {
      // 1. matrix exploded
      const op1 = baseOp({
        path: "/items{val}",
        parameters: [
          {
            name: "val",
            in: "path",
            required: true,
            style: "matrix",
            explode: true,
          },
        ],
      });

      await executor.createTool(op1).execute({ val: "red" }, context);
      expect(capturedUrl).toBe("https://api.example.com/items;val=red");

      await executor.createTool(op1).execute({ val: ["x", "y"] }, context);
      expect(capturedUrl).toBe("https://api.example.com/items;val=x;val=y");

      await executor
        .createTool(op1)
        .execute({ val: { a: "1", b: "2" } }, context);
      expect(capturedUrl).toBe("https://api.example.com/items;a=1;b=2");

      // 2. matrix non-exploded
      const op2 = baseOp({
        path: "/items{val}",
        parameters: [
          {
            name: "val",
            in: "path",
            required: true,
            style: "matrix",
            explode: false,
          },
        ],
      });
      await executor.createTool(op2).execute({ val: ["x", "y"] }, context);
      expect(capturedUrl).toBe("https://api.example.com/items;val=x,y");

      await executor
        .createTool(op2)
        .execute({ val: { a: "1", b: "2" } }, context);
      expect(capturedUrl).toBe("https://api.example.com/items;val=a,1,b,2");
    });

    it("serializes simple path style with explode true / false", async () => {
      const opExplode = baseOp({
        path: "/res/{val}",
        parameters: [
          {
            name: "val",
            in: "path",
            required: true,
            style: "simple",
            explode: true,
          },
        ],
      });
      await executor
        .createTool(opExplode)
        .execute({ val: { k1: "v1", k2: "v2" } }, context);
      expect(capturedUrl).toBe("https://api.example.com/res/k1=v1,k2=v2");

      const opNonExplode = baseOp({
        path: "/res/{val}",
        parameters: [
          {
            name: "val",
            in: "path",
            required: true,
            style: "simple",
            explode: false,
          },
        ],
      });
      await executor
        .createTool(opNonExplode)
        .execute({ val: { k1: "v1", k2: "v2" } }, context);
      expect(capturedUrl).toBe("https://api.example.com/res/k1,v1,k2,v2");
    });
  });

  describe("Query parameter styles (deepObject, spaceDelimited, pipeDelimited, form)", () => {
    let capturedUrl = "";
    const transport: UpstreamTransport = {
      request: async (req: UpstreamTransportRequest) => {
        capturedUrl = req.url.toString();
        return jsonResponse();
      },
    };

    const executor = createUpstreamExecutor(makeOptions(transport));

    it("serializes deepObject query style", async () => {
      const op = baseOp({
        parameters: [
          {
            name: "filter",
            in: "query",
            required: false,
            style: "deepObject",
            explode: true,
          },
        ],
      });

      await executor.createTool(op).execute(
        {
          filter: {
            user: { name: "alice" },
            tags: ["t1", "t2"],
            active: true,
          },
        },
        context,
      );

      const url = new URL(capturedUrl);
      expect(url.searchParams.get("filter[user][name]")).toBe("alice");
      expect(url.searchParams.getAll("filter[tags]")).toEqual(["t1", "t2"]);
      expect(url.searchParams.get("filter[active]")).toBe("true");
    });

    it("rejects non-object value for deepObject parameter", async () => {
      const op = baseOp({
        parameters: [
          { name: "filter", in: "query", required: false, style: "deepObject" },
        ],
      });

      await expectBuildFailure(
        executor.createTool(op).execute({ filter: "not-an-object" }, context),
        "deepObject parameter must be an object",
      );
    });

    it("serializes spaceDelimited and pipeDelimited query styles", async () => {
      const opSpace = baseOp({
        parameters: [
          {
            name: "tags",
            in: "query",
            required: false,
            style: "spaceDelimited",
          },
          {
            name: "meta",
            in: "query",
            required: false,
            style: "spaceDelimited",
          },
        ],
      });

      await executor
        .createTool(opSpace)
        .execute({ tags: ["tag1", "tag2"], meta: { a: "1", b: "2" } }, context);
      const urlSpace = new URL(capturedUrl);
      expect(urlSpace.searchParams.get("tags")).toBe("tag1 tag2");
      expect(urlSpace.searchParams.get("meta")).toBe("a 1 b 2");

      const opPipe = baseOp({
        parameters: [
          {
            name: "tags",
            in: "query",
            required: false,
            style: "pipeDelimited",
          },
          {
            name: "meta",
            in: "query",
            required: false,
            style: "pipeDelimited",
          },
        ],
      });

      await executor
        .createTool(opPipe)
        .execute({ tags: ["tag1", "tag2"], meta: { a: "1", b: "2" } }, context);
      const urlPipe = new URL(capturedUrl);
      expect(urlPipe.searchParams.get("tags")).toBe("tag1|tag2");
      expect(urlPipe.searchParams.get("meta")).toBe("a|1|b|2");
    });

    it("serializes form query style with explode: false for records and arrays", async () => {
      const op = baseOp({
        parameters: [
          {
            name: "arr",
            in: "query",
            required: false,
            style: "form",
            explode: false,
          },
          {
            name: "obj",
            in: "query",
            required: false,
            style: "form",
            explode: false,
          },
        ],
      });

      await executor
        .createTool(op)
        .execute({ arr: ["x", "y"], obj: { k1: "v1", k2: "v2" } }, context);

      const url = new URL(capturedUrl);
      expect(url.searchParams.get("arr")).toBe("x,y");
      expect(url.searchParams.get("obj")).toBe("k1,v1,k2,v2");
    });
  });

  describe("Header parameter serialization & Cookie parameter validations", () => {
    let capturedHeaders: Record<string, string> = {};
    const transport: UpstreamTransport = {
      request: async (req: UpstreamTransportRequest) => {
        capturedHeaders = req.headers;
        return jsonResponse();
      },
    };

    const executor = createUpstreamExecutor(makeOptions(transport));

    it("serializes array and object header parameters with explode true/false", async () => {
      const op = baseOp({
        parameters: [
          { name: "X-List", in: "header", required: false },
          {
            name: "X-Obj-Explode",
            in: "header",
            required: false,
            explode: true,
          },
          { name: "X-Obj-Flat", in: "header", required: false, explode: false },
        ],
      });

      await executor.createTool(op).execute(
        {
          "X-List": ["val1", "val2"],
          "X-Obj-Explode": { a: "1", b: "2" },
          "X-Obj-Flat": { a: "1", b: "2" },
        },
        context,
      );

      expect(capturedHeaders["X-List"]).toBe("val1,val2");
      expect(capturedHeaders["X-Obj-Explode"]).toBe("a=1,b=2");
      expect(capturedHeaders["X-Obj-Flat"]).toBe("a,1,b,2");
    });

    it("validates cookie parameter requiredness and reserved names", async () => {
      const opRequired = baseOp({
        parameters: [{ name: "session", in: "cookie", required: true }],
      });

      await expectBuildFailure(
        executor.createTool(opRequired).execute({}, context),
        "Cookie parameter is missing",
      );

      await expectBuildFailure(
        executor
          .createTool(opRequired)
          .execute({ session: undefined }, context),
        "Cookie parameter is missing",
      );

      const opInvalidName = baseOp({
        parameters: [
          { name: "bad cookie name!", in: "cookie", required: false },
        ],
      });
      await expectBuildFailure(
        executor
          .createTool(opInvalidName)
          .execute({ "bad cookie name!": "val" }, context),
        "Cookie parameter name is invalid",
      );

      const opReservedName = baseOp({
        parameters: [{ name: "constructor", in: "cookie", required: false }],
      });
      await expectBuildFailure(
        executor
          .createTool(opReservedName)
          .execute({ constructor: "val" }, context),
        "Cookie parameter name is reserved",
      );
    });
  });
});

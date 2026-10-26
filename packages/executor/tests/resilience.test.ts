import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CompiledOperation } from "@chainmcp/compiler";
import { RuntimeError, type ToolContext } from "@chainmcp/core";

import {
  createNodeUpstreamTransport,
  createUpstreamExecutor,
  type UpstreamExecutorOptions,
  type UpstreamTransport,
  type UpstreamTransportRequest,
  type UpstreamTransportResponse,
} from "../src/index.js";

let server: Server;
let port: number;

function testOp(overrides: Partial<CompiledOperation> = {}): CompiledOperation {
  return {
    name: "resilienceOp",
    description: "Resilience test operation",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
    operation: {},
    method: "get",
    path: "/test",
    readOnly: true,
    deprecated: false,
    parameters: [],
    responses: [],
    security: [],
    authentication: { alternatives: [], allowsAnonymous: true },
    sourceLocation: "#/paths/~1test/get",
    ...overrides,
  };
}

class FakeTransport implements UpstreamTransport {
  readonly requests: UpstreamTransportRequest[] = [];
  private readonly responses: Array<
    | UpstreamTransportResponse
    | ((
        request: UpstreamTransportRequest,
      ) => Promise<UpstreamTransportResponse>)
  >;

  constructor(
    responses: Array<
      | UpstreamTransportResponse
      | ((
          request: UpstreamTransportRequest,
        ) => Promise<UpstreamTransportResponse>)
    >,
  ) {
    this.responses = responses;
  }

  async request(
    request: UpstreamTransportRequest,
  ): Promise<UpstreamTransportResponse> {
    this.requests.push(request);
    const next = this.responses.shift();
    if (next === undefined) throw new Error("unexpected upstream request");
    return typeof next === "function" ? next(request) : next;
  }
}

const context: ToolContext = {
  requestId: "req-exec-resilience",
  tenantId: "tenant-resilience",
  principal: { id: "user-resilience", scopes: [] },
};

beforeEach(async () => {
  server = createServer((request, response) => {
    const url = request.url ?? "/";
    if (url === "/test") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"success":true}');
      return;
    }
    if (url === "/drop-socket") {
      request.socket.destroy();
      return;
    }
    if (url === "/hang") {
      // Intentionally never respond
      return;
    }
    response.writeHead(404).end();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("test server did not bind to a port");
  }
  port = address.port;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

function defaultOptions(
  transport: UpstreamTransport,
  overrides: Partial<UpstreamExecutorOptions> = {},
): UpstreamExecutorOptions {
  return {
    baseUrl: "https://api.example.com/v1",
    allowedHosts: ["api.example.com"],
    resolveHost: async () => ["93.184.216.34"], // RFC 2606 public IP
    transport,
    contractRevision: "rev-exec-resilience",
    ...overrides,
  };
}

describe("Executor Upstream Transport Resilience and Fault Injection", () => {
  describe("Node upstream transport socket and connection faults", () => {
    it("safely rejects when socket is abruptly dropped mid-transmission", async () => {
      const transport = createNodeUpstreamTransport();
      const req: UpstreamTransportRequest = {
        url: new URL(`http://127.0.0.1:${port}/drop-socket`),
        hostname: "127.0.0.1",
        address: "127.0.0.1",
        family: 4,
        method: "GET",
        headers: { accept: "application/json" },
        maxResponseBytes: 1024,
        signal: new AbortController().signal,
      };

      await expect(transport.request(req)).rejects.toThrow();
    });

    it("safely aborts when transport AbortSignal fires during hanging request", async () => {
      const transport = createNodeUpstreamTransport();
      const abortController = new AbortController();

      const req: UpstreamTransportRequest = {
        url: new URL(`http://127.0.0.1:${port}/hang`),
        hostname: "127.0.0.1",
        address: "127.0.0.1",
        family: 4,
        method: "GET",
        headers: { accept: "application/json" },
        maxResponseBytes: 1024,
        signal: abortController.signal,
      };

      const pending = transport.request(req);
      setTimeout(() => {
        abortController.abort(new Error("aborted by caller"));
      }, 20);

      await expect(pending).rejects.toThrow();
    });
  });

  describe("Executor failure classification and fault isolation", () => {
    it("maps transport network drops to UPSTREAM_FAILURE", async () => {
      const transport: UpstreamTransport = {
        request: async () => {
          throw new Error("read ECONNRESET");
        },
      };
      const tool = createUpstreamExecutor(defaultOptions(transport)).createTool(
        testOp(),
      );

      const error = await tool.execute({}, context).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RuntimeError);
      expect((error as RuntimeError).code).toBe("UPSTREAM_FAILURE");
      expect((error as RuntimeError).message).toBe("Upstream request failed");
    });

    it("maps malformed/truncated upstream JSON to UPSTREAM_FAILURE", async () => {
      const transport = new FakeTransport([
        {
          status: 200,
          headers: { "content-type": "application/json" },
          body: new TextEncoder().encode('{"incomplete": true'),
        },
      ]);
      const tool = createUpstreamExecutor(defaultOptions(transport)).createTool(
        testOp(),
      );

      const error = await tool.execute({}, context).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RuntimeError);
      expect((error as RuntimeError).code).toBe("UPSTREAM_FAILURE");
      expect((error as RuntimeError).message).toBe(
        "Upstream response was invalid",
      );
    });

    it("maps HTTP 500 internal server error to UPSTREAM_FAILURE", async () => {
      const transport = new FakeTransport([
        {
          status: 500,
          headers: { "content-type": "application/json" },
          body: new TextEncoder().encode('{"error":"Internal Error"}'),
        },
      ]);
      const tool = createUpstreamExecutor(defaultOptions(transport)).createTool(
        testOp(),
      );

      const error = await tool.execute({}, context).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RuntimeError);
      expect((error as RuntimeError).code).toBe("UPSTREAM_FAILURE");
      expect((error as RuntimeError).message).toBe(
        "Upstream request failed with status 500",
      );
    });

    it("maps HTTP 503 service unavailable to UPSTREAM_FAILURE", async () => {
      const transport = new FakeTransport([
        {
          status: 503,
          headers: { "content-type": "application/json" },
          body: new TextEncoder().encode('{"error":"Unavailable"}'),
        },
      ]);
      const tool = createUpstreamExecutor(defaultOptions(transport)).createTool(
        testOp(),
      );

      const error = await tool.execute({}, context).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RuntimeError);
      expect((error as RuntimeError).code).toBe("UPSTREAM_FAILURE");
      expect((error as RuntimeError).message).toBe(
        "Upstream request failed with status 503",
      );
    });

    it("maps DNS resolution failure to UPSTREAM_FAILURE", async () => {
      const transport = new FakeTransport([]);
      const tool = createUpstreamExecutor(
        defaultOptions(transport, {
          resolveHost: async () => {
            throw new Error("getaddrinfo ENOTFOUND api.example.com");
          },
        }),
      ).createTool(testOp());

      const error = await tool.execute({}, context).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RuntimeError);
      expect((error as RuntimeError).code).toBe("UPSTREAM_FAILURE");
    });

    it("maps empty DNS resolution address list to UPSTREAM_FAILURE", async () => {
      const transport = new FakeTransport([]);
      const tool = createUpstreamExecutor(
        defaultOptions(transport, {
          resolveHost: async () => [],
        }),
      ).createTool(testOp());

      const error = await tool.execute({}, context).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RuntimeError);
      expect((error as RuntimeError).code).toBe("UPSTREAM_FAILURE");
      expect((error as RuntimeError).message).toBe(
        "Upstream destination is not permitted",
      );
    });

    it("detects and terminates redirect loops safely", async () => {
      const transport = new FakeTransport([
        {
          status: 302,
          headers: { location: "https://api.example.com/v1/test" },
          body: new Uint8Array(),
        },
        {
          status: 302,
          headers: { location: "https://api.example.com/v1/test" },
          body: new Uint8Array(),
        },
        {
          status: 302,
          headers: { location: "https://api.example.com/v1/test" },
          body: new Uint8Array(),
        },
      ]);

      const tool = createUpstreamExecutor(
        defaultOptions(transport, { maxRedirects: 2 }),
      ).createTool(testOp());

      const error = await tool.execute({}, context).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RuntimeError);
      expect((error as RuntimeError).code).toBe("UPSTREAM_FAILURE");
      expect((error as RuntimeError).message).toBe(
        "Upstream redirect limit exceeded",
      );
    });

    it("cancels in-flight request cleanly when caller signal is aborted", async () => {
      const abortController = new AbortController();
      const transport: UpstreamTransport = {
        request: (req) =>
          new Promise((_resolve, reject) => {
            req.signal.addEventListener("abort", () => {
              reject(new Error("transport aborted"));
            });
          }),
      };

      const tool = createUpstreamExecutor(defaultOptions(transport)).createTool(
        testOp(),
      );

      const execPromise = tool.execute(
        {},
        {
          ...context,
          signal: abortController.signal,
        },
      );

      setTimeout(() => {
        abortController.abort(new Error("caller aborted"));
      }, 15);

      const error = await execPromise.catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RuntimeError);
      expect((error as RuntimeError).code).toBe("CANCELLED");
    });

    it("handles 200 concurrent upstream requests under intermittent network drops and 503s", async () => {
      let callIndex = 0;
      const transport: UpstreamTransport = {
        request: async () => {
          const idx = ++callIndex;
          if (idx % 4 === 0) {
            throw new Error("socket hang up");
          }
          if (idx % 4 === 1) {
            return {
              status: 503,
              statusText: "Service Unavailable",
              headers: { "content-type": "application/json" },
              body: Buffer.from('{"error":"overloaded"}'),
            };
          }
          return {
            status: 200,
            statusText: "OK",
            headers: { "content-type": "application/json" },
            body: Buffer.from(`{"id":${idx},"ok":true}`),
          };
        },
      };

      const tool = createUpstreamExecutor(defaultOptions(transport)).createTool(
        testOp(),
      );

      const tasks = Array.from({ length: 200 }, (_, i) => {
        const reqContext: ToolContext = {
          requestId: `load-exec-req-${i}`,
          tenantId: `tenant-${i % 10}`,
          principal: { id: `user-${i % 5}`, scopes: [] },
        };
        return tool
          .execute({}, reqContext)
          .then((res) => ({ success: true, res }))
          .catch((err) => ({
            success: false,
            code: err instanceof RuntimeError ? err.code : "UNKNOWN",
          }));
      });

      const results = await Promise.all(tasks);
      const successful = results.filter((r) => r.success);
      const failed = results.filter(
        (r): r is { success: false; code: string } => !r.success,
      );

      expect(successful.length).toBe(100);
      expect(failed.length).toBe(100);
      for (const f of failed) {
        expect(["UPSTREAM_FAILURE", "UPSTREAM_HTTP_ERROR"]).toContain(f.code);
      }
    });
  });
});

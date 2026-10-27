import { InMemoryToolRuntime, RuntimeError } from "@chainmcp/core";
import type { CompiledOperation } from "@chainmcp/compiler";
import {
  OAuthClientCredentialsProvider,
  type UpstreamCredentialProvider,
} from "@chainmcp/auth";
import { describe, expect, it } from "vitest";

import {
  createUpstreamExecutor,
  type UpstreamExecutorOptions,
  type UpstreamTransport,
  type UpstreamTransportRequest,
  type UpstreamTransportResponse,
} from "../src/index.js";

function operation(
  overrides: Partial<CompiledOperation> = {},
): CompiledOperation {
  return {
    name: "testOp",
    description: "Test operation",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
    operation: {},
    method: "get",
    path: "/x",
    readOnly: true,
    deprecated: false,
    parameters: [],
    responses: [],
    security: [],
    authentication: { alternatives: [], allowsAnonymous: true },
    sourceLocation: "#/paths/~1x/get",
    ...overrides,
  };
}

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): UpstreamTransportResponse {
  return {
    status,
    headers: { "content-type": "application/json", ...headers },
    body: new TextEncoder().encode(JSON.stringify(body)),
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

const context = {
  requestId: "req-1",
  tenantId: "tenant-1",
  principal: { id: "user-1", scopes: [] },
};

function options(
  transport: UpstreamTransport,
  overrides: Partial<UpstreamExecutorOptions> = {},
): UpstreamExecutorOptions {
  return {
    baseUrl: "https://api.example.com/v1",
    allowedHosts: ["api.example.com"],
    resolveHost: async () => ["8.8.8.8"],
    transport,
    contractRevision: "rev-1",
    ...overrides,
  };
}

async function expectRuntimeError(
  promise: Promise<unknown>,
  code: string,
  message?: string,
): Promise<RuntimeError> {
  const error = await promise.then(
    () => {
      throw new Error("expected the call to reject");
    },
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(RuntimeError);
  expect(error).toMatchObject({ code, ...(message ? { message } : {}) });
  return error as RuntimeError;
}

describe("upstream executor request mapping", () => {
  it("maps path, query, header, and body inputs", async () => {
    const transport = new FakeTransport([jsonResponse({ ok: true })]);
    const tool = createUpstreamExecutor(options(transport)).createTool(
      operation({
        method: "post",
        path: "/pets/{petId}",
        parameters: [
          { name: "petId", in: "path", required: true },
          { name: "filter", in: "query", required: false },
          { name: "tags", in: "query", required: false },
          { name: "X-Trace", in: "header", required: false },
        ],
        requestBody: { mediaType: "application/json", required: true },
      }),
    );

    const result = await tool.execute(
      {
        petId: "a/b",
        filter: "hi there",
        tags: ["x", "y"],
        "X-Trace": "trace-1",
        body: { name: "Ada" },
      },
      context,
    );

    expect(result).toEqual({ ok: true });
    expect(transport.requests).toHaveLength(1);
    const request = transport.requests[0];
    expect(request?.url.href).toBe(
      "https://api.example.com/v1/pets/a%2Fb?filter=hi+there&tags=x&tags=y",
    );
    expect(request?.method).toBe("POST");
    expect(request?.headers["x-trace"]).toBeUndefined();
    expect(request?.headers["X-Trace"]).toBe("trace-1");
    expect(request?.headers["content-type"]).toBe("application/json");
    expect(request?.headers["authorization"]).toBeUndefined();
    expect(new TextDecoder().decode(request?.body ?? new Uint8Array())).toBe(
      '{"name":"Ada"}',
    );
  });

  it("exports tool metadata and the contract revision", () => {
    const tool = createUpstreamExecutor(
      options(new FakeTransport([]), { ownerTenantId: "tenant-1" }),
    ).createTool(operation());
    expect(tool).toMatchObject({
      name: "testOp",
      description: "Test operation",
      operation: {},
      contractRevision: "rev-1",
      ownerTenantId: "tenant-1",
    });
    expect(tool.cache).toBeUndefined();
  });

  it("returns null for an empty successful response", async () => {
    const transport = new FakeTransport([
      { status: 204, headers: {}, body: new Uint8Array() },
    ]);
    const tool = createUpstreamExecutor(options(transport)).createTool(
      operation(),
    );
    await expect(tool.execute({}, context)).resolves.toBeNull();
  });

  it("rejects object query values, nulls, and header injection", async () => {
    const tool = createUpstreamExecutor(
      options(new FakeTransport([])),
    ).createTool(
      operation({
        parameters: [
          { name: "q", in: "query", required: false },
          { name: "X-Test", in: "header", required: false },
        ],
      }),
    );

    await expectRuntimeError(
      tool.execute({ q: { nested: true } }, context),
      "UPSTREAM_FAILURE",
      "Upstream request could not be constructed",
    );
    await expectRuntimeError(
      tool.execute({ q: null }, context),
      "UPSTREAM_FAILURE",
      "Upstream request could not be constructed",
    );
    await expectRuntimeError(
      tool.execute({ "X-Test": "a\r\nb" }, context),
      "UPSTREAM_FAILURE",
      "Upstream request could not be constructed",
    );
  });

  it("bounds query strings and request headers", async () => {
    const transport = new FakeTransport([]);
    const tool = createUpstreamExecutor(options(transport)).createTool(
      operation({
        parameters: [
          { name: "q", in: "query", required: false },
          { name: "X-Big", in: "header", required: false },
        ],
      }),
    );

    await expectRuntimeError(
      tool.execute({ q: "x".repeat(9_000) }, context),
      "UPSTREAM_FAILURE",
      "Upstream request could not be constructed",
    );
    await expectRuntimeError(
      tool.execute({ "X-Big": "x".repeat(17_000) }, context),
      "UPSTREAM_FAILURE",
      "Upstream request could not be constructed",
    );
    expect(transport.requests).toHaveLength(0);
  });

  it("rejects path traversal, prototype header names, and media-type injection", async () => {
    const transport = new FakeTransport([]);
    const traversal = createUpstreamExecutor(options(transport)).createTool(
      operation({
        path: "/pets/{id}",
        parameters: [{ name: "id", in: "path", required: true }],
      }),
    );
    await expectRuntimeError(
      traversal.execute({ id: ".." }, context),
      "UPSTREAM_FAILURE",
      "Upstream request could not be constructed",
    );
    await expectRuntimeError(
      traversal.execute({ id: "." }, context),
      "UPSTREAM_FAILURE",
      "Upstream request could not be constructed",
    );
    await expectRuntimeError(
      traversal.execute({ id: "\uD800" }, context),
      "UPSTREAM_FAILURE",
      "Upstream request could not be constructed",
    );

    const prototypeHeader = createUpstreamExecutor(
      options(transport),
    ).createTool(
      operation({
        parameters: [{ name: "__proto__", in: "header", required: false }],
      }),
    );
    await expectRuntimeError(
      prototypeHeader.execute({ ["__proto__"]: "value" }, context),
      "UPSTREAM_FAILURE",
      "Upstream request could not be constructed",
    );

    const mediaInjection = createUpstreamExecutor(
      options(transport),
    ).createTool(
      operation({
        method: "post",
        requestBody: {
          mediaType: "application/json\r\nX-Evil: 1",
          required: true,
        },
      }),
    );
    await expectRuntimeError(
      mediaInjection.execute({ body: {} }, context),
      "UPSTREAM_FAILURE",
      "Upstream request could not be constructed",
    );
    expect(transport.requests).toHaveLength(0);
  });

  it("rejects missing path/body values and oversized bodies", async () => {
    const transport = new FakeTransport([]);
    const tool = createUpstreamExecutor(
      options(transport, { maxRequestBytes: 4 }),
    ).createTool(
      operation({
        method: "post",
        path: "/pets/{petId}",
        parameters: [{ name: "petId", in: "path", required: true }],
        requestBody: { mediaType: "application/json", required: true },
      }),
    );

    await expectRuntimeError(
      tool.execute({ body: {} }, context),
      "UPSTREAM_FAILURE",
      "Upstream request could not be constructed",
    );
    await expectRuntimeError(
      tool.execute({ petId: "1" }, context),
      "UPSTREAM_FAILURE",
      "Upstream request could not be constructed",
    );
    await expectRuntimeError(
      tool.execute({ petId: "1", body: { long: "value" } }, context),
      "UPSTREAM_FAILURE",
      "Upstream request could not be constructed",
    );
    expect(transport.requests).toHaveLength(0);
  });
});

describe("upstream executor redirects", () => {
  it("follows a same-origin redirect", async () => {
    const transport = new FakeTransport([
      {
        status: 302,
        headers: { location: "/v1/next" },
        body: new Uint8Array(),
      },
      jsonResponse({ ok: true }),
    ]);
    const tool = createUpstreamExecutor(options(transport)).createTool(
      operation(),
    );

    await expect(tool.execute({}, context)).resolves.toEqual({ ok: true });
    expect(transport.requests.map((request) => request.url.href)).toEqual([
      "https://api.example.com/v1/x",
      "https://api.example.com/v1/next",
    ]);
  });

  it("rejects redirects to another host, port, or protocol", async () => {
    const cases = [
      "https://evil.example.com/x",
      "https://api.example.com:8443/x",
      "http://api.example.com/x",
    ];
    for (const location of cases) {
      const transport = new FakeTransport([
        { status: 302, headers: { location }, body: new Uint8Array() },
      ]);
      const tool = createUpstreamExecutor(options(transport)).createTool(
        operation(),
      );
      await expectRuntimeError(
        tool.execute({}, context),
        "UPSTREAM_FAILURE",
        "Upstream destination is not permitted",
      );
      expect(transport.requests).toHaveLength(1);
    }
  });

  it("rejects cross-host redirects even when both hosts are allowlisted", async () => {
    const transport = new FakeTransport([
      {
        status: 302,
        headers: { location: "https://cdn.example.com/asset" },
        body: new Uint8Array(),
      },
    ]);
    const tool = createUpstreamExecutor(
      options(transport, {
        allowedHosts: ["api.example.com", "cdn.example.com"],
      }),
    ).createTool(operation());

    await expectRuntimeError(
      tool.execute({}, context),
      "UPSTREAM_FAILURE",
      "Upstream destination is not permitted",
    );
    expect(transport.requests).toHaveLength(1);
  });

  it("enforces the redirect limit", async () => {
    const transport = new FakeTransport([
      { status: 302, headers: { location: "/a" }, body: new Uint8Array() },
      { status: 302, headers: { location: "/b" }, body: new Uint8Array() },
    ]);
    const tool = createUpstreamExecutor(
      options(transport, { maxRedirects: 1 }),
    ).createTool(operation());

    await expectRuntimeError(
      tool.execute({}, context),
      "UPSTREAM_FAILURE",
      "Upstream redirect limit exceeded",
    );
    expect(transport.requests).toHaveLength(2);
  });

  it("rewrites 303 to GET and drops the body", async () => {
    const transport = new FakeTransport([
      { status: 303, headers: { location: "/done" }, body: new Uint8Array() },
      jsonResponse({ ok: true }),
    ]);
    const tool = createUpstreamExecutor(options(transport)).createTool(
      operation({
        method: "post",
        requestBody: { mediaType: "application/json", required: true },
      }),
    );

    await tool.execute({ body: { value: 1 } }, context);
    expect(transport.requests[1]?.method).toBe("GET");
    expect(transport.requests[1]?.body).toBeUndefined();
    expect(transport.requests[1]?.headers["content-type"]).toBeUndefined();
  });

  it("preserves method and body across 307", async () => {
    const transport = new FakeTransport([
      { status: 307, headers: { location: "/retry" }, body: new Uint8Array() },
      jsonResponse({ ok: true }),
    ]);
    const tool = createUpstreamExecutor(options(transport)).createTool(
      operation({
        method: "post",
        requestBody: { mediaType: "application/json", required: true },
      }),
    );

    await tool.execute({ body: { value: 1 } }, context);
    expect(transport.requests[1]?.method).toBe("POST");
    expect(
      new TextDecoder().decode(transport.requests[1]?.body ?? new Uint8Array()),
    ).toBe('{"value":1}');
  });
});

describe("upstream executor responses and failures", () => {
  it("rejects non-2xx statuses without exposing the response body", async () => {
    const transport = new FakeTransport([
      {
        status: 500,
        headers: { "content-type": "text/plain" },
        body: new TextEncoder().encode("secret upstream detail"),
      },
    ]);
    const tool = createUpstreamExecutor(options(transport)).createTool(
      operation(),
    );
    const error = await expectRuntimeError(
      tool.execute({}, context),
      "UPSTREAM_FAILURE",
      "Upstream request failed with status 500",
    );
    expect(error.message).not.toContain("secret");
  });

  it("requires a JSON response media type and valid JSON", async () => {
    const text = new FakeTransport([
      {
        status: 200,
        headers: { "content-type": "text/plain" },
        body: new TextEncoder().encode("ok"),
      },
    ]);
    await expectRuntimeError(
      createUpstreamExecutor(options(text))
        .createTool(operation())
        .execute({}, context),
      "UPSTREAM_FAILURE",
      "Upstream response is not a JSON media type",
    );

    const invalid = new FakeTransport([
      {
        status: 200,
        headers: { "content-type": "application/json" },
        body: new TextEncoder().encode("{not json"),
      },
    ]);
    await expectRuntimeError(
      createUpstreamExecutor(options(invalid))
        .createTool(operation())
        .execute({}, context),
      "UPSTREAM_FAILURE",
      "Upstream response was invalid",
    );
  });

  it("defensively enforces the response cap on injected transports", async () => {
    const transport = new FakeTransport([
      {
        status: 200,
        headers: { "content-type": "application/json" },
        body: new Uint8Array(32),
      },
    ]);
    const tool = createUpstreamExecutor(
      options(transport, { maxResponseBytes: 8 }),
    ).createTool(operation());

    await expectRuntimeError(
      tool.execute({}, context),
      "UPSTREAM_FAILURE",
      "Upstream response exceeded the size limit",
    );
  });

  it("rejects a non-public resolved destination before requesting", async () => {
    const transport = new FakeTransport([]);
    const tool = createUpstreamExecutor(
      options(transport, { resolveHost: async () => ["10.0.0.1"] }),
    ).createTool(operation());

    await expectRuntimeError(
      tool.execute({}, context),
      "UPSTREAM_FAILURE",
      "Upstream destination is not permitted",
    );
    expect(transport.requests).toHaveLength(0);
  });

  it("enforces a total timeout and aborts the transport signal", async () => {
    let seenSignal: AbortSignal | undefined;
    const transport: UpstreamTransport = {
      request: (request) => {
        seenSignal = request.signal;
        return new Promise((_resolve, reject) => {
          request.signal.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true },
          );
        });
      },
    };
    const tool = createUpstreamExecutor(
      options(transport, { timeoutMs: 5 }),
    ).createTool(operation());

    await expectRuntimeError(
      tool.execute({}, context),
      "UPSTREAM_TIMEOUT",
      "Upstream request timed out",
    );
    expect(seenSignal?.aborted).toBe(true);
  });

  it("maps caller cancellation to CANCELLED and aborts the transport", async () => {
    const controller = new AbortController();
    let started: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const transport: UpstreamTransport = {
      request: (request) => {
        started?.();
        return new Promise((_resolve, reject) => {
          request.signal.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true },
          );
        });
      },
    };
    const tool = createUpstreamExecutor(options(transport)).createTool(
      operation(),
    );
    const pending = tool.execute({}, { ...context, signal: controller.signal });
    await ready;
    controller.abort();

    await expectRuntimeError(pending, "CANCELLED", "Tool call was cancelled");
  });

  it("works through the shared runtime and emits no credentials", async () => {
    const transport = new FakeTransport([jsonResponse({ ok: true })]);
    const tool = createUpstreamExecutor(options(transport)).createTool(
      operation({ name: "lookup" }),
    );
    const runtime = new InMemoryToolRuntime();
    runtime.register(tool);

    await expect(
      runtime.callTool(
        "lookup",
        {},
        { ...context, principal: { id: "user-1", scopes: [] } },
      ),
    ).resolves.toEqual({ ok: true });
    expect(transport.requests[0]?.headers["authorization"]).toBeUndefined();
  });
});

describe("executor option validation", () => {
  it("requires HTTPS unless explicitly allowed", () => {
    expect(() =>
      createUpstreamExecutor(
        options(new FakeTransport([]), { baseUrl: "http://api.example.com" }),
      ),
    ).toThrow(TypeError);
  });

  it("requires the base host in the allowlist", () => {
    expect(() =>
      createUpstreamExecutor(
        options(new FakeTransport([]), { allowedHosts: ["other.example.com"] }),
      ),
    ).toThrow(TypeError);
  });

  it("rejects a zero base URL port", () => {
    expect(() =>
      createUpstreamExecutor(
        options(new FakeTransport([]), {
          baseUrl: "https://api.example.com:0",
        }),
      ),
    ).toThrow(TypeError);
  });

  it("rejects invalid limits and metadata", () => {
    expect(() =>
      createUpstreamExecutor(
        options(new FakeTransport([]), { maxRedirects: -1 }),
      ),
    ).toThrow(TypeError);
    expect(() =>
      createUpstreamExecutor(
        options(new FakeTransport([]), { maxResponseBytes: 10_000_001 }),
      ),
    ).toThrow(TypeError);
    expect(() =>
      createUpstreamExecutor(options(new FakeTransport([]), { timeoutMs: 0 })),
    ).toThrow(TypeError);
    expect(() =>
      createUpstreamExecutor(
        options(new FakeTransport([]), { contractRevision: " " }),
      ),
    ).toThrow(TypeError);
  });
});

describe("Upstream authentication & credential injection", () => {
  it("injects apiKey credentials into request header, query, and cookie", async () => {
    const transport = new FakeTransport([
      jsonResponse({ ok: true }),
      jsonResponse({ ok: true }),
      jsonResponse({ ok: true }),
    ]);

    const executor = createUpstreamExecutor(
      options(transport, {
        credentialProvider: {
          resolveCredential: async (ctx) => {
            if (ctx.schemeName === "header_key") {
              return {
                type: "apiKey",
                name: "X-API-KEY",
                location: "header",
                value: "secret-head-val",
              };
            }
            if (ctx.schemeName === "query_key") {
              return {
                type: "apiKey",
                name: "api_key",
                location: "query",
                value: "secret-query-val",
              };
            }
            if (ctx.schemeName === "cookie_key") {
              return {
                type: "apiKey",
                name: "session_id",
                location: "cookie",
                value: "secret-cookie-val",
              };
            }
            return undefined;
          },
        },
      }),
    );

    // 1. Header apiKey
    const headerOp = operation({
      authentication: {
        alternatives: [
          {
            schemes: [
              {
                name: "header_key",
                type: "apiKey",
                parameterName: "X-API-KEY",
                parameterLocation: "header",
                scopes: [],
              },
            ],
          },
        ],
        allowsAnonymous: false,
      },
    });
    const headerTool = executor.createTool(headerOp);
    await headerTool.execute({}, context);
    expect(transport.requests[0]?.headers["x-api-key"]).toBe("secret-head-val");

    // 2. Query apiKey
    const queryOp = operation({
      authentication: {
        alternatives: [
          {
            schemes: [
              {
                name: "query_key",
                type: "apiKey",
                parameterName: "api_key",
                parameterLocation: "query",
                scopes: [],
              },
            ],
          },
        ],
        allowsAnonymous: false,
      },
    });
    const queryTool = executor.createTool(queryOp);
    await queryTool.execute({}, context);
    expect(transport.requests[1]?.url.searchParams.get("api_key")).toBe(
      "secret-query-val",
    );

    // 3. Cookie apiKey
    const cookieOp = operation({
      authentication: {
        alternatives: [
          {
            schemes: [
              {
                name: "cookie_key",
                type: "apiKey",
                parameterName: "session_id",
                parameterLocation: "cookie",
                scopes: [],
              },
            ],
          },
        ],
        allowsAnonymous: false,
      },
    });
    const cookieTool = executor.createTool(cookieOp);
    await cookieTool.execute({}, context);
    expect(transport.requests[2]?.headers["cookie"]).toBe(
      "session_id=secret-cookie-val",
    );
  });

  it("injects HTTP bearer, HTTP basic, and OAuth2 credentials", async () => {
    const transport = new FakeTransport([
      jsonResponse({ ok: true }),
      jsonResponse({ ok: true }),
      jsonResponse({ ok: true }),
    ]);

    const executor = createUpstreamExecutor(
      options(transport, {
        credentialProvider: {
          resolveCredential: async (ctx) => {
            if (ctx.schemeName === "bearer_auth") {
              return {
                type: "http",
                scheme: "bearer",
                token: "bearer-token-123",
              };
            }
            if (ctx.schemeName === "basic_auth") {
              return {
                type: "http",
                scheme: "basic",
                username: "alice",
                password: "pwd",
              };
            }
            if (ctx.schemeName === "oauth_auth") {
              return {
                type: "oauth2",
                token: "oauth-tok-999",
                tokenType: "Bearer",
              };
            }
            return undefined;
          },
        },
      }),
    );

    // 1. Bearer
    const bearerOp = operation({
      authentication: {
        alternatives: [
          {
            schemes: [
              {
                name: "bearer_auth",
                type: "http",
                httpScheme: "bearer",
                scopes: [],
              },
            ],
          },
        ],
        allowsAnonymous: false,
      },
    });
    await executor.createTool(bearerOp).execute({}, context);
    expect(transport.requests[0]?.headers["authorization"]).toBe(
      "Bearer bearer-token-123",
    );

    // 2. Basic
    const basicOp = operation({
      authentication: {
        alternatives: [
          {
            schemes: [
              {
                name: "basic_auth",
                type: "http",
                httpScheme: "basic",
                scopes: [],
              },
            ],
          },
        ],
        allowsAnonymous: false,
      },
    });
    await executor.createTool(basicOp).execute({}, context);
    const expectedBasic = Buffer.from("alice:pwd").toString("base64");
    expect(transport.requests[1]?.headers["authorization"]).toBe(
      `Basic ${expectedBasic}`,
    );

    // 3. OAuth2
    const oauthOp = operation({
      authentication: {
        alternatives: [
          {
            schemes: [
              {
                name: "oauth_auth",
                type: "oauth2",
                scopes: ["read"],
              },
            ],
          },
        ],
        allowsAnonymous: false,
      },
    });
    await executor.createTool(oauthOp).execute({}, context);
    expect(transport.requests[2]?.headers["authorization"]).toBe(
      "Bearer oauth-tok-999",
    );
  });

  it("tries alternatives in order and falls back to second alternative when first fails", async () => {
    const transport = new FakeTransport([jsonResponse({ ok: true })]);

    const executor = createUpstreamExecutor(
      options(transport, {
        credentialProvider: {
          resolveCredential: async (ctx) => {
            // scheme1 fails to resolve
            if (ctx.schemeName === "scheme1") return undefined;
            // scheme2 resolves
            if (ctx.schemeName === "scheme2") {
              return { type: "http", scheme: "bearer", token: "tok-scheme2" };
            }
            return undefined;
          },
        },
      }),
    );

    const multiAuthOp = operation({
      authentication: {
        alternatives: [
          {
            schemes: [
              {
                name: "scheme1",
                type: "http",
                httpScheme: "bearer",
                scopes: [],
              },
            ],
          },
          {
            schemes: [
              {
                name: "scheme2",
                type: "http",
                httpScheme: "bearer",
                scopes: [],
              },
            ],
          },
        ],
        allowsAnonymous: false,
      },
    });

    await executor.createTool(multiAuthOp).execute({}, context);
    expect(transport.requests[0]?.headers["authorization"]).toBe(
      "Bearer tok-scheme2",
    );
  });

  it("falls back to anonymous alternative when credentials are not resolved and allowsAnonymous is true", async () => {
    const transport = new FakeTransport([jsonResponse({ ok: true })]);
    const executor = createUpstreamExecutor(
      options(transport, {
        credentialProvider: {
          resolveCredential: async () => undefined,
        },
      }),
    );

    const anonOp = operation({
      authentication: {
        alternatives: [
          {
            schemes: [
              {
                name: "opt_scheme",
                type: "http",
                httpScheme: "bearer",
                scopes: [],
              },
            ],
          },
          { schemes: [] }, // anonymous alternative
        ],
        allowsAnonymous: true,
      },
    });

    await executor.createTool(anonOp).execute({}, context);
    expect(transport.requests[0]?.headers["authorization"]).toBeUndefined();
  });

  it("fails closed with AUTH_REQUIRED when credentials are missing and no anonymous alternative exists", async () => {
    const transport = new FakeTransport([]);
    const executor = createUpstreamExecutor(
      options(transport, {
        credentialProvider: {
          resolveCredential: async () => undefined,
        },
      }),
    );

    const secureOp = operation({
      authentication: {
        alternatives: [
          {
            schemes: [
              {
                name: "mandatory_key",
                type: "apiKey",
                parameterName: "X-Key",
                parameterLocation: "header",
                scopes: [],
              },
            ],
          },
        ],
        allowsAnonymous: false,
      },
    });

    const tool = executor.createTool(secureOp);
    await expect(tool.execute({}, context)).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
      message: "Authentication required",
    });
    expect(transport.requests.length).toBe(0);
  });

  it("binds credential resolution to context.signal and executor timeout", async () => {
    const transport = new FakeTransport([]);
    const executor = createUpstreamExecutor(
      options(transport, {
        timeoutMs: 30,
        credentialProvider: {
          resolveCredential: async (ctx) => {
            return new Promise((resolve, reject) => {
              if (ctx.signal?.aborted) {
                reject(ctx.signal.reason);
                return;
              }
              const onAbort = () => reject(ctx.signal?.reason);
              ctx.signal?.addEventListener("abort", onAbort, { once: true });
            });
          },
        },
      }),
    );

    const secureOp = operation({
      authentication: {
        alternatives: [
          {
            schemes: [
              {
                name: "slow_key",
                type: "apiKey",
                parameterName: "X-Key",
                parameterLocation: "header",
                scopes: [],
              },
            ],
          },
        ],
        allowsAnonymous: false,
      },
    });

    const tool = executor.createTool(secureOp);

    // 1. Timeout during credential resolution
    await expect(tool.execute({}, context)).rejects.toMatchObject({
      code: "UPSTREAM_TIMEOUT",
      message: "Upstream request timed out",
    });

    // 2. Cancellation during credential resolution
    const abortCtrl = new AbortController();
    const cancelPromise = tool.execute(
      {},
      { ...context, signal: abortCtrl.signal },
    );
    abortCtrl.abort(new Error("caller cancelled"));
    await expect(cancelPromise).rejects.toMatchObject({
      code: "CANCELLED",
    });
  });

  it("rejects invalid or reserved credential names", async () => {
    const transport = new FakeTransport([]);

    // 1. Invalid characters in header name
    const invalidHeaderExecutor = createUpstreamExecutor(
      options(transport, {
        credentialProvider: {
          resolveCredential: async () => ({
            type: "apiKey",
            name: "bad header with spaces",
            location: "header",
            value: "secret",
          }),
        },
      }),
    );
    const op = operation({
      authentication: {
        alternatives: [
          {
            schemes: [
              {
                name: "k",
                type: "apiKey",
                parameterName: "k",
                parameterLocation: "header",
                scopes: [],
              },
            ],
          },
        ],
        allowsAnonymous: false,
      },
    });
    await expect(
      invalidHeaderExecutor.createTool(op).execute({}, context),
    ).rejects.toMatchObject({
      code: "UPSTREAM_FAILURE",
      cause: expect.objectContaining({
        message: expect.stringContaining("is invalid"),
      }),
    });

    // 2. Reserved header name like Host
    const reservedHeaderExecutor = createUpstreamExecutor(
      options(transport, {
        credentialProvider: {
          resolveCredential: async () => ({
            type: "apiKey",
            name: "Host",
            location: "header",
            value: "evil.example.com",
          }),
        },
      }),
    );
    await expect(
      reservedHeaderExecutor.createTool(op).execute({}, context),
    ).rejects.toMatchObject({
      code: "UPSTREAM_FAILURE",
      cause: expect.objectContaining({
        message: expect.stringContaining("is reserved"),
      }),
    });

    // 3. Reserved query name like __proto__
    const reservedQueryExecutor = createUpstreamExecutor(
      options(transport, {
        credentialProvider: {
          resolveCredential: async () => ({
            type: "apiKey",
            name: "__proto__",
            location: "query",
            value: "evil",
          }),
        },
      }),
    );
    await expect(
      reservedQueryExecutor.createTool(op).execute({}, context),
    ).rejects.toMatchObject({
      code: "UPSTREAM_FAILURE",
      cause: expect.objectContaining({
        message: expect.stringContaining("is reserved"),
      }),
    });
  });

  it("proves caller input cannot override credential headers or query parameters", async () => {
    const transport = new FakeTransport([
      jsonResponse({ ok: true }),
      jsonResponse({ ok: true }),
    ]);

    const executor = createUpstreamExecutor(
      options(transport, {
        credentialProvider: {
          resolveCredential: async (ctx) => {
            if (ctx.schemeName === "header_auth") {
              return {
                type: "apiKey",
                name: "X-API-KEY",
                location: "header",
                value: "system-secret-key",
              };
            }
            if (ctx.schemeName === "query_auth") {
              return {
                type: "apiKey",
                name: "api_key",
                location: "query",
                value: "system-secret-query",
              };
            }
            return undefined;
          },
        },
      }),
    );

    // 1. Caller declares and passes X-API-KEY in header parameter
    const headerOp = operation({
      parameters: [
        { name: "X-API-KEY", in: "header", required: false },
        { name: "other-header", in: "header", required: false },
      ],
      authentication: {
        alternatives: [
          {
            schemes: [
              {
                name: "header_auth",
                type: "apiKey",
                parameterName: "X-API-KEY",
                parameterLocation: "header",
                scopes: [],
              },
            ],
          },
        ],
        allowsAnonymous: false,
      },
    });

    const headerTool = executor.createTool(headerOp);
    await headerTool.execute(
      {
        "X-API-KEY": "caller-evil-key",
        "other-header": "safe-value",
      },
      context,
    );

    const sentHeaders = transport.requests[0]?.headers ?? {};
    // Caller's value must NOT be present
    expect(sentHeaders["x-api-key"]).toBe("system-secret-key");
    expect(sentHeaders["X-API-KEY"]).toBeUndefined();
    expect(sentHeaders["other-header"]).toBe("safe-value");

    // 2. Caller passes query parameter matching the credential query parameter
    const queryOp = operation({
      parameters: [{ name: "api_key", in: "query", required: false }],
      authentication: {
        alternatives: [
          {
            schemes: [
              {
                name: "query_auth",
                type: "apiKey",
                parameterName: "api_key",
                parameterLocation: "query",
                scopes: [],
              },
            ],
          },
        ],
        allowsAnonymous: false,
      },
    });

    const queryTool = executor.createTool(queryOp);
    await queryTool.execute(
      {
        api_key: "caller-evil-query-val",
      },
      context,
    );

    const sentUrl = transport.requests[1]?.url;
    // URL search params must contain only the system credential value
    expect(sentUrl?.searchParams.getAll("api_key")).toEqual([
      "system-secret-query",
    ]);
  });
});

describe("OAuth token acquisition through the outbound policy", () => {
  const oauthOperation = () =>
    operation({
      authentication: {
        alternatives: [
          {
            schemes: [{ name: "oauth", type: "oauth2", scopes: ["read"] }],
          },
        ],
        allowsAnonymous: false,
      },
    });

  const tokenProvider = (
    overrides: Partial<
      ConstructorParameters<typeof OAuthClientCredentialsProvider>[0]
    > = {},
  ) =>
    new OAuthClientCredentialsProvider({
      tokenUrl: "https://auth.example.com/oauth/token",
      clientId: "client-id",
      clientSecret: "client-secret",
      allowedTokenHosts: ["auth.example.com"],
      now: () => 1_000_000,
      ...overrides,
    });

  it("fetches the token and the API request through the same transport", async () => {
    const transport = new FakeTransport([
      jsonResponse({
        access_token: "token-1",
        token_type: "Bearer",
        expires_in: 3600,
      }),
      jsonResponse({ ok: true }),
    ]);

    const tool = createUpstreamExecutor(
      options(transport, {
        credentialProvider: tokenProvider(),
      }),
    ).createTool(oauthOperation());

    await expect(tool.execute({}, context)).resolves.toEqual({ ok: true });

    expect(transport.requests).toHaveLength(2);
    const tokenRequest = transport.requests[0]!;
    expect(tokenRequest.method).toBe("POST");
    expect(tokenRequest.hostname).toBe("auth.example.com");
    expect(tokenRequest.address).toBe("8.8.8.8");
    expect(Buffer.from(tokenRequest.body ?? []).toString("utf8")).toContain(
      "grant_type=client_credentials",
    );
    expect(tokenRequest.headers.authorization).toMatch(/^Basic /);

    const apiRequest = transport.requests[1]!;
    expect(apiRequest.hostname).toBe("api.example.com");
    expect(apiRequest.headers.authorization).toBe("Bearer token-1");
  });

  it("rejects a token endpoint that resolves to a non-public address", async () => {
    const transport = new FakeTransport([]);
    const tool = createUpstreamExecutor(
      options(transport, {
        resolveHost: async (hostname) =>
          hostname === "auth.example.com" ? ["127.0.0.1"] : ["8.8.8.8"],
        credentialProvider: tokenProvider(),
      }),
    ).createTool(oauthOperation());

    const error = await expectRuntimeError(
      tool.execute({}, context),
      "AUTH_REQUIRED",
    );
    expect(error.cause).toMatchObject({ name: "DestinationPolicyError" });
    expect(transport.requests).toHaveLength(0);
  });

  it("refuses token endpoint redirects", async () => {
    const transport = new FakeTransport([
      {
        status: 302,
        headers: { location: "https://attacker.example/token" },
        body: new Uint8Array(),
      },
    ]);
    const tool = createUpstreamExecutor(
      options(transport, { credentialProvider: tokenProvider() }),
    ).createTool(oauthOperation());

    const error = await expectRuntimeError(
      tool.execute({}, context),
      "AUTH_REQUIRED",
    );
    expect(error.cause).toMatchObject({
      message: expect.stringContaining("redirects are not followed"),
    });
    expect(transport.requests).toHaveLength(1);
  });

  it("rejects token responses that are not JSON", async () => {
    const transport = new FakeTransport([
      {
        status: 200,
        headers: { "content-type": "text/html" },
        body: new TextEncoder().encode("<html>hi</html>"),
      },
    ]);
    const tool = createUpstreamExecutor(
      options(transport, { credentialProvider: tokenProvider() }),
    ).createTool(oauthOperation());

    const error = await expectRuntimeError(
      tool.execute({}, context),
      "AUTH_REQUIRED",
    );
    expect(error.cause).toMatchObject({
      message: expect.stringContaining("non-JSON"),
    });
  });

  it("rejects a token host outside the provider allowlist", async () => {
    const transport = new FakeTransport([]);
    const tool = createUpstreamExecutor(
      options(transport, {
        credentialProvider: tokenProvider({
          allowedTokenHosts: ["other.example"],
        }),
      }),
    ).createTool(oauthOperation());

    const error = await expectRuntimeError(
      tool.execute({}, context),
      "AUTH_REQUIRED",
    );
    expect(error.cause).toMatchObject({ name: "DestinationPolicyError" });
    expect(transport.requests).toHaveLength(0);
  });

  it("fails closed when a provider returns malformed credential material", async () => {
    const transport = new FakeTransport([]);
    const tool = createUpstreamExecutor(
      options(transport, {
        credentialProvider: {
          // Simulates third-party provider code returning an invalid shape.
          resolveCredential: (async () => ({
            type: "http",
            scheme: "bearer",
            token: "",
          })) as unknown as UpstreamCredentialProvider["resolveCredential"],
        },
      }),
    ).createTool(
      operation({
        authentication: {
          alternatives: [
            { schemes: [{ name: "bearer", type: "http", scopes: [] }] },
          ],
          allowsAnonymous: false,
        },
      }),
    );

    await expectRuntimeError(tool.execute({}, context), "AUTH_REQUIRED");
    expect(transport.requests).toHaveLength(0);
  });

  it("attaches opt-in read caching to GET operations and caches responses in runtime", async () => {
    const transport = new FakeTransport([
      jsonResponse({ id: "1", name: "Cached Widget" }),
    ]);
    const executor = createUpstreamExecutor(
      options(transport, {
        defaultReadCacheTtlSeconds: 300,
        contractRevision: "rev-2026",
      }),
    );

    const getTool = executor.createTool(
      operation({
        name: "getWidget",
        method: "get",
        readOnly: true,
      }),
    );
    expect(getTool.cache).toEqual({ ttlSeconds: 300 });
    expect(getTool.contractRevision).toBe("rev-2026");

    const postTool = executor.createTool(
      operation({
        name: "createWidget",
        method: "post",
        readOnly: false,
      }),
    );
    expect(postTool.cache).toBeUndefined();

    // Verify end-to-end cache hit in runtime
    const runtime = new InMemoryToolRuntime({
      cache: {
        store: new MapCacheStore(),
        authorizationPartition: () => "public",
      },
    });
    runtime.register(getTool);

    const res1 = await runtime.callTool("getWidget", {}, async () => context);
    expect(res1).toEqual({ id: "1", name: "Cached Widget" });
    expect(transport.requests).toHaveLength(1);

    // Second call hits cache; transport is NOT called again
    const res2 = await runtime.callTool("getWidget", {}, async () => context);
    expect(res2).toEqual({ id: "1", name: "Cached Widget" });
    expect(transport.requests).toHaveLength(1);
  });

  describe("Base URL scheme, port, and path prefix preservation (RM-06)", () => {
    it("preserves path prefix when building upstream URL", async () => {
      const transport = new FakeTransport([jsonResponse({ status: "ok" })]);
      const executor = createUpstreamExecutor({
        baseUrl: "https://api.example.com/v2",
        allowedHosts: ["api.example.com"],
        resolveHost: async () => ["8.8.8.8"],
        transport,
      });

      const tool = executor.createTool(
        operation({
          name: "getPets",
          method: "get",
          path: "/pets",
        }),
      );

      const runtime = new InMemoryToolRuntime();
      runtime.register(tool);

      await runtime.callTool("getPets", {}, async () => context);
      expect(transport.requests).toHaveLength(1);
      expect(transport.requests[0]?.url.toString()).toBe(
        "https://api.example.com/v2/pets",
      );
    });

    it("does not double-slash when baseUrl has a trailing slash", async () => {
      const transport = new FakeTransport([jsonResponse({ status: "ok" })]);
      const executor = createUpstreamExecutor({
        baseUrl: "https://api.example.com/v2/",
        allowedHosts: ["api.example.com"],
        resolveHost: async () => ["8.8.8.8"],
        transport,
      });

      const tool = executor.createTool(
        operation({
          name: "getPets",
          method: "get",
          path: "/pets",
        }),
      );

      const runtime = new InMemoryToolRuntime();
      runtime.register(tool);

      await runtime.callTool("getPets", {}, async () => context);
      expect(transport.requests).toHaveLength(1);
      expect(transport.requests[0]?.url.toString()).toBe(
        "https://api.example.com/v2/pets",
      );
    });

    it("preserves custom port and http scheme when allowInsecureHttp is enabled", async () => {
      const transport = new FakeTransport([jsonResponse({ status: "ok" })]);
      const executor = createUpstreamExecutor({
        baseUrl: "http://127.0.0.1:8080",
        allowedHosts: ["127.0.0.1"],
        allowInsecureHttp: true,
        transport,
      });

      const tool = executor.createTool(
        operation({
          name: "getPets",
          method: "get",
          path: "/pets",
        }),
      );

      const runtime = new InMemoryToolRuntime();
      runtime.register(tool);

      await runtime.callTool("getPets", {}, async () => context);
      expect(transport.requests).toHaveLength(1);
      expect(transport.requests[0]?.url.toString()).toBe(
        "http://127.0.0.1:8080/pets",
      );
    });
  });
});

class MapCacheStore {
  private readonly map = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    return this.map.get(key) as T | undefined;
  }
  async set<T>(key: string, value: T): Promise<void> {
    this.map.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }
}

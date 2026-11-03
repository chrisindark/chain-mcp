import { describe, expect, it } from "vitest";

import {
  createFieldProjector,
  InMemoryToolRuntime,
  RuntimeError,
  type ToolContext,
} from "@chainmcp/core";
import {
  createUpstreamExecutor,
  type UpstreamTransport,
  type UpstreamTransportRequest,
  type UpstreamTransportResponse,
} from "@chainmcp/executor";

import {
  createDeclarativeToolSource,
  DeclarativeDescriptorError,
  type DeclarativeToolDescriptor,
} from "../src/index.js";

const context = (signal?: AbortSignal): ToolContext => ({
  requestId: "req-1",
  tenantId: "tenant-1",
  principal: { id: "principal-1", scopes: [] },
  ...(signal === undefined ? {} : { signal }),
});

function jsonResponse(value: unknown, contentType = "application/json") {
  return {
    status: 200,
    headers: { "content-type": contentType },
    body: new TextEncoder().encode(JSON.stringify(value)),
  };
}

function fixture(
  handler?: (
    request: UpstreamTransportRequest,
  ) => UpstreamTransportResponse | Promise<UpstreamTransportResponse>,
) {
  const requests: UpstreamTransportRequest[] = [];
  const transport: UpstreamTransport = {
    async request(request) {
      requests.push(request);
      return handler === undefined
        ? jsonResponse({ ok: true })
        : await handler(request);
    },
  };
  const executor = createUpstreamExecutor({
    baseUrl: "https://api.example.com/v1",
    allowedHosts: ["api.example.com"],
    resolveHost: async () => ["93.184.216.34"],
    transport,
  });
  return { requests, executor };
}

function getDescriptor(): DeclarativeToolDescriptor {
  return {
    descriptorVersion: 1,
    name: "get_user",
    description: "Fetches one user",
    request: {
      method: "GET",
      path: "/users/{userId}",
      parameters: [
        { name: "userId", in: "path", required: true },
        { name: "limit", in: "query" },
        { name: "X-Tenant", in: "header" },
      ],
    },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["userId"],
      properties: {
        userId: { type: "string" },
        limit: { type: "integer" },
        "X-Tenant": { type: "string" },
      },
    },
    policy: { cacheTtlSeconds: 30, timeoutMs: 5_000 },
  };
}

describe("DeclarativeToolSource", () => {
  it("executes a descriptor through the bounded executor", async () => {
    const { executor, requests } = fixture();
    const source = createDeclarativeToolSource({
      executor,
      descriptors: [getDescriptor()],
    });
    const runtime = new InMemoryToolRuntime({ tenantId: "tenant-1" });
    await runtime.registerSource(source);

    const result = await runtime.callTool(
      "get_user",
      { userId: "user 1", limit: 2, "X-Tenant": "acme" },
      context(),
    );

    expect(result).toEqual({ ok: true });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("GET");
    expect(requests[0]?.url.href).toBe(
      "https://api.example.com/v1/users/user%201?limit=2",
    );
    expect(requests[0]?.headers["X-Tenant"]).toBe("acme");

    const [tool] = source.getTools();
    expect(tool?.contractRevision).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(tool?.cache).toEqual({ ttlSeconds: 30 });
    expect(tool?.timeoutMs).toBe(5_000);
  });

  it("serializes a required JSON body for a POST descriptor", async () => {
    const { executor, requests } = fixture(() =>
      jsonResponse({ id: "u-1", name: "Ann" }),
    );
    const source = createDeclarativeToolSource({
      executor,
      descriptors: [
        {
          descriptorVersion: 1,
          name: "create_user",
          description: "Creates a user",
          request: {
            method: "POST",
            path: "/users",
            parameters: [],
            body: { required: true },
          },
          inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["body"],
            properties: {
              body: {
                type: "object",
                additionalProperties: false,
                required: ["name"],
                properties: { name: { type: "string" } },
              },
            },
          },
        },
      ],
    });
    const runtime = new InMemoryToolRuntime({ tenantId: "tenant-1" });
    await runtime.registerSource(source);

    const result = await runtime.callTool(
      "create_user",
      { body: { name: "Ann" } },
      context(),
    );

    expect(result).toEqual({ id: "u-1", name: "Ann" });
    expect(requests[0]?.method).toBe("POST");
    expect(requests[0]?.headers["content-type"]).toBe("application/json");
    expect(new TextDecoder().decode(requests[0]?.body)).toBe('{"name":"Ann"}');
  });

  it("injects credentials from a scheme reference, never from input", async () => {
    const requests: UpstreamTransportRequest[] = [];
    const descriptor: DeclarativeToolDescriptor = {
      ...getDescriptor(),
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["userId"],
        properties: { userId: { type: "string" } },
      },
      request: {
        method: "GET",
        path: "/users/{userId}",
        parameters: [{ name: "userId", in: "path", required: true }],
      },
      authentication: { alternatives: [{ schemes: [{ name: "api_key" }] }] },
    };
    const authenticatedExecutor = createUpstreamExecutor({
      baseUrl: "https://api.example.com/v1",
      allowedHosts: ["api.example.com"],
      resolveHost: async () => ["93.184.216.34"],
      transport: {
        async request(request) {
          requests.push(request);
          return jsonResponse({ ok: true });
        },
      },
      credentialProvider: {
        async resolveCredential() {
          return {
            type: "apiKey" as const,
            name: "X-API-Key",
            location: "header" as const,
            value: "s3cret",
          };
        },
      },
    });

    const source = createDeclarativeToolSource({
      executor: authenticatedExecutor,
      descriptors: [descriptor],
      authSchemes: {
        api_key: {
          type: "apiKey",
          parameterName: "X-API-Key",
          parameterLocation: "header",
        },
      },
    });
    const runtime = new InMemoryToolRuntime({ tenantId: "tenant-1" });
    await runtime.registerSource(source);

    await runtime.callTool("get_user", { userId: "u-1" }, context());

    expect(requests[0]?.headers["x-api-key"]).toBe("s3cret");
    expect(JSON.stringify(descriptor)).not.toContain("s3cret");
  });

  it("applies the declared output projection", async () => {
    const { executor } = fixture(() =>
      jsonResponse([
        { id: 1, secret: "hidden" },
        { id: 2, secret: "hidden" },
      ]),
    );
    const source = createDeclarativeToolSource({
      executor,
      descriptors: [
        {
          descriptorVersion: 1,
          name: "list_users",
          description: "Lists users",
          request: { method: "GET", path: "/users", parameters: [] },
          inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {},
          },
          policy: { outputFields: { include: ["id"] } },
        },
      ],
    });
    const runtime = new InMemoryToolRuntime({
      tenantId: "tenant-1",
      projector: createFieldProjector(),
    });
    await runtime.registerSource(source);

    const result = await runtime.callTool("list_users", {}, context());

    expect(result).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it("maps non-JSON upstream responses to a safe failure", async () => {
    const { executor } = fixture(() =>
      jsonResponse("<html>oops</html>", "text/html"),
    );
    const source = createDeclarativeToolSource({
      executor,
      descriptors: [
        {
          descriptorVersion: 1,
          name: "list_users",
          description: "Lists users",
          request: { method: "GET", path: "/users", parameters: [] },
          inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {},
          },
        },
      ],
    });
    const runtime = new InMemoryToolRuntime({ tenantId: "tenant-1" });
    await runtime.registerSource(source);

    await expect(
      runtime.callTool("list_users", {}, context()),
    ).rejects.toMatchObject({ code: "UPSTREAM_FAILURE" });
  });

  it("honors cancellation before any upstream request", async () => {
    const { executor, requests } = fixture();
    const source = createDeclarativeToolSource({
      executor,
      descriptors: [getDescriptor()],
    });
    const controller = new AbortController();
    controller.abort();

    await expect(
      source
        .getTools()[0]
        ?.execute({ userId: "u-1" }, context(controller.signal)),
    ).rejects.toMatchObject({ code: "CANCELLED" });
    expect(requests).toHaveLength(0);
  });

  it("rejects duplicate names and invalid descriptors at construction", () => {
    const { executor } = fixture();
    try {
      createDeclarativeToolSource({
        executor,
        descriptors: [getDescriptor(), getDescriptor()],
      });
      throw new Error("expected duplicate rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(DeclarativeDescriptorError);
      expect((error as DeclarativeDescriptorError).code).toBe("NAME_DUPLICATE");
    }

    try {
      createDeclarativeToolSource({
        executor,
        descriptors: [{ descriptorVersion: 1 }],
      });
      throw new Error("expected descriptor rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(DeclarativeDescriptorError);
      expect((error as DeclarativeDescriptorError).code).toBe(
        "DESCRIPTOR_INVALID",
      );
      expect((error as DeclarativeDescriptorError).message).toContain(
        "descriptors[0]",
      );
    }
  });

  it("does not register a descriptor whose required scope is denied by the authorizer", async () => {
    const { executor } = fixture();
    const source = createDeclarativeToolSource({
      executor,
      descriptors: [
        {
          ...getDescriptor(),
          policy: { requiredScopes: ["users:read"] },
        },
      ],
    });
    const runtime = new InMemoryToolRuntime({
      tenantId: "tenant-1",
      authorizer: {
        authorize(tool) {
          if ((tool.operation.requiredScopes ?? []).length > 0) {
            throw new RuntimeError("AUTH_FORBIDDEN", "Access denied");
          }
        },
      },
    });
    await runtime.registerSource(source);

    await expect(
      runtime.callTool("get_user", { userId: "u-1" }, context()),
    ).rejects.toMatchObject({ code: "AUTH_FORBIDDEN" });
  });
});

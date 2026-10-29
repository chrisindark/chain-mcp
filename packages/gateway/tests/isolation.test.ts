import { describe, expect, it } from "vitest";
import {
  type CacheStore,
  InMemoryCacheStore,
  type ToolContext,
  type ToolDefinition,
} from "@chainmcp/core";
import type {
  UpstreamTransport,
  UpstreamTransportRequest,
} from "@chainmcp/executor";
import type { UpstreamCredentialProvider } from "@chainmcp/auth";
import { DynamicGateway } from "../src/gateway.js";

const CONTRACT_A_SPEC = `
openapi: "3.0.3"
info:
  title: "Tenant A Service"
  version: "1.0.0"
security:
  - bearerAuth: []
paths:
  /data:
    get:
      operationId: "getData"
      summary: "Get tenant A data"
      responses:
        "200":
          description: "Tenant A data"
          content:
            application/json:
              schema:
                type: object
                properties:
                  origin:
                    type: string
components:
  securitySchemes:
    bearerAuth:
      type: http
      scheme: bearer
`;

const CONTRACT_B_SPEC = `
openapi: "3.0.3"
info:
  title: "Tenant B Service"
  version: "1.0.0"
security:
  - bearerAuth: []
paths:
  /data:
    get:
      operationId: "getData"
      summary: "Get tenant B data"
      responses:
        "200":
          description: "Tenant B data"
          content:
            application/json:
              schema:
                type: object
                properties:
                  origin:
                    type: string
components:
  securitySchemes:
    bearerAuth:
      type: http
      scheme: bearer
`;

describe("DynamicGateway Isolation", () => {
  it("enforces tenant discovery and invocation isolation with indistinguishable misses", async () => {
    const gateway = new DynamicGateway();

    const toolTenant1: ToolDefinition = {
      name: "tenant1Tool",
      description: "Tenant 1 specific tool",
      inputSchema: { type: "object" },
      ownerTenantId: "tenant-1",
      operation: {},
      execute: async () => ({ tenant: 1 }),
    };

    const toolTenant2: ToolDefinition = {
      name: "tenant2Tool",
      description: "Tenant 2 specific tool",
      inputSchema: { type: "object" },
      ownerTenantId: "tenant-2",
      operation: {},
      execute: async () => ({ tenant: 2 }),
    };

    await gateway.publishContract({
      tenantId: "tenant-1",
      contractName: "service1",
      tools: [toolTenant1],
      destinationPolicy: {
        baseUrl: "https://api.example.com",
        allowedHosts: ["api.example.com"],
      },
    });

    await gateway.publishContract({
      tenantId: "tenant-2",
      contractName: "service2",
      tools: [toolTenant2],
      destinationPolicy: {
        baseUrl: "https://api.example.com",
        allowedHosts: ["api.example.com"],
      },
    });

    const ctxTenant1: ToolContext = {
      tenantId: "tenant-1",
      requestId: "req-1",
      principal: { id: "user-1", scopes: [] },
    };

    const ctxTenant2: ToolContext = {
      tenantId: "tenant-2",
      requestId: "req-2",
      principal: { id: "user-2", scopes: [] },
    };

    // 1. Discovery isolation
    const t1Tools = gateway.listTools(ctxTenant1);
    expect(t1Tools.map((t) => t.name)).toEqual(["tenant1Tool"]);

    const t2Tools = gateway.listTools(ctxTenant2);
    expect(t2Tools.map((t) => t.name)).toEqual(["tenant2Tool"]);

    // 2. Listing without context fails closed with AUTH_REQUIRED
    expect(() => gateway.listTools()).toThrowError(/requires a caller context/);

    // 3. Invocation isolation: Tenant 1 calling Tenant 2 tool fails closed with TOOL_NOT_FOUND
    await expect(
      gateway.callTool("tenant2Tool", {}, ctxTenant1),
    ).rejects.toThrowError(/Tool 'tenant2Tool' was not found/);

    // 4. Tenant 2 calling Tenant 1 tool fails closed with TOOL_NOT_FOUND
    await expect(
      gateway.callTool("tenant1Tool", {}, ctxTenant2),
    ).rejects.toThrowError(/Tool 'tenant1Tool' was not found/);

    // 5. Calling legitimate tools succeeds
    expect(await gateway.callTool("tenant1Tool", {}, ctxTenant1)).toEqual({
      tenant: 1,
    });
    expect(await gateway.callTool("tenant2Tool", {}, ctxTenant2)).toEqual({
      tenant: 2,
    });
  });

  it("permits identical tool names across different tenants without cross-talk", async () => {
    const gateway = new DynamicGateway();

    const toolT1: ToolDefinition = {
      name: "getUser",
      description: "Tenant 1 User",
      inputSchema: { type: "object" },
      ownerTenantId: "tenant-1",
      operation: {},
      execute: async () => ({ scope: "tenant-1-user" }),
    };

    const toolT2: ToolDefinition = {
      name: "getUser",
      description: "Tenant 2 User",
      inputSchema: { type: "object" },
      ownerTenantId: "tenant-2",
      operation: {},
      execute: async () => ({ scope: "tenant-2-user" }),
    };

    await gateway.publishContract({
      tenantId: "tenant-1",
      contractName: "users-t1",
      tools: [toolT1],
      destinationPolicy: {
        baseUrl: "https://api.example.com",
        allowedHosts: ["api.example.com"],
      },
    });

    await gateway.publishContract({
      tenantId: "tenant-2",
      contractName: "users-t2",
      tools: [toolT2],
      destinationPolicy: {
        baseUrl: "https://api.example.com",
        allowedHosts: ["api.example.com"],
      },
    });

    const ctx1: ToolContext = {
      tenantId: "tenant-1",
      requestId: "r1",
      principal: { id: "u1", scopes: [] },
    };
    const ctx2: ToolContext = {
      tenantId: "tenant-2",
      requestId: "r2",
      principal: { id: "u2", scopes: [] },
    };

    expect(await gateway.callTool("getUser", {}, ctx1)).toEqual({
      scope: "tenant-1-user",
    });
    expect(await gateway.callTool("getUser", {}, ctx2)).toEqual({
      scope: "tenant-2-user",
    });
  });

  it("isolates network destination policies and upstream credentials per contract", async () => {
    const capturedRequests: UpstreamTransportRequest[] = [];
    const mockTransport: UpstreamTransport = {
      request: async (req) => {
        capturedRequests.push(req);
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: new TextEncoder().encode(JSON.stringify({ ok: true })),
        };
      },
    };

    const credProviderA: UpstreamCredentialProvider = {
      resolveCredential: async () => ({
        type: "http",
        scheme: "bearer",
        token: "secret-token-tenant-a",
      }),
    };

    const credProviderB: UpstreamCredentialProvider = {
      resolveCredential: async () => ({
        type: "http",
        scheme: "bearer",
        token: "secret-token-tenant-b",
      }),
    };

    const gateway = new DynamicGateway({
      transport: mockTransport,
      resolveHost: async (h) =>
        h.includes("tenant-a") ? ["93.184.216.34"] : ["93.184.216.35"],
    });

    await gateway.publishContract({
      tenantId: "tenant-a",
      contractName: "contract-a",
      source: CONTRACT_A_SPEC,
      destinationPolicy: {
        baseUrl: "https://api.tenant-a.com",
        allowedHosts: ["api.tenant-a.com"],
      },
      authConfig: {
        credentialProvider: credProviderA,
      },
    });

    await gateway.publishContract({
      tenantId: "tenant-b",
      contractName: "contract-b",
      source: CONTRACT_B_SPEC,
      destinationPolicy: {
        baseUrl: "https://api.tenant-b.com",
        allowedHosts: ["api.tenant-b.com"],
      },
      authConfig: {
        credentialProvider: credProviderB,
      },
    });

    // Call Tenant A
    await gateway.callTool(
      "getData",
      {},
      {
        tenantId: "tenant-a",
        requestId: "req-a",
        principal: { id: "user-a", scopes: [] },
      },
    );

    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0]?.hostname).toBe("api.tenant-a.com");
    expect(capturedRequests[0]?.headers.authorization).toBe(
      "Bearer secret-token-tenant-a",
    );

    // Call Tenant B
    await gateway.callTool(
      "getData",
      {},
      {
        tenantId: "tenant-b",
        requestId: "req-b",
        principal: { id: "user-b", scopes: [] },
      },
    );

    expect(capturedRequests).toHaveLength(2);
    expect(capturedRequests[1]?.hostname).toBe("api.tenant-b.com");
    expect(capturedRequests[1]?.headers.authorization).toBe(
      "Bearer secret-token-tenant-b",
    );
  });

  it("enforces per-contract required scopes in inbound authorization", async () => {
    const gateway = new DynamicGateway();
    const adminTool: ToolDefinition = {
      name: "adminAction",
      description: "Restricted tool",
      inputSchema: { type: "object" },
      ownerTenantId: "tenant-x",
      operation: {},
      execute: async () => ({ privileged: true }),
    };

    await gateway.publishContract({
      tenantId: "tenant-x",
      contractName: "admin-service",
      tools: [adminTool],
      destinationPolicy: {
        baseUrl: "https://api.example.com",
        allowedHosts: ["api.example.com"],
      },
      authConfig: {
        requiredScopes: ["tenant:admin"],
      },
    });

    const unauthorizedCtx: ToolContext = {
      tenantId: "tenant-x",
      requestId: "req-1",
      principal: { id: "u1", scopes: ["tenant:read"] },
    };

    const authorizedCtx: ToolContext = {
      tenantId: "tenant-x",
      requestId: "req-2",
      principal: { id: "u2", scopes: ["tenant:read", "tenant:admin"] },
    };

    // User missing scope gets AUTH_FORBIDDEN
    await expect(
      gateway.callTool("adminAction", {}, unauthorizedCtx),
    ).rejects.toThrowError(/Access denied/);

    // User with required scope succeeds
    expect(await gateway.callTool("adminAction", {}, authorizedCtx)).toEqual({
      privileged: true,
    });
  });

  it("guarantees cache isolation across tenants using shared cache store", async () => {
    const memoryStore: CacheStore = new InMemoryCacheStore({
      maxBytes: 100_000,
      maxEntryBytes: 10_000,
      maxEntries: 100,
    });

    let toolExecutions = 0;
    const cacheableToolT1: ToolDefinition = {
      name: "fetchData",
      description: "Cached tool",
      inputSchema: { type: "object" },
      ownerTenantId: "tenant-1",
      operation: { requiredScopes: [] },
      contractRevision: "rev-1",
      cache: { ttlSeconds: 60 },
      execute: async () => {
        toolExecutions++;
        return { data: "tenant-1-result", execCount: toolExecutions };
      },
    };

    const cacheableToolT2: ToolDefinition = {
      name: "fetchData",
      description: "Cached tool",
      inputSchema: { type: "object" },
      ownerTenantId: "tenant-2",
      operation: { requiredScopes: [] },
      contractRevision: "rev-2",
      cache: { ttlSeconds: 60 },
      execute: async () => {
        toolExecutions++;
        return { data: "tenant-2-result", execCount: toolExecutions };
      },
    };

    const gateway = new DynamicGateway({
      cache: {
        store: memoryStore,
        authorizationPartition: (ctx) => `part-${ctx.tenantId}`,
      },
    });

    await gateway.publishContract({
      tenantId: "tenant-1",
      contractName: "service-1",
      tools: [cacheableToolT1],
      destinationPolicy: {
        baseUrl: "https://api.example.com",
        allowedHosts: ["api.example.com"],
      },
    });

    await gateway.publishContract({
      tenantId: "tenant-2",
      contractName: "service-2",
      tools: [cacheableToolT2],
      destinationPolicy: {
        baseUrl: "https://api.example.com",
        allowedHosts: ["api.example.com"],
      },
    });

    const ctx1: ToolContext = {
      tenantId: "tenant-1",
      requestId: "r1",
      principal: { id: "user-1", scopes: [] },
    };

    const ctx2: ToolContext = {
      tenantId: "tenant-2",
      requestId: "r2",
      principal: { id: "user-2", scopes: [] },
    };

    // First call by tenant 1 -> executes
    const res1 = await gateway.callTool("fetchData", {}, ctx1);
    expect(res1).toEqual({ data: "tenant-1-result", execCount: 1 });

    // Second call by tenant 1 -> cache hit (execCount remains 1)
    const res1Cached = await gateway.callTool("fetchData", {}, ctx1);
    expect(res1Cached).toEqual({ data: "tenant-1-result", execCount: 1 });

    // First call by tenant 2 -> must NOT hit tenant 1's cache! (executes, execCount becomes 2)
    const res2 = await gateway.callTool("fetchData", {}, ctx2);
    expect(res2).toEqual({ data: "tenant-2-result", execCount: 2 });
  });

  it("rejects tool invocation and listing with TENANT_REQUIRED when tenantId is empty or absent", async () => {
    const gateway = new DynamicGateway();
    await gateway.publishContract({
      tenantId: "tenant-1",
      contractName: "service-1",
      tools: [
        {
          name: "tool_1",
          description: "Tool 1",
          ownerTenantId: "tenant-1",
          operation: {},
          inputSchema: { type: "object" },
          execute: async () => ({ ok: true }),
        },
      ],
      destinationPolicy: {
        baseUrl: "https://api.test",
        allowedHosts: ["api.test"],
      },
      autoActivate: true,
    });

    const emptyTenantCtx: ToolContext = {
      tenantId: "",
      requestId: "r-empty",
      principal: { id: "user-empty", scopes: [] },
    };

    try {
      gateway.listTools(emptyTenantCtx);
      expect.fail("Expected listTools to throw");
    } catch (err: unknown) {
      expect((err as { code?: string }).code).toBe("TENANT_REQUIRED");
    }

    await expect(
      gateway.callTool("tool_1", {}, emptyTenantCtx),
    ).rejects.toMatchObject({
      code: "TENANT_REQUIRED",
    });
  });
});

import { describe, expect, it } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { RuntimeError, type ToolDefinition } from "@chainmcp/core";
import { DynamicGateway } from "../src/gateway.js";
import { connectGatewayServer } from "../src/server.js";

describe("DynamicGateway MCP Server Integration", () => {
  it("serves multi-tenant discovery and execution over MCP protocol with strict isolation", async () => {
    const gateway = new DynamicGateway();

    const toolT1: ToolDefinition = {
      name: "tool_t1",
      description: "Tenant 1 tool",
      inputSchema: {
        type: "object",
        properties: { val: { type: "number" } },
      },
      ownerTenantId: "tenant-1",
      operation: {},
      execute: async (input) => ({
        tenant: "tenant-1",
        received: (input as { val?: number })?.val ?? 0,
      }),
    };

    const toolT2: ToolDefinition = {
      name: "tool_t2",
      description: "Tenant 2 tool",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
      },
      ownerTenantId: "tenant-2",
      operation: {},
      execute: async (input) => ({
        tenant: "tenant-2",
        received: (input as { text?: string })?.text ?? "",
      }),
    };

    await gateway.publishContract({
      tenantId: "tenant-1",
      contractName: "contract-1",
      tools: [toolT1],
      destinationPolicy: {
        baseUrl: "https://api.example.com",
        allowedHosts: ["api.example.com"],
      },
    });

    await gateway.publishContract({
      tenantId: "tenant-2",
      contractName: "contract-2",
      tools: [toolT2],
      destinationPolicy: {
        baseUrl: "https://api.example.com",
        allowedHosts: ["api.example.com"],
      },
    });

    // Client 1 connected with Tenant 1 identity
    const [client1Transport, server1Transport] =
      InMemoryTransport.createLinkedPair();
    const client1 = new Client(
      { name: "client-1", version: "0.1.0" },
      { capabilities: {} },
    );

    const server1Handle = await connectGatewayServer(
      gateway,
      server1Transport,
      {
        name: "gateway-server",
        version: "0.1.0",
        createContext: () => ({
          requestId: "req-c1",
          tenantId: "tenant-1",
          principal: { id: "user-1", scopes: [] },
        }),
      },
    );
    await client1.connect(client1Transport);

    // Client 2 connected with Tenant 2 identity
    const [client2Transport, server2Transport] =
      InMemoryTransport.createLinkedPair();
    const client2 = new Client(
      { name: "client-2", version: "0.1.0" },
      { capabilities: {} },
    );

    const server2Handle = await connectGatewayServer(
      gateway,
      server2Transport,
      {
        name: "gateway-server",
        version: "0.1.0",
        createContext: () => ({
          requestId: "req-c2",
          tenantId: "tenant-2",
          principal: { id: "user-2", scopes: [] },
        }),
      },
    );
    await client2.connect(client2Transport);

    try {
      // 1. Verify Client 1 discovery
      const c1List = await client1.listTools();
      expect(c1List.tools.map((t) => t.name)).toEqual(["tool_t1"]);

      // 2. Verify Client 2 discovery
      const c2List = await client2.listTools();
      expect(c2List.tools.map((t) => t.name)).toEqual(["tool_t2"]);

      // 3. Client 1 calling its own tool succeeds
      const c1Call = await client1.callTool({
        name: "tool_t1",
        arguments: { val: 42 },
      });
      expect(c1Call.isError).toBeFalsy();
      const c1Text = (c1Call.content[0] as { type: "text"; text: string }).text;
      expect(JSON.parse(c1Text)).toEqual({ tenant: "tenant-1", received: 42 });

      // 4. Client 1 calling Tenant 2's tool fails closed (isError: true, TOOL_NOT_FOUND)
      const c1CrossCall = await client1.callTool({
        name: "tool_t2",
        arguments: { text: "exploit" },
      });
      expect(c1CrossCall.isError).toBe(true);
      const crossText = (
        c1CrossCall.content[0] as { type: "text"; text: string }
      ).text;
      expect(crossText).toContain("TOOL_NOT_FOUND: Tool not found");

      // 5. Client 2 calling its own tool succeeds
      const c2Call = await client2.callTool({
        name: "tool_t2",
        arguments: { text: "hello" },
      });
      expect(c2Call.isError).toBeFalsy();
      const c2Text = (c2Call.content[0] as { type: "text"; text: string }).text;
      expect(JSON.parse(c2Text)).toEqual({
        tenant: "tenant-2",
        received: "hello",
      });
    } finally {
      await client1.close();
      await client2.close();
      await server1Handle.close();
      await server2Handle.close();
    }
  });

  it("fails tool execution with TENANT_REQUIRED when authenticated principal lacks tenantId, and does not execute tool", async () => {
    let executed = false;

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client(
      { name: "test-client", version: "0.1.0" },
      { capabilities: {} },
    );

    const auditEvents: unknown[] = [];
    // Attach audit sink to capture failure event
    const gatewayWithSink = new DynamicGateway({
      auditSink: (event) => {
        auditEvents.push(event);
      },
    });
    gatewayWithSink.onToolsChanged(() => {}); // verify listener works
    await gatewayWithSink.publishContract({
      tenantId: "tenant-corp",
      contractName: "corp-service",
      tools: [
        {
          name: "sensitiveTool",
          description: "Corp tool",
          ownerTenantId: "tenant-corp",
          operation: {},
          inputSchema: { type: "object" },
          execute: async () => {
            executed = true;
            return { secret: "corp-secret" };
          },
        },
      ],
      destinationPolicy: {
        baseUrl: "https://api.test",
        allowedHosts: ["api.test"],
      },
    });

    const serverHandle = await connectGatewayServer(
      gatewayWithSink,
      serverTransport,
      {
        name: "gateway-server",
        version: "0.1.0",
        createContext: (request) => {
          const auth = request.authInfo as
            { clientId?: string; extra?: Record<string, unknown> } | undefined;
          const tenantId = (auth?.extra?.tenantId as string) ?? undefined;
          if (!tenantId) {
            void gatewayWithSink.emitAudit({
              type: "tenant_resolution_failed",
              timestamp: Date.now(),
              tenantId: "",
              contractName: "",
              revisionId: "",
              toolCount: 0,
              details: { clientId: auth?.clientId },
            });
            throw new RuntimeError(
              "TENANT_REQUIRED",
              "Tenant context required to invoke tools in multi-tenant mode",
            );
          }
          return {
            requestId: "req-1",
            tenantId,
            principal: { id: auth?.clientId ?? "anon", scopes: [] },
          };
        },
      },
    );

    await client.connect(clientTransport);

    try {
      const callResult = await client.callTool({
        name: "sensitiveTool",
        arguments: {},
      });
      expect(callResult.isError).toBe(true);
      const text = (callResult.content[0] as { type: "text"; text: string })
        .text;
      expect(text).toContain("TENANT_REQUIRED");
      expect(executed).toBe(false);
      expect(
        auditEvents.some(
          (e: unknown) =>
            (e as { type?: string }).type === "tenant_resolution_failed",
        ),
      ).toBe(true);
    } finally {
      await client.close();
      await serverHandle.close();
    }
  });

  it("prioritizes authenticated principal tenantId over explicit default tenant", async () => {
    const gateway = new DynamicGateway();

    await gateway.publishContract({
      tenantId: "tenant-acme",
      contractName: "acme-service",
      tools: [
        {
          name: "getAcmeData",
          description: "Acme data",
          ownerTenantId: "tenant-acme",
          operation: {},
          inputSchema: { type: "object" },
          execute: async () => ({ tenant: "tenant-acme" }),
        },
      ],
      destinationPolicy: {
        baseUrl: "https://api.test",
        allowedHosts: ["api.test"],
      },
    });

    await gateway.publishContract({
      tenantId: "tenant-fallback",
      contractName: "fallback-service",
      tools: [
        {
          name: "getFallbackData",
          description: "Fallback data",
          ownerTenantId: "tenant-fallback",
          operation: {},
          inputSchema: { type: "object" },
          execute: async () => ({ tenant: "tenant-fallback" }),
        },
      ],
      destinationPolicy: {
        baseUrl: "https://api.test",
        allowedHosts: ["api.test"],
      },
    });

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client(
      { name: "test-client", version: "0.1.0" },
      { capabilities: {} },
    );

    const explicitDefault = "tenant-fallback";
    const serverHandle = await connectGatewayServer(gateway, serverTransport, {
      name: "gateway-server",
      version: "0.1.0",
      createContext: () => {
        // Request has authenticated tenant "tenant-acme"
        const auth = {
          extra: { tenantId: "tenant-acme" },
          clientId: "user-acme",
        };
        const authTenant = auth.extra?.tenantId;
        const tenantId = authTenant ?? explicitDefault;
        return {
          requestId: "req-prio",
          tenantId,
          principal: { id: auth.clientId, scopes: [] },
        };
      },
    });

    await client.connect(clientTransport);

    try {
      // Must see Acme tools, not Fallback tools
      const listRes = await client.listTools();
      expect(listRes.tools.map((t) => t.name)).toEqual(["getAcmeData"]);

      const callRes = await client.callTool({
        name: "getAcmeData",
        arguments: {},
      });
      expect(callRes.isError).toBeFalsy();
      const text = (callRes.content[0] as { type: "text"; text: string }).text;
      expect(JSON.parse(text)).toEqual({ tenant: "tenant-acme" });
    } finally {
      await client.close();
      await serverHandle.close();
    }
  });
});

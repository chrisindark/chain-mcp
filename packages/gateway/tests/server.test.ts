import { describe, expect, it } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { ToolDefinition } from "@chainmcp/core";
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
});

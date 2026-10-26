import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";

import type { UpstreamTransport } from "@chainmcp/executor";
import { DynamicGateway } from "../src/gateway.js";
import { connectGatewayServer } from "../src/server.js";

const BILLING_OPENAPI = `
openapi: "3.1.0"
info:
  title: Billing API
  version: "1.0.0"
paths:
  /invoices:
    get:
      operationId: getInvoices
      summary: List all invoices
      responses:
        "200":
          description: List of invoices
          content:
            application/json:
              schema:
                type: array
                items:
                  type: object
                  properties:
                    id:
                      type: string
                    amount:
                      type: number
`;

const INVENTORY_OPENAPI = `
openapi: "3.1.0"
info:
  title: Inventory API
  version: "1.0.0"
paths:
  /items:
    get:
      operationId: getItems
      summary: List inventory items
      responses:
        "200":
          description: List of items
          content:
            application/json:
              schema:
                type: array
                items:
                  type: object
                  properties:
                    sku:
                      type: string
                    qty:
                      type: integer
`;

const ANALYTICS_OPENAPI = `
openapi: "3.1.0"
info:
  title: Analytics API
  version: "1.0.0"
paths:
  /reports:
    get:
      operationId: getReports
      summary: List analytics reports
      responses:
        "200":
          description: List of reports
          content:
            application/json:
              schema:
                type: array
                items:
                  type: object
                  properties:
                    reportId:
                      type: string
`;

function createMockTransport(): UpstreamTransport {
  return {
    request: async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/invoices") {
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: new TextEncoder().encode(
            JSON.stringify([{ id: "inv-001", amount: 99.99 }]),
          ),
        };
      }
      if (url.pathname === "/items") {
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: new TextEncoder().encode(
            JSON.stringify([{ sku: "item-abc", qty: 42 }]),
          ),
        };
      }
      if (url.pathname === "/reports") {
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: new TextEncoder().encode(
            JSON.stringify([{ reportId: "rep-2026" }]),
          ),
        };
      }
      return {
        status: 404,
        headers: { "content-type": "application/json" },
        body: new TextEncoder().encode(JSON.stringify({ error: "Not found" })),
      };
    },
  };
}

describe("DynamicGateway Multi-Contract SDK End-to-End", () => {
  it("manages multi-contract lifecycles, emits tools/list_changed notifications, and isolates tenants", async () => {
    const transport = createMockTransport();
    const gateway = new DynamicGateway({
      transport,
      resolveHost: async () => ["93.184.216.34"],
    });

    // 1. Publish initial contracts for tenant-corp
    await gateway.publishContract({
      tenantId: "tenant-corp",
      contractName: "billing",
      source: BILLING_OPENAPI,
      destinationPolicy: {
        baseUrl: "https://billing.example.com",
        allowedHosts: ["billing.example.com"],
      },
    });

    const inventoryRev1 = await gateway.publishContract({
      tenantId: "tenant-corp",
      contractName: "inventory",
      source: INVENTORY_OPENAPI,
      destinationPolicy: {
        baseUrl: "https://inventory.example.com",
        allowedHosts: ["inventory.example.com"],
      },
    });

    // 2. Connect official MCP Client
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    const client = new Client(
      { name: "test-client", version: "1.0.0" },
      { capabilities: {} },
    );

    let listChangedCount = 0;
    client.setNotificationHandler("notifications/tools/list_changed", () => {
      listChangedCount++;
    });

    const serverHandle = await connectGatewayServer(gateway, serverTransport, {
      name: "enterprise-gateway",
      version: "1.0.0",
      createContext: () => ({
        requestId: "req-1",
        tenantId: "tenant-corp",
        principal: { id: "corp-user", scopes: [] },
      }),
    });

    await client.connect(clientTransport);

    try {
      // 3. Verify initial tool listing (2 contracts = 2 tools)
      const initialTools = await client.listTools();
      const initialNames = initialTools.tools.map((t) => t.name).sort();
      expect(initialNames).toEqual(["getInvoices", "getItems"]);

      // 4. Invoke a tool via the MCP client
      const invoiceResult = await client.callTool({
        name: "getInvoices",
        arguments: {},
      });
      expect(invoiceResult.isError).toBeFalsy();
      const invoiceText = (
        invoiceResult.content[0] as { type: "text"; text: string }
      ).text;
      expect(JSON.parse(invoiceText)).toEqual([
        { id: "inv-001", amount: 99.99 },
      ]);

      // 5. Publish 3rd contract (analytics) -> triggers tools/list_changed notification
      const prevNotificationCount = listChangedCount;
      await gateway.publishContract({
        tenantId: "tenant-corp",
        contractName: "analytics",
        source: ANALYTICS_OPENAPI,
        destinationPolicy: {
          baseUrl: "https://analytics.example.com",
          allowedHosts: ["analytics.example.com"],
        },
      });

      // Notification should have been delivered
      expect(listChangedCount).toBeGreaterThan(prevNotificationCount);

      // Verify updated tools list has 3 tools
      const updatedTools = await client.listTools();
      const updatedNames = updatedTools.tools.map((t) => t.name).sort();
      expect(updatedNames).toEqual(["getInvoices", "getItems", "getReports"]);

      // 6. Disable inventory contract -> triggers tools/list_changed notification
      const countBeforeDisable = listChangedCount;
      await gateway.disableContract("tenant-corp", "inventory");
      expect(listChangedCount).toBeGreaterThan(countBeforeDisable);

      const afterDisableTools = await client.listTools();
      const afterDisableNames = afterDisableTools.tools
        .map((t) => t.name)
        .sort();
      expect(afterDisableNames).toEqual(["getInvoices", "getReports"]);

      // Attempting to call disabled tool fails closed
      const disabledCall = await client.callTool({
        name: "getItems",
        arguments: {},
      });
      expect(disabledCall.isError).toBe(true);

      // 7. Rollback inventory contract -> restores getItems and triggers tools/list_changed
      const countBeforeRollback = listChangedCount;
      await gateway.rollbackContract(
        "tenant-corp",
        "inventory",
        inventoryRev1.revisionId,
      );
      expect(listChangedCount).toBeGreaterThan(countBeforeRollback);

      const afterRollbackTools = await client.listTools();
      const afterRollbackNames = afterRollbackTools.tools
        .map((t) => t.name)
        .sort();
      expect(afterRollbackNames).toEqual([
        "getInvoices",
        "getItems",
        "getReports",
      ]);

      // 8. Test tenant isolation with a second client connected as tenant-outsider
      const [outsiderClientTransport, outsiderServerTransport] =
        InMemoryTransport.createLinkedPair();
      const outsiderClient = new Client(
        { name: "outsider-client", version: "1.0.0" },
        { capabilities: {} },
      );

      const outsiderServerHandle = await connectGatewayServer(
        gateway,
        outsiderServerTransport,
        {
          name: "enterprise-gateway",
          version: "1.0.0",
          createContext: () => ({
            requestId: "req-2",
            tenantId: "tenant-outsider",
            principal: { id: "outsider-user", scopes: [] },
          }),
        },
      );

      await outsiderClient.connect(outsiderClientTransport);

      try {
        const outsiderTools = await outsiderClient.listTools();
        expect(outsiderTools.tools).toHaveLength(0);

        const unauthorizedCall = await outsiderClient.callTool({
          name: "getInvoices",
          arguments: {},
        });
        expect(unauthorizedCall.isError).toBe(true);
      } finally {
        await outsiderClient.close();
        await outsiderServerHandle.close();
      }
    } finally {
      await client.close();
      await serverHandle.close();
    }
  });
});

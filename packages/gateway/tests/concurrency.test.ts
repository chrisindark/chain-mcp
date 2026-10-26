import { describe, expect, it } from "vitest";
import type { ToolContext, ToolDefinition } from "@chainmcp/core";
import { DynamicGateway } from "../src/gateway.js";

describe("DynamicGateway Concurrency", () => {
  it("handles concurrent contract publications, reloads, and calls without corruption", async () => {
    const gateway = new DynamicGateway();
    const tenantCount = 4;
    const iterations = 5;

    // Helper to generate a dummy tool
    const makeTool = (tenantId: string, version: number): ToolDefinition => ({
      name: `tool_${tenantId}`,
      description: `Tool for ${tenantId} v${version}`,
      inputSchema: { type: "object" },
      ownerTenantId: tenantId,
      operation: {},
      execute: async () => ({ tenant: tenantId, version }),
    });

    // Run parallel publish operations across multiple tenants
    const publishTasks: Promise<unknown>[] = [];
    for (let t = 1; t <= tenantCount; t++) {
      const tenantId = `tenant-${t}`;
      publishTasks.push(
        gateway.publishContract({
          tenantId,
          contractName: `contract-${tenantId}`,
          tools: [makeTool(tenantId, 1)],
          destinationPolicy: {
            baseUrl: "https://api.example.com",
            allowedHosts: ["api.example.com"],
          },
        }),
      );
    }
    await Promise.all(publishTasks);

    // Verify all tenants can list and call their tools
    for (let t = 1; t <= tenantCount; t++) {
      const tenantId = `tenant-${t}`;
      const ctx: ToolContext = {
        tenantId,
        requestId: `req-${t}`,
        principal: { id: `user-${t}`, scopes: [] },
      };
      const tools = gateway.listTools(ctx);
      expect(tools.map((x) => x.name)).toEqual([`tool_${tenantId}`]);
      const res = await gateway.callTool(`tool_${tenantId}`, {}, ctx);
      expect(res).toEqual({ tenant: tenantId, version: 1 });
    }

    // Now fire concurrent reloads, rollbacks, and calls in a tight loop
    const concurrentOperations: Promise<unknown>[] = [];

    for (let i = 2; i <= iterations + 1; i++) {
      for (let t = 1; t <= tenantCount; t++) {
        const tenantId = `tenant-${t}`;
        const ctx: ToolContext = {
          tenantId,
          requestId: `concurrent-${t}-${i}`,
          principal: { id: `user-${t}`, scopes: [] },
        };

        // Reload to version i
        concurrentOperations.push(
          gateway.publishContract({
            tenantId,
            contractName: `contract-${tenantId}`,
            tools: [makeTool(tenantId, i)],
            destinationPolicy: {
              baseUrl: "https://api.example.com",
              allowedHosts: ["api.example.com"],
            },
          }),
        );

        // Concurrent tool call
        concurrentOperations.push(
          gateway.callTool(`tool_${tenantId}`, {}, ctx).then((res) => {
            const data = res as { tenant: string; version: number };
            expect(data.tenant).toBe(tenantId);
            expect(data.version).toBeGreaterThanOrEqual(1);
          }),
        );
      }
    }

    await Promise.all(concurrentOperations);

    // After all operations, verify final state consistency for all tenants
    for (let t = 1; t <= tenantCount; t++) {
      const tenantId = `tenant-${t}`;
      const ctx: ToolContext = {
        tenantId,
        requestId: `final-${t}`,
        principal: { id: `user-${t}`, scopes: [] },
      };
      const tools = gateway.listTools(ctx);
      expect(tools).toHaveLength(1);
      const res = await gateway.callTool(`tool_${tenantId}`, {}, ctx);
      expect(res).toEqual({ tenant: tenantId, version: iterations + 1 });
    }
  });
});

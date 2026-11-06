import { describe, expect, it, vi } from "vitest";
import type { ToolContext, ToolDefinition } from "@chainmcp/core";
import { DynamicGateway } from "../src/gateway.js";
import { ContractRegistry } from "../src/registry.js";
import { createGatewayServer } from "../src/server.js";
import { GatewayError } from "../src/types.js";

function dummyTool(name: string, tenantId: string): ToolDefinition {
  return {
    name,
    description: `Tool ${name}`,
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
      },
    },
    ownerTenantId: tenantId,
    operation: {},
    execute: async (input) => ({ echo: input }),
  };
}

describe("Gateway Additional Tests (gateway.ts, registry.ts, server.ts)", () => {
  describe("createGatewayServer", () => {
    it("initializes an McpServer instance from DynamicGateway and options", () => {
      const gateway = new DynamicGateway();
      const server = createGatewayServer(gateway, {
        name: "test-gateway-server",
        version: "1.0.0",
        createContext: () => ({
          tenantId: "tenant-1",
          requestId: "req-1",
          principal: { id: "user-1", scopes: [] },
        }),
      });
      expect(server).toBeDefined();
    });
  });

  describe("DynamicGateway listener and error cases", () => {
    it("validates onToolsChanged listener and handles exceptions gracefully", async () => {
      const gateway = new DynamicGateway();

      expect(() =>
        gateway.onToolsChanged("not a function" as unknown as () => void),
      ).toThrow("listener must be a function");

      const throwingListener = vi.fn().mockImplementation(() => {
        throw new Error("listener error");
      });
      const unsubscribe = gateway.onToolsChanged(throwingListener);

      const tool = dummyTool("testTool", "tenant-1");
      await gateway.publishContract({
        tenantId: "tenant-1",
        contractName: "contract-1",
        tools: [tool],
        destinationPolicy: {
          baseUrl: "https://api.example.com",
          allowedHosts: ["api.example.com"],
        },
      });

      expect(throwingListener).toHaveBeenCalledTimes(1);

      // Unsubscribe stops notifications
      unsubscribe();
      await gateway.disableContract("tenant-1", "contract-1");
      expect(throwingListener).toHaveBeenCalledTimes(1);
    });

    it("rejects publishContract with invalid sources or missing tools/source", async () => {
      const gateway = new DynamicGateway();

      await expect(
        gateway.publishContract({
          tenantId: "tenant-1",
          contractName: "contract-1",
          source: "",
          destinationPolicy: {
            baseUrl: "https://api.example.com",
            allowedHosts: ["api.example.com"],
          },
        }),
      ).rejects.toThrowError(GatewayError);

      await expect(
        gateway.publishContract({
          tenantId: "tenant-1",
          contractName: "contract-1",
          source: "invalid openapi yaml text without paths or openapi",
          destinationPolicy: {
            baseUrl: "https://api.example.com",
            allowedHosts: ["api.example.com"],
          },
        }),
      ).rejects.toThrowError(GatewayError);

      await expect(
        gateway.publishContract({
          tenantId: "tenant-1",
          contractName: "contract-1",
          tools: [],
          destinationPolicy: {
            baseUrl: "https://api.example.com",
            allowedHosts: ["api.example.com"],
          },
        }),
      ).rejects.toThrowError(GatewayError);

      await expect(
        gateway.publishContract({
          tenantId: "tenant-1",
          contractName: "contract-1",
          destinationPolicy: {
            baseUrl: "https://api.example.com",
            allowedHosts: ["api.example.com"],
          },
        } as unknown as Parameters<DynamicGateway["publishContract"]>[0]),
      ).rejects.toThrowError(GatewayError);
    });

    it("supports publishContract with autoActivate: false and manual activation", async () => {
      const gateway = new DynamicGateway();
      const tool = dummyTool("manualTool", "tenant-1");

      const rev = await gateway.publishContract({
        tenantId: "tenant-1",
        contractName: "contract-manual",
        tools: [tool],
        destinationPolicy: {
          baseUrl: "https://api.example.com",
          allowedHosts: ["api.example.com"],
        },
        autoActivate: false,
      });

      expect(rev.status).toBe("candidate");
      const activeBefore = gateway
        .getRegistry()
        .listActiveRevisions("tenant-1");
      expect(activeBefore).toHaveLength(0);

      const activated = await gateway.activateRevision(
        "tenant-1",
        "contract-manual",
        rev.revisionId,
      );
      expect(activated.status).toBe("active");

      const activeAfter = gateway.getRegistry().listActiveRevisions("tenant-1");
      expect(activeAfter).toHaveLength(1);
    });

    it("delegates direct register and registerSource calls to active runtime", async () => {
      const gateway = new DynamicGateway();
      const tool1 = dummyTool("directTool1", "tenant-1");
      const tool2 = dummyTool("directTool2", "tenant-1");

      gateway.register(tool1);
      await gateway.registerSource({
        getTools: async () => [tool2],
      });

      const testContext: ToolContext = {
        tenantId: "tenant-1",
        requestId: "req-1",
        principal: { id: "user-1", scopes: [] },
      };

      const tools = gateway.listTools(testContext);
      expect(tools.map((t) => t.name).sort()).toEqual([
        "directTool1",
        "directTool2",
      ]);

      // Invalidate cached result delegates cleanly
      await gateway.invalidateCachedResult("directTool1", {}, testContext);
    });

    it("merges requiredScopes into tools when specified in authConfig", async () => {
      const gateway = new DynamicGateway();
      const tool = dummyTool("scopedTool", "tenant-1");

      const rev = await gateway.publishContract({
        tenantId: "tenant-1",
        contractName: "contract-scoped",
        tools: [tool],
        destinationPolicy: {
          baseUrl: "https://api.example.com",
          allowedHosts: ["api.example.com"],
        },
        authConfig: {
          requiredScopes: ["read:data", "write:data"],
        },
      });

      expect(rev.tools[0]?.operation?.requiredScopes).toEqual([
        "read:data",
        "write:data",
      ]);
    });
  });

  describe("ContractRegistry edge cases", () => {
    it("validates destination policies exhaustively", () => {
      const registry = new ContractRegistry();
      const tool = dummyTool("testTool", "tenant-1");

      const baseOptions = {
        tenantId: "tenant-1",
        contractName: "contract-1",
        sourceHash: "hash123",
        tools: [tool],
      };

      expect(() =>
        registry.createRevision({
          ...baseOptions,
          destinationPolicy: null as unknown as {
            baseUrl: string;
            allowedHosts: string[];
          },
        }),
      ).toThrowError(/Destination policy must be an object/);

      expect(() =>
        registry.createRevision({
          ...baseOptions,
          destinationPolicy: { baseUrl: "", allowedHosts: ["api.example.com"] },
        }),
      ).toThrowError(/baseUrl must be a non-empty string/);

      expect(() =>
        registry.createRevision({
          ...baseOptions,
          destinationPolicy: {
            baseUrl: "not-a-valid-url",
            allowedHosts: ["api.example.com"],
          },
        }),
      ).toThrowError(/not a valid absolute URL/);

      expect(() =>
        registry.createRevision({
          ...baseOptions,
          destinationPolicy: {
            baseUrl: "https://api.example.com",
            allowedHosts: [],
          },
        }),
      ).toThrowError(/allowedHosts must be a non-empty array/);

      expect(() =>
        registry.createRevision({
          ...baseOptions,
          destinationPolicy: {
            baseUrl: "https://api.example.com",
            allowedHosts: ["api.other.com"],
          },
        }),
      ).toThrowError(/is not in allowedHosts/);
    });

    it("validates tool schemas, tenant ownership, and intra-revision names", () => {
      const registry = new ContractRegistry();

      expect(() =>
        registry.createRevision({
          tenantId: "tenant-1",
          contractName: "contract-1",
          sourceHash: "hash123",
          tools: [],
          destinationPolicy: {
            baseUrl: "https://api.example.com",
            allowedHosts: ["api.example.com"],
          },
        }),
      ).toThrowError(/must have at least one tool/);

      expect(() =>
        registry.createRevision({
          tenantId: "tenant-1",
          contractName: "contract-1",
          sourceHash: "hash123",
          tools: [dummyTool("invalid tool name with spaces", "tenant-1")],
          destinationPolicy: {
            baseUrl: "https://api.example.com",
            allowedHosts: ["api.example.com"],
          },
        }),
      ).toThrowError(/Tool name '.*' is invalid/);

      expect(() =>
        registry.createRevision({
          tenantId: "tenant-1",
          contractName: "contract-1",
          sourceHash: "hash123",
          tools: [
            dummyTool("sameName", "tenant-1"),
            dummyTool("sameName", "tenant-1"),
          ],
          destinationPolicy: {
            baseUrl: "https://api.example.com",
            allowedHosts: ["api.example.com"],
          },
        }),
      ).toThrowError(/Duplicate tool name 'sameName'/);

      expect(() =>
        registry.createRevision({
          tenantId: "tenant-1",
          contractName: "contract-1",
          sourceHash: "hash123",
          tools: [dummyTool("tool1", "tenant-different")],
          destinationPolicy: {
            baseUrl: "https://api.example.com",
            allowedHosts: ["api.example.com"],
          },
        }),
      ).toThrowError(/does not match contract tenant/);

      const throwingSchema = {
        get type(): never {
          throw new Error("corrupt schema property");
        },
      };

      const invalidSchemaTool: ToolDefinition = {
        name: "badSchemaTool",
        description: "bad schema tool description",
        operation: {},
        inputSchema: throwingSchema as unknown as { type: "object" },
        ownerTenantId: "tenant-1",
        execute: async () => ({}),
      };

      expect(() =>
        registry.createRevision({
          tenantId: "tenant-1",
          contractName: "contract-1",
          sourceHash: "hash123",
          tools: [invalidSchemaTool],
          destinationPolicy: {
            baseUrl: "https://api.example.com",
            allowedHosts: ["api.example.com"],
          },
        }),
      ).toThrowError(/unsupported input schema/);
    });

    it("handles activation, disabling, and rollback errors", () => {
      const registry = new ContractRegistry();
      const tool = dummyTool("tool1", "tenant-1");

      const rev1 = registry.createRevision({
        tenantId: "tenant-1",
        contractName: "contract-1",
        sourceHash: "hash1",
        tools: [tool],
        destinationPolicy: {
          baseUrl: "https://api.example.com",
          allowedHosts: ["api.example.com"],
        },
      });

      // Activate rev1
      const act1 = registry.activateRevision(
        "tenant-1",
        "contract-1",
        rev1.revisionId,
      );
      expect(act1.activatedRevision.status).toBe("active");

      // Activating already active revision returns it immediately
      const actAgain = registry.activateRevision(
        "tenant-1",
        "contract-1",
        rev1.revisionId,
      );
      expect(actAgain.activatedRevision.revisionId).toBe(rev1.revisionId);

      // Disable with wrong revisionId throws REVISION_CONFLICT
      expect(() =>
        registry.disableRevision(
          "tenant-1",
          "contract-1",
          "rev_wrongid12345678",
        ),
      ).toThrowError(GatewayError);

      // Disable successfully
      const disabled = registry.disableRevision(
        "tenant-1",
        "contract-1",
        rev1.revisionId,
      );
      expect(disabled.status).toBe("disabled");

      // Disabling again throws CONTRACT_NOT_FOUND
      expect(() =>
        registry.disableRevision("tenant-1", "contract-1"),
      ).toThrowError(GatewayError);

      // Rollback to unknown revision throws REVISION_NOT_FOUND
      expect(() =>
        registry.rollbackRevision(
          "tenant-1",
          "contract-1",
          "rev_unknown12345678",
        ),
      ).toThrowError(GatewayError);

      // Rollback to rev1 reactivates it
      const rolledBack = registry.rollbackRevision(
        "tenant-1",
        "contract-1",
        rev1.revisionId,
      );
      expect(rolledBack.reactivatedRevision.status).toBe("active");

      // Rollback when already active throws INVALID_REVISION_STATE
      expect(() =>
        registry.rollbackRevision("tenant-1", "contract-1", rev1.revisionId),
      ).toThrowError(GatewayError);
    });

    it("lists revisions across tenants and contracts", () => {
      const registry = new ContractRegistry();
      const tool1 = dummyTool("tool1", "tenant-1");
      const tool2 = dummyTool("tool2", "tenant-2");

      const r1 = registry.createRevision({
        tenantId: "tenant-1",
        contractName: "contract-a",
        sourceHash: "hash1",
        tools: [tool1],
        destinationPolicy: {
          baseUrl: "https://api.example.com",
          allowedHosts: ["api.example.com"],
        },
      });

      const r2 = registry.createRevision({
        tenantId: "tenant-2",
        contractName: "contract-b",
        sourceHash: "hash2",
        tools: [tool2],
        destinationPolicy: {
          baseUrl: "https://api.example.com",
          allowedHosts: ["api.example.com"],
        },
      });

      registry.activateRevision("tenant-1", "contract-a", r1.revisionId);
      registry.activateRevision("tenant-2", "contract-b", r2.revisionId);

      // listRevisions with tenantId but without contractName
      const tenant1Revs = registry.listRevisions("tenant-1");
      expect(tenant1Revs).toHaveLength(1);
      expect(tenant1Revs[0]?.contractName).toBe("contract-a");

      // listActiveRevisions without tenantId returns all active revisions
      const allActive = registry.listActiveRevisions();
      expect(allActive).toHaveLength(2);
      expect(allActive.map((r) => r.tenantId).sort()).toEqual([
        "tenant-1",
        "tenant-2",
      ]);
    });
  });
});

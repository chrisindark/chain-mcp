import { describe, expect, it, vi } from "vitest";
import type { ToolContext, ToolDefinition } from "@chainmcp/core";
import type { UpstreamTransport } from "@chainmcp/executor";
import { DynamicGateway } from "../src/gateway.js";
import type { GatewayAuditEvent } from "../src/types.js";

const SIMPLE_OPENAPI = `
openapi: "3.0.3"
info:
  title: "Petstore API"
  version: "1.0.0"
paths:
  /pets:
    get:
      operationId: "listPets"
      summary: "List all pets"
      responses:
        "200":
          description: "A list of pets"
          content:
            application/json:
              schema:
                type: array
                items:
                  type: object
                  properties:
                    id:
                      type: string
`;

function createMockTransport(
  responseBody: Record<string, unknown> | unknown[] = [{ id: "pet-1" }],
): UpstreamTransport {
  return {
    request: async () => ({
      status: 200,
      headers: { "content-type": "application/json" },
      body: new TextEncoder().encode(JSON.stringify(responseBody)),
    }),
  };
}

describe("DynamicGateway", () => {
  it("publishes and activates a contract from OpenAPI YAML", async () => {
    const transport = createMockTransport([{ id: "pet-100" }]);
    const gateway = new DynamicGateway({
      transport,
      resolveHost: async () => ["93.184.216.34"],
    });

    const revision = await gateway.publishContract({
      tenantId: "tenant-a",
      contractName: "petstore",
      source: SIMPLE_OPENAPI,
      destinationPolicy: {
        baseUrl: "https://api.petstore.com",
        allowedHosts: ["api.petstore.com"],
      },
    });

    expect(revision.status).toBe("active");
    expect(revision.tenantId).toBe("tenant-a");
    expect(revision.tools).toHaveLength(1);
    expect(revision.tools[0]?.name).toBe("listPets");

    // List tools for tenant-a
    const context: ToolContext = {
      tenantId: "tenant-a",
      requestId: "req-1",
      principal: { id: "user-1", scopes: [] },
    };
    const tools = gateway.listTools(context);
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe("listPets");

    // Call tool
    const result = await gateway.callTool("listPets", {}, context);
    expect(result).toEqual([{ id: "pet-100" }]);
  });

  it("publishes code tools and supports manual activation", async () => {
    const gateway = new DynamicGateway();
    const toolDef: ToolDefinition = {
      name: "echoTool",
      description: "Echoes input",
      inputSchema: {
        type: "object",
        properties: { message: { type: "string" } },
      },
      ownerTenantId: "tenant-b",
      operation: {},
      execute: async (input) => ({
        reply: (input as { message?: string })?.message ?? "none",
      }),
    };

    // Publish with autoActivate: false
    const candidate = await gateway.publishContract({
      tenantId: "tenant-b",
      contractName: "echo-contract",
      tools: [toolDef],
      destinationPolicy: {
        baseUrl: "https://api.example.com",
        allowedHosts: ["api.example.com"],
      },
      autoActivate: false,
    });

    expect(candidate.status).toBe("candidate");
    const context: ToolContext = {
      tenantId: "tenant-b",
      requestId: "req-1",
      principal: { id: "user-b", scopes: [] },
    };

    // Candidate should not yet be discoverable
    expect(gateway.listTools(context)).toHaveLength(0);

    // Explicitly activate
    const activated = await gateway.activateRevision(
      "tenant-b",
      "echo-contract",
      candidate.revisionId,
    );
    expect(activated.status).toBe("active");

    // Now discoverable and callable
    expect(gateway.listTools(context)).toHaveLength(1);
    const result = await gateway.callTool(
      "echoTool",
      { message: "hello" },
      context,
    );
    expect(result).toEqual({ reply: "hello" });
  });

  it("guarantees in-flight request continuity during atomic contract reload", async () => {
    const gateway = new DynamicGateway();
    let resolveV1Execution: () => void;
    const v1ExecutingPromise = new Promise<void>((res) => {
      resolveV1Execution = res;
    });

    const v1Tool: ToolDefinition = {
      name: "processData",
      description: "V1 tool",
      inputSchema: { type: "object" },
      ownerTenantId: "tenant-1",
      operation: {},
      execute: async () => {
        await v1ExecutingPromise;
        return { version: 1 };
      },
    };

    const v2Tool: ToolDefinition = {
      name: "processData",
      description: "V2 tool",
      inputSchema: { type: "object" },
      ownerTenantId: "tenant-1",
      operation: {},
      execute: async () => ({ version: 2 }),
    };

    const context: ToolContext = {
      tenantId: "tenant-1",
      requestId: "req-1",
      principal: { id: "user-1", scopes: [] },
    };

    // 1. Publish V1
    await gateway.publishContract({
      tenantId: "tenant-1",
      contractName: "workflow",
      tools: [v1Tool],
      destinationPolicy: {
        baseUrl: "https://api.example.com",
        allowedHosts: ["api.example.com"],
      },
    });

    // 2. Start V1 tool call (in flight)
    const inFlightCall = gateway.callTool("processData", {}, context);

    // 3. While V1 is in flight, publish and activate V2 atomically
    await gateway.publishContract({
      tenantId: "tenant-1",
      contractName: "workflow",
      tools: [v2Tool],
      destinationPolicy: {
        baseUrl: "https://api.example.com",
        allowedHosts: ["api.example.com"],
      },
    });

    // 4. Start a new V2 tool call
    const v2Call = gateway.callTool("processData", {}, context);

    // 5. Complete V1 execution
    resolveV1Execution!();

    const [v1Result, v2Result] = await Promise.all([inFlightCall, v2Call]);
    expect(v1Result).toEqual({ version: 1 });
    expect(v2Result).toEqual({ version: 2 });
  });

  it("supports contract disabling and rollback", async () => {
    const gateway = new DynamicGateway();
    const toolV1: ToolDefinition = {
      name: "calculate",
      description: "V1 calculate",
      inputSchema: { type: "object" },
      ownerTenantId: "tenant-1",
      operation: {},
      execute: async () => ({ v: 1 }),
    };

    const toolV2: ToolDefinition = {
      name: "calculate",
      description: "V2 calculate",
      inputSchema: { type: "object" },
      ownerTenantId: "tenant-1",
      operation: {},
      execute: async () => ({ v: 2 }),
    };

    const context: ToolContext = {
      tenantId: "tenant-1",
      requestId: "req-1",
      principal: { id: "user-1", scopes: [] },
    };

    // Publish V1
    const rev1 = await gateway.publishContract({
      tenantId: "tenant-1",
      contractName: "calc",
      tools: [toolV1],
      destinationPolicy: {
        baseUrl: "https://api.example.com",
        allowedHosts: ["api.example.com"],
      },
    });

    // Publish V2
    await gateway.publishContract({
      tenantId: "tenant-1",
      contractName: "calc",
      tools: [toolV2],
      destinationPolicy: {
        baseUrl: "https://api.example.com",
        allowedHosts: ["api.example.com"],
      },
    });

    expect(await gateway.callTool("calculate", {}, context)).toEqual({ v: 2 });

    // Rollback to V1
    await gateway.rollbackContract("tenant-1", "calc", rev1.revisionId);
    expect(await gateway.callTool("calculate", {}, context)).toEqual({ v: 1 });

    // Disable contract
    await gateway.disableContract("tenant-1", "calc");
    expect(gateway.listTools(context)).toHaveLength(0);

    await expect(
      gateway.callTool("calculate", {}, context),
    ).rejects.toThrowError(/was not found/);
  });

  it("emits structured audit events and survives audit sink failure", async () => {
    const auditEvents: GatewayAuditEvent[] = [];
    const auditSink = vi.fn(async (event: GatewayAuditEvent) => {
      auditEvents.push(event);
      if (event.type === "contract_disabled") {
        throw new Error("Audit sink temporary network error");
      }
    });

    const gateway = new DynamicGateway({ auditSink });
    const tool: ToolDefinition = {
      name: "myTool",
      description: "A tool",
      inputSchema: { type: "object" },
      ownerTenantId: "t1",
      operation: {},
      execute: async () => ({ ok: true }),
    };

    await gateway.publishContract({
      tenantId: "t1",
      contractName: "c1",
      tools: [tool],
      destinationPolicy: {
        baseUrl: "https://api.example.com",
        allowedHosts: ["api.example.com"],
      },
    });

    expect(auditEvents.map((e) => e.type)).toEqual([
      "contract_published",
      "contract_activated",
    ]);

    // Disabling throws in auditSink, but operation should still succeed
    await expect(gateway.disableContract("t1", "c1")).resolves.toBeDefined();
    expect(auditEvents.some((e) => e.type === "contract_disabled")).toBe(true);
  });

  it("rejects candidate on compilation error without affecting currently active revisions", async () => {
    const gateway = new DynamicGateway();
    const validTool: ToolDefinition = {
      name: "validTool",
      description: "Valid tool",
      inputSchema: { type: "object" },
      ownerTenantId: "t1",
      operation: {},
      execute: async () => ({ active: true }),
    };

    // 1. Establish working revision
    await gateway.publishContract({
      tenantId: "t1",
      contractName: "c1",
      tools: [validTool],
      destinationPolicy: {
        baseUrl: "https://api.example.com",
        allowedHosts: ["api.example.com"],
      },
    });

    const context: ToolContext = {
      tenantId: "t1",
      requestId: "req-1",
      principal: { id: "u1", scopes: [] },
    };

    // 2. Attempt to publish corrupted OpenAPI document
    await expect(
      gateway.publishContract({
        tenantId: "t1",
        contractName: "c1",
        source: "invalid openapi: { unclosed: [",
        destinationPolicy: {
          baseUrl: "https://api.example.com",
          allowedHosts: ["api.example.com"],
        },
      }),
    ).rejects.toThrowError(/Failed to compile OpenAPI contract/);

    // 3. Existing revision remains active and callable
    expect(gateway.listTools(context)).toHaveLength(1);
    expect(await gateway.callTool("validTool", {}, context)).toEqual({
      active: true,
    });
  });
});

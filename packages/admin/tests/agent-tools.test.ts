import type { ToolContext } from "@chainmcp/core";
import { describe, expect, it } from "vitest";

import { createMetaMcpTools } from "../src/index.js";
import {
  FakeTransport,
  makeAdmin,
  makeBinding,
  makeDescriptor,
} from "./fixtures.js";

const standardParams = [
  { name: "userId", in: "path", required: true },
  { name: "limit", in: "query" },
];

const mutationPolicy = {
  requiredScopes: ["users:write"],
  timeoutMs: 5_000,
};

const dummyContext = {} as unknown as ToolContext;

interface ContractsResult {
  contracts: Array<{
    contractName: string;
    tenantId: string;
    baseUrl: string;
    status: string;
    toolCount: number;
    enabledToolCount: number;
  }>;
}

interface PublishResult {
  ok: boolean;
  revisionId: string;
  toolCount: number;
}

interface InspectContractResult {
  contractName: string;
  tenantId: string;
  destination: { baseUrl: string };
  toolCount: number;
  tools: Array<{ name: string; enabled: boolean }>;
}

interface InspectToolsResult {
  tools: Array<{
    name: string;
    enabled: boolean;
    policy: {
      cacheTtlSeconds?: number;
      maxOutputTokens?: number;
      outputFields?: { include?: string[]; exclude?: string[] };
    };
  }>;
}

interface CurateResult {
  ok: boolean;
  revisionId: string;
}

interface ConfigureProjectionResult {
  ok: boolean;
  policy: {
    outputFields?: { include?: string[]; exclude?: string[] };
    maxOutputTokens?: number;
  };
}

interface ConfigureCacheResult {
  ok: boolean;
  cacheTtlSeconds?: number;
}

interface TestToolResult {
  ok: boolean;
  toolName: string;
  projected: unknown;
  metrics: {
    rawTokens: number;
    projectedTokens: number;
    savedTokens: number;
    percentSavings: number;
  };
}

interface CompileSpecResult {
  ok: boolean;
  toolCount: number;
  tools: Array<{ name: string }>;
}

interface ListRevisionsResult {
  revisions: Array<{ revisionId: string }>;
}

interface RollbackResult {
  ok: boolean;
  revisionId: string;
  restoredRevisionId: string;
  toolCount: number;
}

describe("Agent-callable Meta-MCP Tools (createMetaMcpTools)", () => {
  it("exposes all 11 meta tools with object inputSchema and additionalProperties: false", () => {
    const { admin } = makeAdmin();
    const tools = createMetaMcpTools(admin);

    expect(tools).toHaveLength(11);
    const expectedNames = [
      "chainmcp_list_contracts",
      "chainmcp_inspect_contract",
      "chainmcp_inspect_tools",
      "chainmcp_curate_tool",
      "chainmcp_configure_projection",
      "chainmcp_configure_cache",
      "chainmcp_test_tool",
      "chainmcp_compile_spec",
      "chainmcp_publish_revision",
      "chainmcp_list_revisions",
      "chainmcp_rollback_revision",
    ];

    for (const expected of expectedNames) {
      const tool = tools.find((t) => t.name === expected);
      expect(tool).toBeDefined();
      expect(tool!.inputSchema.type).toBe("object");
      expect(tool!.inputSchema.additionalProperties).toBe(false);
      expect(tool!.description).toBeTruthy();
    }
  });

  it("chainmcp_list_contracts lists managed contracts with destination and tool status", async () => {
    const { admin } = makeAdmin();
    const tools = createMetaMcpTools(admin);
    const listTool = tools.find((t) => t.name === "chainmcp_list_contracts")!;

    // Initial state before publishing
    const initial = (await listTool.execute(
      {},
      dummyContext,
    )) as unknown as ContractsResult;
    expect(initial.contracts).toHaveLength(1);
    expect(initial.contracts[0]!.contractName).toBe("users");
    expect(initial.contracts[0]!.tenantId).toBe("tenant-a");
    expect(initial.contracts[0]!.baseUrl).toBe("https://api.example.com");

    // Publish a revision so it's active
    const publishTool = tools.find(
      (t) => t.name === "chainmcp_publish_revision",
    )!;
    const pubRes = (await publishTool.execute(
      {
        contractName: "users",
        descriptors: [
          makeDescriptor({ name: "get_user" }),
          makeDescriptor({
            name: "create_user",
            request: {
              method: "POST",
              path: "/users/{userId}",
              parameters: standardParams,
            },
            policy: mutationPolicy,
          }),
        ],
      },
      dummyContext,
    )) as unknown as PublishResult;
    expect(pubRes.ok).toBe(true);

    const after = (await listTool.execute(
      {},
      dummyContext,
    )) as unknown as ContractsResult;
    expect(after.contracts[0]!.status).toBe("active");
    expect(after.contracts[0]!.toolCount).toBe(2);
    expect(after.contracts[0]!.enabledToolCount).toBe(2);
  });

  it("chainmcp_inspect_contract returns destination, active revision, and tool summaries", async () => {
    const { admin } = makeAdmin();
    const tools = createMetaMcpTools(admin);

    const publishTool = tools.find(
      (t) => t.name === "chainmcp_publish_revision",
    )!;
    const pubRes = (await publishTool.execute(
      {
        contractName: "users",
        descriptors: [
          makeDescriptor({ name: "get_user" }),
          makeDescriptor({
            name: "update_user",
            request: {
              method: "PUT",
              path: "/users/{userId}",
              parameters: standardParams,
            },
            policy: mutationPolicy,
          }),
        ],
      },
      dummyContext,
    )) as unknown as PublishResult;
    expect(pubRes.ok).toBe(true);

    const inspectContractTool = tools.find(
      (t) => t.name === "chainmcp_inspect_contract",
    )!;
    const res = (await inspectContractTool.execute(
      { contractName: "users" },
      dummyContext,
    )) as unknown as InspectContractResult;

    expect(res.contractName).toBe("users");
    expect(res.tenantId).toBe("tenant-a");
    expect(res.destination.baseUrl).toBe("https://api.example.com");
    expect(res.toolCount).toBe(2);
    expect(res.tools.map((t) => t.name)).toEqual(["get_user", "update_user"]);
  });

  it("chainmcp_inspect_tools returns schemas, policies, and filters by toolName", async () => {
    const { admin } = makeAdmin();
    const tools = createMetaMcpTools(admin);

    const publishTool = tools.find(
      (t) => t.name === "chainmcp_publish_revision",
    )!;
    const pubRes = (await publishTool.execute(
      {
        contractName: "users",
        descriptors: [
          makeDescriptor({
            name: "get_user",
            policy: { cacheTtlSeconds: 60, maxOutputTokens: 500 },
          }),
          makeDescriptor({
            name: "delete_user",
            request: {
              method: "DELETE",
              path: "/users/{userId}",
              parameters: standardParams,
            },
            policy: mutationPolicy,
          }),
        ],
      },
      dummyContext,
    )) as unknown as PublishResult;
    expect(pubRes.ok).toBe(true);

    const inspectToolsTool = tools.find(
      (t) => t.name === "chainmcp_inspect_tools",
    )!;

    // All tools
    const all = (await inspectToolsTool.execute(
      { contractName: "users" },
      dummyContext,
    )) as unknown as InspectToolsResult;
    expect(all.tools).toHaveLength(2);

    // Filter by toolName
    const single = (await inspectToolsTool.execute(
      { contractName: "users", toolName: "get_user" },
      dummyContext,
    )) as unknown as InspectToolsResult;
    expect(single.tools).toHaveLength(1);
    expect(single.tools[0]!.name).toBe("get_user");
    expect(single.tools[0]!.policy.cacheTtlSeconds).toBe(60);
    expect(single.tools[0]!.policy.maxOutputTokens).toBe(500);

    // Negative: unknown tool
    await expect(
      inspectToolsTool.execute(
        { contractName: "users", toolName: "unknown_tool" },
        dummyContext,
      ),
    ).rejects.toThrow("Tool 'unknown_tool' was not found");
  });

  it("chainmcp_curate_tool enables/disables tools and prevents disabling all tools", async () => {
    const { admin, audit } = makeAdmin();
    const tools = createMetaMcpTools(admin);

    const publishTool = tools.find(
      (t) => t.name === "chainmcp_publish_revision",
    )!;
    await publishTool.execute(
      {
        contractName: "users",
        descriptors: [
          makeDescriptor({ name: "tool_1" }),
          makeDescriptor({ name: "tool_2" }),
        ],
      },
      dummyContext,
    );

    const curateTool = tools.find((t) => t.name === "chainmcp_curate_tool")!;

    // Disable tool_1
    const curateRes = (await curateTool.execute(
      { contractName: "users", toolName: "tool_1", enabled: false },
      dummyContext,
    )) as unknown as CurateResult;
    expect(curateRes.ok).toBe(true);

    const inspectToolsTool = tools.find(
      (t) => t.name === "chainmcp_inspect_tools",
    )!;
    const inspection = (await inspectToolsTool.execute(
      { contractName: "users" },
      dummyContext,
    )) as unknown as InspectContractResult;
    const tool1 = inspection.tools.find((t) => t.name === "tool_1");
    const tool2 = inspection.tools.find((t) => t.name === "tool_2");
    expect(tool1?.enabled).toBe(false);
    expect(tool2?.enabled).toBe(true);

    // Audit record emitted
    const curateAudit = audit.find((a) => a.type === "admin_curate");
    expect(curateAudit).toBeDefined();

    // Invariant: cannot disable all tools
    await expect(
      curateTool.execute(
        { contractName: "users", toolName: "tool_2", enabled: false },
        dummyContext,
      ),
    ).rejects.toThrow("Cannot disable all tools");
  });

  it("chainmcp_configure_projection validates and configures field selection and token budget", async () => {
    const { admin } = makeAdmin();
    const tools = createMetaMcpTools(admin);

    const publishTool = tools.find(
      (t) => t.name === "chainmcp_publish_revision",
    )!;
    const pubRes = (await publishTool.execute(
      {
        contractName: "users",
        descriptors: [makeDescriptor({ name: "get_user" })],
      },
      dummyContext,
    )) as unknown as PublishResult;
    expect(pubRes.ok).toBe(true);

    const configureProjectionTool = tools.find(
      (t) => t.name === "chainmcp_configure_projection",
    )!;

    // Negative: invalid projection (both include and exclude)
    await expect(
      configureProjectionTool.execute(
        {
          contractName: "users",
          toolName: "get_user",
          outputFields: { include: ["id"], exclude: ["secret"] },
        },
        dummyContext,
      ),
    ).rejects.toThrow(
      "Field selection must declare exactly one of include or exclude",
    );

    // Positive: configure include projection and maxOutputTokens
    const res = (await configureProjectionTool.execute(
      {
        contractName: "users",
        toolName: "get_user",
        outputFields: { include: ["userId", "limit"] },
        maxOutputTokens: 250,
      },
      dummyContext,
    )) as unknown as ConfigureProjectionResult;

    expect(res.ok).toBe(true);
    expect(res.policy.outputFields).toEqual({ include: ["userId", "limit"] });
    expect(res.policy.maxOutputTokens).toBe(250);

    // Verify stored policy in active revision
    const inspectToolsTool = tools.find(
      (t) => t.name === "chainmcp_inspect_tools",
    )!;
    const inspection = (await inspectToolsTool.execute(
      { contractName: "users", toolName: "get_user" },
      dummyContext,
    )) as unknown as InspectToolsResult;
    expect(inspection.tools[0]!.policy.outputFields).toEqual({
      include: ["userId", "limit"],
    });
    expect(inspection.tools[0]!.policy.maxOutputTokens).toBe(250);
  });

  it("SECURITY BOUNDARY: chainmcp_configure_cache strictly rejects mutations (POST/PUT/PATCH/DELETE)", async () => {
    const { admin } = makeAdmin();
    const tools = createMetaMcpTools(admin);

    const publishTool = tools.find(
      (t) => t.name === "chainmcp_publish_revision",
    )!;
    const pubRes = (await publishTool.execute(
      {
        contractName: "users",
        descriptors: [
          makeDescriptor({
            name: "get_user",
            request: {
              method: "GET",
              path: "/users/{userId}",
              parameters: standardParams,
            },
          }),
          makeDescriptor({
            name: "create_user",
            request: {
              method: "POST",
              path: "/users/{userId}",
              parameters: standardParams,
            },
            policy: mutationPolicy,
          }),
          makeDescriptor({
            name: "update_user",
            request: {
              method: "PUT",
              path: "/users/{userId}",
              parameters: standardParams,
            },
            policy: mutationPolicy,
          }),
          makeDescriptor({
            name: "patch_user",
            request: {
              method: "PATCH",
              path: "/users/{userId}",
              parameters: standardParams,
            },
            policy: mutationPolicy,
          }),
          makeDescriptor({
            name: "delete_user",
            request: {
              method: "DELETE",
              path: "/users/{userId}",
              parameters: standardParams,
            },
            policy: mutationPolicy,
          }),
        ],
      },
      dummyContext,
    )) as unknown as PublishResult;
    expect(pubRes.ok).toBe(true);

    const configureCacheTool = tools.find(
      (t) => t.name === "chainmcp_configure_cache",
    )!;

    // Security check: POST rejection
    await expect(
      configureCacheTool.execute(
        { contractName: "users", toolName: "create_user", ttlSeconds: 300 },
        dummyContext,
      ),
    ).rejects.toThrow("Cannot configure caching on mutation method 'POST'");

    // Security check: PUT rejection
    await expect(
      configureCacheTool.execute(
        { contractName: "users", toolName: "update_user", ttlSeconds: 300 },
        dummyContext,
      ),
    ).rejects.toThrow("Cannot configure caching on mutation method 'PUT'");

    // Security check: PATCH rejection
    await expect(
      configureCacheTool.execute(
        { contractName: "users", toolName: "patch_user", ttlSeconds: 300 },
        dummyContext,
      ),
    ).rejects.toThrow("Cannot configure caching on mutation method 'PATCH'");

    // Security check: DELETE rejection
    await expect(
      configureCacheTool.execute(
        { contractName: "users", toolName: "delete_user", ttlSeconds: 300 },
        dummyContext,
      ),
    ).rejects.toThrow("Cannot configure caching on mutation method 'DELETE'");

    // Positive: GET allows caching
    const getRes = (await configureCacheTool.execute(
      { contractName: "users", toolName: "get_user", ttlSeconds: 120 },
      dummyContext,
    )) as unknown as ConfigureCacheResult;
    expect(getRes.ok).toBe(true);
    expect(getRes.cacheTtlSeconds).toBe(120);

    // Positive: ttlSeconds: 0 removes caching
    const removeRes = (await configureCacheTool.execute(
      { contractName: "users", toolName: "get_user", ttlSeconds: 0 },
      dummyContext,
    )) as unknown as ConfigureCacheResult;
    expect(removeRes.ok).toBe(true);
    expect(removeRes.cacheTtlSeconds).toBeUndefined();
  });

  it("chainmcp_test_tool test-fires a tool with projection and returns token savings metrics", async () => {
    const transport = new FakeTransport();
    transport.responder = () => ({
      status: 200,
      headers: { "content-type": "application/json" },
      body: Buffer.from(
        JSON.stringify({
          userId: "user_123",
          name: "Alice Smith",
          email: "alice@example.com",
          bio: "A very long detailed bio that takes many tokens to serialize and send to an LLM context window.",
          metadata: {
            internalDebugFlags: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
            accountTier: "enterprise",
          },
        }),
      ),
    });

    const mockCredentialProvider = {
      resolveCredential: async () => ({
        type: "apiKey" as const,
        name: "X-API-Key",
        location: "header" as const,
        value: "test-secret-key",
      }),
    };

    const binding = makeBinding({
      transport,
      credentialProvider: mockCredentialProvider as unknown as Parameters<
        typeof makeBinding
      >[0] extends { credentialProvider?: infer CP }
        ? CP
        : never,
    });
    const { admin } = makeAdmin({ transport, contracts: [binding] });
    const tools = createMetaMcpTools(admin);

    const publishTool = tools.find(
      (t) => t.name === "chainmcp_publish_revision",
    )!;
    await publishTool.execute(
      {
        contractName: "users",
        descriptors: [makeDescriptor({ name: "get_user" })],
      },
      dummyContext,
    );

    const testTool = tools.find((t) => t.name === "chainmcp_test_tool")!;
    const res = (await testTool.execute(
      {
        contractName: "users",
        toolName: "get_user",
        arguments: { userId: "user_123" },
        projection: { include: ["userId", "name"] },
      },
      dummyContext,
    )) as unknown as TestToolResult;

    expect(res.ok).toBe(true);
    expect(res.toolName).toBe("get_user");
    expect(res.projected).toEqual({ userId: "user_123", name: "Alice Smith" });
    expect(res.metrics.rawTokens).toBeGreaterThan(res.metrics.projectedTokens);
    expect(res.metrics.savedTokens).toBeGreaterThan(0);
    expect(res.metrics.percentSavings).toBeGreaterThan(0);
  });

  it("chainmcp_compile_spec compiles OpenAPI specs and returns tools without publishing", async () => {
    const { admin } = makeAdmin();
    const tools = createMetaMcpTools(admin);
    const compileTool = tools.find((t) => t.name === "chainmcp_compile_spec")!;

    const yamlSpec = `
openapi: "3.0.3"
info:
  title: Pet API
  version: "1.0.0"
paths:
  /pets:
    get:
      operationId: listPets
      summary: List all pets
      responses:
        '200':
          description: OK
`;

    const res = (await compileTool.execute(
      { spec: yamlSpec },
      dummyContext,
    )) as unknown as CompileSpecResult;
    expect(res.ok).toBe(true);
    expect(res.toolCount).toBe(1);
    expect(res.tools[0]!.name).toBe("listPets");
  });

  it("chainmcp_list_revisions and chainmcp_rollback_revision support full lifecycle rollback", async () => {
    const { admin } = makeAdmin();
    const tools = createMetaMcpTools(admin);

    const publishTool = tools.find(
      (t) => t.name === "chainmcp_publish_revision",
    )!;
    const listRevisionsTool = tools.find(
      (t) => t.name === "chainmcp_list_revisions",
    )!;
    const rollbackTool = tools.find(
      (t) => t.name === "chainmcp_rollback_revision",
    )!;

    // Revision 1
    const rev1 = (await publishTool.execute(
      {
        contractName: "users",
        descriptors: [makeDescriptor({ name: "v1_tool" })],
      },
      dummyContext,
    )) as unknown as PublishResult;
    expect(rev1.ok).toBe(true);

    // Revision 2
    const rev2 = (await publishTool.execute(
      {
        contractName: "users",
        descriptors: [
          makeDescriptor({ name: "v1_tool" }),
          makeDescriptor({ name: "v2_tool" }),
        ],
      },
      dummyContext,
    )) as unknown as PublishResult;
    expect(rev2.ok).toBe(true);

    // List revisions
    const listRes = (await listRevisionsTool.execute(
      { contractName: "users" },
      dummyContext,
    )) as unknown as ListRevisionsResult;
    expect(listRes.revisions.length).toBeGreaterThanOrEqual(2);

    // Rollback to Revision 1
    const rollbackRes = (await rollbackTool.execute(
      { contractName: "users", targetRevisionId: rev1.revisionId },
      dummyContext,
    )) as unknown as RollbackResult;
    expect(rollbackRes.ok).toBe(true);
    expect(rollbackRes.restoredRevisionId).toBe(rev1.revisionId);
    expect(rollbackRes.toolCount).toBe(1);

    // Invariant: cannot rollback to active revision
    await expect(
      rollbackTool.execute(
        { contractName: "users", targetRevisionId: rollbackRes.revisionId },
        dummyContext,
      ),
    ).rejects.toThrow("is already active");
  });

  it("enforces tenant boundary isolation when caller is restricted", async () => {
    const bindingA = makeBinding({
      tenantId: "tenant-a",
      contractName: "orders",
    });
    const bindingB = makeBinding({
      tenantId: "tenant-b",
      contractName: "payments",
    });
    const { admin } = makeAdmin({ contracts: [bindingA, bindingB] });

    // Scoped tools restricted to tenant-a only
    const scopedTools = createMetaMcpTools(admin, { tenants: ["tenant-a"] });
    const listTool = scopedTools.find(
      (t) => t.name === "chainmcp_list_contracts",
    )!;
    const inspectTool = scopedTools.find(
      (t) => t.name === "chainmcp_inspect_contract",
    )!;

    // List only returns tenant-a contracts
    const listRes = (await listTool.execute(
      {},
      dummyContext,
    )) as unknown as ContractsResult;
    expect(listRes.contracts).toHaveLength(1);
    expect(listRes.contracts[0]!.contractName).toBe("orders");

    // Accessing tenant-b contract is rejected with security violation
    await expect(
      inspectTool.execute(
        { contractName: "payments", tenantId: "tenant-b" },
        dummyContext,
      ),
    ).rejects.toThrow(
      "Contract 'payments' for tenant 'tenant-b' was not found or is not accessible",
    );
  });
});

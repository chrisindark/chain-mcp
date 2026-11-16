import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createMetaMcpTools, DeclarativeAdmin } from "@chainmcp/admin";
import { createFieldProjector, InMemoryToolRuntime } from "@chainmcp/core";
import { DynamicGateway } from "@chainmcp/gateway";
import { connectMcpServer, type Transport } from "@chainmcp/server";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

import { runCli } from "../src/cli.js";
import { agentServerCommand } from "../src/commands/agent-server.js";

const DUMMY_SPEC = `
openapi: "3.1.0"
info:
  title: Pet Service
  version: "1.0.0"
paths:
  /pets:
    get:
      operationId: listPets
      responses:
        '200':
          description: OK
`;

const SAMPLE_GATEWAY_CONFIG = `
version: 1
name: test-agent-gateway
storage:
  enabled: true
  driver: memory
contracts:
  - name: pet-service
    tenantId: tenant-alpha
    spec: ./pet-service.yaml
    destination:
      baseUrl: https://api.petstore.test/v1
      allowedHosts:
        - api.petstore.test
`;

describe("agent-server command and Meta-MCP server (M14-2)", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "chainmcp-agent-server-"));
    await writeFile(join(tempDir, "pet-service.yaml"), DUMMY_SPEC, "utf8");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("exposes --help documentation including agent-server command and options", async () => {
    const logs: string[] = [];
    const exitCode = await runCli(["--help"], {
      stdout: (msg) => logs.push(msg),
    });

    expect(exitCode).toBe(0);
    const output = logs.join("\n");
    expect(output).toContain("agent-server");
    expect(output).toContain("Run agent-callable Meta-MCP server");
    expect(output).toContain("--transport <type>");
    expect(output).toContain("--port <number>");
  });

  it("fails fast with non-zero exit code if configuration file does not exist", async () => {
    const errLogs: string[] = [];
    const exitCode = await runCli(
      ["agent-server", "--config", join(tempDir, "nonexistent.yaml")],
      {
        stderr: (msg) => errLogs.push(msg),
      },
    );

    expect(exitCode).toBe(1);
    expect(errLogs.join("\n")).toContain("Configuration file not found");
  });

  it("starts and shuts down cleanly over stdio transport with mock streams", async () => {
    const configPath = join(tempDir, "gateway.config.yaml");
    await writeFile(configPath, SAMPLE_GATEWAY_CONFIG, "utf8");

    const stdin = new PassThrough();
    const stdout = new PassThrough();

    const serverHandle = await agentServerCommand({
      cwd: tempDir,
      config: configPath,
      transport: "stdio",
      stdin,
      stdout,
    });

    expect(serverHandle.ok).toBe(true);
    expect(serverHandle.serverName).toBe("chainmcp-agent-server");
    expect(serverHandle.toolCount).toBe(12);

    await serverHandle.close();
    await serverHandle.closed;
  });

  it("starts and shuts down cleanly over HTTP transport with ephemeral port", async () => {
    const configPath = join(tempDir, "gateway.config.yaml");
    await writeFile(configPath, SAMPLE_GATEWAY_CONFIG, "utf8");

    const serverHandle = await agentServerCommand({
      cwd: tempDir,
      config: configPath,
      transport: "http",
      host: "127.0.0.1",
      port: 0,
    });

    expect(serverHandle.ok).toBe(true);
    expect(serverHandle.url).toBeDefined();
    expect(serverHandle.url?.protocol).toBe("http:");
    expect(serverHandle.toolCount).toBe(12);

    await serverHandle.close();
    await serverHandle.closed;
  });

  it("allows MCP client to connect via InMemoryTransport, list tools, and inspect contracts", async () => {
    const gateway = new DynamicGateway({
      projector: createFieldProjector(),
    });

    const admin = new DeclarativeAdmin({
      gateway,
      tokens: [
        { id: "test-operator", token: "0123456789abcdef", tenants: "*" },
      ],
      contracts: [
        {
          tenantId: "tenant-1",
          contractName: "pet-api",
          destinationPolicy: {
            baseUrl: "https://api.petstore.test/v1",
            allowedHosts: ["api.petstore.test"],
          },
        },
      ],
    });

    const metaTools = createMetaMcpTools(admin, {
      tokenId: "agent-test-client",
      tenants: "*",
    });

    const runtime = new InMemoryToolRuntime({
      tenantMode: "single-tenant",
      tenantId: "tenant-1",
    });
    for (const tool of metaTools) {
      runtime.register(tool);
    }

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const connectedServer = await connectMcpServer(
      runtime,
      serverTransport as unknown as Transport,
      {
        name: "chainmcp-agent-server-test",
        version: "1.0.0",
        createContext: () => ({
          requestId: "req-1",
          tenantId: "tenant-1",
          principal: { id: "test-client", scopes: [] },
        }),
      },
    );

    const client = new Client(
      { name: "meta-agent-client", version: "1.0.0" },
      { capabilities: {} },
    );

    try {
      await client.connect(clientTransport);

      // 1. tools/list verification
      const listResponse = await client.listTools();
      expect(listResponse.tools).toHaveLength(12);

      const toolNames = listResponse.tools.map((t) => t.name);
      expect(toolNames).toContain("chainmcp_list_contracts");
      expect(toolNames).toContain("chainmcp_inspect_contract");
      expect(toolNames).toContain("chainmcp_inspect_tools");
      expect(toolNames).toContain("chainmcp_curate_tool");
      expect(toolNames).toContain("chainmcp_configure_projection");
      expect(toolNames).toContain("chainmcp_configure_cache");
      expect(toolNames).toContain("chainmcp_test_tool");
      expect(toolNames).toContain("chainmcp_compile_spec");
      expect(toolNames).toContain("chainmcp_publish_revision");
      expect(toolNames).toContain("chainmcp_list_revisions");
      expect(toolNames).toContain("chainmcp_rollback_revision");
      expect(toolNames).toContain("chainmcp_get_diagnostics");

      // Verify every tool schema has type: object and additionalProperties: false
      for (const t of listResponse.tools) {
        expect(t.inputSchema.type).toBe("object");
        expect(
          (t.inputSchema as { additionalProperties?: unknown })
            .additionalProperties,
        ).toBe(false);
      }

      // 2. Call chainmcp_list_contracts
      const listContractsCall = await client.callTool({
        name: "chainmcp_list_contracts",
        arguments: {},
      });
      expect(listContractsCall.isError).toBeFalsy();
      const contractsResult = JSON.parse(
        (listContractsCall.content[0] as { text: string }).text,
      );
      expect(contractsResult.contracts).toHaveLength(1);
      expect(contractsResult.contracts[0].contractName).toBe("pet-api");

      // 3. Call chainmcp_compile_spec
      const compileCall = await client.callTool({
        name: "chainmcp_compile_spec",
        arguments: {
          spec: `
openapi: "3.0.3"
info:
  title: Micro Service
  version: "1.0.0"
paths:
  /status:
    get:
      operationId: getStatus
      responses:
        '200':
          description: OK
`,
        },
      });
      expect(compileCall.isError).toBeFalsy();
      const compileResult = JSON.parse(
        (compileCall.content[0] as { text: string }).text,
      );
      expect(compileResult.ok).toBe(true);
      expect(compileResult.toolCount).toBe(1);
      expect(compileResult.tools[0].name).toBe("getStatus");

      // 4. Call chainmcp_publish_revision
      const publishCall = await client.callTool({
        name: "chainmcp_publish_revision",
        arguments: {
          contractName: "pet-api",
          descriptors: [
            {
              descriptorVersion: 1,
              name: "get_pet",
              description: "Get a pet",
              request: {
                method: "GET",
                path: "/pets/{petId}",
                parameters: [{ name: "petId", in: "path", required: true }],
              },
              inputSchema: {
                type: "object",
                additionalProperties: false,
                required: ["petId"],
                properties: {
                  petId: { type: "string" },
                },
              },
              policy: {
                cacheTtlSeconds: 60,
              },
            },
            {
              descriptorVersion: 1,
              name: "delete_pet",
              description: "Delete a pet",
              request: {
                method: "DELETE",
                path: "/pets/{petId}",
                parameters: [{ name: "petId", in: "path", required: true }],
              },
              inputSchema: {
                type: "object",
                additionalProperties: false,
                required: ["petId"],
                properties: {
                  petId: { type: "string" },
                },
              },
            },
          ],
        },
      });
      expect(publishCall.isError).toBeFalsy();
      const publishResult = JSON.parse(
        (publishCall.content[0] as { text: string }).text,
      );
      expect(publishResult.ok).toBe(true);
      expect(publishResult.toolCount).toBe(2);

      // 5. Call chainmcp_inspect_tools
      const inspectCall = await client.callTool({
        name: "chainmcp_inspect_tools",
        arguments: {
          contractName: "pet-api",
          toolName: "get_pet",
        },
      });
      expect(inspectCall.isError).toBeFalsy();
      const inspectResult = JSON.parse(
        (inspectCall.content[0] as { text: string }).text,
      );
      expect(inspectResult.tools).toHaveLength(1);
      expect(inspectResult.tools[0].name).toBe("get_pet");
      expect(inspectResult.tools[0].policy.cacheTtlSeconds).toBe(60);

      // 6. Call chainmcp_curate_tool to disable delete_pet
      const curateCall = await client.callTool({
        name: "chainmcp_curate_tool",
        arguments: {
          contractName: "pet-api",
          toolName: "delete_pet",
          enabled: false,
        },
      });
      expect(curateCall.isError).toBeFalsy();

      // Verify curation in inspect_tools
      const inspectAllCall = await client.callTool({
        name: "chainmcp_inspect_tools",
        arguments: { contractName: "pet-api" },
      });
      const inspectAllResult = JSON.parse(
        (inspectAllCall.content[0] as { text: string }).text,
      );
      const delTool = inspectAllResult.tools.find(
        (t: { name: string; enabled: boolean }) => t.name === "delete_pet",
      );
      expect(delTool.enabled).toBe(false);

      // 7. Security negative test: cache configuration on DELETE tool rejected
      const badCacheCall = await client.callTool({
        name: "chainmcp_configure_cache",
        arguments: {
          contractName: "pet-api",
          toolName: "delete_pet",
          ttlSeconds: 120,
        },
      });
      expect(badCacheCall.isError).toBe(true);

      // 8. Negative test: cannot disable all tools
      const disableAllCall = await client.callTool({
        name: "chainmcp_curate_tool",
        arguments: {
          contractName: "pet-api",
          toolName: "get_pet",
          enabled: false,
        },
      });
      expect(disableAllCall.isError).toBe(true);

      // 9. Call chainmcp_get_diagnostics via MCP client
      const diagCall = await client.callTool({
        name: "chainmcp_get_diagnostics",
        arguments: {
          contractName: "pet-api",
        },
      });
      expect(diagCall.isError).toBeFalsy();
      const diagResult = JSON.parse(
        (diagCall.content[0] as { text: string }).text,
      );
      expect(diagResult.summary).toBeDefined();
      expect(Array.isArray(diagResult.hints)).toBe(true);
    } finally {
      await client.close();
      await connectedServer.close();
    }
  });
});

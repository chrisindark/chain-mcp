import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { StorageDescriptorRevisionStore } from "@chainmcp/admin";
import type { DeclarativeToolDescriptor } from "@chainmcp/declarative";
import type { UpstreamTransport } from "@chainmcp/executor";
import type { ConnectedMcpServer, Transport } from "@chainmcp/server";
import { SqliteStorageDriver } from "@chainmcp/storage";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

import { runCli } from "../src/cli.js";
import { ejectCommand } from "../src/commands/eject.js";
import { exportCommand } from "../src/commands/export.js";
import { installGeneratedProject } from "./support/generated-install.js";

const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const SAMPLE_OPENAPI_SPEC = `
openapi: "3.1.0"
info:
  title: Staged Petstore API
  version: "1.0.0"
servers:
  - url: https://api.petstore.test
paths:
  /pets:
    get:
      operationId: listPets
      summary: List all pets
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema:
                type: array
                items:
                  type: object
                  properties:
                    id:
                      type: string
                    name:
                      type: string
                    tag:
                      type: string
  /pets/{petId}:
    get:
      operationId: getPet
      summary: Get a single pet
      parameters:
        - name: petId
          in: path
          required: true
          schema:
            type: string
      responses:
        "200":
          description: OK
    delete:
      operationId: deletePet
      summary: Delete a pet
      parameters:
        - name: petId
          in: path
          required: true
          schema:
            type: string
      responses:
        "204":
          description: No Content
`;

describe("M14-1: Stage in Gateway, Eject to Standalone", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "chainmcp-eject-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("ejects a contract from gateway.config.yaml with pruned tools and verified manifest", async () => {
    const specPath = join(tempDir, "petstore.yaml");
    await writeFile(specPath, SAMPLE_OPENAPI_SPEC, "utf8");

    const gatewayConfigPath = join(tempDir, "gateway.config.yaml");
    const gatewayConfigContent = `
version: 1
name: test-gateway
contracts:
  - name: petstore
    tenantId: default
    spec: ./petstore.yaml
    destination:
      baseUrl: https://api.petstore.test
      allowedHosts:
        - api.petstore.test
    tools:
      exclude:
        - deletePet
`;
    await writeFile(gatewayConfigPath, gatewayConfigContent, "utf8");

    const ejectDir = join(tempDir, "petstore-standalone");
    const result = await ejectCommand({
      config: gatewayConfigPath,
      contract: "petstore",
      output: ejectDir,
      check: true,
      localDeps: REPO_ROOT,
      cwd: tempDir,
    });

    expect(result.ok).toBe(true);
    expect(result.contractName).toBe("petstore");
    expect(result.verifiedReproducible).toBe(true);

    // Verify written files
    expect(result.filesWritten).toContain("descriptors.json");
    expect(result.filesWritten).toContain("chainmcp.manifest.json");
    expect(result.filesWritten).toContain("chainmcp.config.yaml");
    expect(result.filesWritten).toContain("dist/compiled-tools.json");
    expect(result.filesWritten).toContain("package.json");
    expect(result.filesWritten).toContain("src/server.ts");
    expect(result.filesWritten).toContain("src/tools.ts");
    expect(result.filesWritten).toContain("Dockerfile");
    expect(result.filesWritten).toContain("README.md");

    // Check descriptors.json: deletePet must be pruned, listPets and getPet retained
    const descriptorsRaw = await readFile(
      join(ejectDir, "descriptors.json"),
      "utf8",
    );
    const descriptors = JSON.parse(
      descriptorsRaw,
    ) as DeclarativeToolDescriptor[];
    expect(descriptors).toHaveLength(2);
    const names = descriptors.map((d) => d.name);
    expect(names).toContain("listPets");
    expect(names).toContain("getPet");
    expect(names).not.toContain("deletePet");

    // Check manifest
    const manifest = JSON.parse(
      await readFile(join(ejectDir, "chainmcp.manifest.json"), "utf8"),
    );
    expect(manifest.toolCount).toBe(2);
    expect(manifest.tools.map((t: { name: string }) => t.name)).toEqual([
      "getPet",
      "listPets",
    ]);
    expect(manifest.artifacts?.compiledTools?.toolCount).toBe(2);

    // Check package.json: MUST NOT depend on @chainmcp/gateway or @chainmcp/admin
    const pkg = JSON.parse(
      await readFile(join(ejectDir, "package.json"), "utf8"),
    );
    expect(pkg.dependencies["@chainmcp/gateway"]).toBeUndefined();
    expect(pkg.dependencies["@chainmcp/admin"]).toBeUndefined();
    expect(pkg.dependencies["@chainmcp/core"]).toBeDefined();
    expect(pkg.dependencies["@chainmcp/server"]).toBeDefined();

    // Check standalone chainmcp.config.yaml
    const serverConfigYaml = await readFile(
      join(ejectDir, "chainmcp.config.yaml"),
      "utf8",
    );
    expect(serverConfigYaml).toContain("name: petstore-server");
    expect(serverConfigYaml).toContain("baseUrl: https://api.petstore.test");
    expect(serverConfigYaml).toContain("api.petstore.test");
  });

  it("ejects active curated revision from SQLite storage revision store with field projections", async () => {
    const dbPath = join(tempDir, "storage.db");
    const driver = new SqliteStorageDriver({ path: dbPath });
    await driver.init();
    const store = await StorageDescriptorRevisionStore.open(driver);

    const activeDescriptors: DeclarativeToolDescriptor[] = [
      {
        descriptorVersion: 1,
        name: "getUserProfile",
        description: "Retrieve user profile with projection",
        enabled: true,
        inputSchema: {
          type: "object",
          properties: { userId: { type: "string" } },
          required: ["userId"],
          additionalProperties: false,
        },
        request: {
          method: "GET",
          path: "/users/{userId}",
          parameters: [{ name: "userId", in: "path", required: true }],
        },
        policy: {
          outputFields: { include: ["id", "username"] },
        },
      },
      {
        descriptorVersion: 1,
        name: "deprecatedUserTool",
        description: "Tool disabled during curation",
        enabled: false,
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        request: { method: "GET", path: "/deprecated" },
      },
      {
        descriptorVersion: 1,
        name: "listActiveUsers",
        description: "List active users",
        enabled: true,
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        request: { method: "GET", path: "/users" },
      },
    ];

    const revisionId = "dset_0123456789abcdef";
    await store.createRevision({
      revisionId,
      tenantId: "tenant-prod",
      contractName: "user-service",
      createdAt: Date.now(),
      status: "candidate",
      toolsetHash: "a".repeat(64),
      descriptors: activeDescriptors,
      toolRevisions: activeDescriptors.map((d) => ({
        name: d.name,
        revision: `sha256:${"b".repeat(64)}`,
      })),
    });
    await store.activateRevision(
      "tenant-prod",
      "user-service",
      revisionId,
      "gw_rev_100",
    );
    await driver.close();

    const gatewayConfigPath = join(tempDir, "gateway.config.yaml");
    await writeFile(
      gatewayConfigPath,
      `
version: 1
name: prod-gateway
storage:
  enabled: true
  driver: sqlite
  path: ${dbPath}
contracts:
  - name: user-service
    tenantId: tenant-prod
    spec: ./non-existent.yaml
    destination:
      baseUrl: https://users.internal.net
      allowedHosts:
        - users.internal.net
`,
      "utf8",
    );

    const ejectDir = join(tempDir, "user-service-standalone");
    const result = await ejectCommand({
      config: gatewayConfigPath,
      contract: "user-service",
      tenant: "tenant-prod",
      output: ejectDir,
      check: true,
      cwd: tempDir,
    });

    expect(result.ok).toBe(true);
    expect(result.contractName).toBe("user-service");

    const descriptors = JSON.parse(
      await readFile(join(ejectDir, "descriptors.json"), "utf8"),
    ) as DeclarativeToolDescriptor[];

    // Disabled tool deprecatedUserTool MUST be pruned
    expect(descriptors).toHaveLength(2);
    expect(descriptors.map((d) => d.name)).toEqual([
      "getUserProfile",
      "listActiveUsers",
    ]);

    // Projection policy on getUserProfile MUST be preserved
    const getUser = descriptors.find((d) => d.name === "getUserProfile");
    expect(getUser?.policy?.outputFields).toEqual({
      include: ["id", "username"],
    });
  });

  it("builds the ejected server with tsc and executes tools/list and tools/call offline", async () => {
    const specPath = join(tempDir, "pets.yaml");
    await writeFile(specPath, SAMPLE_OPENAPI_SPEC, "utf8");

    const gatewayConfigPath = join(tempDir, "gateway.config.yaml");
    await writeFile(
      gatewayConfigPath,
      `
version: 1
name: test-gw
contracts:
  - name: pets
    tenantId: default
    spec: ./pets.yaml
    destination:
      baseUrl: https://api.petstore.test
      allowedHosts:
        - api.petstore.test
    tools:
      exclude:
        - deletePet
`,
      "utf8",
    );

    const projectDir = join(tempDir, "pets-standalone-exec");
    const ejectResult = await ejectCommand({
      config: gatewayConfigPath,
      contract: "pets",
      output: projectDir,
      localDeps: REPO_ROOT,
      cwd: tempDir,
    });
    expect(ejectResult.ok).toBe(true);

    // Install packages offline from clone
    await installGeneratedProject(projectDir);

    // Compile with tsc
    const tscBin = join(REPO_ROOT, "node_modules/.bin/tsc");
    await execFileAsync(
      tscBin,
      ["-p", join(projectDir, "tsconfig.build.json")],
      { cwd: projectDir, timeout: 120_000 },
    );

    const serverJsPath = join(projectDir, "dist/server.js");
    const serverStat = await stat(serverJsPath);
    expect(serverStat.isFile()).toBe(true);

    // Import and start server
    const serverModule = (await import(serverJsPath)) as {
      runServer: (options: {
        transport: UpstreamTransport;
        resolveHost: (hostname: string) => Promise<string[]>;
        serverTransport: Transport;
      }) => Promise<ConnectedMcpServer>;
    };

    const mockUpstream: UpstreamTransport = {
      async request() {
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: new TextEncoder().encode(
            JSON.stringify([
              { id: "p1", name: "Rex", tag: "dog", secretCode: "123" },
            ]),
          ),
        };
      },
    };

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const serverHandle = await serverModule.runServer({
      transport: mockUpstream,
      resolveHost: async () => ["93.184.216.34"],
      serverTransport,
    });

    const client = new Client(
      { name: "eject-test-client", version: "1.0.0" },
      { capabilities: {} },
    );
    try {
      await client.connect(clientTransport);

      // Verify tools/list contains curated tools
      const listResponse = await client.listTools();
      const toolNames = listResponse.tools.map((t) => t.name);
      expect(toolNames).toContain("listPets");
      expect(toolNames).toContain("getPet");
      expect(toolNames).not.toContain("deletePet");

      // Verify tools/call works
      const callResponse = await client.callTool({
        name: "listPets",
        arguments: {},
      });
      expect(callResponse.isError).toBeFalsy();
      const content = callResponse.content as Array<{ text: string }>;
      expect(content[0]?.text).toContain("Rex");
    } finally {
      await client.close();
      await serverHandle.close();
    }
  }, 180_000);

  it("fails if target directory exists and is not empty without --force, succeeds with --force", async () => {
    const specPath = join(tempDir, "petstore.yaml");
    await writeFile(specPath, SAMPLE_OPENAPI_SPEC, "utf8");

    const gatewayConfigPath = join(tempDir, "gateway.config.yaml");
    await writeFile(
      gatewayConfigPath,
      `
version: 1
name: test-gateway
contracts:
  - name: petstore
    tenantId: default
    spec: ./petstore.yaml
    destination:
      baseUrl: https://api.petstore.test
      allowedHosts:
        - api.petstore.test
`,
      "utf8",
    );

    const ejectDir = join(tempDir, "conflict-server");
    const first = await ejectCommand({
      config: gatewayConfigPath,
      output: ejectDir,
      cwd: tempDir,
    });
    expect(first.ok).toBe(true);

    const failResult = await ejectCommand({
      config: gatewayConfigPath,
      output: ejectDir,
      cwd: tempDir,
    });
    expect(failResult.ok).toBe(false);
    expect(failResult.error).toContain("is not empty");

    const forceResult = await ejectCommand({
      config: gatewayConfigPath,
      output: ejectDir,
      force: true,
      cwd: tempDir,
    });
    expect(forceResult.ok).toBe(true);
  });

  it("fails when contract name is not found or when multiple contracts exist without --contract", async () => {
    const specPath = join(tempDir, "petstore.yaml");
    await writeFile(specPath, SAMPLE_OPENAPI_SPEC, "utf8");

    const gatewayConfigPath = join(tempDir, "gateway.config.yaml");
    await writeFile(
      gatewayConfigPath,
      `
version: 1
name: multi-gateway
contracts:
  - name: alpha
    tenantId: default
    spec: ./petstore.yaml
    destination:
      baseUrl: https://api.alpha.test
      allowedHosts:
        - api.alpha.test
  - name: beta
    tenantId: default
    spec: ./petstore.yaml
    destination:
      baseUrl: https://api.beta.test
      allowedHosts:
        - api.beta.test
`,
      "utf8",
    );

    // Missing --contract when multiple exist
    const multiResult = await ejectCommand({
      config: gatewayConfigPath,
      cwd: tempDir,
    });
    expect(multiResult.ok).toBe(false);
    expect(multiResult.error).toContain("Multiple contracts found");
    expect(multiResult.error).toContain("alpha, beta");

    // Unknown contract name
    const unknownResult = await ejectCommand({
      config: gatewayConfigPath,
      contract: "gamma",
      cwd: tempDir,
    });
    expect(unknownResult.ok).toBe(false);
    expect(unknownResult.error).toContain("Contract 'gamma' was not found");
  });

  it("enforces SSRF protection: rejects plain HTTP without allowInsecureHttp and invalid URLs", async () => {
    const specPath = join(tempDir, "petstore.yaml");
    await writeFile(specPath, SAMPLE_OPENAPI_SPEC, "utf8");

    const gatewayConfigPath = join(tempDir, "gateway.config.yaml");
    await writeFile(
      gatewayConfigPath,
      `
version: 1
name: insecure-gw
contracts:
  - name: remote-http
    tenantId: default
    spec: ./petstore.yaml
    destination:
      baseUrl: http://remote-insecure-api.test
      allowedHosts:
        - remote-insecure-api.test
`,
      "utf8",
    );

    const result = await ejectCommand({
      config: gatewayConfigPath,
      contract: "remote-http",
      cwd: tempDir,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Plain HTTP destination");
  });

  it("fails when all tools are excluded by curation pruning", async () => {
    const specPath = join(tempDir, "petstore.yaml");
    await writeFile(specPath, SAMPLE_OPENAPI_SPEC, "utf8");

    const gatewayConfigPath = join(tempDir, "gateway.config.yaml");
    await writeFile(
      gatewayConfigPath,
      `
version: 1
name: empty-gw
contracts:
  - name: petstore
    tenantId: default
    spec: ./petstore.yaml
    destination:
      baseUrl: https://api.petstore.test
      allowedHosts:
        - api.petstore.test
    tools:
      exclude:
        - listPets
        - getPet
        - deletePet
`,
      "utf8",
    );

    const result = await ejectCommand({
      config: gatewayConfigPath,
      contract: "petstore",
      cwd: tempDir,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("no active tools after curation pruning");
  });

  it("exportCommand with fromGateway=true delegates to eject workflow", async () => {
    const specPath = join(tempDir, "petstore.yaml");
    await writeFile(specPath, SAMPLE_OPENAPI_SPEC, "utf8");

    const gatewayConfigPath = join(tempDir, "gateway.config.yaml");
    await writeFile(
      gatewayConfigPath,
      `
version: 1
name: test-gateway
contracts:
  - name: petstore
    tenantId: default
    spec: ./petstore.yaml
    destination:
      baseUrl: https://api.petstore.test
      allowedHosts:
        - api.petstore.test
`,
      "utf8",
    );

    const exportDir = join(tempDir, "export-gateway-ejected");
    const result = await exportCommand({
      config: gatewayConfigPath,
      fromGateway: true,
      contract: "petstore",
      output: exportDir,
      cwd: tempDir,
    });

    expect(result.ok).toBe(true);
    expect(result.filesWritten).toContain("descriptors.json");
    expect(result.filesWritten).toContain("chainmcp.manifest.json");
  });

  it("runs chainmcp eject via CLI", async () => {
    const specPath = join(tempDir, "petstore.yaml");
    await writeFile(specPath, SAMPLE_OPENAPI_SPEC, "utf8");

    const gatewayConfigPath = join(tempDir, "gateway.config.yaml");
    await writeFile(
      gatewayConfigPath,
      `
version: 1
name: test-gateway
contracts:
  - name: petstore
    tenantId: default
    spec: ./petstore.yaml
    destination:
      baseUrl: https://api.petstore.test
      allowedHosts:
        - api.petstore.test
`,
      "utf8",
    );

    const ejectDir = join(tempDir, "cli-ejected");
    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];

    const exitCode = await runCli(
      [
        "eject",
        "--config",
        gatewayConfigPath,
        "--contract",
        "petstore",
        "--output",
        ejectDir,
      ],
      {
        stdout: (msg) => stdoutLines.push(msg),
        stderr: (msg) => stderrLines.push(msg),
      },
    );

    expect(exitCode).toBe(0);
    expect(stderrLines).toHaveLength(0);
    expect(stdoutLines.some((l) => l.includes("Eject succeeded:"))).toBe(true);
    expect(
      stdoutLines.some((l) => l.includes("Ejected contract 'petstore'")),
    ).toBe(true);
  });
});

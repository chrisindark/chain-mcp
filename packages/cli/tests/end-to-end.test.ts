import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

import { exportCommand } from "../src/commands/export.js";
import { sha256 } from "../src/manifest.js";

const execFileAsync = promisify(execFile);

const PETSTORE_SPEC = `
openapi: "3.1.0"
info:
  title: Generated Petstore
  version: "1.0.0"
servers:
  - url: https://api.petstore.test
paths:
  /pets:
    get:
      operationId: getPets
      summary: Retrieve all pets
      responses:
        "200":
          description: A list of pets
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
`;

describe("End-to-End Generated Server", () => {
  let tempDir: string;
  let specFile: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "chainmcp-e2e-"));
    specFile = join(tempDir, "openapi.yaml");
    await writeFile(specFile, PETSTORE_SPEC, "utf8");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("exports a server project and verifies exact deterministic byte reproduction", async () => {
    const exportDir1 = join(tempDir, "server-1");
    const exportDir2 = join(tempDir, "server-2");

    const result1 = await exportCommand({
      spec: specFile,
      output: exportDir1,
      check: true,
      cwd: tempDir,
    });
    expect(result1.ok).toBe(true);

    const result2 = await exportCommand({
      spec: specFile,
      output: exportDir2,
      check: true,
      cwd: tempDir,
    });
    expect(result2.ok).toBe(true);

    // Verify all files match byte-for-byte
    for (const relativePath of result1.filesWritten) {
      const file1 = await readFile(join(exportDir1, relativePath), "utf8");
      const file2 = await readFile(join(exportDir2, relativePath), "utf8");
      expect(sha256(file1)).toBe(sha256(file2));
    }
  });

  it("builds the exported server with TypeScript and serves it to an MCP client", async () => {
    const exportDir = join(tempDir, "test-build-server");
    const rootDir = join(dirname(fileURLToPath(import.meta.url)), "../../..");

    const result = await exportCommand({
      spec: specFile,
      output: exportDir,
      workspaceDependencies: true,
      cwd: tempDir,
    });
    expect(result.ok).toBe(true);

    // Set up node_modules in the isolated export directory
    const exportNodeModules = join(exportDir, "node_modules");
    await mkdir(exportNodeModules, { recursive: true });
    await symlink(
      join(rootDir, "packages/cli/node_modules/@chainmcp"),
      join(exportNodeModules, "@chainmcp"),
      "dir",
    );
    await symlink(
      join(rootDir, "packages/cli/node_modules/@modelcontextprotocol"),
      join(exportNodeModules, "@modelcontextprotocol"),
      "dir",
    );
    await symlink(
      join(rootDir, "packages/cli/node_modules/yaml"),
      join(exportNodeModules, "yaml"),
      "dir",
    );
    await symlink(
      join(rootDir, "node_modules/@types"),
      join(exportNodeModules, "@types"),
      "dir",
    );

    // Run TypeScript compiler in the exported project
    const tscBin = join(rootDir, "node_modules/.bin/tsc");
    const { stderr } = await execFileAsync(
      tscBin,
      ["-p", join(exportDir, "tsconfig.build.json")],
      { cwd: exportDir },
    );
    expect(stderr).toBe("");

    // Verify built artifacts exist
    const serverJsContent = await readFile(
      join(exportDir, "dist/server.js"),
      "utf8",
    );
    expect(serverJsContent).toContain("runServer");

    // Dynamically import compiled server module
    const serverModule = await import(join(exportDir, "dist/server.js"));
    expect(serverModule.runServer).toBeDefined();

    // Connect an MCP client over linked in-memory transport
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client(
      { name: "chainmcp-e2e-test-client", version: "0.1.0" },
      { capabilities: {} },
    );

    // Custom transport for mock responses
    const mockTransport = {
      async request() {
        return {
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8" },
          body: new TextEncoder().encode(
            JSON.stringify([{ id: "1", name: "Fluffy" }]),
          ),
        };
      },
    };

    const serverHandle = await serverModule.runServer({
      configPath: join(exportDir, "chainmcp.config.yaml"),
      contractPath: join(exportDir, "spec/openapi.yaml"),
      transport: mockTransport,
      resolveHost: async () => ["93.184.216.34"],
      serverTransport,
    });

    expect(serverHandle).toBeDefined();

    await client.connect(clientTransport);

    // Discover tools
    const toolsResult = await client.listTools();
    const toolNames = toolsResult.tools.map((t) => t.name);
    expect(toolNames).toContain("getPets");
    // Also JSON navigation tools should be registered
    expect(toolNames).toContain("json_inspect_shape");
    expect(toolNames).toContain("json_select_path");

    // Call API tool
    const callResult = await client.callTool({
      name: "getPets",
      arguments: {},
    });
    expect(callResult.isError).toBeFalsy();
    const resultText = (callResult.content[0] as { type: "text"; text: string })
      .text;
    expect(JSON.parse(resultText)).toEqual([{ id: "1", name: "Fluffy" }]);

    // Call JSON navigation tool
    const jsonNavResult = await client.callTool({
      name: "json_select_path",
      arguments: {
        json: [
          { id: "1", name: "Fluffy" },
          { id: "2", name: "Spot" },
        ],
        path: "$[1].name",
      },
    });
    expect(jsonNavResult.isError).toBeFalsy();
    const navText = (jsonNavResult.content[0] as { type: "text"; text: string })
      .text;
    expect(JSON.parse(navText)).toBe("Spot");

    // Close client and server cleanly
    await client.close();
    await serverHandle.close();
    await serverHandle.closed;
  });
});

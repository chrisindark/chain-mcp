import { execFile } from "node:child_process";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

import type { UpstreamTransport } from "@chainmcp/executor";
import type { ConnectedMcpServer, Transport } from "@chainmcp/server";

import { exportCommand } from "../src/commands/export.js";
import { buildCommand } from "../src/commands/build.js";
import { initCommand } from "../src/commands/init.js";
import {
  CHAINMCP_PACKAGE_DEPENDENCIES,
  renderPackageJson,
} from "../src/templates.js";

const execFileAsync = promisify(execFile);

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const SPEC = `
openapi: "3.1.0"
info:
  title: Local Install Petstore
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

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

interface GeneratedPackageJson {
  version: string;
  dependencies: Record<string, string>;
}

describe("P0-2: generator version is never hardcoded", () => {
  it("emits the supplied version in package.json dependency and version fields", () => {
    const pkg = JSON.parse(
      renderPackageJson({ name: "version-probe", version: "9.9.9" }),
    ) as GeneratedPackageJson;

    expect(pkg.version).toBe("9.9.9");
    for (const name of CHAINMCP_PACKAGE_DEPENDENCIES) {
      expect(pkg.dependencies[name]).toBe("^9.9.9");
    }
    expect(JSON.stringify(pkg)).not.toContain("0.1.0");
  });

  it("keeps workspace mode explicit", () => {
    const pkg = JSON.parse(
      renderPackageJson({
        name: "workspace-probe",
        version: "9.9.9",
        workspaceDependencies: true,
      }),
    ) as GeneratedPackageJson;

    expect(pkg.version).toBe("9.9.9");
    for (const name of CHAINMCP_PACKAGE_DEPENDENCIES) {
      expect(pkg.dependencies[name]).toBe("workspace:*");
    }
  });

  it("contains no ChainMcp release literal in templates.ts", async () => {
    const source = await readFile(
      new URL("../src/templates.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/\b0\.1\.0\b/);
    expect(source).not.toMatch(/version:\s*["']\d+\.\d+\.\d+["']/);
  });

  it("stamps init output with the supplied version", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "chainmcp-version-init-"));
    try {
      const specPath = join(tempDir, "openapi.yaml");
      await writeFile(specPath, SPEC, "utf8");
      const projectDir = join(tempDir, "project");

      const result = await initCommand({
        spec: specPath,
        output: projectDir,
        version: "9.9.9",
        cwd: tempDir,
      });
      expect(result.ok).toBe(true);

      const pkg = JSON.parse(
        await readFile(join(projectDir, "package.json"), "utf8"),
      ) as GeneratedPackageJson;
      expect(pkg.version).toBe("9.9.9");
      expect(pkg.dependencies["@chainmcp/server"]).toBe("^9.9.9");

      const serverSource = await readFile(
        join(projectDir, "src", "server.ts"),
        "utf8",
      );
      expect(serverSource).toContain('version: "9.9.9"');
      expect(serverSource).not.toContain('version: "0.1.0"');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("stamps export output and the manifest with the supplied version", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "chainmcp-version-export-"));
    try {
      const specPath = join(tempDir, "openapi.yaml");
      await writeFile(specPath, SPEC, "utf8");
      const projectDir = join(tempDir, "project");

      const result = await exportCommand({
        spec: specPath,
        output: projectDir,
        version: "9.9.9",
        cwd: tempDir,
      });
      expect(result.ok).toBe(true);
      expect(result.manifest.generatorVersion).toBe("9.9.9");

      const pkg = JSON.parse(
        await readFile(join(projectDir, "package.json"), "utf8"),
      ) as GeneratedPackageJson;
      expect(pkg.version).toBe("9.9.9");

      const manifest = JSON.parse(
        await readFile(join(projectDir, "chainmcp.manifest.json"), "utf8"),
      ) as { generatorVersion: string };
      expect(manifest.generatorVersion).toBe("9.9.9");

      const serverSource = await readFile(
        join(projectDir, "src", "server.ts"),
        "utf8",
      );
      expect(serverSource).toContain('version: "9.9.9"');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("P0-1: local-clone dependency mode", () => {
  it("emits file: dependencies that resolve to the cloned packages", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "chainmcp-local-deps-"));
    try {
      const specPath = join(tempDir, "openapi.yaml");
      await writeFile(specPath, SPEC, "utf8");
      const projectDir = join(tempDir, "project");

      const result = await initCommand({
        spec: specPath,
        output: projectDir,
        localDeps: REPO_ROOT,
        cwd: tempDir,
      });
      expect(result.ok).toBe(true);

      const pkg = JSON.parse(
        await readFile(join(projectDir, "package.json"), "utf8"),
      ) as GeneratedPackageJson;

      for (const name of CHAINMCP_PACKAGE_DEPENDENCIES) {
        const spec = pkg.dependencies[name];
        expect(spec).toBeDefined();
        if (spec === undefined) {
          throw new Error(`Missing local dependency spec for ${name}`);
        }
        expect(spec).toMatch(/^file:/);
        const dependencyDir = resolve(projectDir, spec.slice("file:".length));
        const manifest = JSON.parse(
          await readFile(join(dependencyDir, "package.json"), "utf8"),
        ) as { name: string };
        expect(manifest.name).toBe(name);
      }
      expect(JSON.stringify(pkg)).not.toContain("^0.1.0");

      const workspace = parseYaml(
        await readFile(join(projectDir, "pnpm-workspace.yaml"), "utf8"),
      ) as { packages: string[]; overrides: Record<string, string> };
      expect(workspace.packages).toEqual(["."]);
      expect(Object.keys(workspace.overrides).sort()).toEqual(
        [...CHAINMCP_PACKAGE_DEPENDENCIES].sort(),
      );

      const readme = await readFile(join(projectDir, "README.md"), "utf8");
      expect(readme).toContain("pnpm install");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects a directory that is not a ChainMcp checkout", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "chainmcp-local-invalid-"));
    try {
      const specPath = join(tempDir, "openapi.yaml");
      await writeFile(specPath, SPEC, "utf8");

      const result = await initCommand({
        spec: specPath,
        output: join(tempDir, "project"),
        localDeps: join(tempDir, "not-a-repo"),
        cwd: tempDir,
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("Local dependency resolution failed");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects combining local and workspace dependency modes", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "chainmcp-local-conflict-"));
    try {
      const specPath = join(tempDir, "openapi.yaml");
      await writeFile(specPath, SPEC, "utf8");

      const result = await initCommand({
        spec: specPath,
        output: join(tempDir, "project"),
        localDeps: REPO_ROOT,
        workspaceDependencies: true,
        cwd: tempDir,
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("not both");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("installs, builds, and serves a generated project without the registry", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "chainmcp-local-run-"));
    try {
      const specPath = join(tempDir, "openapi.yaml");
      await writeFile(specPath, SPEC, "utf8");
      const projectDir = join(tempDir, "project");

      const result = await initCommand({
        spec: specPath,
        output: projectDir,
        localDeps: REPO_ROOT,
        cwd: tempDir,
      });
      expect(result.ok).toBe(true);

      // Generated servers verify build artifacts at startup. Produce the
      // manifest and compiled tool definitions before compiling TypeScript.
      const buildResult = await buildCommand({ cwd: projectDir });
      expect(buildResult.ok).toBe(true);

      // Install from local packages only. Third-party packages come from the
      // existing pnpm store; no registry request is made.
      try {
        await execFileAsync(
          "pnpm",
          ["install", "--offline", "--ignore-scripts"],
          { cwd: projectDir, timeout: 120_000 },
        );
      } catch (error) {
        const stderr =
          typeof error === "object" && error !== null && "stderr" in error
            ? String(error.stderr)
            : "";
        const stdout =
          typeof error === "object" && error !== null && "stdout" in error
            ? String(error.stdout)
            : "";
        throw new Error(
          `pnpm install failed.\nstdout: ${stdout}\nstderr: ${stderr}`,
        );
      }
      expect(await pathExists(join(projectDir, "node_modules"))).toBe(true);

      const tscBin = join(REPO_ROOT, "node_modules/.bin/tsc");
      await execFileAsync(
        tscBin,
        ["-p", join(projectDir, "tsconfig.build.json")],
        { cwd: projectDir, timeout: 120_000 },
      );
      expect(await pathExists(join(projectDir, "dist/server.js"))).toBe(true);

      const serverModule = (await import(
        join(projectDir, "dist/server.js")
      )) as {
        runServer: (options: {
          transport: UpstreamTransport;
          resolveHost: (hostname: string) => Promise<string[]>;
          serverTransport: Transport;
        }) => Promise<ConnectedMcpServer>;
      };

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

      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      const serverHandle = await serverModule.runServer({
        transport: mockTransport,
        resolveHost: async () => ["93.184.216.34"],
        serverTransport,
      });

      const client = new Client(
        { name: "chainmcp-local-install-client", version: "0.1.0" },
        { capabilities: {} },
      );
      try {
        await client.connect(clientTransport);
        const tools = await client.listTools();
        expect(tools.tools.map((tool) => tool.name)).toContain("getPets");

        const callResult = await client.callTool({
          name: "getPets",
          arguments: {},
        });
        expect(callResult.isError).toBeFalsy();
        const text = (callResult.content[0] as { type: "text"; text: string })
          .text;
        expect(JSON.parse(text)).toEqual([{ id: "1", name: "Fluffy" }]);
      } finally {
        await client.close();
        await serverHandle.close();
        await serverHandle.closed;
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 180_000);
});

describe("generated project layout", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "chainmcp-layout-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("does not add pnpm-workspace.yaml in registry mode", async () => {
    const specPath = join(tempDir, "openapi.yaml");
    await writeFile(specPath, SPEC, "utf8");
    const projectDir = join(tempDir, "project");

    const result = await exportCommand({
      spec: specPath,
      output: projectDir,
      cwd: tempDir,
    });
    expect(result.ok).toBe(true);
    expect(await readdir(projectDir)).not.toContain("pnpm-workspace.yaml");
  });
});

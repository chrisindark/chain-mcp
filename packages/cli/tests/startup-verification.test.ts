import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

import type { UpstreamTransport } from "@chainmcp/executor";
import type { Transport } from "@chainmcp/server";

import { exportCommand } from "../src/commands/export.js";

const execFileAsync = promisify(execFile);

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

const SPEC = `
openapi: "3.1.0"
info:
  title: Startup Verification API
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

interface RunServerOptions {
  configPath?: string;
  contractPath?: string;
  transport?: UpstreamTransport;
  resolveHost?: (hostname: string) => Promise<string[]>;
  serverTransport?: Transport;
}

interface ServerHandle {
  close(): Promise<void>;
  closed: Promise<void>;
}

interface GeneratedServerModule {
  runServer(options?: RunServerOptions): Promise<ServerHandle>;
}

interface ManifestShape {
  manifestVersion: number;
  generatorVersion: string;
  compilerVersion: string;
  contractRevision?: string;
  sourceHash: string;
  toolCount: number;
  tools: { name: string; hash: string }[];
  artifacts?: {
    compiledTools?: {
      sha256: string;
      toolCount: number;
      contractRevision?: string;
      tools: { name: string; hash: string }[];
    };
  };
}

const mockTransport: UpstreamTransport = {
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

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe("P0-3: generated servers verify build artifacts at startup", () => {
  let tempDir: string;
  let projectDir: string;
  let manifestPath: string;
  let compiledToolsPath: string;
  let specPath: string;
  let serverModule: GeneratedServerModule;
  let pristine: {
    manifest: string;
    compiledTools: string;
    spec: string;
  };

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "chainmcp-startup-verify-"));
    const specFile = join(tempDir, "openapi.yaml");
    await writeFile(specFile, SPEC, "utf8");
    projectDir = join(tempDir, "project");
    manifestPath = join(projectDir, "chainmcp.manifest.json");
    compiledToolsPath = join(projectDir, "dist", "compiled-tools.json");
    specPath = join(projectDir, "spec", "openapi.yaml");

    const result = await exportCommand({
      spec: specFile,
      output: projectDir,
      workspaceDependencies: true,
      cwd: tempDir,
    });
    expect(result.ok).toBe(true);

    const exportNodeModules = join(projectDir, "node_modules");
    await mkdir(exportNodeModules, { recursive: true });
    await symlink(
      join(REPO_ROOT, "packages/cli/node_modules/@chainmcp"),
      join(exportNodeModules, "@chainmcp"),
      "dir",
    );
    await symlink(
      join(REPO_ROOT, "packages/cli/node_modules/@modelcontextprotocol"),
      join(exportNodeModules, "@modelcontextprotocol"),
      "dir",
    );
    await symlink(
      join(REPO_ROOT, "packages/cli/node_modules/yaml"),
      join(exportNodeModules, "yaml"),
      "dir",
    );
    await symlink(
      join(REPO_ROOT, "node_modules/@types"),
      join(exportNodeModules, "@types"),
      "dir",
    );

    try {
      await execFileAsync(
        join(REPO_ROOT, "node_modules/.bin/tsc"),
        ["-p", join(projectDir, "tsconfig.build.json")],
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
      throw new Error(`tsc failed.\nstdout: ${stdout}\nstderr: ${stderr}`);
    }

    serverModule = (await import(
      join(projectDir, "dist", "server.js")
    )) as GeneratedServerModule;

    pristine = {
      manifest: await readFile(manifestPath, "utf8"),
      compiledTools: await readFile(compiledToolsPath, "utf8"),
      spec: await readFile(specPath, "utf8"),
    };
  }, 180_000);

  afterAll(async () => {
    if (tempDir !== undefined) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  beforeEach(async () => {
    await restoreArtifacts();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (ORIGINAL_NODE_ENV === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    }
    for (let index = process.argv.length - 1; index >= 0; index -= 1) {
      if (process.argv[index] === "--allow-manifest-drift") {
        process.argv.splice(index, 1);
      }
    }
  });

  async function restoreArtifacts(): Promise<void> {
    await writeFile(manifestPath, pristine.manifest, "utf8");
    await writeFile(compiledToolsPath, pristine.compiledTools, "utf8");
    await writeFile(specPath, pristine.spec, "utf8");
  }

  async function readManifest(): Promise<ManifestShape> {
    return JSON.parse(await readFile(manifestPath, "utf8")) as ManifestShape;
  }

  async function writeManifest(manifest: ManifestShape): Promise<void> {
    await writeFile(
      manifestPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );
  }

  async function startServer(): Promise<{
    handle: ServerHandle;
    clientTransport: Transport;
  }> {
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const handle = await serverModule.runServer({
      configPath: join(projectDir, "chainmcp.config.yaml"),
      contractPath: specPath,
      transport: mockTransport,
      resolveHost: async () => ["93.184.216.34"],
      serverTransport,
    });
    return { handle, clientTransport };
  }

  async function expectStartupFailure(pattern: RegExp): Promise<void> {
    await expect(startServer()).rejects.toThrow(pattern);
  }

  it("starts and serves tools when the manifest and artifact match", async () => {
    const { handle, clientTransport } = await startServer();
    const client = new Client(
      { name: "chainmcp-startup-verify-client", version: "0.1.0" },
      { capabilities: {} },
    );
    try {
      await client.connect(clientTransport);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain("getPets");
    } finally {
      await client.close();
      await handle.close();
      await handle.closed;
    }
  });

  it("ships the compiled tools artifact in export output and the Docker image", async () => {
    expect(
      await pathExists(join(projectDir, "dist", "compiled-tools.json")),
    ).toBe(true);
    expect(await pathExists(join(projectDir, "compiled-tools.json"))).toBe(
      true,
    );
    const dockerfile = await readFile(join(projectDir, "Dockerfile"), "utf8");
    expect(dockerfile).toContain(
      "COPY compiled-tools.json ./dist/compiled-tools.json",
    );
  });

  it("fails when the pinned contract changed after build", async () => {
    await writeFile(
      specPath,
      `${pristine.spec}\n# edited after build\n`,
      "utf8",
    );

    await expectStartupFailure(/changed after build|source hash/i);
  });

  it("fails when compiled-tools.json was modified after build", async () => {
    const artifact = JSON.parse(pristine.compiledTools) as {
      name: string;
      description: string;
    }[];
    const first = artifact[0];
    if (first === undefined) {
      throw new Error("expected at least one compiled tool");
    }
    first.description = `${first.description} (tampered)`;
    await writeFile(
      compiledToolsPath,
      `${JSON.stringify(artifact, null, 2)}\n`,
      "utf8",
    );

    await expectStartupFailure(/digest does not match/i);
  });

  it("fails when a per-tool hash in the manifest does not match", async () => {
    const manifest = await readManifest();
    const hashes = manifest.artifacts?.compiledTools?.tools;
    const tool = hashes?.[0];
    if (tool === undefined) {
      throw new Error("expected at least one manifest tool hash");
    }
    tool.hash = `sha256:${"0".repeat(64)}`;
    await writeManifest(manifest);

    await expectStartupFailure(/does not match its manifest hash/i);
  });

  it("fails when the manifest schema version is unsupported", async () => {
    const manifest = await readManifest();
    manifest.manifestVersion = 2;
    await writeManifest(manifest);

    await expectStartupFailure(/manifest schema version mismatch/i);
  });

  it("fails closed when build artifacts are missing outside development", async () => {
    await rm(compiledToolsPath, { force: true });

    await expectStartupFailure(/build artifact verification failed/i);
  });

  it("fails when the spec was edited after build, even in development", async () => {
    process.env.NODE_ENV = "development";
    await writeFile(
      specPath,
      `${pristine.spec}\n# edited after build\n`,
      "utf8",
    );

    await expectStartupFailure(/changed after build|source hash/i);
  });

  it("starts with a warning under --allow-manifest-drift", async () => {
    process.argv.push("--allow-manifest-drift");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await writeFile(
      specPath,
      `${pristine.spec}\n# edited after build\n`,
      "utf8",
    );

    const { handle, clientTransport } = await startServer();
    try {
      expect(warn).toHaveBeenCalled();
      const client = new Client(
        { name: "chainmcp-manifest-drift-client", version: "0.1.0" },
        { capabilities: {} },
      );
      try {
        await client.connect(clientTransport);
        const tools = await client.listTools();
        expect(tools.tools.map((tool) => tool.name)).toContain("getPets");
      } finally {
        await client.close();
      }
    } finally {
      await handle.close();
      await handle.closed;
    }
  });

  it("recompiles the pinned contract only in development when artifacts are absent", async () => {
    process.env.NODE_ENV = "development";
    await rm(compiledToolsPath, { force: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const { handle, clientTransport } = await startServer();
    try {
      expect(warn).toHaveBeenCalled();
      const client = new Client(
        { name: "chainmcp-dev-recompile-client", version: "0.1.0" },
        { capabilities: {} },
      );
      try {
        await client.connect(clientTransport);
        const tools = await client.listTools();
        expect(tools.tools.map((tool) => tool.name)).toContain("getPets");
      } finally {
        await client.close();
      }
    } finally {
      await handle.close();
      await handle.closed;
    }
  });

  it("never imports the compiler statically in the generated server", async () => {
    const serverSource = await readFile(
      join(projectDir, "src", "server.ts"),
      "utf8",
    );

    expect(serverSource).not.toMatch(
      /import\s*\{[^}]*\}\s*from\s*"@chainmcp\/compiler"/,
    );
    expect(serverSource.match(/"@chainmcp\/compiler"/g)).toHaveLength(1);
    expect(serverSource).toContain('await import("@chainmcp/compiler")');
  });
});

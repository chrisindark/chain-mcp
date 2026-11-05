import { spawn, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

import { initCommand } from "../src/commands/init.js";
import {
  assertChainMcpPackagesFromClone,
  installGeneratedProject,
} from "./support/generated-install.js";

/**
 * P1-6: execute the documented local-clone quick start
 * (clone → build → init → serve → MCP client) in a temp directory.
 *
 * Mirrors README.md "Quick Start (Local Clone)" and
 * docs/getting-started.md "Local-clone quick start" as literally as a
 * user can copy-paste:
 *
 * 1. `node packages/cli/dist/bin.js init --spec <petstore openapi.yaml>
 *    --output <dir> --local-deps <repo-root>` (programmatic initCommand,
 *    same argv as the docs).
 * 2. `pnpm install` in the generated project (offline, from local deps —
 *    no registry, via `--local-deps`).
 * 3. `pnpm build` in the generated project.
 * 4. Serve over stdio (both in-process via runServer and as a real child
 *    process via `node dist/server.js`, the Claude Desktop launch shape)
 *    and talk to it with a real MCP client: `tools/list` and `tools/call`.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const SPEC_PATH = join(REPO_ROOT, "examples", "petstore", "openapi.yaml");

function curl(argv: string[], cwd: string): void {
  const result = spawnSync(argv[0]!, argv.slice(1), {
    cwd,
    encoding: "utf8",
    timeout: 120_000,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${argv.join(" ")} failed with status ${result.status}: ${result.stderr}`,
    );
  }
}

describe("P1-6: documented local-clone quick start, end to end", () => {
  it("init --local-deps, pnpm install, pnpm build, serve, and MCP client tools/list + tools/call", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const tempDir = await mkdtemp(join(tmpdir(), "chainmcp-quickstart-"));
    try {
      const projectDir = join(tempDir, "my-mcp-server");

      const cliBin = join(REPO_ROOT, "packages", "cli", "dist", "bin.js");
      const binStat = await readFile(cliBin, {
        encoding: "utf8",
        flag: "r",
      }).catch(() => null);
      if (!binStat) {
        throw new Error(
          `Built CLI not found at ${cliBin}. Run "pnpm build" from the repo root first.`,
        );
      }

      // init with --local-deps (literal quick-start argv).
      const initResult = await initCommand({
        spec: SPEC_PATH,
        output: projectDir,
        localDeps: REPO_ROOT,
        cwd: REPO_ROOT,
      });
      expect(initResult.ok).toBe(true);

      const pkgJson = JSON.parse(
        await readFile(join(projectDir, "package.json"), "utf8"),
      ) as {
        scripts?: Record<string, string>;
        dependencies?: Record<string, string>;
      };
      expect(pkgJson.scripts?.build).toContain("tsc");
      expect(pkgJson.scripts?.start).toContain("node dist/server.js");
      expect(
        Object.values(pkgJson.dependencies ?? {}).some((s) =>
          s.startsWith("file:"),
        ),
      ).toBe(true);

      // Install from local deps only (no registry).
      await installGeneratedProject(projectDir);
      await assertChainMcpPackagesFromClone(projectDir, REPO_ROOT);

      // Build the generated server.
      curl(["pnpm", "build"], projectDir);
      const serverJs = join(projectDir, "dist", "server.js");
      expect(await readFile(serverJs, "utf8")).toContain("serveStdio");

      // In-process serve + real MCP client over a linked transport.
      const serverModule = (await import(serverJs)) as {
        runServer: (options: {
          transport: unknown;
          resolveHost?: (hostname: string) => Promise<string[]>;
          serverTransport: unknown;
        }) => Promise<{ close: () => Promise<void>; closed: Promise<void> }>;
      };
      const mockTransport = {
        async request() {
          return {
            status: 200,
            headers: { "content-type": "application/json; charset=utf-8" },
            body: new TextEncoder().encode(
              JSON.stringify({ id: "42", name: "Demo item 42", quantity: 3 }),
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
        { name: "chainmcp-quickstart-client", version: "0.1.0" },
        { capabilities: {} },
      );
      try {
        await client.connect(clientTransport);
        const { tools } = await client.listTools();
        expect(tools.map((t) => t.name).sort()).toEqual(
          expect.arrayContaining(["createItem", "getItem"]),
        );
        const call = await client.callTool({
          name: "getItem",
          arguments: { id: "42" },
        });
        expect(call.isError).toBeFalsy();
        const text = (call.content[0] as { type: "text"; text: string }).text;
        expect(JSON.parse(text)).toEqual({
          id: "42",
          name: "Demo item 42",
          quantity: 3,
        });
      } finally {
        await client.close();
        await serverHandle.close();
        await serverHandle.closed;
      }

      // Child-process stdio round-trip (the exact Claude Desktop launch
      // shape); the in-process half above covers tools/call. Launch it
      // through a symlinked project path so the main-module guard is
      // exercised the way macOS temp dirs (/var -> /private/var) and
      // symlinked checkouts do.
      const { symlink } = await import("node:fs/promises");
      const linkedProjectDir = join(tempDir, "my-mcp-server-link");
      await symlink(projectDir, linkedProjectDir, "dir");
      await expectRunServerStdio(
        join(linkedProjectDir, "dist", "server.js"),
        linkedProjectDir,
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 300_000);
});

/**
 * Spawn the built `dist/server.js` as a real child process over stdio —
 * exactly the Claude Desktop launch shape (`command: "node"`,
 * `args: ["<project>/dist/server.js"]`) — and speak the MCP protocol
 * (initialize + tools/list) over its stdin/stdout byte stream.
 * The child is run with `cwd` set to the project directory passed in (the
 * caller passes a symlinked path) so it resolves its own project-local
 * `node_modules` via the file: link, exactly as a user running `pnpm start`
 * from the generated directory does.
 */
async function expectRunServerStdio(
  serverJs: string,
  projectDir: string,
): Promise<void> {
  const child = spawn("node", [serverJs], {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: projectDir,
  });
  const responses: unknown[] = [];
  let buffer = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line) responses.push(JSON.parse(line));
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  await new Promise<void>((resolve) => child.on("spawn", resolve));
  const send = (msg: unknown) => {
    child.stdin.write(JSON.stringify(msg) + "\n");
  };
  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "quickstart-stdio", version: "0.1.0" },
    },
  });
  for (const wantId of [1, 2]) {
    const deadline = Date.now() + 10_000;
    while (
      !responses.some(
        (r) =>
          typeof r === "object" &&
          r !== null &&
          (r as { id?: number }).id === wantId,
      )
    ) {
      if (Date.now() > deadline) {
        child.kill("SIGKILL");
        throw new Error(
          `Timed out waiting for response id ${wantId} over stdio; got: ${JSON.stringify(responses)}; stderr: ${stderr}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (wantId === 1) {
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    }
  }
  child.stdin.end();
  await new Promise((resolve) => child.on("close", resolve));
  const initResp = responses.find(
    (r): r is { id: number; result: { serverInfo: { name: string } } } =>
      typeof r === "object" && r !== null && (r as { id: number }).id === 1,
  );
  expect(initResp?.result?.serverInfo?.name).toBeDefined();
  const listResp = responses.find(
    (r): r is { id: number; result: { tools: Array<{ name: string }> } } =>
      typeof r === "object" && r !== null && (r as { id: number }).id === 2,
  );
  expect(listResp?.result?.tools.map((t) => t.name).sort()).toEqual(
    expect.arrayContaining(["createItem", "getItem"]),
  );
}

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { compileOpenApi } from "@chainmcp/compiler";
import { InMemoryToolRuntime } from "@chainmcp/core";
import { createUpstreamExecutor } from "@chainmcp/executor";
import { serveStdio } from "@chainmcp/server";

import { createMockUpstreamTransport } from "./mock-upstream.js";

const exampleRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = await readFile(join(exampleRoot, "openapi.yaml"), "utf8");
const compiled = compileOpenApi(source);

if (!compiled.ok) {
  for (const diagnostic of compiled.diagnostics) {
    console.error(
      `${diagnostic.severity}: ${diagnostic.code}: ${diagnostic.message}`,
    );
  }
  process.exitCode = 1;
} else {
  const executor = createUpstreamExecutor({
    baseUrl: "https://api.chainmcp.test",
    allowedHosts: ["api.chainmcp.test"],
    contractRevision: compiled.contractRevision,
    resolveHost: async () => ["93.184.216.34"],
    transport: createMockUpstreamTransport(),
  });
  const runtime = new InMemoryToolRuntime();
  for (const tool of executor.createTools(compiled.tools)) {
    runtime.register(tool);
  }

  await serveStdio(runtime, {
    name: "chainmcp-petstore-example",
    version: "0.1.0",
    createContext: () => ({
      requestId: randomUUID(),
      tenantId: "demo",
      principal: { id: "demo-user", scopes: [] },
    }),
  });
}

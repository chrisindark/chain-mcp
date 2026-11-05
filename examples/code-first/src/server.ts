import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { InMemoryToolRuntime } from "@chainmcp/core";
import { serveStdio } from "@chainmcp/server";
import { tools } from "./tools.js";

export async function startServer() {
  const runtime = new InMemoryToolRuntime();

  for (const tool of tools) {
    runtime.register(tool);
  }

  return await serveStdio(runtime, {
    name: "example-code-first",
    version: "0.1.0",
    createContext: () => ({
      requestId: randomUUID(),
      tenantId: "demo",
      principal: { id: "demo-user", scopes: [] },
    }),
  });
}

// Automatically start when executed as entrypoint.
// Node resolves symlinks when loading the entry module, so import.meta.url can
// be the real path while process.argv[1] keeps the symlinked path.
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (entry === undefined || entry.length === 0) return false;
  const self = fileURLToPath(import.meta.url);
  if (entry === self) return true;
  try {
    return realpathSync(entry) === self;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  startServer().catch((error) => {
    console.error("Server error:", error);
    process.exit(1);
  });
}

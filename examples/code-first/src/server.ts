import { randomUUID } from "node:crypto";
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

// Automatically start when executed as entrypoint
if (import.meta.url === `file://${process.argv[1]}`) {
  startServer().catch((error) => {
    console.error("Server error:", error);
    process.exit(1);
  });
}

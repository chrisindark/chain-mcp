import path from "node:path";
import { fileURLToPath } from "node:url";

import { gatewayServeCommand } from "@chainmcp/cli";

const cwd = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const result = await gatewayServeCommand({
  cwd,
  config: "gateway.config.yaml",
});

if (result.url) {
  console.log(`Dynamic Gateway running at ${result.url.toString()}`);
}

await result.closed;

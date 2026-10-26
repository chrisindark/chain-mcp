import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { gatewayServeCommand } from "@chainmcp/cli";

const cwd = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("Gateway Example Deployment", () => {
  it("boots the example gateway with customers and orders contracts", async () => {
    const handle = await gatewayServeCommand({
      cwd,
      config: "gateway.config.yaml",
      port: 0, // ephemeral port for test
    });

    expect(handle.ok).toBe(true);
    expect(handle.serverName).toBe("enterprise-dynamic-gateway");
    expect(handle.contractCount).toBe(2);
    expect(handle.totalToolCount).toBe(2);
    expect(handle.url).toBeDefined();

    // Verify health
    const healthUrl = new URL("/health", handle.url!);
    const res = await fetch(healthUrl.toString());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("ok");

    await handle.close();
    await handle.closed;
  });
});

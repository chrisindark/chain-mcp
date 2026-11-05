import { startDeclarativeAdminServer } from "@chainmcp/admin";
import { DynamicGateway } from "@chainmcp/gateway";

export interface AdminCommandOptions {
  host?: string | undefined;
  port?: number | undefined;
  token?: string | undefined;
  json?: boolean | undefined;
}

export interface AdminCommandResult {
  ok: boolean;
  url?: string | undefined;
  error?: string | undefined;
}

export async function adminCommand(
  options: AdminCommandOptions = {},
): Promise<AdminCommandResult> {
  const token = options.token ?? process.env.CHAINMCP_ADMIN_TOKEN ?? "";
  if (!token) {
    return { ok: false, error: "CHAINMCP_ADMIN_TOKEN is required" };
  }
  try {
    const gateway = new DynamicGateway({});
    const server = await startDeclarativeAdminServer({
      admin: {
        gateway,
        tokens: [{ id: "cli", token, tenants: "*" }],
      },
      ...(options.host ? { host: options.host } : {}),
      ...(options.port ? { port: options.port } : {}),
    });
    return { ok: true, url: server.url };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

import {
  type ConnectedMcpServer,
  connectMcpServer,
  createMcpServer,
  type McpServerOptions,
  type Transport,
} from "@chainmcp/server";
import type { McpServer } from "@modelcontextprotocol/server";
import type { DynamicGateway } from "./gateway.js";

export type GatewayServerOptions = McpServerOptions;

/**
 * Creates an official MCP SDK server instance backed by a DynamicGateway.
 * Since DynamicGateway declares `tenantMode: "multi-tenant"`, low-level
 * per-request `tools/list` and `tools/call` handlers are automatically installed,
 * scoping tool discovery and invocation to each request's authenticated tenant.
 */
export function createGatewayServer(
  gateway: DynamicGateway,
  options: GatewayServerOptions,
): McpServer {
  return createMcpServer(gateway, options);
}

/**
 * Connects an MCP transport to a DynamicGateway instance and returns a ConnectedMcpServer handle.
 */
export async function connectGatewayServer(
  gateway: DynamicGateway,
  transport: Transport,
  options: GatewayServerOptions,
): Promise<ConnectedMcpServer> {
  return connectMcpServer(gateway, transport, options);
}

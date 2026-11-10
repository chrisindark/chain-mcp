import { createHash, randomBytes } from "node:crypto";
import { trace } from "@opentelemetry/api";
import {
  type JsonSchema,
  RuntimeError,
  type ToolContext,
  type ToolDefinition,
  type ToolSource,
} from "@chainmcp/core";
import {
  Client,
  StreamableHTTPClientTransport,
  type Transport,
  type CallToolResult,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { GatewayError, type ProxyDestinationConfig } from "./types.js";

export interface McpProxyAdapterOptions {
  readonly tenantId: string;
  readonly contractName: string;
  readonly proxy: ProxyDestinationConfig;
  readonly requiredScopes?: readonly string[] | undefined;
  readonly defaultTimeoutMs?: number | undefined;
  readonly clientName?: string | undefined;
  readonly clientVersion?: string | undefined;
}

/**
 * Generates a valid W3C traceparent (00-{traceId}-{spanId}-{flags}) from active OpenTelemetry
 * context or caller request identity.
 */
export function generateTraceparent(context?: ToolContext): string {
  try {
    const activeSpan = trace.getActiveSpan();
    if (activeSpan) {
      const spanCtx = activeSpan.spanContext();
      if (
        spanCtx &&
        spanCtx.traceId &&
        spanCtx.spanId &&
        spanCtx.traceId !== "00000000000000000000000000000000" &&
        spanCtx.spanId !== "0000000000000000"
      ) {
        const flags = (spanCtx.traceFlags ?? 1).toString(16).padStart(2, "0");
        return `00-${spanCtx.traceId.toLowerCase()}-${spanCtx.spanId.toLowerCase()}-${flags}`;
      }
    }
  } catch {
    // Fallback if tracer is not accessible
  }

  const traceId = context?.requestId
    ? createHash("sha256").update(context.requestId).digest("hex").slice(0, 32)
    : randomBytes(16).toString("hex");
  const spanId = randomBytes(8).toString("hex");
  return `00-${traceId}-${spanId}-01`;
}

/**
 * Unwraps standard MCP CallToolResult content into structured JSON or text
 * for downstream field projection and token accounting.
 */
export function unwrapCallToolResult(result: CallToolResult): unknown {
  if (!result.content || result.content.length === 0) {
    return { ok: true };
  }

  if (
    result.content.length === 1 &&
    result.content[0]?.type === "text" &&
    typeof result.content[0]?.text === "string"
  ) {
    const text = result.content[0].text;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  return { content: result.content };
}

function isToolCacheEligible(
  toolName: string,
  cacheEligible?: boolean | readonly string[] | undefined,
): boolean {
  if (cacheEligible === true) {
    return true;
  }
  if (Array.isArray(cacheEligible)) {
    return cacheEligible.includes(toolName);
  }
  return false;
}

/**
 * Active MCP-to-MCP Proxy Adapter. Connects to an external stdio or HTTP MCP server,
 * discovers its tools via tools/list, wraps each tool with ChainMcp governance policies,
 * and injects W3C traceparent into params._meta on each invocation.
 */
export class McpProxyAdapter implements ToolSource {
  public readonly tenantId: string;
  public readonly contractName: string;
  public readonly proxyConfig: ProxyDestinationConfig;
  private readonly requiredScopes?: readonly string[] | undefined;
  private readonly client: Client;
  private tools: readonly ToolDefinition[] = [];
  private isConnected = false;

  constructor(options: McpProxyAdapterOptions) {
    this.tenantId = options.tenantId;
    this.contractName = options.contractName;
    this.proxyConfig = options.proxy;
    this.requiredScopes = options.requiredScopes;

    this.client = new Client(
      {
        name: options.clientName ?? "chainmcp-gateway-proxy",
        version: options.clientVersion ?? "0.5.0",
      },
      {
        capabilities: {},
      },
    );
  }

  /**
   * Connects to the external MCP server, negotiates protocol, and queries tools/list.
   */
  async connect(): Promise<void> {
    if (this.isConnected) {
      return;
    }

    let transport: Transport;

    if (this.proxyConfig.transport === "custom") {
      if (!this.proxyConfig.customTransport) {
        throw new GatewayError(
          "DESTINATION_INVALID",
          "Proxy transport 'custom' requires a customTransport instance",
        );
      }
      transport = this.proxyConfig.customTransport as Transport;
    } else if (this.proxyConfig.transport === "http") {
      if (!this.proxyConfig.url) {
        throw new GatewayError(
          "DESTINATION_INVALID",
          "Proxy transport 'http' requires 'url'",
        );
      }
      let url: URL;
      try {
        url = new URL(this.proxyConfig.url);
      } catch (err) {
        throw new GatewayError(
          "DESTINATION_INVALID",
          `Invalid proxy HTTP URL '${this.proxyConfig.url}'`,
          { cause: err },
        );
      }

      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new GatewayError(
          "DESTINATION_INVALID",
          `Proxy HTTP URL must use http: or https: scheme (got '${url.protocol}')`,
        );
      }

      transport = new StreamableHTTPClientTransport(url, {
        ...(this.proxyConfig.headers
          ? { requestInit: { headers: { ...this.proxyConfig.headers } } }
          : {}),
      });
    } else if (this.proxyConfig.transport === "stdio") {
      if (!this.proxyConfig.command) {
        throw new GatewayError(
          "DESTINATION_INVALID",
          "Proxy transport 'stdio' requires 'command'",
        );
      }

      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (typeof v === "string") {
          env[k] = v;
        }
      }
      if (this.proxyConfig.env) {
        for (const [k, v] of Object.entries(this.proxyConfig.env)) {
          if (typeof v === "string") {
            env[k] = v;
          }
        }
      }

      transport = new StdioClientTransport({
        command: this.proxyConfig.command,
        env,
        ...(this.proxyConfig.args ? { args: [...this.proxyConfig.args] } : {}),
        ...(this.proxyConfig.cwd !== undefined
          ? { cwd: this.proxyConfig.cwd }
          : {}),
      });
    } else {
      throw new GatewayError(
        "DESTINATION_INVALID",
        `Unsupported proxy transport '${String(this.proxyConfig.transport)}'`,
      );
    }

    try {
      await this.client.connect(transport);
      this.isConnected = true;
    } catch (err) {
      throw new GatewayError(
        "DESTINATION_INVALID",
        `Failed to connect to external MCP server: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }

    // Discover tools
    await this.discoverTools();
  }

  private async discoverTools(): Promise<void> {
    const listResult = await this.client.listTools();
    const discovered = listResult.tools ?? [];

    const prefix = this.proxyConfig.toolPrefix ?? "";

    this.tools = discovered.map((t) => {
      const toolName = prefix ? `${prefix}${t.name}` : t.name;
      const isEligible = isToolCacheEligible(
        t.name,
        this.proxyConfig.cacheEligible,
      );

      const def: ToolDefinition = {
        name: toolName,
        description: t.description ?? "",
        inputSchema: (t.inputSchema as JsonSchema) ?? {
          type: "object",
          properties: {},
        },
        ownerTenantId: this.tenantId,
        operation: {
          ...(this.requiredScopes && this.requiredScopes.length > 0
            ? { requiredScopes: this.requiredScopes }
            : {}),
        },
        ...(isEligible
          ? {
              cache: {
                ttlSeconds: 300,
              },
            }
          : {}),
        execute: async (
          input: unknown,
          context: ToolContext,
        ): Promise<unknown> => {
          if (!this.isConnected) {
            throw new RuntimeError(
              "UPSTREAM_FAILURE",
              `Proxy client for contract '${this.contractName}' is not connected`,
            );
          }

          // Inject W3C traceparent and correlation context into params._meta
          const traceparent = generateTraceparent(context);
          const meta: Record<string, unknown> = {
            traceparent,
            ...(context.tenantId ? { "tenant.id": context.tenantId } : {}),
            ...(context.principal?.id
              ? { "principal.id": context.principal.id }
              : {}),
            ...(context.requestId ? { "request.id": context.requestId } : {}),
          };

          const callResult = await this.client.callTool(
            {
              name: t.name,
              arguments: (input ?? {}) as Record<string, unknown>,
              _meta: meta,
            },
            context.signal ? { signal: context.signal } : undefined,
          );

          if (callResult.isError) {
            const errorMsg =
              callResult.content
                ?.filter((c) => c.type === "text" && typeof c.text === "string")
                .map((c) => (c as { text: string }).text)
                .join("\n") || `Upstream tool '${t.name}' returned an error`;
            throw new RuntimeError("UPSTREAM_FAILURE", errorMsg);
          }

          return unwrapCallToolResult(callResult);
        },
      };

      return def;
    });
  }

  getTools(): readonly ToolDefinition[] {
    return this.tools;
  }

  async close(): Promise<void> {
    if (this.isConnected) {
      this.isConnected = false;
      try {
        await this.client.close();
      } catch {
        // Safe isolate
      }
    }
  }
}

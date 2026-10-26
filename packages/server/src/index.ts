import {
  auditInputSchema,
  type JsonSchema,
  RuntimeError,
  type RuntimeErrorCode,
  type ToolContext,
  type ToolRuntime,
} from "@chainmcp/core";
import {
  type AuthInfo,
  type CallToolResult,
  fromJsonSchema,
  McpServer,
  ProtocolError,
  ProtocolErrorCode,
  type RequestId,
  type ServerContext,
  type Transport,
} from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import type { Readable, Writable } from "node:stream";

export type {
  AuthInfo,
  CallToolResult,
  RequestId,
  ServerContext,
  Transport,
} from "@modelcontextprotocol/server";

export interface McpServerOptions {
  name: string;
  version: string;
  /** Establishes trusted inbound identity for each tool call. */
  createContext: (
    request: McpRequestContext,
  ) => ToolContext | Promise<ToolContext>;
  maxResponseBytes?: number;
  listChanged?: boolean;
  onclose?: () => void;
}

export interface McpRequestContext {
  id: RequestId;
  signal: AbortSignal;
  authInfo?: AuthInfo;
}

export interface ConnectedMcpServer {
  server: McpServer;
  /** Resolves when the underlying transport closes, including peer closure. */
  closed: Promise<void>;
  close(): Promise<void>;
}

export interface StdioServeOptions {
  /** Defaults to the current process stdin; injectable for embedding and tests. */
  stdin?: Readable;
  /** Defaults to the current process stdout; injectable for embedding and tests. */
  stdout?: Writable;
  /** Optional application shutdown signal. */
  signal?: AbortSignal;
  /** Install SIGINT/SIGTERM handlers and set the conventional process exit code. */
  handleProcessSignals?: boolean;
}

const DEFAULT_MAX_RESPONSE_BYTES = 1_000_000;
const MAX_ALLOWED_RESPONSE_BYTES = 100_000_000;

/** Bridges the shared runtime to the official MCP SDK. */
export function createMcpServer(
  runtime: ToolRuntime,
  options: McpServerOptions,
): McpServer {
  const maxResponseBytes =
    options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  if (
    !Number.isSafeInteger(maxResponseBytes) ||
    maxResponseBytes < 1 ||
    maxResponseBytes > MAX_ALLOWED_RESPONSE_BYTES
  ) {
    throw new TypeError(
      `maxResponseBytes must be a positive safe integer no greater than ${MAX_ALLOWED_RESPONSE_BYTES}`,
    );
  }

  const server = new McpServer({
    name: options.name,
    version: options.version,
  });
  if (runtime.tenantMode === "multi-tenant") {
    installMultiTenantToolHandlers(server, runtime, options, maxResponseBytes);
  } else {
    // The adapter snapshots tools at creation, which is exact for
    // single-tenant runtimes. The runtime declares its tenancy mode on the
    // public `ToolRuntime` interface, so a multi-tenant runtime cannot be
    // mistaken for a single-tenant one and listed without a caller context.
    for (const tool of runtime.listTools()) {
      assertServerToolSchema(tool.name, tool.inputSchema);
      server.registerTool(
        tool.name,
        {
          description: tool.description,
          inputSchema: fromJsonSchema(
            // The audit above is the compatibility gate for this SDK conversion;
            // keep schema parity tests alongside any changes to the audited subset.
            tool.inputSchema as Parameters<typeof fromJsonSchema>[0],
          ),
        },
        async (input, requestContext) => {
          const result = await toolCallResult(
            runtime,
            tool.name,
            input,
            async () => establishContext(options, requestContext),
            maxResponseBytes,
          );
          return server.server.projectCallToolResult(result, undefined);
        },
      );
    }
  }

  const observableRuntime = runtime as unknown as {
    onToolsChanged?: (listener: () => void | Promise<void>) => () => void;
  };
  if (typeof observableRuntime.onToolsChanged === "function") {
    const unsubscribe = observableRuntime.onToolsChanged(async () => {
      try {
        await server.sendToolListChanged();
      } catch {
        // Notification errors when transport closes are ignored safely
      }
    });
    const originalClose = server.close.bind(server);
    server.close = async () => {
      unsubscribe();
      return originalClose();
    };
  }

  return server;
}

/**
 * Establishes trusted inbound identity for one MCP request through the
 * adapter's context factory. The returned context merges the adapter's own
 * cancellation signal with the protocol request signal, exactly as tool
 * callbacks do in the snapshot path.
 */
async function establishContext(
  options: McpServerOptions,
  requestContext: ServerContext,
): Promise<ToolContext> {
  const request: McpRequestContext = {
    id: requestContext.mcpReq.id,
    signal: requestContext.mcpReq.signal,
    ...(requestContext.http?.authInfo
      ? { authInfo: requestContext.http.authInfo }
      : {}),
  };
  const context = await options.createContext(request);
  return {
    ...context,
    signal: context.signal
      ? AbortSignal.any([context.signal, request.signal])
      : request.signal,
  };
}

type SdkToolResult = CallToolResult;

/**
 * Invokes one runtime tool and maps every failure to a safe MCP error result.
 * Shared by the snapshot path (single-tenant) and the per-request path
 * (multi-tenant) so error mapping cannot drift between them.
 */
async function toolCallResult(
  runtime: ToolRuntime,
  name: string,
  input: unknown,
  createContext: () => Promise<ToolContext>,
  maxResponseBytes: number,
): Promise<SdkToolResult> {
  try {
    const result = await runtime.callTool(name, input, createContext);
    const text = JSON.stringify(result);
    if (text === undefined) {
      throw new RuntimeError(
        "UPSTREAM_FAILURE",
        "Tool returned a non-JSON result",
      );
    }
    if (Buffer.byteLength(text, "utf8") > maxResponseBytes) {
      throw new RuntimeError(
        "UPSTREAM_FAILURE",
        "Tool response exceeds the configured limit",
      );
    }
    return { content: [{ type: "text" as const, text }] };
  } catch (error) {
    if (error instanceof RuntimeError) {
      return {
        content: [
          {
            type: "text" as const,
            text: `${error.code}: ${safeRuntimeErrorMessage(error)}`,
          },
        ],
        isError: true,
      };
    }
    return {
      content: [
        {
          type: "text" as const,
          text: "UPSTREAM_FAILURE: Tool invocation failed",
        },
      ],
      isError: true,
    };
  }
}

/**
 * Installs per-request `tools/list` and `tools/call` handlers for multi-tenant
 * runtimes (ADR 0008). Listings are identity-scoped against the same tenant
 * registry that `callTool` resolves against, so discovery and invocation
 * cannot disagree, and per-call authorization still runs on every invocation.
 * Protocol pagination is not implemented: like the snapshot path, every listing
 * answers once with no `nextCursor`.
 */
function installMultiTenantToolHandlers(
  server: McpServer,
  runtime: ToolRuntime,
  options: McpServerOptions,
  maxResponseBytes: number,
): void {
  // Multi-tenant handlers declare tool capabilities including listChanged support.
  const listChanged = options.listChanged ?? true;
  server.server.registerCapabilities({ tools: { listChanged } });
  server.server.setRequestHandler("tools/list", async (_request, ctx) => {
    try {
      const context = await establishContext(options, ctx);
      const tools = runtime.listTools(context).map((tool) => {
        assertServerToolSchema(tool.name, tool.inputSchema);
        const inputSchemaJson = fromJsonSchema(
          tool.inputSchema as Parameters<typeof fromJsonSchema>[0],
        )["~standard"].jsonSchema.input({ target: "draft-2020-12" });
        return {
          name: tool.name,
          description: tool.description,
          // The audited subset guarantees an object root.
          inputSchema: inputSchemaJson as {
            type: "object";
            [key: string]: unknown;
          },
        };
      });
      return { tools };
    } catch (error) {
      // Fail closed without leaking listing internals.
      const message =
        error instanceof RuntimeError
          ? safeRuntimeErrorMessage(error)
          : "Access denied";
      throw new ProtocolError(ProtocolErrorCode.InternalError, message);
    }
  });
  server.server.setRequestHandler("tools/call", async (request, ctx) => {
    // The tool name is attacker-controlled request data; the runtime treats
    // every name it has not registered, including any non-string value, as a
    // plain miss.
    const name =
      typeof request.params.name === "string" ? request.params.name : "";
    return server.server.projectCallToolResult(
      await toolCallResult(
        runtime,
        name,
        request.params.arguments,
        async () => establishContext(options, ctx),
        maxResponseBytes,
      ),
      undefined,
    );
  });
}

/**
 * The compatibility gate for exposing a runtime schema to MCP: outside the
 * core-supported subset, or without an object root, the tool must not be
 * exposed. Shared by the snapshot and per-request listing paths.
 */
function assertServerToolSchema(name: string, inputSchema: JsonSchema): void {
  const schemaAudit = auditInputSchema(inputSchema);
  if (!schemaAudit.supported) {
    throw new TypeError(
      `Runtime exposed unsupported schema for tool '${name}': ${schemaAudit.diagnostics[0]?.message ?? "invalid schema"}`,
    );
  }
  if (inputSchema.type !== "object") {
    throw new TypeError(
      `Tool '${name}' must declare an object input schema for MCP`,
    );
  }
}

/**
 * Safe client-visible messages keyed by runtime error code. Declaring the
 * record over the full `RuntimeErrorCode` union makes a new code a build
 * error instead of rendering `undefined` to the caller.
 */
const SAFE_RUNTIME_ERROR_MESSAGES: Record<RuntimeErrorCode, string> = {
  INPUT_INVALID: "Invalid tool arguments",
  AUTH_FORBIDDEN: "Access denied",
  RATE_LIMITED: "Rate limit exceeded",
  OUTPUT_POLICY_VIOLATION: "Tool output was rejected by policy",
  OUTPUT_LIMIT_EXCEEDED: "Tool output exceeded the configured limit",
  CANCELLED: "Tool call cancelled",
  UPSTREAM_TIMEOUT: "Tool call timed out",
  TOOL_NOT_FOUND: "Tool not found",
  TOOL_ALREADY_REGISTERED: "Tool is unavailable",
  CONFIG_INVALID: "Tool is unavailable",
  AUTH_REQUIRED: "Authentication required",
  CONTRACT_INVALID: "Tool definition is invalid",
  UPSTREAM_FAILURE: "Tool invocation failed",
};

/**
 * Upper bound for a rendered retry hint. Larger values are not client
 * actionable and would only pad the response.
 */
const MAX_RETRY_AFTER_HINT_SECONDS = 86_400;

function safeRuntimeErrorMessage(error: RuntimeError): string {
  const base = SAFE_RUNTIME_ERROR_MESSAGES[error.code];
  if (error.code !== "RATE_LIMITED") return base;
  // Retry hints are client-actionable, so surface the runtime's value when it is
  // an integer we can render safely. Values are sanitized rather than
  // interpolated blindly: the field is typed, but the runtime is a trust
  // boundary between the limiter and the wire.
  const retryAfterSeconds = error.retryAfterSeconds;
  if (
    typeof retryAfterSeconds !== "number" ||
    !Number.isSafeInteger(retryAfterSeconds) ||
    retryAfterSeconds < 1 ||
    retryAfterSeconds > MAX_RETRY_AFTER_HINT_SECONDS
  ) {
    return base;
  }
  const unit = retryAfterSeconds === 1 ? "second" : "seconds";
  return `${base}. Retry after ${retryAfterSeconds} ${unit}`;
}

/** Connects a server and returns an idempotent close handle. */
export async function connectMcpServer(
  runtime: ToolRuntime,
  transport: Transport,
  options: McpServerOptions,
): Promise<ConnectedMcpServer> {
  const server = createMcpServer(runtime, options);
  let notifyClosed: (() => void) | undefined;
  const closed = new Promise<void>((resolve) => {
    notifyClosed = resolve;
  });
  server.server.onclose = () => {
    notifyClosed?.();
    try {
      options.onclose?.();
    } catch {
      // Lifecycle observers must not interfere with protocol teardown.
    }
  };
  try {
    await server.connect(transport);
  } catch (error) {
    try {
      await server.close();
    } catch {
      // Preserve the connection error; cleanup errors are not client-facing.
    }
    throw error;
  }
  let closePromise: Promise<void> | undefined;
  return {
    server,
    closed,
    async close() {
      closePromise ??= server.close();
      return closePromise;
    },
  };
}

/**
 * Starts local stdio and closes it on EOF, an optional abort signal, or
 * SIGINT/SIGTERM. Protocol output stays on stdout.
 */
export async function serveStdio(
  runtime: ToolRuntime,
  options: McpServerOptions,
  stdioOptions: StdioServeOptions = {},
): Promise<ConnectedMcpServer> {
  const stdin = stdioOptions.stdin ?? process.stdin;
  const stdout = stdioOptions.stdout ?? process.stdout;
  const handleProcessSignals = stdioOptions.handleProcessSignals ?? true;
  const connected = await connectMcpServer(
    runtime,
    new StdioServerTransport(stdin, stdout),
    options,
  );
  const onEnd = () => {
    void connected.close().catch(() => {});
  };
  const onAbort = () => onEnd();
  const onSigint = () => {
    process.exitCode = 130;
    onEnd();
  };
  const onSigterm = () => {
    process.exitCode = 143;
    onEnd();
  };
  const cleanup = () => {
    stdin.off("end", onEnd);
    stdioOptions.signal?.removeEventListener("abort", onAbort);
    if (handleProcessSignals) {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
    }
  };

  stdin.once("end", onEnd);
  if (stdioOptions.signal?.aborted) onAbort();
  else stdioOptions.signal?.addEventListener("abort", onAbort, { once: true });
  if (handleProcessSignals) {
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
  }
  void connected.closed.then(cleanup);
  return connected;
}

export * from "./verifier.js";
export * from "./http.js";

import http from "node:http";
import type { ToolRuntime } from "@chainmcp/core";
import { createMcpHandler } from "@modelcontextprotocol/server";
import {
  type ConnectedMcpServer,
  createMcpServer,
  type McpServerOptions,
} from "./index.js";
import type { InboundAuthVerifier, InboundAuthResult } from "./verifier.js";

export interface HttpServeOptions {
  /** Port to listen on (default 3333; use 0 for ephemeral port assignment in tests). */
  port?: number | undefined;
  /** Host interface to bind to (default "127.0.0.1"). */
  host?: string | undefined;
  /** Base path for the MCP endpoint (default "/mcp"). */
  path?: string | undefined;
  /** Optional cancellation signal to trigger graceful server shutdown. */
  signal?: AbortSignal | undefined;
  /** Inbound verifier to parse and validate caller identity (bearer tokens, API keys, JWTs). */
  verifier?: InboundAuthVerifier | undefined;
  /** Whether requests must have valid inbound authentication (default false unless verifier is provided). */
  requireAuth?: boolean | undefined;
  /** Whether to enable CORS headers and preflight handling (default true). */
  cors?: boolean | undefined;
  /** Install SIGINT/SIGTERM handlers and set standard process exit codes (default true). */
  handleProcessSignals?: boolean | undefined;
}

export interface ConnectedHttpServer extends ConnectedMcpServer {
  httpServer: http.Server;
  url: URL;
}

const DEFAULT_PORT = 3333;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PATH = "/mcp";

/**
 * Starts an HTTP server supporting modern Streamable HTTP and SSE transports
 * for Model Context Protocol clients.
 */
export async function serveHttp(
  runtime: ToolRuntime,
  options: McpServerOptions,
  httpOptions: HttpServeOptions = {},
): Promise<ConnectedHttpServer> {
  const port = httpOptions.port ?? DEFAULT_PORT;
  const host = httpOptions.host ?? DEFAULT_HOST;
  const mcpPath = normalizePath(httpOptions.path ?? DEFAULT_PATH);
  const requireAuth = httpOptions.requireAuth ?? false;
  const corsEnabled = httpOptions.cors ?? true;
  const handleProcessSignals = httpOptions.handleProcessSignals ?? true;

  const server = createMcpServer(runtime, options);
  const mcpHandler = createMcpHandler(() => server);

  let notifyClosed: (() => void) | undefined;
  const closed = new Promise<void>((resolve) => {
    notifyClosed = resolve;
  });

  const httpServer = http.createServer(async (req, res) => {
    try {
      const requestUrl = new URL(
        req.url ?? "/",
        `http://${req.headers.host ?? `${host}:${port}`}`,
      );

      // CORS Preflight & Headers
      if (corsEnabled) {
        const origin = (req.headers.origin as string) || "*";
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader(
          "Access-Control-Allow-Methods",
          "GET, POST, OPTIONS, DELETE",
        );
        res.setHeader(
          "Access-Control-Allow-Headers",
          "Content-Type, Authorization, X-API-Key, Accept, mcp-session-id, last-event-id",
        );
        res.setHeader(
          "Access-Control-Expose-Headers",
          "Content-Type, mcp-session-id",
        );

        if (req.method === "OPTIONS") {
          res.statusCode = 204;
          res.end();
          return;
        }
      }

      // Health and liveness probe
      if (
        requestUrl.pathname === "/health" ||
        requestUrl.pathname === "/livez"
      ) {
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            status: "ok",
            name: options.name,
            version: options.version,
          }),
        );
        return;
      }

      // Match target MCP endpoint
      if (
        requestUrl.pathname !== mcpPath &&
        !requestUrl.pathname.startsWith(`${mcpPath}/`)
      ) {
        res.statusCode = 404;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Not Found" }));
        return;
      }

      // Inbound Authentication
      let authResult: InboundAuthResult | undefined;
      if (httpOptions.verifier) {
        authResult = await httpOptions.verifier.verify({
          headers: req.headers,
          url: requestUrl,
          method: req.method,
        });
      }

      if (requireAuth && !authResult) {
        res.statusCode = 401;
        res.setHeader("WWW-Authenticate", 'Bearer error="invalid_token"');
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: {
              code: -32001,
              message: "Unauthorized: valid inbound credentials required",
            },
            id: null,
          }),
        );
        return;
      }

      // Read incoming body for non-GET/HEAD methods
      let body: Buffer | undefined;
      if (req.method !== "GET" && req.method !== "HEAD") {
        const chunks: Uint8Array[] = [];
        for await (const chunk of req) {
          chunks.push(chunk as Uint8Array);
        }
        body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
      }

      // Convert Node IncomingMessage to web Request
      const webHeaders = new Headers();
      for (const [headerName, headerValue] of Object.entries(req.headers)) {
        if (headerValue === undefined) continue;
        if (Array.isArray(headerValue)) {
          for (const val of headerValue) {
            webHeaders.append(headerName, val);
          }
        } else {
          webHeaders.set(headerName, headerValue);
        }
      }

      const webRequest = new Request(requestUrl, {
        method: req.method ?? "GET",
        headers: webHeaders,
        body: body ? new Uint8Array(body) : null,
      });

      // Invoke MCP handler with authInfo pass-through
      const webResponse = await mcpHandler.fetch(
        webRequest,
        authResult?.authInfo ? { authInfo: authResult.authInfo } : {},
      );

      res.statusCode = webResponse.status;
      for (const [key, value] of webResponse.headers.entries()) {
        res.setHeader(key, value);
      }

      if (webResponse.body) {
        const reader = webResponse.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(value);
          }
        } finally {
          reader.releaseLock();
        }
      }
      res.end();
    } catch {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal server error" },
            id: null,
          }),
        );
      }
    }
  });

  // Start HTTP listening
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });

  const address = httpServer.address();
  const actualPort =
    typeof address === "object" && address !== null ? address.port : port;
  const serverUrl = new URL(`http://${host}:${actualPort}${mcpPath}`);

  let closePromise: Promise<void> | undefined;
  const close = async (): Promise<void> => {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      try {
        await mcpHandler.close().catch(() => {});
      } catch {
        // Ignored: handler teardown errors should not block HTTP server closure
      }
      try {
        await server.close().catch(() => {});
      } catch {
        // Ignored: server teardown errors should not block HTTP server closure
      }
      if (httpServer.listening) {
        if (typeof httpServer.closeAllConnections === "function") {
          httpServer.closeAllConnections();
        }
        await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      }
      notifyClosed?.();
      try {
        options.onclose?.();
      } catch {
        // Observers must not fail teardown
      }
    })();
    return closePromise;
  };

  const onAbort = () => {
    void close().catch(() => {});
  };
  const onSigint = () => {
    process.exitCode = 130;
    void close().catch(() => {});
  };
  const onSigterm = () => {
    process.exitCode = 143;
    void close().catch(() => {});
  };

  const cleanup = () => {
    httpOptions.signal?.removeEventListener("abort", onAbort);
    if (handleProcessSignals) {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
    }
  };

  if (httpOptions.signal?.aborted) {
    onAbort();
  } else {
    httpOptions.signal?.addEventListener("abort", onAbort, { once: true });
  }

  if (handleProcessSignals) {
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
  }

  void closed.then(cleanup);

  return {
    server,
    httpServer,
    url: serverUrl,
    closed,
    close,
  };
}

function normalizePath(p: string): string {
  if (!p.startsWith("/")) return `/${p}`;
  return p;
}

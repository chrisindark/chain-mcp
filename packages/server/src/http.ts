import http from "node:http";
import type { ToolRuntime, Authorizer } from "@chainmcp/core";
import { createMcpHandler } from "@modelcontextprotocol/server";
import {
  type ConnectedMcpServer,
  createMcpServer,
  type McpServerOptions,
} from "./index.js";
import {
  isInboundAuthFailure,
  type InboundAuthVerifier,
  type InboundAuthOutcome,
} from "./verifier.js";

export interface HttpCorsOptions {
  /** Whether CORS is enabled. CORS is disabled by default on every bind host. */
  enabled?: boolean | undefined;
  /** Explicit allowed origins (exact match, "null", or "*"). Wildcard cannot be used with allowCredentials. */
  allowedOrigins?: string[] | undefined;
  /** Extra headers allowed in CORS requests, appended to standard defaults. */
  allowedHeaders?: string[] | undefined;
  /** Whether to allow credentials (Access-Control-Allow-Credentials). Never permitted with wildcard '*'. */
  allowCredentials?: boolean | undefined;
  /** Preflight cache duration in seconds (Access-Control-Max-Age; default 600). */
  maxAgeSeconds?: number | undefined;
}

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
  /** Alias for requireAuth. */
  requireInboundAuth?: boolean | undefined;
  /** Explicitly allow unauthenticated HTTP access on non-loopback network interfaces (default false). */
  allowUnauthenticatedHttp?: boolean | undefined;
  /** Inbound authorizer instance or authorizer type ("scope" | "none"). */
  authorizer?: Authorizer | "scope" | "none" | undefined;
  /** Explicit authorizer type ("scope" | "none"). */
  authorizerType?: "scope" | "none" | undefined;
  /** Total count of registered tools (for startup diagnostics/warning). */
  toolCount?: number | undefined;
  /** Custom warning handler for unauthenticated server startup. */
  warn?:
    ((message: string, meta?: Record<string, unknown>) => void) | undefined;
  /** Custom info handler for logging security posture at startup. */
  info?:
    ((message: string, meta?: Record<string, unknown>) => void) | undefined;
  /** Optional logger for diagnostics and security posture. */
  logger?:
    | {
        warn?: (message: string, meta?: Record<string, unknown>) => void;
        info?: (message: string, meta?: Record<string, unknown>) => void;
      }
    | undefined;
  /** Whether to enable CORS headers and preflight handling, or explicit CORS options. */
  cors?: boolean | HttpCorsOptions | undefined;
  /** Hard cap in bytes on incoming request bodies (default 1 MiB = 1048576 bytes). */
  maxRequestBytes?: number | undefined;
  /** List of allowed Host header values for DNS rebinding protection. */
  allowedHosts?: string[] | undefined;
  /** List of allowed Origin header values for DNS rebinding and CORS protection. */
  allowedOrigins?: string[] | undefined;
  /** Enable DNS rebinding protection (enforces allowedHosts and allowedOrigins). */
  enableDnsRebindingProtection?: boolean | undefined;
  /** Request timeout in milliseconds (applied to HTTP server and body reads; default 15,000 ms). */
  requestTimeoutMs?: number | undefined;
  /** Time to drain in-flight requests during shutdown (default 10,000 ms). */
  shutdownTimeoutMs?: number | undefined;
  /** Install SIGINT/SIGTERM handlers and set standard process exit codes (default true). */
  handleProcessSignals?: boolean | undefined;
  /**
   * Opt-in `/readyz` readiness checks. Liveness (`/health`, `/livez`) stays
   * dependency-free; `/readyz` also reflects each check in `deps`. When
   * omitted, `/readyz` returns ready with no dependency detail.
   */
  readiness?:
    | {
        /** Dependencies to report on /readyz. Each `check` returns true when healthy. */
        deps?:
          | Array<{
              name: string;
              check: () => boolean | Promise<boolean>;
              /** When true, a failed check still leaves the server ready (e.g. rate-limiter `fail-open`). */
              degradedReady?: boolean | undefined;
            }>
          | undefined;
      }
    | undefined;
  protectedResourceMetadata?:
    | {
        resource?: string | undefined;
        authorizationServers?: string[] | undefined;
        scopesSupported?: string[] | undefined;
        bearerMethodsSupported?: string[] | undefined;
        resourceName?: string | undefined;
      }
    | undefined;
  protectedResource?:
    | {
        resource?: string | undefined;
        authorizationServers?: string[] | undefined;
        scopesSupported?: string[] | undefined;
        bearerMethodsSupported?: string[] | undefined;
        resourceName?: string | undefined;
      }
    | undefined;
  resourceMetadata?:
    | {
        resource?: string | undefined;
        authorizationServers?: string[] | undefined;
        scopesSupported?: string[] | undefined;
        bearerMethodsSupported?: string[] | undefined;
        resourceName?: string | undefined;
      }
    | undefined;
  authorizationServers?: string[] | undefined;
  scopesSupported?: string[] | undefined;
  /**
   * Optional OTLP HTTP ingestion handler for `/v1/traces` and `/v1/metrics`.
   * Returns true if the request was an OTLP route and handled.
   */
  otlpHandler?:
    | ((
        req: http.IncomingMessage,
        res: http.ServerResponse,
      ) => boolean | Promise<boolean>)
    | undefined;
}

export interface ConnectedHttpServer extends ConnectedMcpServer {
  httpServer: http.Server;
  url: URL;
}

const DEFAULT_PORT = 3333;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PATH = "/mcp";
const DEFAULT_MAX_REQUEST_BYTES = 1024 * 1024; // 1 MiB (1,048,576 bytes)
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

function normalizeHostname(hostOrUrl: string): string {
  const trimmed = hostOrUrl.trim().toLowerCase();
  try {
    const url = new URL(
      trimmed.includes("://") ? trimmed : `http://${trimmed}`,
    );
    return url.hostname.toLowerCase();
  } catch {
    const split = trimmed.split(":");
    return split[0] ?? trimmed;
  }
}

export function isLoopbackHost(hostname: string): boolean {
  const norm = normalizeHostname(hostname);
  return (
    norm === "127.0.0.1" ||
    norm === "localhost" ||
    norm === "::1" ||
    norm === "[::1]" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(norm)
  );
}

function isAnyOrLoopback(hostname: string): boolean {
  const norm = normalizeHostname(hostname);
  return isLoopbackHost(norm) || norm === "0.0.0.0" || norm === "::";
}

function deriveAllowedHosts(
  bindHost: string,
  explicitHosts?: string[],
): string[] {
  if (explicitHosts && explicitHosts.length > 0) {
    return explicitHosts.map(normalizeHostname);
  }
  const norm = normalizeHostname(bindHost);
  if (isAnyOrLoopback(norm)) {
    return ["localhost", "127.0.0.1", "[::1]"];
  }
  return [norm];
}

function deriveAllowedOrigins(
  bindHost: string,
  explicitOrigins?: string[],
): string[] {
  if (explicitOrigins && explicitOrigins.length > 0) {
    return explicitOrigins.map(normalizeHostname);
  }
  const norm = normalizeHostname(bindHost);
  if (isAnyOrLoopback(norm)) {
    return ["localhost", "127.0.0.1", "[::1]"];
  }
  return [norm];
}

export const DEFAULT_CORS_HEADERS: readonly string[] = [
  "Content-Type",
  "Authorization",
  "X-API-Key",
  "Accept",
  "mcp-session-id",
  "last-event-id",
];

export function computeAllowedHeaders(
  verifierHeaders?: readonly string[] | undefined,
  customHeaders?: readonly string[] | undefined,
): string {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const h of DEFAULT_CORS_HEADERS) {
    const trimmed = h.trim();
    if (trimmed && !seen.has(trimmed.toLowerCase())) {
      seen.add(trimmed.toLowerCase());
      result.push(trimmed);
    }
  }

  if (verifierHeaders) {
    for (const h of verifierHeaders) {
      const trimmed = h.trim();
      if (trimmed && !seen.has(trimmed.toLowerCase())) {
        seen.add(trimmed.toLowerCase());
        result.push(trimmed);
      }
    }
  }

  if (customHeaders) {
    for (const h of customHeaders) {
      const trimmed = h.trim();
      if (trimmed && !seen.has(trimmed.toLowerCase())) {
        seen.add(trimmed.toLowerCase());
        result.push(trimmed);
      }
    }
  }

  return result.join(", ");
}

export function matchAllowedOrigin(
  requestOrigin: string | undefined,
  allowedOrigins: readonly string[],
): string | undefined {
  if (allowedOrigins.includes("*")) {
    return "*";
  }
  if (!requestOrigin) {
    return undefined;
  }
  if (requestOrigin === "null") {
    return allowedOrigins.includes("null") ? "null" : undefined;
  }
  for (const allowed of allowedOrigins) {
    if (
      allowed === requestOrigin ||
      allowed.toLowerCase() === requestOrigin.toLowerCase()
    ) {
      return requestOrigin;
    }
  }
  return undefined;
}

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
  const protectedResourceConfig =
    httpOptions.protectedResourceMetadata ??
    httpOptions.protectedResource ??
    httpOptions.resourceMetadata ??
    {};
  const protectedResourceAuthorizationServers = [
    ...(protectedResourceConfig.authorizationServers ?? []),
    ...(httpOptions.authorizationServers ?? []),
  ];
  const protectedResourceScopes = [
    ...(protectedResourceConfig.scopesSupported ?? []),
    ...(httpOptions.scopesSupported ?? []),
  ];
  const requireAuth =
    httpOptions.requireInboundAuth ?? httpOptions.requireAuth ?? false;
  const allowUnauthenticated = httpOptions.allowUnauthenticatedHttp ?? false;
  const verifier = httpOptions.verifier;
  const authorizerType =
    httpOptions.authorizerType ??
    (typeof httpOptions.authorizer === "string"
      ? httpOptions.authorizer
      : undefined);
  const hasScopeAuthorizer =
    authorizerType === "scope" ||
    (typeof httpOptions.authorizer === "object" &&
      httpOptions.authorizer !== null);

  // 1. If inbound auth is required but no verifier is provided, fail fast
  if (requireAuth && !verifier) {
    if (hasScopeAuthorizer) {
      throw new Error(
        'Inbound authorizer is configured as "scope", but no inbound verifier is configured. Scope authorization requires an authenticated principal. Configure tokens, apiKeys, or jwt in "auth.inbound" or supply a verifier.',
      );
    }
    throw new Error(
      'HTTP inbound authentication is required ("security.requireInboundAuth: true"), but no inbound verifier is configured. Configure tokens, apiKeys, or jwt in "auth.inbound" or supply a verifier.',
    );
  }

  // 2. If scope authorizer is configured but no verifier exists, fail fast
  if (hasScopeAuthorizer && !verifier) {
    throw new Error(
      'Inbound authorizer is configured as "scope", but no inbound verifier is configured. Scope authorization requires an authenticated principal. Configure tokens, apiKeys, or jwt in "auth.inbound" or supply a verifier.',
    );
  }

  // 3. If bound to a non-loopback host without authentication, fail closed unless explicitly allowed
  const loopback = isLoopbackHost(host);
  const isAuthConfigured = Boolean(requireAuth && verifier);

  if (!loopback && !isAuthConfigured && !allowUnauthenticated) {
    throw new Error(
      `Refusing to bind HTTP server to non-loopback host "${host}" without authentication. Set "security.requireInboundAuth: true" with a configured verifier, or set "security.allowUnauthenticatedHttp: true" to explicitly allow unauthenticated HTTP access.`,
    );
  }

  // 4. Resolve CORS configuration
  let corsEnabled: boolean;
  let corsAllowedOrigins: string[] = [];
  let corsAllowedHeaders: string[] = [];
  let corsAllowCredentials = false;
  let corsMaxAgeSeconds = 600;

  if (typeof httpOptions.cors === "boolean") {
    corsEnabled = httpOptions.cors;
    if (corsEnabled) {
      if (httpOptions.allowedOrigins && httpOptions.allowedOrigins.length > 0) {
        corsAllowedOrigins = [...httpOptions.allowedOrigins];
      } else if (httpOptions.cors === true) {
        // Explicit true with no origins -> disabled for safety
        corsEnabled = false;
        corsAllowedOrigins = [];
      }
    }
  } else if (httpOptions.cors && typeof httpOptions.cors === "object") {
    corsAllowedOrigins = [
      ...(httpOptions.cors.allowedOrigins ?? httpOptions.allowedOrigins ?? []),
    ];
    corsAllowedHeaders = [...(httpOptions.cors.allowedHeaders ?? [])];
    corsAllowCredentials = httpOptions.cors.allowCredentials ?? false;
    corsMaxAgeSeconds = httpOptions.cors.maxAgeSeconds ?? 600;

    if (httpOptions.cors.enabled !== undefined) {
      corsEnabled = httpOptions.cors.enabled;
    } else {
      if (corsAllowedOrigins.length > 0) {
        corsEnabled = true;
      } else {
        corsEnabled = false;
      }
    }
  } else {
    // cors is undefined
    if (httpOptions.allowedOrigins && httpOptions.allowedOrigins.length > 0) {
      corsEnabled = true;
      corsAllowedOrigins = [...httpOptions.allowedOrigins];
    } else {
      corsEnabled = false;
      corsAllowedOrigins = [];
    }
  }

  // Reject wildcard origin * when allowCredentials is true
  if (corsEnabled && corsAllowedOrigins.includes("*") && corsAllowCredentials) {
    throw new Error(
      "Wildcard origin ('*') cannot be used when allowCredentials is true",
    );
  }

  // Warning when CORS wildcard is active on loopback or otherwise
  if (corsEnabled && corsAllowedOrigins.includes("*")) {
    const corsWarningMessage = `[SECURITY WARNING] CORS is enabled with wildcard origin ('*'). Browsers from any website may connect. Configure "server.cors.allowedOrigins" with explicit origins or set "server.cors.enabled: false" for production deployments.`;
    if (httpOptions.warn) {
      httpOptions.warn(corsWarningMessage, {
        event: "cors_wildcard_warning",
        host,
        port,
        path: mcpPath,
        configKey: "server.cors.allowedOrigins",
      });
    } else if (httpOptions.logger?.warn) {
      httpOptions.logger.warn(corsWarningMessage, {
        event: "cors_wildcard_warning",
        host,
        port,
        path: mcpPath,
        configKey: "server.cors.allowedOrigins",
      });
    } else {
      console.warn(corsWarningMessage);
    }
  }

  const allowedHeadersString = computeAllowedHeaders(
    verifier?.headerNames,
    corsAllowedHeaders,
  );

  const handleProcessSignals = httpOptions.handleProcessSignals ?? true;
  const maxRequestBytes =
    httpOptions.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;
  const requestTimeoutMs =
    httpOptions.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const shutdownTimeoutMs =
    httpOptions.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;

  const hasExplicitAllowedHosts =
    httpOptions.allowedHosts !== undefined &&
    httpOptions.allowedHosts.length > 0;
  const allCandidateOrigins = [
    ...(httpOptions.allowedOrigins ?? []),
    ...corsAllowedOrigins,
  ];
  const hasExplicitAllowedOrigins = allCandidateOrigins.length > 0;
  const enableHostProtection = Boolean(
    httpOptions.enableDnsRebindingProtection || hasExplicitAllowedHosts,
  );
  // Origin validation is always on: browser requests carry an Origin header,
  // and an origin outside the effective allowlist must not reach tools even
  // when CORS response headers are disabled. Requests without Origin (CLI
  // clients, the Inspector CLI) remain unaffected.
  const enableOriginDnsProtection = true;
  const enableDnsRebinding =
    httpOptions.enableDnsRebindingProtection ??
    (hasExplicitAllowedHosts || hasExplicitAllowedOrigins);

  const effectiveAllowedHosts = deriveAllowedHosts(
    host,
    httpOptions.allowedHosts,
  );
  const effectiveAllowedOrigins = deriveAllowedOrigins(
    host,
    hasExplicitAllowedOrigins ? allCandidateOrigins : undefined,
  );

  // Resolve tool count for warning & posture
  let toolCount = httpOptions.toolCount;
  if (toolCount === undefined) {
    try {
      toolCount = runtime.listTools().length;
    } catch {
      toolCount = 0;
    }
  }

  // Emit structured startup warning when listening unauthenticated
  if (!isAuthConfigured) {
    const warningMessage = `[SECURITY WARNING] HTTP server listening unauthenticated on http://${host}:${port}${mcpPath} (${toolCount} tool(s) exposed). Non-loopback binds and production environments must enforce authentication. Set "security.requireInboundAuth: true" and configure tokens, apiKeys, or jwt in "auth.inbound" to secure this server.`;
    if (httpOptions.warn) {
      httpOptions.warn(warningMessage, {
        event: "unauthenticated_http_startup",
        host,
        port,
        path: mcpPath,
        toolCount,
        configKey: "security.requireInboundAuth",
      });
    } else if (httpOptions.logger?.warn) {
      httpOptions.logger.warn(warningMessage, {
        event: "unauthenticated_http_startup",
        host,
        port,
        path: mcpPath,
        toolCount,
        configKey: "security.requireInboundAuth",
      });
    } else {
      console.warn(warningMessage);
    }
  }

  // Log resolved security posture once at startup
  const postureMeta = {
    event: "security_posture",
    inboundAuth: isAuthConfigured,
    tenantMode: runtime.tenantMode ?? "single-tenant",
    allowedHosts: effectiveAllowedHosts,
    allowedOrigins: effectiveAllowedOrigins,
    enableDnsRebindingProtection: enableDnsRebinding,
    cors: {
      enabled: corsEnabled,
      allowedOrigins: corsAllowedOrigins,
      allowCredentials: corsAllowCredentials,
    },
    host,
    port,
    path: mcpPath,
  };
  const postureMessage = `[SECURITY] HTTP security posture: inboundAuth=${isAuthConfigured ? "enabled" : "disabled"}, tenantMode=${postureMeta.tenantMode}, allowedHosts=[${effectiveAllowedHosts.join(", ")}], allowedOrigins=[${effectiveAllowedOrigins.join(", ")}], enableDnsRebindingProtection=${enableDnsRebinding}, cors=${corsEnabled ? `enabled (${corsAllowedOrigins.join(", ") || "none"})` : "disabled"}`;

  if (httpOptions.info) {
    httpOptions.info(postureMessage, postureMeta);
  } else if (httpOptions.logger?.info) {
    httpOptions.logger.info(postureMessage, postureMeta);
  }

  const server = createMcpServer(runtime, options);
  const mcpHandler = createMcpHandler(() => server, {
    maxRequestBodySize: maxRequestBytes,
  });

  let notifyClosed: (() => void) | undefined;
  const closed = new Promise<void>((resolve) => {
    notifyClosed = resolve;
  });

  let isShuttingDown = false;
  const activeRequests = new Set<AbortController>();
  const shutdownAbortController = new AbortController();
  let drainWaiter: (() => void) | undefined;

  const completeRequest = (controller: AbortController): void => {
    if (!activeRequests.delete(controller)) return;
    if (activeRequests.size === 0) {
      const waiter = drainWaiter;
      drainWaiter = undefined;
      waiter?.();
    }
  };

  const waitForDrain = (timeoutMs: number): Promise<boolean> => {
    if (activeRequests.size === 0) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        drainWaiter = undefined;
        resolve(false);
      }, timeoutMs);
      // A pending drain timer alone must not keep the process alive.
      timer.unref?.();
      drainWaiter = () => {
        clearTimeout(timer);
        resolve(true);
      };
    });
  };

  const httpServer = http.createServer(async (req, res) => {
    // Request timeout protection: abort socket if read takes longer than requestTimeoutMs
    req.on("error", () => {});
    if (isShuttingDown) {
      if (!res.headersSent) {
        res.statusCode = 503;
        res.setHeader("Connection", "close");
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: {
              code: -32000,
              message: "Service Unavailable: server is shutting down",
            },
            id: null,
          }),
        );
      }
      return;
    }

    // Track work-bearing requests for the drain phase and cancel cooperative
    // work when the client disconnects before its response is complete. GET
    // and HEAD are long-lived SSE/probe streams (or health checks), not calls,
    // so they never extend the drain budget.
    const trackForDrain = req.method === "POST" || req.method === "DELETE";
    const requestController = new AbortController();
    if (trackForDrain) activeRequests.add(requestController);
    res.once("close", () => {
      requestController.abort(new Error("HTTP connection closed"));
      if (trackForDrain) completeRequest(requestController);
    });

    req.setTimeout(requestTimeoutMs, () => {
      if (!res.headersSent) {
        res.statusCode = 408;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: {
              code: -32000,
              message:
                "Request Timeout: client took too long to complete request",
            },
            id: null,
          }),
        );
      }
      req.destroy();
    });

    const clearTimeoutHandler = () => {
      try {
        if (req.socket && !req.socket.destroyed) {
          req.setTimeout(0);
        }
      } catch {
        // Socket may already be destroyed
      }
    };
    res.on("finish", clearTimeoutHandler);
    res.on("close", clearTimeoutHandler);

    try {
      // 1. Validate Host header presence (HTTP/1.1 requirement)
      const rawHost = req.headers.host;
      if (!rawHost || typeof rawHost !== "string" || !rawHost.trim()) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: {
              code: -32600,
              message: "Bad Request: Missing Host header",
            },
            id: null,
          }),
        );
        return;
      }

      // 2. Validate Host header format
      let requestHostname: string;
      try {
        const parsedHostUrl = new URL(`http://${rawHost.trim()}`);
        requestHostname = parsedHostUrl.hostname.toLowerCase();
        if (!requestHostname) {
          throw new Error("Empty hostname");
        }
      } catch {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: {
              code: -32600,
              message: "Bad Request: Malformed Host header",
            },
            id: null,
          }),
        );
        return;
      }

      // 3. DNS rebinding / Host allowlist validation
      if (
        enableHostProtection &&
        !effectiveAllowedHosts.includes(requestHostname)
      ) {
        res.statusCode = 403;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: {
              code: -32000,
              message: "Forbidden: Host not allowed",
            },
            id: null,
          }),
        );
        return;
      }

      const requestUrl = new URL(req.url ?? "/", `http://${rawHost.trim()}`);

      // CORS Preflight & Headers
      if (corsEnabled) {
        res.setHeader("Vary", "Origin");

        const rawOrigin = req.headers.origin;
        const requestOrigin = (
          Array.isArray(rawOrigin) ? rawOrigin[0] : rawOrigin
        )?.trim();

        const matchedOrigin = matchAllowedOrigin(
          requestOrigin,
          corsAllowedOrigins,
        );

        if (req.method === "OPTIONS") {
          if (matchedOrigin !== undefined) {
            res.setHeader("Access-Control-Allow-Origin", matchedOrigin);
            if (corsAllowCredentials) {
              res.setHeader("Access-Control-Allow-Credentials", "true");
            }
            res.setHeader(
              "Access-Control-Allow-Methods",
              "GET, POST, OPTIONS, DELETE",
            );
            res.setHeader("Access-Control-Allow-Headers", allowedHeadersString);
            res.setHeader(
              "Access-Control-Expose-Headers",
              "Content-Type, mcp-session-id",
            );
            res.setHeader("Access-Control-Max-Age", String(corsMaxAgeSeconds));
            res.statusCode = 204;
            res.end();
            return;
          } else {
            // Disallowed origin on preflight request -> 403
            res.statusCode = 403;
            res.setHeader("Content-Type", "application/json");
            res.end(
              JSON.stringify({
                jsonrpc: "2.0",
                error: {
                  code: -32000,
                  message: "Forbidden: CORS origin not allowed",
                },
                id: null,
              }),
            );
            return;
          }
        }

        // Non-OPTIONS requests: attach CORS headers if origin is allowed
        if (matchedOrigin !== undefined) {
          res.setHeader("Access-Control-Allow-Origin", matchedOrigin);
          if (corsAllowCredentials) {
            res.setHeader("Access-Control-Allow-Credentials", "true");
          }
          res.setHeader(
            "Access-Control-Expose-Headers",
            "Content-Type, mcp-session-id",
          );
        }
      }

      // 4b. Origin allowlist validation (after CORS preflight so CORS-specific
      // rejections keep their message; runs even when CORS is disabled).
      if (enableOriginDnsProtection && req.headers.origin) {
        // Origin-keyed responses must not be cached across origins, including
        // the 403 rejection when CORS is active.
        if (corsEnabled) res.setHeader("Vary", "Origin");
        const rawOrigin = req.headers.origin;
        const originStr = (
          Array.isArray(rawOrigin) ? rawOrigin[0] : rawOrigin
        )?.trim();
        if (originStr) {
          if (originStr === "null") {
            if (
              !effectiveAllowedOrigins.includes("null") &&
              !effectiveAllowedOrigins.includes("*")
            ) {
              res.statusCode = 403;
              res.setHeader("Content-Type", "application/json");
              res.end(
                JSON.stringify({
                  jsonrpc: "2.0",
                  error: {
                    code: -32000,
                    message: "Forbidden: Origin not allowed",
                  },
                  id: null,
                }),
              );
              return;
            }
          } else if (effectiveAllowedOrigins.includes("*")) {
            // Wildcard allowed
          } else {
            let originHostname: string;
            try {
              const originUrl = new URL(originStr);
              originHostname = originUrl.hostname.toLowerCase();
              if (!originHostname) {
                throw new Error("Empty origin hostname");
              }
            } catch {
              res.statusCode = 403;
              res.setHeader("Content-Type", "application/json");
              res.end(
                JSON.stringify({
                  jsonrpc: "2.0",
                  error: {
                    code: -32000,
                    message: "Forbidden: Origin not allowed",
                  },
                  id: null,
                }),
              );
              return;
            }

            if (!effectiveAllowedOrigins.includes(originHostname)) {
              res.statusCode = 403;
              res.setHeader("Content-Type", "application/json");
              res.end(
                JSON.stringify({
                  jsonrpc: "2.0",
                  error: {
                    code: -32000,
                    message: "Forbidden: Origin not allowed",
                  },
                  id: null,
                }),
              );
              return;
            }
          }
        }
      }

      // OAuth protected-resource metadata (RFC 9728): advertised so remote MCP
      // clients can discover the authorization server protecting this resource.
      if (
        requestUrl.pathname === "/.well-known/oauth-protected-resource" ||
        requestUrl.pathname.startsWith("/.well-known/oauth-protected-resource/")
      ) {
        const resourceUrl =
          protectedResourceConfig.resource ?? `${requestUrl.origin}${mcpPath}`;
        const metadata = {
          resource: resourceUrl,
          authorization_servers: protectedResourceAuthorizationServers,
          scopes_supported: protectedResourceScopes,
          bearer_methods_supported:
            protectedResourceConfig.bearerMethodsSupported ?? ["header"],
          ...(protectedResourceConfig.resourceName !== undefined
            ? { resource_name: protectedResourceConfig.resourceName }
            : {}),
        };
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(metadata));
        return;
      }

      // Health and liveness probe (liveness-only: never touches dependencies)
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

      // Readiness probe: dependency reachability, following the configured
      // failure policy. A failed check with `degradedReady: true` (e.g. a
      // rate limiter configured `fail-open`) keeps the server ready; a
      // failed check without it (e.g. `fail-closed`) returns 503. Error
      // details are never mirrored — only pass/fail per dependency.
      if (requestUrl.pathname === "/readyz") {
        const deps: Array<{ name: string; ok: boolean; degraded?: boolean }> =
          [];
        for (const dep of httpOptions.readiness?.deps ?? []) {
          let ok = false;
          try {
            ok = (await dep.check()) === true;
          } catch {
            ok = false;
          }
          deps.push({
            name: dep.name,
            ok,
            ...(dep.degradedReady ? { degraded: true } : {}),
          });
        }
        const notReady = deps.some((d) => !d.ok && !d.degraded);
        const degraded = deps.some((d) => !d.ok && d.degraded);
        const payload: Record<string, unknown> = {
          status: notReady ? "not_ready" : degraded ? "degraded" : "ready",
          name: options.name,
          version: options.version,
        };
        if (deps.length > 0) payload.deps = deps;
        res.statusCode = notReady ? 503 : 200;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(payload));
        return;
      }

      // OTLP Ingestion Sink (/v1/traces, /v1/metrics)
      if (
        httpOptions.otlpHandler &&
        (requestUrl.pathname === "/v1/traces" ||
          requestUrl.pathname === "/v1/metrics")
      ) {
        try {
          const handled = await httpOptions.otlpHandler(req, res);
          if (handled) {
            return;
          }
        } catch {
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "Internal Server Error" }));
          return;
        }
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
      let authResult: InboundAuthOutcome | undefined;
      if (httpOptions.verifier) {
        authResult = await httpOptions.verifier.verify({
          headers: req.headers,
          url: requestUrl,
          method: req.method,
        });
      }

      // A verified credential that cannot establish tenant context fails closed
      // with a stable code, even when inbound auth is otherwise optional.
      if (isInboundAuthFailure(authResult)) {
        res.statusCode = 401;
        res.setHeader(
          "WWW-Authenticate",
          `Bearer resource_metadata="${requestUrl.origin}/.well-known/oauth-protected-resource", error="invalid_token"`,
        );
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: {
              code: -32001,
              message: `Unauthorized: ${authResult.message}`,
              data: { code: authResult.code },
            },
            id: null,
          }),
        );
        return;
      }

      if (requireAuth && !authResult) {
        res.statusCode = 401;
        res.setHeader(
          "WWW-Authenticate",
          `Bearer resource_metadata="${requestUrl.origin}/.well-known/oauth-protected-resource", error="invalid_token"`,
        );
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

      // Read incoming body for non-GET/HEAD methods with byte limit enforcement
      let body: Buffer | undefined;
      if (req.method !== "GET" && req.method !== "HEAD") {
        // Fast-path: Check declared Content-Length before buffering
        const contentLengthHeader = req.headers["content-length"];
        if (contentLengthHeader !== undefined) {
          const contentLength = Number.parseInt(
            Array.isArray(contentLengthHeader)
              ? contentLengthHeader[0]!
              : contentLengthHeader,
            10,
          );
          if (!Number.isNaN(contentLength) && contentLength > maxRequestBytes) {
            res.statusCode = 413;
            res.setHeader("Content-Type", "application/json");
            res.end(
              JSON.stringify({
                jsonrpc: "2.0",
                error: {
                  code: -32000,
                  message:
                    "Payload Too Large: request body exceeds maximum allowed size",
                },
                id: null,
              }),
            );
            req.destroy();
            return;
          }
        }

        // Streaming read: enforce cap while reading chunks
        const chunks: Buffer[] = [];
        let totalBytes = 0;
        let exceeded = false;

        for await (const chunk of req) {
          const bufferChunk = Buffer.isBuffer(chunk)
            ? chunk
            : Buffer.from(chunk as Uint8Array);
          totalBytes += bufferChunk.byteLength;
          if (totalBytes > maxRequestBytes) {
            exceeded = true;
            break;
          }
          chunks.push(bufferChunk);
        }

        if (exceeded) {
          res.statusCode = 413;
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              error: {
                code: -32000,
                message:
                  "Payload Too Large: request body exceeds maximum allowed size",
              },
              id: null,
            }),
          );
          req.destroy();
          return;
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
        signal: AbortSignal.any([
          shutdownAbortController.signal,
          requestController.signal,
        ]),
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

  httpServer.requestTimeout = requestTimeoutMs;

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
      // 1. Stop accepting new work. The listener stays bound while draining so
      // requests that arrive late receive a 503 rejection instead of a
      // connection reset; it is closed once the drain window ends.
      isShuttingDown = true;

      // 2. Drain work-bearing requests up to the configured budget. A request
      // is in flight from acceptance until its response closes.
      if (shutdownTimeoutMs > 0) {
        await waitForDrain(shutdownTimeoutMs);
      }

      // 3. Cancel what did not drain. Aborting the shutdown signal propagates
      // through the MCP request signal to cooperative tool executions.
      shutdownAbortController.abort(new Error("Server is shutting down"));

      // 4. Stop listening, then force-close everything left: idle keep-alives
      // first, then active sockets that ignored cooperative cancellation.
      const httpClosed = new Promise<void>((resolve) => {
        if (!httpServer.listening) {
          resolve();
          return;
        }
        httpServer.close(() => resolve());
      });
      if (typeof httpServer.closeIdleConnections === "function") {
        httpServer.closeIdleConnections();
      }
      if (typeof httpServer.closeAllConnections === "function") {
        httpServer.closeAllConnections();
      }
      await httpClosed;

      // 5. Tear down the protocol adapter and release runtime-owned resources
      // exactly once, after the last request has stopped using them.
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
      try {
        await runtime.close?.();
      } catch {
        // Ignored: resource teardown failures must not change the exit code.
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
  // The first signal wins. Repeated or mixed SIGINT/SIGTERM deliveries share
  // the same shutdown promise and never change the documented exit code.
  let signalHandled = false;
  const handleSignal = (exitCode: number): void => {
    if (signalHandled) return;
    signalHandled = true;
    process.exitCode = exitCode;
    void close().catch(() => {});
  };
  const onSigint = () => handleSignal(130);
  const onSigterm = () => handleSignal(143);

  const cleanup = () => {
    httpOptions.signal?.removeEventListener("abort", onAbort);
    if (handleProcessSignals) {
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGTERM", onSigterm);
    }
  };

  if (httpOptions.signal?.aborted) {
    onAbort();
  } else {
    httpOptions.signal?.addEventListener("abort", onAbort, { once: true });
  }

  if (handleProcessSignals) {
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);
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

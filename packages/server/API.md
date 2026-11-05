# API Reference: @chainmcp/server

## `@chainmcp/server`

`createMcpServer(runtime, options)` adapts the shared `ToolRuntime` to the
official TypeScript MCP SDK. Runtime tool names, descriptions, and supported
input schemas are exposed through `tools/list`; calls go through
`ToolRuntime.callTool`, preserving runtime authorization, input validation,
rate limiting, cancellation, and telemetry behavior. Listing mode follows the
runtime's tenancy mode (ADR 0008):

- **Single-tenant runtimes** (any runtime declaring `tenantMode: "single-tenant"`) are snapshot-adapted: tools are
  enumerated once at `createMcpServer` and registered with the SDK as tool
  callbacks. New registrations after creation are not observed.
- **Multi-tenant runtimes** (any runtime declaring `tenantMode: "multi-tenant"`,
  including `InMemoryToolRuntime` in that mode) are adapted with low-level
  per-request `tools/list` and `tools/call` handlers. The adapter dispatches on
  the interface declaration rather than on the runtime's concrete class.
  The `tools` capability is declared with `listChanged: false`. Each
  `tools/list` request establishes the caller identity through `createContext`
  and lists only the caller's tenant's tools against the same tenant-scoped
  registry that `callTool` resolves against, so discovery and invocation
  cannot disagree and per-call authorization still runs on every invocation. A
  listing whose identity cannot be established fails closed with a safe
  protocol error and does not reveal tool names. Result serialization, byte
  caps, and safe error mapping are implemented once and shared by both modes.
  Protocol pagination is implemented for both modes through
  `toolsPageSize` (default `100`; `0` disables pagination). Pages are ordered by
  tool name, and `nextCursor` is opaque and bound to the revision of the exact
  listing that produced it, so a cursor from a different tenant or from before
  the tool set changed is rejected with `STALE_CURSOR` instead of silently
  returning a shifted page. A malformed cursor returns the same stable error.

MCP tools require a non-null object-root input schema (`type: "object"`).
`createMcpServer` rejects a runtime tool with a schema outside the
core-supported subset or without that exact root type instead of exposing a
schema the MCP protocol cannot represent.

`McpServerOptions` requires `name`, `version`, and `createContext`. Its
`toolsPageSize` option controls `tools/list` pagination as described above; a
negative or non-integer value is rejected at construction. Its
`createContext(request)` factory receives the SDK request ID, cancellation
signal, and optional HTTP `authInfo`. It is trusted adapter code and must
establish a tenant and principal; values are never accepted from MCP tool
arguments. The MCP request signal is combined with any signal supplied by the
factory. Factory failures fail closed: an untyped failure is classified as
`AUTH_FORBIDDEN`, a typed `RuntimeError` keeps its code, and both produce a
runtime metrics event with `tenantId: "unknown"` because tenant identity is
not yet available.
Tool results are serialized into a text content block using streaming bounded serialization (`stringifyBounded`) capped at a 1 MB UTF-8 byte limit by default (`maxResponseBytes`). Serialization aborts immediately upon exceeding `maxResponseBytes`, recursion depth, or node count limits without buffering the full string or evaluating subsequent properties. `maxResponseBytes` may be configured up to 100 MB; values outside that range are rejected at construction. `docs/getting-started.md` shows a
compiled stdio server, and `pnpm conformance:inspector` runs the Inspector CLI
against `tools/list` and `tools/call`. Runtime errors are returned as
`isError: true` results containing only the stable code and adapter-selected
generic message; executor-provided messages and causes are never returned.
`RATE_LIMITED` additionally renders `RuntimeError.retryAfterSeconds` when it is
a whole number of seconds between 1 and 86,400, as
`RATE_LIMITED: Rate limit exceeded. Retry after N seconds`; no other detail
from the limiter is exposed. Unexpected failures use a generic message. No
credentials or causes are returned to clients.

`connectMcpServer(runtime, transport, options)` connects a server to an SDK
transport and returns an idempotent `close()` handle plus a `closed` promise
that resolves when the transport closes. Concurrent `close()` callers await
the same shutdown. `McpServerOptions.onclose` is called when the SDK reports
transport closure; observer exceptions are isolated from teardown.

`serveStdio(runtime, options, stdioOptions)` uses local stdio and closes on
stdin EOF, an optional `AbortSignal`, SIGINT, or SIGTERM. Signal handlers are
removed at closure; SIGINT and SIGTERM set conventional exit codes 130 and 143.
For embedded use and tests, stdin and stdout streams can be injected and
process signal handling can be disabled.

`serveHttp(runtime, options, httpOptions)` starts an HTTP server supporting modern
Streamable HTTP and SSE transports for Model Context Protocol clients.

`HttpServeOptions`:

- `port` (`number`, optional; default `3333`): Port to listen on (use `0` for ephemeral port assignment).
- `host` (`string`, optional; default `"127.0.0.1"`): Host interface to bind to.
- `path` (`string`, optional; default `"/mcp"`): Base path for the MCP endpoint.
- `signal` (`AbortSignal`, optional): Cancellation signal to trigger graceful server shutdown.
- `verifier` (`InboundAuthVerifier`, optional): Inbound verifier to parse and validate caller identity.
- `requireAuth` / `requireInboundAuth` (`boolean`, optional; default `false`): Whether requests must present valid inbound credentials. If `true` and no verifier is provided, startup fails fast.
- `allowUnauthenticatedHttp` (`boolean`, optional; default `false`): Explicitly allows unauthenticated HTTP binding on non-loopback network interfaces. When `false` (the default), binding to a non-loopback host (e.g. `0.0.0.0`, external IPs) without an authenticated verifier fails fast at startup.
- `authorizer` / `authorizerType` (`Authorizer | "scope" | "none"`, optional): Declares the inbound authorizer. If set to `"scope"` without a configured inbound verifier, startup fails fast.
- `toolCount` (`number`, optional): Total count of registered tools reported in unauthenticated startup warnings.
- `warn` (`(message: string, meta?: Record<string, unknown>) => void`, optional): Custom warning handler invoked when starting unauthenticated.
- `info` (`(message: string, meta?: Record<string, unknown>) => void`, optional): Custom info handler invoked to log resolved security posture at startup.
- `cors` (`boolean | HttpCorsOptions`, optional): Whether to enable CORS headers and preflight handling, or explicit CORS options. CORS is disabled by default on every bind host; configure explicit `allowedOrigins` (or top-level `allowedOrigins`) to enable it. `cors: true` without origins remains disabled. A wildcard `"*"` is only honoured when explicitly configured and always emits a startup warning.
- `maxRequestBytes` (`number`, optional; default `1048576` = 1 MiB): Hard cap in bytes on incoming request bodies, enforced before buffering and during chunked streaming (rejects with 413 Payload Too Large).
- `allowedHosts` (`string[]`, optional): Allowed Host header hostnames for DNS rebinding protection. Malformed or missing Host headers are rejected with 400 Bad Request; unlisted hosts are rejected with 403 Forbidden.
- `allowedOrigins` (`string[]`, optional): Allowed Origin header hostnames for browser and DNS rebinding protection. Unlisted origins are rejected with 403 Forbidden when protection is enabled.
- `enableDnsRebindingProtection` (`boolean`, optional; default `false`): Enables strict Host and Origin allowlist validation.
- `requestTimeoutMs` (`number`, optional; default `15000`): Request timeout in milliseconds applied to the HTTP server and incoming body reads.
- `shutdownTimeoutMs` (`number`, optional; default `10000`): Drain budget in milliseconds. `0` skips the drain and force-closes immediately.
- `handleProcessSignals` (`boolean`, optional; default `true`): Installs SIGINT/SIGTERM handlers and sets standard process exit codes.
- `readiness` (`{ deps?: Array<{ name: string; check: () => boolean | Promise<boolean>; degradedReady?: boolean }> }`, optional): Dependency checks served by `GET /readyz`. With no `deps`, `/readyz` returns ready with no dependency detail. Each check is run with its error details swallowed, so a failure never leaks internal state (e.g. Redis URLs) into the response. A failed check with `degradedReady: true` (the `fail-open` case) keeps the probe at `200 {"status":"degraded"}`; a failed check without it (the `fail-closed` case) returns `503 {"status":"not_ready"}`. Probes are bounded by a short timeout in the builder. When the CLI wires `buildReadinessDeps`, the rate limiter probes `eval("return 1")` and the cache store probes a read of an absent key — both prove liveness without writing.

**Probes.** `GET /health` and `GET /livez` are liveness-only and never evaluate `readiness.deps`; point orchestrator liveness at one of them and readiness at `/readyz`.

Shutdown is drain-then-cancel. `close()` is idempotent and concurrent callers await the same promise. It marks the server as shutting down, answers every request that arrives during the window with `503` and `Connection: close` (the listener stays bound so late requests receive a rejection rather than a connection reset), and waits up to `shutdownTimeoutMs` for work-bearing `POST`/`DELETE` requests to finish. `GET`/`HEAD` streams such as SSE and health probes never extend the drain budget. When the budget expires, the shutdown `AbortSignal` is aborted, which propagates through the MCP request signal to cooperative tool executions as `CANCELLED`. The listener is then closed, idle and remaining connections are force-closed, `mcpHandler.close()` and the MCP server are torn down, and `runtime.close?.()` runs once to flush analytics and drain runtime-owned clients. A tool that ignores its signal is abandoned rather than forcibly terminated; its socket is closed and its process handles determine whether the process can exit. SIGINT and SIGTERM are idempotent: the first delivery sets exit code `130` or `143` and starts the same shutdown, and repeated or mixed signals do not change the code or run teardown twice.

`HttpCorsOptions`:

- `enabled` (`boolean`, optional): Explicitly toggles CORS headers and preflight handling. Defaults to `false`; setting `true` without `allowedOrigins` still leaves CORS disabled.
- `allowedOrigins` (`string[]`, optional): Exact origins permitted to make cross-origin requests. Wildcard `"*"` is supported for uncredentialed access, but rejected at startup if combined with `allowCredentials: true`. Sandboxed `"null"` origin is rejected unless explicitly listed in `allowedOrigins`.
- `allowedHeaders` (`string[]`, optional): Extra headers permitted in cross-origin requests, appended to standard defaults (`Content-Type`, `Authorization`, `X-API-Key`, `Accept`, `mcp-session-id`, `last-event-id`) and inbound verifier header names (`verifier.headerNames`).
- `allowCredentials` (`boolean`, optional; default `false`): Enables `Access-Control-Allow-Credentials: true` when origin matches. Never permitted with wildcard origin `"*"`.
- `maxAgeSeconds` (`number`, optional; default `600`): Preflight cache duration in seconds (`Access-Control-Max-Age`).

`InboundAuthVerifier`:

```typescript
export interface InboundAuthVerifier {
  readonly headerNames?: readonly string[] | undefined;
  verify(
    request: InboundAuthRequest,
  ): Promise<InboundAuthOutcome | undefined> | InboundAuthOutcome | undefined;
}

export interface InboundAuthResult {
  context: ToolContext;
  authInfo?: AuthInfo | undefined;
}

export interface InboundAuthFailure {
  readonly failure: true;
  readonly code: "TENANT_REQUIRED";
  readonly message: string;
}

export type InboundAuthOutcome = InboundAuthResult | InboundAuthFailure;
```

`undefined` remains the generic unauthenticated result (missing, invalid, or expired credential). A credential that verifies but cannot establish tenant context returns `InboundAuthFailure`; narrow both cases with `isInboundAuthFailure(outcome)` before reading `context`. This widens the return type for callers, while custom verifier implementations returning `InboundAuthResult | undefined` remain assignable.

`serveHttp` answers an `InboundAuthFailure` with `401`, `WWW-Authenticate: Bearer error="invalid_token"`, and a JSON-RPC error carrying `data: { code: "TENANT_REQUIRED" }`. It does so even when `requireAuth` is `false`, so a verified token never downgrades to an anonymous caller.

Browser-origin validation is independent of CORS header emission and always on. A request carrying an `Origin` header must match the effective allowlist (explicit `allowedOrigins` anywhere in the options, or the bind-host-derived hostnames such as `localhost`/`127.0.0.1`/`[::1]`); otherwise it receives `403` with a JSON-RPC error before any tool runs. Requests without `Origin` (CLI clients and the Inspector CLI) are unaffected. CORS-disabled responses carry no `Access-Control-Allow-Origin`. Explicit `allowedOrigins: ["*"]` allows any origin and emits the startup warning even on loopback; to use the Inspector UI, add its origin (default `http://localhost:6274`) to `allowedOrigins`.

`createJwtVerifier(options)` additions:

- `tenantClaim` (`string`, optional): explicit claim carrying the tenant id. When set, the implicit `tenantId` and `tid` claims are ignored.
- `fallbackTenantId` (`string`, optional): tenant used only when the token has no tenant claim. Blank values throw `TypeError` at construction.
- `requireExplicitClaimMapping` (`boolean`, optional): construction throws `TypeError` unless `mapClaims`, `tenantClaim`, or `fallbackTenantId` supplies tenant identity, and implicit claims are never read.

`createInboundVerifier(options, settings?)` accepts `{ multiTenant?: boolean; fallbackTenantId?: string }`. `fallbackTenantId` is passed to JWT verification, and `multiTenant: true` sets `requireExplicitClaimMapping` so a multi-tenant deployment never guesses a tenant from implicit claims.

Built-in verifiers (`createBearerTokenVerifier`, `createApiKeyVerifier`, `createJwtVerifier`, `createCompositeVerifier`) expose their inspected header names (`headerNames`) so CORS `Access-Control-Allow-Headers` can be dynamically computed without drift.

# API Reference

This document defines the public package contracts for the ChainMcp monorepo. To optimize agent velocity and minimize token consumption, reference documentation is split per package under `packages/*/API.md`.

## Package Index

| Package                         | Purpose                                                                              | Detailed Reference                                                   |
| :------------------------------ | :----------------------------------------------------------------------------------- | :------------------------------------------------------------------- |
| **`@chainmcp/core`**            | Core runtime interfaces (`ToolContext`, `Principal`, `Tokenizer`, cache interfaces). | [`packages/core/API.md`](packages/core/API.md)                       |
| **`@chainmcp/compiler`**        | OpenAPI 3.0/3.1 contract compiler (`compileOpenApi`).                                | [`packages/compiler/API.md`](packages/compiler/API.md)               |
| **`@chainmcp/executor`**        | Upstream HTTP executor and streaming transport.                                      | [`packages/executor/API.md`](packages/executor/API.md)               |
| **`@chainmcp/cache-redis`**     | Distributed Redis cache adapter with versioned keys.                                 | [`packages/cache-redis/API.md`](packages/cache-redis/API.md)         |
| **`@chainmcp/auth`**            | Inbound authentication verifiers and operation scope checks.                         | [`packages/auth/API.md`](packages/auth/API.md)                       |
| **`@chainmcp/rate-limit`**      | Sliding-window and in-memory rate limiting.                                          | [`packages/rate-limit/API.md`](packages/rate-limit/API.md)           |
| **`@chainmcp/json-navigation`** | Bounded JSON navigation and traversal tools.                                         | [`packages/json-navigation/API.md`](packages/json-navigation/API.md) |
| **`@chainmcp/analytics`**       | Structured telemetry, logging, and metrics sinks.                                    | [`packages/analytics/API.md`](packages/analytics/API.md)             |
| **`@chainmcp/config`**          | Configuration loading, schema validation, and secret resolution.                     | [`packages/config/API.md`](packages/config/API.md)                   |
| **`@chainmcp/authoring`**       | Code-first TypeScript MCP tool authoring (`defineTool`).                             | [`packages/authoring/API.md`](packages/authoring/API.md)             |
| **`@chainmcp/declarative`**     | Declarative JSON/YAML HTTP tool descriptors.                                         | [`packages/declarative/API.md`](packages/declarative/API.md)         |
| **`@chainmcp/admin`**           | Self-hosted declarative admin surface and revision stores.                           | [`packages/admin/API.md`](packages/admin/API.md)                     |
| **`@chainmcp/server`**          | Stdio and HTTP SSE transport runtime.                                                | [`packages/server/API.md`](packages/server/API.md)                   |
| **`@chainmcp/cli`**             | Developer CLI commands (`init`, `build`, `serve`, `export`).                         | [`packages/cli/API.md`](packages/cli/API.md)                         |
| **`@chainmcp/gateway`**         | Dynamic multi-tenant runtime gateway (`DynamicGateway`).                             | [`packages/gateway/API.md`](packages/gateway/API.md)                 |

---

## Server Transport & Security Options (`@chainmcp/server`)

When launching HTTP transports via `serveHttp`, the following security configuration is applied:

- `allowUnauthenticatedHttp` (`boolean`, optional; default `false`): Explicitly allows unauthenticated HTTP binding on non-loopback network interfaces. When `false` (the default), binding to a non-loopback host (e.g. `0.0.0.0`, external IPs) without an authenticated verifier fails fast at startup.
- `cors` (`boolean | HttpCorsOptions`, optional): Whether to enable CORS headers and preflight handling, or explicit CORS options. CORS is disabled by default on every bind host; configure explicit `allowedOrigins` (or top-level `allowedOrigins`) to enable it. `cors: true` without origins remains disabled. A wildcard `"*"` is only honoured when explicitly configured and always emits a startup warning.
- `maxRequestBytes` (`number`, optional; default `1048576` = 1 MiB): Hard cap in bytes on incoming request bodies, enforced before buffering and during chunked streaming (rejects with 413 Payload Too Large).
- `allowedHosts` (`string[]`, optional): Allowed Host header hostnames for DNS rebinding protection. Malformed or missing Host headers are rejected with 400 Bad Request; unlisted hosts are rejected with 403 Forbidden.
- `allowedOrigins` (`string[]`, optional): Allowed Origin header hostnames for browser and DNS rebinding protection. Unlisted origins are rejected with 403 Forbidden when protection is enabled.
- `enableDnsRebindingProtection` (`boolean`, optional; default `false`): Enables strict Host and Origin allowlist validation.
- `requestTimeoutMs` (`number`, optional; default `15000`): Request timeout in milliseconds applied to the HTTP server and incoming body reads.

---

## Error Codes

The runtime standardizes error codes across all packages:

- `UNAUTHENTICATED`: Missing or invalid inbound identity.
- `PERMISSION_DENIED`: Inbound principal lacks required scope.
- `RATE_LIMITED`: Request exceeded concurrency or rate limits.
- `UPSTREAM_TIMEOUT`: Upstream service failed to answer within timeout.
- `CANCELLED`: Cooperative cancellation aborted by caller.
- `PAYLOAD_TOO_LARGE`: Request payload exceeded `maxRequestBytes`.
- `INVALID_ARGUMENT`: Tool arguments failed schema validation.

---

## Compatibility

- **Node.js**: >= 20.0.0
- **TypeScript**: Strict ESM mode required across all packages.
- **Model Context Protocol**: MCP SDK v1.x / v2.x compliant.

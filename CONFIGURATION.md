# Configuration

## 1. Principles

- Configuration is versioned and schema-validated.
- Defaults are conservative and documented.
- Secrets are supplied through environment variables or secret providers, not committed files.
- Unknown fields produce clear warnings or errors according to validation mode.
- Per-operation policy cannot weaken mandatory tenant isolation or network security.

## 2. Proposed configuration

```yaml
version: 1
name: catalog-api
tenant: tenant-alpha # Optional tenant ID (defaults to unset)

contract:
  source: ./openapi.yaml
  strict: true
  baseUrl: https://api.example.com/v1

server:
  transport: stdio
  host: 127.0.0.1
  port: 3333
  requestTimeoutMs: 15000
  shutdownTimeoutMs: 10000
  toolsPageSize: 100
  maxResponseBytes: 1000000
  maxRequestBytes: 1048576
  maxMultipartPartBytes: 1048576
  maxToolInputBytes: 1048576
  validateResponses: warn
  allowedHosts:
    - localhost
    - 127.0.0.1
  allowedOrigins:
    - https://app.example.com
  enableDnsRebindingProtection: false
  cors:
    enabled: true
    allowedOrigins:
      - https://app.example.com
    allowedHeaders: []
    allowCredentials: false
    maxAgeSeconds: 600

security:
  requireInboundAuth: false
  allowUnauthenticatedHttp: false
  allowInsecureHttp: false
  allowedUpstreamHosts:
    - api.example.com
  redactHeaders:
    - authorization
    - cookie
    - x-api-key

cache:
  enabled: true
  provider: memory # memory | redis
  ttlSeconds: 300
  maxEntries: 10000
  redis:
    url: redis://127.0.0.1:6379 # or CHAINMCP_REDIS_URL
    keyPrefix: "chainmcp:cache:"
    commandTimeoutMs: 1000

tokenMetrics:
  enabled: true
  tokenizer: approximate # approximate | exact | none
  modelId: cl100k_base
  charactersPerToken: 4
  # module: ./tokenizer.mjs # required for exact unless a factory is registered

projection:
  enabled: true

rateLimit:
  enabled: true
  requestsPerMinute: 60
  concurrency: 10

jsonNavigation:
  enabled: true
  maxDepth: 12
  maxArrayItems: 100
  maxResultBytes: 50000
  handles:
    enabled: true
    ttlMs: 600000

analytics:
  enabled: true
  includeArguments: false
  includeResponseBodies: false
  retentionDays: 14
  openTelemetry:
    enabled: false
    serviceName: chainmcp
    endpoint: http://localhost:4318/v1/traces
    tracing:
      enabled: false
      sampleRatio: 0.1
```

The implemented `@chainmcp/config` package exports `ChainMcpConfigSchema`, `parseConfig`, `safeParseConfig`, `resolveConfigSecrets`, `redactConfigSecrets`, and wiring helpers. The supported sections are `version`, `name`, `contract`, `server`, `security`, `rateLimit`, `auth`, `logging`, `jsonNavigation`, and `analytics`. Unknown keys are rejected with Zod `.strict()`.

- **`tenant`:** (Optional `string`, min length 1; default unset) Declares the tenant ID for the server or gateway deployment. For single-tenant servers, pins the runtime to this tenant ID. For dynamic gateways, provides an explicit fallback tenant for unauthenticated development invocations. If unset and no inbound verifier is present, gateway mode refuses to start. When inbound authentication is active, the authenticated principal's tenant claim takes precedence over this value (`authTenant ?? explicitTenant`).
- **`contract`:** (Optional) Declares the OpenAPI specification file (`contract.source`), compilation mode (`contract.strict`), and target upstream base URL (`contract.baseUrl`). For code-first projects authored with `@chainmcp/authoring`, the `contract` section is omitted.
  - **`contract.baseUrl`:** Absolute `http://` or `https://` base URL preserving origin, port, and path prefix (e.g., `https://api.example.com/v2` or `http://127.0.0.1:8080`). Credentials (`user:pass@`), query parameters (`?`), and fragments (`#`) are strictly rejected. Trailing slashes are canonically normalized. The host from `baseUrl` is automatically derived and added to `security.allowedUpstreamHosts`.
  - **Migration Note:** Configurations that omit `contract.baseUrl` continue to derive their origin from `https://${security.allowedUpstreamHosts[0]}` for backward compatibility, but emit a `CONFIG_DEPRECATED` warning during `chainmcp validate`. Explicit declaration of `contract.baseUrl` is strongly recommended.
- **`server`:** Configures transport (`stdio` or `http`), binding host (`127.0.0.1`), port (`3333`), base path (`/mcp`), `requestTimeoutMs` (default 15,000 ms), `shutdownTimeoutMs` (default 10,000 ms; HTTP graceful-drain budget, `0` skips the drain and force-closes immediately), `toolsPageSize` (default `100`; maximum tools returned per `tools/list` page, `0` disables pagination and returns every tool in one page — pages are ordered by tool name and `nextCursor` is opaque and bound to the current listing revision, so a cursor issued before the tool set changed is rejected with `STALE_CURSOR`), `maxResponseBytes` (default 1,000,000 bytes; aborts JSON serialization mid-traversal if exceeded, failing with `UPSTREAM_FAILURE`), `maxRequestBytes` (default 1,048,576 = 1 MiB for HTTP body payload), `maxMultipartPartBytes` (default 1,048,576 = 1 MiB; maximum size cap for each individual part in a multipart/form-data request body), `maxToolInputBytes` (default 1,048,576 = 1 MiB; caps tool argument size and rejects oversized inputs with `INPUT_TOO_LARGE` before schema validation), `validateResponses` (`off` | `warn` | `enforce`, default `warn`; validates upstream responses against compiled OpenAPI response schemas, redacting response bodies in logs and error details), `allowedHosts` for DNS rebinding protection, `allowedOrigins` for browser/CORS origin verification, `enableDnsRebindingProtection`, and `cors` configuration (`enabled`, `allowedOrigins`, `allowedHeaders`, `allowCredentials`, `maxAgeSeconds`). CORS accepts boolean shorthand or explicit object and defaults to **off on every bind host**; configure `cors.allowedOrigins` (or top-level `allowedOrigins`) to enable it. `cors: true` without origins stays disabled. Wildcard origin with credentials is rejected at parse time, only exact configured origins are reflected in `Access-Control-Allow-Origin`, and `Vary: Origin` is set whenever CORS is active. Browser-origin validation is always on: a request with an `Origin` outside the effective allowlist is rejected with `403` even when CORS headers are disabled, while requests without `Origin` are unaffected. Explicit wildcard `"*"` emits a startup warning on every bind host.
- **`security.requireInboundAuth`:** (default `false`) Enforces inbound authentication on HTTP requests. When set to `true`, incoming requests must present valid credentials, and an inbound verifier (`auth.inbound.tokens`, `apiKeys`, or `jwt`) must be configured or startup fails fast.
- **`security.allowUnauthenticatedHttp`:** (default `false`) Explicit override required when binding the HTTP server or dynamic gateway to a non-loopback host (e.g. `0.0.0.0`, external IPs) without authentication. If `false` and inbound authentication is not configured, binding to non-loopback hosts fails fast at startup. Unauthenticated startups on loopback (`127.0.0.1`, `localhost`, `::1`) or with `allowUnauthenticatedHttp: true` emit a prominent security warning.
- **`security.allowInsecureHttp`:** (default `false`) Explicit override required to permit unencrypted plain HTTP traffic to upstreams (e.g., local loopback services during development like `http://127.0.0.1:8080`) or to fetch remote OpenAPI contracts over plain HTTP for loopback/private hosts. If `false`, `contract.baseUrl` using `http://` and remote specification loading via `http://` fail closed. CLI commands also accept the `--allow-http` flag for ad-hoc commands (`chainmcp init --spec http://... --allow-http`, `chainmcp validate --allow-http`). Plain HTTP is never permitted for public hosts.
- **`security.allowedUpstreamHosts`:** Strictly validated against schemes, ports, paths, queries, credentials, and wildcards. Automatically normalized to lowercase canonical hostnames. Wired directly into executor options via `buildExecutorOptions`. Extra explicit hosts are preserved alongside the auto-derived host from `contract.baseUrl`.
- **`cache`:** Configures in-memory (`provider: "memory"`, default) or Redis shared caching (`provider: "redis"`).
  - **`provider`:** `"memory"` | `"redis"` (default `"memory"`).
  - **`ttlSeconds`:** (default `300` seconds) Cache entry TTL.
  - **`maxEntries`:** (default `10,000`) Maximum entries for the in-memory cache store.
  - **`redis.url`:** (Optional `string`) Redis connection URL (e.g. `redis://127.0.0.1:6379` or `rediss://127.0.0.1:6380` for TLS). If omitted, falls back to `rateLimit.redis.url` or `CHAINMCP_REDIS_URL`.
  - **`redis.keyPrefix`:** (default `"chainmcp:cache:"`) Key prefix for cache storage.
  - **`redis.commandTimeoutMs`:** (default `1,000` ms) Latency bound for cache operations.
  - **`redis.tls`:** (Optional object) Configures TLS options when connecting over `rediss://` or with custom certificates: `rejectUnauthorized` (boolean, default `true`), `ca` (CA certificate string), `cert` (client certificate string), `key` (client private key string), `servername` (SNI hostname override).
- **`tokenMetrics`:** Configures token measurement for successful tool results.
  - **`enabled`:** (default `false`) Enables measurement. When disabled, events omit `tokenUsage` and `output.maxTokens` cannot be enforced.
  - **`tokenizer`:** `"approximate"` | `"exact"` | `"none"` (default `"approximate"`). `approximate` divides characters by `charactersPerToken` and always reports `measurement: "estimate"`. `exact` requires `module` or a factory registered with `registerTokenizerFactory(modelId, factory)`; missing configuration fails startup with `TOKENIZER_SOURCE_REQUIRED`.
  - **`modelId`:** (default `"cl100k_base"`) Stable tokenizer id recorded on every measurement. It is also the factory registry key, and an exact adapter's own `id` must match it.
  - **`charactersPerToken`:** (default `4`, positive) Character ratio used by `approximate`.
  - **`module`:** (Optional `string`) Module for exact measurement that exports `createTokenizer(config)` (named or default). Relative paths resolve from the directory containing the configuration file. The factory may be async, but `count(text)` must be synchronous and `measurement` must be `"exact"`. Module loading failures use `TOKENIZER_MODULE_INVALID`; invalid adapters use `TOKENIZER_INVALID`. Module configuration with `tokenizer` other than `exact` is rejected at parse time.
- **`rateLimit`:** Configures in-memory (`provider: "memory"`, default) or Redis distributed rate limiting (`provider: "redis"`) with shorthand (`requestsPerMinute`, `concurrency`) or explicit global, tenant, and tool quotas. Wired into runtime options via `createRateLimiterFromConfig`.
  - **`provider`:** `"memory"` | `"redis"` (default `"memory"`).
  - **`failurePolicy`:** `"fail-closed"` | `"fail-open"` (default `"fail-closed"`). Under `"fail-closed"`, Redis connection outages and timeouts block calls with `UPSTREAM_FAILURE`. Under `"fail-open"`, Redis outages log a warning and permit calls to proceed.
  - **`redis.url`:** (Optional `string`) Redis connection URL (e.g. `redis://127.0.0.1:6379` or `rediss://127.0.0.1:6380` for TLS). Supports ACL credentials (`redis://username:password@host:port`), password-only auth (`redis://:password@host:port`), and database index paths (e.g. `/0`, `/1`). If omitted when `provider: "redis"`, falls back to `cache.redis.url` or `CHAINMCP_REDIS_URL`. If neither is configured, startup fails fast naming both keys. When both rate limiting and caching use Redis, `buildRuntimeOptions` shares a single client instance to eliminate duplicate connection sets.
  - **`redis.keyPrefix`:** (default `"chainmcp:ratelimit:"`) Key prefix for sliding-window sorted sets and concurrency locks.
  - **`redis.commandTimeoutMs`:** (default `1,000` ms) Latency bound for Redis commands before timing out and invoking the failure policy.
  - **`redis.tls`:** (Optional object) Configures TLS options: `rejectUnauthorized` (boolean, default `true`), `ca` (CA cert string), `cert` (client cert string), `key` (client key string), `servername` (SNI hostname override).
  - **Connection Pooling & Reconnect (RM-16):** Built-in Redis clients manage a pool of 2–4 sockets with lazy connect, checkout health checks (`PING`), exponential backoff with jitter on reconnects, and graceful pool drain on shutdown.
  - **Startup Health & Credential Redaction:** Startup emits a structured health log recording provider, reachability (`"reachable"` | `"unreachable"` | `"local"`), key prefix, and quota summary. `CHAINMCP_REDIS_URL` may contain sensitive passwords and must never be logged. The client automatically redacts passwords from all error messages, stack traces, and diagnostics.
- **`auth`:** Configures inbound authorization (`authorizer: "scope"`) and upstream credential providers (`static`, `env`, `secretStore`, `oauth`). Wired into executor options via `createUpstreamCredentialProviderFromConfig`.
- **`auth.inbound.jwt`:** Verifies inbound JWTs (`HS256`, `RS256`, `ES256`) from `Authorization: Bearer <jwt>`. Fields: `secret` (HS256), `publicKey` (RS256/ES256), `issuer`, `audience`, `clockToleranceSeconds` (default `30`), and `tenantClaim`. `secret` accepts `${VAR}` references.
  - **`tenantClaim`:** (Optional `string`, max 128 chars) Explicit claim carrying the tenant id. When set, the implicit `tenantId` and `tid` claims are not read. `chainmcp gateway serve` runs in multi-tenant mode and requires an explicit mapping (`tenantClaim`, programmatic `mapClaims`, or the `tenant` fallback) before JWT verification starts. A verified token with no tenant claim and no fallback is rejected with HTTP `401` and `error.data.code: "TENANT_REQUIRED"`.
- **`logging`:** Configures structured logger levels (`debug`, `info`, `warn`, `error`, `silent`), output destination (`stdout`, `stderr`, `memory`), secret redaction keys, and body exclusion. Overridable via `CHAINMCP_LOG_LEVEL`. Wired into runtime options via `createLoggerFromConfig`.
- **`jsonNavigation`:** Configures bounds for JSON exploration tools (`maxDepth`, `maxArrayItems`, `maxResultBytes`, `maxVisitedNodes`, `timeoutMs`). Mapped into `NavigationLimits` via `createNavigationLimitsFromConfig`.
  - **`handles`:** (default enabled) Result-handle registry. `json_create_handle` stores a document once and returns an opaque handle; navigation tools then accept `handle` instead of the inline `json` payload. Handles are tenant- and principal-scoped, opacity-preserving, TTL'd, and LRU-/byte-bounded. Sub-keys: `enabled` (default `true`), `maxPerPrincipal` (default `50`), `maxPerTenant` (default `250`), `maxTotal` (default `1,000`), `maxBytes` (per-document byte cap, default `1,000,000`), `maxTotalBytes` (default `8,000,000`), `ttlMs` (default `600,000`), `minBytes` (minimum size before the auto path mints a handle, default `0`). Unknown, expired, evicted, tampered, cross-tenant, and cross-principal handles fail with the stable `RESULT_HANDLE_EXPIRED` error; documents above the byte cap throw `ResultHandleTooLargeError`. Wired via `createHandleRegistryOptionsFromConfig`.
- **`analytics`:** Configures usage and performance event tracking, rolling metrics aggregation retention, and OpenTelemetry integration. Under `openTelemetry`, optional `endpoint` specifies the OTLP trace/metrics destination URL, and `tracing` (`enabled`, `sampleRatio`) controls OpenTelemetry span generation and probabilistic sampling.
- **Wiring Helpers:** `buildExecutorOptions(config, overrides)` maps allowlists, timeouts, response caps, and credentials into `@chainmcp/executor`. `buildRuntimeOptions(config, overrides, factoryOptions)` maps authorizers, rate limiters, loggers, metrics sinks, OpenTelemetry tracers (`ToolTracer`), and default timeouts into `@chainmcp/core`.

## 3. Environment variables

Implemented variables:

- `CHAINMCP_CONFIG`: configuration file path (server commands).
- `CHAINMCP_GATEWAY_CONFIG`: gateway configuration file path (`chainmcp gateway serve`).
- `CHAINMCP_LOG_LEVEL`: log verbosity (`debug`, `info`, `warn`, `error`, `silent`).
- `CHAINMCP_REDIS_URL`: Redis connection used by the cache and rate limiter when neither `cache.redis.url` nor `rateLimit.redis.url` is set.
- `CHAINMCP_ALLOW_MANIFEST_DRIFT`: generated servers only. Set to `1` (or start with `--allow-manifest-drift`) to warn instead of failing when build artifacts do not match.
- `CHAINMCP_AUTH_<SCHEME>`: upstream credential lookup performed by the `type: env` upstream provider (prefix configurable with `auth.upstream.providers[].prefix`).

### Secret references

Credential fields accept `${VAR}` and `${VAR:-default}` instead of literal values.
Resolution happens after YAML parsing and before schema validation:

```yaml
auth:
  inbound:
    tokens:
      "${INBOUND_TOKEN}":
        tenantId: tenant-1
        principalId: client-1
  upstream:
    providers:
      - type: oauth
        tokenUrl: https://auth.example.com/oauth/token
        clientId: chainmcp
        clientSecret: "${OAUTH_CLIENT_SECRET}"
cache:
  provider: redis
  redis:
    url: "redis://:${REDIS_PASSWORD}@cache.internal:6379/0"
```

- **Supported fields:** keys of `auth.inbound.tokens` and `auth.inbound.apiKeys`,
  `auth.inbound.jwt.secret`, static upstream credential values (`value`,
  `token`, `username`, `password`), `auth.upstream.providers[].clientSecret`,
  `auth.upstream.providers[].keys.*`, `cache.redis.url`,
  `rateLimit.redis.url`, and their `redis.tls.key`.
- **Other fields are never interpolated.** A `contract.source` or `name`
  containing `${...}` stays literal.
- **Missing value:** startup fails with code `SECRET_UNRESOLVED` and names both
  the secret field and the environment variable. An empty environment value is
  treated as unset, so `${VAR:-fallback}` applies.
- **No recursion:** a resolved value that itself contains `${...}` is used
  verbatim.
- **No leakage:** resolved values never appear in logs, validation diagnostics,
  or `chainmcp config explain` output.
- **Literal values remain supported** for backward compatibility, but storing
  them in `chainmcp.config.yaml` is discouraged.

Run `chainmcp config explain` to print the fully resolved configuration with
every credential field replaced by `[REDACTED]`, plus the environment variable
provenance for each secret. Add `--json` for machine-readable output.

Production encryption keys should generally come from a managed secret or key-management service. Never print environment variable values.

## 4. Tool-level and operation policies

Tool-level rate limits are configured in `chainmcp.config.yaml` under `rateLimit.tools`:

```yaml
rateLimit:
  enabled: true
  requestsPerMinute: 60
  tools:
    listProducts:
      requestsPerMinute: 120
    createPayment:
      requestsPerMinute: 5
```

For code-first authoring, per-tool scopes, cache TTLs, and response projections are declared using `defineTool` in `@chainmcp/authoring`:

```typescript
import { defineTool } from "@chainmcp/authoring";
import { z } from "zod";

export const createPayment = defineTool({
  name: "createPayment",
  description: "Processes a customer payment",
  requiredScopes: ["payments:write"],
  cacheTtlSeconds: 0, // Never cache mutating actions
  inputSchema: z.object({
    amount: z.number().positive(),
    currency: z.string().length(3),
  }),
  execute: async (input, ctx) => {
    // Execution logic
  },
});
```

Mandatory authorization partitions, SSRF protections, and response-size limits cannot be disabled through tool configuration.

## 5. Validation requirements

The configuration loader must:

- Validate types and allowed values.
- Reject invalid ports, timeouts, TTLs, and negative limits.
- Reject unsupported configuration versions.
- Validate host allowlists.
- Prevent accidental exposure of remote servers without an explicit authentication decision.
- Redact secret values from diagnostics.
- Distinguish development defaults from production requirements.

## 6. Compatibility

Every configuration change must update:

- The configuration schema.
- Defaults and environment-variable mappings.
- `CONFIGURATION.md`.
- Examples and migration guidance.
- Tests for valid and invalid configurations.

Breaking configuration changes require a migration note.

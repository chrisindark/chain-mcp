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

contract:
  source: ./openapi.yaml
  strict: true

server:
  transport: stdio
  host: 127.0.0.1
  port: 3333
  requestTimeoutMs: 15000
  maxResponseBytes: 1000000
  maxRequestBytes: 1048576
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
  tokenizer: approximate # approximate | none
  modelId: cl100k_base
  charactersPerToken: 4

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

analytics:
  enabled: true
  includeArguments: false
  includeResponseBodies: false
  retentionDays: 14
```

The implemented `@chainmcp/config` package exports `ChainMcpConfigSchema`, `parseConfig`, `safeParseConfig`, and wiring helpers. The supported sections are `version`, `name`, `contract`, `server`, `security`, `rateLimit`, `auth`, `logging`, `jsonNavigation`, and `analytics`. Unknown keys are rejected with Zod `.strict()`.

- **`contract`:** (Optional) Declares the OpenAPI specification file (`contract.source`) and compilation mode (`contract.strict`). For code-first projects authored with `@chainmcp/authoring`, the `contract` section is omitted.
- **`server`:** Configures transport (`stdio` or `http`), binding host (`127.0.0.1`), port (`3333`), base path (`/mcp`), `requestTimeoutMs` (default 15,000 ms), `maxResponseBytes` (default 1,000,000), `maxRequestBytes` (default 1,048,576 = 1 MiB), `allowedHosts` for DNS rebinding protection, `allowedOrigins` for browser/CORS origin verification, `enableDnsRebindingProtection`, and `cors` configuration (`enabled`, `allowedOrigins`, `allowedHeaders`, `allowCredentials`, `maxAgeSeconds`). CORS accepts boolean shorthand or explicit object, defaults to off on non-loopback bindings, rejects wildcard origin with credentials at parse time, reflects only exact matches, and sets `Vary: Origin`.
- **`security.requireInboundAuth`:** (default `false`) Enforces inbound authentication on HTTP requests. When set to `true`, incoming requests must present valid credentials, and an inbound verifier (`auth.inbound.tokens`, `apiKeys`, or `jwt`) must be configured or startup fails fast.
- **`security.allowUnauthenticatedHttp`:** (default `false`) Explicit override required when binding the HTTP server or dynamic gateway to a non-loopback host (e.g. `0.0.0.0`, external IPs) without authentication. If `false` and inbound authentication is not configured, binding to non-loopback hosts fails fast at startup. Unauthenticated startups on loopback (`127.0.0.1`, `localhost`, `::1`) or with `allowUnauthenticatedHttp: true` emit a prominent security warning.
- **`security.allowedUpstreamHosts`:** Strictly validated against schemes, ports, paths, queries, credentials, and wildcards. Automatically normalized to lowercase canonical hostnames. Wired directly into executor options via `buildExecutorOptions`.
- **`rateLimit`:** Configures in-memory or Redis distributed rate limiting with shorthand (`requestsPerMinute`, `concurrency`) or explicit global, tenant, and tool quotas. Wired into runtime options via `createRateLimiterFromConfig`.
- **`auth`:** Configures inbound authorization (`authorizer: "scope"`) and upstream credential providers (`static`, `env`, `secretStore`, `oauth`). Wired into executor options via `createUpstreamCredentialProviderFromConfig`.
- **`logging`:** Configures structured logger levels (`debug`, `info`, `warn`, `error`, `silent`), output destination (`stdout`, `stderr`, `memory`), secret redaction keys, and body exclusion. Overridable via `CHAINMCP_LOG_LEVEL`. Wired into runtime options via `createLoggerFromConfig`.
- **`jsonNavigation`:** Configures bounds for JSON exploration tools (`maxDepth`, `maxArrayItems`, `maxResultBytes`, `maxVisitedNodes`, `timeoutMs`). Mapped into `NavigationLimits` via `createNavigationLimitsFromConfig`.
- **`analytics`:** Configures usage and performance event tracking, rolling metrics aggregation retention, and OpenTelemetry integration. Wired into runtime options via `buildRuntimeOptions`.
- **Wiring Helpers:** `buildExecutorOptions(config, overrides)` maps allowlists, timeouts, response caps, and credentials into `@chainmcp/executor`. `buildRuntimeOptions(config, overrides, factoryOptions)` maps authorizers, rate limiters, loggers, metrics sinks, and default timeouts into `@chainmcp/core`.

## 3. Environment variables

- `CHAINMCP_CONFIG`: configuration file path.
- `CHAINMCP_LOG_LEVEL`: log verbosity.
- `CHAINMCP_REDIS_URL`: Redis connection.
- `CHAINMCP_DATABASE_URL`: metadata database.
- `CHAINMCP_UPSTREAM_TIMEOUT_MS`: upstream timeout override.
- `CHAINMCP_SECRET_PROVIDER`: configured credential provider.

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

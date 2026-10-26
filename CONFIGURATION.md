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

security:
  requireInboundAuth: false
  allowedUpstreamHosts:
    - api.example.com
  redactHeaders:
    - authorization
    - cookie
    - x-api-key

cache:
  enabled: true
  provider: memory
  defaultTtlSeconds: 30
  maxEntryBytes: 250000
  cacheOnlyExplicitlySafeReads: true

tokenMetrics:
  enabled: true
  mode: estimate
  tokenizer: null

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

## 4. Operation-level policies

```yaml
operations:
  listProducts:
    cache:
      enabled: true
      ttlSeconds: 60
    rateLimit:
      requestsPerMinute: 120
    response:
      select:
        - $.items[*].id
        - $.items[*].name

  createPayment:
    cache:
      enabled: false
    authorization:
      requiredScopes:
        - payments:write
    rateLimit:
      requestsPerMinute: 5
```

Mandatory authorization partitions, SSRF protections, and response-size limits cannot be disabled through operation configuration.

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

# API Reference: @chainmcp/config

## `@chainmcp/config`

Configuration schema, validation, and wiring helpers for ChainMcp servers:

```ts
export const ChainMcpConfigSchema: z.ZodType<ChainMcpConfig>;
export function parseConfig(input: unknown): ChainMcpConfig;
export function safeParseConfig(
  input: unknown,
): ReturnType<typeof ChainMcpConfigSchema.safeParse>;

export class SecretResolutionError extends Error {
  readonly code: "SECRET_UNRESOLVED";
  readonly field: string;
  readonly failure: "missing-variable" | "invalid-template";
  readonly variable: string | undefined;
}

export interface SecretResolutionSource {
  readonly field: string;
  readonly variables: readonly string[];
  readonly usesDefault: boolean;
  readonly literal: boolean;
}

export interface ResolvedConfigSecrets<T = unknown> {
  readonly config: T;
  readonly sources: readonly SecretResolutionSource[];
}

export function resolveConfigSecrets<T = unknown>(
  input: T,
  options?: { env?: Readonly<Record<string, string | undefined>> },
): ResolvedConfigSecrets<T>;

export function redactConfigSecrets<T = unknown>(input: T): T;
```

`resolveConfigSecrets()` deep-copies the document, expands `${VAR}` /
`${VAR:-default}` only in designated credential fields (inbound token and API-key
record keys, `auth.inbound.jwt.secret`, static upstream credential values,
OAuth `clientSecret`, `secretStore` keys, and Redis URLs/TLS keys), and returns
value-free provenance. It throws `SecretResolutionError` (`SECRET_UNRESOLVED`)
when a variable is unset with no default or a reference is malformed.
`redactConfigSecrets()` replaces every designated secret field with
`[REDACTED]` (map keys become `[REDACTED:<n>]`) and is safe to print or log.

```ts
export interface BuildExecutorOptionsOverrides extends Partial<UpstreamExecutorOptions> {
  baseUrl?: string;
}

export function buildExecutorOptions(
  config: ChainMcpConfig,
  overrides?: BuildExecutorOptionsOverrides,
  factoryOptions?: CredentialProviderFactoryOptions,
): UpstreamExecutorOptions;

export function buildRuntimeOptions(
  config: ChainMcpConfig,
  overrides?: Partial<RuntimeOptions>,
  factoryOptions?: {
    rateLimiterOptions?: RateLimiterFactoryOptions;
    env?: Record<string, string | undefined>;
    diagnosticSink?: LogSink;
    auditSink?: LogSink;
  },
): RuntimeOptions;

export function createRateLimiterFromConfig(
  config: RateLimitConfig,
  options?: RateLimiterFactoryOptions,
): RateLimiter | undefined;

export function logRateLimiterStartup(
  config: RateLimitConfig,
  options?: {
    logger?: Logger | undefined;
    client?: RedisRateLimitClient | undefined;
  },
): Promise<RateLimiterStartupHealth | undefined>;

export function createAuthorizerFromConfig(
  config: InboundAuthConfig,
): Authorizer | undefined;

export function createUpstreamCredentialProviderFromConfig(
  config: UpstreamAuthConfig,
  options?: CredentialProviderFactoryOptions,
): UpstreamCredentialProvider | undefined;

export function createLoggerFromConfig(
  config: LoggingConfig,
  options?: LoggerFromConfigOptions,
): Logger;

export function createNavigationLimitsFromConfig(
  config: JsonNavigationConfig,
): NavigationLimits;
```

### Configuration Sections

- **`server`:** Configures transport (`stdio` or `http`), host, port, `requestTimeoutMs` (default 15,000ms), `shutdownTimeoutMs` (default 10,000ms; HTTP drain budget, `0` forces immediate close), `maxResponseBytes` (default 1,000,000 bytes; aborts JSON serialization mid-stream upon breach), `maxRequestBytes` (default 1,048,576 bytes), `maxToolInputBytes` (default 1,048,576 bytes; capped pre-validation), `validateResponses` (`off` | `warn` | `enforce`, default `warn`), `allowedHosts`, `allowedOrigins`, `enableDnsRebindingProtection`, and `cors`.
- **`security`:** Configures `requireInboundAuth`, `allowUnauthenticatedHttp`, `allowInsecureHttp`, `allowedUpstreamHosts`, and `redactHeaders`. Each host in `allowedUpstreamHosts` is strictly validated against schemes, ports, paths, queries, credentials, and wildcards, and normalized to canonical lowercase. `allowInsecureHttp` defaults to `false` and must be enabled to permit `http://` upstream traffic.
- **`rateLimit`:** Configures in-memory or Redis distributed rate limiting with shorthand (`requestsPerMinute`, `concurrency`) or explicit global, tenant, and tool quotas.
- **`auth`:** Configures inbound authorization (`authorizer: "scope"`) and upstream credential providers (`static`, `env`, `secretStore`, `oauth`).
- **`logging`:** Configures structured logger level, destination (`stdout`, `stderr`, `memory`), redaction keys, and body exclusion. Overridable via `CHAINMCP_LOG_LEVEL`.
- **`jsonNavigation`:** Configures bounds for JSON exploration tools (`maxDepth`, `maxArrayItems`, `maxResultBytes`, `maxVisitedNodes`, `timeoutMs`).
- **`analytics`:** Configures telemetry retention, arguments/body exclusion, and OpenTelemetry integration.
- **`contract`:** Configures OpenAPI contract specification file (`source`), strict validation mode (`strict`), and optional target upstream base URL (`baseUrl`). `contract.baseUrl` accepts absolute `http://` or `https://` URLs, preserves port and path prefix, normalizes trailing slashes, and auto-derives its host into `security.allowedUpstreamHosts`.

### Wiring Helpers

- `buildExecutorOptions(config, overrides)` maps `config.contract.baseUrl` (or fallback to `allowedUpstreamHosts[0]`) to `baseUrl`, `security.allowedUpstreamHosts` to `allowedHosts`, `security.allowInsecureHttp` to `allowInsecureHttp`, `server.requestTimeoutMs` to `timeoutMs`, `server.maxResponseBytes` to `maxResponseBytes`, `server.validateResponses` to `validateResponses`, `config.logging` to `logger`, and `auth.upstream` to `credentialProvider`. Fails closed if `allowedUpstreamHosts` is empty or no base URL can be resolved.
- `buildRuntimeOptions(config, overrides, factoryOptions)` maps `security.requireInboundAuth` / `auth.inbound` to `authorizer`, `config.rateLimit` to `rateLimiter`, `config.logging` to `logger`, `config.analytics` to `metrics`, `config.analytics.openTelemetry.tracing` to `tracer` (`ToolTracer`), `server.requestTimeoutMs` to `defaultTimeoutMs`, `server.maxToolInputBytes` to `maxToolInputBytes`, and `server.maxResponseBytes` to `maxResponseBytes`. When the factory creates the shared Redis client (no caller-supplied client was passed), it also composes `onShutdown` so `runtime.close()` drains that client exactly once; caller-supplied clients remain the caller's responsibility.

## Error codes

Public-facing errors use stable codes such as:

- `CONFIG_INVALID`
- `CONTRACT_INVALID`
- `TOOL_NOT_FOUND`
- `INPUT_INVALID`
- `INPUT_TOO_LARGE`
- `AUTH_REQUIRED`
- `AUTH_FORBIDDEN`
- `RATE_LIMITED`
- `OUTPUT_POLICY_VIOLATION`
- `OUTPUT_LIMIT_EXCEEDED`
- `UPSTREAM_TIMEOUT`
- `UPSTREAM_FAILURE`
- `RESPONSE_TOO_LARGE`
- `POLICY_DENIED`

Never expose stack traces or credential values to MCP clients.

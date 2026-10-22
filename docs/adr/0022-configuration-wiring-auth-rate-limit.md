# ADR 0022: Configuration Wiring for Network Security, Upstream Credentials, and Rate Limiting

- Status: proposed
- Date: 2026-10-22

## Context and problem

Following Milestone 5 (ADR 0021), `@chainmcp/auth` implemented pluggable upstream credential providers and encrypted secret storage, `@chainmcp/rate-limit` implemented in-memory and Redis distributed rate limiters, and `@chainmcp/executor` implemented upstream credential injection and outbound host allowlists.

However, `@chainmcp/config` only supported a minimal subset (`version`, `name`, `server`, and basic `security`), leaving several gaps:

1. `security.allowedUpstreamHosts` did not validate host syntax or normalize hostnames, permitting invalid entries with schemes or ports to pass schema parsing.
2. `security.allowedUpstreamHosts` was not wired to `@chainmcp/executor` options, requiring manual mapping in deployment code.
3. No configuration schemas existed for rate limiting (`rateLimit`) or upstream credentials (`auth.upstream`).
4. No factory or wiring helpers existed to build `RateLimiter`, `UpstreamCredentialProvider`, or `Authorizer` from parsed configuration.

## Decision

### 1. Host Validation and Normalization in Configuration Schema

- Defined `AllowedHostSchema` in `@chainmcp/config` using `normalizeAllowedHost` from `@chainmcp/executor`.
- Enforces that every host in `security.allowedUpstreamHosts` is a valid hostname, IPv4, or IPv6 address.
- Strictly rejects schemes (`http://`, `https://`), ports (`:8080`), paths (`/`), queries (`?`), fragments (`#`), user credentials (`user@`), wildcards (`*`), control characters, and whitespace.
- Automatically normalizes valid hostnames to lowercase and strips trailing dots.

### 2. Rate Limiting Schema and Factory (`rateLimit`)

- Added `RateLimitConfigSchema` to `ChainMcpConfigSchema`:
  - `enabled`: boolean flag (defaults to `false`).
  - `provider`: `"memory" | "redis"` (defaults to `"memory"`).
  - Shorthand ergonomics: `requestsPerMinute` and `concurrency`.
  - Structured policies: `globalQuota`, `globalConcurrency`, `tenantQuota`, `tenantConcurrency`, `toolQuota`, and `toolConcurrency`.
  - Redis options: `redis.keyPrefix` (defaults to `"chainmcp:ratelimit:"`) and `redis.commandTimeoutMs` (defaults to `1_000ms`, max `30_000ms`).
  - Memory bounds: `maxTrackedWindows` (defaults to `10_000`).
- Implemented `createRateLimiterFromConfig(config: RateLimitConfig, options?: RateLimiterFactoryOptions)`:
  - Returns `undefined` when `enabled` is false.
  - Maps `requestsPerMinute` to `globalQuota` ({ maxRequests, windowMs: 60_000 }) and `concurrency` to `globalConcurrency`.
  - Returns `InMemoryRateLimiter` or `DistributedRateLimiter` (requiring `options.redisClient`).

### 3. Authentication Schema and Factories (`auth`)

- Added `AuthConfigSchema` to `ChainMcpConfigSchema`:
  - `inbound`: `requireInboundAuth` and `authorizer` (`"scope" | "none"`).
  - `upstream.providers`: Discriminated union supporting:
    - `static`: mapping of scheme names to API keys, HTTP basic/bearer, or OAuth2 tokens.
    - `env`: environment variable resolution with customizable prefix (default `CHAINMCP_AUTH_`).
    - `secretStore`: encrypted secret store with `activeKeyId`, key ring, and `allowGlobalFallback`.
    - `oauth`: OAuth 2.0 Client Credentials Grant with `tokenUrl`, `clientId`, `clientSecret`, `scopes`, `schemeNames`, and `expirySkewSeconds`.
- Implemented:
  - `createAuthorizerFromConfig(config: InboundAuthConfig)`: returns `OperationScopeAuthorizer` when `authorizer === "scope"`.
  - `createUpstreamCredentialProviderFromConfig(config: UpstreamAuthConfig, options?)`: builds single or `CompositeCredentialProvider`.

### 4. Direct Executor and Runtime Wiring Helpers

- Implemented `buildExecutorOptions(config: ChainMcpConfig, overrides: BuildExecutorOptionsOverrides)`:
  - Automatically wires `security.allowedUpstreamHosts` to `allowedHosts`.
  - Automatically wires `server.requestTimeoutMs` to `timeoutMs`.
  - Automatically wires `server.maxResponseBytes` to `maxResponseBytes`.
  - Automatically wires `auth.upstream` to `credentialProvider`.
  - Fails closed if `allowedUpstreamHosts` is empty.
- Implemented `buildRuntimeOptions(config: ChainMcpConfig, overrides?, factoryOptions?)`:
  - Automatically wires authorizer from `security.requireInboundAuth` or `auth.inbound`.
  - Automatically wires `rateLimiter` from `config.rateLimit`.
  - Automatically wires `server.requestTimeoutMs` to `defaultTimeoutMs`.

## Alternatives considered

- **Keep configuration purely data without factories:** Rejected. Having deployment code manually map nested config structures to runtime and executor options leads to divergent wiring, missed timeouts, and security gaps.
- **Support wildcard host allowlists (`*.example.com`):** Rejected. Wildcards weaken SSRF boundaries and prevent reliable destination classification and DNS pinning.

## Consequences and trade-offs

- `@chainmcp/config` now depends on `@chainmcp/core`, `@chainmcp/auth`, `@chainmcp/executor`, and `@chainmcp/rate-limit`.
- Configuration-to-runtime transition is fully unified and validated.
- Unknown fields continue to be rejected by Zod `.strict()`.

## Security implications

- Outbound allowlists cannot contain invalid or ambiguous host strings.
- Empty allowlists fail closed when building executor options.
- Rate limiting and inbound authorization can be enabled directly from configuration without boilerplate.

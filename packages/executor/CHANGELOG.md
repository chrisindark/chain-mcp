# @chainmcp/executor

## 0.4.1

### Patch Changes

- Updated dependencies
  - @chainmcp/core@0.4.1
  - @chainmcp/auth@0.4.1
  - @chainmcp/compiler@0.4.1

## 0.4.0

### Patch Changes

- @chainmcp/auth@0.4.0
  - @chainmcp/compiler@0.4.0
  - @chainmcp/core@0.4.0

## 0.3.1

### Patch Changes

- Updated dependencies
  - @chainmcp/core@0.3.1
  - @chainmcp/auth@0.3.1
  - @chainmcp/compiler@0.3.1

## 0.3.0

### Minor Changes

- 180f2f0: Documentation truth pass (P0-8).

  - README now says the project is pre-1.0 and that the 1.0 release is deliberately withheld; registry `npx @chainmcp/cli` and bare `chainmcp` examples are marked as requiring publishing or an installed CLI (clone path is `node packages/cli/dist/bin.js`); intended technology no longer lists Hono or PostgreSQL (no database metadata store ships); token accounting, JSON navigation, response-schema enforcement, and auth-policy language match the shipped behavior.
  - `docs/getting-started.md`: response schemas are enforced by the executor when `server.validateResponses` is `warn`/`enforce`; authentication policies are not enforced by the compiler. Code-first init examples now include `--local-deps`.
  - `docs/deployment.md`: generated-server install and Dockerfile steps now use pnpm in local-deps mode.
  - `docs/product-guide.md`: softened `reduce payloads by up to 90%`, `sub-millisecond`, and `military-grade` marketing claims; corrected metric names to the four emitted by `OpenTelemetryMetricsSink` (`chainmcp.tool.invocations`, `chainmcp.tool.duration`, `chainmcp.tool.tokens`, `chainmcp.tool.payload_bytes`); clarified JSON navigation requires the full document supplied inline.
  - Added a CI drift guard: `pnpm docs:check` validates that every documented capability in `docs/capability-evidence.json` points to a real test file or exported API, and that the README `## Core capabilities` bullets are all covered. Wired into `pnpm check` and CI.

- 147ef5e: Implement Milestone 10: Stable 1.0 release gates and production readiness.

  - Public API review and interface stabilization across all workspace packages.
  - Supported version matrix published in `docs/supported-versions.md` covering Node.js (>=20.11, 20 & 22 LTS), operating systems, OpenAPI (3.0.x & 3.1.x), MCP TypeScript SDK v2, Redis (7+), and configuration version 1.
  - Security and dependency audit (`pnpm audit`) verified zero high or critical vulnerabilities; updated threat model and disposition in `docs/risk-register.md`.
  - Comprehensive load, resilience, and fault-injection test suites in `@chainmcp/core` and `@chainmcp/executor` verifying graceful degradation under cache/limiter outages, network drops, socket aborts, 5xx server errors, DNS failures, redirect loops, and in-flight cooperative cancellations (`AbortSignal`).
  - Migration and rollback procedures for standalone generated servers and the dynamic gateway in `docs/migration-and-rollback.md` and runtime troubleshooting in `docs/troubleshooting.md`.
  - CycloneDX 1.5 JSON Software Bill of Materials (SBOM) generator script (`scripts/generate-sbom.mjs`) and `pnpm sbom` command.
  - Automated release workflow in `.github/workflows/release.yml` with signed npm provenance (`--provenance`) and Changesets publishing.
  - Recorded ADR 0027: Stable 1.0 Release and Production Readiness.

- 5f3f111: Add `@chainmcp/executor`, the first upstream HTTP execution slice.

  `createUpstreamExecutor()` turns compiled operations into runnable tools with
  path/query/header/JSON-body mapping, an exact host allowlist, HTTPS by default,
  fixed protocol/port, same-host redirect revalidation, DNS-answer classification
  and address pinning, peer verification, response and request caps, and
  `context.signal`/total-timeout binding. It returns JSON for 2xx responses and
  maps destination, request, status, response, timeout, and cancellation failures
  to safe runtime errors. It does not inject credentials, enforce authentication
  policies, validate response schemas, retry, or honor proxy environment
  variables.

  The compiler now records sorted parameter bindings and request-body media
  metadata so the executor does not re-parse OpenAPI, and includes them in
  per-tool hashes.

- c214e77: Implement Milestone 5 authentication, secret storage, upstream credentials, and rate limiting:

  - Add `EncryptedSecretStore` in `@chainmcp/auth` providing AES-256-GCM authenticated encryption at rest with 96-bit random IVs, 128-bit authentication tags, key-name AAD binding, key rings, and key rotation.
  - Add pluggable upstream credential providers (`StaticCredentialProvider`, `EnvCredentialProvider`, `SecretStoreCredentialProvider`, `CompositeCredentialProvider`, and `OAuthClientCredentialsProvider`), with `normalizeUpstreamCredential` validating provider output at the trust boundary.
  - Add `buildCredentialStoreKey`, `buildOAuthTokenStoreKey`, and `encodeSecretKeySegment` so tenant, principal, scheme, and scope values always derive valid, collision-free `SecretStore` keys.
  - Implement the OAuth 2.0 client credentials grant with token caching, expiry safety margins, automatic re-acquisition, and `invalidate(tenantId?, schemeName?, principalId?)`. Invalidation also deletes persistent cache entries; cross-process revocation of entries another process wrote remains out of scope because `SecretStore` has no scan operation.
  - Require an explicit token endpoint allowlist (`allowedTokenHosts`) or `allowAnyTokenHost`, enforce HTTPS unless `allowInsecureHttp` is set, and refuse redirects and URL credentials in the built-in token fetcher.
  - Wire `credentialProvider` into `@chainmcp/executor` with explicit OR/AND authentication policy evaluation, header/query/cookie injection, and fail-closed `AUTH_REQUIRED` enforcement. OAuth token requests run through the executor's destination policy and pinned transport instead of the platform fetch.
  - Default `SecretStoreCredentialProvider` to tenant-scoped secrets; a deployment-wide credential now requires `allowGlobalFallback: true`.
  - Add `@chainmcp/rate-limit` with `InMemoryRateLimiter` (bounded, least-recently-used sliding windows via `maxTrackedWindows`) and `DistributedRateLimiter` (Redis-backed atomic Lua scripts for rolling-window quotas and concurrency permits). A denied multi-scope check rolls back quota it already recorded.
  - Extend `@chainmcp/core` with `retryAfterSeconds` on `RateLimitDecision` and `RuntimeError`, and `release?(context, toolName)` concurrency permit release hook.
  - Surface a bounded retry hint (`Retry after N seconds`) in the client-visible `RATE_LIMITED` error from `@chainmcp/server`.

- 46e3b31: Wire network security allowlists, rate limiting, and upstream authentication into `@chainmcp/config`:

  - Enforce strict hostname validation and lowercase normalization on `security.allowedUpstreamHosts`, rejecting schemes, ports, paths, queries, credentials, and wildcards.
  - Export `normalizeAllowedHost` and `normalizeHostname` from `@chainmcp/executor`.
  - Add `rateLimit` and `auth` schema sections to `ChainMcpConfigSchema`.
  - Add factory and wiring helpers: `buildExecutorOptions`, `buildRuntimeOptions`, `createRateLimiterFromConfig`, `createAuthorizerFromConfig`, and `createUpstreamCredentialProviderFromConfig`.

- 998b681: Implement Milestone 8: Tool Sources and Code-First Authoring.

  - Add `@chainmcp/core` `ToolSource` boundary interface and `InMemoryToolRuntime.registerSource()`.
  - Add `OpenApiToolSource` in `@chainmcp/executor` wrapping compiled operations and `UpstreamExecutor`.
  - Add `@chainmcp/authoring` package with `defineTool()` authoring facade, `ManualToolSource`, and `zodToJsonSchema()` lowering with definition-time schema audits against the supported JSON Schema subset.
  - Add policy parity tests (`packages/authoring/tests/parity.test.ts`) asserting 100% equivalence between manual and compiled tools across input validation, authorization scopes, rate limiting, cooperative cancellation/timeout, output projection, result caching, and safe error masking.
  - Add `chainmcp init --blank` in `@chainmcp/cli` to scaffold contract-free, code-first MCP server projects with example tools and build templates.
  - Add `chainmcp dev` in `@chainmcp/cli` for a local developer authoring loop over stdio.
  - Add runnable code-first example in `examples/code-first` with automated integration tests over the official MCP SDK client.
  - Update documentation in `docs/getting-started.md`, `API_REFERENCE.md`, `CONFIGURATION.md`, and `ARCHITECTURE.md`, accept ADR 0019, and record ADR 0025.

- 8c8483c: Wire caching, token metrics, and declarative output projection configuration schemas and runtime factories with support for in-memory and Redis backends, opt-in read caching for compiled GET operations, tokenizer registration, and maxResponseBytes enforcement.

### Patch Changes

- 26e83fe: Add `@chainmcp/declarative`, the first post-1.0 builder slice. `descriptorVersion: 1`
  JSON documents describe an HTTP tool (name, audited input schema, method,
  relative path, parameter/body bindings, auth references, and policy), are
  validated at load time with stable diagnostic codes, and lower into the
  existing bounded executor. Descriptors cannot contain absolute URLs,
  credentials, transport-owned headers, or code. `DeclarativeToolSource` binds
  validated descriptors to a deployment executor with deterministic
  `sha256:` revisions, so descriptor tools inherit the same SSRF, redirect,
  timeout, response-cap, authorization, cache, and output guarantees as compiled
  tools. `@chainmcp/executor` exports `isReservedRequestHeader()` and
  `isValidRequestHeaderName()` so descriptor validation and request building
  cannot drift.
- 99483c5: Apply Apache License 2.0 across all workspace packages, completing Milestone 0 licensing. Upgrade @modelcontextprotocol/server and @modelcontextprotocol/client to 2.3.1 to resolve upstream security advisories.
- f51ff52: Hardened release evidence with Node 20/22 CI matrix, transitive CycloneDX 1.5 SBOM, and high-concurrency multi-tenant load and fault-injection test suite.
- 5ea3ece: Add package metadata, READMEs, licenses, engines, homepage, and repository links across all workspace packages for npm distribution.
- Updated dependencies [180f2f0]
- Updated dependencies [180f2f0]
- Updated dependencies [99483c5]
- Updated dependencies [f51ff52]
- Updated dependencies [147ef5e]
- Updated dependencies [8df778b]
- Updated dependencies [805c5a4]
- Updated dependencies [1bb1a2a]
- Updated dependencies [5f3f111]
- Updated dependencies [c371655]
- Updated dependencies [c214e77]
- Updated dependencies [8252a3a]
- Updated dependencies [998b681]
- Updated dependencies [8df778b]
- Updated dependencies [5ea3ece]
  - @chainmcp/compiler@0.3.0
  - @chainmcp/core@0.3.0
  - @chainmcp/auth@0.3.0

## 0.2.0

### Minor Changes

- 180f2f0: Documentation truth pass (P0-8).

  - README now says the project is pre-1.0 and that the 1.0 release is deliberately withheld; registry `npx @chainmcp/cli` and bare `chainmcp` examples are marked as requiring publishing or an installed CLI (clone path is `node packages/cli/dist/bin.js`); intended technology no longer lists Hono or PostgreSQL (no database metadata store ships); token accounting, JSON navigation, response-schema enforcement, and auth-policy language match the shipped behavior.
  - `docs/getting-started.md`: response schemas are enforced by the executor when `server.validateResponses` is `warn`/`enforce`; authentication policies are not enforced by the compiler. Code-first init examples now include `--local-deps`.
  - `docs/deployment.md`: generated-server install and Dockerfile steps now use pnpm in local-deps mode.
  - `docs/product-guide.md`: softened `reduce payloads by up to 90%`, `sub-millisecond`, and `military-grade` marketing claims; corrected metric names to the four emitted by `OpenTelemetryMetricsSink` (`chainmcp.tool.invocations`, `chainmcp.tool.duration`, `chainmcp.tool.tokens`, `chainmcp.tool.payload_bytes`); clarified JSON navigation requires the full document supplied inline.
  - Added a CI drift guard: `pnpm docs:check` validates that every documented capability in `docs/capability-evidence.json` points to a real test file or exported API, and that the README `## Core capabilities` bullets are all covered. Wired into `pnpm check` and CI.

- 147ef5e: Implement Milestone 10: Stable 1.0 release gates and production readiness.

  - Public API review and interface stabilization across all workspace packages.
  - Supported version matrix published in `docs/supported-versions.md` covering Node.js (>=20.11, 20 & 22 LTS), operating systems, OpenAPI (3.0.x & 3.1.x), MCP TypeScript SDK v2, Redis (7+), and configuration version 1.
  - Security and dependency audit (`pnpm audit`) verified zero high or critical vulnerabilities; updated threat model and disposition in `docs/risk-register.md`.
  - Comprehensive load, resilience, and fault-injection test suites in `@chainmcp/core` and `@chainmcp/executor` verifying graceful degradation under cache/limiter outages, network drops, socket aborts, 5xx server errors, DNS failures, redirect loops, and in-flight cooperative cancellations (`AbortSignal`).
  - Migration and rollback procedures for standalone generated servers and the dynamic gateway in `docs/migration-and-rollback.md` and runtime troubleshooting in `docs/troubleshooting.md`.
  - CycloneDX 1.5 JSON Software Bill of Materials (SBOM) generator script (`scripts/generate-sbom.mjs`) and `pnpm sbom` command.
  - Automated release workflow in `.github/workflows/release.yml` with signed npm provenance (`--provenance`) and Changesets publishing.
  - Recorded ADR 0027: Stable 1.0 Release and Production Readiness.

- 5f3f111: Add `@chainmcp/executor`, the first upstream HTTP execution slice.

  `createUpstreamExecutor()` turns compiled operations into runnable tools with
  path/query/header/JSON-body mapping, an exact host allowlist, HTTPS by default,
  fixed protocol/port, same-host redirect revalidation, DNS-answer classification
  and address pinning, peer verification, response and request caps, and
  `context.signal`/total-timeout binding. It returns JSON for 2xx responses and
  maps destination, request, status, response, timeout, and cancellation failures
  to safe runtime errors. It does not inject credentials, enforce authentication
  policies, validate response schemas, retry, or honor proxy environment
  variables.

  The compiler now records sorted parameter bindings and request-body media
  metadata so the executor does not re-parse OpenAPI, and includes them in
  per-tool hashes.

- c214e77: Implement Milestone 5 authentication, secret storage, upstream credentials, and rate limiting:

  - Add `EncryptedSecretStore` in `@chainmcp/auth` providing AES-256-GCM authenticated encryption at rest with 96-bit random IVs, 128-bit authentication tags, key-name AAD binding, key rings, and key rotation.
  - Add pluggable upstream credential providers (`StaticCredentialProvider`, `EnvCredentialProvider`, `SecretStoreCredentialProvider`, `CompositeCredentialProvider`, and `OAuthClientCredentialsProvider`), with `normalizeUpstreamCredential` validating provider output at the trust boundary.
  - Add `buildCredentialStoreKey`, `buildOAuthTokenStoreKey`, and `encodeSecretKeySegment` so tenant, principal, scheme, and scope values always derive valid, collision-free `SecretStore` keys.
  - Implement the OAuth 2.0 client credentials grant with token caching, expiry safety margins, automatic re-acquisition, and `invalidate(tenantId?, schemeName?, principalId?)`. Invalidation also deletes persistent cache entries; cross-process revocation of entries another process wrote remains out of scope because `SecretStore` has no scan operation.
  - Require an explicit token endpoint allowlist (`allowedTokenHosts`) or `allowAnyTokenHost`, enforce HTTPS unless `allowInsecureHttp` is set, and refuse redirects and URL credentials in the built-in token fetcher.
  - Wire `credentialProvider` into `@chainmcp/executor` with explicit OR/AND authentication policy evaluation, header/query/cookie injection, and fail-closed `AUTH_REQUIRED` enforcement. OAuth token requests run through the executor's destination policy and pinned transport instead of the platform fetch.
  - Default `SecretStoreCredentialProvider` to tenant-scoped secrets; a deployment-wide credential now requires `allowGlobalFallback: true`.
  - Add `@chainmcp/rate-limit` with `InMemoryRateLimiter` (bounded, least-recently-used sliding windows via `maxTrackedWindows`) and `DistributedRateLimiter` (Redis-backed atomic Lua scripts for rolling-window quotas and concurrency permits). A denied multi-scope check rolls back quota it already recorded.
  - Extend `@chainmcp/core` with `retryAfterSeconds` on `RateLimitDecision` and `RuntimeError`, and `release?(context, toolName)` concurrency permit release hook.
  - Surface a bounded retry hint (`Retry after N seconds`) in the client-visible `RATE_LIMITED` error from `@chainmcp/server`.

- 46e3b31: Wire network security allowlists, rate limiting, and upstream authentication into `@chainmcp/config`:

  - Enforce strict hostname validation and lowercase normalization on `security.allowedUpstreamHosts`, rejecting schemes, ports, paths, queries, credentials, and wildcards.
  - Export `normalizeAllowedHost` and `normalizeHostname` from `@chainmcp/executor`.
  - Add `rateLimit` and `auth` schema sections to `ChainMcpConfigSchema`.
  - Add factory and wiring helpers: `buildExecutorOptions`, `buildRuntimeOptions`, `createRateLimiterFromConfig`, `createAuthorizerFromConfig`, and `createUpstreamCredentialProviderFromConfig`.

- 998b681: Implement Milestone 8: Tool Sources and Code-First Authoring.

  - Add `@chainmcp/core` `ToolSource` boundary interface and `InMemoryToolRuntime.registerSource()`.
  - Add `OpenApiToolSource` in `@chainmcp/executor` wrapping compiled operations and `UpstreamExecutor`.
  - Add `@chainmcp/authoring` package with `defineTool()` authoring facade, `ManualToolSource`, and `zodToJsonSchema()` lowering with definition-time schema audits against the supported JSON Schema subset.
  - Add policy parity tests (`packages/authoring/tests/parity.test.ts`) asserting 100% equivalence between manual and compiled tools across input validation, authorization scopes, rate limiting, cooperative cancellation/timeout, output projection, result caching, and safe error masking.
  - Add `chainmcp init --blank` in `@chainmcp/cli` to scaffold contract-free, code-first MCP server projects with example tools and build templates.
  - Add `chainmcp dev` in `@chainmcp/cli` for a local developer authoring loop over stdio.
  - Add runnable code-first example in `examples/code-first` with automated integration tests over the official MCP SDK client.
  - Update documentation in `docs/getting-started.md`, `API_REFERENCE.md`, `CONFIGURATION.md`, and `ARCHITECTURE.md`, accept ADR 0019, and record ADR 0025.

- 8c8483c: Wire caching, token metrics, and declarative output projection configuration schemas and runtime factories with support for in-memory and Redis backends, opt-in read caching for compiled GET operations, tokenizer registration, and maxResponseBytes enforcement.

### Patch Changes

- 26e83fe: Add `@chainmcp/declarative`, the first post-1.0 builder slice. `descriptorVersion: 1`
  JSON documents describe an HTTP tool (name, audited input schema, method,
  relative path, parameter/body bindings, auth references, and policy), are
  validated at load time with stable diagnostic codes, and lower into the
  existing bounded executor. Descriptors cannot contain absolute URLs,
  credentials, transport-owned headers, or code. `DeclarativeToolSource` binds
  validated descriptors to a deployment executor with deterministic
  `sha256:` revisions, so descriptor tools inherit the same SSRF, redirect,
  timeout, response-cap, authorization, cache, and output guarantees as compiled
  tools. `@chainmcp/executor` exports `isReservedRequestHeader()` and
  `isValidRequestHeaderName()` so descriptor validation and request building
  cannot drift.
- 99483c5: Apply Apache License 2.0 across all workspace packages, completing Milestone 0 licensing. Upgrade @modelcontextprotocol/server and @modelcontextprotocol/client to 2.3.1 to resolve upstream security advisories.
- f51ff52: Hardened release evidence with Node 20/22 CI matrix, transitive CycloneDX 1.5 SBOM, and high-concurrency multi-tenant load and fault-injection test suite.
- Updated dependencies [180f2f0]
- Updated dependencies [180f2f0]
- Updated dependencies
- Updated dependencies [99483c5]
- Updated dependencies [f51ff52]
- Updated dependencies [147ef5e]
- Updated dependencies [8df778b]
- Updated dependencies [805c5a4]
- Updated dependencies [1bb1a2a]
- Updated dependencies [5f3f111]
- Updated dependencies [c371655]
- Updated dependencies [c214e77]
- Updated dependencies [8252a3a]
- Updated dependencies [998b681]
- Updated dependencies [8df778b]
  - @chainmcp/compiler@0.2.0
  - @chainmcp/core@0.2.0
  - @chainmcp/auth@0.2.0

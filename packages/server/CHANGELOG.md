# @chainmcp/server

## 0.6.0

### Minor Changes

- Implement Milestone 12.1 (M12-1): Universal MCP Telemetry & lightweight OTLP/HTTP Ingestion Sink.

  - Added `OtlpIngestionSink`, `createOtlpHttpHandler`, and `deriveMetricsFromSpans` in `@chainmcp/analytics`.
  - Support standard OTLP/JSON payloads on `POST /v1/traces` and `POST /v1/metrics`.
  - Maps GenAI semantic conventions (`gen_ai.usage.*`, `gen_ai.request.model`) and MCP conventions (`tool.name`, `mcp.tool_name`, `outcome`, `tenant.id`) into ChainMcp runtime events.
  - Asynchronously persists `TelemetryEvent`s to `@chainmcp/storage` (`TelemetryRingBuffer`) in WAL mode or memory while delivering synchronous metrics in <5ms.
  - Mounted into `@chainmcp/server` via `HttpServeOptions.otlpHandler`.
  - Added `openTelemetry.ingestion` configuration and `createOtlpIngestionSinkFromConfig` to `@chainmcp/config`.

### Patch Changes

- @chainmcp/core@0.6.0

## 0.5.0

### Patch Changes

- @chainmcp/core@0.5.0

## 0.4.1

### Patch Changes

- Updated dependencies
  - @chainmcp/core@0.4.1

## 0.4.0

### Patch Changes

- @chainmcp/core@0.4.0

## 0.3.1

### Patch Changes

- Updated dependencies
  - @chainmcp/core@0.3.1

## 0.3.0

### Minor Changes

- 723c5dd: Make the dynamic gateway deployable with chainmcp gateway serve, gateway configuration schema, tools/list_changed notifications on publish/activate/disable/rollback, runnable deployment example, and multi-contract SDK end-to-end integration tests.
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

- 8df778b: Declare `tenantMode` on `ToolRuntime`, dispatch the MCP adapter on that declaration instead of a concrete class, and preserve typed `RuntimeError`s thrown by context factories. Also map error codes through an exhaustive table, bound `maxResponseBytes` to 100 MB, and replace the placeholder `TODO` license with `UNLICENSED`.
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

- 5477ae5: Implement Milestone 7: Developer CLI and Portable Generated Servers.

  - Add `@chainmcp/cli` package providing developer CLI commands (`init`, `validate`, `build`, `serve`, `export`) using Node.js built-in `util.parseArgs` and strictly asynchronous I/O conforming to `chainmcp/no-blocking-io`.
  - Implement `chainmcp export` to generate portable, self-contained MCP server projects with pinned contract snapshots, project configurations, TypeScript configs, multi-stage `Dockerfile` templates, `.dockerignore`, `.gitignore`, `README.md`, and deterministic manifests.
  - Implement `chainmcp.manifest.json` generation and reproducibility verification (`verifyProjectManifest`).
  - Export `Transport` type from `@chainmcp/server`.
  - Add deployment documentation in `docs/deployment.md` covering stdio client integration, Docker containerization, process lifecycle, and SSRF security controls.
  - Add end-to-end integration tests verifying clean compilation with `tsc`, independent execution, and MCP SDK protocol conformance.

- b64fd14: Add a `GET /readyz` readiness probe that reflects dependency reachability and follows the configured failure policy.

  - `@chainmcp/server`: `serveHttp` accepts `readiness: { deps: [{ name, check, degradedReady? }] }`. `GET /readyz` runs each check (errors swallowed, never mirrored) and returns `200 {"status":"ready"}` when all pass, `200 {"status":"degraded"}` when only `degradedReady` deps fail, and `503 {"status":"not_ready"}` when a non-degraded dep fails. `GET /health` and `GET /livez` remain liveness-only and never touch dependencies. With no deps configured, `/readyz` returns ready with no dependency detail.
  - `@chainmcp/config`: new `buildReadinessDeps(config, { rateLimiter, cacheStore })` emits one dep per Redis-backed dependency, using the same client instances as the runtime. The rate limiter probes `eval("return 1")`; the cache store probes a read of an absent key (proves liveness without writing). Both are bounded by a 500 ms probe timeout. A `fail-open` limiter is reported `degradedReady`, mirroring the call path, so an unreachable Redis keeps `/readyz` at 200 `degraded`; a `fail-closed` limiter or cache outage returns 503. Exported `ReadinessDep` type for embedded use.
  - `@chainmcp/cli`: `serve` (HTTP), `gateway serve` (HTTP), and generated server templates pass `buildReadinessDeps` output to `serveHttp`.
  - Additive: existing deployments without the wiring behave as before; `/health` and `/livez` responses are unchanged.

- 0097d0b: Add Streamable HTTP and SSE transports to `@chainmcp/server`, with inbound authentication verifiers (Bearer tokens, API keys, JWT), CLI `--transport http` support, Docker EXPOSE, and MCP Inspector conformance verification.
- b64fd14: Paginate `tools/list` with revision-bound cursors.

  - `@chainmcp/server`: `McpServerOptions.toolsPageSize` (default `100`; `0` disables pagination) applies to both the single-tenant snapshot path and the multi-tenant per-request path. Pages are ordered deterministically by tool name, and `nextCursor` is opaque and bound to the listing revision. Stale, malformed, and cross-tenant cursors fail with the stable `STALE_CURSOR` error.
  - `@chainmcp/config`: `server.toolsPageSize` defaults to `100` and accepts `0`.
  - `@chainmcp/cli`: `serve`, `dev`, `gateway serve`, and generated server templates pass `server.toolsPageSize` through to the adapter.
  - Additive: clients that request `tools/list` without a cursor still receive the complete listing because the MCP client aggregates pages.

### Patch Changes

- 99483c5: Apply Apache License 2.0 across all workspace packages, completing Milestone 0 licensing. Upgrade @modelcontextprotocol/server and @modelcontextprotocol/client to 2.3.1 to resolve upstream security advisories.
- 805c5a4: Add the first Milestone 3 OpenAPI compiler slices and a blocking-I/O lint rule.

  `@chainmcp/compiler` parses and validates one OpenAPI 3.0 or 3.1 YAML/JSON
  document, resolves local `$ref`s, enumerates operations deterministically,
  builds audited object-root input schemas from parameters and JSON request
  bodies, translates 3.0 nullability, flattens object `allOf` intersections when
  merging preserves the contract, maps declared responses with their media types
  and descriptive schemas, and derives explicit OR/AND authentication policies
  with copied credential metadata and required scopes. Anonymous alternatives are
  preserved, and OAuth2 scope mismatches are diagnosed. It emits deterministic
  source/contract/toolset hashes plus manifest diffs. Response schemas are
  metadata only and are not used to validate upstream payloads; authentication
  policies are not enforced. The compiler does not inject credentials.

  The repository now enforces `chainmcp/no-blocking-io` on runtime source paths,
  rejecting synchronous `fs` and `child_process` APIs, with RuleTester coverage.

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

- 5ea3ece: Add package metadata, READMEs, licenses, engines, homepage, and repository links across all workspace packages for npm distribution.
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
  - @chainmcp/core@0.3.0

## 0.2.0

### Minor Changes

- 723c5dd: Make the dynamic gateway deployable with chainmcp gateway serve, gateway configuration schema, tools/list_changed notifications on publish/activate/disable/rollback, runnable deployment example, and multi-contract SDK end-to-end integration tests.
- 180f2f0: Documentation truth pass (P0-8).

  - README now says the project is pre-1.0 and that the 1.0 release is deliberately withheld; registry `npx @chainmcp/cli` and bare `chainmcp` examples are marked as requiring publishing or an installed CLI (clone path is `node packages/cli/dist/bin.js`); intended technology no longer lists Hono or PostgreSQL (no database metadata store ships); token accounting, JSON navigation, response-schema enforcement, and auth-policy language match the shipped behavior.
  - `docs/getting-started.md`: response schemas are enforced by the executor when `server.validateResponses` is `warn`/`enforce`; authentication policies are not enforced by the compiler. Code-first init examples now include `--local-deps`.
  - `docs/deployment.md`: generated-server install and Dockerfile steps now use pnpm in local-deps mode.
  - `docs/product-guide.md`: softened `reduce payloads by up to 90%`, `sub-millisecond`, and `military-grade` marketing claims; corrected metric names to the four emitted by `OpenTelemetryMetricsSink` (`chainmcp.tool.invocations`, `chainmcp.tool.duration`, `chainmcp.tool.tokens`, `chainmcp.tool.payload_bytes`); clarified JSON navigation requires the full document supplied inline.
  - Added a CI drift guard: `pnpm docs:check` validates that every documented capability in `docs/capability-evidence.json` points to a real test file or exported API, and that the README `## Core capabilities` bullets are all covered. Wired into `pnpm check` and CI.

- Drain in-flight HTTP requests instead of killing them on shutdown.

  - `serveHttp` answers requests that arrive during shutdown with `503` and
    `Connection: close`, drains work-bearing `POST`/`DELETE` requests for up to
    `server.shutdownTimeoutMs` (default 10,000 ms), then aborts cooperative tool
    executions and force-closes remaining sockets. SIGINT/SIGTERM are idempotent
    with exit codes 130 and 143.
  - `ToolRuntime.close?()` / `InMemoryToolRuntime.close()` flush
    `MetricsSink.flush?()` and run `RuntimeOptions.onShutdown()` exactly once.
    `buildRuntimeOptions` drains the shared Redis client it created through that
    hook; caller-supplied clients are not closed.

- 147ef5e: Implement Milestone 10: Stable 1.0 release gates and production readiness.

  - Public API review and interface stabilization across all workspace packages.
  - Supported version matrix published in `docs/supported-versions.md` covering Node.js (>=20.11, 20 & 22 LTS), operating systems, OpenAPI (3.0.x & 3.1.x), MCP TypeScript SDK v2, Redis (7+), and configuration version 1.
  - Security and dependency audit (`pnpm audit`) verified zero high or critical vulnerabilities; updated threat model and disposition in `docs/risk-register.md`.
  - Comprehensive load, resilience, and fault-injection test suites in `@chainmcp/core` and `@chainmcp/executor` verifying graceful degradation under cache/limiter outages, network drops, socket aborts, 5xx server errors, DNS failures, redirect loops, and in-flight cooperative cancellations (`AbortSignal`).
  - Migration and rollback procedures for standalone generated servers and the dynamic gateway in `docs/migration-and-rollback.md` and runtime troubleshooting in `docs/troubleshooting.md`.
  - CycloneDX 1.5 JSON Software Bill of Materials (SBOM) generator script (`scripts/generate-sbom.mjs`) and `pnpm sbom` command.
  - Automated release workflow in `.github/workflows/release.yml` with signed npm provenance (`--provenance`) and Changesets publishing.
  - Recorded ADR 0027: Stable 1.0 Release and Production Readiness.

- 8df778b: Declare `tenantMode` on `ToolRuntime`, dispatch the MCP adapter on that declaration instead of a concrete class, and preserve typed `RuntimeError`s thrown by context factories. Also map error codes through an exhaustive table, bound `maxResponseBytes` to 100 MB, and replace the placeholder `TODO` license with `UNLICENSED`.
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

- 5477ae5: Implement Milestone 7: Developer CLI and Portable Generated Servers.

  - Add `@chainmcp/cli` package providing developer CLI commands (`init`, `validate`, `build`, `serve`, `export`) using Node.js built-in `util.parseArgs` and strictly asynchronous I/O conforming to `chainmcp/no-blocking-io`.
  - Implement `chainmcp export` to generate portable, self-contained MCP server projects with pinned contract snapshots, project configurations, TypeScript configs, multi-stage `Dockerfile` templates, `.dockerignore`, `.gitignore`, `README.md`, and deterministic manifests.
  - Implement `chainmcp.manifest.json` generation and reproducibility verification (`verifyProjectManifest`).
  - Export `Transport` type from `@chainmcp/server`.
  - Add deployment documentation in `docs/deployment.md` covering stdio client integration, Docker containerization, process lifecycle, and SSRF security controls.
  - Add end-to-end integration tests verifying clean compilation with `tsc`, independent execution, and MCP SDK protocol conformance.

- 0097d0b: Add Streamable HTTP and SSE transports to `@chainmcp/server`, with inbound authentication verifiers (Bearer tokens, API keys, JWT), CLI `--transport http` support, Docker EXPOSE, and MCP Inspector conformance verification.
- Reject non-allowlisted browser origins by default.

  - CORS is disabled on every bind host unless `allowedOrigins` is configured
    explicitly; `cors: true` without origins stays disabled, and wildcard `"*"`
    always warns at startup.
  - Origin validation now runs even when CORS headers are disabled. A request
    with an `Origin` outside the effective allowlist receives `403` before tools
    run; requests without `Origin` are unaffected.
  - Add the Inspector UI origin (`http://localhost:6274`) to `allowedOrigins` to
    opt in. Browser clients that relied on the previous implicit loopback
    wildcard must configure their origin.

### Patch Changes

- 99483c5: Apply Apache License 2.0 across all workspace packages, completing Milestone 0 licensing. Upgrade @modelcontextprotocol/server and @modelcontextprotocol/client to 2.3.1 to resolve upstream security advisories.
- 805c5a4: Add the first Milestone 3 OpenAPI compiler slices and a blocking-I/O lint rule.

  `@chainmcp/compiler` parses and validates one OpenAPI 3.0 or 3.1 YAML/JSON
  document, resolves local `$ref`s, enumerates operations deterministically,
  builds audited object-root input schemas from parameters and JSON request
  bodies, translates 3.0 nullability, flattens object `allOf` intersections when
  merging preserves the contract, maps declared responses with their media types
  and descriptive schemas, and derives explicit OR/AND authentication policies
  with copied credential metadata and required scopes. Anonymous alternatives are
  preserved, and OAuth2 scope mismatches are diagnosed. It emits deterministic
  source/contract/toolset hashes plus manifest diffs. Response schemas are
  metadata only and are not used to validate upstream payloads; authentication
  policies are not enforced. The compiler does not inject credentials.

  The repository now enforces `chainmcp/no-blocking-io` on runtime source paths,
  rejecting synchronous `fs` and `child_process` APIs, with RuleTester coverage.

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
  - @chainmcp/core@0.2.0

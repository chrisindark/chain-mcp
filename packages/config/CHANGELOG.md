# @chainmcp/config

## 0.7.0

### Minor Changes

- c8a1025: Add visual tool curation, endpoint filtering, and bidirectional configuration sync to Web Studio (M13-2):

  - `@chainmcp/declarative`: Added `enabled?: boolean` on tool descriptors, filtering out disabled tools from `DeclarativeToolSource.getTools()` while preserving descriptors in store.
  - `@chainmcp/config`: Added `tools` filter configuration (`include`, `exclude`) and `filterToolsByConfig` helper to `ContractConfigSchema` and `GatewayContractConfigSchema`.
  - `@chainmcp/admin`: Added `GET .../tools`, `GET .../tools/{toolName}`, `PATCH .../tools/{toolName}`, and `POST .../curate` endpoints with `admin_curate` audit logging and `onConfigSync` notification. Added visual Tools & Curation card in Web Studio UI.
  - `@chainmcp/cli`: Added `syncConfigToolCuration` atomic configuration sync for both `chainmcp.config.yaml` and `gateway.config.yaml` multi-contract files, and auto-restores active revisions on Studio launch.

### Patch Changes

- Updated dependencies [984d136]
  - @chainmcp/storage@0.7.0
  - @chainmcp/analytics@0.7.0
  - @chainmcp/json-navigation@0.7.0
  - @chainmcp/auth@0.7.0
  - @chainmcp/cache-redis@0.7.0
  - @chainmcp/core@0.7.0
  - @chainmcp/executor@0.7.0
  - @chainmcp/rate-limit@0.7.0

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

- Updated dependencies
  - @chainmcp/analytics@0.6.0
  - @chainmcp/auth@0.6.0
  - @chainmcp/cache-redis@0.6.0
  - @chainmcp/core@0.6.0
  - @chainmcp/executor@0.6.0
  - @chainmcp/json-navigation@0.6.0
  - @chainmcp/rate-limit@0.6.0
  - @chainmcp/storage@0.6.0

## 0.5.0

### Minor Changes

- Wire `@chainmcp/storage` persistence into runtime and administration packages:

  - `@chainmcp/json-navigation`: `ResultHandleRegistry` accepts optional `storageDriver` or `blobStore` (`BlobPayloadStore`). Added async persistence methods `storeAsync`, `storeIfLargeAsync`, and `resolveAsync`. Tools (`json_create_handle`, `json_inspect_shape`, `json_select_path`, `json_paginate`, `json_filter`) asynchronously resolve handles from storage and persist server-side handles across restarts. Zero breaking changes to synchronous in-memory usage.
  - `@chainmcp/admin`: Implemented `StorageDescriptorRevisionStore` extending `InMemoryDescriptorRevisionStore`. Uses `KeyValueStore` (`namespace: "chainmcp_revisions"`) to persist revision history partitioned per contract (`contract:${tenantId}:${contractName}`) with atomic index tracking (`contracts_index`).
  - `@chainmcp/config`: Added `StorageConfigSchema` (`driver: "memory" | "sqlite"`, `path?: string`, `busyTimeoutMs?: number`) and `createStorageDriverFromConfig()`. Added `storage` block to `ChainMcpConfigSchema` and `GatewayConfigSchema`. Updated `createHandleRegistryOptionsFromConfig` to forward `storageDriver`.
  - `@chainmcp/cli`: Wired `createStorageDriverFromConfig` and storage driver initialization in `serve`, `dev`, and generated server templates (`templates.ts`). Added `@chainmcp/storage` to `CHAINMCP_PACKAGE_DEPENDENCIES` for `--local-deps` generated projects.

### Patch Changes

- Updated dependencies
  - @chainmcp/json-navigation@0.5.0
  - @chainmcp/analytics@0.5.0
  - @chainmcp/auth@0.5.0
  - @chainmcp/cache-redis@0.5.0
  - @chainmcp/core@0.5.0
  - @chainmcp/executor@0.5.0
  - @chainmcp/rate-limit@0.5.0
  - @chainmcp/storage@0.5.0

## 0.4.1

### Patch Changes

- Updated dependencies
  - @chainmcp/core@0.4.1
  - @chainmcp/analytics@0.4.1
  - @chainmcp/auth@0.4.1
  - @chainmcp/cache-redis@0.4.1
  - @chainmcp/executor@0.4.1
  - @chainmcp/json-navigation@0.4.1
  - @chainmcp/rate-limit@0.4.1

## 0.4.0

### Patch Changes

- @chainmcp/analytics@0.4.0
  - @chainmcp/auth@0.4.0
  - @chainmcp/cache-redis@0.4.0
  - @chainmcp/core@0.4.0
  - @chainmcp/executor@0.4.0
  - @chainmcp/json-navigation@0.4.0
  - @chainmcp/rate-limit@0.4.0

## 0.3.1

### Patch Changes

- Updated dependencies
  - @chainmcp/core@0.3.1
  - @chainmcp/analytics@0.3.1
  - @chainmcp/auth@0.3.1
  - @chainmcp/cache-redis@0.3.1
  - @chainmcp/executor@0.3.1
  - @chainmcp/json-navigation@0.3.1
  - @chainmcp/rate-limit@0.3.1

## 0.3.0

### Minor Changes

- 180f2f0: Resolve credentials from the environment instead of literal config values.

  - `@chainmcp/config` exports `resolveConfigSecrets()` and `redactConfigSecrets()`. Designated secret fields accept `${VAR}` and `${VAR:-default}`; missing variables fail with `SECRET_UNRESOLVED` naming the field and variable, and non-secret fields are never interpolated.
  - `chainmcp config explain` prints the resolved configuration with credentials redacted, plus value-free provenance for each secret (`--json` supported).
  - CLI `validate`, `serve`, `dev`, `gateway serve`, and generated server templates resolve secret references before schema validation.
  - `chainmcp build` mirrors `chainmcp.manifest.json` and `compiled-tools.json` to the project root so generated servers can verify artifacts at startup.
  - Documentation no longer lists the unimplemented `CHAINMCP_DATABASE_URL`, `CHAINMCP_UPSTREAM_TIMEOUT_MS`, and `CHAINMCP_SECRET_PROVIDER` variables.

- 723c5dd: Make the dynamic gateway deployable with chainmcp gateway serve, gateway configuration schema, tools/list_changed notifications on publish/activate/disable/rollback, runnable deployment example, and multi-contract SDK end-to-end integration tests.
- 180f2f0: Documentation truth pass (P0-8).

  - README now says the project is pre-1.0 and that the 1.0 release is deliberately withheld; registry `npx @chainmcp/cli` and bare `chainmcp` examples are marked as requiring publishing or an installed CLI (clone path is `node packages/cli/dist/bin.js`); intended technology no longer lists Hono or PostgreSQL (no database metadata store ships); token accounting, JSON navigation, response-schema enforcement, and auth-policy language match the shipped behavior.
  - `docs/getting-started.md`: response schemas are enforced by the executor when `server.validateResponses` is `warn`/`enforce`; authentication policies are not enforced by the compiler. Code-first init examples now include `--local-deps`.
  - `docs/deployment.md`: generated-server install and Dockerfile steps now use pnpm in local-deps mode.
  - `docs/product-guide.md`: softened `reduce payloads by up to 90%`, `sub-millisecond`, and `military-grade` marketing claims; corrected metric names to the four emitted by `OpenTelemetryMetricsSink` (`chainmcp.tool.invocations`, `chainmcp.tool.duration`, `chainmcp.tool.tokens`, `chainmcp.tool.payload_bytes`); clarified JSON navigation requires the full document supplied inline.
  - Added a CI drift guard: `pnpm docs:check` validates that every documented capability in `docs/capability-evidence.json` points to a real test file or exported API, and that the README `## Core capabilities` bullets are all covered. Wired into `pnpm check` and CI.

- b64fd14: Allow exact token measurement from configuration.

  - `@chainmcp/config`: `tokenMetrics.tokenizer` accepts `exact`. Exact measurement requires `tokenMetrics.module` or a factory registered with `registerTokenizerFactory(modelId, factory)`. `loadTokenizerFromConfig()` resolves modules relative to the configuration directory, validates that the adapter id matches `modelId` and that it declares `measurement: "exact"`, and fails startup rather than relabeling an estimate. `TokenizerConfigError` exposes stable `TOKENIZER_SOURCE_REQUIRED`, `TOKENIZER_FACTORY_FAILED`, `TOKENIZER_MODULE_INVALID`, and `TOKENIZER_INVALID` codes. `buildRuntimeOptions()` stays synchronous and requires an injected tokenizer for exact configurations.
  - `@chainmcp/cli`: `serve`, `dev`, `gateway serve`, and generated server templates load the configured tokenizer once at startup and pass the same instance to the runtime, so `output.maxTokens` enforcement and `tokenUsage` use one counter.
  - Additive: existing `approximate` and `none` configurations behave as before.

- 46e3b31: Wire network security allowlists, rate limiting, and upstream authentication into `@chainmcp/config`:

  - Enforce strict hostname validation and lowercase normalization on `security.allowedUpstreamHosts`, rejecting schemes, ports, paths, queries, credentials, and wildcards.
  - Export `normalizeAllowedHost` and `normalizeHostname` from `@chainmcp/executor`.
  - Add `rateLimit` and `auth` schema sections to `ChainMcpConfigSchema`.
  - Add factory and wiring helpers: `buildExecutorOptions`, `buildRuntimeOptions`, `createRateLimiterFromConfig`, `createAuthorizerFromConfig`, and `createUpstreamCredentialProviderFromConfig`.

- 8252a3a: Implement Milestone 6: JSON navigation, structured logging, and analytics.

  - Add `@chainmcp/json-navigation` with bounded JSON path selection, shape inspection, pagination, declarative filtering, and MCP tool definitions.
  - Add portable `Logger`, `LogLevel`, `LogRecord`, and `LogCorrelationContext` interfaces to `@chainmcp/core` and integrate correlated lifecycle logging in `InMemoryToolRuntime`.
  - Add `@chainmcp/analytics` with `createLogger`, multi-sink routing (`ConsoleSink`, `MemorySink`, `MultiSink`), case-insensitive secret scrubbing, token pattern redaction, default request/response body exclusion, dedicated security `auditSink`, OpenTelemetry metrics (`OpenTelemetryMetricsSink`) and tracing (`ToolTracer`), and `RollingAnalyticsAggregator`.
  - Add `logging`, `jsonNavigation`, and `analytics` schemas and wiring helpers to `@chainmcp/config`.

- 8df778b: Measure `RuntimeEvent.durationMs` with a monotonic `performance.now` clock instead of the wall clock, so system clock adjustments cannot distort or invert durations. Add `RuntimeOptions.monotonicNow` for deterministic tests; `RuntimeOptions.now` now only supplies the event `timestamp`. Add publish metadata (`license`, `repository`, `publishConfig`) to `@chainmcp/core` and `@chainmcp/config`.
- b64fd14: Add a `GET /readyz` readiness probe that reflects dependency reachability and follows the configured failure policy.

  - `@chainmcp/server`: `serveHttp` accepts `readiness: { deps: [{ name, check, degradedReady? }] }`. `GET /readyz` runs each check (errors swallowed, never mirrored) and returns `200 {"status":"ready"}` when all pass, `200 {"status":"degraded"}` when only `degradedReady` deps fail, and `503 {"status":"not_ready"}` when a non-degraded dep fails. `GET /health` and `GET /livez` remain liveness-only and never touch dependencies. With no deps configured, `/readyz` returns ready with no dependency detail.
  - `@chainmcp/config`: new `buildReadinessDeps(config, { rateLimiter, cacheStore })` emits one dep per Redis-backed dependency, using the same client instances as the runtime. The rate limiter probes `eval("return 1")`; the cache store probes a read of an absent key (proves liveness without writing). Both are bounded by a 500 ms probe timeout. A `fail-open` limiter is reported `degradedReady`, mirroring the call path, so an unreachable Redis keeps `/readyz` at 200 `degraded`; a `fail-closed` limiter or cache outage returns 503. Exported `ReadinessDep` type for embedded use.
  - `@chainmcp/cli`: `serve` (HTTP), `gateway serve` (HTTP), and generated server templates pass `buildReadinessDeps` output to `serveHttp`.
  - Additive: existing deployments without the wiring behave as before; `/health` and `/livez` responses are unchanged.

- b64fd14: Connect JSON navigation to a tenant- and principal-scoped result-handle registry (P1-2).

  - `@chainmcp/json-navigation`: new `ResultHandleRegistry` (`src/handles.ts`) — opaque `rhv1.<counter>.<tag>` handles where the tag is an HMAC of `tenantId|principalId|counter` under a per-registry secret, so tenant/principal ids are never embedded and a tampered handle fails verification. Bounded per-principal LRU, per-tenant cap, absolute cap, per-document byte cap, and total-bytes cap, with a TTL. Stable `RESULT_HANDLE_EXPIRED` for unknown, expired, evicted, tampered, cross-tenant, and cross-principal handles (no existence leak across scopes); `ResultHandleTooLargeError` for documents above the byte cap instead of silent truncation. `createJsonNavigationTools(limits?, handleRegistry?)` now registers five tools: the four existing navigation tools accept either `json` or `handle`, and a new `json_create_handle` tool stores a document once and returns `{ handle, bytes }`.
  - `@chainmcp/config`: new `jsonNavigation.handles` schema (`enabled`, `maxPerPrincipal`, `maxPerTenant`, `maxTotal`, `maxBytes`, `maxTotalBytes`, `ttlMs`, `minBytes`) and `createHandleRegistryOptionsFromConfig()` wiring helper.
  - `@chainmcp/cli`: `serve` (both code-first and compiled paths), `dev`, and generated server templates pass registry options from config into `createJsonNavigationTools`; tool counts updated from 4 to 5 navigation tools.
  - Additive: inline-`json` callers are unaffected; the result-handle docs previously claimed no handles existed (README, product guide), and those statements are corrected.

- 0097d0b: Add Streamable HTTP and SSE transports to `@chainmcp/server`, with inbound authentication verifiers (Bearer tokens, API keys, JWT), CLI `--transport http` support, Docker EXPOSE, and MCP Inspector conformance verification.
- b64fd14: Paginate `tools/list` with revision-bound cursors.

  - `@chainmcp/server`: `McpServerOptions.toolsPageSize` (default `100`; `0` disables pagination) applies to both the single-tenant snapshot path and the multi-tenant per-request path. Pages are ordered deterministically by tool name, and `nextCursor` is opaque and bound to the listing revision. Stale, malformed, and cross-tenant cursors fail with the stable `STALE_CURSOR` error.
  - `@chainmcp/config`: `server.toolsPageSize` defaults to `100` and accepts `0`.
  - `@chainmcp/cli`: `serve`, `dev`, `gateway serve`, and generated server templates pass `server.toolsPageSize` through to the adapter.
  - Additive: clients that request `tools/list` without a cursor still receive the complete listing because the MCP client aggregates pages.

- 8c8483c: Wire caching, token metrics, and declarative output projection configuration schemas and runtime factories with support for in-memory and Redis backends, opt-in read caching for compiled GET operations, tokenizer registration, and maxResponseBytes enforcement.

### Patch Changes

- 99483c5: Apply Apache License 2.0 across all workspace packages, completing Milestone 0 licensing. Upgrade @modelcontextprotocol/server and @modelcontextprotocol/client to 2.3.1 to resolve upstream security advisories.
- 147ef5e: Implement Milestone 10: Stable 1.0 release gates and production readiness.

  - Public API review and interface stabilization across all workspace packages.
  - Supported version matrix published in `docs/supported-versions.md` covering Node.js (>=20.11, 20 & 22 LTS), operating systems, OpenAPI (3.0.x & 3.1.x), MCP TypeScript SDK v2, Redis (7+), and configuration version 1.
  - Security and dependency audit (`pnpm audit`) verified zero high or critical vulnerabilities; updated threat model and disposition in `docs/risk-register.md`.
  - Comprehensive load, resilience, and fault-injection test suites in `@chainmcp/core` and `@chainmcp/executor` verifying graceful degradation under cache/limiter outages, network drops, socket aborts, 5xx server errors, DNS failures, redirect loops, and in-flight cooperative cancellations (`AbortSignal`).
  - Migration and rollback procedures for standalone generated servers and the dynamic gateway in `docs/migration-and-rollback.md` and runtime troubleshooting in `docs/troubleshooting.md`.
  - CycloneDX 1.5 JSON Software Bill of Materials (SBOM) generator script (`scripts/generate-sbom.mjs`) and `pnpm sbom` command.
  - Automated release workflow in `.github/workflows/release.yml` with signed npm provenance (`--provenance`) and Changesets publishing.
  - Recorded ADR 0027: Stable 1.0 Release and Production Readiness.

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
- Updated dependencies [26e83fe]
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
- Updated dependencies [46e3b31]
- Updated dependencies [8252a3a]
- Updated dependencies [998b681]
- Updated dependencies [8df778b]
- Updated dependencies [5ea3ece]
- Updated dependencies [b64fd14]
- Updated dependencies [8c8483c]
  - @chainmcp/executor@0.3.0
  - @chainmcp/core@0.3.0
  - @chainmcp/analytics@0.3.0
  - @chainmcp/auth@0.3.0
  - @chainmcp/rate-limit@0.3.0
  - @chainmcp/json-navigation@0.3.0
  - @chainmcp/cache-redis@0.3.0

## 0.2.0

### Minor Changes

- 180f2f0: Resolve credentials from the environment instead of literal config values.

  - `@chainmcp/config` exports `resolveConfigSecrets()` and `redactConfigSecrets()`. Designated secret fields accept `${VAR}` and `${VAR:-default}`; missing variables fail with `SECRET_UNRESOLVED` naming the field and variable, and non-secret fields are never interpolated.
  - `chainmcp config explain` prints the resolved configuration with credentials redacted, plus value-free provenance for each secret (`--json` supported).
  - CLI `validate`, `serve`, `dev`, `gateway serve`, and generated server templates resolve secret references before schema validation.
  - `chainmcp build` mirrors `chainmcp.manifest.json` and `compiled-tools.json` to the project root so generated servers can verify artifacts at startup.
  - Documentation no longer lists the unimplemented `CHAINMCP_DATABASE_URL`, `CHAINMCP_UPSTREAM_TIMEOUT_MS`, and `CHAINMCP_SECRET_PROVIDER` variables.

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

- 46e3b31: Wire network security allowlists, rate limiting, and upstream authentication into `@chainmcp/config`:

  - Enforce strict hostname validation and lowercase normalization on `security.allowedUpstreamHosts`, rejecting schemes, ports, paths, queries, credentials, and wildcards.
  - Export `normalizeAllowedHost` and `normalizeHostname` from `@chainmcp/executor`.
  - Add `rateLimit` and `auth` schema sections to `ChainMcpConfigSchema`.
  - Add factory and wiring helpers: `buildExecutorOptions`, `buildRuntimeOptions`, `createRateLimiterFromConfig`, `createAuthorizerFromConfig`, and `createUpstreamCredentialProviderFromConfig`.

- 8252a3a: Implement Milestone 6: JSON navigation, structured logging, and analytics.

  - Add `@chainmcp/json-navigation` with bounded JSON path selection, shape inspection, pagination, declarative filtering, and MCP tool definitions.
  - Add portable `Logger`, `LogLevel`, `LogRecord`, and `LogCorrelationContext` interfaces to `@chainmcp/core` and integrate correlated lifecycle logging in `InMemoryToolRuntime`.
  - Add `@chainmcp/analytics` with `createLogger`, multi-sink routing (`ConsoleSink`, `MemorySink`, `MultiSink`), case-insensitive secret scrubbing, token pattern redaction, default request/response body exclusion, dedicated security `auditSink`, OpenTelemetry metrics (`OpenTelemetryMetricsSink`) and tracing (`ToolTracer`), and `RollingAnalyticsAggregator`.
  - Add `logging`, `jsonNavigation`, and `analytics` schemas and wiring helpers to `@chainmcp/config`.

- 8df778b: Measure `RuntimeEvent.durationMs` with a monotonic `performance.now` clock instead of the wall clock, so system clock adjustments cannot distort or invert durations. Add `RuntimeOptions.monotonicNow` for deterministic tests; `RuntimeOptions.now` now only supplies the event `timestamp`. Add publish metadata (`license`, `repository`, `publishConfig`) to `@chainmcp/core` and `@chainmcp/config`.
- 0097d0b: Add Streamable HTTP and SSE transports to `@chainmcp/server`, with inbound authentication verifiers (Bearer tokens, API keys, JWT), CLI `--transport http` support, Docker EXPOSE, and MCP Inspector conformance verification.
- 8c8483c: Wire caching, token metrics, and declarative output projection configuration schemas and runtime factories with support for in-memory and Redis backends, opt-in read caching for compiled GET operations, tokenizer registration, and maxResponseBytes enforcement.

### Patch Changes

- 99483c5: Apply Apache License 2.0 across all workspace packages, completing Milestone 0 licensing. Upgrade @modelcontextprotocol/server and @modelcontextprotocol/client to 2.3.1 to resolve upstream security advisories.
- 147ef5e: Implement Milestone 10: Stable 1.0 release gates and production readiness.

  - Public API review and interface stabilization across all workspace packages.
  - Supported version matrix published in `docs/supported-versions.md` covering Node.js (>=20.11, 20 & 22 LTS), operating systems, OpenAPI (3.0.x & 3.1.x), MCP TypeScript SDK v2, Redis (7+), and configuration version 1.
  - Security and dependency audit (`pnpm audit`) verified zero high or critical vulnerabilities; updated threat model and disposition in `docs/risk-register.md`.
  - Comprehensive load, resilience, and fault-injection test suites in `@chainmcp/core` and `@chainmcp/executor` verifying graceful degradation under cache/limiter outages, network drops, socket aborts, 5xx server errors, DNS failures, redirect loops, and in-flight cooperative cancellations (`AbortSignal`).
  - Migration and rollback procedures for standalone generated servers and the dynamic gateway in `docs/migration-and-rollback.md` and runtime troubleshooting in `docs/troubleshooting.md`.
  - CycloneDX 1.5 JSON Software Bill of Materials (SBOM) generator script (`scripts/generate-sbom.mjs`) and `pnpm sbom` command.
  - Automated release workflow in `.github/workflows/release.yml` with signed npm provenance (`--provenance`) and Changesets publishing.
  - Recorded ADR 0027: Stable 1.0 Release and Production Readiness.

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

- Updated dependencies [26e83fe]
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
- Updated dependencies [46e3b31]
- Updated dependencies [8252a3a]
- Updated dependencies [998b681]
- Updated dependencies [8df778b]
- Updated dependencies [8c8483c]
  - @chainmcp/executor@0.2.0
  - @chainmcp/core@0.2.0
  - @chainmcp/analytics@0.2.0
  - @chainmcp/auth@0.2.0
  - @chainmcp/rate-limit@0.2.0
  - @chainmcp/json-navigation@0.2.0
  - @chainmcp/cache-redis@0.2.0

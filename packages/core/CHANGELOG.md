# @chainmcp/core

## 0.2.0

### Minor Changes

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
- 1bb1a2a: Enforce bounded JSON Schema constraints in generated validators.

  The runtime now supports string `minLength`/`maxLength`, `pattern`, asserted
  `format` values, numeric bounds and `multipleOf`, array length and structural
  `uniqueItems`, and object property counts. Patterns use the linear-time
  `re2js` engine, invalid or oversized patterns fail registration, and structural
  uniqueness fails closed when its bounded comparison budget is exceeded. The
  compiler preserves these constraints and normalizes OpenAPI 3.0 boolean
  exclusive bounds to the JSON Schema numeric form.

  Add `examples/petstore`, a compiled stdio MCP server wired to a deterministic
  mock upstream, plus `docs/getting-started.md` and `pnpm conformance:inspector`.
  The Inspector check exercises `tools/list` and `tools/call` and runs in CI.

- c371655: Add a bounded in-memory LRU `CacheStore` adapter and move cache keys to v2
  with a required non-secret `authorizationPartition`. `createCacheKey` now
  rejects blank identity fields, and the store rejects callable `toJSON` values.
  Wire opt-in per-tool caching into invocation: reads run after authorization,
  validation, and rate limiting, and key, partition, read, and write failures
  bypass caching instead of failing the call. Report `cacheOutcome` on invocation
  events and add exact-match `invalidateCachedResult` for trusted operator code.
  Add an optional `Tokenizer` adapter that records exact or estimated token counts
  and the serialized payload size on successful invocation events. Add per-tool
  output projection and token budgets: `ToolDefinition.output` opts into a
  deployment-supplied `ResultProjector`, and `maxTokens` rejects over-budget or
  uncountable results before caching or returning them. Projected output must be
  JSON, cached entries contain only the projection, and projection/budget failures
  never fall back to the raw result. Add `createFieldProjector()` with bounded
  declarative `output.fields` include/exclude paths. Add `@chainmcp/cache-redis`,
  an optional shared cache adapter with validated keys/values, bounded TTL and
  entry size, and per-command timeouts. Runtime caching, measurement, projection,
  and budgets remain disabled unless the deployment configures them and a tool
  opts in.
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

- 8252a3a: Implement Milestone 6: JSON navigation, structured logging, and analytics.

  - Add `@chainmcp/json-navigation` with bounded JSON path selection, shape inspection, pagination, declarative filtering, and MCP tool definitions.
  - Add portable `Logger`, `LogLevel`, `LogRecord`, and `LogCorrelationContext` interfaces to `@chainmcp/core` and integrate correlated lifecycle logging in `InMemoryToolRuntime`.
  - Add `@chainmcp/analytics` with `createLogger`, multi-sink routing (`ConsoleSink`, `MemorySink`, `MultiSink`), case-insensitive secret scrubbing, token pattern redaction, default request/response body exclusion, dedicated security `auditSink`, OpenTelemetry metrics (`OpenTelemetryMetricsSink`) and tracing (`ToolTracer`), and `RollingAnalyticsAggregator`.
  - Add `logging`, `jsonNavigation`, and `analytics` schemas and wiring helpers to `@chainmcp/config`.

- 998b681: Implement Milestone 8: Tool Sources and Code-First Authoring.

  - Add `@chainmcp/core` `ToolSource` boundary interface and `InMemoryToolRuntime.registerSource()`.
  - Add `OpenApiToolSource` in `@chainmcp/executor` wrapping compiled operations and `UpstreamExecutor`.
  - Add `@chainmcp/authoring` package with `defineTool()` authoring facade, `ManualToolSource`, and `zodToJsonSchema()` lowering with definition-time schema audits against the supported JSON Schema subset.
  - Add policy parity tests (`packages/authoring/tests/parity.test.ts`) asserting 100% equivalence between manual and compiled tools across input validation, authorization scopes, rate limiting, cooperative cancellation/timeout, output projection, result caching, and safe error masking.
  - Add `chainmcp init --blank` in `@chainmcp/cli` to scaffold contract-free, code-first MCP server projects with example tools and build templates.
  - Add `chainmcp dev` in `@chainmcp/cli` for a local developer authoring loop over stdio.
  - Add runnable code-first example in `examples/code-first` with automated integration tests over the official MCP SDK client.
  - Update documentation in `docs/getting-started.md`, `API_REFERENCE.md`, `CONFIGURATION.md`, and `ARCHITECTURE.md`, accept ADR 0019, and record ADR 0025.

- 8df778b: Measure `RuntimeEvent.durationMs` with a monotonic `performance.now` clock instead of the wall clock, so system clock adjustments cannot distort or invert durations. Add `RuntimeOptions.monotonicNow` for deterministic tests; `RuntimeOptions.now` now only supplies the event `timestamp`. Add publish metadata (`license`, `repository`, `publishConfig`) to `@chainmcp/core` and `@chainmcp/config`.

### Patch Changes

- 99483c5: Apply Apache License 2.0 across all workspace packages, completing Milestone 0 licensing. Upgrade @modelcontextprotocol/server and @modelcontextprotocol/client to 2.3.1 to resolve upstream security advisories.
- f51ff52: Hardened release evidence with Node 20/22 CI matrix, transitive CycloneDX 1.5 SBOM, and high-concurrency multi-tenant load and fault-injection test suite.
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

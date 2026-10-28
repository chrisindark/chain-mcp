# Changelog

All notable project changes are recorded here.

The project is pre-release. Versions and release dates must reflect actual published artifacts.

## Unreleased

### Security

- **RM-04 configurable CORS allowlist & dynamic header computation:** Replaced arbitrary origin reflection with a configurable CORS allowlist (`server.cors` with `enabled`, `allowedOrigins`, `allowedHeaders`, `allowCredentials`, `maxAgeSeconds`). Enforced parse-time and startup rejection of wildcard origin `*` when `allowCredentials: true` is configured. Sandboxed `null` origin is rejected with 403 Forbidden on preflights and omitted from response headers unless explicitly listed in `allowedOrigins`. HTTP responses attach `Vary: Origin` whenever CORS is active. Dynamic header computation derives `Access-Control-Allow-Headers` from configured verifiers (`InboundAuthVerifier.headerNames`), custom headers, and defaults without drift. CORS defaults to disabled on non-loopback bindings and warns on wildcard loopback bindings.
- **RM-03 HTTP inbound auth fail closed & secure defaults:** Enforced fail-closed behavior for HTTP servers and gateways bound to non-loopback network interfaces (e.g. `0.0.0.0`, LAN/public IPs), refusing to start unauthenticated unless `security.allowUnauthenticatedHttp: true` (or `--allow-unauthenticated-http`) is explicitly configured. Added immediate startup fail-fast validation when `requireInboundAuth: true` or `authorizer: "scope"` is configured without a corresponding inbound verifier. Unauthenticated servers on loopback interfaces (`127.0.0.1`, `localhost`, `::1`) or with explicit overrides emit structured startup warnings detailing the host, port, exposed tool count, and configuration remedies. Resolved security posture is logged at startup.
- **RM-02 HTTP request size, Host, Origin, and DNS-rebinding limits:** Enforced pre-buffering `Content-Length` cap checks and streaming body chunk limits defaulting to 1 MiB (`maxRequestBytes`), rejecting oversized payloads with HTTP 413 without unbounded memory buffering. Added strict `Host` header syntax and presence validation (HTTP 400). Added DNS-rebinding and unauthorized host/origin protections via `allowedHosts`, `allowedOrigins`, and `enableDnsRebindingProtection` (HTTP 403) without echoing untrusted values in responses. Enforced HTTP server `requestTimeout` and socket termination on slow-body clients. Wired these options through `@chainmcp/config`, `@chainmcp/server`, CLI serve commands, and server templates.
- **RM-01 inbound verifier prototype-chain auth bypass fix:** Replaced prototype-walking `in` checks with own-property checks (`Object.hasOwn`) in `createBearerTokenVerifier` and `createApiKeyVerifier`. Added strict runtime validation for candidate principals (`validatePrincipal` requiring non-empty string `tenantId` and `principalId`, and string array `scopes`) across configured maps, custom `verifyToken`/`verifyKey` callbacks, and JWT `mapClaims`, ensuring malformed or prototype-derived credentials fail closed with HTTP 401 unauthenticated.

### Documentation

- Document Milestone 10 stable release gates, supported version matrix, operational troubleshooting, migration and rollback procedures, SBOM generation, and release provenance in `docs/supported-versions.md`, `docs/migration-and-rollback.md`, `docs/troubleshooting.md`, `RELEASES.md`, `ROADMAP.md`, `docs/risk-register.md`, and ADR 0027.
- Document dynamic gateway architecture, versioned contract registry, atomic reloads, tenant policy binding, per-contract authentication and network policies, and rollback in `docs/dynamic-gateway.md`, `API_REFERENCE.md`, `ARCHITECTURE.md`, `ROADMAP.md`, ADR 0008 (accepted), and ADR 0026.
- Document tool sources and code-first authoring, `@chainmcp/authoring`, `defineTool()`, schema lowering and audit, `chainmcp init --blank`, `chainmcp dev`, and policy parity in `docs/getting-started.md`, `API_REFERENCE.md`, `CONFIGURATION.md`, `ARCHITECTURE.md`, `ROADMAP.md`, ADR 0019 (accepted), and ADR 0025.
- Document developer CLI commands, generation manifests, reproducibility requirements, and containerization in `docs/generated-servers.md`, `docs/deployment.md`, `API_REFERENCE.md`, `ARCHITECTURE.md`, `ROADMAP.md`, and ADR 0024.
- Document JSON navigation, structured logging, OpenTelemetry integration, and analytics aggregation in `docs/json-navigation.md`, `docs/analytics.md`, `API_REFERENCE.md`, `CONFIGURATION.md`, `ROADMAP.md`, and ADR 0023.
- Document configuration wiring for network security, upstream credentials, and rate limiting in `CONFIGURATION.md`, `API_REFERENCE.md`, `ROADMAP.md`, and ADR 0022.
- Document authentication, upstream credentials, encrypted secret storage, and distributed rate limiting in `docs/authentication.md`, `docs/rate-limiting.md`, `API_REFERENCE.md`, `CONFIGURATION.md`, `ARCHITECTURE.md`, `SECURITY.md`, and ADR 0021.
- Define product vision and package boundaries.
- Specify generated-server and dynamic-gateway modes.
- Define configuration and public interface contracts.
- Document security requirements and release gates.
- Establish coding-agent workflow and roadmap milestones.
- Add explicit production logging requirements to Milestone 6.
- Document timeout and cancellation as cooperative `AbortSignal` propagation, with executor responsibility for resource release.
- Record ADRs 0001–0009 and maintain an ADR index with current statuses.
- Document the implemented Milestone 1 `RuntimeEvent` shape and mark `cache_hit`, `tokenCount`, `attributes`, and optional event fields as Milestone 4/6 targets rather than current behavior.
- Document authorization and rate-limit adapter contracts, including the distinction between policy denial and adapter failure.
- Record ADR 0008, the MCP authorization mapping (tenant-bound registration, tenancy modes, identity-scoped listing), and document the tenant-bound runtime groundwork in `API_REFERENCE.md` and `ARCHITECTURE.md`.
- Document the `@chainmcp/auth` package and its `OperationScopeAuthorizer` default, including the exact-match scope semantics and the protected-diagnostics cause contract.
- Document the first Milestone 3 compiler slice, its supported/rejected OpenAPI surface, deterministic manifest hashes, and its metadata-only boundary in `API_REFERENCE.md`, `ARCHITECTURE.md`, `docs/openapi-support.md`, and ADR 0015.
- Document response metadata mapping and object `allOf` flattening, including the unvalidated status of response schemas and the remaining input union-composition limits, in `API_REFERENCE.md`, `ARCHITECTURE.md`, `docs/openapi-support.md`, and ADR 0016.
- Document explicit OR/AND authentication policy mapping, anonymous alternatives, scope validation, and the unenforced boundary in `API_REFERENCE.md`, `ARCHITECTURE.md`, `docs/openapi-support.md`, and ADR 0017.
- Document the upstream executor, request/response mapping, destination policy, cancellation binding, and remaining credential/validation limits in `API_REFERENCE.md`, `ARCHITECTURE.md`, `SECURITY.md`, `docs/openapi-support.md`, `docs/generated-servers.md`, and ADR 0018.
- Document the `chainmcp/no-blocking-io` lint rule and its runtime-source scope in `DEVELOPMENT.md`.
- Add Milestone 8 (tool sources and code-first authoring), renumber the dynamic gateway and stable release to Milestones 9 and 10, and record ADR 0019. Scaffold, `defineTool()`, `chainmcp dev`, and code-first docs are in the 1.0 path; the declarative tool builder and admin UI are explicitly post-1.0 and are not a 1.0 release gate.

### Implementation

- **RM-11 support form, multipart, and cookie parameters:**
  - Extended compiler to support `in: "cookie"` parameters with RFC 6265 token name validation, `style: "form"` enforcement, and optional `explode`.
  - Added compile-time recognition of `application/x-www-form-urlencoded` and `multipart/form-data` request bodies alongside `application/json` (and `+json`), emitting a discriminated `kind: "json" | "form-urlencoded" | "multipart"` and `encodings` map. Unsupported request body media types are rejected with `REQUEST_BODY_UNSUPPORTED`.
  - Implemented executor serialization for `cookie` parameters: values are validated against CRLF, control characters, and semicolons to eliminate header/cookie injection vectors, formatted with form style, and injected into the `Cookie` header. Transport-owned and credential cookies take precedence and overwrite matching parameter names.
  - Implemented executor serialization for `application/x-www-form-urlencoded` request bodies with OpenAPI `style`/`explode` semantics (nested objects with `explode: true` expand to top-level fields, `explode: false` format as comma-separated pairs; arrays expand to repeated keys or comma-separated items).
  - Implemented executor serialization for `multipart/form-data` request bodies with unique boundary framing, per-part `Content-Disposition`, `Content-Type`, text fields, binary base64 decoding, and JSON object parts. Enforced fail-closed caps per part (`maxMultipartPartBytes`, default 1 MiB) and total request (`maxRequestBytes`, default 1 MiB), and strictly rejected CRLF in part names and filenames.
  - Added `server.maxMultipartPartBytes` to configuration schema in `@chainmcp/config` and wired into `buildExecutorOptions`.
  - Added request body media-type matrix and cookie parameter specifications to `docs/openapi-support.md`, `CONFIGURATION.md`, `SECURITY.md`, `API_REFERENCE.md`, `ARCHITECTURE.md`, `ROADMAP.md`, and `REMEDIATION_PLAN.md`.
- **RM-10 bound serialization and add response-schema validation:**
  - Implemented streaming bounded JSON serializer `stringifyBounded(value, options)` in `@chainmcp/core` with byte limit (`maxBytes`), depth limit (`maxDepth`), and node limit (`maxNodes`). Traversal halts immediately with `SerializationLimitError` when limits are reached without buffering full string allocations or accessing subsequent properties. Rejects circular structures safely via object identity tracking.
  - Replaced unbounded `JSON.stringify` with `stringifyBounded` across `@chainmcp/core` (`serializeOutput`, `applyOutputPolicy`, `measureTokens`), `@chainmcp/server` (`toolCallResult`), and `@chainmcp/json-navigation` (`assertResultBytes`).
  - Added tool invocation input size cap: `InMemoryToolRuntime.callTool` runs `assertInputSize` during validation phase (after authorization) before schema validation runs, rejecting oversized inputs with stable `INPUT_TOO_LARGE` code, limit, and observed byte count.
  - Implemented upstream response schema validation in `@chainmcp/executor`: matches responses by status code, range (`2XX`), or `default` fallback, and validates against compiled response schemas using `validateJsonSchema`. Configurable via `server.validateResponses` with modes `"off"`, `"warn"` (default; logs warning and audit event with redacted response payload), and `"enforce"` (fails closed with `UPSTREAM_FAILURE` without body leakage).
  - Extended configuration schema in `@chainmcp/config` with `server.maxToolInputBytes` (default 1,048,576 bytes) and `server.validateResponses` (`off` | `warn` | `enforce`, default `"warn"`).
  - Documented bounded serialization and response validation in `CONFIGURATION.md`, `ARCHITECTURE.md`, `API_REFERENCE.md`, `docs/troubleshooting.md`, and `ROADMAP.md`.
- **RM-09 reject unsupported security schemes `mutualTLS` and `openIdConnect`:**
  - Added compile-time rejection and warning diagnostics for unsatisfiable OpenAPI security schemes `mutualTLS` and `openIdConnect` via diagnostic code `UNSUPPORTED_SECURITY_SCHEME`.
  - In strict mode (`strict: true`, default), specs declaring `mutualTLS` or `openIdConnect` fail compilation and `chainmcp validate` with a diagnostic error, preventing runtime credential-resolution failures.
  - In permissive mode (`strict: false`), compilation succeeds with structured warnings preserved in `CompileManifest.warnings`, surviving into `compiled-tools.json` and `chainmcp.manifest.json`.
  - Added security scheme support matrix to `docs/openapi-support.md` and detailed satisfiability documentation in `docs/authentication.md`.
- **RM-08 code-first project support across `serve`, `build`, and `export`:**
  - Made `validateCommand` contract-optional. Contract-driven projects compile and validate the OpenAPI specification as before, while contract-free projects validate configuration, check entrypoint existence (`src/tools.ts`, `src/server.ts`), and discover code-first tools, returning `contractKind: "code-first"`.
  - Added `--require-contract` flag to `validate`, `build`, `serve`, and `export` to enforce contract requirement where desired.
  - Updated `serveCommand` to run code-first projects in-process over both `stdio` and Streamable HTTP (`http`) transports using the shared `InMemoryToolRuntime`, ensuring consistent signal handling, rate limiting, and JSON navigation, and rejecting empty toolsets with an explicit error.
  - Updated `buildCommand` to generate deterministic code-first project manifests (`chainmcp.manifest.json`) and `compiled-tools.json`, supporting reproducibility verification via `--check`.
  - Updated `exportCommand` to export standalone code-first projects, copying source files from `src/`, generating contract-free configs and Dockerfiles, and emitting code-first manifests.
  - Added `loadCodeFirstTools`, `discoverCodeFirstEntrypoint`, and `buildCodeFirstManifest` to `@chainmcp/cli`.
- **RM-07 remote specification loading unification & SSRF-safe fetch policy:**
  - Implemented unified `loadSpec` module in `@chainmcp/cli` (`packages/cli/src/spec-loader.ts`) with strict SSRF-safe fetch policy.
  - Required HTTPS by default for all remote specifications; plain HTTP is restricted exclusively to loopback/private hosts when opted into via `--allow-http` or `security.allowInsecureHttp: true`, and strictly rejected for public endpoints.
  - Blocked loopback, private, link-local, shared, documentation, and reserved IP ranges for public URLs to protect against SSRF.
  - Unconditionally blocked cloud metadata IP endpoints (`169.254.169.254`, `100.100.100.200`, `192.0.0.192`).
  - Pinned resolved IP addresses to connection sockets via the transport `lookup` hook and verified peer addresses on connect to eliminate DNS rebinding and TOCTOU vulnerabilities.
  - Handled redirects manually with hop-by-hop SSRF re-validation, capped at `maxRedirects` (default 3), and rejected HTTPS-to-HTTP downgrades.
  - Strictly validated response content-types, accepting only JSON and YAML specifications and rejecting `text/html`.
  - Streamed response bodies with streaming byte caps (`maxBytes`, default 10 MiB) and abort timeouts (`timeoutMs`, default 10,000ms).
  - Eliminated duplicated raw `fetch` calls across `init`, `validate`, `build`, `diff`, `dev`, `serve`, and `export`, and enabled URL specification loading for `serve` and `export`.
  - Added `--json` output support to `chainmcp validate`, exposing `resolvedSource` and `specBytes`.
  - Re-exported `classifyAddress`, `canonicalizeIp`, `isSameAddress`, `systemHostResolver`, and `AddressClass` from `@chainmcp/executor`.

- **RM-06 upstream base URL scheme, port, and path prefix preservation:**
  - Added `contract.baseUrl` and `BaseUrlSchema` to `@chainmcp/config`, strictly validating absolute `http://` or `https://` URLs, rejecting credentials (`user:pass@`), query parameters, and fragments, and canonically normalizing trailing slashes.
  - Added `security.allowInsecureHttp` (default `false`) across configuration schemas and wiring helpers, requiring explicit opt-in for unencrypted plain HTTP upstreams.
  - Auto-derives `contract.baseUrl` host into `security.allowedUpstreamHosts` while preserving explicit extra allowlisted hosts.
  - Updated `chainmcp init` to capture and record the full normalized base URL (scheme, port, and path prefix) into `contract.baseUrl` and sets `allowInsecureHttp: true` when targeting HTTP endpoints.
  - Replaced legacy synthesis of `https://${allowedUpstreamHosts[0]}` across `serve`, `dev`, `export`, and `renderServerTs` with proper resolution order (`options.baseUrl` -> `config.contract.baseUrl` -> legacy fallback).
  - Added `validateCommand` diagnostics: emits warning when `contract.baseUrl` host was not explicitly declared in `security.allowedUpstreamHosts`, emits `CONFIG_DEPRECATED` when `contract.baseUrl` is omitted from contract configurations, and emits an error when insecure HTTP is used without `security.allowInsecureHttp: true`.
  - Updated `@chainmcp/executor` destination policy to permit loopback destinations (`127.0.0.1`, `::1`) when `allowInsecureHttp: true` is configured, enabling local development and self-hosted gateway targets while preserving public-only SSRF protection for remote traffic.

- **RM-05 OpenAPI ignored constructs rejection & strict parameter validation:** Enforced explicit compile-time diagnostics for accepted-but-ignored OpenAPI constructs to prevent silent contract weakening:
  - Path-item and operation-level `servers` overrides are rejected in strict mode with `UNSUPPORTED_SERVERS` (or warned in permissive mode `strict: false`), ensuring all operations adhere to the configured upstream `baseUrl`.
  - Inbound `callbacks` (webhooks) are rejected in strict mode with `UNSUPPORTED_CALLBACKS` (or warned in permissive mode).
  - Parameter `style`, `explode`, and `allowReserved` are strictly validated: non-default combinations (`style: "deepObject"` or non-form on query, non-simple on path/header, `explode: false` on query, `explode: true` on path/header, `allowReserved: true` on query, or misplaced properties) are rejected with `PARAMETER_UNSUPPORTED` or `PARAMETER_INVALID` in strict mode (or warned and defaulted in permissive mode).
  - Unknown parameter properties are strictly rejected with `PARAMETER_INVALID` in strict mode (or warned in permissive mode), while OpenAPI extensions (`x-*`) remain accepted.
  - All warnings in permissive mode survive into `CompileManifest.warnings` and `CompiledOperation.warnings`, persisting into `compiled-tools.json` and `chainmcp.manifest.json`.

- Complete Milestone 10 (Stable release):
  - Add comprehensive load, resilience, and fault-injection test suites in `@chainmcp/core` and `@chainmcp/executor` covering cache/limiter degradation, observability sink isolation, network drops, socket aborts, 5xx errors, DNS resolution failures, and in-flight cooperative cancellations (`AbortSignal`).
  - Publish supported-version matrix and compatibility policy in `docs/supported-versions.md`.
  - Document operational troubleshooting in `docs/troubleshooting.md` and deterministic migration and rollback workflows in `docs/migration-and-rollback.md`.
  - Add CycloneDX 1.5 JSON SBOM generation script (`scripts/generate-sbom.mjs`) with `pnpm sbom` and `pnpm sbom:check`.
  - Configure automated release workflow in `.github/workflows/release.yml` with cryptographic npm provenance (`--provenance`) and Changesets publishing.
  - Satisfy all Version 1.0 exit criteria and release checklist items in `RELEASES.md`.
  - Record ADR 0027: Stable 1.0 Release and Production Readiness.
- Complete Milestone 9 (Dynamic gateway):
  - Add `@chainmcp/gateway` package providing `DynamicGateway`, `ContractRegistry`, `createGatewayServer`, and `connectGatewayServer`.
  - Add immutable versioned contract revisions with deterministic digest IDs, source hashing, tool definitions, destination policies, auth configurations, and resource limits.
  - Add candidate compilation and validation in isolation with `@chainmcp/compiler` and `@chainmcp/executor`, auditing all input schemas and destination allowlists before activation.
  - Enforce intra-revision and intra-tenant tool name collision rejection, while allowing clean duplicate names across distinct tenants without conflict.
  - Implement atomic runtime state swap (`this.activeRuntime = nextRuntime`) serialized by an asynchronous mutex, ensuring in-flight requests complete cleanly while subsequent requests observe updated revisions.
  - Support atomic contract rollback to historical revisions and contract disabling with structured, redacted audit event emissions (`contract_published`, `contract_activated`, `contract_disabled`, `contract_rolled_back`).
  - Isolate network destination policies and upstream credentials per contract revision.
  - Verify tenant isolation, cache isolation, concurrent reloads, and end-to-end MCP protocol integration via `@modelcontextprotocol/client`.
- Complete Milestone 8 (Tool sources and code-first authoring):
  - Add `ToolSource` interface in `@chainmcp/core` and `registerSource(source: ToolSource): Promise<void>` on `InMemoryToolRuntime`.
  - Add `OpenApiToolSource` in `@chainmcp/executor` wrapping compiled operations and `UpstreamExecutor`.
  - Add `@chainmcp/authoring` package with `defineTool()` authoring facade, `ManualToolSource`, and `zodToJsonSchema()` adapter lowering Zod and raw JSON Schemas to the audited subset with definition-time validation.
  - Add policy parity tests (`packages/authoring/tests/parity.test.ts`) asserting 100% equivalence between manual and compiled tools across input validation, authorization scopes, rate limiting, cooperative cancellation/timeout, output projection, result caching, and safe error masking.
  - Add `chainmcp init --blank` in `@chainmcp/cli` to scaffold contract-free, code-first MCP server projects with example tool, configuration, and build templates.
  - Add `chainmcp dev` in `@chainmcp/cli` for a local developer authoring loop over stdio.
  - Add runnable code-first example in `examples/code-first` with automated integration tests over the official MCP SDK client.
- Complete Milestone 7 (Developer CLI and Generated Servers):
  - Add `@chainmcp/cli` package implementing developer CLI commands (`init`, `validate`, `build`, `serve`, `export`) using Node.js built-in `util.parseArgs` and strictly asynchronous I/O conforming to `chainmcp/no-blocking-io`.
  - Add deterministic generation manifest (`chainmcp.manifest.json`) and verification helper (`verifyProjectManifest`) asserting compiler, generator, contract, and toolset hash equality.
  - Add portable server export (`chainmcp export`) generating standalone, buildable projects with pinned contract snapshots, project configurations, TypeScript configs, multi-stage `Dockerfile` templates, and server entry points sharing `@chainmcp/*` runtime packages.
  - Implement comprehensive deployment documentation in `docs/deployment.md` covering stdio client integration, Docker container builds, process signals, and SSRF security controls.
  - Verify independent build, execution, and MCP SDK protocol conformance via clean-installation end-to-end integration tests.
- Complete Milestone 6 (JSON navigation, logging, and analytics):
  - Add `@chainmcp/json-navigation` package providing bounded JSON path selection (`selectPath`), shape inspection (`inspectShape`), pagination (`paginate`), and declarative filtering (`filterData`) with strict enforcement of depth, node visit budgets, array limits, serialized result bytes, and execution deadlines, plus runnable MCP tool definitions (`json_inspect_shape`, `json_select_path`, `json_paginate`, `json_filter`).
  - Add injectable `Logger`, `LogLevel`, `LogRecord`, and `LogCorrelationContext` interfaces to `@chainmcp/core`.
  - Wire correlated lifecycle logging into `InMemoryToolRuntime`, isolating logger errors from tool results.
  - Add `@chainmcp/analytics` package providing `createLogger`, multi-sink routing (`ConsoleSink`, `MemorySink`, `MultiSink`), case-insensitive secret scrubbing, token pattern redaction, default request/response body exclusion, dedicated security `auditSink`, OpenTelemetry metrics (`OpenTelemetryMetricsSink`) and tracing (`ToolTracer`) via `@opentelemetry/api`, and `RollingAnalyticsAggregator` for sliding-window performance and cache hit-ratio monitoring.
  - Wire `logging`, `jsonNavigation`, and `analytics` schemas into `@chainmcp/config`, map `CHAINMCP_LOG_LEVEL`, and provide `buildRuntimeOptions` wiring.
- Complete Milestone 5 (Authentication and rate limiting):
  - Add `EncryptedSecretStore` with AES-256-GCM authenticated encryption, 96-bit random IVs, 128-bit authentication tags, AAD key-binding, key rings, and key rotation to `@chainmcp/auth`.
  - Add pluggable upstream credential providers (`StaticCredentialProvider`, `EnvCredentialProvider`, `SecretStoreCredentialProvider`, `CompositeCredentialProvider`, and `OAuthClientCredentialsProvider`) to `@chainmcp/auth`.
  - Implement OAuth 2.0 Client Credentials flow (RFC 6749) with token caching, expiration safety margins, automatic refresh, and manual invalidation.
  - Wire `credentialProvider` into `@chainmcp/executor` with explicit OR/AND authentication policy evaluation, header/query/cookie injection, and fail-closed `AUTH_REQUIRED` enforcement.
  - Add `@chainmcp/rate-limit` package providing `InMemoryRateLimiter` and `DistributedRateLimiter` (Redis-backed with atomic Lua scripts for rolling window quotas and concurrency permits). Quota denials report the time until the oldest request leaves the window; concurrency denials report a one-second lower bound.
  - Extend `@chainmcp/core` with `retryAfterSeconds` on `RateLimitDecision` and `RuntimeError`, and `release?(context, toolName)` concurrency permit release hook.
- Wire network security allowlists, rate limiting, and upstream authentication into `@chainmcp/config`:
  - Enforce strict hostname validation and lowercase normalization on `security.allowedUpstreamHosts`, rejecting schemes, ports, paths, queries, credentials, and wildcards.
  - Add `rateLimit` and `auth` schema sections to `ChainMcpConfigSchema`.
  - Add factory and wiring helpers: `buildExecutorOptions`, `buildRuntimeOptions`, `createRateLimiterFromConfig`, `createAuthorizerFromConfig`, and `createUpstreamCredentialProviderFromConfig`.
- Harden Milestone 5 after an implementation audit:
  - Derive `SecretStore` keys for OAuth token cache entries and upstream credentials with a segment-encoding helper (`buildCredentialStoreKey`, `buildOAuthTokenStoreKey`), so tenant, principal, scheme, or scope values outside the key grammar can no longer break lookups. Over-long keys become a stable SHA-256 digest.
  - Delete persistent token copies on `invalidate(...)`, accept an optional `principalId` filter, and bypass a failing token store on read instead of failing credential resolution.
  - Validate credential material returned by any provider with `normalizeUpstreamCredential`; malformed values now fail closed as `AUTH_REQUIRED`.
  - Default `SecretStoreCredentialProvider` to tenant-scoped keys. A tenant secret no longer falls back to a deployment-wide credential unless `allowGlobalFallback: true` is set.
  - Require an explicit token endpoint allowlist (`allowedTokenHosts`) or `allowAnyTokenHost`, require HTTPS unless `allowInsecureHttp` is set, and refuse redirects and URL credentials in the built-in OAuth fetcher.
  - Fetch OAuth tokens through the executor's destination policy and pinned transport, so token requests inherit allowlisting, public-address classification, DNS pinning, peer verification, redirect refusal, and the response cap.
  - Roll back quota recorded earlier in the same check when a later scope denies, so a rejected request no longer consumes another scope's budget.
  - Bound in-memory sliding windows with least-recently-used eviction (`maxTrackedWindows`, default 10,000), drop fully expired windows, and expose `trackedWindowCount`.
  - Include the retry hint in the client-visible `RATE_LIMITED` MCP error text as `Retry after N seconds` when `retryAfterSeconds` is a whole number from 1 to 86,400.
  - Add an opt-in integration suite that runs the distributed limiter's Lua scripts against a real Redis, plus a CI job with a Redis service container.
- Add a pnpm workspace with strict TypeScript, lint/format, test, typecheck, build, and CI configuration.
- Add `@chainmcp/core` with registration, discovery, supported-subset input validation, authorization/rate-limit hooks, timeout/cancellation handling, metrics, and deterministic identity-partitioned cache-key serialization.
- Add `@chainmcp/config` with strict Zod validation and defaults for the implemented configuration subset.
- Wrap unexpected execution failures in a stable, safe runtime error and keep metrics delivery from delaying tool results.
- Fix input validation to enforce array-valued (`type: [...]`) declarations and object/array keywords in schemas that omit `type`; empty or malformed type declarations now fail closed.
- Reject unsupported validation keywords and schema forms at tool registration with `CONTRACT_INVALID` instead of silently skipping them. Bound schema nesting to 32 levels, reject cyclic schemas, and cap validation depth so hostile input cannot surface as `UPSTREAM_FAILURE`.
- Export `auditInputSchema` and its diagnostic types from `@chainmcp/core` so the compiler can apply the same supported-schema rules at compile time.
- Hash cache keys with SHA-256 under a versioned namespace, bound canonical input to 64 KiB, and omit `undefined` object properties.
- Add a bounded process-local LRU cache with entry-count, retained-byte, per-entry, and TTL limits. Require hashed cache keys, reject callable `toJSON` values so serialization cannot escape the value bounds, and clone cached JSON values.
- Version cache keys to v2 and include a required non-secret authorization partition alongside tenant, principal, contract, tool, and canonical arguments. Identity fields that are blank after trimming are rejected.
- Integrate caching into invocation for tools that opt in with `ToolDefinition.cache` and a runtime store. Cache reads run after authorization, validation, and rate limiting; misses execute and store successful results with the tool TTL, while key, partition, read, and write failures bypass caching without failing the call.
- Report `cacheOutcome` (`hit`, `miss`, or `bypass`) on invocation events and add exact-match `invalidateCachedResult` for trusted operator code. Hashed keys still cannot be invalidated by prefix or tenant.
- Add a synchronous `Tokenizer` adapter interface and record exact or estimated token counts plus serialized payload bytes on successful invocation events. No tokenizer is bundled, measurement failures never change results, and cache hits are measured too.
- Add per-tool output projection and token budgets: `output` opts a tool into a deployment-supplied `ResultProjector`, and `output.maxTokens` rejects over-budget results before they are cached or returned. Projection must produce JSON, failures never fall back to the raw result, and cached entries contain only projected output. New error codes are `OUTPUT_POLICY_VIOLATION` and `OUTPUT_LIMIT_EXCEEDED`.
- Add `createFieldProjector()` and `output.fields` for bounded declarative include/exclude projection. Paths traverse arrays element-wise, reject prototype-sensitive segments, enforce depth/node/path limits, and never mutate the source result.
- Add `@chainmcp/cache-redis`, an optional shared `CacheStore` adapter with validated hashed keys and JSON values, bounded entry size, TTL, and per-command latency. It accepts a narrow client wrapper rather than bundling a Redis SDK.
- Classify invocation failures by stage. Untyped authorizer failures now fail closed as `AUTH_FORBIDDEN` with a safe message and retain their cause instead of surfacing as `UPSTREAM_FAILURE`.
- Replace the throwing `RateLimiter.check` contract with an explicit `RateLimitDecision`. Only `{ allowed: false }` produces `RATE_LIMITED` and the `rate_limited` metrics outcome; limiter failures, missing decisions, and a thrown `RATE_LIMITED` code become `UPSTREAM_FAILURE`.
- Preserve typed authorization failures so operators can distinguish policy denial from adapter infrastructure failure.
- Compare object keys as own properties during validation. `additionalProperties: false` now rejects undeclared keys named after `Object.prototype` members such as `toString` or `__proto__`, and `required` is no longer satisfied by an inherited name.
- Cap reported validation issues at 20 per call and append a truncation marker, so a large invalid input can no longer inflate the client-facing `INPUT_INVALID` message.
- Reject non-finite `enum` entries such as `NaN` and `Infinity` at registration. They cannot appear in JSON, and the type check rejects non-finite numbers before the enum comparison, so such an entry could never match.
- Measure `RuntimeEvent.durationMs` with a monotonic `performance.now` clock (`RuntimeOptions.monotonicNow`) instead of the wall clock, so system clock adjustments cannot distort or invert a duration. `RuntimeOptions.now` now only supplies the event `timestamp`; both clocks remain injectable for deterministic tests. See `docs/adr/0007-wall-clock-and-monotonic-duration.md`.
- Add publish metadata (`license`, `repository`, `publishConfig.access`) to `@chainmcp/core` and `@chainmcp/config` so the scoped packages can be published publicly.
- Add release and commit tooling: Conventional Commit enforcement (`commitlint`), staged-file formatting and linting (`lint-staged`), a `pre-commit` typecheck, Husky hooks, and Changesets with a fixed `@chainmcp/core`/`@chainmcp/config`/`@chainmcp/server` group and a root version-sync check.
- Add `@chainmcp/auth` with `OperationScopeAuthorizer`, the ADR 0008 default authorizer: it denies with `AUTH_FORBIDDEN` unless every `operation.requiredScopes` entry is present in `principal.scopes` (exact token match, no wildcards; missing/empty requirements impose none), retains the ungranted requirements only as a protected diagnostic cause, and denies malformed definitions or principal data instead of failing open. Tenant matches stay structural in the runtime, so composing the scope authorizer cannot weaken tenant isolation. Composition tests demonstrate scope enforcement, safe metrics, and authorization ordering in a multi-tenant runtime; dependency boundaries, version sync, and the changeset fixed group extended to the new package.
- Add `@chainmcp/server` with official MCP SDK tool listing and invocation, safe runtime error mapping, a serialized response byte cap, local stdio serving, and idempotent connection shutdown.
- Change pre-1.0 context factories to receive MCP request metadata; run context resolution inside runtime accounting and map failures to `AUTH_FORBIDDEN` with metrics.
- Wire stdio EOF, abort, SIGINT, and SIGTERM to shutdown; expose transport closure and make concurrent close calls await completion. Add lifecycle regression tests.
- Require an exact non-null object root for MCP tool schemas, explain the audited SDK schema conversion, and test validation parity, cancellation, non-JSON results, timeouts, connection failure, and stdio lifecycle.
- Add tenant-bound registration and tenancy modes to `@chainmcp/core` (ADR 0008). A single-tenant runtime may pin `RuntimeOptions.tenantId`, stamps tools without `ownerTenantId` with the pin, rejects foreign bindings with `CONFIG_INVALID`, and denies cross-tenant callers with `AUTH_FORBIDDEN` before adapters run. A multi-tenant runtime requires an authorizer at construction, requires a non-empty `ownerTenantId` per tool, allows repeated tool names across tenants, scopes tool resolution and per-call listing to the caller's tenant, and rejects cross-tenant tools with `TOOL_NOT_FOUND` (no metrics event), keeping cross-tenant calls indistinguishable from unknown tools. `listTools` without a caller context is `AUTH_REQUIRED`. Milestone 2 single-tenant behavior without a pin is unchanged. The `@chainmcp/server` safe-error mapping covers the new `CONFIG_INVALID` and `AUTH_REQUIRED` codes.
- Adopt identity-filtered listing in `@chainmcp/server` (ADR 0008). A multi-tenant runtime is now adapted through low-level per-request `tools/list` and `tools/call` handlers instead of failing closed: per-request identity is established via `createContext`, listing is scoped to the caller's tenant against the same registry `callTool` resolves against, listing failures that cannot establish identity fail closed with a safe protocol error, and serialization, response byte caps, and safe error mapping are shared with the snapshot path so both modes cannot drift. Single-tenant snapshot behavior, including all Milestone 2 exit criteria, is unchanged, and cross-tenant calls remain indistinguishable from unknown tools at the MCP surface.
- Declare `tenantMode` on the `ToolRuntime` interface and dispatch the MCP adapter on that declaration instead of on `InMemoryToolRuntime`. A custom multi-tenant runtime can no longer be mistaken for a single-tenant one and listed without a caller context; a server regression test exercises a non-`InMemoryToolRuntime` implementation.
- Preserve typed `RuntimeError`s thrown by context factories. Untyped identity-resolution failures still fail closed as `AUTH_FORBIDDEN`, but an identity-provider outage now keeps `UPSTREAM_FAILURE`, so operators can distinguish it from a policy denial in metrics (ADR 0006, ADR 0008).
- Map `RuntimeErrorCode` to client-safe messages through an exhaustive `Record`, making a newly added code a compile error, and bound `maxResponseBytes` to 100 MB to match the configuration limit.
- Set `license: "UNLICENSED"` in every workspace package, replacing the invalid `TODO` placeholder that would fail publish validation. Choosing and documenting a real license remains an open Milestone 0 item.
- Build before `typecheck` and `test` in `pnpm check`. Cross-package imports resolve through each package's built `dist`, so the previous order only passed when stale artifacts happened to exist and failed on a clean checkout.
- Add `chainmcp/no-blocking-io`, a custom ESLint rule that rejects synchronous `fs` and `child_process` APIs on runtime source paths, including aliased/namespace imports, `require`, and dynamic import. RuleTester coverage runs through `pnpm test:rules` in `pnpm check`.
- Add `@chainmcp/compiler` with the first Milestone 3 slice: bounded YAML/JSON parsing, OpenAPI 3.0/3.1 structural validation, local `$ref` resolution with cycle/depth limits, deterministic operation enumeration and tool names, object-root input schemas from path/query/header parameters and JSON request bodies, 3.0 `nullable` translation, `readOnly` input filtering, `auditInputSchema` enforcement, security OR/AND metadata, and deterministic source/contract/toolset hashes with `diffManifests()`. It emits metadata only; executors and authentication enforcement remain open.
- Map declared OpenAPI responses into deterministic metadata with status keys, descriptions, selected media types, and translated schemas. Response schemas resolve local `$ref`s, drop `writeOnly` fields, preserve composition, and are explicitly not applied as output validation. Flatten object `allOf` intersections for inputs, rejecting incompatible properties, non-object members, and sibling validation keywords. Include responses in per-tool hashes.
- Derive `CompiledOperation.authentication` as explicit OR alternatives and AND scheme sets with credential metadata and sorted, deduplicated scopes. Preserve anonymous alternatives, reject scopes on non-OAuth/OIDC schemes, and diagnose undeclared OAuth2 scopes. Include authentication details in per-tool hashes. Policies are metadata only; no credentials are resolved or enforced.
- Add the compiler package to the fixed release group and root version-sync check.
- Record sorted path/query/header parameter bindings and JSON request-body media metadata on `CompiledOperation`, include them in per-tool hashes, and reject transport/credential headers such as `Content-Type` and `User-Agent` as tool inputs.
- Add `@chainmcp/executor` with `createUpstreamExecutor()`: compile output becomes runnable tools with bounded path/query/header/JSON-body mapping; exact host allowlists; HTTPS by default; fixed protocol/port; same-host redirect revalidation; rejection of any loopback, private, shared, link-local, metadata, multicast, documentation, or reserved DNS answer; pinned lookups with peer verification; no proxy environment or connection reuse; compression refusal; URL/header/request/response/redirect/time caps; and `context.signal`/total-timeout binding. It does not inject credentials, enforce authentication, validate response schemas, or retry.
- Extend the runtime validator and compiler with bounded schema constraints: string `minLength`/`maxLength`/`pattern` and asserted formats, numeric bounds and `multipleOf`, array length and structural `uniqueItems`, and object property counts. Patterns use the linear-time `re2js` engine; invalid or oversized patterns fail registration. OpenAPI 3.0 boolean exclusive bounds are normalized to numeric JSON Schema bounds.
- Add `examples/petstore`, a compiled stdio MCP server that wires the compiler, executor, shared runtime, and server adapter to a deterministic mock upstream. Add `docs/getting-started.md` and `pnpm conformance:inspector`, which runs the MCP Inspector CLI against `tools/list` and `tools/call`; CI runs the Inspector check in a separate Node.js 22.19.0 job.
- Add Apache License 2.0 and apply it across all workspace packages, completing Milestone 0 licensing.
- Configure dependency and secret scanning: add Dependabot configuration (`.github/dependabot.yml`), high-severity audit check in CI, Gitleaks secret scanning, and pull request dependency review.
- Upgrade `@modelcontextprotocol/server` and `@modelcontextprotocol/client` to `2.3.1` to patch security advisories GHSA-jm63-cq47-j5jp, GHSA-46jr-4wx8-v453, and GHSA-rvq5-wwqv-78pq.

### Breaking changes

- `RateLimiter.check` now returns `RateLimitDecision` (`{ allowed: boolean }`) instead of `Promise<void>`. Throwing `RuntimeError("RATE_LIMITED")` no longer denies a call; it is treated as a limiter failure. The package is pre-1.0, so this change is recorded rather than deprecated. See `docs/adr/0006-stage-aware-policy-errors.md`.
- `RuntimeOptions.now` no longer measures `durationMs`; it only supplies the event `timestamp`. Inject `RuntimeOptions.monotonicNow` to control durations. The package is pre-1.0, so this change is recorded rather than deprecated.
- `ToolRuntime.listTools` accepts an optional `ToolContext`, and `RuntimeErrorCode` gained `CONFIG_INVALID` and `AUTH_REQUIRED`. `ToolDefinition` gained optional `ownerTenantId`. Existing single-tenant call sites are unaffected. See `docs/adr/0008-mcp-authorization-mapping.md`.
- `ToolRuntime` now requires a `tenantMode` declaration so adapters can select the listing strategy without depending on a concrete class. Custom runtime implementations must add the field; the package is pre-1.0, so this change is recorded rather than deprecated.

### Limitations

- No OpenAPI response-schema validation, CLI, gateway, credential provider, authentication enforcement, generated-server wiring, or concrete cache/auth/rate-limit adapter is included.
- `@chainmcp/compiler` output is operation metadata; `@chainmcp/executor` turns it into runnable tools. Response schemas and authentication policies are not enforced; input `oneOf`/`anyOf`/`not` composition, `const`, remote references, and formats outside the asserted set remain unsupported. Authentication enforcement remains Milestone 5 work; generated-server/CLI wiring remains Milestone 7 work.
- The core input validator supports only the subset documented in `API_REFERENCE.md`.

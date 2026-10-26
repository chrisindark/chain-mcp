# ChainMcp Roadmap

This roadmap is the delivery plan and source of truth for project progress.

A checkbox may be marked complete only after implementation, tests, documentation, and acceptance criteria have been verified.

## Cross-cutting acceptance criteria

These apply to every milestone that touches the relevant surface, in addition to
that milestone's own exit criteria. They exist so that repeated failure modes
are not re-argued per milestone. Deferred risks and their triggers live in
`docs/risk-register.md`.

- **Protocol conformance:** a server-mode change is exercised by an MCP client,
  and generated servers pass an Inspector conformance check, before the
  milestone is checked.
- **Determinism:** the same contract and compiler version produce byte-identical
  output, and the generation manifest records a toolset hash.
- **No blocking I/O:** request paths avoid synchronous filesystem, process, and
  network calls; the `chainmcp/no-blocking-io` lint rule enforces this over
  runtime source paths.
- **Outbound safety:** the first outbound HTTP call lands with destination
  allowlisting, private/link-local/metadata range blocking, redirect
  revalidation, and response size and time caps.
- **Bounded serialization:** response caps are enforced while producing output,
  not only after `JSON.stringify`.

## Milestone 0 — Project foundation

- [x] Establish monorepo and package boundaries (`@chainmcp/core`, `@chainmcp/config`).
- [x] Define supported Node.js (20.11+) and TypeScript (5.9) versions.
- [x] Establish lint, formatting, typecheck, build, and test commands.
- [x] Add CI, dependency scanning, and secret scanning (CI check, Inspector conformance, Dependabot, high-severity audit, Gitleaks, and dependency-review actions configured).
- [x] Document architecture, security, and contribution rules.
- [x] Select a license before public release (Apache License 2.0).

**Exit criteria:** a clean checkout installs and passes all CI checks.

## Milestone 1 — Core runtime

- [x] Define tool, context, policy, and error interfaces.
- [x] Implement in-memory tool registry and invocation pipeline.
- [x] Validate tool arguments before execution (documented JSON Schema subset).
- [x] Add injectable authorization, cache, rate-limit, and metrics interfaces.
- [x] Classify authorization and rate-limit adapter failures by invocation stage, with explicit rate-limit decisions and fail-closed untyped authorization failures.
- [x] Implement timeout rejection and cooperative `AbortSignal` propagation.
- [x] Add deterministic unit tests.

**Exit criteria:** tools can be registered, discovered, validated, and executed through the shared runtime. Verified by the deterministic core tests and workspace checks. Timeout and cancellation reject the caller and abort the per-call signal; they do not guarantee executor termination or resource release. Cache storage and concrete authorization/rate-limit policies remain injected adapters, not built-in features.

## Milestone 2 — MCP server adapter

- [x] Integrate the official TypeScript MCP SDK.
- [x] Support local stdio transport.
- [x] Add tool listing and invocation handlers.
- [x] Map runtime errors to safe MCP results.
- [x] Test SDK client/server interoperability over a linked in-memory transport pair.
- [x] Handle and test stdio EOF, abort, SIGINT/SIGTERM, peer closure, close propagation, concurrent close, and connect-failure cleanup.

**Exit criteria:** an MCP client can discover and call a test tool end to end. Verified through the SDK client over a linked transport pair. The adapter returns JSON results as text, checks the serialized response against a configurable cap (1 MB default, 100 MB maximum), maps safe runtime errors into MCP error results, and requires trusted context construction. The byte check currently runs after `JSON.stringify`, so it does not bound serialization memory; bounded output production/serialization remains an M6 requirement. Context factories receive MCP request metadata; untyped factory failures fail closed as `AUTH_FORBIDDEN`, typed `RuntimeError`s keep their code, and metrics use an `unknown` tenant ID when identity resolution fails. The adapter dispatches on the `ToolRuntime.tenantMode` declaration, snapshots single-tenant tools at server creation, and rejects non-object root schemas. Lifecycle tests cover stdio EOF, application abort, SIGTERM, concurrent close callers, onclose propagation, and connection-failure cleanup. Stdio also closes on SIGINT; remote transport authentication is not implemented.

## Milestone 3 — OpenAPI compiler

- [x] Parse and validate OpenAPI 3.0 and 3.1.
- [x] Map operations, parameters, request bodies, and response schemas.
- [x] Resolve nested and composed `$ref` schemas deterministically.
- [x] Preserve required fields, enums, formats, and numeric and string constraints in generated validators.
- [x] Generate stable tool names and descriptions.
- [x] Detect circular references, invalid schemas, and tool-name collisions; fail with actionable diagnostics.
- [x] Translate supported JSON Schema constructs into validators.
- [x] Map authentication schemes to explicit policies, including alternative (OR) and combined (AND) requirements; never silently drop a requirement.
- [x] Report unsupported constructs and ambiguous mappings.
- [x] Enforce outbound destination policy (allowlist, private-range and metadata blocking, redirect revalidation) in `@chainmcp/executor`; generated-server wiring remains open.
- [x] Bind `context.signal` to upstream calls in `@chainmcp/executor` and release executor resources on timeout or cancellation.
- [x] Emit a deterministic generation manifest with a toolset hash and a regeneration diff.
- [x] Validate compiled output with an MCP client and an Inspector conformance check.
- [x] Document one end-to-end example in `docs/getting-started.md` and `examples/`.
- [x] Add deterministic compiler tests and fixtures.

**Exit criteria:** a representative API contract compiles into validated tools with documented limitations; generated executors bind the cancellation signal and the outbound destination policy to upstream I/O; output is byte-identical for the same contract and compiler version; and a runnable example is documented in `docs/getting-started.md`.

**Status (2026-10-21):** the compiler and the first upstream executor slice are
implemented. The compiler parses one YAML/JSON OpenAPI 3.0 or 3.1 document,
validates document structure, resolves local references, enumerates operations,
builds audited object-root input schemas from path/query/header parameters and
JSON request bodies, translates 3.0 nullability, and emits deterministic
source/contract/toolset hashes plus `diffManifests()`. It records parameter and
request-body bindings, maps declared responses in status-key order with their
description, selected media type, and translated response schema, and expands
security requirements into explicit OR alternatives and AND scheme sets with
copied credential metadata and required scopes. Response schemas are
descriptive metadata, and authentication is not enforced. Object `allOf`
intersections are flattened deterministically for inputs; nested and composed
local references are resolved with cycle/depth limits; the runtime-supported
constraints are preserved and enforced; unsupported input annotations are
rejected in strict mode and reported when droppable in permissive mode; input
`oneOf`/`anyOf`/`not`, conditional/dependent/pattern composition, and remote
references are always rejected.

`@chainmcp/executor` converts compiled operations into runnable tools. It maps
path, query, header, and JSON body inputs; enforces an exact host allowlist,
HTTPS by default, fixed protocol/port, and same-host redirects; rejects any DNS
answer in loopback, private, shared, link-local, metadata, multicast,
documentation, or reserved ranges; pins the resolved address and verifies the
peer; rejects compressed and oversized responses; and binds `context.signal`
plus a total timeout to upstream I/O. It does not inject credentials, validate
response schemas, retry, or resolve per-operation `servers`.

The `examples/petstore` project compiles a contract, binds the executor,
registers the tools in the shared runtime, and serves them over stdio. The MCP
Inspector CLI lists and calls those tools; `pnpm conformance:inspector` asserts
both operations and runs in CI.

Input union composition, an output validator, authentication enforcement, and
generated-server/CLI wiring remain open. They are documented limitations, not
part of this milestone's exit criteria.

## Milestone 4 — Smart caching and token accounting

- [x] Add bounded in-memory cache for development (LRU, bounded retained bytes/entries, per-entry cap, TTL cap, and JSON value depth/node limits).
- [x] Add optional Redis adapter (`@chainmcp/cache-redis`, with bounded commands, validated keys/values, TTLs, and an injectable client).
- [x] Implement safe, versioned, hashed cache key construction and tenant/principal/authorization-context partitioning.
- [x] Cache eligible read operations only by default (opt-in `ToolDefinition.cache`; authorization, validation, and rate limiting still run on hits; key/partition/store failures bypass instead of failing the call).
- [x] Add TTL, invalidation, and field projection (TTL and exact-match invalidation are implemented; `createFieldProjector()` provides bounded declarative include/exclude paths).
- [x] Enforce output-level policy and a token-budgeted projection on tool results (per-tool opt-in `ResultProjector` or built-in `createFieldProjector()`, mandatory JSON output, and `output.maxTokens` enforced before caching and measurement).
- [x] Integrate tokenizer adapters (optional synchronous `Tokenizer` with id, exact/estimate declaration, and count).
- [x] Distinguish exact counts from estimates (recorded as `tokenUsage.measurement`; estimates are never relabeled).
- [x] Record cache hit ratio and token metrics (per-invocation hit/miss/bypass and `tokenUsage`; aggregated ratios are computed by exporters).

**Exit criteria:** tests demonstrate cache isolation and accurate labeling of token measurements.

**Status (2026-10-21):** all Milestone 4 items are implemented and covered by
tests. Remaining distributed concerns (bulk invalidation, request coalescing) are
tracked outside M4; declarative field projection is in core and the optional
Redis adapter is published as `@chainmcp/cache-redis`.

## Milestone 5 — Authentication and rate limiting

- [x] Separate inbound MCP authorization from upstream credentials.
- [x] Add pluggable upstream credential providers.
- [x] Add encrypted secret storage abstraction.
- [x] Support required OAuth flows.
- [x] Handle refresh, expiry, rotation, and revocation.
- [x] Implement tenant, principal, and tool quotas.
- [x] Implement concurrency limits and retry-after behavior.

**Exit criteria:** unauthorized requests fail closed, secrets remain protected, and quota enforcement works across processes when using a distributed adapter.

**Status (2026-10-22):** all Milestone 5 items are implemented and covered by
tests. Inbound identity and authorization (`ToolContext.principal`, `OperationScopeAuthorizer`)
remain separated from upstream credentials; caller arguments cannot inject or override
authorization headers. Upstream credentials (`apiKey`, `http` basic/bearer, `oauth2`) are
resolved per scheme and tenant by pluggable `UpstreamCredentialProvider` adapters
(`StaticCredentialProvider`, `EnvCredentialProvider`, `SecretStoreCredentialProvider`,
`CompositeCredentialProvider`, and `OAuthClientCredentialsProvider`); provider output is
validated against the credential shapes and invalid material fails closed. Secrets at rest are
protected by `EncryptedSecretStore` using authenticated AES-256-GCM encryption, 96-bit random
IVs, 128-bit authentication tags, key-name AAD binding, and key rotation support.

Scope of the OAuth item: only the RFC 6749 client credentials grant is implemented, which is
the only grant current contracts require. That grant issues no refresh token, so expiry means
re-acquiring the token; there is no refresh-token rotation. Token invalidation clears the
entries an instance knows about and deletes their persistent copies, while cross-process
revocation of entries another process wrote is out of scope because `SecretStore` has no scan
operation (delete the derived `buildOAuthTokenStoreKey(...)` entry or rely on token expiry).
Token acquisition is an outbound call: inside the executor it runs through the same exact host
allowlist, address classification, DNS pinning, peer verification, redirect refusal, and
response cap as API requests, and store keys are derived with a segment-encoding helper so
tenant, principal, scheme, and scope values cannot break the key grammar. Secret rotation
applies to `EncryptedSecretStore` key rotation, not to OAuth refresh tokens.

The `@chainmcp/rate-limit` package provides `InMemoryRateLimiter` and `DistributedRateLimiter`
(backed by Redis with atomic Lua scripts for rolling-window quota checks and concurrency permit
management), enforcing quotas and concurrency limits partitioned by tenant, principal, tool,
or globally. All matching scopes are evaluated per call: a denial rolls back quota recorded
earlier in the same check, so a rejected call never consumes another scope's budget. Local
window memory is bounded by least-recently-used eviction (`maxTrackedWindows`, default
10,000). `retryAfterSeconds` is the exact time until the oldest request leaves the window for
quota denials, and a conservative one-second lower bound for concurrency denials. Exit-criteria
evidence combines unit tests, executor credential and egress tests, and an opt-in integration
suite that runs the Lua scripts against a real Redis (CI job `redis-integration`); the default
`pnpm check` path stays hermetic.

`@chainmcp/config` wires `security.allowedUpstreamHosts` directly into executor options with strict hostname syntax validation (no schemes, ports, or wildcards), and wires `rateLimit` and `auth` (inbound authorizers and upstream providers) into runtime and executor options via factory helpers (`buildExecutorOptions`, `buildRuntimeOptions`, `createRateLimiterFromConfig`, and `createUpstreamCredentialProviderFromConfig`).

## Milestone 6 — JSON navigation, logging, and analytics

- [x] Add bounded JSON path selection.
- [x] Add filtering, pagination, and shape inspection.
- [x] Enforce depth, size, and execution limits.
- [x] Define an injectable logger interface with levels and structured records.
- [x] Add validated logging configuration, including level validation and environment-variable mapping.
- [x] Enforce secret and sensitive-field redaction at the logger boundary; exclude request and response bodies by default.
- [x] Correlate log records with request, tool call, and contract revision identifiers.
- [x] Define output sinks, retention, and separation between diagnostic and audit logs.
- [x] Test level filtering, redaction, correlation fields, and logger-failure isolation.
- [x] Emit structured usage and performance events.
- [x] Integrate OpenTelemetry.
- [x] Define retention and redaction defaults.

**Exit criteria:** large and adversarial JSON documents remain bounded; analytics and logs exclude secrets and response bodies by default; and logs honor the configured level, emit structured and correlated records, and cannot change tool results when delivery fails.

**Status (2026-10-26):** all Milestone 6 items are implemented and covered by
tests. `@chainmcp/json-navigation` provides bounded path selection (`selectPath`),
shape inspection (`inspectShape`), pagination (`paginate`), and declarative
filtering (`filterData`) with strict enforcement of depth (default 16, max 64),
node counts (default 50,000), array items (default 1,000), result byte limits
(default 50,000 bytes), and execution time (default 5,000ms), and exports runnable
MCP tool definitions (`json_inspect_shape`, `json_select_path`, `json_paginate`,
`json_filter`). Circular references throw and prototype pollution keys
(`__proto__`, `prototype`, `constructor`) are strictly rejected. Navigation
operates strictly on authorized and projected data.
`@chainmcp/core` defines portable `Logger`, `LogLevel`, `LogRecord`, and
`LogCorrelationContext` interfaces, and `InMemoryToolRuntime` logs correlated
invocation lifecycle records while completely isolating logger failures.
`@chainmcp/analytics` implements `createLogger` with log-level filtering,
case-insensitive secret scrubbing, token pattern redaction, and default body
exclusion. It routes diagnostic logs and security audit logs to separate sinks
(`ConsoleSink`, `MemorySink`, `MultiSink`), implements
`OpenTelemetryMetricsSink` and `ToolTracer` over `@opentelemetry/api`, and
provides `RollingAnalyticsAggregator` for sliding-window performance and cache
hit-ratio accounting.
`@chainmcp/config` adds validated `logging`, `jsonNavigation`, and `analytics`
schemas, maps `CHAINMCP_LOG_LEVEL`, and wires loggers and metrics into runtime
options via `buildRuntimeOptions`.

## Milestone 7 — Generated servers

- [x] Implement `init`, `validate`, `build`, `serve`, and `export`.
- [x] Generate a portable project with a pinned contract revision.
- [x] Share runtime and policy implementations.
- [x] Add generation manifests and reproducibility checks.
- [x] Add Docker templates and deployment documentation.
- [x] Test generated projects from clean installations.

**Exit criteria:** an exported server builds and runs independently.

**Status (2026-10-26):** all Milestone 7 items are implemented and covered by
tests. `@chainmcp/cli` implements the developer CLI with `init`, `validate`,
`build`, `serve`, and `export` commands via Node.js native `util.parseArgs` with
strict asynchronous I/O (`chainmcp/no-blocking-io`). `chainmcp export` generates
portable standalone projects containing pinned contract snapshots in
`spec/openapi.yaml`, configuration in `chainmcp.config.yaml`, TypeScript configs,
multi-stage `Dockerfile` templates, `.dockerignore`, `.gitignore`, `README.md`,
and an immutable generation manifest (`chainmcp.manifest.json`) recording
`manifestVersion`, `generatorVersion`, `compilerVersion`, `contractRevision`,
`sourceHash`, `toolsetHash`, and individual tool hashes.
Generated servers share the `@chainmcp/*` runtime, executor, server, auth,
analytics, and JSON navigation implementations without duplicating policy logic
(preserving ADR 0002). Reproducibility checks (`verifyProjectManifest`,
`--check` on `build` and `export`) assert exact byte-for-byte and hash identity.
Deployment documentation is established in `docs/deployment.md`.
End-to-end integration tests (`end-to-end.test.ts`) demonstrate that an exported
server compiles with `tsc` and runs independently, discovering and executing both
OpenAPI-compiled tools and JSON navigation tools over the official MCP SDK
client.

## Milestone 8 — Tool sources and code-first authoring

OpenAPI compilation is the default tool source, not the only one. This
milestone makes a blank, code-first project a supported deployment without
forking the runtime or bypassing policy.

- [x] Define a `ToolSource` boundary that produces `ToolDefinition`s, with OpenAPI compilation as one implementation.
- [x] Add a manual tool source whose tools pass through the same validation, authorization, caching, rate-limit, cancellation, and output-policy pipeline as compiled tools.
- [x] Add an authoring facade (working name `defineTool()`) that accepts a supported `JsonSchema` and an optional Zod adapter, lowering to the audited schema subset and rejecting unsupported schemas at definition time.
- [x] Add `chainmcp init --blank` (or equivalent) that scaffolds a project with one hand-written example tool and no contract.
- [x] Add `chainmcp dev` for a local authoring loop, using stdio first and HTTP once the transport lands.
- [x] Document the code-first path in `docs/getting-started.md`, `API_REFERENCE.md`, and `CONFIGURATION.md`, and add a runnable example.
- [x] Test policy parity between manual and compiled tools, including error mapping, cancellation, and response caps.

**Exit criteria:** a developer can scaffold a project without an OpenAPI document, define a tool in code, and call it from an MCP client with the same authorization, validation, and output guarantees as a compiled tool. Tool handlers are trusted application code shipped by the deploying developer; the server never evaluates user-supplied source.

**Status (2026-10-26):** all Milestone 8 items are implemented and covered by
tests. `@chainmcp/core` defines the portable `ToolSource` boundary and
implements `registerSource(source: ToolSource): Promise<void>` on `InMemoryToolRuntime`.
`@chainmcp/executor` implements `OpenApiToolSource` wrapping compiled OpenAPI
operations and `UpstreamExecutor`.
`@chainmcp/authoring` provides the `defineTool()` authoring facade, `zodToJsonSchema()`
lowering, and `ManualToolSource`. Zod and raw JSON Schemas are lowered and audited at
definition time via `auditInputSchema`, rejecting unsupported constructs (unions of
complex types, recursive `$ref`, functions) before server startup.
Policy parity tests (`parity.test.ts`) demonstrate 100% equivalence between manual and
compiled tools across input validation, authorization scopes, rate limiting,
cooperative cancellation/timeouts, output projection, cache partitioning/hits,
and safe error concealing without leaking internal messages or credentials.
`@chainmcp/cli` implements `chainmcp init --blank` for contract-free scaffolding
and `chainmcp dev` for a local authoring loop over stdio.
A runnable code-first example is provided in `examples/code-first` with automated
integration tests over the official MCP SDK client.
Documentation is updated in `docs/getting-started.md`, `API_REFERENCE.md`,
`CONFIGURATION.md`, and `ARCHITECTURE.md`, ADR 0019 is accepted, and ADR 0025 is recorded.

**Non-goals:** a visual tool editor, arbitrary code upload, and a hosted control plane. The declarative builder is tracked post-1.0.

## Milestone 9 — Dynamic gateway

- [x] Add versioned contract registry.
- [x] Bind each contract revision to tenant policy.
- [x] Load and reload revisions atomically.
- [x] Enforce per-contract authentication and network policies.
- [x] Support rollback and revision disabling.
- [x] Test tenant isolation and concurrent reloads.

**Exit criteria:** multiple contracts can be served safely without cross-tenant access.

**Status (2026-10-26):** all Milestone 9 items are implemented and covered by
tests. `@chainmcp/gateway` implements `ContractRegistry` and `DynamicGateway`
with versioned immutable contract revisions (`revisionId`, `sourceHash`,
`tools`, `destinationPolicy`, `authConfig`, and `limits`).
Candidate revisions are compiled and validated in isolation with
`@chainmcp/compiler` and `@chainmcp/executor`, auditing all input schemas and
destination allowlists before activation. Tool name collisions within a revision
and across active contracts for the same tenant are rejected at candidate
validation and activation; distinct tenants may safely publish identical tool
names without collision or cross-talk.
Atomic state swap (`this.activeRuntime = nextRuntime`) serialized by an
asynchronous mutex ensures in-flight requests complete cleanly while new
requests immediately observe updated revisions.
Rollback reactivates prior revisions atomically and disabling removes tools
from discovery and execution, emitting structured, redacted audit events
(`contract_published`, `contract_activated`, `contract_disabled`,
`contract_rolled_back`).
Per-contract network destination policies and upstream credentials are strictly
isolated per contract revision.
Multi-tenant isolation tests demonstrate that callers without context fail with
`AUTH_REQUIRED`, and cross-tenant requests fail closed as `TOOL_NOT_FOUND`
without leaking other tenants' inventory.
ADR 0008 is accepted, and ADR 0026 is recorded.

## Milestone 10 — Stable release

- [x] Complete public API review.
- [x] Publish supported-version matrix.
- [x] Complete security and dependency review.
- [x] Add load, resilience, and fault-injection tests.
- [x] Document migration and rollback procedures.
- [x] Configure signed releases and software bill of materials.
- [x] Meet all 1.0 release gates in `RELEASES.md`.

Public APIs across all 13 workspace packages are reviewed and stabilized with
strict TypeScript definitions and ESM entrypoints.
The supported-version matrix and lifecycle policy are published in
`docs/supported-versions.md`, documenting Node.js (>=20.11, 20 and 22 LTS),
operating systems, OpenAPI (3.0.x and 3.1.x), Model Context Protocol TypeScript
SDK (v2), Redis (7+), and configuration (`version: 1`).
Security and dependency audit (`pnpm audit --audit-level=high`) verified zero
high or critical vulnerabilities; `docs/risk-register.md` is updated to reflect
all Phase 1–3 security and reliability risks as done.
Comprehensive load, resilience, and fault-injection test suites in
`@chainmcp/core` and `@chainmcp/executor` verify graceful degradation under
cache outages, rate limiter check/release errors, observability sink failures,
upstream network drops, socket aborts, HTTP 5xx errors, DNS resolution failures,
redirect loops, and in-flight cooperative cancellations (`AbortSignal`).
Migration and rollback procedures for standalone generated servers and the
dynamic gateway are documented in `docs/migration-and-rollback.md` and
troubleshooting guides in `docs/troubleshooting.md`.
Software Bill of Materials (SBOM) generator script (`scripts/generate-sbom.mjs`)
produces CycloneDX 1.5 JSON metadata (`dist/sbom.cdx.json`).
Automated release workflow (`.github/workflows/release.yml`) configures signed
releases with npm provenance (`--provenance`) and Changesets publishing.
All 1.0 exit criteria and release checklist items in `RELEASES.md` are met.
ADR 0027 is recorded.

## Post-1.0 — Declarative tool builder and admin UI

Not part of the 1.0 critical path. A visual builder is a separate product
surface that requires persistence, an admin identity model, and a dynamic
registry. It must reopen the persistence and control-plane decisions recorded
as ENT-04/ENT-05 in `docs/risk-register.md`, and it requires an ADR before
implementation.

- [ ] Define a versioned declarative tool descriptor (name, schema, method, URL, auth reference, policy) executed by the bounded HTTP executor.
- [ ] Add a self-hosted admin API and local UI for creating, validating, previewing, and publishing descriptors.
- [ ] Persist descriptors with tenant ownership, revision history, and rollback.
- [ ] Route descriptor-backed tools through the same policy, SSRF, redaction, and audit paths as compiled tools.
- [ ] Exclude arbitrary code upload, hosted SaaS control plane, and unaudited execution.

**Exit criteria:** a self-hosted operator can publish a declarative HTTP tool through an admin surface without editing code, and the tool is indistinguishable from a compiled tool at invocation time.

## Deferred and out of scope

The following are recorded in `docs/risk-register.md` with status and
re-evaluation triggers. They are deliberately not milestones:

- OAuth authorization-code and refresh-token flows, token introspection, OIDC
  discovery, and cross-process token revocation. The Milestone 5 client
  credentials grant needs none of them; revisit with a real contract, and keep
  placeholders out per `AGENTS.md`.
- Retries, backoff, circuit breakers, and health checks beyond explicit retries
  for idempotent operations.
- Orphaned process and container cleanup, and multi-OS CI matrices (release
  hardening).
- Pluggable persistence, configuration rollback, audit dashboards, usage
  metering, and any hosted control plane.
- Approval gates beyond client-side confirmation and destructive-tool design.

Deferred does not mean unimportant. It means no failing test and no place on
the current vertical slice.

## Definition of done

Every feature must include:

1. Implementation and input validation.
2. Unit and integration tests.
3. Public API and configuration documentation.
4. Error and failure behavior.
5. Security and tenant-isolation review.
6. Observability and redaction behavior.
7. Compatibility and migration assessment.
8. An updated roadmap entry.

Do not skip milestones merely to make the roadmap appear complete.

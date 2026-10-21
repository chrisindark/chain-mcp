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
- [ ] Add CI, dependency scanning, and secret scanning (CI checks exist; scanners remain absent).
- [x] Document architecture, security, and contribution rules.
- [ ] Select a license before public release.

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
- [ ] Map operations, parameters, request bodies, and response schemas.
- [ ] Resolve nested and composed `$ref` schemas deterministically.
- [ ] Preserve required fields, enums, formats, and numeric and string constraints in generated validators.
- [x] Generate stable tool names and descriptions.
- [x] Detect circular references, invalid schemas, and tool-name collisions; fail with actionable diagnostics.
- [ ] Translate supported JSON Schema constructs into validators.
- [ ] Map authentication schemes to explicit policies, including alternative (OR) and combined (AND) requirements; never silently drop a requirement.
- [x] Report unsupported constructs and ambiguous mappings.
- [ ] Enforce outbound destination policy (allowlist, private-range and metadata blocking, redirect revalidation) on generated executors.
- [ ] Bind `context.signal` to generated upstream calls and release executor resources on timeout or cancellation.
- [x] Emit a deterministic generation manifest with a toolset hash and a regeneration diff.
- [ ] Validate compiled output with an MCP client and an Inspector conformance check.
- [ ] Document one end-to-end example in `docs/getting-started.md` and `examples/`.
- [x] Add deterministic compiler tests and fixtures.

**Exit criteria:** a representative API contract compiles into validated tools with documented limitations; generated executors bind the cancellation signal and the outbound destination policy to upstream I/O; output is byte-identical for the same contract and compiler version; and a runnable example is documented in `docs/getting-started.md`.

**Status (2026-10-21):** the compiler package and its first vertical slice are
implemented. It parses one YAML/JSON OpenAPI 3.0 or 3.1 document, validates
document structure, resolves local references, enumerates operations, builds
audited object-root input schemas from path/query/header parameters and JSON
request bodies, translates 3.0 nullability, preserves security OR/AND
metadata, and emits deterministic source/contract/toolset hashes plus
`diffManifests()`. Unsupported constraints are rejected in strict mode and
reported when droppable in permissive mode; composition and remote references
are always rejected. Output is metadata, not runnable tools. Response schemas,
composed `$ref` forms, explicit authentication policies/scopes, upstream
execution, outbound destination policy, cancellation binding, Inspector
conformance, and an end-to-end example remain open, so the exit criteria are
not yet met.

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

- [ ] Separate inbound MCP authorization from upstream credentials.
- [ ] Add pluggable upstream credential providers.
- [ ] Add encrypted secret storage abstraction.
- [ ] Support required OAuth flows.
- [ ] Handle refresh, expiry, rotation, and revocation.
- [ ] Implement tenant, principal, and tool quotas.
- [ ] Implement concurrency limits and retry-after behavior.

**Exit criteria:** unauthorized requests fail closed, secrets remain protected, and quota enforcement works across processes when using a distributed adapter.

## Milestone 6 — JSON navigation, logging, and analytics

- [ ] Add bounded JSON path selection.
- [ ] Add filtering, pagination, and shape inspection.
- [ ] Enforce depth, size, and execution limits.
- [ ] Define an injectable logger interface with levels and structured records.
- [ ] Add validated logging configuration, including level validation and environment-variable mapping.
- [ ] Enforce secret and sensitive-field redaction at the logger boundary; exclude request and response bodies by default.
- [ ] Correlate log records with request, tool call, and contract revision identifiers.
- [ ] Define output sinks, retention, and separation between diagnostic and audit logs.
- [ ] Test level filtering, redaction, correlation fields, and logger-failure isolation.
- [ ] Emit structured usage and performance events.
- [ ] Integrate OpenTelemetry.
- [ ] Define retention and redaction defaults.

**Exit criteria:** large and adversarial JSON documents remain bounded; analytics and logs exclude secrets and response bodies by default; and logs honor the configured level, emit structured and correlated records, and cannot change tool results when delivery fails.

## Milestone 7 — Generated servers

- [ ] Implement `init`, `validate`, `build`, `serve`, and `export`.
- [ ] Generate a portable project with a pinned contract revision.
- [ ] Share runtime and policy implementations.
- [ ] Add generation manifests and reproducibility checks.
- [ ] Add Docker templates and deployment documentation.
- [ ] Test generated projects from clean installations.

**Exit criteria:** an exported server builds and runs independently.

## Milestone 8 — Dynamic gateway

- [ ] Add versioned contract registry.
- [ ] Bind each contract revision to tenant policy.
- [ ] Load and reload revisions atomically.
- [ ] Enforce per-contract authentication and network policies.
- [ ] Support rollback and revision disabling.
- [ ] Test tenant isolation and concurrent reloads.

**Exit criteria:** multiple contracts can be served safely without cross-tenant access.

## Milestone 9 — Stable release

- [ ] Complete public API review.
- [ ] Publish supported-version matrix.
- [ ] Complete security and dependency review.
- [ ] Add load, resilience, and fault-injection tests.
- [ ] Document migration and rollback procedures.
- [ ] Configure signed releases and software bill of materials.
- [ ] Meet all 1.0 release gates in `RELEASES.md`.

## Deferred and out of scope

The following are recorded in `docs/risk-register.md` with status and
re-evaluation triggers. They are deliberately not milestones:

- OAuth discovery, refresh, rotation, and revocation (revisit only with a real
  OAuth-required contract; placeholder OAuth is forbidden by `AGENTS.md`).
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

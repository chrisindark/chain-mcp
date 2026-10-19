# ChainMcp Roadmap

This roadmap is the delivery plan and source of truth for project progress.

A checkbox may be marked complete only after implementation, tests, documentation, and acceptance criteria have been verified.

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

- [ ] Integrate the official TypeScript MCP SDK.
- [ ] Support local stdio transport.
- [ ] Add tool listing and invocation handlers.
- [ ] Map runtime errors to safe MCP results.
- [ ] Test against a real MCP client.
- [ ] Add transport lifecycle and shutdown handling.

**Exit criteria:** an MCP client can discover and call a test tool end to end.

## Milestone 3 — OpenAPI compiler

- [ ] Parse and validate OpenAPI 3.0 and 3.1.
- [ ] Map operations, parameters, request bodies, and response schemas.
- [ ] Generate stable tool names and descriptions.
- [ ] Translate supported JSON Schema constructs into validators.
- [ ] Map authentication schemes to explicit policies.
- [ ] Report unsupported constructs and ambiguous mappings.
- [ ] Bind `context.signal` to generated upstream calls and release executor resources on timeout or cancellation.
- [ ] Add deterministic compiler tests and fixtures.

**Exit criteria:** a representative API contract compiles into validated tools with documented limitations, and generated executors bind the cancellation signal to upstream I/O.

## Milestone 4 — Smart caching and token accounting

- [ ] Add bounded in-memory cache for development.
- [ ] Add optional Redis adapter.
- [ ] Implement safe, versioned, hashed cache key construction and identity partitioning.
- [ ] Cache eligible read operations only by default.
- [ ] Add TTL, invalidation, and field projection.
- [ ] Integrate tokenizer adapters.
- [ ] Distinguish exact counts from estimates.
- [ ] Record cache hit ratio and token metrics.

**Exit criteria:** tests demonstrate cache isolation and accurate labeling of token measurements.

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

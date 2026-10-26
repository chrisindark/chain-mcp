# Risk register

A catalogue of known failure modes for MCP servers, with an explicit status and
disposition. This is **not** a roadmap. `ROADMAP.md` remains the source of
truth for delivery; this file exists so that real risks are neither lost nor
mistaken for commitments.

## Provenance

The raw material is a condensed triage of open issues in OSS MCP servers and
clients, recorded in `ISSUES.md`. Issue trackers over-represent edge cases from
large deployments, so they are useful as a list of failure modes and test
fixtures, not as a priority list. Severity labels copied from a source tracker
are not our priority.

## Intake gate

An item enters `ROADMAP.md` or the active backlog only when at least one is
true:

1. It is reproducible in this repository with a failing test.
2. It blocks the current vertical slice or the golden path (one runnable
   example an MCP client can use).

Everything else stays here with a trigger for re-evaluation. Priority is
derived from this gate, not from a source tracker's `[P0]` label.

| Disposition | Meaning                                                             |
| ----------- | ------------------------------------------------------------------- |
| **Now**     | Passes the gate; belongs to the active milestone / vertical slice.  |
| **Next**    | Passes the gate; scheduled after the current slice.                 |
| **Defer**   | No failing test and not on the golden path; revisit at the trigger. |
| **Drop**    | Out of scope for the current product direction; reason recorded.    |
| **Done**    | Implemented and covered by tests; keep as a regression check.       |

The 1.0 release gate tracks all Phase 1, Phase 2, and Phase 3 risks as
verified against automated test suites and architectural boundaries.
Post-1.0 enterprise enhancements (declarative UI builder, hosted control plane)
remain deferred per `ROADMAP.md` and `AGENTS.md`.

## Phase 1 — Security

| ID     | Risk                                                      | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Disposition | Target or trigger                                                                |
| ------ | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | -------------------------------------------------------------------------------- |
| SEC-01 | Authenticate protected MCP endpoints                      | Done: Streamable HTTP and stdio transports in `@chainmcp/server` authenticate inbound callers via bearer token, API key, and JWT verifiers (`createBearerTokenVerifier`, `createApiKeyVerifier`, `createJwtVerifier`, `createInboundVerifier`). Signatures and temporal claims (exp, nbf, iss, aud) are verified, and caller identity (`tenantId`, `principalId`, `scopes`) is wired directly to `ToolContext` and MCP `AuthInfo` before tool dispatch. 401 Unauthorized with `WWW-Authenticate: Bearer` is returned when authentication is required. | Done        | Regression checks in `@chainmcp/server` (`http.test.ts`) & inspector conformance |
| SEC-02 | Translate OpenAPI security schemes correctly              | Done: explicit OR/AND policy, credential metadata, scope validation, pluggable credential resolution, and executor injection are implemented and tested                                                                                                                                                                                                                                                                                                                                                                                               | Done        | Regression check                                                                 |
| SEC-03 | Robust OAuth discovery and token refresh                  | Done: OAuth 2.0 Client Credentials flow with configurable expiry skew margin, atomic re-acquisition, store-safe cache keys, and invalidation. Standalone and executor egress paths enforced                                                                                                                                                                                                                                                                                                                                                           | Done        | Refresh-token flow deferred to post-1.0                                          |
| SEC-04 | Enforce tenant isolation and resource ownership           | Done across core runtime, generated servers, and dynamic gateway (M9); namespace isolation, tenant-scoped contract revisions, and partitioned cache keys prevent cross-tenant data leakage                                                                                                                                                                                                                                                                                                                                                            | Done        | Regression check in gateway & core                                               |
| SEC-05 | Argument-level and output-level policy enforcement        | Done: argument validation, operation scopes, output redaction hooks, token budget accounting, and declarative field projection enforced before results are returned or cached                                                                                                                                                                                                                                                                                                                                                                         | Done        | Regression check                                                                 |
| SEC-06 | Block SSRF, unsafe redirects, and private-network targets | Done in `@chainmcp/executor` for HTTP, including OAuth token requests: exact allowlist, public-address classification, DNS pinning/peer check, same-origin redirects, caps, and signal cancellation. Standalone token fetcher enforces HTTPS and allowlist                                                                                                                                                                                                                                                                                            | Done        | Regression check                                                                 |
| SEC-07 | Explicit policy-denial errors and audit events            | Done: typed `RuntimeError` codes (`AUTH_FORBIDDEN`, `AUTH_REQUIRED`, `RATE_LIMITED`, `INPUT_INVALID`) and structured audit log sinks ensure safe diagnostic logging without leaking secrets                                                                                                                                                                                                                                                                                                                                                           | Done        | Regression check in core runtime                                                 |

Notes:

- `SEC-03` must not become a placeholder OAuth implementation; `AGENTS.md`
  explicitly forbids that.
- `SEC-06` includes loopback, private, link-local, multicast, and metadata
  ranges; redirect revalidation; DNS-rebinding pinning; no scheme or port
  escalation; and explicit proxy configuration.
- `SEC-06b` from the raw triage (dependency and secret scanning) is Milestone 0
  process work; completed in CI (audit check, Dependabot, Gitleaks, and dependency review).

## Phase 2 — Tool generation

| ID     | Risk                                                  | Status                                                                                                                             | Disposition           | Target or trigger                    |
| ------ | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------- | ------------------------------------ |
| GEN-01 | Resolve nested OpenAPI references and definitions     | Done for local refs with cycle/depth limits; remote refs rejected                                                                  | Done                  | Revisit if remote refs are required  |
| GEN-02 | Preserve validation constraints and required fields   | Done for documented input subsets (required, enums, formats, numeric/string/array/object constraints) and response output policies | Done                  | Regression check                     |
| GEN-03 | Resolve per-operation server URLs safely              | Done: server URLs validated against the destination policy and host allowlist                                                      | Done                  | Regression check                     |
| GEN-04 | Handle JSON, multipart, binary, and media types       | Partial: JSON inputs and responses fully supported; streaming/multipart open for post-1.0 extension                                | Done / Defer (binary) | Post-1.0 media streaming             |
| GEN-05 | Validate MCP protocol conformance                     | Done: SDK client/server tests and Inspector CLI verification for `tools/list` and `tools/call` run in CI                           | Done                  | Verified against official MCP SDK v2 |
| GEN-06 | Detect invalid schemas, circular refs, naming clashes | Done: compiler diagnostics, re2js regex checking, and input-schema audit prevent schema poisoning and clashes                      | Done                  | Compiler regression tests            |
| GEN-07 | Make generated output deterministic and reproducible  | Done: compiler manifests, SHA-256 toolset hash, and deterministic AST codegen ensure identical output for unchanged contracts      | Done                  | CLI generate & diff tests            |

## Phase 3 — Runtime reliability

| ID     | Risk                                                  | Status                                                                                                                                                                                                                                                                                                       | Disposition | Target or trigger                                                          |
| ------ | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------- | -------------------------------------------------------------------------- |
| RUN-01 | Isolate blocking synchronous operations               | Controlled: zero sync I/O in runtime code; enforced by ESLint custom rule `chainmcp/no-blocking-io` in CI                                                                                                                                                                                                    | Done        | Continuous CI enforcement                                                  |
| RUN-02 | Enforce execution deadlines and cancellation limits   | Done: total timeout enforcement and cooperative AbortSignal cancellation in core runtime and upstream executor                                                                                                                                                                                               | Done        | Regression & resilience tests                                              |
| RUN-03 | Retries, backoff, circuit breakers, and health checks | Done: safe degradation for cache/metrics/limiter outages; rate limiters return explicit `retryAfterSeconds` backoff hints; fault-injection test suite verifies graceful operation                                                                                                                            | Done        | Circuit breaker open for post-1.0                                          |
| RUN-04 | Clean up orphaned processes and containers            | Done: graceful shutdown hooks close transport servers, active sockets, and timers without orphan leaks                                                                                                                                                                                                       | Done        | Server and gateway tests                                                   |
| RUN-05 | Support and test required HTTP transports             | Done: Streamable HTTP and stdio transports in `@chainmcp/server` (`serveHttp`, `serveStdio`), CLI `--transport <stdio\|http>`, `--port`, `--host`, `--path`, Docker `EXPOSE 3333`, and full integration test coverage with official `@modelcontextprotocol/client` and `@modelcontextprotocol/inspector` CLI | Done        | Verified with MCP client & inspector (`scripts/inspector-conformance.mjs`) |
| RUN-06 | Concurrent startup and supported operating systems    | Done: supported version matrix (`docs/supported-versions.md`), Node.js 20/22 LTS, and multi-tenant high-concurrency load suite                                                                                                                                                                               | Done        | Hardened for 1.0 release                                                   |
| RUN-07 | Prevent stale OAuth state and refresh failures        | Done: Client Credentials flow with expiry skew margin, atomic re-acquisition, store-safe cache keys, and cache invalidation. Stale cross-process tokens bounded by expiration                                                                                                                                | Done        | Regression check in auth & executor                                        |

Note: `RUN-03` must not introduce implicit retries for non-idempotent
operations, per `DEVELOPMENT.md`.

Notes on Milestone 5 limits after the implementation audit:

- `SEC-03`/`RUN-07`: a `SecretStore` cannot be scanned, so `invalidate()` clears
  only entries the instance knows about. Cross-process revocation requires
  deleting `buildOAuthTokenStoreKey(...)` from the shared store or relying on
  token expiry.
- `SEC-06`: inside `@chainmcp/executor`, OAuth token requests run through the
  same destination policy and pinned transport as API requests. Used standalone,
  the built-in fetcher enforces HTTPS, an explicit host allowlist, redirect
  refusal, and size caps but uses the platform fetch, which does not pin the
  resolved address.
- Rate limiting: in-memory windows are bounded by least-recently-used eviction
  (`maxTrackedWindows`, default 10,000), so an evicted identity can make one
  extra request before its window rebuilds. Concurrency denials report a
  one-second lower bound rather than an exact release time.

## Phase 4 — Enterprise and releases

| ID     | Risk                                           | Status                                                                                                                       | Disposition | Target or trigger                      |
| ------ | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------- | -------------------------------------- |
| ENT-01 | Detect and review upstream tool-schema changes | Done: satisfied by the GEN-07 SHA-256 toolset hash and CLI diffing                                                           | Done        | Regression checks in CLI               |
| ENT-02 | Approval gates for sensitive tool calls        | Open                                                                                                                         | Defer       | Post-1.0 enterprise review             |
| ENT-03 | Version tool manifests and record trust checks | Done: generation manifest with schema hashes, tool counts, and CLI provenance metadata                                       | Done        | Regression checks in compiler and CLI  |
| ENT-04 | Pluggable storage and configuration rollback   | Done: dynamic gateway supports atomic contract revisions, tenant isolation, and atomic rollback (`gateway.rollbackContract`) | Done        | Regression checks in gateway           |
| ENT-05 | Audit dashboards, metrics, and usage metering  | Drop: hosted SaaS control plane out of open-source MVP per `AGENTS.md`                                                       | Drop        | Hosted SaaS control plane; `AGENTS.md` |
| ENT-06 | Versioned releases and compatibility guidance  | Done: `docs/supported-versions.md`, `RELEASES.md`, and 1.0 release gates                                                     | Done        | Maintained per release                 |

## Not captured by the triage

These are core elements of the ChainMcp architecture implemented across the roadmap:

| Gap                                        | Why it matters                                                                                                        | Status                                                                   |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Runnable example and getting-started guide | `examples/petstore` and `docs/getting-started.md` provide a built, Inspector-verified path from contract to tool call | Done                                                                     |
| Code-first authoring for non-OpenAPI tools | `@chainmcp/authoring` provides `defineTool`, declarative schema builders, and composition                             | Done (M8)                                                                |
| Output projection and token budget         | Quality differentiator; prevents context window exhaustion and prompt flooding                                        | Done (runtime hook, budget accounting, and declarative field projection) |
| Toolset hash and regeneration diff         | Makes schema drift and unintended breaking changes observable in CI                                                   | Done (M7 CLI diff)                                                       |
| Dynamic gateway and contract registry      | Multi-tenant live contract loading, versioned dispatch, and zero-downtime rollback                                    | Done (M9 `@chainmcp/gateway`)                                            |

## Re-evaluation triggers

Review the deferred rows when any of these occurs:

- Remote transport or an inbound HTTP endpoint is proposed.
- The first upstream HTTP executor is implemented.
- An OAuth-protected API becomes a target contract.
- The first generated server is exported (M7).
- A tenant, enterprise, or hosted-service requirement is raised.
- A declarative tool builder or admin UI is proposed (post-1.0; requires an ADR).
- Any deferred risk is reproduced with a failing test.

When a trigger fires, move the item into `ROADMAP.md` as an acceptance
criterion rather than creating a parallel issue list.

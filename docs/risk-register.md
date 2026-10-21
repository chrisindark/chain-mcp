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

| Disposition | Meaning                                                                |
| ----------- | ---------------------------------------------------------------------- |
| **Now**     | Passes the gate; belongs to the current vertical slice (M3 + example). |
| **Next**    | Passes the gate; scheduled after the current slice.                    |
| **Defer**   | No failing test and not on the golden path; revisit at the trigger.    |
| **Drop**    | Out of scope for the current product direction; reason recorded.       |
| **Done**    | Implemented and covered by tests; keep as a regression check.          |

Nine items pass the gate for the current slice: `SEC-02`, `SEC-05` (output
half), `SEC-06`, `GEN-01`, `GEN-02`, `GEN-05`, `GEN-06`, `GEN-07`, `RUN-01`.
They appear as acceptance criteria in Milestones 3 and 4 or in the
cross-cutting criteria, not as a separate backlog.

## Phase 1 — Security

| ID     | Risk                                                      | Status                                                                                                                | Disposition            | Target or trigger                                |
| ------ | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------ |
| SEC-01 | Authenticate protected MCP endpoints                      | Not applicable: stdio only, no inbound HTTP                                                                           | Defer                  | Before any remote transport (M5)                 |
| SEC-02 | Translate OpenAPI security schemes correctly              | Open                                                                                                                  | **Now**                | M3                                               |
| SEC-03 | Robust OAuth discovery and token refresh                  | Open                                                                                                                  | Defer                  | Only when an OAuth-required API is a target (M5) |
| SEC-04 | Enforce tenant isolation and resource ownership           | Done in core and server (ADR 0008); gateway coverage open                                                             | Done / Defer           | Gateway path in M8                               |
| SEC-05 | Argument-level and output-level policy enforcement        | Partial: argument validation, operation scopes, and the runtime output hook/budget are done; no built-in field policy | **Now** (field policy) | Runtime hook in M4; concrete field policy in M6  |
| SEC-06 | Block SSRF, unsafe redirects, and private-network targets | Open: no outbound HTTP exists yet                                                                                     | **Now**                | Land with the first outbound HTTP call (M3)      |
| SEC-07 | Explicit policy-denial errors and audit events            | Partial: typed denials and safe mapping done; audit events open                                                       | Defer (audit)          | M6                                               |

Notes:

- `SEC-03` must not become a placeholder OAuth implementation; `AGENTS.md`
  explicitly forbids that.
- `SEC-06` includes loopback, private, link-local, multicast, and metadata
  ranges; redirect revalidation; DNS-rebinding pinning; no scheme or port
  escalation; and explicit proxy configuration.
- `SEC-06b` from the raw triage (dependency and secret scanning) is Milestone 0
  process work, not a service feature; `ROADMAP.md` already tracks it.

## Phase 2 — Tool generation

| ID     | Risk                                                  | Status                                                           | Disposition | Target or trigger                     |
| ------ | ----------------------------------------------------- | ---------------------------------------------------------------- | ----------- | ------------------------------------- |
| GEN-01 | Resolve nested OpenAPI references and definitions     | Open                                                             | **Now**     | M3                                    |
| GEN-02 | Preserve validation constraints and required fields   | Open: core validates a documented subset; compiler must preserve | **Now**     | M3                                    |
| GEN-03 | Resolve per-operation server URLs safely              | Open                                                             | Defer       | After M3, tied to the SSRF allowlist  |
| GEN-04 | Handle JSON, multipart, binary, and media types       | Open                                                             | Defer       | Post-M3; JSON only in the first slice |
| GEN-05 | Validate MCP protocol conformance                     | Partial: SDK client/server pair tested; Inspector/CI check open  | **Now**     | M3 (conformance test, not a feature)  |
| GEN-06 | Detect invalid schemas, circular refs, naming clashes | Partial: input-schema audit exists; compiler diagnostics open    | **Now**     | M3                                    |
| GEN-07 | Make generated output deterministic and reproducible  | Open                                                             | **Now**     | M3; also satisfies ENT-01             |

## Phase 3 — Runtime reliability

| ID     | Risk                                                  | Status                                             | Disposition | Target or trigger                               |
| ------ | ----------------------------------------------------- | -------------------------------------------------- | ----------- | ----------------------------------------------- |
| RUN-01 | Isolate blocking synchronous operations               | Controlled: no sync I/O found in `packages/*/src`  | **Now**     | Lint/CI rule, not a feature                     |
| RUN-02 | Enforce execution deadlines and cancellation limits   | Done: timeout rejection and cooperative abort (M1) | Done        | Regression tests exist                          |
| RUN-03 | Retries, backoff, circuit breakers, and health checks | Open                                               | Defer       | Only when a real upstream demonstrates the need |
| RUN-04 | Clean up orphaned processes and containers            | Open                                               | Defer       | Only if container templates ship (M7)           |
| RUN-05 | Support and test required HTTP transports             | Open: stdio only                                   | Defer       | With SEC-01 and SEC-03 (M5)                     |
| RUN-06 | Concurrent startup and supported operating systems    | Open                                               | Defer       | Release hardening (M9)                          |
| RUN-07 | Prevent stale OAuth state and refresh failures        | Open                                               | Defer       | With SEC-03 (M5)                                |

Note: `RUN-03` must not introduce implicit retries for non-idempotent
operations, per `DEVELOPMENT.md`.

## Phase 4 — SaaS and enterprise

| ID     | Risk                                           | Status | Disposition | Target or trigger                                |
| ------ | ---------------------------------------------- | ------ | ----------- | ------------------------------------------------ |
| ENT-01 | Detect and review upstream tool-schema changes | Open   | Next        | Satisfied by the GEN-07 toolset hash; diff in M7 |
| ENT-02 | Approval gates for sensitive tool calls        | Open   | Defer       | Revisit with a real enterprise user              |
| ENT-03 | Version tool manifests and record trust checks | Open   | Next        | M7 generation manifest                           |
| ENT-04 | Pluggable storage and configuration rollback   | Open   | Drop        | No persistence or control plane in scope         |
| ENT-05 | Audit dashboards, metrics, and usage metering  | Open   | Drop        | Hosted SaaS control plane; `AGENTS.md`           |
| ENT-06 | Versioned releases and compatibility guidance  | Open   | Next        | M9 and `RELEASES.md`                             |

## Not captured by the triage

These are more important to the current product thesis than most of the items
above, and the raw issue list contains none of them.

| Gap                                        | Why it matters                                                                                 | Status                                            |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Runnable example and getting-started guide | `docs/getting-started.md` and `examples/README.md` are empty; no evidence a user has succeeded | **Now**                                           |
| Output projection and token budget         | The quality differentiator; also the open half of SEC-05                                       | Done (runtime hook and budget); field policy Next |
| Toolset hash and regeneration diff         | Makes GEN-07 and ENT-01 observable in CI                                                       | **Now**                                           |
| `lint-tools` and a smoke eval in CI        | Turns tool-quality judgment into a repeatable check                                            | Next                                              |
| Composite/intent tool definitions          | Curation beyond route mapping; cannot be produced by endpoint conversion                       | Next                                              |

## Re-evaluation triggers

Review the deferred rows when any of these occurs:

- Remote transport or an inbound HTTP endpoint is proposed.
- The first upstream HTTP executor is implemented.
- An OAuth-protected API becomes a target contract.
- The first generated server is exported (M7).
- A tenant, enterprise, or hosted-service requirement is raised.
- Any deferred risk is reproduced with a failing test.

When a trigger fires, move the item into `ROADMAP.md` as an acceptance
criterion rather than creating a parallel issue list.

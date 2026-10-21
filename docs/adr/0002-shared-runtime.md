# ADR 0002 — Shared runtime for generated and dynamic execution

- Status: accepted
- Recorded: 2026-10-19 (reconstructed from existing documentation and implementation; no new decision)

## Context and problem

ChainMcp supports two delivery modes:

- a generated server that packages a single compiled contract, and
- a dynamic gateway that serves multiple versioned contracts from one process.

Both modes need the same authorization, caching, rate limiting, timeout,
cancellation, metrics, error mapping, and JSON-navigation behavior. Duplicating
that behavior in generated code would create security drift, inconsistent error
handling, and a large maintenance surface. Generated projects must also remain
portable and independent of the ChainMcp repository at runtime.

## Decision

Use one shared runtime for both modes.

- The compiler emits deterministic tool definitions and contract metadata, not a
  private copy of the execution pipeline.
- Generated servers depend on the published shared runtime package and pin its
  version through a lockfile.
- The dynamic gateway loads the same runtime and registers contract revisions
  into isolated registries.
- Transport adapters, policy adapters, and infrastructure integrations stay
  behind interfaces so the runtime remains transport-neutral and independently
  testable.
- Policy logic must not depend on whether the caller is a generated server or
  the gateway.

## Alternatives considered

- **Generate a complete server including runtime logic.** Rejected: security
  fixes and behavior changes would have to be re-generated and redeployed for
  every contract.
- **Embed the runtime only in the gateway.** Rejected: generated servers must run
  independently without a hosted control plane.
- **Maintain separate generated and gateway runtimes.** Rejected: duplicate
  authorization, cache, and error semantics would drift.
- **Expose the runtime only through the MCP server package.** Rejected: the
  runtime must be testable without a running MCP transport or external
  infrastructure.

## Consequences and trade-offs

- Both modes share one behavior and one test suite, reducing security drift.
- Generated projects depend on a compatible runtime version; upgrades require
  normal package version management.
- The runtime cannot depend on a specific transport, cache, database, or cloud
  SDK without an adapter boundary.
- Generated source remains smaller and easier to audit, while the runtime becomes
  a critical shared dependency.

## Security implications

- Authorization, credential separation, redaction, and cache isolation are
  implemented once rather than re-created per generated project.
- A runtime defect can affect both delivery modes; releases therefore require
  compatibility and security review.
- Generated projects must never embed production credentials or forked policy
  logic.
- The runtime must enforce limits and cancellation consistently regardless of
  the transport or deployment mode.

## Follow-up actions

- Make the compiler emit tools against the shared runtime interface
  (Milestone 3).
- Verify generated projects build and run from clean installations
  (Milestone 7).
- Verify the gateway uses the same runtime with atomic revision loading
  (Milestone 9).
- Keep `API_REFERENCE.md` and package boundaries synchronized with runtime
  changes.

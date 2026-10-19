# Changelog

All notable project changes are recorded here.

The project is pre-release. Versions and release dates must reflect actual published artifacts.

## Unreleased

### Documentation

- Define product vision and package boundaries.
- Specify generated-server and dynamic-gateway modes.
- Define configuration and public interface contracts.
- Document security requirements and release gates.
- Establish coding-agent workflow and roadmap milestones.
- Add explicit production logging requirements to Milestone 6.
- Document timeout and cancellation as cooperative `AbortSignal` propagation, with executor responsibility for resource release.
- Record ADRs 0001–0006 and add an ADR index with statuses.
- Document the implemented Milestone 1 `RuntimeEvent` shape and mark `cache_hit`, `tokenCount`, `attributes`, and optional event fields as Milestone 4/6 targets rather than current behavior.
- Document authorization and rate-limit adapter contracts, including the distinction between policy denial and adapter failure.

### Implementation

- Add a pnpm workspace with strict TypeScript, lint/format, test, typecheck, build, and CI configuration.
- Add `@chainmcp/core` with registration, discovery, supported-subset input validation, authorization/rate-limit hooks, timeout/cancellation handling, metrics, and deterministic identity-partitioned cache-key serialization.
- Add `@chainmcp/config` with strict Zod validation and defaults for the implemented configuration subset.
- Wrap unexpected execution failures in a stable, safe runtime error and keep metrics delivery from delaying tool results.
- Fix input validation to enforce array-valued (`type: [...]`) declarations and object/array keywords in schemas that omit `type`; empty or malformed type declarations now fail closed.
- Reject unsupported validation keywords and schema forms at tool registration with `CONTRACT_INVALID` instead of silently skipping them. Bound schema nesting to 32 levels, reject cyclic schemas, and cap validation depth so hostile input cannot surface as `UPSTREAM_FAILURE`.
- Export `auditInputSchema` and its diagnostic types from `@chainmcp/core` so the compiler can apply the same supported-schema rules at compile time.
- Hash cache keys with SHA-256 under a versioned namespace, bound canonical input to 64 KiB, and omit `undefined` object properties.
- Classify invocation failures by stage. Untyped authorizer failures now fail closed as `AUTH_FORBIDDEN` with a safe message and retain their cause instead of surfacing as `UPSTREAM_FAILURE`.
- Replace the throwing `RateLimiter.check` contract with an explicit `RateLimitDecision`. Only `{ allowed: false }` produces `RATE_LIMITED` and the `rate_limited` metrics outcome; limiter failures, missing decisions, and a thrown `RATE_LIMITED` code become `UPSTREAM_FAILURE`.
- Preserve typed authorization failures so operators can distinguish policy denial from adapter infrastructure failure.
- Compare object keys as own properties during validation. `additionalProperties: false` now rejects undeclared keys named after `Object.prototype` members such as `toString` or `__proto__`, and `required` is no longer satisfied by an inherited name.
- Cap reported validation issues at 20 per call and append a truncation marker, so a large invalid input can no longer inflate the client-facing `INPUT_INVALID` message.

### Breaking changes

- `RateLimiter.check` now returns `RateLimitDecision` (`{ allowed: boolean }`) instead of `Promise<void>`. Throwing `RuntimeError("RATE_LIMITED")` no longer denies a call; it is treated as a limiter failure. The package is pre-1.0, so this change is recorded rather than deprecated. See `docs/adr/0006-stage-aware-policy-errors.md`.

### Limitations

- No MCP server, OpenAPI compiler, CLI, gateway, upstream HTTP executor, or concrete cache/auth/rate-limit adapter is included.
- The core input validator supports only the subset documented in `API_REFERENCE.md`.
- License selection remains unresolved; the existing `LICENSE` file is empty.

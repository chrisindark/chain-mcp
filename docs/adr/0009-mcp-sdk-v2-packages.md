# ADR 0009 — MCP SDK v2 package split and pin

- Status: proposed
- Recorded: 2026-10-20 (documents the implemented Milestone 2 dependency choice)

## Context and problem

Milestone 2 integrates the official TypeScript MCP SDK. The adapter needs the
server APIs at runtime and a protocol client for end-to-end interoperability
tests. SDK package boundaries and version changes affect the public adapter's
integration surface, so dependency placement and upgrade policy should be
explicit.

## Decision

- Depend on `@modelcontextprotocol/server` from `@chainmcp/server` at runtime.
- Depend on `@modelcontextprotocol/client` only as a development dependency for
  integration tests.
- Pin both packages to exact version `2.3.1` (updated from `2.0.0` following
  compatibility verification and security review); keep the lockfile aligned.
- Treat an SDK upgrade as a reviewed compatibility change: update both package
  declarations and the lockfile together, then run typecheck, tests, and build.

## Alternatives considered

- **Use a version range.** Deferred because this pre-1.0 adapter integrates a
  specific SDK major and should not silently change protocol behavior on
  dependency refresh.
- **Use the client package in production.** Rejected because the adapter only
  serves requests; client functionality is needed for tests, not runtime.
- **Use a project-local protocol implementation.** Rejected because the
  project relies on the official SDK to implement MCP protocol behavior.

## Consequences and trade-offs

- Runtime installation includes the server package but not the SDK client.
- The exact pin makes dependency updates deliberate and keeps CI reproducible.
- Security and bug fixes in the SDK require an intentional version update and
  compatibility review.

## Security implications

- Protocol parsing and transport behavior remain delegated to the official SDK.
- Exact version pins reduce unreviewed dependency drift but do not replace
  dependency vulnerability review or timely updates.

## Follow-up actions

- Review and accept this dependency decision.
- On SDK updates, verify package boundaries, request context propagation,
  schema conversion, cancellation, and transport lifecycle behavior.

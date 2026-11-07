# @chainmcp/admin

## 0.4.0

### Patch Changes

- @chainmcp/auth@0.4.0
  - @chainmcp/core@0.4.0
  - @chainmcp/declarative@0.4.0
  - @chainmcp/executor@0.4.0
  - @chainmcp/gateway@0.4.0

## 0.3.1

### Patch Changes

- Updated dependencies
  - @chainmcp/core@0.3.1
  - @chainmcp/auth@0.3.1
  - @chainmcp/declarative@0.3.1
  - @chainmcp/executor@0.3.1
  - @chainmcp/gateway@0.3.1

## 0.3.0

### Minor Changes

- 26e83fe: Allow `DeclarativeAdmin` to take an injectable upstream `transport` and
  `resolveHost`, at the admin level and per contract binding. Descriptor-backed
  tools previously always resolved hosts with system DNS and sent requests
  through the built-in fetch transport, so callers could not stub an upstream in
  tests or route traffic through a custom agent. A binding-level `transport` or
  `resolveHost` overrides the admin-wide value for that contract; both options
  are optional and default to the previous behavior.
- 26e83fe: Add `@chainmcp/admin`, the self-hosted operator surface for declarative HTTP
  tools. Bearer tokens with explicit tenant scopes unlock validate, static
  preview, publish, active-tool, and revision-history routes under `/api/v1`,
  plus a dependency-free console. Publication lowers descriptors through a fresh
  bounded executor and hands the tools to `DynamicGateway.publishContract()`, so
  tenant ownership, revisions, activation, collision checks, and audit stay in
  the gateway. The Node transport binds loopback by default, refuses non-loopback
  binds without `allowRemote`, and validates `Host`, `Origin`, and
  `Sec-Fetch-Site` before the handler runs. Descriptor documents and revisions
  remain in memory until the persistence milestone.
- 26e83fe: Persist declarative descriptor revisions with tenant ownership, revision
  history, restart restore, and rollback. `DescriptorRevisionStore` records move
  through `candidate → active → superseded/failed`, with admin `dset_…` ids linked
  to gateway `rev_…` ids. The default in-memory store keeps prior behavior;
  `FileDescriptorRevisionStore` writes a versioned, schema-validated JSON snapshot
  with `0600` permissions, fsync, and atomic rename, and is single-writer.
  Publication writes a candidate, publishes to the gateway, then activates it, so
  a store rejection prevents publication and a gateway rejection marks the
  candidate failed. `POST .../rollback` revalidates a stored superseded revision
  and republishes it with `rollbackOf`, and `DeclarativeAdmin.restore()`
  republishes active records after a restart. Persisted descriptors contain no
  credentials and are revalidated on restore and rollback.
- 180f2f0: Documentation truth pass (P0-8).

  - README now says the project is pre-1.0 and that the 1.0 release is deliberately withheld; registry `npx @chainmcp/cli` and bare `chainmcp` examples are marked as requiring publishing or an installed CLI (clone path is `node packages/cli/dist/bin.js`); intended technology no longer lists Hono or PostgreSQL (no database metadata store ships); token accounting, JSON navigation, response-schema enforcement, and auth-policy language match the shipped behavior.
  - `docs/getting-started.md`: response schemas are enforced by the executor when `server.validateResponses` is `warn`/`enforce`; authentication policies are not enforced by the compiler. Code-first init examples now include `--local-deps`.
  - `docs/deployment.md`: generated-server install and Dockerfile steps now use pnpm in local-deps mode.
  - `docs/product-guide.md`: softened `reduce payloads by up to 90%`, `sub-millisecond`, and `military-grade` marketing claims; corrected metric names to the four emitted by `OpenTelemetryMetricsSink` (`chainmcp.tool.invocations`, `chainmcp.tool.duration`, `chainmcp.tool.tokens`, `chainmcp.tool.payload_bytes`); clarified JSON navigation requires the full document supplied inline.
  - Added a CI drift guard: `pnpm docs:check` validates that every documented capability in `docs/capability-evidence.json` points to a real test file or exported API, and that the README `## Core capabilities` bullets are all covered. Wired into `pnpm check` and CI.

### Patch Changes

- 5ea3ece: Add package metadata, READMEs, licenses, engines, homepage, and repository links across all workspace packages for npm distribution.
- Updated dependencies [26e83fe]
- Updated dependencies [723c5dd]
- Updated dependencies [180f2f0]
- Updated dependencies [99483c5]
- Updated dependencies [f51ff52]
- Updated dependencies [147ef5e]
- Updated dependencies [8df778b]
- Updated dependencies [805c5a4]
- Updated dependencies [1bb1a2a]
- Updated dependencies [5f3f111]
- Updated dependencies [c371655]
- Updated dependencies [c214e77]
- Updated dependencies [46e3b31]
- Updated dependencies [8252a3a]
- Updated dependencies [998b681]
- Updated dependencies [e543870]
- Updated dependencies [8df778b]
- Updated dependencies [5ea3ece]
- Updated dependencies [8c8483c]
  - @chainmcp/declarative@0.3.0
  - @chainmcp/executor@0.3.0
  - @chainmcp/gateway@0.3.0
  - @chainmcp/core@0.3.0
  - @chainmcp/auth@0.3.0

## 0.2.0

### Minor Changes

- 26e83fe: Allow `DeclarativeAdmin` to take an injectable upstream `transport` and
  `resolveHost`, at the admin level and per contract binding. Descriptor-backed
  tools previously always resolved hosts with system DNS and sent requests
  through the built-in fetch transport, so callers could not stub an upstream in
  tests or route traffic through a custom agent. A binding-level `transport` or
  `resolveHost` overrides the admin-wide value for that contract; both options
  are optional and default to the previous behavior.
- 26e83fe: Add `@chainmcp/admin`, the self-hosted operator surface for declarative HTTP
  tools. Bearer tokens with explicit tenant scopes unlock validate, static
  preview, publish, active-tool, and revision-history routes under `/api/v1`,
  plus a dependency-free console. Publication lowers descriptors through a fresh
  bounded executor and hands the tools to `DynamicGateway.publishContract()`, so
  tenant ownership, revisions, activation, collision checks, and audit stay in
  the gateway. The Node transport binds loopback by default, refuses non-loopback
  binds without `allowRemote`, and validates `Host`, `Origin`, and
  `Sec-Fetch-Site` before the handler runs. Descriptor documents and revisions
  remain in memory until the persistence milestone.
- 26e83fe: Persist declarative descriptor revisions with tenant ownership, revision
  history, restart restore, and rollback. `DescriptorRevisionStore` records move
  through `candidate → active → superseded/failed`, with admin `dset_…` ids linked
  to gateway `rev_…` ids. The default in-memory store keeps prior behavior;
  `FileDescriptorRevisionStore` writes a versioned, schema-validated JSON snapshot
  with `0600` permissions, fsync, and atomic rename, and is single-writer.
  Publication writes a candidate, publishes to the gateway, then activates it, so
  a store rejection prevents publication and a gateway rejection marks the
  candidate failed. `POST .../rollback` revalidates a stored superseded revision
  and republishes it with `rollbackOf`, and `DeclarativeAdmin.restore()`
  republishes active records after a restart. Persisted descriptors contain no
  credentials and are revalidated on restore and rollback.
- 180f2f0: Documentation truth pass (P0-8).

  - README now says the project is pre-1.0 and that the 1.0 release is deliberately withheld; registry `npx @chainmcp/cli` and bare `chainmcp` examples are marked as requiring publishing or an installed CLI (clone path is `node packages/cli/dist/bin.js`); intended technology no longer lists Hono or PostgreSQL (no database metadata store ships); token accounting, JSON navigation, response-schema enforcement, and auth-policy language match the shipped behavior.
  - `docs/getting-started.md`: response schemas are enforced by the executor when `server.validateResponses` is `warn`/`enforce`; authentication policies are not enforced by the compiler. Code-first init examples now include `--local-deps`.
  - `docs/deployment.md`: generated-server install and Dockerfile steps now use pnpm in local-deps mode.
  - `docs/product-guide.md`: softened `reduce payloads by up to 90%`, `sub-millisecond`, and `military-grade` marketing claims; corrected metric names to the four emitted by `OpenTelemetryMetricsSink` (`chainmcp.tool.invocations`, `chainmcp.tool.duration`, `chainmcp.tool.tokens`, `chainmcp.tool.payload_bytes`); clarified JSON navigation requires the full document supplied inline.
  - Added a CI drift guard: `pnpm docs:check` validates that every documented capability in `docs/capability-evidence.json` points to a real test file or exported API, and that the README `## Core capabilities` bullets are all covered. Wired into `pnpm check` and CI.

### Patch Changes

- Updated dependencies [26e83fe]
- Updated dependencies [723c5dd]
- Updated dependencies [180f2f0]
- Updated dependencies
- Updated dependencies [99483c5]
- Updated dependencies [f51ff52]
- Updated dependencies [147ef5e]
- Updated dependencies [8df778b]
- Updated dependencies [805c5a4]
- Updated dependencies [1bb1a2a]
- Updated dependencies [5f3f111]
- Updated dependencies [c371655]
- Updated dependencies [c214e77]
- Updated dependencies [46e3b31]
- Updated dependencies [8252a3a]
- Updated dependencies [998b681]
- Updated dependencies [e543870]
- Updated dependencies [8df778b]
- Updated dependencies [8c8483c]
  - @chainmcp/declarative@0.2.0
  - @chainmcp/executor@0.2.0
  - @chainmcp/gateway@0.2.0
  - @chainmcp/core@0.2.0
  - @chainmcp/auth@0.2.0

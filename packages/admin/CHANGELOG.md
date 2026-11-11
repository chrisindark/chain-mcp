# @chainmcp/admin

## 0.7.0

### Minor Changes

- 93822a8: Add one-click client export snippets with secret redaction (M13-5):

  - `@chainmcp/admin`: Added `generateClientExportSnippets()` and client snippet types generating ready-to-paste configurations for Claude Desktop (`claude_desktop_config.json`), Cursor (`.cursor/mcp.json`), and Claude Code CLI for both `stdio` and `sse` transports with OS path guidance.
  - `@chainmcp/admin`: Enforced complete secret redaction via `@chainmcp/config`'s `redactConfigSecrets` and deep object sanitization, ensuring zero credential leakage in snippets and environment instructions.
  - `@chainmcp/admin`: Exposed `GET /api/v1/export/snippets` and `GET /api/v1/tenants/{tenant}/contracts/{contract}/snippets` endpoints with transport, server name, and SSE URL options.
  - `@chainmcp/admin`: Added Client Export Snippets interactive card in Web Studio UI with client tabs (Claude Desktop, Cursor, Claude Code CLI), transport selection, live snippet preview, clipboard copy with visual feedback, and environment variable setup guides.
  - `@chainmcp/cli`: Updated Web Studio to pass configuration AST to admin for snippet generation and added integration tests for snippets endpoints and Web Studio UI components.

- ef31d58: Add Web Studio foundation and `chainmcp studio` command with loopback security, status/telemetry endpoints, and unified storage integration (M13-1).
- 984d136: Add Live Shield & OTel Observability Dashboard from SQLite WAL storage (M13-4):

  - `@chainmcp/storage`: Extended `TelemetryQueryOptions` and `TelemetryRingBuffer` (`MemoryStorageDriver` and `SqliteStorageDriver`) to support `until`, `isError`, `offset`, and `order: "asc" | "desc"` query filters.
  - `@chainmcp/admin`: Added `GET /api/v1/telemetry/metrics` and `GET /api/v1/tenants/{tenant}/telemetry/metrics` endpoints aggregating total requests, cache hit ratio, error rates, p50/p95/p99 duration percentiles, token usage, per-tool breakdown, and 12-bucket timeSeries.
  - `@chainmcp/admin`: Extended `GET /api/v1/telemetry` with status, time bounds, pagination, W3C trace correlation (`traceId`, `spanId`), and automatic secret redaction using `@chainmcp/analytics`.
  - `@chainmcp/admin`: Added Shield & OTel Observability card in Web Studio UI with live metric badges, auto-refresh polling, filter controls, event table, and detail inspection modal.
  - `@chainmcp/cli`: Added Web Studio observability integration tests.

- f0a5ae8: Add interactive projection playground with live upstream test-firing and token savings metrics to Web Studio (M13-3):

  - `@chainmcp/admin`: Added `POST /api/v1/tenants/{tenant}/contracts/{contract}/tools/{toolName}/test` endpoint for direct upstream test-firing with sandboxed execution, non-cached mode, and SSRF enforcement. Evaluates field projections (`include`/`exclude`), measures execution latency, counts raw vs. projected tokens using tokenizer, and reports token savings and percentage reduction with `admin_test_tool` audit records.
  - `@chainmcp/admin`: Added Interactive Projection Playground section in Web Studio UI with tool selector, argument JSON editor, include/exclude field filters, side-by-side Raw vs. Projected diff view, and live token savings metrics badge.
  - `@chainmcp/cli`: Added Web Studio playground integration tests.

- c8a1025: Add visual tool curation, endpoint filtering, and bidirectional configuration sync to Web Studio (M13-2):

  - `@chainmcp/declarative`: Added `enabled?: boolean` on tool descriptors, filtering out disabled tools from `DeclarativeToolSource.getTools()` while preserving descriptors in store.
  - `@chainmcp/config`: Added `tools` filter configuration (`include`, `exclude`) and `filterToolsByConfig` helper to `ContractConfigSchema` and `GatewayContractConfigSchema`.
  - `@chainmcp/admin`: Added `GET .../tools`, `GET .../tools/{toolName}`, `PATCH .../tools/{toolName}`, and `POST .../curate` endpoints with `admin_curate` audit logging and `onConfigSync` notification. Added visual Tools & Curation card in Web Studio UI.
  - `@chainmcp/cli`: Added `syncConfigToolCuration` atomic configuration sync for both `chainmcp.config.yaml` and `gateway.config.yaml` multi-contract files, and auto-restores active revisions on Studio launch.

### Patch Changes

- Updated dependencies [984d136]
- Updated dependencies [c8a1025]
  - @chainmcp/storage@0.7.0
  - @chainmcp/config@0.7.0
  - @chainmcp/declarative@0.7.0
  - @chainmcp/analytics@0.7.0
  - @chainmcp/auth@0.7.0
  - @chainmcp/core@0.7.0
  - @chainmcp/executor@0.7.0
  - @chainmcp/gateway@0.7.0

## 0.6.0

### Patch Changes

- Updated dependencies
  - @chainmcp/gateway@0.6.0
  - @chainmcp/auth@0.6.0
  - @chainmcp/core@0.6.0
  - @chainmcp/declarative@0.6.0
  - @chainmcp/executor@0.6.0
  - @chainmcp/storage@0.6.0

## 0.5.0

### Minor Changes

- Wire `@chainmcp/storage` persistence into runtime and administration packages:

  - `@chainmcp/json-navigation`: `ResultHandleRegistry` accepts optional `storageDriver` or `blobStore` (`BlobPayloadStore`). Added async persistence methods `storeAsync`, `storeIfLargeAsync`, and `resolveAsync`. Tools (`json_create_handle`, `json_inspect_shape`, `json_select_path`, `json_paginate`, `json_filter`) asynchronously resolve handles from storage and persist server-side handles across restarts. Zero breaking changes to synchronous in-memory usage.
  - `@chainmcp/admin`: Implemented `StorageDescriptorRevisionStore` extending `InMemoryDescriptorRevisionStore`. Uses `KeyValueStore` (`namespace: "chainmcp_revisions"`) to persist revision history partitioned per contract (`contract:${tenantId}:${contractName}`) with atomic index tracking (`contracts_index`).
  - `@chainmcp/config`: Added `StorageConfigSchema` (`driver: "memory" | "sqlite"`, `path?: string`, `busyTimeoutMs?: number`) and `createStorageDriverFromConfig()`. Added `storage` block to `ChainMcpConfigSchema` and `GatewayConfigSchema`. Updated `createHandleRegistryOptionsFromConfig` to forward `storageDriver`.
  - `@chainmcp/cli`: Wired `createStorageDriverFromConfig` and storage driver initialization in `serve`, `dev`, and generated server templates (`templates.ts`). Added `@chainmcp/storage` to `CHAINMCP_PACKAGE_DEPENDENCIES` for `--local-deps` generated projects.

### Patch Changes

- @chainmcp/auth@0.5.0
  - @chainmcp/core@0.5.0
  - @chainmcp/declarative@0.5.0
  - @chainmcp/executor@0.5.0
  - @chainmcp/gateway@0.5.0
  - @chainmcp/storage@0.5.0

## 0.4.1

### Patch Changes

- Updated dependencies
  - @chainmcp/gateway@0.4.1
  - @chainmcp/core@0.4.1
  - @chainmcp/auth@0.4.1
  - @chainmcp/declarative@0.4.1
  - @chainmcp/executor@0.4.1

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

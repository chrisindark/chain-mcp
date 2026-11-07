# @chainmcp/gateway

## 0.4.0

### Patch Changes

- @chainmcp/auth@0.4.0
  - @chainmcp/compiler@0.4.0
  - @chainmcp/core@0.4.0
  - @chainmcp/executor@0.4.0
  - @chainmcp/server@0.4.0

## 0.3.1

### Patch Changes

- Updated dependencies
  - @chainmcp/core@0.3.1
  - @chainmcp/auth@0.3.1
  - @chainmcp/compiler@0.3.1
  - @chainmcp/executor@0.3.1
  - @chainmcp/server@0.3.1

## 0.3.0

### Minor Changes

- 723c5dd: Make the dynamic gateway deployable with chainmcp gateway serve, gateway configuration schema, tools/list_changed notifications on publish/activate/disable/rollback, runnable deployment example, and multi-contract SDK end-to-end integration tests.
- 180f2f0: Documentation truth pass (P0-8).

  - README now says the project is pre-1.0 and that the 1.0 release is deliberately withheld; registry `npx @chainmcp/cli` and bare `chainmcp` examples are marked as requiring publishing or an installed CLI (clone path is `node packages/cli/dist/bin.js`); intended technology no longer lists Hono or PostgreSQL (no database metadata store ships); token accounting, JSON navigation, response-schema enforcement, and auth-policy language match the shipped behavior.
  - `docs/getting-started.md`: response schemas are enforced by the executor when `server.validateResponses` is `warn`/`enforce`; authentication policies are not enforced by the compiler. Code-first init examples now include `--local-deps`.
  - `docs/deployment.md`: generated-server install and Dockerfile steps now use pnpm in local-deps mode.
  - `docs/product-guide.md`: softened `reduce payloads by up to 90%`, `sub-millisecond`, and `military-grade` marketing claims; corrected metric names to the four emitted by `OpenTelemetryMetricsSink` (`chainmcp.tool.invocations`, `chainmcp.tool.duration`, `chainmcp.tool.tokens`, `chainmcp.tool.payload_bytes`); clarified JSON navigation requires the full document supplied inline.
  - Added a CI drift guard: `pnpm docs:check` validates that every documented capability in `docs/capability-evidence.json` points to a real test file or exported API, and that the README `## Core capabilities` bullets are all covered. Wired into `pnpm check` and CI.

- e543870: Implement Milestone 9: Dynamic gateway.

  - Versioned contract registry (`ContractRegistry`) managing immutable candidate, active, superseded, rolled-back, and disabled contract revisions.
  - `DynamicGateway` implementing `ToolRuntime` with `tenantMode: "multi-tenant"`.
  - Atomic runtime snapshot updates with mutex serialization, guaranteeing in-flight request continuity and zero downtime during reloads.
  - Per-contract network destination policies and upstream credential provider bindings.
  - Tool name collision rejection within revisions and across active contracts for the same tenant.
  - Rollback and revision disabling with structured, redacted audit event emissions.
  - Tenant discovery and invocation isolation, cache isolation, and end-to-end MCP protocol integration.

### Patch Changes

- 147ef5e: Implement Milestone 10: Stable 1.0 release gates and production readiness.

  - Public API review and interface stabilization across all workspace packages.
  - Supported version matrix published in `docs/supported-versions.md` covering Node.js (>=20.11, 20 & 22 LTS), operating systems, OpenAPI (3.0.x & 3.1.x), MCP TypeScript SDK v2, Redis (7+), and configuration version 1.
  - Security and dependency audit (`pnpm audit`) verified zero high or critical vulnerabilities; updated threat model and disposition in `docs/risk-register.md`.
  - Comprehensive load, resilience, and fault-injection test suites in `@chainmcp/core` and `@chainmcp/executor` verifying graceful degradation under cache/limiter outages, network drops, socket aborts, 5xx server errors, DNS failures, redirect loops, and in-flight cooperative cancellations (`AbortSignal`).
  - Migration and rollback procedures for standalone generated servers and the dynamic gateway in `docs/migration-and-rollback.md` and runtime troubleshooting in `docs/troubleshooting.md`.
  - CycloneDX 1.5 JSON Software Bill of Materials (SBOM) generator script (`scripts/generate-sbom.mjs`) and `pnpm sbom` command.
  - Automated release workflow in `.github/workflows/release.yml` with signed npm provenance (`--provenance`) and Changesets publishing.
  - Recorded ADR 0027: Stable 1.0 Release and Production Readiness.

- 5ea3ece: Add package metadata, READMEs, licenses, engines, homepage, and repository links across all workspace packages for npm distribution.
- Updated dependencies [180f2f0]
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
- Updated dependencies [5477ae5]
- Updated dependencies [998b681]
- Updated dependencies [8df778b]
- Updated dependencies [5ea3ece]
- Updated dependencies [b64fd14]
- Updated dependencies [0097d0b]
- Updated dependencies [b64fd14]
- Updated dependencies [8c8483c]
  - @chainmcp/compiler@0.3.0
  - @chainmcp/executor@0.3.0
  - @chainmcp/server@0.3.0
  - @chainmcp/core@0.3.0
  - @chainmcp/auth@0.3.0

## 0.2.0

### Minor Changes

- 723c5dd: Make the dynamic gateway deployable with chainmcp gateway serve, gateway configuration schema, tools/list_changed notifications on publish/activate/disable/rollback, runnable deployment example, and multi-contract SDK end-to-end integration tests.
- 180f2f0: Documentation truth pass (P0-8).

  - README now says the project is pre-1.0 and that the 1.0 release is deliberately withheld; registry `npx @chainmcp/cli` and bare `chainmcp` examples are marked as requiring publishing or an installed CLI (clone path is `node packages/cli/dist/bin.js`); intended technology no longer lists Hono or PostgreSQL (no database metadata store ships); token accounting, JSON navigation, response-schema enforcement, and auth-policy language match the shipped behavior.
  - `docs/getting-started.md`: response schemas are enforced by the executor when `server.validateResponses` is `warn`/`enforce`; authentication policies are not enforced by the compiler. Code-first init examples now include `--local-deps`.
  - `docs/deployment.md`: generated-server install and Dockerfile steps now use pnpm in local-deps mode.
  - `docs/product-guide.md`: softened `reduce payloads by up to 90%`, `sub-millisecond`, and `military-grade` marketing claims; corrected metric names to the four emitted by `OpenTelemetryMetricsSink` (`chainmcp.tool.invocations`, `chainmcp.tool.duration`, `chainmcp.tool.tokens`, `chainmcp.tool.payload_bytes`); clarified JSON navigation requires the full document supplied inline.
  - Added a CI drift guard: `pnpm docs:check` validates that every documented capability in `docs/capability-evidence.json` points to a real test file or exported API, and that the README `## Core capabilities` bullets are all covered. Wired into `pnpm check` and CI.

- e543870: Implement Milestone 9: Dynamic gateway.

  - Versioned contract registry (`ContractRegistry`) managing immutable candidate, active, superseded, rolled-back, and disabled contract revisions.
  - `DynamicGateway` implementing `ToolRuntime` with `tenantMode: "multi-tenant"`.
  - Atomic runtime snapshot updates with mutex serialization, guaranteeing in-flight request continuity and zero downtime during reloads.
  - Per-contract network destination policies and upstream credential provider bindings.
  - Tool name collision rejection within revisions and across active contracts for the same tenant.
  - Rollback and revision disabling with structured, redacted audit event emissions.
  - Tenant discovery and invocation isolation, cache isolation, and end-to-end MCP protocol integration.

### Patch Changes

- 147ef5e: Implement Milestone 10: Stable 1.0 release gates and production readiness.

  - Public API review and interface stabilization across all workspace packages.
  - Supported version matrix published in `docs/supported-versions.md` covering Node.js (>=20.11, 20 & 22 LTS), operating systems, OpenAPI (3.0.x & 3.1.x), MCP TypeScript SDK v2, Redis (7+), and configuration version 1.
  - Security and dependency audit (`pnpm audit`) verified zero high or critical vulnerabilities; updated threat model and disposition in `docs/risk-register.md`.
  - Comprehensive load, resilience, and fault-injection test suites in `@chainmcp/core` and `@chainmcp/executor` verifying graceful degradation under cache/limiter outages, network drops, socket aborts, 5xx server errors, DNS failures, redirect loops, and in-flight cooperative cancellations (`AbortSignal`).
  - Migration and rollback procedures for standalone generated servers and the dynamic gateway in `docs/migration-and-rollback.md` and runtime troubleshooting in `docs/troubleshooting.md`.
  - CycloneDX 1.5 JSON Software Bill of Materials (SBOM) generator script (`scripts/generate-sbom.mjs`) and `pnpm sbom` command.
  - Automated release workflow in `.github/workflows/release.yml` with signed npm provenance (`--provenance`) and Changesets publishing.
  - Recorded ADR 0027: Stable 1.0 Release and Production Readiness.

- Updated dependencies [180f2f0]
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
- Updated dependencies [5477ae5]
- Updated dependencies [998b681]
- Updated dependencies [8df778b]
- Updated dependencies [0097d0b]
- Updated dependencies
- Updated dependencies [8c8483c]
  - @chainmcp/compiler@0.2.0
  - @chainmcp/executor@0.2.0
  - @chainmcp/server@0.2.0
  - @chainmcp/core@0.2.0
  - @chainmcp/auth@0.2.0

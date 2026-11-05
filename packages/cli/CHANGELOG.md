# @chainmcp/cli

## 0.3.0

### Minor Changes

- 3a7cbc4: Add diff command, remote URL OpenAPI contract support, TS source loading diagnostics in dev, and bin alias for npx execution.
- 180f2f0: Resolve credentials from the environment instead of literal config values.

  - `@chainmcp/config` exports `resolveConfigSecrets()` and `redactConfigSecrets()`. Designated secret fields accept `${VAR}` and `${VAR:-default}`; missing variables fail with `SECRET_UNRESOLVED` naming the field and variable, and non-secret fields are never interpolated.
  - `chainmcp config explain` prints the resolved configuration with credentials redacted, plus value-free provenance for each secret (`--json` supported).
  - CLI `validate`, `serve`, `dev`, `gateway serve`, and generated server templates resolve secret references before schema validation.
  - `chainmcp build` mirrors `chainmcp.manifest.json` and `compiled-tools.json` to the project root so generated servers can verify artifacts at startup.
  - Documentation no longer lists the unimplemented `CHAINMCP_DATABASE_URL`, `CHAINMCP_UPSTREAM_TIMEOUT_MS`, and `CHAINMCP_SECRET_PROVIDER` variables.

- 723c5dd: Make the dynamic gateway deployable with chainmcp gateway serve, gateway configuration schema, tools/list_changed notifications on publish/activate/disable/rollback, runnable deployment example, and multi-contract SDK end-to-end integration tests.
- 180f2f0: Documentation truth pass (P0-8).

  - README now says the project is pre-1.0 and that the 1.0 release is deliberately withheld; registry `npx @chainmcp/cli` and bare `chainmcp` examples are marked as requiring publishing or an installed CLI (clone path is `node packages/cli/dist/bin.js`); intended technology no longer lists Hono or PostgreSQL (no database metadata store ships); token accounting, JSON navigation, response-schema enforcement, and auth-policy language match the shipped behavior.
  - `docs/getting-started.md`: response schemas are enforced by the executor when `server.validateResponses` is `warn`/`enforce`; authentication policies are not enforced by the compiler. Code-first init examples now include `--local-deps`.
  - `docs/deployment.md`: generated-server install and Dockerfile steps now use pnpm in local-deps mode.
  - `docs/product-guide.md`: softened `reduce payloads by up to 90%`, `sub-millisecond`, and `military-grade` marketing claims; corrected metric names to the four emitted by `OpenTelemetryMetricsSink` (`chainmcp.tool.invocations`, `chainmcp.tool.duration`, `chainmcp.tool.tokens`, `chainmcp.tool.payload_bytes`); clarified JSON navigation requires the full document supplied inline.
  - Added a CI drift guard: `pnpm docs:check` validates that every documented capability in `docs/capability-evidence.json` points to a real test file or exported API, and that the README `## Core capabilities` bullets are all covered. Wired into `pnpm check` and CI.

- b64fd14: Allow exact token measurement from configuration.

  - `@chainmcp/config`: `tokenMetrics.tokenizer` accepts `exact`. Exact measurement requires `tokenMetrics.module` or a factory registered with `registerTokenizerFactory(modelId, factory)`. `loadTokenizerFromConfig()` resolves modules relative to the configuration directory, validates that the adapter id matches `modelId` and that it declares `measurement: "exact"`, and fails startup rather than relabeling an estimate. `TokenizerConfigError` exposes stable `TOKENIZER_SOURCE_REQUIRED`, `TOKENIZER_FACTORY_FAILED`, `TOKENIZER_MODULE_INVALID`, and `TOKENIZER_INVALID` codes. `buildRuntimeOptions()` stays synchronous and requires an injected tokenizer for exact configurations.
  - `@chainmcp/cli`: `serve`, `dev`, `gateway serve`, and generated server templates load the configured tokenizer once at startup and pass the same instance to the runtime, so `output.maxTokens` enforcement and `tokenUsage` use one counter.
  - Additive: existing `approximate` and `none` configurations behave as before.

- d202546: Generate installable projects from a local clone and stop hardcoding the CLI version.

  - `chainmcp init` and `chainmcp export` accept `--local-deps <repo-root>`, which
    emits relative `file:` specifiers plus a `pnpm-workspace.yaml` override block
    so the unpublished `@chainmcp/*` packages resolve from a cloned checkout.
  - `--workspace-deps` is now available on the CLI for projects generated inside
    the monorepo. The two flags are mutually exclusive.
  - `getCliVersion()` reads the CLI `package.json` at runtime. Dependency ranges,
    the generated server's advertised version, and `manifest.generatorVersion` are
    no longer pinned to `0.1.0`.
  - Breaking for embedders: `CLI_VERSION` is replaced by `getCliVersion()`, and
    `buildProjectManifest` / `buildCodeFirstManifest` now require a
    `generatorVersion` option.

- 5477ae5: Implement Milestone 7: Developer CLI and Portable Generated Servers.

  - Add `@chainmcp/cli` package providing developer CLI commands (`init`, `validate`, `build`, `serve`, `export`) using Node.js built-in `util.parseArgs` and strictly asynchronous I/O conforming to `chainmcp/no-blocking-io`.
  - Implement `chainmcp export` to generate portable, self-contained MCP server projects with pinned contract snapshots, project configurations, TypeScript configs, multi-stage `Dockerfile` templates, `.dockerignore`, `.gitignore`, `README.md`, and deterministic manifests.
  - Implement `chainmcp.manifest.json` generation and reproducibility verification (`verifyProjectManifest`).
  - Export `Transport` type from `@chainmcp/server`.
  - Add deployment documentation in `docs/deployment.md` covering stdio client integration, Docker containerization, process lifecycle, and SSRF security controls.
  - Add end-to-end integration tests verifying clean compilation with `tsc`, independent execution, and MCP SDK protocol conformance.

- 998b681: Implement Milestone 8: Tool Sources and Code-First Authoring.

  - Add `@chainmcp/core` `ToolSource` boundary interface and `InMemoryToolRuntime.registerSource()`.
  - Add `OpenApiToolSource` in `@chainmcp/executor` wrapping compiled operations and `UpstreamExecutor`.
  - Add `@chainmcp/authoring` package with `defineTool()` authoring facade, `ManualToolSource`, and `zodToJsonSchema()` lowering with definition-time schema audits against the supported JSON Schema subset.
  - Add policy parity tests (`packages/authoring/tests/parity.test.ts`) asserting 100% equivalence between manual and compiled tools across input validation, authorization scopes, rate limiting, cooperative cancellation/timeout, output projection, result caching, and safe error masking.
  - Add `chainmcp init --blank` in `@chainmcp/cli` to scaffold contract-free, code-first MCP server projects with example tools and build templates.
  - Add `chainmcp dev` in `@chainmcp/cli` for a local developer authoring loop over stdio.
  - Add runnable code-first example in `examples/code-first` with automated integration tests over the official MCP SDK client.
  - Update documentation in `docs/getting-started.md`, `API_REFERENCE.md`, `CONFIGURATION.md`, and `ARCHITECTURE.md`, accept ADR 0019, and record ADR 0025.

- b64fd14: Add a `GET /readyz` readiness probe that reflects dependency reachability and follows the configured failure policy.

  - `@chainmcp/server`: `serveHttp` accepts `readiness: { deps: [{ name, check, degradedReady? }] }`. `GET /readyz` runs each check (errors swallowed, never mirrored) and returns `200 {"status":"ready"}` when all pass, `200 {"status":"degraded"}` when only `degradedReady` deps fail, and `503 {"status":"not_ready"}` when a non-degraded dep fails. `GET /health` and `GET /livez` remain liveness-only and never touch dependencies. With no deps configured, `/readyz` returns ready with no dependency detail.
  - `@chainmcp/config`: new `buildReadinessDeps(config, { rateLimiter, cacheStore })` emits one dep per Redis-backed dependency, using the same client instances as the runtime. The rate limiter probes `eval("return 1")`; the cache store probes a read of an absent key (proves liveness without writing). Both are bounded by a 500 ms probe timeout. A `fail-open` limiter is reported `degradedReady`, mirroring the call path, so an unreachable Redis keeps `/readyz` at 200 `degraded`; a `fail-closed` limiter or cache outage returns 503. Exported `ReadinessDep` type for embedded use.
  - `@chainmcp/cli`: `serve` (HTTP), `gateway serve` (HTTP), and generated server templates pass `buildReadinessDeps` output to `serveHttp`.
  - Additive: existing deployments without the wiring behave as before; `/health` and `/livez` responses are unchanged.

- b64fd14: Connect JSON navigation to a tenant- and principal-scoped result-handle registry (P1-2).

  - `@chainmcp/json-navigation`: new `ResultHandleRegistry` (`src/handles.ts`) — opaque `rhv1.<counter>.<tag>` handles where the tag is an HMAC of `tenantId|principalId|counter` under a per-registry secret, so tenant/principal ids are never embedded and a tampered handle fails verification. Bounded per-principal LRU, per-tenant cap, absolute cap, per-document byte cap, and total-bytes cap, with a TTL. Stable `RESULT_HANDLE_EXPIRED` for unknown, expired, evicted, tampered, cross-tenant, and cross-principal handles (no existence leak across scopes); `ResultHandleTooLargeError` for documents above the byte cap instead of silent truncation. `createJsonNavigationTools(limits?, handleRegistry?)` now registers five tools: the four existing navigation tools accept either `json` or `handle`, and a new `json_create_handle` tool stores a document once and returns `{ handle, bytes }`.
  - `@chainmcp/config`: new `jsonNavigation.handles` schema (`enabled`, `maxPerPrincipal`, `maxPerTenant`, `maxTotal`, `maxBytes`, `maxTotalBytes`, `ttlMs`, `minBytes`) and `createHandleRegistryOptionsFromConfig()` wiring helper.
  - `@chainmcp/cli`: `serve` (both code-first and compiled paths), `dev`, and generated server templates pass registry options from config into `createJsonNavigationTools`; tool counts updated from 4 to 5 navigation tools.
  - Additive: inline-`json` callers are unaffected; the result-handle docs previously claimed no handles existed (README, product guide), and those statements are corrected.

- 0097d0b: Add Streamable HTTP and SSE transports to `@chainmcp/server`, with inbound authentication verifiers (Bearer tokens, API keys, JWT), CLI `--transport http` support, Docker EXPOSE, and MCP Inspector conformance verification.
- b64fd14: Paginate `tools/list` with revision-bound cursors.

  - `@chainmcp/server`: `McpServerOptions.toolsPageSize` (default `100`; `0` disables pagination) applies to both the single-tenant snapshot path and the multi-tenant per-request path. Pages are ordered deterministically by tool name, and `nextCursor` is opaque and bound to the listing revision. Stale, malformed, and cross-tenant cursors fail with the stable `STALE_CURSOR` error.
  - `@chainmcp/config`: `server.toolsPageSize` defaults to `100` and accepts `0`.
  - `@chainmcp/cli`: `serve`, `dev`, `gateway serve`, and generated server templates pass `server.toolsPageSize` through to the adapter.
  - Additive: clients that request `tools/list` without a cursor still receive the complete listing because the MCP client aggregates pages.

- 8c8483c: Wire caching, token metrics, and declarative output projection configuration schemas and runtime factories with support for in-memory and Redis backends, opt-in read caching for compiled GET operations, tokenizer registration, and maxResponseBytes enforcement.

### Patch Changes

- b64fd14: Add a CI coverage gate with per-package floors.

  - Per-package coverage thresholds (floors set just below the coverage measured on 2026-11-05, ratcheting upward with each improvement) live in `scripts/coverage-thresholds.mjs`, the single source of truth shared by the Vitest root run (`vite.config.ts`) and the new gate script.
  - New `node scripts/check-coverage.mjs --summary` (also `pnpm coverage:check`) compares the fresh `coverage/coverage-summary.json` against the global and per-package floors, writes `coverage/coverage-gate.json`, and emits a Markdown summary.
  - CI runs the gate in a dedicated `coverage` job, uploads the `coverage/` directory as the `coverage-report` artifact, and posts (or updates) the summary as a pull-request comment.
  - Negative behavior: a package below its floor, a package with no covered files, or a missing/unparseable coverage report fails the gate instead of passing silently. Covered by positive, negative, and missing-report tests in `scripts/check-coverage.test.mjs`.
  - Additive/internal: `pnpm check` is unchanged; the gate has its own CI job because package-level `pnpm -r test` runs without coverage.

- b64fd14: Local-clone quick start (P1-6): the README and getting-started docs now document the exact clone → build → init → serve → MCP client sequence, including the Claude Desktop config, and that sequence is executed end to end by `packages/cli/tests/quick-start.test.ts` in a temp directory (`initCommand` + offline `pnpm install` + `pnpm build` + in-process `tools/list`/`tools/call` + `dist/server.js` stdio round trip, launched through a symlinked project path). Registry `npx @chainmcp/cli` and bare `chainmcp` steps stay gated behind "after publishing"; a bare `chainmcp validate`/`build` pair in the product guide was replaced with the clone-path commands. `docs/capability-evidence.json` gained a `local-clone-quick-start` entry pointing at `initCommand` and the quick-start test.

  Fixes a silent-startup bug found by that test: the generated server's main-module guard compared `process.argv[1]` with `fileURLToPath(import.meta.url)`, which differ whenever the entry path contains a symlink (macOS `/var` → `/private/var` temp directories, symlinked checkouts). The process started, printed nothing, and exited. The guard now compares real paths (`realpathSync`) and is covered by a template source test plus the symlinked stdio round trip. `examples/code-first/src/server.ts` had the same fragile guard and is fixed the same way.

- 147ef5e: Implement Milestone 10: Stable 1.0 release gates and production readiness.

  - Public API review and interface stabilization across all workspace packages.
  - Supported version matrix published in `docs/supported-versions.md` covering Node.js (>=20.11, 20 & 22 LTS), operating systems, OpenAPI (3.0.x & 3.1.x), MCP TypeScript SDK v2, Redis (7+), and configuration version 1.
  - Security and dependency audit (`pnpm audit`) verified zero high or critical vulnerabilities; updated threat model and disposition in `docs/risk-register.md`.
  - Comprehensive load, resilience, and fault-injection test suites in `@chainmcp/core` and `@chainmcp/executor` verifying graceful degradation under cache/limiter outages, network drops, socket aborts, 5xx server errors, DNS failures, redirect loops, and in-flight cooperative cancellations (`AbortSignal`).
  - Migration and rollback procedures for standalone generated servers and the dynamic gateway in `docs/migration-and-rollback.md` and runtime troubleshooting in `docs/troubleshooting.md`.
  - CycloneDX 1.5 JSON Software Bill of Materials (SBOM) generator script (`scripts/generate-sbom.mjs`) and `pnpm sbom` command.
  - Automated release workflow in `.github/workflows/release.yml` with signed npm provenance (`--provenance`) and Changesets publishing.
  - Recorded ADR 0027: Stable 1.0 Release and Production Readiness.

- 113836f: Make CI report the truth (P2-0). The `checks` and `inspector` matrices drop
  Node.js 20, which `pnpm@11.0.0` cannot run (`ERR_UNKNOWN_BUILTIN_MODULE: No
such built-in module: node:sqlite`), and set `fail-fast: false` so one
  failing leg can no longer cancel a passing one. The root `engines.node`
  floor is now `>=22.13`, and the supported-version, getting-started, release,
  development, and limitations docs agree.

  The coverage job no longer fails when `coverage/coverage-summary.md` is
  absent (a missing summary now warns instead of throwing `ENOENT`).

  Generated-project tests no longer require a warm pnpm store:
  `installGeneratedProject()` tries `--offline`, retries with
  `--prefer-offline` only for `ERR_PNPM_NO_OFFLINE_META` /
  `ERR_PNPM_NO_OFFLINE_TARBALL`, and still surfaces every other failure.
  `assertChainMcpPackagesFromClone()` proves the property the product actually
  guarantees — every `@chainmcp/*` dependency is a `file:` specifier installed
  at the clone's version — instead of asserting the installed path is inside
  the clone, which pnpm's virtual store makes impossible. Both helpers are
  pinned by `packages/cli/tests/generated-install.test.ts`. README and
  getting-started no longer claim that no registry access is needed at any
  step: third-party dependencies still come from npm on a first install.

- 5ea3ece: Add package metadata, READMEs, licenses, engines, homepage, and repository links across all workspace packages for npm distribution.
- Updated dependencies [26e83fe]
- Updated dependencies [180f2f0]
- Updated dependencies [26e83fe]
- Updated dependencies [26e83fe]
- Updated dependencies [723c5dd]
- Updated dependencies [26e83fe]
- Updated dependencies [180f2f0]
- Updated dependencies [b64fd14]
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
- Updated dependencies [e543870]
- Updated dependencies [8df778b]
- Updated dependencies [5ea3ece]
- Updated dependencies [b64fd14]
- Updated dependencies [b64fd14]
- Updated dependencies [0097d0b]
- Updated dependencies [b64fd14]
- Updated dependencies [8c8483c]
  - @chainmcp/admin@0.3.0
  - @chainmcp/config@0.3.0
  - @chainmcp/compiler@0.3.0
  - @chainmcp/executor@0.3.0
  - @chainmcp/gateway@0.3.0
  - @chainmcp/server@0.3.0
  - @chainmcp/core@0.3.0
  - @chainmcp/analytics@0.3.0
  - @chainmcp/auth@0.3.0
  - @chainmcp/rate-limit@0.3.0
  - @chainmcp/json-navigation@0.3.0

## 0.2.0

### Minor Changes

- 3a7cbc4: Add diff command, remote URL OpenAPI contract support, TS source loading diagnostics in dev, and bin alias for npx execution.
- 180f2f0: Resolve credentials from the environment instead of literal config values.

  - `@chainmcp/config` exports `resolveConfigSecrets()` and `redactConfigSecrets()`. Designated secret fields accept `${VAR}` and `${VAR:-default}`; missing variables fail with `SECRET_UNRESOLVED` naming the field and variable, and non-secret fields are never interpolated.
  - `chainmcp config explain` prints the resolved configuration with credentials redacted, plus value-free provenance for each secret (`--json` supported).
  - CLI `validate`, `serve`, `dev`, `gateway serve`, and generated server templates resolve secret references before schema validation.
  - `chainmcp build` mirrors `chainmcp.manifest.json` and `compiled-tools.json` to the project root so generated servers can verify artifacts at startup.
  - Documentation no longer lists the unimplemented `CHAINMCP_DATABASE_URL`, `CHAINMCP_UPSTREAM_TIMEOUT_MS`, and `CHAINMCP_SECRET_PROVIDER` variables.

- 723c5dd: Make the dynamic gateway deployable with chainmcp gateway serve, gateway configuration schema, tools/list_changed notifications on publish/activate/disable/rollback, runnable deployment example, and multi-contract SDK end-to-end integration tests.
- 180f2f0: Documentation truth pass (P0-8).

  - README now says the project is pre-1.0 and that the 1.0 release is deliberately withheld; registry `npx @chainmcp/cli` and bare `chainmcp` examples are marked as requiring publishing or an installed CLI (clone path is `node packages/cli/dist/bin.js`); intended technology no longer lists Hono or PostgreSQL (no database metadata store ships); token accounting, JSON navigation, response-schema enforcement, and auth-policy language match the shipped behavior.
  - `docs/getting-started.md`: response schemas are enforced by the executor when `server.validateResponses` is `warn`/`enforce`; authentication policies are not enforced by the compiler. Code-first init examples now include `--local-deps`.
  - `docs/deployment.md`: generated-server install and Dockerfile steps now use pnpm in local-deps mode.
  - `docs/product-guide.md`: softened `reduce payloads by up to 90%`, `sub-millisecond`, and `military-grade` marketing claims; corrected metric names to the four emitted by `OpenTelemetryMetricsSink` (`chainmcp.tool.invocations`, `chainmcp.tool.duration`, `chainmcp.tool.tokens`, `chainmcp.tool.payload_bytes`); clarified JSON navigation requires the full document supplied inline.
  - Added a CI drift guard: `pnpm docs:check` validates that every documented capability in `docs/capability-evidence.json` points to a real test file or exported API, and that the README `## Core capabilities` bullets are all covered. Wired into `pnpm check` and CI.

- Drain in-flight HTTP requests instead of killing them on shutdown.

  - `serveHttp` answers requests that arrive during shutdown with `503` and
    `Connection: close`, drains work-bearing `POST`/`DELETE` requests for up to
    `server.shutdownTimeoutMs` (default 10,000 ms), then aborts cooperative tool
    executions and force-closes remaining sockets. SIGINT/SIGTERM are idempotent
    with exit codes 130 and 143.
  - `ToolRuntime.close?()` / `InMemoryToolRuntime.close()` flush
    `MetricsSink.flush?()` and run `RuntimeOptions.onShutdown()` exactly once.
    `buildRuntimeOptions` drains the shared Redis client it created through that
    hook; caller-supplied clients are not closed.

- d202546: Generate installable projects from a local clone and stop hardcoding the CLI version.

  - `chainmcp init` and `chainmcp export` accept `--local-deps <repo-root>`, which
    emits relative `file:` specifiers plus a `pnpm-workspace.yaml` override block
    so the unpublished `@chainmcp/*` packages resolve from a cloned checkout.
  - `--workspace-deps` is now available on the CLI for projects generated inside
    the monorepo. The two flags are mutually exclusive.
  - `getCliVersion()` reads the CLI `package.json` at runtime. Dependency ranges,
    the generated server's advertised version, and `manifest.generatorVersion` are
    no longer pinned to `0.1.0`.
  - Breaking for embedders: `CLI_VERSION` is replaced by `getCliVersion()`, and
    `buildProjectManifest` / `buildCodeFirstManifest` now require a
    `generatorVersion` option.

- 5477ae5: Implement Milestone 7: Developer CLI and Portable Generated Servers.

  - Add `@chainmcp/cli` package providing developer CLI commands (`init`, `validate`, `build`, `serve`, `export`) using Node.js built-in `util.parseArgs` and strictly asynchronous I/O conforming to `chainmcp/no-blocking-io`.
  - Implement `chainmcp export` to generate portable, self-contained MCP server projects with pinned contract snapshots, project configurations, TypeScript configs, multi-stage `Dockerfile` templates, `.dockerignore`, `.gitignore`, `README.md`, and deterministic manifests.
  - Implement `chainmcp.manifest.json` generation and reproducibility verification (`verifyProjectManifest`).
  - Export `Transport` type from `@chainmcp/server`.
  - Add deployment documentation in `docs/deployment.md` covering stdio client integration, Docker containerization, process lifecycle, and SSRF security controls.
  - Add end-to-end integration tests verifying clean compilation with `tsc`, independent execution, and MCP SDK protocol conformance.

- 998b681: Implement Milestone 8: Tool Sources and Code-First Authoring.

  - Add `@chainmcp/core` `ToolSource` boundary interface and `InMemoryToolRuntime.registerSource()`.
  - Add `OpenApiToolSource` in `@chainmcp/executor` wrapping compiled operations and `UpstreamExecutor`.
  - Add `@chainmcp/authoring` package with `defineTool()` authoring facade, `ManualToolSource`, and `zodToJsonSchema()` lowering with definition-time schema audits against the supported JSON Schema subset.
  - Add policy parity tests (`packages/authoring/tests/parity.test.ts`) asserting 100% equivalence between manual and compiled tools across input validation, authorization scopes, rate limiting, cooperative cancellation/timeout, output projection, result caching, and safe error masking.
  - Add `chainmcp init --blank` in `@chainmcp/cli` to scaffold contract-free, code-first MCP server projects with example tools and build templates.
  - Add `chainmcp dev` in `@chainmcp/cli` for a local developer authoring loop over stdio.
  - Add runnable code-first example in `examples/code-first` with automated integration tests over the official MCP SDK client.
  - Update documentation in `docs/getting-started.md`, `API_REFERENCE.md`, `CONFIGURATION.md`, and `ARCHITECTURE.md`, accept ADR 0019, and record ADR 0025.

- 0097d0b: Add Streamable HTTP and SSE transports to `@chainmcp/server`, with inbound authentication verifiers (Bearer tokens, API keys, JWT), CLI `--transport http` support, Docker EXPOSE, and MCP Inspector conformance verification.
- Verify build artifacts before serving and stop recompiling the contract at startup.

  - Generated servers load `dist/compiled-tools.json` and verify the manifest
    schema version, generator/compiler versions, contract source hash and revision,
    tool count, artifact digest, and per-tool hashes before registering tools.
  - Drift fails startup with a remediation message;
    `--allow-manifest-drift` / `CHAINMCP_ALLOW_MANIFEST_DRIFT=1` downgrades it to a
    warning. Recompiling `spec/openapi.yaml` is now a `NODE_ENV=development`
    fallback, so production startup never imports `@chainmcp/compiler`.
  - `chainmcp build` and `chainmcp export` emit the manifest and compiled tools at
    the project root and in `dist/`, and the generated Dockerfile copies them into
    the image.

- 8c8483c: Wire caching, token metrics, and declarative output projection configuration schemas and runtime factories with support for in-memory and Redis backends, opt-in read caching for compiled GET operations, tokenizer registration, and maxResponseBytes enforcement.

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
- Updated dependencies [e543870]
- Updated dependencies [8df778b]
- Updated dependencies [0097d0b]
- Updated dependencies
- Updated dependencies [8c8483c]
  - @chainmcp/config@0.2.0
  - @chainmcp/compiler@0.2.0
  - @chainmcp/executor@0.2.0
  - @chainmcp/gateway@0.2.0
  - @chainmcp/server@0.2.0
  - @chainmcp/core@0.2.0
  - @chainmcp/analytics@0.2.0
  - @chainmcp/auth@0.2.0
  - @chainmcp/rate-limit@0.2.0
  - @chainmcp/json-navigation@0.2.0

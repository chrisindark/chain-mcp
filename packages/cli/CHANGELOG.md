# @chainmcp/cli

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

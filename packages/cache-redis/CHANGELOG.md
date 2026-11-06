# @chainmcp/cache-redis

## 0.3.1

### Patch Changes

- Updated dependencies
  - @chainmcp/core@0.3.1

## 0.3.0

### Minor Changes

- 180f2f0: Documentation truth pass (P0-8).

  - README now says the project is pre-1.0 and that the 1.0 release is deliberately withheld; registry `npx @chainmcp/cli` and bare `chainmcp` examples are marked as requiring publishing or an installed CLI (clone path is `node packages/cli/dist/bin.js`); intended technology no longer lists Hono or PostgreSQL (no database metadata store ships); token accounting, JSON navigation, response-schema enforcement, and auth-policy language match the shipped behavior.
  - `docs/getting-started.md`: response schemas are enforced by the executor when `server.validateResponses` is `warn`/`enforce`; authentication policies are not enforced by the compiler. Code-first init examples now include `--local-deps`.
  - `docs/deployment.md`: generated-server install and Dockerfile steps now use pnpm in local-deps mode.
  - `docs/product-guide.md`: softened `reduce payloads by up to 90%`, `sub-millisecond`, and `military-grade` marketing claims; corrected metric names to the four emitted by `OpenTelemetryMetricsSink` (`chainmcp.tool.invocations`, `chainmcp.tool.duration`, `chainmcp.tool.tokens`, `chainmcp.tool.payload_bytes`); clarified JSON navigation requires the full document supplied inline.
  - Added a CI drift guard: `pnpm docs:check` validates that every documented capability in `docs/capability-evidence.json` points to a real test file or exported API, and that the README `## Core capabilities` bullets are all covered. Wired into `pnpm check` and CI.

- c371655: Add a bounded in-memory LRU `CacheStore` adapter and move cache keys to v2
  with a required non-secret `authorizationPartition`. `createCacheKey` now
  rejects blank identity fields, and the store rejects callable `toJSON` values.
  Wire opt-in per-tool caching into invocation: reads run after authorization,
  validation, and rate limiting, and key, partition, read, and write failures
  bypass caching instead of failing the call. Report `cacheOutcome` on invocation
  events and add exact-match `invalidateCachedResult` for trusted operator code.
  Add an optional `Tokenizer` adapter that records exact or estimated token counts
  and the serialized payload size on successful invocation events. Add per-tool
  output projection and token budgets: `ToolDefinition.output` opts into a
  deployment-supplied `ResultProjector`, and `maxTokens` rejects over-budget or
  uncountable results before caching or returning them. Projected output must be
  JSON, cached entries contain only the projection, and projection/budget failures
  never fall back to the raw result. Add `createFieldProjector()` with bounded
  declarative `output.fields` include/exclude paths. Add `@chainmcp/cache-redis`,
  an optional shared cache adapter with validated keys/values, bounded TTL and
  entry size, and per-command timeouts. Runtime caching, measurement, projection,
  and budgets remain disabled unless the deployment configures them and a tool
  opts in.
- 8c8483c: Wire caching, token metrics, and declarative output projection configuration schemas and runtime factories with support for in-memory and Redis backends, opt-in read caching for compiled GET operations, tokenizer registration, and maxResponseBytes enforcement.

### Patch Changes

- 99483c5: Apply Apache License 2.0 across all workspace packages, completing Milestone 0 licensing. Upgrade @modelcontextprotocol/server and @modelcontextprotocol/client to 2.3.1 to resolve upstream security advisories.
- 147ef5e: Implement Milestone 10: Stable 1.0 release gates and production readiness.

  - Public API review and interface stabilization across all workspace packages.
  - Supported version matrix published in `docs/supported-versions.md` covering Node.js (>=20.11, 20 & 22 LTS), operating systems, OpenAPI (3.0.x & 3.1.x), MCP TypeScript SDK v2, Redis (7+), and configuration version 1.
  - Security and dependency audit (`pnpm audit`) verified zero high or critical vulnerabilities; updated threat model and disposition in `docs/risk-register.md`.
  - Comprehensive load, resilience, and fault-injection test suites in `@chainmcp/core` and `@chainmcp/executor` verifying graceful degradation under cache/limiter outages, network drops, socket aborts, 5xx server errors, DNS failures, redirect loops, and in-flight cooperative cancellations (`AbortSignal`).
  - Migration and rollback procedures for standalone generated servers and the dynamic gateway in `docs/migration-and-rollback.md` and runtime troubleshooting in `docs/troubleshooting.md`.
  - CycloneDX 1.5 JSON Software Bill of Materials (SBOM) generator script (`scripts/generate-sbom.mjs`) and `pnpm sbom` command.
  - Automated release workflow in `.github/workflows/release.yml` with signed npm provenance (`--provenance`) and Changesets publishing.
  - Recorded ADR 0027: Stable 1.0 Release and Production Readiness.

- 805c5a4: Add the first Milestone 3 OpenAPI compiler slices and a blocking-I/O lint rule.

  `@chainmcp/compiler` parses and validates one OpenAPI 3.0 or 3.1 YAML/JSON
  document, resolves local `$ref`s, enumerates operations deterministically,
  builds audited object-root input schemas from parameters and JSON request
  bodies, translates 3.0 nullability, flattens object `allOf` intersections when
  merging preserves the contract, maps declared responses with their media types
  and descriptive schemas, and derives explicit OR/AND authentication policies
  with copied credential metadata and required scopes. Anonymous alternatives are
  preserved, and OAuth2 scope mismatches are diagnosed. It emits deterministic
  source/contract/toolset hashes plus manifest diffs. Response schemas are
  metadata only and are not used to validate upstream payloads; authentication
  policies are not enforced. The compiler does not inject credentials.

  The repository now enforces `chainmcp/no-blocking-io` on runtime source paths,
  rejecting synchronous `fs` and `child_process` APIs, with RuleTester coverage.

- 5f3f111: Add `@chainmcp/executor`, the first upstream HTTP execution slice.

  `createUpstreamExecutor()` turns compiled operations into runnable tools with
  path/query/header/JSON-body mapping, an exact host allowlist, HTTPS by default,
  fixed protocol/port, same-host redirect revalidation, DNS-answer classification
  and address pinning, peer verification, response and request caps, and
  `context.signal`/total-timeout binding. It returns JSON for 2xx responses and
  maps destination, request, status, response, timeout, and cancellation failures
  to safe runtime errors. It does not inject credentials, enforce authentication
  policies, validate response schemas, retry, or honor proxy environment
  variables.

  The compiler now records sorted parameter bindings and request-body media
  metadata so the executor does not re-parse OpenAPI, and includes them in
  per-tool hashes.

- 5ea3ece: Add package metadata, READMEs, licenses, engines, homepage, and repository links across all workspace packages for npm distribution.
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
- Updated dependencies [8252a3a]
- Updated dependencies [998b681]
- Updated dependencies [8df778b]
- Updated dependencies [5ea3ece]
  - @chainmcp/core@0.3.0

## 0.2.0

### Minor Changes

- 180f2f0: Documentation truth pass (P0-8).

  - README now says the project is pre-1.0 and that the 1.0 release is deliberately withheld; registry `npx @chainmcp/cli` and bare `chainmcp` examples are marked as requiring publishing or an installed CLI (clone path is `node packages/cli/dist/bin.js`); intended technology no longer lists Hono or PostgreSQL (no database metadata store ships); token accounting, JSON navigation, response-schema enforcement, and auth-policy language match the shipped behavior.
  - `docs/getting-started.md`: response schemas are enforced by the executor when `server.validateResponses` is `warn`/`enforce`; authentication policies are not enforced by the compiler. Code-first init examples now include `--local-deps`.
  - `docs/deployment.md`: generated-server install and Dockerfile steps now use pnpm in local-deps mode.
  - `docs/product-guide.md`: softened `reduce payloads by up to 90%`, `sub-millisecond`, and `military-grade` marketing claims; corrected metric names to the four emitted by `OpenTelemetryMetricsSink` (`chainmcp.tool.invocations`, `chainmcp.tool.duration`, `chainmcp.tool.tokens`, `chainmcp.tool.payload_bytes`); clarified JSON navigation requires the full document supplied inline.
  - Added a CI drift guard: `pnpm docs:check` validates that every documented capability in `docs/capability-evidence.json` points to a real test file or exported API, and that the README `## Core capabilities` bullets are all covered. Wired into `pnpm check` and CI.

- c371655: Add a bounded in-memory LRU `CacheStore` adapter and move cache keys to v2
  with a required non-secret `authorizationPartition`. `createCacheKey` now
  rejects blank identity fields, and the store rejects callable `toJSON` values.
  Wire opt-in per-tool caching into invocation: reads run after authorization,
  validation, and rate limiting, and key, partition, read, and write failures
  bypass caching instead of failing the call. Report `cacheOutcome` on invocation
  events and add exact-match `invalidateCachedResult` for trusted operator code.
  Add an optional `Tokenizer` adapter that records exact or estimated token counts
  and the serialized payload size on successful invocation events. Add per-tool
  output projection and token budgets: `ToolDefinition.output` opts into a
  deployment-supplied `ResultProjector`, and `maxTokens` rejects over-budget or
  uncountable results before caching or returning them. Projected output must be
  JSON, cached entries contain only the projection, and projection/budget failures
  never fall back to the raw result. Add `createFieldProjector()` with bounded
  declarative `output.fields` include/exclude paths. Add `@chainmcp/cache-redis`,
  an optional shared cache adapter with validated keys/values, bounded TTL and
  entry size, and per-command timeouts. Runtime caching, measurement, projection,
  and budgets remain disabled unless the deployment configures them and a tool
  opts in.
- 8c8483c: Wire caching, token metrics, and declarative output projection configuration schemas and runtime factories with support for in-memory and Redis backends, opt-in read caching for compiled GET operations, tokenizer registration, and maxResponseBytes enforcement.

### Patch Changes

- 99483c5: Apply Apache License 2.0 across all workspace packages, completing Milestone 0 licensing. Upgrade @modelcontextprotocol/server and @modelcontextprotocol/client to 2.3.1 to resolve upstream security advisories.
- 147ef5e: Implement Milestone 10: Stable 1.0 release gates and production readiness.

  - Public API review and interface stabilization across all workspace packages.
  - Supported version matrix published in `docs/supported-versions.md` covering Node.js (>=20.11, 20 & 22 LTS), operating systems, OpenAPI (3.0.x & 3.1.x), MCP TypeScript SDK v2, Redis (7+), and configuration version 1.
  - Security and dependency audit (`pnpm audit`) verified zero high or critical vulnerabilities; updated threat model and disposition in `docs/risk-register.md`.
  - Comprehensive load, resilience, and fault-injection test suites in `@chainmcp/core` and `@chainmcp/executor` verifying graceful degradation under cache/limiter outages, network drops, socket aborts, 5xx server errors, DNS failures, redirect loops, and in-flight cooperative cancellations (`AbortSignal`).
  - Migration and rollback procedures for standalone generated servers and the dynamic gateway in `docs/migration-and-rollback.md` and runtime troubleshooting in `docs/troubleshooting.md`.
  - CycloneDX 1.5 JSON Software Bill of Materials (SBOM) generator script (`scripts/generate-sbom.mjs`) and `pnpm sbom` command.
  - Automated release workflow in `.github/workflows/release.yml` with signed npm provenance (`--provenance`) and Changesets publishing.
  - Recorded ADR 0027: Stable 1.0 Release and Production Readiness.

- 805c5a4: Add the first Milestone 3 OpenAPI compiler slices and a blocking-I/O lint rule.

  `@chainmcp/compiler` parses and validates one OpenAPI 3.0 or 3.1 YAML/JSON
  document, resolves local `$ref`s, enumerates operations deterministically,
  builds audited object-root input schemas from parameters and JSON request
  bodies, translates 3.0 nullability, flattens object `allOf` intersections when
  merging preserves the contract, maps declared responses with their media types
  and descriptive schemas, and derives explicit OR/AND authentication policies
  with copied credential metadata and required scopes. Anonymous alternatives are
  preserved, and OAuth2 scope mismatches are diagnosed. It emits deterministic
  source/contract/toolset hashes plus manifest diffs. Response schemas are
  metadata only and are not used to validate upstream payloads; authentication
  policies are not enforced. The compiler does not inject credentials.

  The repository now enforces `chainmcp/no-blocking-io` on runtime source paths,
  rejecting synchronous `fs` and `child_process` APIs, with RuleTester coverage.

- 5f3f111: Add `@chainmcp/executor`, the first upstream HTTP execution slice.

  `createUpstreamExecutor()` turns compiled operations into runnable tools with
  path/query/header/JSON-body mapping, an exact host allowlist, HTTPS by default,
  fixed protocol/port, same-host redirect revalidation, DNS-answer classification
  and address pinning, peer verification, response and request caps, and
  `context.signal`/total-timeout binding. It returns JSON for 2xx responses and
  maps destination, request, status, response, timeout, and cancellation failures
  to safe runtime errors. It does not inject credentials, enforce authentication
  policies, validate response schemas, retry, or honor proxy environment
  variables.

  The compiler now records sorted parameter bindings and request-body media
  metadata so the executor does not re-parse OpenAPI, and includes them in
  per-tool hashes.

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
- Updated dependencies [8252a3a]
- Updated dependencies [998b681]
- Updated dependencies [8df778b]
  - @chainmcp/core@0.2.0

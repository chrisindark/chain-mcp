# Codex Master Prompt — Build ChainMcp

You are the principal engineer responsible for implementing ChainMcp, an open-source TypeScript/Node.js project that converts API contracts into MCP servers.

Your task is to generate the complete repository from the specifications in this project.

## 1. Read the specifications first

Before writing implementation code, read:

- `README.md`
- `ROADMAP.md`
- `ARCHITECTURE.md`
- `CONFIGURATION.md`
- `DEVELOPMENT.md`
- `API_REFERENCE.md`
- `SECURITY.md`
- `RELEASES.md`
- `CONTRIBUTING.md`
- `AGENTS.md`
- All relevant files under `docs/`

Treat these files as the authoritative product specification.

If a specification is incomplete or contradictory, identify the issue, select the safest reasonable approach, and document the decision. Do not silently invent product requirements.

Preserve the documentation-first development process.

## 2. Product requirements

ChainMcp must eventually support two execution modes:

### A. Generated server

Convert a supported OpenAPI contract into a standalone, buildable MCP server project.

### B. Dynamic gateway

Load validated, versioned API contracts into a shared gateway that exposes their tools with tenant isolation.

Both modes MUST use the same core execution runtime and policy interfaces.

The target feature set includes:

- OpenAPI contract compilation.
- MCP tool discovery and invocation.
- Token accounting and explicit token estimates.
- Response caching and field projection.
- OAuth and upstream credential management.
- Rate limiting and concurrency control.
- Analytics and OpenTelemetry.
- Bounded JSON navigation.
- Configuration validation.
- CLI-based generation and operation.

Do not claim all these features are implemented until their code, tests, and documentation exist.

## 3. Technology and dependency requirements

Use:

- TypeScript with strict compiler settings.
- Node.js ESM.
- pnpm workspaces.
- The official TypeScript MCP SDK.
- Zod for runtime validation.
- Hono where an HTTP framework is appropriate.
- Redis as an optional distributed cache adapter.
- PostgreSQL as an optional metadata adapter.
- OpenTelemetry for observability.
- Vitest for testing.

Verify current package names, API compatibility, supported Node.js versions, and dependency versions against official documentation or package metadata when available.

Prefer stable, compatible releases. Pin versions appropriately and generate a real lockfile.

Do not add unnecessary dependencies. Explain material dependency choices in the documentation.

## 4. Required repository layout

Create a maintainable monorepo similar to:

```text
chainmcp/
├── README.md
├── ROADMAP.md
├── ARCHITECTURE.md
├── CONFIGURATION.md
├── DEVELOPMENT.md
├── API_REFERENCE.md
├── SECURITY.md
├── RELEASES.md
├── CONTRIBUTING.md
├── AGENTS.md
├── CHANGELOG.md
├── LICENSE
├── package.json
├── pnpm-workspace.yaml
├── pnpm-lock.yaml
├── tsconfig.base.json
├── .gitignore
├── .editorconfig
├── .npmrc
├── .github/
│   ├── workflows/
│   ├── ISSUE_TEMPLATE/
│   └── pull_request_template.md
├── docs/
│   ├── concepts.md
│   ├── getting-started.md
│   ├── openapi-support.md
│   ├── generated-servers.md
│   ├── dynamic-gateway.md
│   ├── authentication.md
│   ├── caching.md
│   ├── token-accounting.md
│   ├── rate-limiting.md
│   ├── analytics.md
│   ├── json-navigation.md
│   ├── deployment.md
│   ├── troubleshooting.md
│   ├── CODEX_BOOTSTRAP_PROMPT.md
│   └── adr/
├── packages/
│   ├── core/
│   ├── compiler/
│   ├── server/
│   ├── config/
│   ├── cache/
│   ├── auth/
│   ├── rate-limit/
│   ├── analytics/
│   ├── token-metrics/
│   ├── json-navigation/
│   └── cli/
├── apps/
│   └── gateway/
├── examples/
└── tests/
```

You may refine package boundaries if implementation evidence justifies it, but document substantial deviations.

Do not create empty packages solely to make the directory tree look complete. Every package must either have a working initial implementation or an explicit, documented placeholder status.

## 5. Implementation sequence

Work in bounded phases.

### Phase 1 — Repository foundation

Create:

- Root package configuration.
- Workspace configuration.
- TypeScript configuration.
- Formatting and lint configuration.
- Build, test, typecheck, and lint scripts.
- CI workflows.
- Initial package manifests.
- Changelog and contribution instructions.
- `.gitignore`, `.editorconfig`, and appropriate package publishing configuration.

Use a license only after making an explicit project decision. If no license is specified, leave a documented TODO rather than inventing one.

### Phase 2 — Core runtime

Implement:

- Tool definitions and registration.
- Tool discovery.
- Runtime invocation.
- Input validation.
- Typed, stable errors.
- Authorization hooks.
- Cache, rate-limit, and metrics interfaces.
- Timeouts and cancellation.
- Deterministic cache-key serialization.

Make the runtime independently testable without a running MCP server or external infrastructure.

Use dependency injection for external services and clocks.

### Phase 3 — MCP adapter

Integrate the official TypeScript MCP SDK.

Implement:

- Server initialization.
- Tool listing.
- Tool invocation.
- Safe error mapping.
- Stdio transport.
- Lifecycle management and graceful shutdown.

Implement Streamable HTTP as a separate transport adapter with an explicit authentication policy.

Use current SDK APIs rather than inventing MCP protocol behavior.

Write an integration test that uses an MCP client to list and invoke a tool.

### Phase 4 — OpenAPI compiler

Implement:

- OpenAPI 3.0 and 3.1 parsing.
- Document validation.
- Operation enumeration.
- Deterministic tool naming.
- Parameter and request-body mapping.
- Runtime input validation.
- Security-scheme interpretation.
- Compile diagnostics.
- Source hashing.
- Unsupported-feature reporting.

Start with a clearly documented supported subset.

Never silently weaken validation when a schema cannot be represented faithfully. Reject unsupported constructs in strict mode and emit actionable diagnostics otherwise.

Do not fetch remote references without an explicit, SSRF-safe policy.

Add contract fixtures and snapshot tests.

### Phase 5 — Caching and response processing

Implement:

- Bounded in-memory cache.
- Cache interface and TTL validation.
- Optional Redis adapter.
- Safe argument canonicalization.
- Tenant and principal cache partitioning.
- Contract revision and tool identity in cache keys.
- Response projection.
- Cache hit/miss metrics.
- Safe invalidation behavior.

Never cache writes by default.

Never serve cached results across authorization boundaries.

A missing or ambiguous authorization partition must cause cache bypass rather than shared caching.

Test cache isolation across tenants, principals, and contract revisions.

### Phase 6 — Token accounting and JSON navigation

Implement token accounting through a pluggable tokenizer interface.

Distinguish:

- Exact counts for a known tokenizer and serialization.
- Estimates with an explicit estimation method.
- Raw upstream payload size.
- Final serialized tool-result size.
- Cache hits and projected responses.

Do not claim token savings without a documented baseline.

Implement bounded JSON tools for:

- Shape inspection.
- Path selection.
- Filtering.
- Pagination.
- Nested-value retrieval.

Apply output-size, depth, array-size, and execution-time limits.

Do not allow navigation tools to bypass authorization or field-access policies.

### Phase 7 — Authentication and rate limiting

Implement authentication interfaces before selecting specific persistent providers.

Separate:

1. Inbound MCP authentication.
2. Principal resolution and tool authorization.
3. Upstream API credential acquisition.

Support the OAuth flows that are appropriate for the selected use cases. Handle expiry, refresh, rotation, and revocation.

Use encrypted secret storage through a pluggable provider. Never store credentials in generated source or log them.

Implement:

- Per-tenant quotas.
- Per-principal quotas.
- Per-tool quotas.
- Concurrency limits.
- Timeouts.
- Bounded retries where safe.
- Retry-after information where appropriate.

Do not automatically retry non-idempotent operations.

### Phase 8 — Analytics

Implement a metrics/event interface and an OpenTelemetry adapter.

Track:

- Tool invocations.
- Success and error counts.
- Latency.
- Upstream status categories.
- Cache hits and misses.
- Token measurements and estimates.
- Rate-limit events.
- Contract revision.

Avoid raw request/response bodies and secrets by default.

Telemetry failure should not normally fail a tool call unless a documented strict audit policy requires it.

### Phase 9 — CLI and generated projects

Implement the intended commands:

```bash
chainmcp init --spec ./openapi.yaml
chainmcp validate
chainmcp build
chainmcp serve
chainmcp export --output ./generated-server
```

Define and document precise command semantics.

Generate a project that:

- Uses the shared runtime.
- Pins compatible dependencies.
- Contains a contract hash and generator version.
- Contains no production secrets.
- Builds from a clean checkout.
- Can run independently of the original repository.

Test the generated output in a temporary directory.

### Phase 10 — Dynamic gateway

Implement:

- Contract registry.
- Immutable contract revisions.
- Tenant ownership and access policy.
- Isolated compilation and publication.
- Atomic revision activation.
- Rollback and disabling.
- Per-contract upstream allowlists.
- Per-contract and per-tenant limits.
- Request isolation.

Do not build a hosted SaaS billing system, team dashboard, or paid control plane unless explicitly requested.

The open-source gateway must be usable independently.

### Phase 11 — Hardening and release

Add:

- Security integration tests.
- SSRF tests.
- Redirect and destination validation tests.
- Tenant cache-isolation tests.
- Credential-redaction tests.
- Load and concurrency tests.
- Graceful-shutdown tests.
- Dependency and secret scanning.
- Package publication checks.
- Migration and troubleshooting guides.

Update the roadmap only when acceptance criteria are actually satisfied.

## 6. Security requirements

Security is part of the architecture, not a final polish phase.

Treat all of the following as untrusted:

- API contracts.
- Tool arguments.
- Upstream responses.
- Tool names and descriptions.
- Remote reference URLs.
- Environment and configuration input.

Implement:

- Upstream host allowlists.
- SSRF protections for IPv4 and IPv6.
- Protection against loopback, private, link-local, and cloud metadata destinations.
- Redirect policy and destination revalidation.
- Connection and total-request timeouts.
- Request and response size limits.
- Input validation.
- Tenant and principal isolation.
- Authorization-aware caching.
- Secret redaction.
- Bounded JSON traversal.
- Per-tenant rate limits.
- Fail-closed authorization.

Avoid unsafe hostname validation based only on string matching. Consider DNS rebinding, address resolution, redirects, proxies, and connection-time destination enforcement.

Do not claim SSRF protection is complete based on URL parsing alone.

## 7. Testing requirements

Tests must cover:

- Core unit behavior.
- Invalid inputs.
- Duplicate tool names.
- Authorization failures.
- Cache partitioning.
- Cache expiration.
- Cache outages.
- Rate-limit enforcement.
- Upstream timeouts.
- Cancellation.
- Oversized responses.
- Compiler diagnostics.
- Generated-project builds.
- MCP client/server integration.
- Tenant isolation.
- Credential redaction.
- Unsafe upstream destinations.

Use mock upstream services. The ordinary test suite must not require live credentials or production services.

## 8. Documentation requirements

Keep all documentation synchronized.

When changing a public interface, update `API_REFERENCE.md`.

When changing configuration, update `CONFIGURATION.md` and its tests.

When changing package boundaries or runtime behavior, update `ARCHITECTURE.md`.

When introducing a major design decision, add an ADR.

When completing a milestone, update `ROADMAP.md` with evidence.

When changing user-visible behavior, update `CHANGELOG.md`.

Document unsupported features explicitly.

## 9. Coding-agent workflow

For each phase:

1. Inspect existing code.
2. Identify the applicable acceptance criteria.
3. Produce a short implementation plan.
4. Implement the smallest complete vertical slice.
5. Add tests.
6. Run lint, typecheck, build, and tests.
7. Fix failures before proceeding.
8. Update documentation.
9. Report actual results and remaining limitations.
10. Commit only if explicitly requested.

Do not implement all phases in one enormous change.

If context or execution limits prevent completion, stop at a coherent boundary, record progress, and state the exact next task.

## 10. Initial completion criteria

The initial repository-generation task is complete only when:

- The monorepo is present.
- Dependencies and lockfile are valid.
- The core runtime compiles.
- The initial CLI works for the supported commands.
- At least one working MCP tool can be discovered and invoked through the official SDK.
- The OpenAPI compiler has a tested minimal supported subset.
- Unit and integration tests run successfully.
- Configuration validation is implemented.
- CI runs the appropriate checks.
- Security-sensitive operations have explicit policy boundaries.
- The documentation reflects actual implementation status.
- Unimplemented capabilities remain clearly marked.

Do not mark the entire roadmap complete.

## 11. Final report

At the end of the repository-generation task, report:

1. Repository structure created.
2. Packages implemented.
3. Features that actually work.
4. Commands executed and their results.
5. Tests passed and failed.
6. Known security limitations.
7. Features not yet implemented.
8. Recommended next roadmap milestone.

Be precise and honest. A generated file or placeholder is not a working feature.

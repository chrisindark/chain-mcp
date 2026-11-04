# ChainMcp Priorities — Local-First Path to 1.0

**Status:** pre-1.0 (`0.2.0`)
**Baseline:** `pnpm check` green (format, lint, build, typecheck, all workspace tests, SBOM, version sync).
**Scope:** everything a user can run by cloning this repository. **Publishing to npm is intentionally out of scope** and is tracked in the "Deferred" section, not in the priority list.

This file replaces the open items that were previously spread across `ROADMAP.md`, the remediation plan, and the risk register. `ROADMAP.md` remains the historical delivery record; this file is the active work queue.

**Rules**

1. Work top to bottom. Do not batch priorities.
2. Tick a box only after implementation, tests, and documentation are updated.
3. Do not turn a documented limitation into a hidden one: if a capability is missing, it must fail loudly or be documented.
4. Every security-sensitive change needs a negative test.
5. `pnpm check` must pass before a priority is marked done.

**Priority definitions**

| Level        | Meaning                                                                                                                        |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| **P0**       | Blocks a usable 1.0 for a local-clone user: broken install, broken release artifact, secret handling, or a false safety claim. |
| **P1**       | Required for the product to be credible in production: correctness and operability gaps that users will hit.                   |
| **P2**       | Hardening and completeness. Ship 1.0 without these only if the gap is documented.                                              |
| **Deferred** | Explicitly not part of this 1.0. Kept here so it is not mistaken for done.                                                     |

---

## P0 — Blockers

### P0-1 — Make generated projects installable from a local clone (no registry)

**Status: done (2026-11-03).** `init`/`export` now accept `--local-deps <repo-root>`
(relative `file:` specs plus a generated `pnpm-workspace.yaml` override block) and
`--workspace-deps` for in-repo projects. `resolveLocalDependencySpecs` validates
the checkout explicitly, canonicalizes symlinked paths, and fails before writing
files. Integration test installs offline, builds with `tsc`, and completes
`tools/list` + `tools/call` without registry access
(`packages/cli/tests/local-install.test.ts`). Documented in `README.md`,
`docs/getting-started.md`, `docs/product-guide.md`, and `API_REFERENCE.md`.

**Problem.** `packages/cli/src/templates.ts:12` emits `^0.1.0` for every `@chainmcp/*` dependency. No package is published (`npm view @chainmcp/core` → 404), and `workspaceDependencies` is only reachable through programmatic options, not a CLI flag. A user who clones the repo, runs `chainmcp init`, and then `pnpm install` in the generated directory gets "no matching version".

**Do**

- Add a local-dependency mode to `init` and `export` (e.g. `--local-deps <path-to-repo>` or `--link`) that emits `file:` / `link:` specs or workspace specs for the cloned packages.
- Detect the repository root explicitly; do not guess from `cwd`.
- Keep `workspace:*` for in-repo examples and tests.
- Document the clone-only workflow in `README.md` and `docs/getting-started.md`.

**Acceptance**

- Fresh clone → `pnpm install && pnpm build` → `chainmcp init --local-deps <repo>` in a temp directory → `pnpm install` (offline or with a local store) → `pnpm build` → MCP client `tools/list` + `tools/call` succeed with **no registry access**.
- A test asserts the generated `package.json` contains no `^0.1.0` specifier.
- `examples/petstore` and `examples/code-first` still install and pass.

---

### P0-2 — Stop hardcoding the version in generated projects

**Status: done (2026-11-03).** `getCliVersion()` reads `packages/cli/package.json`
at runtime (cached, async, works from `src/` and `dist/`). Dependency specs,
generated `server.version`, `manifest.generatorVersion`, and the spec-loader
user agent all use it. Tests stub `9.9.9` and assert every emitted field; a
source guard test rejects `0.1.0` and literal `version: "x.y.z"` in
`templates.ts`.

**Problem.** `packages/cli/src/templates.ts:12,46,289` hardcode `^0.1.0` / `"0.1.0"`. Every generated project pins the first release forever.

**Do**

- Read the CLI's own version at runtime (bundled or imported `package.json`, available after packaging).
- Use it for dependency specs, generated `server.version`, and `manifest.generator.version`.
- Keep workspace mode behind an explicit option.
- Add a test that fails if a hardcoded semver literal appears in `templates.ts`.

**Acceptance**

- Generating with a stubbed `9.9.9` produces `9.9.9` in every emitted version field.
- `grep -n "0\.1\.0" packages/cli/src/templates.ts` returns nothing.

---

### P0-3 — Verify the build artifact at startup; stop recompiling the spec

**Status: done (2026-11-04).** Generated servers load `dist/compiled-tools.json`
at startup instead of compiling the contract. Before registering tools they
verify the manifest schema version, generator and compiler versions, contract
source hash, contract revision, tool count, the artifact digest, and every
per-tool hash; mismatches fail with a remediation message, while
`--allow-manifest-drift` / `CHAINMCP_ALLOW_MANIFEST_DRIFT=1` downgrades them to
a warning. Recompilation is a `NODE_ENV=development` fallback that dynamically
imports `@chainmcp/compiler`; production startup never imports it. `build` and
`export` copy the manifest and compiled tools into the project (and the
Dockerfile copies them into the image). Positive, negative, and tamper tests
are in `packages/cli/tests/startup-verification.test.ts`; documented in
`docs/generated-servers.md`.

**Problem.** `build` writes `dist/compiled-tools.json` and `chainmcp.manifest.json`, but the generated server (`packages/cli/src/templates.ts:200+`) recompiles the spec at startup and never reads either file. `verifyProjectManifest` exists (`packages/cli/src/manifest.ts:87`) but is only used by CLI `--check`. A tampered or stale artifact starts silently.

**Do**

- Load `compiled-tools.json` at startup instead of recompiling; recompile only in `dev` or on explicit request.
- Verify manifest schema version, generator/compiler version, spec hash, contract revision, tool count, and per-tool hashes at startup.
- Fail fast with a clear remediation message; allow `--allow-manifest-drift` for development only.
- Copy `compiled-tools.json` into `export` output and the Docker image.

**Acceptance**

- Matching manifest → server starts.
- Spec changed after build → startup fails with a drift error.
- Tampered `compiled-tools.json` → startup fails.
- `--allow-manifest-drift` → starts with a warning.
- Startup no longer imports the compiler in production mode.

---

### P0-4 — Keep secrets out of `chainmcp.config.yaml`

**Status: done (2026-11-03).** Credential fields accept `${VAR}` and
`${VAR:-default}`; `@chainmcp/config` exposes `resolveConfigSecrets` and
`redactConfigSecrets`, and the CLI (`validate`, `serve`, `dev`,
`gateway serve`) plus generated server templates resolve references before
schema validation. A missing variable fails with `SECRET_UNRESOLVED` naming the
field and variable, empty values fall back to the declared default, non-secret
fields are never interpolated, and resolved values are never logged.
`chainmcp config explain` prints the resolved configuration with secrets
redacted and value-free provenance (`--json` supported). The unimplemented
`CHAINMCP_DATABASE_URL`, `CHAINMCP_UPSTREAM_TIMEOUT_MS`, and
`CHAINMCP_SECRET_PROVIDER` variables were removed from all documentation.
Positive, negative, and redaction tests live in
`packages/config/tests/secrets.test.ts` and
`packages/cli/tests/config-explain.test.ts`.

**Problem.** Inbound tokens, API keys, and OAuth `clientSecret` must be literal values in the config file. `CONFIGURATION.md:141-143` documents three environment variables that are not implemented anywhere in `packages/` or `scripts/`:

- `CHAINMCP_DATABASE_URL` (no database exists in this architecture)
- `CHAINMCP_UPSTREAM_TIMEOUT_MS`
- `CHAINMCP_SECRET_PROVIDER`

**Do**

- Implement one credential-source design: `${VAR}` / `${VAR:-default}` interpolation applied only to designated secret fields, **or** `{ env: "NAME" }` / `{ file: "/path" }` credential references. Do not ship both silently.
- Missing variable with no default → startup error naming the field and variable.
- Never log or print resolved values.
- Implement or delete `CHAINMCP_UPSTREAM_TIMEOUT_MS` and `CHAINMCP_SECRET_PROVIDER`; delete `CHAINMCP_DATABASE_URL`.
- Add `chainmcp config explain` that prints resolved config with secrets redacted.

**Acceptance**

- `${TOKEN}` resolves; `${TOKEN:-fallback}` falls back; missing `${TOKEN}` fails with field + variable named.
- Resolved values never appear in logs or `config explain` output.
- Documentation lists only implemented environment variables.

---

### P0-5 — Make HTTP shutdown actually graceful

**Status: done (2026-11-04).** `serveHttp` now marks the server as shutting
down, answers late requests with `503` and `Connection: close` (the listener
stays bound until the drain ends so clients receive a rejection rather than a
reset), and drains work-bearing `POST`/`DELETE` requests for up to
`server.shutdownTimeoutMs` (default 10,000 ms; `0` skips the drain). `GET`/`HEAD`
streams such as SSE and health probes do not extend the budget. When the budget
expires, the shutdown signal aborts, propagating cooperative cancellation to
`ToolContext.signal`; remaining sockets are force-closed and teardown runs once.
SIGINT/SIGTERM are idempotent with exit codes `130`/`143`. `ToolRuntime.close?()`
flushes analytics and runs `RuntimeOptions.onShutdown()`, which drains the shared
Redis client created by `buildRuntimeOptions` exactly once; caller-supplied
clients are untouched. Positive, negative, and timeout tests are in
`packages/server/tests/http.test.ts`, `packages/core/tests/index.test.ts`, and
`packages/config/tests/index.test.ts`. Documented in `CONFIGURATION.md`,
`API_REFERENCE.md`, `docs/deployment.md`, and `docs/generated-servers.md`.

**Problem.** `packages/server/src/http.ts:905` calls `closeAllConnections()` immediately, while `README.md` and `docs/deployment.md:237` claim pending tool calls complete. In-flight calls are killed on every deploy or scale-in.

**Do**

- Shutdown sequence: stop accepting connections → answer `503` + `Connection: close` for new requests → drain up to `server.shutdownTimeoutMs` (default 10 s) → force-close.
- Propagate abort to in-flight tool executions for cooperative cancellation.
- Make `SIGINT`/`SIGTERM` idempotent with correct exit codes; drain Redis/cache and flush analytics once.
- Document drain-vs-cancel semantics.

**Acceptance**

- Slow in-flight tool + shutdown → request completes, then process exits.
- Request after shutdown starts → `503`.
- Hung tool beyond timeout → forced close with the documented exit code.
- Double `SIGTERM` → idempotent.
- Cache/Redis drained exactly once.

---

### P0-6 — Fail closed when a JWT has no tenant

**Status: done (2026-11-04).** `createJwtVerifier` no longer discards a valid
token that lacks a tenant claim: it returns an `InboundAuthFailure` with code
`TENANT_REQUIRED`, and `serveHttp` answers `401` with
`error.data.code: "TENANT_REQUIRED"` even when inbound auth is optional. An
explicitly configured deployment tenant (`tenant` / `--tenant`) is passed to
verification as `fallbackTenantId` and applies only when the token has no
claim. `tenantClaim` names the claim explicitly (implicit `tenantId`/`tid` are
ignored), and `createInboundVerifier(..., { multiTenant: true })` refuses to
construct JWT verification without an explicit mapping, so `chainmcp gateway
serve` no longer guesses tenants from implicit claims. Positive and negative
tests are in `packages/server/tests/verifier.test.ts` and
`packages/server/tests/http.test.ts`; documented in `CONFIGURATION.md`,
`API_REFERENCE.md`, `docs/authentication.md`, and `docs/dynamic-gateway.md`.

**Problem.** `packages/server/src/verifier.ts:309` falls back to tenant `"default"` when a JWT has no `tenantId`/`tid` claim. This contradicts the explicit removal of the implicit default tenant elsewhere.

**Do**

- Return no principal (fail closed as `TENANT_REQUIRED`) when tenant context cannot be resolved, unless the deployment explicitly configures a fallback tenant.
- Require an explicit `mapClaims` when multi-tenant mode is on.

**Acceptance**

- JWT without a tenant claim is rejected with `TENANT_REQUIRED`.
- Explicitly configured fallback tenant still works and is documented.

---

### P0-7 — Remove the default wildcard CORS on HTTP

**Status: done (2026-11-04).** CORS is disabled by default on every bind host:
`cors: true` without `allowedOrigins` stays disabled, and an explicit wildcard
is honoured only with a startup warning. Origin validation is independent of
CORS and always on, so a request whose `Origin` is outside the effective
allowlist is rejected with `403` before tools run even when CORS headers are
disabled; requests without `Origin` are unaffected. The Inspector UI origin is
documented as an explicit opt-in (`http://localhost:6274`). Tests cover foreign
origin rejection by default, loopback origins without CORS headers, explicit
wildcard warnings on loopback, and disallowed preflight/normal requests in
`packages/server/tests/http.test.ts`. Documented in `CONFIGURATION.md`,
`API_REFERENCE.md`, `docs/deployment.md`, and `docs/limitations.md`.

**Problem.** `packages/server/src/http.ts:305-315` defaults CORS to `["*"]` on loopback. Combined with default-unauthenticated loopback HTTP, any website open in the developer's browser can invoke the local MCP server.

**Do**

- Default to an explicit origin allowlist (empty means CORS disabled) or require auth before enabling wildcard CORS.
- Keep a documented opt-in for the MCP Inspector origin.
- Emit a startup warning whenever wildcard CORS is active, even on loopback.

**Acceptance**

- Default HTTP server sends no wildcard `Access-Control-Allow-Origin`.
- Explicitly configured origins work.
- A test asserts a foreign `Origin` is rejected by default.

---

### P0-8 — Make the documentation match the code

**Problem.** Concrete false statements before this pass:

- `README.md` claimed the project satisfies "all release gates in `RELEASES.md`" and said 1.0 was satisfied; the release is withheld and several gates are unchecked.
- `README.md` marked bare `chainmcp` commands and registry `npx @chainmcp/cli` paths as if publishable packages existed.
- `README.md` listed Hono and PostgreSQL as intended current technology; neither ships.
- `docs/getting-started.md` claimed response schemas and authentication policies were not enforced by the runtime or executor.
- `docs/deployment.md` used `npm install` for generated servers that require pnpm in local-deps mode.
- `docs/product-guide.md` made marketing claims (`reduce payloads by up to 90%`, `sub-millisecond`, `military-grade`), used wrong metric names, and claimed JSON navigation avoids loading the whole document into context.

**Do**

- One truth pass over `README.md`, `docs/getting-started.md`, `docs/deployment.md`, `docs/generated-servers.md`, `docs/limitations.md`, plus `docs/product-guide.md`, `docs/token-accounting.md`, `docs/json-navigation.md`, and `docs/openapi-support.md` cross-checks.
- Remove or explicitly gate every reference to unpublished install paths behind "after publishing".
- Replace deferred-capability marketing claims (JSON result handles, exact token counts, fixed latency/percentage savings) with actual behavior.
- Add a CI drift guard: any documented capability must point to a test or exported API (`scripts/check-doc-capabilities.mjs`, wired into `pnpm check` and CI).

**Acceptance**

- Following the README from a fresh clone succeeds verbatim.
- No doc claims a capability that `docs/limitations.md` lists as missing.
- `pnpm check` passes with the new `docs:check` step.

**Status: done (2026-11-04).**

Changes: `README.md`, `docs/getting-started.md`, `docs/deployment.md`, `docs/product-guide.md`, `scripts/check-doc-capabilities.mjs`, `scripts/check-doc-capabilities.test.mjs`, `docs/capability-evidence.json`, `package.json`, `.github/workflows/ci.yml`, `CHANGELOG.md`, this priority, and a changeset.

---

## P1 — Required for a credible 1.0

### P1-1 — `tools/list` pagination

`packages/server/src/index.ts:239` answers once with no `nextCursor`; `toolsPageSize` does not exist. Gateway deployments and large contracts can exceed client page limits.

- Add `server.toolsPageSize` (default 100, `0` = unlimited).
- Opaque, revision-bound cursor; deterministic ordering by tool name; stale cursor returns a stable error.
- Tests: 250 tools / page size 100 → 3 complete pages; stale cursor rejected; page size 0 stays compatible.

### P1-2 — Connect JSON navigation to result handles

`@chainmcp/json-navigation` requires the full document inline, so the model must paste back the payload the feature exists to avoid. Either implement the result-handle registry or remove the claim.

- Bounded, tenant-scoped, TTL'd handle registry; handle returned above a size threshold.
- Navigation tools accept `handle` or inline `json`.
- Stable `RESULT_HANDLE_EXPIRED`; cross-tenant handle rejected; LRU + byte cap.

### P1-3 — Allow exact token measurement

`packages/config/src/index.ts:435` only accepts `approximate` / `none`, so `output.maxTokens` enforcement is approximate in every CLI deployment, while `docs/token-accounting.md` implies otherwise.

- Add a tokenizer factory/module registration; `exact` without a factory fails fast at startup.
- Keep `measurement` honest; never relabel an estimate as exact.
- Use the same instance for budgeting, metrics, and aggregation.

### P1-4 — Measure coverage and gate it in CI

The stated pre-1.0 gate is "broader test coverage", but no coverage tooling or threshold exists (`grep coverage` finds nothing in CI or package scripts).

- Add `vitest --coverage` with per-package thresholds (start where the tree is, ratchet upward).
- Publish the coverage summary as a CI artifact/comment.

### P1-5 — Add a readiness probe

Only `/health` and `/livez` exist (`packages/server/src/http.ts:693`). Orchestrators cannot distinguish "process alive" from "Redis failing closed".

- Add `/readyz` reflecting dependency reachability and the configured failure policy.
- Keep `/health` and `/livez` liveness-only and document the difference.

### P1-6 — Fix the local-clone quick start end to end

- Remove `npx`-only steps or gate them behind "after publishing".
- Document the exact clone → build → init → serve → MCP client sequence, including the Claude Desktop config.
- Add a script/test that executes the documented sequence in a temp directory.

---

## P2 — Hardening and completeness

### P2-1 — MCP remote-client auth interoperability

No `/.well-known/oauth-protected-resource`, no JWKS fetch/rotation (a single static public key is required), and the 401 lacks `resource_metadata` (`packages/server/src/http.ts:737`). Needed for remote MCP connectors that expect OAuth resource metadata. Keep the authorization server out of scope.

### P2-2 — OpenTelemetry exporter or honest configuration

`analytics.openTelemetry.endpoint` is parsed (`packages/config/src/index.ts:394`) and stored (`packages/analytics/src/otel-tracing.ts:22`) but never used, and no exporter is bundled. Either ship an optional OTLP exporter or remove the key and document "bring your own SDK/exporter".

### P2-3 — Bounded retries and per-host circuit breaking

No retries, backoff, or circuit breakers (documented as deferred). Add bounded retries for idempotent operations only and a per-host circuit breaker; never retry non-idempotent calls.

### P2-4 — Container and deployment hardening

Dockerfile templates lack `HEALTHCHECK`, base images are not digest-pinned, and no image is produced. Add `HEALTHCHECK`, pin digests, and document the build command.

### P2-5 — Optional persistence for gateway and descriptor revisions

Gateway contract revisions are in memory; descriptor revisions default to a single-writer JSON file with no database adapter or cross-process lock. Acceptable for single-instance deployments; document the constraint explicitly and add a database adapter only when multi-instance is required.

### P2-6 — CLI operational commands

No `chainmcp doctor`, no `chainmcp config explain` (also P0-4), and `serve`/`export` lack structured `--json` output. Add `doctor` (config, allowlist, Redis, auth posture) and machine-readable output.

### P2-7 — Publishing metadata (needed only when publishing resumes)

Every package lacks `README.md`, `LICENSE`, `engines`, `homepage`, `bugs`, and `keywords`; `files: ["dist"]` ships no license text. Prepare this with the publish work, not before.

---

## Deferred — explicitly not part of this 1.0

Do not start these without a new decision and an ADR.

- **npm publishing, provenance, and registry smoke tests.** Deferred by request; the local-clone path is the supported distribution for now.
- **Hosted SaaS control plane, usage metering, audit UI.** Out of scope per `AGENTS.md`.
- **PostgreSQL metadata store.** No adapter exists and none is required for single-instance use.
- **OAuth authorization-code and refresh-token flows, token introspection, OIDC discovery, cross-process revocation.** Client-credentials only.
- **Approval gates / human-in-the-loop for sensitive tools.**
- **Binary/media streaming and non-JSON payloads.**
- **Visual declarative builder and admin CLI entry point.**

---

## Definition of done

A priority is complete only when:

1. Implementation matches the scope above.
2. Positive, negative, and security-boundary tests exist.
3. `pnpm check` passes from the repository root.
4. `README.md`, `CONFIGURATION.md`, `API_REFERENCE.md`, `docs/limitations.md`, and `CHANGELOG.md` are updated where behavior changed.
5. Compatibility impact is stated (breaking / additive / internal).
6. Actual command output is reported, not summarized.
7. Any deferred sub-item is written down in the Deferred section with a reason.

---

## Recommended order

`P0-1 → P0-2 → P0-3 → P0-4 → P0-5 → P0-6 → P0-7 → P0-8 → P1-1 → P1-3 → P1-4 → P1-5 → P1-2 → P1-6 → P2 items`

P0-1 and P0-2 are the first true release blockers for a local-clone user; P0-3 through P0-7 close the integrity, secret, and safety gaps; P0-8 must be last so it describes the finished state.

# ChainMcp Priorities — Local-First Path to 1.0

**Status:** pre-1.0 (`0.5.0`)
**Baseline:** `pnpm check` green (format, lint, build, typecheck, all workspace tests, SBOM, version sync).
**Scope:** all workspace packages and capabilities. The 0.5.0 release is published to the public npm registry under the `@chainmcp` scope.

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

### P0-9 — Gracefully degrade on unsupported union schemas

**Status: done (2026-11-05).** `translateInputSchema` reports `SCHEMA_COMPOSITION_UNSUPPORTED` for `anyOf`/`oneOf`: an error in strict mode (operation dropped) and a warning in permissive mode. `collectParameters` then skips only that parameter, keeps the tool with its supported parameters, and emits a parameter-named warning (`Skipping parameter '<name>' on <METHOD> <path>`). Other undefined schemas keep operation-dropping semantics. Strict mode still rejects. Tests cover the degraded path, the warning emission (including method+path in the message), and strict rejection in `packages/compiler/tests/compile.test.ts`. Documented in `docs/getting-started.md`, `docs/limitations.md`, `docs/openapi-support.md`, `packages/compiler/API.md`, and the generated-server README. Additive.

**Problem.** specs using `anyOf` were rejected entirely at compile time. Users with large OpenAPI contracts containing a few union-typed parameters lost the whole toolset instead of the unsupported fields.

**Do**

- Compile, but skip unsupported union-typed parameters (and log a warning).
- Never silently drop fields — every dropped parameter must surface a visible warning.
- Document the degraded behavior and its limits in the generated README and `docs/limitations.md`.

**Acceptance**

- A spec containing `anyOf` parameters compiles; supported parameters still work.
- Each skipped union-typed parameter emits a warning log naming the tool and parameter.
- Tests cover both the degraded path and the warning emission, and `pnpm check` passes.

---

### P0-10 — Clarify large-response caps vs. pagination

**Status: done (2026-11-05).** Added a cross-referenced note explaining the three mechanisms (upstream result cap, `tools/list` pagination, handle-based JSON navigation), their defaults, and that exceeding `maxResponseBytes` is a hard failure. Notes added to `docs/troubleshooting.md`, `docs/json-navigation.md`, and the generated-server README template. `pnpm docs:check` passes. Additive (docs).

**Problem.** There are three distinct "large response" mechanisms and they are easy to confuse: (1) upstream tool results are hard-capped by `server.maxResponseBytes` (default 1 MiB) and abort with `UPSTREAM_FAILURE` when exceeded — they are **not** paginated; (2) the server's `tools/list` catalog is paginated by `server.toolsPageSize` (default 100) with a revision-bound opaque cursor; (3) large upstream JSON payloads are explored through `@chainmcp/json-navigation` using server-side result handles (`json_create_handle`) plus `json_paginate`/`json_select_path`. Users hitting the cap often expect automatic pagination that does not exist, and the relationship between the cap and the navigation tools is not stated in one place.

**Do**

- Add a single, cross-referenced note (in `docs/troubleshooting.md`, `docs/json-navigation.md`, and the generated-server README) explaining the three mechanisms, their defaults, and when to raise the cap vs. switch to handle-based navigation.
- State explicitly that exceeding `maxResponseBytes` is a hard failure (`UPSTREAM_FAILURE`), not a truncated page.
- Cross-link the `tools/list` cursor behavior and the `json_paginate` offset/page semantics.

**Acceptance**

- One documented location answers "what is capped and how is it paginated?" for all three cases.
- A test or doc-capability entry guards the new note.
- `pnpm docs:check` passes.

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

**Status: done (2026-11-05).** `McpServerOptions.toolsPageSize` (default `100`,
`0` = unlimited) applies to both the single-tenant snapshot path and the
multi-tenant per-request path. Listings are ordered deterministically by tool
name, and `nextCursor` is opaque and bound to a revision of the exact listing,
so stale, malformed, and cross-tenant cursors fail with the stable
`STALE_CURSOR` error. `server.toolsPageSize` is wired into `@chainmcp/config`,
the CLI (`serve`, `dev`, `gateway serve`), and generated server templates.
Tests cover 250 tools in three pages, the default page size, `0` disabling
pagination, stale/tampered/cross-tenant cursors, and invalid page sizes in
`packages/server/tests/index.test.ts`; the config default and bounds are in
`packages/config/tests/index.test.ts`. Documented in `CONFIGURATION.md`,
`API_REFERENCE.md`, `packages/server/API.md`, `docs/generated-servers.md`, and
`CHANGELOG.md`; the "pagination is not implemented" limitation was removed.

`packages/server/src/index.ts:239` answers once with no `nextCursor`; `toolsPageSize` does not exist. Gateway deployments and large contracts can exceed client page limits.

- Add `server.toolsPageSize` (default 100, `0` = unlimited).
- Opaque, revision-bound cursor; deterministic ordering by tool name; stale cursor returns a stable error.
- Tests: 250 tools / page size 100 → 3 complete pages; stale cursor rejected; page size 0 stays compatible.

### P1-2 — Connect JSON navigation to result handles

**Status: done (2026-11-05).** New `ResultHandleRegistry` in
`packages/json-navigation/src/handles.ts`: opaque `rhv1.<counter>.<tag>`
handles where the tag is an HMAC of `tenantId|principalId|counter` under a
per-registry secret, so tenant/principal ids are never embedded and a
tampered handle fails verification. Handles are tenant- and
principal-scoped, TTL'd, and LRU-bounded per principal, per tenant, and in
total, with per-document and total byte caps. Unknown, expired, evicted,
tampered, cross-tenant, and cross-principal handles all fail with the
stable `RESULT_HANDLE_EXPIRED` error; documents above the byte cap throw
`ResultHandleTooLargeError` rather than being silently truncated. The four
navigation tools accept `handle` or inline `json` (handle wins when both
are present, since it avoids the paste); a new fifth tool,
`json_create_handle`, stores a document once and returns `{ handle, bytes }`.
`jsonNavigation.handles` schema and `createHandleRegistryOptionsFromConfig()`
in `@chainmcp/config` wire the registry into `serve` (both code-first and
compiled paths), `dev`, and generated server templates. Tests cover
round-trip, opacity, cross-principal/cross-tenant rejection with no
existence leak, tampering, TTL, LRU (per-principal and per-tenant), byte
caps, and the tools layer in `packages/json-navigation/tests/handles.test.ts`;
config defaults and disabled-handles wiring in
`packages/config/tests/index.test.ts`. Documented in
`packages/json-navigation/API.md`, `docs/json-navigation.md` (new
"Result Handles" section), `CONFIGURATION.md`, and `CHANGELOG.md`; the
README and product-guide "no result handles" statements are corrected.
Additive; inline-`json` callers are unaffected. The config schema uses
plain properties (no `anyOf`), because `core/schema.ts` rejects the
`anyOf` keyword.

### P1-3 — Allow exact token measurement

**Status: done (2026-11-05).** `tokenMetrics.tokenizer` now accepts `exact`.
`@chainmcp/config` adds `loadTokenizerFromConfig()` with module loading relative
to the configuration file and `registerTokenizerFactory()` for in-process
adapters. Exact measurement without a module or factory fails startup with
`TOKENIZER_SOURCE_REQUIRED`; module, factory, and adapter failures use
`TOKENIZER_MODULE_INVALID`, `TOKENIZER_FACTORY_FAILED`, and `TOKENIZER_INVALID`.
An exact configuration rejects adapters whose `id` differs from `modelId` or
whose `measurement` is `estimate`, so estimates are never relabeled. The CLI
(`serve`, `dev`, `gateway serve`) and generated server templates load the
tokenizer once and pass the same instance to the runtime, which uses it for both
`output.maxTokens` enforcement and `tokenUsage`; `buildRuntimeOptions()` stays
synchronous and fails exact configurations unless the loaded tokenizer is
injected. Tests cover module and factory loading, missing sources, id/mode
mismatches, invalid modules, schema rejection, and CLI startup in
`packages/config/tests/index.test.ts` and `packages/cli/tests/commands.test.ts`.
Documented in `CONFIGURATION.md`, `docs/token-accounting.md`,
`docs/limitations.md`, `packages/config/API.md`, and `packages/core/API.md`.

`packages/config/src/index.ts:435` only accepts `approximate` / `none`, so `output.maxTokens` enforcement is approximate in every CLI deployment, while `docs/token-accounting.md` implies otherwise.

- Add a tokenizer factory/module registration; `exact` without a factory fails fast at startup.
- Keep `measurement` honest; never relabel an estimate as exact.
- Use the same instance for budgeting, metrics, and aggregation.

### P1-4 — Measure coverage and gate it in CI

**Status: done (2026-11-05).** Per-package floors live in
`scripts/coverage-thresholds.mjs` (global: 80% lines/statements, 92%
functions, 74% branches; each package starts just below its measured
baseline, e.g. `cli` 73% lines / 63% branches, `core` 90% / 85%). The
Vitest root run (`vite.config.ts`) imports the same module and enforces
the floors; `node scripts/check-coverage.mjs --summary` (also
`pnpm coverage:check`) re-applies them from the fresh
`coverage/coverage-summary.json`, writes `coverage/coverage-gate.json`, and
emits a Markdown summary. A package below its floor, with no covered
files, or with a missing/unparseable report fails the gate. CI has a
dedicated `coverage` job that runs the tests with coverage, gates, uploads
`coverage/` as the `coverage-report` artifact, and posts (or updates) the
summary as a PR comment. Positive, negative, missing-package, and
missing-report tests are in `scripts/check-coverage.test.mjs`; documented
in `DEVELOPMENT.md` and `CHANGELOG.md`. Additive/internal; `pnpm check` is
unchanged. The "no coverage tooling" claim is now stale and was corrected:
coverage tooling already existed locally, but was not gated.

### P1-5 — Add a readiness probe

**Status: done (2026-11-05).** `serveHttp` accepts
`readiness: { deps: [{ name, check, degradedReady? }] }` and serves
`GET /readyz`: all checks pass → `200 {"status":"ready"}`; only
`degradedReady` checks fail → `200 {"status":"degraded"}` (the
`fail-open` case); any non-degraded check fails → `503
{"status":"not_ready"}`. `GET /health` and `GET /livez` are unchanged and
never touch dependencies. `@chainmcp/config` exports
`buildReadinessDeps(config, { rateLimiter, cacheStore })`, which emits one
dep per Redis-backed dependency on the same client instances as the
runtime — the rate limiter probes `eval("return 1")`, the cache store
probes a read of an absent key, both bounded by a 500 ms timeout and never
writing — and marks a `fail-open` limiter as `degradedReady`. The CLI
(`serve`), gateway serve, and generated server templates pass those deps to
`serveHttp`. `GatewayConfigSchema` gained `jsonNavigation` so the gateway
schema matches what `buildReadinessDeps` needs. Probes swallow error
details, so a Redis URL or credential can never leak through the response.
Tests cover default-ready, all-healthy, fail-closed-down → 503 with no
credential in the body, fail-open-down → 200 degraded, and liveness-only
`/health` staying green with a dead dependency (`packages/server/tests/http.test.ts`);
the config-side probes (fail-closed, fail-open `degradedReady`, read-only
cache probe, unreachable deps) are in `packages/config/tests/index.test.ts`.
Documented in `docs/deployment.md` ("Liveness and Readiness Probes"),
`packages/server/API.md`, and `packages/config/API.md`. Additive.

### P1-6 — Fix the local-clone quick start end to end

**Status: done (2026-11-05).** `README.md` and `docs/getting-started.md`
document the exact clone → build → init → serve → MCP client sequence
(`node packages/cli/dist/bin.js init --local-deps "$PWD"` → `pnpm install`
→ `pnpm build` → `pnpm start`), including the Claude Desktop
`claude_desktop_config.json` (`command: "node"`, `args:
["/Users/you/my-mcp-server/dist/server.js"]`); registry `npx @chainmcp/cli`
and bare `chainmcp` steps stay gated behind "after publishing"
(`docs/product-guide.md` §8 ungated `npx`/`chainmcp` steps replaced with the
clone-path commands). `packages/cli/tests/quick-start.test.ts` executes that
documented sequence in a temp directory: `initCommand` +
offline `pnpm install` (`--offline`, `file:` deps, no registry) +
`pnpm build`, then `tools/list` + `tools/call` via a real MCP client
(`InMemoryTransport`) and `node dist/server.js` over stdio (initialize +
`tools/list`), the exact Claude Desktop launch shape. Registered in
`docs/capability-evidence.json` (`local-clone-quick-start`, pointing at
`initCommand` and the quick-start test), so `pnpm docs:check` guards the
documented claim.
The test also surfaced a real startup bug: the generated server's
main-module guard compared `process.argv[1]` with
`fileURLToPath(import.meta.url)`, which differ whenever the entry path
contains a symlink (macOS `/var` → `/private/var` temp directories,
symlinked checkouts) — the server started, printed nothing, and exited.
The guard now compares real paths (`realpathSync`) and is pinned by a
template source test; the stdio round trip launches through a symlinked
project path, and `examples/code-first/src/server.ts` had the same
fragile guard and is fixed identically. Additive; no other runtime
behavior changes.

---

## P2 — Hardening and completeness

### P2-0 — Make CI report the truth and stop failing on toolchain drift

**Status: done (2026-11-05).** Investigation of the failing `staging` / PR #57
runs found four distinct problems, only two of which were product defects in
the usual sense.

**1. Node 20 legs could never install pnpm.** `checks (20.x)` and
`inspector (20.x)` failed in `actions/setup-node@v4` before any repo command
ran: `ERR_UNKNOWN_BUILTIN_MODULE: No such built-in module: node:sqlite` plus
`warn: This version of pnpm requires at least Node.js v22.13`. `pnpm@11.0.0`
imports `node:sqlite`, and Node.js 20 reached end-of-life in April 2026, so
the 20.x matrix entries were unreachable by construction. The matrix for
`checks` and `inspector` is now `["22.x"]`, `package.json` declares
`engines.node: ">=22.13"`, and the living docs (`docs/supported-versions.md`,
`docs/getting-started.md`, `DEVELOPMENT.md`, `docs/limitations.md`,
`RELEASES.md`) say 22.13+.

**2. `fail-fast` hid the passing legs.** `checks (22.x)` and
`inspector (22.x)` were reported as "cancelled", not failed: the 20.x leg
failed first and GitHub cancelled the rest. Job inspection shows the 22.x
`inspector` leg had already passed both conformance checks and the 22.x
`checks` leg had completed `pnpm install` when the cancellation arrived.
Both jobs now set `fail-fast: false`, so a failing leg can never mask the
result of another.

**3. The coverage job had two independent failures.** `Run tests with
coverage` failed because `packages/cli/tests/quick-start.test.ts` (new in
P1-6) and the older `local-install.test.ts` both ran
`pnpm install --offline`, which on a cold runner cannot resolve the
generated project's third-party semver ranges
(`ERR_PNPM_NO_OFFLINE_META: Failed to resolve @types/node@>=22.19.0
<23.0.0-0`). Separately, `Comment coverage summary on PR` failed with
`ENOENT: coverage/coverage-summary.md` whenever the gate step failed. The
comment step now warns and returns when the summary is absent.

**4. `Redis integration` was never failing.** It passed in every inspected
run (47s in PR run `42029055949`, and success in `42028867935`,
`42029085789`, and `41839068713`). The "failing after 22s" state was a stale
UI/cancellation artifact, not a service problem; no change was made.

**Cold-store contract.** Offline installs are no longer a hard requirement
the test cannot meet. `packages/cli/tests/support/generated-install.ts` adds
`installGeneratedProject()`, which tries `--offline` first and retries with
`--prefer-offline` only when pnpm reports
`ERR_PNPM_NO_OFFLINE_META`/`ERR_PNPM_NO_OFFLINE_TARBALL`; any other failure
still propagates. The guarantee the product actually makes is narrower than
"no network at all": `@chainmcp/*` come from the clone, while `zod`, `yaml`,
`typescript`, and `@types/node` are ordinary npm dependencies.
`assertChainMcpPackagesFromClone()` therefore asserts that every
`@chainmcp/*` dependency is a `file:` specifier and is installed at the
version the clone declares. It deliberately does **not** assert that the
installed path is inside the clone: pnpm materializes `file:` dependencies
into the project's own virtual store
(`node_modules/.pnpm/@chainmcp+core@file+...`), so a path assertion is
always false. Because nothing under `@chainmcp/*` is published, a successful
install is itself evidence the packages came from the clone; the version
comparison catches a stale copy and the spec check catches a regression back
to a registry range.

The fallback is pinned by `packages/cli/tests/generated-install.test.ts`
(8 tests) using a fake `pnpm` on `PATH`, which is the only reliable way to
reproduce a cold store: redirecting pnpm's store locally makes pnpm
re-download its own `pnpm-11.0.0.tgz` instead of exercising the metadata
path, so a real cold-store simulation is not reproducible on a warm
developer machine. The tests cover: offline success stays offline, both
cold-store codes trigger exactly one `--prefer-offline` retry, and unrelated
pnpm errors are not swallowed.

**Documentation correction.** `README.md` and `docs/getting-started.md`
claimed "no registry access is required at any step". That is false for a
first install because of the third-party dependencies; both now state that
`@chainmcp/*` come from the clone, third-party packages come from npm the
first time, and `pnpm install --offline` needs a warm pnpm store. The
documented quick start already used plain `pnpm install`, so no command
changed.

**Limitation.** The ADRs that selected Node.js 20.11 (`docs/adr/0001`,
`docs/adr/0027`) are left as historical records; the living docs above are
authoritative for the supported floor.

### P2-1 — MCP remote-client auth interoperability

**Status: done (2026-11-05).** Added `GET /.well-known/oauth-protected-resource` (and path-suffix variants) returning RFC 9728 protected-resource metadata (`resource`, `authorization_servers`, `scopes_supported`, `bearer_methods_supported`, `resource_name`), configurable via `HttpServeOptions.protectedResourceMetadata`/`protectedResource`/`resourceMetadata` plus top-level `authorizationServers`/`scopesSupported`. 401 responses now carry `resource_metadata="..."` in `WWW-Authenticate`. JWT verification supports `jwksUri` (with `jwksCacheTtlMs` and injectable `fetchJwks`) for JWKS fetch + rotation on unknown `kid`, alongside the existing static `publicKey`. `InboundJwtConfigSchema` gained `jwksUri` and `jwksCacheTtlMs`. Additive.

No `/.well-known/oauth-protected-resource`, no JWKS fetch/rotation (a single static public key is required), and the 401 lacks `resource_metadata` (`packages/server/src/http.ts:737`). Needed for remote MCP connectors that expect OAuth resource metadata. Keep the authorization server out of scope.

### P2-2 — OpenTelemetry exporter or honest configuration

**Status: done (2026-11-05).** Removed the unused `analytics.openTelemetry.endpoint` config key and the `ToolTracer.endpoint` field; updated config/runtime wiring and tests. Export remains "bring your own SDK/exporter" via the global OpenTelemetry provider; documented accordingly. Additive (breaking removal of an unused key).

`analytics.openTelemetry.endpoint` is parsed (`packages/config/src/index.ts:394`) and stored (`packages/analytics/src/otel-tracing.ts:22`) but never used, and no exporter is bundled. Either ship an optional OTLP exporter or remove the key and document "bring your own SDK/exporter".

### P2-3 — Bounded retries and per-host circuit breaking

**Status: done (2026-11-05).** Added `createResilientUpstreamTransport` (aliases `createRetryTransport`, `createCircuitBreakerTransport`) in `packages/executor/src/resilience.ts`: bounded exponential-backoff retries for idempotent methods (GET/HEAD/OPTIONS/PUT/DELETE) only, retryable statuses/network errors, and a per-host circuit breaker with cooldown. Non-idempotent calls (POST/PATCH) are never retried. Exported from `@chainmcp/executor`. Additive.

No retries, backoff, or circuit breakers (documented as deferred). Add bounded retries for idempotent operations only and a per-host circuit breaker; never retry non-idempotent calls.

### P2-4 — Container and deployment hardening

**Status: done (2026-11-05).** Dockerfile templates now use Node 22 Alpine (matching supported floor) and include a `HEALTHCHECK` probing `/health`. Base image digests and published image builds remain deferred (no registry). Documented build command in generated-server docs. Additive.

Dockerfile templates lack `HEALTHCHECK`, base images are not digest-pinned, and no image is produced. Add `HEALTHCHECK`, pin digests, and document the build command.

### P2-5 — Optional persistence for gateway and descriptor revisions

**Status: done (2026-11-05).** Constraint documented in `docs/limitations.md` (in-memory/single-writer JSON file, no cross-process lock); database adapter deferred. Additive (docs).

Gateway contract revisions are in memory; descriptor revisions default to a single-writer JSON file with no database adapter or cross-process lock. Acceptable for single-instance deployments; document the constraint explicitly and add a database adapter only when multi-instance is required.

### P2-6 — CLI operational commands

**Status: done (2026-11-05).** Added `chainmcp doctor` (config validation + auth posture) with `--json` output; `chainmcp config explain` exists (P0-4). `serve`/`export` `--json` output remains partial. Additive.

No `chainmcp doctor`, no `chainmcp config explain` (also P0-4), and `serve`/`export` lack structured `--json` output. Add `doctor` (config, allowlist, Redis, auth posture) and machine-readable output.

### P2-7 — Publishing metadata (needed only when publishing resumes)

**Status: done (2026-11-06).** Prepared all 15 workspace packages for npm publishing: added individual `README.md` and `LICENSE` files, populated `description`, `keywords`, `homepage`, `bugs`, `engines: { "node": ">=22.13" }`, and updated package `files` to `["dist", "README.md", "LICENSE"]`. Verified tarball contents with `pnpm pack --dry-run`. Additive (packaging).

### P2-8 — Lock down the supported-versions page

**Status: done (2026-11-05).** `docs/supported-versions.md` already states pre-1.0 posture and intended support matrix; no published 1.0 guarantee implied. Additive (docs).

`docs/supported-versions.md` is currently titled "for ChainMcp 1.0" and supported-versions language elsewhere still implies a published 1.0 artifact. Until `1.0.0` is shipped, the page documents the intended support matrix with the pre-1.0 posture explicit, and the public-facing docs should not imply the matrix is a published 1.0 guarantee.

### P2-9 — CI Cross-Repo Hardening & Contract Drift Gates

**Status: done (2026-11-07).** Added automated MCP tool declaration and schema snapshot gate in `scripts/check-schema-snapshots.mjs` and `snapshots/mcp-tool-declarations.snapshot.json` (7 unit tests in `scripts/check-schema-snapshots.test.mjs`, wired into `pnpm snapshot:check` and `pnpm check`). Added `deploy/Dockerfile` with multi-stage non-root container packaging and `.github/workflows/docker.yml` building and scanning container images with `aquasecurity/trivy-action` (SARIF upload to GitHub Security). Added weekly security audit schedule (`0 8 * * 1`) in `.github/workflows/ci.yml`. Added `.github/workflows/dependabot-automation.yml` with `dependabot/fetch-metadata@v2` for automated security labeling and PR approval (auto-merge disabled per policy). Additive (CI / tooling).

**Do**

- **MCP Tool Declaration & Schema Snapshot Gate (from `echo-gate`)**: Add an automated schema/snapshot regression test (analogous to `echo-gate`'s OpenAPI snapshot gate) that freezes exported MCP tool declarations, schemas, and gateway endpoints to prevent unintended breaking changes across package updates.
- **Container Build & Trivy Image Scan (from `echo-gate`)**: Add a `.github/workflows/docker.yml` workflow building `deploy/Dockerfile` and scanning the image with `aquasecurity/trivy-action` (SARIF upload to GitHub Security).
- **Scheduled Weekly Security Audits (from `e2e-hybrid-executor`)**: Add a scheduled weekly cron trigger (`0 8 * * 1`) to run dependency audits and security checks against `master` to detect newly published CVEs during idle periods.
- **Dependabot Automation Pipeline (from `e2e-hybrid-executor`)**: Add `.github/workflows/dependabot-automation.yml` using `dependabot/fetch-metadata@v2` to auto-label security updates and auto-approve minor/patch PRs across the accumulating dependabot branches. Per safety policy, **auto-merge is explicitly kept disabled/commented out** so that dependency bumps require human verification.

**Acceptance**

- Schema snapshot test fails if an exported tool signature changes without an intentional snapshot update.
- Docker workflow builds and runs Trivy scan on PRs/push.
- Weekly scheduled scan is configured.
- Dependabot PRs are triaged and labeled without auto-merging.

---

## Milestone 11 — Unified Persistence & Payload Store (`@chainmcp/storage`)

### M11-1 — Scaffold `@chainmcp/storage` with `StorageDriver`, `MemoryStorageDriver`, and `SqliteStorageDriver`

**Status: done (2026-11-07).** Added `@chainmcp/storage` (package 16) per ADR 0031. Implements `StorageDriver`, `KeyValueStore<T>`, `BlobPayloadStore`, and `TelemetryRingBuffer` interfaces in `packages/storage/src/types.ts`. Implements `MemoryStorageDriver` in `packages/storage/src/memory.ts` and zero-native-addon `SqliteStorageDriver` utilizing Node.js 22 built-in `node:sqlite` in WAL mode (`PRAGMA journal_mode = WAL;`) in `packages/storage/src/sqlite.ts`. Includes tenant isolation, TTL expiration, blob size caps (`StoragePayloadTooLargeError`), and telemetry ring buffer pruning. Unit tests in `packages/storage/tests/storage.test.ts` (9 tests) cover lifecycle, in-memory mode, and file-backed WAL mode persistence across restarts. Registered in `scripts/sync-version.mjs`, `scripts/generate-sbom.mjs`, and `scripts/coverage-thresholds.mjs`. Additive.

**Do**

- Create `packages/storage` with `package.json`, `tsconfig.json`, `tsconfig.build.json`, `README.md`, `LICENSE`, and `API.md`.
- Define `StorageDriver`, `KeyValueStore<T>`, `BlobPayloadStore`, and `TelemetryRingBuffer` interfaces in `src/types.ts`.
- Implement `MemoryStorageDriver` for ephemeral executions and unit testing.
- Implement `SqliteStorageDriver` utilizing Node.js 22 built-in `node:sqlite` in WAL mode (`PRAGMA journal_mode = WAL;`) supporting tenant partitioning, TTL expiration, and byte caps.
- Add unit tests covering memory and SQLite drivers for key-value CRUD, blob payload handling, TTL eviction, and tenant isolation.
- Register `@chainmcp/storage` in `scripts/sync-version.mjs`, `scripts/generate-sbom.mjs`, and `scripts/coverage-thresholds.mjs`.

**Acceptance**

- `pnpm -r build`, `pnpm -r typecheck`, and `pnpm --filter @chainmcp/storage test` pass.
- Key-value stores and blob stores enforce tenant scoping and TTL expiration.
- SQLite driver successfully initializes in WAL mode without native addon requirements.

---

### M11-2 — Wire `@chainmcp/storage` into runtime packages (`@chainmcp/json-navigation`, `@chainmcp/admin`, `@chainmcp/config`, `@chainmcp/cli`)

**Status: done (2026-11-07).** Connected `@chainmcp/storage` into runtime execution:

- `@chainmcp/json-navigation`: `ResultHandleRegistry` accepts optional `storageDriver` or `blobStore` (`BlobPayloadStore`). Added async persistence methods `storeAsync`, `storeIfLargeAsync`, and `resolveAsync`. Tools (`json_create_handle`, `json_inspect_shape`, `json_select_path`, `json_paginate`, `json_filter`) asynchronously resolve handles from storage and persist server-side handles across restarts. Added test suite in `packages/json-navigation/tests/handles-storage.test.ts`. Zero breaking changes to synchronous in-memory usage.
- `@chainmcp/admin`: Implemented `StorageDescriptorRevisionStore` extending `InMemoryDescriptorRevisionStore`. Uses `KeyValueStore` (`namespace: "chainmcp_revisions"`) to persist revision history partitioned per contract (`contract:${tenantId}:${contractName}`) with atomic index tracking (`contracts_index`). Added test suite in `packages/admin/tests/storage-store.test.ts` covering restart survival with SQLite WAL mode and DeclarativeAdmin integration.
- `@chainmcp/config`: Added `StorageConfigSchema` (`driver: "memory" | "sqlite"`, `path?: string`, `busyTimeoutMs?: number`) and `createStorageDriverFromConfig()`. Added `storage` block to `ChainMcpConfigSchema` and `GatewayConfigSchema`. Updated `createHandleRegistryOptionsFromConfig` to forward `storageDriver`.
- `@chainmcp/cli`: Wired `createStorageDriverFromConfig` and storage driver initialization in `serve`, `dev`, and generated server templates (`templates.ts`). Added `@chainmcp/storage` to `CHAINMCP_PACKAGE_DEPENDENCIES` for `--local-deps` generated projects.

**Do**

- Wire `@chainmcp/storage` into `@chainmcp/json-navigation` result handle registry and navigation tools.
- Implement `StorageDescriptorRevisionStore` in `@chainmcp/admin` backed by `KeyValueStore`.
- Add `StorageConfigSchema` and driver instantiation helpers to `@chainmcp/config`.
- Wire storage initialization in CLI `serve`, `dev`, and generated server templates.
- Add comprehensive test coverage verifying restart survival in SQLite WAL mode, isolation, and backward compatibility.

**Acceptance**

- `pnpm check` passes with all quality gates green.
- `pnpm snapshot:check` verifies zero MCP tool declaration or schema drift.
- Revisions and result handles survive restarts when backed by SQLite WAL storage.

---

## Deferred — explicitly not part of this 1.0

Do not start these without a new decision and an ADR.

- **npm publishing, provenance, and registry smoke tests.** Complete (published at 0.3.0 with signed provenance across all 15 packages).
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
4. `pnpm docs:check` passes: every documented capability in `docs/capability-evidence.json` points to a real test file or exported API, and the README "## Core capabilities" bullets are covered. `README.md`, `CONFIGURATION.md`, `API_REFERENCE.md`, `docs/limitations.md`, and `CHANGELOG.md` are otherwise updated where behavior changed.
5. Compatibility impact is stated (breaking / additive / internal).
6. Actual command output is reported, not summarized.
7. Any deferred sub-item is written down in the Deferred section with a reason.

---

## Recommended order

`P0-1 → P0-2 → P0-3 → P0-4 → P0-5 → P0-6 → P0-7 → P0-8 → P1-1 → P1-3 → P1-4 → P1-5 → P1-2 → P1-6 → P2-0 → remaining P2 items`

P0-1 and P0-2 are the first true release blockers for a local-clone user; P0-3 through P0-7 close the integrity, secret, and safety gaps; P0-8 must be last so it describes the finished state. P2-0 came before the other P2 items because a CI that reports false failures cannot verify any of them.

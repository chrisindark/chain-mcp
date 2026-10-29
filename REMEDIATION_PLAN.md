# ChainMcp Remediation Plan

**Created:** 2026-10-26
**Baseline:** `0.1.0` monorepo, `pnpm check` green (exit 0) at time of audit.
**Source:** Read-only audit of `ROADMAP.md` claims against source, tests, docs, config, and CI.
**Purpose:** Machine-feedable, one-at-a-time work queue. Each milestone is independently implementable, testable, and verifiable.

---

## How to use this file

1. Pick **one** milestone only. Do not batch milestones, even when they touch the same files.
2. Respect the **Depends on** field. Do not start a milestone whose dependencies are incomplete.
3. Read the milestone's **Evidence** section first. Line numbers were accurate at audit time; confirm before editing.
4. Follow the repository rules in `AGENTS.md` (TypeScript strict ESM, no `any`, validate untrusted input, no credentials in generated artifacts, no fail-open caching, docs synchronization).
5. Implement **Required changes** exactly as scoped. If you believe a change needs to expand beyond scope, stop and record why in the milestone's **Notes** section instead of expanding silently.
6. Add or update the tests listed. Do not delete or weaken existing tests to make a change pass.
7. Update the documentation listed. `AGENTS.md` makes docs the product spec.
8. Run the milestone's **Validation** commands and paste the real output into your completion report.
9. Tick the checkbox in the index and append a one-line status to the milestone (date, commit, validation result).
10. Report: changed files, behavior implemented, tests executed, known limitations, next recommended milestone.

### Copy-paste task prompt

```
Implement milestone RM-XX from REMEDIATION_PLAN.md in this repository.
Scope: that milestone only. Do not start other milestones.
Follow AGENTS.md. Do not invent capabilities or weaken contracts.
Run the milestone's validation commands and report actual output.
If acceptance criteria cannot be met, stop and explain what blocked you
rather than marking it complete.
```

### Global guardrails

- Never disable a security check to make a test pass.
- Never add a config default that is less safe than the current behavior without an explicit migration note and a startup warning.
- Every new behavior that touches untrusted input (headers, URLs, bodies, specs) needs a negative test.
- Every public API change requires `API_REFERENCE.md`; every config change requires `CONFIGURATION.md`; every user-visible change requires `CHANGELOG.md`.
- Do not implement placeholders presented as production-ready. If a capability is deferred, it must be rejected or documented as unsupported — never silently accepted.

---

## Milestone index

| Done | ID    | Milestone                                                     | Priority | Area                 | Depends on  |
| ---- | ----- | ------------------------------------------------------------- | -------- | -------------------- | ----------- |
| [x]  | RM-01 | Fix inbound verifier prototype-chain auth bypass              | P0       | server/auth          | —           |
| [x]  | RM-02 | Enforce HTTP request size, Host, Origin, DNS-rebinding limits | P0       | server/transport     | —           |
| [x]  | RM-03 | Make HTTP inbound auth fail closed                            | P0       | server/cli           | RM-02       |
| [x]  | RM-04 | Replace origin reflection with configurable CORS allowlist    | P1       | server/transport     | RM-02       |
| [x]  | RM-05 | Reject or implement silently ignored OpenAPI constructs       | P1       | compiler             | —           |
| [x]  | RM-06 | Preserve upstream base URL scheme, port, and path prefix      | P1       | config/executor/cli  | —           |
| [x]  | RM-07 | Unify remote spec loading with SSRF-safe fetch policy         | P1       | cli                  | RM-06       |
| [x]  | RM-08 | Support code-first projects in `serve`, `build`, `export`     | P1       | cli                  | RM-07       |
| [x]  | RM-09 | Resolve or reject `mutualTLS` and `openIdConnect` schemes     | P1       | executor/compiler    | —           |
| [x]  | RM-10 | Bound serialization and add response-schema validation        | P1       | core/executor        | —           |
| [x]  | RM-11 | Support form, multipart, and cookie parameters                | P2       | compiler/executor    | RM-05       |
| [x]  | RM-12 | Classify non-removal contract changes as breaking in `diff`   | P1       | cli/compiler         | —           |
| [x]  | RM-13 | Remove implicit `"default"` tenant fallback                   | P1       | gateway/cli          | RM-01       |
| [x]  | RM-14 | Wire `ToolTracer` into runtime and server                     | P2       | core/server/config   | —           |
| [x]  | RM-15 | Wire Redis rate limiter through CLI and config                | P1       | config/cli           | —           |
| [ ]  | RM-16 | Harden Redis client: TLS, ACL, pooling, reconnect             | P2       | cache-redis          | RM-15       |
| [ ]  | RM-17 | Add secret interpolation and implement documented env vars    | P1       | config/cli           | —           |
| [ ]  | RM-18 | Stamp generated projects with the real CLI version            | P1       | cli/release          | —           |
| [ ]  | RM-19 | Fix changeset fixed group to cover all 13 packages            | P1       | release              | —           |
| [ ]  | RM-20 | Verify build manifest at runtime; add true clean-install e2e  | P1       | cli/server/ci        | RM-18       |
| [ ]  | RM-21 | Make HTTP shutdown actually graceful                          | P2       | server/cli           | RM-02       |
| [ ]  | RM-22 | Implement `tools/list` pagination                             | P2       | server               | —           |
| [ ]  | RM-23 | Connect JSON navigation tools to upstream result handles      | P2       | json-navigation/core | —           |
| [ ]  | RM-24 | Allow injecting an exact tokenizer                            | P2       | config/core          | —           |
| [ ]  | RM-25 | Documentation truth pass across all stale claims              | P1       | docs                 | RM-01…RM-24 |
| [ ]  | RM-26 | Correct risk register and add claim-drift guards              | P2       | docs/ci              | RM-25       |

**Recommended execution order:** RM-01 → RM-02 → RM-03 → RM-05 → RM-06 → RM-07 → RM-12 → RM-15 → RM-17 → RM-18 → RM-19 → RM-20 → RM-25 → then remaining P1s → then P2s → RM-26 last.

**Suggested waves**

- **Wave 1 — release blockers (security):** RM-01, RM-02, RM-03.
- **Wave 2 — correctness for real APIs:** RM-05, RM-06, RM-07, RM-08, RM-09, RM-12, RM-13.
- **Wave 3 — operability:** RM-15, RM-17, RM-18, RM-19, RM-20, RM-21.
- **Wave 4 — depth:** RM-04, RM-10, RM-11, RM-14, RM-16, RM-22, RM-23, RM-24.
- **Wave 5 — truth:** RM-25, RM-26 (must be last).

---

## Findings → milestone coverage map

Every audit finding must map to a milestone. If a finding is not covered, that is a bug in this plan.

| Audit finding                                                               | Milestone |
| --------------------------------------------------------------------------- | --------- |
| 1. Prototype-chain inbound auth bypass                                      | RM-01     |
| 2. No HTTP body size limit; no Host/Origin/DNS-rebinding protection         | RM-02     |
| 3. Inbound auth fail-open over HTTP                                         | RM-03     |
| 4. CORS reflects any origin; custom key header missing                      | RM-04     |
| 5. `servers`/`callbacks`/`style`/`explode`/`allowReserved` silently ignored | RM-05     |
| 6. Base URL scheme/port/path lost                                           | RM-06     |
| 7. Remote spec support inconsistent; duplicated unsafed `fetch`             | RM-07     |
| 8. `serve`/`build`/`export` require a contract                              | RM-08     |
| 9. `mutualTLS`/`openIdConnect` compile but cannot authenticate              | RM-09     |
| 10. No response validation; unbounded serialization; no input cap           | RM-10     |
| 11. JSON-only bodies; no cookie parameters                                  | RM-11     |
| 12. `diff` only treats removal as breaking                                  | RM-12     |
| 13. Gateway/CLI tenant fallback to `"default"`                              | RM-13     |
| 14. `ToolTracer` dead code                                                  | RM-14     |
| 15. Redis rate limiter unusable from CLI                                    | RM-15     |
| 16. Redis client ignores TLS/ACL, no pooling/reconnect                      | RM-16     |
| 17. Literal secrets only; documented env vars unimplemented                 | RM-17     |
| 18. Hardcoded `^0.1.0` / `"0.1.0"` in templates                             | RM-18     |
| 19. Changeset fixed group covers 8 of 13 packages                           | RM-19     |
| 20. Generated server ignores manifest; fake clean-install test              | RM-20     |
| 21. Shutdown kills in-flight calls                                          | RM-21     |
| 22. No `tools/list` pagination                                              | RM-22     |
| 23. JSON navigation not connected to tool results                           | RM-23     |
| 24. No exact tokenizer injection                                            | RM-24     |
| 25. All documentation drift                                                 | RM-25     |
| 26. Risk register false "Done" entries; no drift guard                      | RM-26     |

---

# Wave 1 — Release blockers

## RM-01 — Fix inbound verifier prototype-chain auth bypass

- **Priority:** P0 — release blocker
- **Depends on:** none
- **Blocks:** RM-13 (tenant fallback becomes exploitable without this fix)

### Evidence

`packages/server/src/verifier.ts:55`

```ts
if (options.tokens && token in options.tokens) {
  matched = options.tokens[token];
}
```

`packages/server/src/verifier.ts:117` uses the same pattern for `options.keys`.

The `in` operator walks the prototype chain. With any configured token map, these values all "match":

- `constructor`
- `toString`
- `valueOf`
- `__proto__`
- `hasOwnProperty`

The resolved value is a function or object, not an `InboundPrincipalConfig`, so the verifier returns an authenticated result with `tenantId: undefined`, `principalId: undefined`, and `scopes: []`.

Because scope authorization passes for operations with `requiredScopes: []`, and because `chainmcp serve` later defaults the tenant to `"default"`, this defeats `requireInboundAuth` for every unscoped tool.

Reproduced end-to-end with `Authorization: Bearer constructor`.

### Required changes

1. Replace both `in` checks with own-property semantics:
   - Use `Object.hasOwn(options.tokens, token)` (preferred), or convert the config maps to `Map` at construction time.
   - Do the same for `options.keys`.
2. After resolving `matched`, validate its shape before building the context:
   - `matched` must be a non-null object.
   - `matched.tenantId` must be a non-empty string.
   - `matched.principalId` must be a non-empty string.
   - `matched.scopes`, when present, must be an array of strings.
   - Return `undefined` (unauthenticated) if validation fails — never fabricate an empty principal.
3. Validate `verifyToken` / `verifyKey` results with the same guard. A custom callback returning a loosely typed object must not bypass the contract.
4. Reject empty and whitespace-only credentials before lookup (already partially done for bearer; confirm for API key).
5. Consider making `tenantId` required in `InboundPrincipalConfigSchema` (`packages/config/src/index.ts:121`) if it is currently optional, so the compiler enforces this rather than only the runtime.

### Tests

Add `packages/server/tests/verifier.test.ts` (new file):

- `Bearer constructor` → `verify()` returns `undefined`.
- `Bearer __proto__`, `Bearer toString`, `Bearer valueOf`, `Bearer hasOwnProperty` → `undefined`.
- Valid configured bearer token → authenticated with correct `tenantId`, `principalId`, `scopes`.
- Valid token with `scopes: undefined` → authenticated with `scopes: []`.
- Custom `verifyToken` returning `{}` → `undefined`.
- Custom `verifyToken` returning `{ principalId: "a" }` (no tenant) → `undefined`.
- API key verifier: same matrix against `x-api-key` and a custom header name.
- Case sensitivity: token lookup is exact, not case-folded.

Add an end-to-end assertion in `packages/server/tests/http.test.ts` or `packages/cli/tests/end-to-end.test.ts`:

- `Authorization: Bearer constructor` against a server with `requireInboundAuth: true` and one unscoped tool → HTTP 401, tool never executes.

### Documentation

- `SECURITY.md`: add a note that verifier maps are own-property keyed and that principals without a tenant are rejected.
- `docs/authentication.md`: document the required principal shape.
- `CHANGELOG.md`: security fix entry.

### Done when

- All new tests pass.
- `grep -n " in options\." packages/server/src/verifier.ts` returns nothing.
- `pnpm --filter @chainmcp/server test` passes.
- No behavior change for legitimate tokens.

### Validation

```bash
pnpm --filter @chainmcp/server test
pnpm --filter @chainmcp/server typecheck
pnpm --filter @chainmcp/config test
```

**Status:** Completed on 2026-10-27. Replaced `in` checks with `Object.hasOwn` in `packages/server/src/verifier.ts` and added strict `validatePrincipal` guard. 14 new verifier tests + 1 end-to-end HTTP prototype bypass rejection test added. Validation commands and `pnpm check` green.

---

## RM-02 — Enforce HTTP request size, Host, Origin, and DNS-rebinding limits

- **Priority:** P0 — release blocker
- **Depends on:** none
- **Blocks:** RM-03, RM-04, RM-21

### Evidence

`packages/server/src/http.ts:63`

```ts
const httpServer = http.createServer(async (req, res) => {
  try {
    // ... reads the entire body with `for await (const chunk of req)` before dispatch
```

There is no `Content-Length` check, no streaming cap, and no early `413`. A single client can allocate unbounded memory.

Missing transport protections, all supported by MCP SDK 2.3.1:

- `allowedHosts`
- `allowedOrigins`
- `enableDnsRebindingProtection` (SDK default is `false`)
- `maxRequestBodySize`

ChainMcp's `HttpServeOptions` (`packages/server/src/http.ts:11`) exposes none of them.

### Required changes

1. Add a hard request-body cap, enforced **before** buffering:
   - Reject with `413 Payload Too Large` when `Content-Length` exceeds the cap.
   - Abort the read and reject with `413` when the stream exceeds the cap without a valid `Content-Length`.
   - Cap must be configurable, defaulting to a safe value (align with `server.maxResponseBytes` naming; propose `server.maxRequestBytes`, default 1 MiB).
2. Wire SDK protections:
   - Pass `allowedHosts` derived from `server.host`, `server.port`, and an explicit allowlist.
   - Pass `allowedOrigins` from configuration (see RM-04).
   - Enable `enableDnsRebindingProtection` when an allowlist is configured.
   - Set `maxRequestBodySize` to the same cap.
   - Verify exact option names and placement against the installed SDK version before implementing; record the version in the milestone notes.
3. Reject malformed `Host` headers with `400`.
4. Add a request timeout (`server.requestTimeoutMs` exists in config but confirm it is applied to the HTTP server and to body reads).
5. Never echo request data in error bodies.

### Tests

Extend `packages/server/tests/http.test.ts`:

- Body exactly at the cap → accepted.
- Body at cap + 1 byte with `Content-Length` → `413`, server still healthy afterwards.
- Chunked body exceeding the cap without `Content-Length` → `413`, no unbounded buffering (assert via a large stream that aborts early).
- Missing `Host` → `400`.
- `Host` not in allowlist → `403`.
- `Origin` not in allowlist → `403` when protection enabled.
- Slow-body client → request timeout closes the connection.
- Server remains responsive after each rejection (follow-up request succeeds).

### Documentation

- `CONFIGURATION.md`: new `server.maxRequestBytes`, allowed hosts/origins keys.
- `API_REFERENCE.md`: `HttpServeOptions` fields.
- `docs/deployment.md`: reverse-proxy guidance and limits.
- `SECURITY.md`: DoS and DNS-rebinding posture.

### Done when

- No code path buffers an unbounded body.
- All new negative tests pass.
- Defaults are safe without configuration.

### Validation

```bash
pnpm --filter @chainmcp/server test
pnpm --filter @chainmcp/config test
```

**Status:** Completed on 2026-10-27. Added `maxRequestBytes` (1 MiB default), `allowedHosts`, `allowedOrigins`, `enableDnsRebindingProtection`, and `requestTimeoutMs` to `@chainmcp/config` and `@chainmcp/server`. Enforced pre-buffering `Content-Length` caps, streaming chunk aborts with 413, strict `Host` validation (400), DNS-rebinding allowlists (403), request timeouts (408), and MCP handler body limits without echoing input. 8 negative & boundary test cases added in `packages/server/tests/http.test.ts`. Validation commands and `pnpm check` passing.

---

## RM-03 — Make HTTP inbound auth fail closed

- **Priority:** P0 — release blocker
- **Depends on:** RM-02
- **Blocks:** none

### Evidence

- `packages/config/src/index.ts:376`: `requireInboundAuth: z.boolean().default(false)`.
- `packages/server/src/http.ts:51`: `const requireAuth = httpOptions.requireAuth ?? false;`
- `packages/server/src/http.ts:55-56`: the server is created and served regardless of whether a verifier or authorizer exists.

Result: `chainmcp serve --transport http` exposes every tool unauthenticated by default, with no warning. This contradicts the project's stated security posture and the "never bypass authorization" rule in `AGENTS.md`.

### Required changes

1. Decide and document the default for non-loopback binds:
   - Recommended: bind non-loopback with no auth → **refuse to start** unless `security.allowUnauthenticatedHttp: true` is explicitly set.
   - Loopback (`127.0.0.1`/`::1`) may keep the permissive default for local development, but must print a one-line warning.
2. Emit a structured startup warning whenever the server starts with `requireInboundAuth: false`, including host, port, tool count, and the exact config key to change.
3. If `requireInboundAuth: true` and no verifier is configured, fail fast with a clear error rather than rejecting every request at runtime.
4. If `auth.inbound.authorizer` is `scope` but no verifier exists, fail fast (`scope` authorization is meaningless without an authenticated principal).
5. Apply the same rules to generated servers (`packages/cli/src/templates.ts`) and the gateway (`packages/cli/src/commands/gateway-serve.ts`).
6. Log the resolved security posture once at startup (auth on/off, tenant mode, allowed hosts) so operators can see it.

### Tests

- Non-loopback host + no auth + no override → startup throws with a message naming the config key.
- Non-loopback host + `allowUnauthenticatedHttp: true` → starts and warns.
- Loopback + no auth → starts and warns.
- `requireInboundAuth: true` with no verifier → startup throws.
- `authorizer: scope` with no verifier → startup throws.
- Generated server and gateway follow the same matrix (CLI tests).

### Documentation

- `CONFIGURATION.md`: `security.requireInboundAuth`, `security.allowUnauthenticatedHttp`.
- `docs/deployment.md`: replace "stdio-only" framing; document the secure default.
- `docs/getting-started.md`: update the local-dev example with the warning behavior.
- `SECURITY.md`: document the threat model for unauthenticated HTTP.
- `CHANGELOG.md`: behavior change entry (this is a breaking default change).

### Done when

- No configuration can silently expose a network-reachable unauthenticated server.
- Warnings are deterministic and covered by tests.

### Validation

```bash
pnpm --filter @chainmcp/server test
pnpm --filter @chainmcp/cli test
```

**Status:** Completed on 2026-10-27. Added `allowUnauthenticatedHttp` (default `false`) to `SecurityConfigSchema` and `HttpServeOptions`. Enforced fail-closed behavior for non-loopback HTTP bindings refusing to bind without authentication unless override is set. Enforced immediate startup errors if `requireInboundAuth: true` or `authorizer: "scope"` is configured without a verifier. Added structured warnings for unauthenticated loopback/override servers and startup security posture logging. Added tests in `@chainmcp/server` (6 new tests) and `@chainmcp/cli` (8 new tests across `serve` and `gateway serve`). All checks passing.

---

## RM-04 — Replace CORS origin reflection with a configurable allowlist

- **Priority:** P1
- **Depends on:** RM-02

### Evidence

`packages/server/src/http.ts:71-80`

```ts
if (corsEnabled) {
  const origin = (req.headers.origin as string) || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, DELETE");
  res.setHeader("Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-API-Key, Accept, mcp-session-id, last-event-id");
```

Problems:

- Any origin is reflected, including `null` and attacker-controlled origins.
- No `Vary: Origin`.
- No `Access-Control-Allow-Credentials` decision is made explicitly.
- A custom API-key header name (supported by `ApiKeyVerifierOptions.headerName`) is never added to `Access-Control-Allow-Headers`.

### Required changes

1. Add `server.cors` configuration:
   ```yaml
   server:
     cors:
       enabled: true
       allowedOrigins: ["https://app.example.com"]
       allowedHeaders: [] # extra headers appended to defaults
       allowCredentials: false
       maxAgeSeconds: 600
   ```
2. Behavior:
   - `allowedOrigins: []` and `cors.enabled: false` → no CORS headers at all.
   - `allowedOrigins: ["*"]` → allow any origin, but never with `allowCredentials: true` (reject that combination at config parse time).
   - Otherwise → reflect only exact matches; otherwise omit the header and respond `403` to preflight.
3. Always set `Vary: Origin`.
4. Compute `Access-Control-Allow-Headers` from the actual configured verifier header names plus the defaults; never hardcode a list that can drift.
5. Keep CORS off by default for non-browser deployments, but preserve current behavior for loopback development with a warning.
6. Apply the same logic to the gateway HTTP surface.

### Tests

- Allowed origin → header present, `Vary: Origin` present.
- Disallowed origin → no allow-origin header; preflight `403`.
- `null` origin → rejected unless explicitly allowed.
- `*` + credentials → config parse error.
- Custom `x-tenant-key` verifier header → present in allow-headers.
- `cors.enabled: false` → no CORS headers, preflight not specially handled.

### Documentation

- `CONFIGURATION.md`: full CORS block.
- `docs/deployment.md`: browser-client guidance.
- `API_REFERENCE.md`: `HttpServeOptions.cors` shape.

### Done when

- No code path reflects an arbitrary origin.
- Tests cover the `*` + credentials rejection.

### Validation

```bash
pnpm --filter @chainmcp/server test
pnpm --filter @chainmcp/config test
```

**Status:** Completed on 2026-10-27. Replaced arbitrary CORS origin reflection with a configurable allowlist in `@chainmcp/config` (`server.cors`) and `@chainmcp/server`. Enforced parse-time and startup rejection of wildcard origin `*` when `allowCredentials: true`. Disallowed origins receive 403 Forbidden on preflights and no allow-origin headers on normal requests. Null origin is rejected unless explicitly declared in `allowedOrigins`. Responses attach `Vary: Origin` whenever CORS is active. Dynamic header derivation extracts inspected verifier headers (`InboundAuthVerifier.headerNames`), custom headers, and standard defaults for `Access-Control-Allow-Headers`. CORS is disabled by default for non-loopback bindings and warns on loopback with wildcard origin. 7 unit tests in `@chainmcp/config` and 7 end-to-end tests in `@chainmcp/server` added and passing; `pnpm check` clean.

---

## RM-05 — Reject or implement silently ignored OpenAPI constructs

- **Priority:** P1
- **Depends on:** none
- **Blocks:** RM-11

### Evidence

`packages/compiler/src/compile.ts:62-83` includes `servers` in `PATH_ITEM_KEYS` and both `servers` and `callbacks` in `OPERATION_KEYS`. They are accepted as valid but never used. Parameter `style`, `explode`, and `allowReserved` are likewise accepted without validation or effect.

This violates the repository rule to never silently weaken a contract. A user can ship a spec believing per-operation servers are honored and get calls routed to the wrong host.

### Required changes

1. Decide per construct, and encode the decision:
   - **`servers` (path item and operation):** implement, or reject with `UNSUPPORTED_SERVERS` in strict mode. Implementing is preferred (pairs with RM-06), but rejecting is acceptable for this milestone if RM-06 is not done.
   - **`callbacks`:** reject with `UNSUPPORTED_CALLBACKS`. Callbacks are inbound webhooks and are out of scope for a client-side gateway; silently ignoring them is the worst option.
   - **`style` / `explode` / `allowReserved`:** implement for `query` and `path` where they affect serialization, or reject non-default combinations with a diagnostic that names the parameter and the unsupported value.
2. Add strict validation of unknown parameter keys (currently only unknown _top-level_ keys are checked). If a parameter object contains a key the compiler does not understand, fail in strict mode.
3. Ensure diagnostics carry a stable `code`, the JSON Pointer location, and a remediation hint.
4. Distinguish `strict: true` (fail) from `strict: false` (warn loudly and record the downgrade in the manifest as a structured warning, not just console output).
5. Ensure warnings survive into `compiled-tools.json` / the manifest so consumers can see what was dropped.

### Tests

Extend `packages/compiler/tests/compile.test.ts`:

- Spec with operation-level `servers` + `strict: true` → diagnostic with `UNSUPPORTED_SERVERS` (or correctly compiled alternate base URL if implemented).
- Spec with `callbacks` → `UNSUPPORTED_CALLBACKS`.
- `style: "deepObject"`, `explode: false`, `allowReserved: true` → explicit diagnostic or correct wire output.
- Unknown parameter key → strict diagnostic.
- `strict: false` → same spec compiles with warnings visible in the manifest.
- No diagnostic is swallowed: assert on the returned diagnostics array, not console output.

### Documentation

- `docs/openapi-support.md`: authoritative supported/unsupported table, regenerated (this file is currently badly stale — coordinate with RM-25 but do not wait for it).
- `API_REFERENCE.md`: compiler diagnostic codes.
- `ROADMAP.md`: adjust the OpenAPI subset claim.

### Done when

- Every accepted-but-ignored construct is either implemented or rejected.
- The supported-construct table matches the diagnostics exactly.

### Validation

```bash
pnpm --filter @chainmcp/compiler test
pnpm --filter @chainmcp/compiler typecheck
```

**Status:** Completed on 2026-10-27. Implemented explicit compiler diagnostics for previously silently accepted OpenAPI constructs. Path-item and operation-level `servers` overrides are rejected in strict mode (`UNSUPPORTED_SERVERS`) or warned in permissive mode. Inbound `callbacks` are rejected in strict mode (`UNSUPPORTED_CALLBACKS`) or warned in permissive mode. Parameter `style`, `explode`, and `allowReserved` are strictly validated, rejecting non-default values in strict mode (`PARAMETER_UNSUPPORTED`, `PARAMETER_INVALID`) and warning in permissive mode while falling back to default wire serialization. Unknown parameter fields are rejected in strict mode (`PARAMETER_INVALID`) and warned in permissive mode, while extensions (`x-*`) remain permitted. Permissive mode warnings survive into `CompileManifest.warnings` and `CompiledOperation.warnings`, persisting into `compiled-tools.json` and `chainmcp.manifest.json`. 7 new unit tests in `packages/compiler/tests/compile.test.ts` added and passing; `pnpm check` clean.

---

# Wave 2 — Correctness for real APIs

## RM-06 — Preserve upstream base URL scheme, port, and path prefix

- **Priority:** P1
- **Depends on:** none
- **Blocks:** RM-07

### Evidence

- `packages/config/src/index.ts` has no `baseUrl` anywhere in `ChainMcpConfigSchema` (see `:387-403`).
- `packages/cli/src/templates.ts:226-228`:
  ```ts
  const primaryHost =
    config.security.allowedUpstreamHosts[0] ?? "api.example.com";
  const baseUrl = options?.baseUrl ?? `https://${primaryHost}`;
  ```
- `init` stores only the hostname, dropping scheme, port, and path.

Consequences:

- `http://localhost:8080` → becomes `https://localhost` (wrong scheme, wrong port).
- `https://api.example.com/v2` → becomes `https://api.example.com` (all calls 404).
- Non-443 ports and self-hosted gateways cannot be targeted at all.

`allowedUpstreamHosts[0]` is also the wrong source of truth: an allowlist's first entry is not necessarily the API origin.

### Required changes

1. Add `contract.baseUrl` (or top-level `upstream.baseUrl`) to `ChainMcpConfigSchema`:
   - Must be an absolute `http`/`https` URL.
   - Must not contain credentials (`user:pass@`).
   - Must not contain a query or fragment.
   - Normalize trailing slashes exactly once.
2. Derive `allowedUpstreamHosts` from the parsed `baseUrl` host **plus** explicit extras, rather than deriving the base URL from the allowlist.
3. `init` must record the full normalized origin including scheme, port, and path prefix.
4. `serve`, `build`, `export`, and the generated server template must read `baseUrl` from config. Remove the `https://${primaryHost}` synthesis entirely.
5. Per-operation server overrides (if RM-05 implements them) must resolve relative to `baseUrl`.
6. Add a validation error when a configured `baseUrl` host is not in `allowedUpstreamHosts` (and auto-insert it with a warning rather than silently failing at call time).
7. Add a migration note: existing configs without `baseUrl` keep current behavior but emit a deprecation warning naming the field.

### Tests

- `http://127.0.0.1:8080` round-trips exactly through `init` → config → executor request URL.
- `https://api.example.com/v2` produces `https://api.example.com/v2/pets`, not `https://api.example.com/pets`.
- Path prefix with trailing slash does not double up (`/v2/` + `/pets`).
- URL with embedded credentials → config parse error.
- URL with query/fragment → config parse error.
- `baseUrl` host added to allowlist automatically; an unrelated host remains blocked.
- Generated server template test asserts the emitted `baseUrl` literal.

### Documentation

- `CONFIGURATION.md`: `baseUrl` field, precedence, migration.
- `API_REFERENCE.md`: config type change.
- `docs/generated-servers.md`: how the base URL is resolved.
- `CHANGELOG.md`: behavior change.

### Done when

- No production code path constructs an upstream URL from `allowedUpstreamHosts[0]`.
- Round-trip tests cover all three URL components.

### Validation

```bash
pnpm --filter @chainmcp/config test
pnpm --filter @chainmcp/cli test
pnpm --filter @chainmcp/executor test
```

**Status:** Completed on 2026-10-27. Added `contract.baseUrl` and `BaseUrlSchema` to `@chainmcp/config` with strict validation (HTTP/HTTPS, no credentials, no query/fragment, canonical single-slash normalization). Added `security.allowInsecureHttp: false` across schemas and executor options. Auto-derived `baseUrl` host into `allowedUpstreamHosts` while preserving explicit extras. Updated `chainmcp init` to capture and record the full base URL including scheme, port, and path prefix into `chainmcp.config.yaml`, and set `allowInsecureHttp: true` when HTTP is used. Updated `serve`, `dev`, `export`, and `renderServerTs` to resolve `baseUrl` from config without synthesising `https://${allowedUpstreamHosts[0]}`. Added `validateCommand` diagnostics for undeclared base hosts, missing `contract.baseUrl` (`CONFIG_DEPRECATED`), and insecure HTTP without `allowInsecureHttp: true`. Updated `@chainmcp/executor` destination policy to allow loopback destinations when `allowInsecureHttp: true`. Added 11 unit tests in `@chainmcp/config`, 5 in `@chainmcp/cli`, and 3 in `@chainmcp/executor`. All validation commands, inspector conformance, and `pnpm check` clean.

---

## RM-07 — Unify remote spec loading with an SSRF-safe fetch policy

- **Priority:** P1
- **Depends on:** RM-06
- **Blocks:** RM-08

### Evidence

Remote fetching is duplicated in six commands, each with different rules:

| Command    | File                                                 | Behavior                            |
| ---------- | ---------------------------------------------------- | ----------------------------------- |
| `init`     | `packages/cli/src/commands/init.ts:164-187, 292-293` | raw `fetch`, allows `http://`       |
| `validate` | `packages/cli/src/commands/validate.ts:76-98`        | raw `fetch`, allows `http://`       |
| `build`    | `packages/cli/src/commands/build.ts:52-60`           | raw `fetch`, only `https://`        |
| `dev`      | `packages/cli/src/commands/dev.ts:86-98`             | raw `fetch`, allows `http://`       |
| `diff`     | `packages/cli/src/commands/diff.ts:68-73`            | raw `fetch`, allows `http://`       |
| `serve`    | `packages/cli/src/commands/serve.ts:42`              | `readFile` only — **fails on URLs** |
| `export`   | `packages/cli/src/commands/export.ts:82`             | `readFile` only — **fails on URLs** |

None of them enforce:

- a timeout
- a response size cap
- a redirect policy
- an SSRF guard (private IPs, loopback, link-local, metadata endpoints)
- a content-type check
- a consistent scheme policy

### Required changes

1. Create one shared module, `packages/cli/src/spec-loader.ts`:
   ```ts
   export interface LoadSpecOptions {
     source: string; // path or URL
     allowHttp?: boolean; // default false outside localhost
     timeoutMs?: number; // default 10_000
     maxBytes?: number; // default 10 MiB
     maxRedirects?: number; // default 3
     allowPrivateHosts?: boolean; // default false
     signal?: AbortSignal;
   }
   export interface LoadedSpec {
     content: string;
     sourceKind: "file" | "url";
     resolvedSource: string; // final URL after redirects
     bytes: number;
     contentType?: string;
   }
   export function loadSpec(options: LoadSpecOptions): Promise<LoadedSpec>;
   ```
2. Policy:
   - `https` only by default.
   - `http` allowed only for loopback/private hosts, and only when explicitly enabled.
   - Reject non-HTTP(S) schemes.
   - Block loopback, link-local, private ranges, and cloud metadata addresses for public URLs (SSRF).
   - Resolve DNS and re-check the resolved address (TOCTOU mitigation); document residual risk.
   - Manual redirect handling: re-validate every hop, cap at `maxRedirects`, reject HTTPS→HTTP downgrade.
   - Cap bytes while streaming; abort as soon as the cap is exceeded.
   - Accept `application/json`, `application/yaml`, `text/yaml`, `application/x-yaml`, `text/plain`; reject `text/html`.
3. Replace all six call sites with `loadSpec` and delete the duplicated fetch code.
4. Fix `serve` and `export` so a URL source works (they must use `loadSpec`, not `readFile`).
5. Ensure `build` does not re-fetch when `validate` already loaded the spec in the same process, or accept and document the double fetch. Prefer passing loaded content through.
6. Surface the resolved source and byte count in `--json` output for `validate`.

### Tests

Add `packages/cli/tests/spec-loader.test.ts`:

- `https` URL to a local test server → loads.
- `http` URL to loopback without opt-in → rejected with a clear error.
- `http` URL to loopback with opt-in → loads.
- Public URL resolving to `127.0.0.1` → blocked (SSRF).
- URL resolving to `169.254.169.254` → blocked.
- Response larger than cap → aborted, error names the cap.
- Redirect chain of 4 → rejected at `maxRedirects`.
- HTTPS → HTTP redirect → rejected.
- `text/html` response → rejected.
- Timeout → aborted within bounds.
- File path still loads and reports `sourceKind: "file"`.
- `serve` and `export` accept a URL spec (command-level tests).

### Documentation

- `CONFIGURATION.md` / `docs/troubleshooting.md`: remote spec policy and how to opt into `http`.
- `API_REFERENCE.md`: if `loadSpec` is exported.
- `SECURITY.md`: SSRF policy.
- `docs/getting-started.md`: remote spec example.

### Done when

- `grep -rn "await fetch(" packages/cli/src` returns only the loader's own implementation.
- `serve` and `export` work with `https://` specs.

### Validation

```bash
pnpm --filter @chainmcp/cli test
pnpm --filter @chainmcp/cli typecheck
```

**Status:** Completed on 2026-10-27. Implemented unified `loadSpec` module in `packages/cli/src/spec-loader.ts` with strict SSRF-safe fetch policy. HTTPS is required by default, plain HTTP is restricted to loopback/private hosts when opted in via `--allow-http` or `security.allowInsecureHttp`, and rejected for public hosts. Public hostnames resolving to loopback or private ranges are blocked for SSRF protection; cloud metadata endpoints (`169.254.169.254`) are unconditionally blocked. Resolved DNS addresses are pinned to the socket via `lookup` hook to mitigate DNS rebinding and TOCTOU attacks. Redirects are manually validated per hop, capped at `maxRedirects` (default 3), and HTTPS-to-HTTP downgrades are rejected. Content types are strictly checked, rejecting `text/html`. Responses are streamed with a hard byte cap (`maxBytes`, default 10 MiB) and timeouts (`timeoutMs`, default 10,000ms). Eliminated all raw `fetch` calls across `init`, `validate`, `build`, `diff`, `dev`, `serve`, and `export`, and enabled URL specification loading for `serve` and `export`. Added `--json` flag to `validate` exposing `resolvedSource` and `specBytes`. 13 dedicated unit tests added in `packages/cli/tests/spec-loader.test.ts`; all 67 CLI tests pass, inspector conformance passes, and workspace `pnpm check` passes clean.

---

## RM-08 — Support code-first projects in `serve`, `build`, and `export`

- **Priority:** P1
- **Depends on:** RM-07

### Evidence

- `packages/cli/src/commands/serve.ts:31` and `:42` require `validation.specPath` and then `readFile` it.
- `packages/cli/src/commands/export.ts:53` and `:82` do the same.
- `validateCommand` fails with `"No OpenAPI contract found"` when `config.contract` is absent, and `serve`/`build`/`export` all call it first.

Meanwhile:

- `chainmcp init` can generate a contract-free project with a blank `src/server.ts`.
- `chainmcp dev` runs code-first projects successfully.
- The generated server template itself supports contract-free mode (`packages/cli/src/templates.ts:211`, `if (effectiveContractPath)`).

So the tool creates a supported project shape that three of its own commands cannot run.

### Required changes

1. Make `validateCommand` contract-optional:
   - Contract present → compile and validate as today.
   - Contract absent → validate config, entrypoint existence, and imported tool modules; return `ok: true` with `contractKind: "code-first"`.
   - `--json` output must state which mode was validated.
2. `serve` behavior:
   - Contract present → current behavior.
   - Contract absent → locate the project's server entrypoint (config field if present, else `src/server.ts`) and run it in-process, or spawn it with a documented contract. Prefer in-process to keep signal handling and logging consistent.
   - Do not silently fall back to an empty tool set.
3. `build` behavior:
   - Contract absent → emit the portable manifest for code-first tools, or explicitly document that `build` requires a contract and exit with a message that says to use the generated server instead. Do not fail with the generic "No OpenAPI contract found" from deep inside validation.
4. `export` behavior:
   - Contract absent → export the code-first project (copy `src/`, config, lockfile guidance) rather than erroring.
5. Decide and document whether contract-free `serve` supports `--transport http`. It should, since the runtime is shared.
6. Add a `--require-contract` flag for users who want the old strict behavior.

### Tests

- `init` with no spec → `validate` succeeds and reports `code-first`.
- Same project → `serve` starts and lists the code-defined tools.
- Same project → `export` produces a runnable directory.
- Same project → `build` either succeeds with a manifest or fails with the documented, specific error.
- Contract project → all four commands unchanged (regression).
- `--require-contract` on a contract-free project → explicit failure.

### Documentation

- `docs/generated-servers.md`: code-first vs contract-first matrix per command.
- `docs/getting-started.md`: code-first quickstart.
- `API_REFERENCE.md`: `chainmcp serve`, `build`, `export`, `validate` flag and behavior tables.
- `ROADMAP.md`: correct the claim if any command still requires a contract.

### Done when

- No command fails on a project shape that `init` itself produces.
- The command capability matrix is documented and tested.

### Validation

```bash
pnpm --filter @chainmcp/cli test
pnpm --filter @chainmcp/cli typecheck
```

**Status:** Completed on 2026-10-28. Updated `validateCommand` to be contract-optional, validating configuration, entrypoint existence (`src/tools.ts`, `src/server.ts`), and discovered tool definitions, returning `contractKind: "code-first"` (or failing explicitly when `--require-contract` is set). Updated `serveCommand` to run code-first projects in-process over both stdio and HTTP transports using the shared `InMemoryToolRuntime`, failing fast if the tool set is empty. Updated `buildCommand` to produce deterministic code-first project manifests (`chainmcp.manifest.json`) and `compiled-tools.json`, supporting reproducibility verification via `--check`. Updated `exportCommand` to export standalone code-first projects, copying `src/`, generating contract-free configs and Dockerfiles, and emitting code-first manifests. Added `--require-contract` flag to CLI and command options. Added 12 dedicated unit tests in `packages/cli/tests/code-first.test.ts` covering validation modes, `--json` output, stdio/http serving, empty tool rejection, export, build, and `--require-contract` enforcement. All 79 CLI tests pass, inspector conformance passes, and monorepo checks pass clean.

---

## RM-09 — Resolve or reject `mutualTLS` and `openIdConnect` schemes

- **Priority:** P1
- **Depends on:** none

### Evidence

`packages/compiler/src/compile.ts` accepts `mutualTLS` and `openIdConnect` security schemes. `createUpstreamCredentialProviderFromConfig` (`packages/config/src/index.ts:657`) builds providers only for `static`, `env`, `secretStore`, and OAuth2 client-credentials paths. No executor path can supply a client certificate or an OIDC-discovered token.

Result: the spec compiles, `validate` passes, and every invocation fails at runtime with a credential-resolution error.

### Required changes

Choose one of two paths per scheme and document it:

**Option A — implement:**

- `mutualTLS`: add a credential provider that loads cert/key from `SecretStore` or file paths, and configure the transport agent per destination. Requires per-destination `https.Agent` support in the executor; verify the current single-agent assumption.
- `openIdConnect`: implement discovery (`/.well-known/openid-configuration`), token endpoint resolution, and client-credentials exchange with cached tokens respecting `expires_in`.

**Option B — reject at compile time (lower risk, recommended for this milestone):**

- Add `UNSUPPORTED_SECURITY_SCHEME` diagnostics for `mutualTLS` and `openIdConnect`.
- In `strict: false`, emit a warning and record the limitation in the manifest.
- Ensure `validate` surfaces the diagnostic.

Whichever path is chosen, do not leave a scheme compiled-but-unusable.

### Tests

- Spec with `mutualTLS` → compile diagnostic with the stable code (Option B), or a passing credential-provider test (Option A).
- Spec with `openIdConnect` → same.
- Spec with bearer/basic/apiKey/oauth2 → unaffected (regression).
- `strict: false` → warning appears in manifest.

### Documentation

- `docs/openapi-support.md`: security scheme support matrix.
- `docs/authentication.md`: what can and cannot be satisfied.
- `API_REFERENCE.md`: diagnostic codes.

### Done when

- `validate` cannot pass a spec whose security scheme is unsatisfiable.
- The support matrix matches the compiler.

### Validation

```bash
pnpm --filter @chainmcp/compiler test
pnpm --filter @chainmcp/executor test
```

**Status:** Completed on 2026-10-28. Implemented Option B compile-time rejection and warning diagnostics for unsatisfiable security schemes `mutualTLS` and `openIdConnect`. Added diagnostic code `UNSUPPORTED_SECURITY_SCHEME`. In strict mode (`strict: true`, default), specs declaring `mutualTLS` or `openIdConnect` schemes are rejected with an error diagnostic, causing compilation and `chainmcp validate` to fail. In permissive mode (`strict: false`), compilation succeeds with a structured warning preserved in `result.manifest.warnings`. Tested across compiler and CLI validate tests (5 new unit tests in compiler, 1 integration test in CLI commands); documentation updated in `API_REFERENCE.md`, `docs/openapi-support.md`, and `docs/authentication.md`. All tests pass cleanly.

---

## RM-10 — Bound serialization and add response-schema validation

- **Priority:** P1
- **Depends on:** none
- **Status:** Completed on 2026-10-28.
  - Implemented streaming bounded JSON serializer `stringifyBounded(value, options)` in `@chainmcp/core` with byte limit (`maxBytes`), depth limit (`maxDepth`), node limit (`maxNodes`), and circular reference tracking via identity set. Aborts immediately upon limit breach with `SerializationLimitError` without constructing full strings or reading subsequent properties (verified with Proxy getter traps).
  - Integrated bounded serialization across `@chainmcp/core` (`serializeOutput`, `measureTokens`, `applyOutputPolicy`), `@chainmcp/server` (`toolCallResult`), and `@chainmcp/json-navigation` (`assertResultBytes`).
  - Added input size cap: `InMemoryToolRuntime.callTool` runs `assertInputSize` during validation phase (after authorization) before schema validation runs, rejecting oversized inputs with stable `INPUT_TOO_LARGE` code, limit, and observed byte count.
  - Implemented response-schema validation in `@chainmcp/executor`: matches responses by exact status code, range (2XX), or fallback ("default"), and validates payload against compiled schema via `validateJsonSchema`. Modes: `"off"`, `"warn"` (default; logs warning and audit event with redacted payload), and `"enforce"` (fails closed with `UPSTREAM_FAILURE` without payload leakage).
  - Configured in `@chainmcp/config`: added `server.maxToolInputBytes` (default 1,048,576 bytes) and `server.validateResponses` (`off` | `warn` | `enforce`, default `"warn"`).
  - Comprehensive tests added across `@chainmcp/core`, `@chainmcp/executor`, and `@chainmcp/config`. Documentation synchronized in `CONFIGURATION.md`, `ARCHITECTURE.md`, `API_REFERENCE.md`, `docs/troubleshooting.md`, `ROADMAP.md`, and `CHANGELOG.md`.

`packages/core/src/index.ts:1287-1305`

```ts
function serializeOutput(toolName: string, value: unknown): string {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
```

The byte limit is applied **after** `JSON.stringify` completes, so a 500 MB upstream response is fully materialized before the size check rejects it. There is also no input-size cap anywhere in the runtime.

Separately, upstream responses are never validated against the OpenAPI response schema, so malformed or malicious upstream data flows directly to the model.

### Required changes

1. Introduce a bounded serializer:
   - Use a streaming JSON writer that aborts once `server.maxResponseBytes` would be exceeded.
   - Or, for the common case, pre-check cheap bounds and use a depth/node-limited stringifier with an abort callback.
   - Never construct the full string before deciding.
2. Add an input-size cap:
   - Reject oversized tool arguments before validation (`server.maxRequestBytes` or a dedicated `server.maxToolInputBytes`).
   - Return a stable `INPUT_TOO_LARGE` error with the limit and observed size.
3. Add response-schema validation:
   - Validate upstream JSON against the compiled response schema before projection.
   - Modes: `off`, `warn`, `enforce` (config `server.validateResponses`).
   - Default to `warn` for the first release, `enforce` documented as recommended.
   - Redact response bodies in errors.
4. Ensure the audit log records validation failures without leaking payloads.
5. Bound the projection pipeline (it must not materialize the full document before projection; verify against `packages/core` projection code).
6. Cap JSON navigation inputs/outputs consistently with RM-23.

### Tests

- 2× `maxResponseBytes` payload → rejected without allocating the full string (assert with a trap/proxy or a memory-safe sentinel).
- Exactly at the limit → accepted.
- Oversized input args → `INPUT_TOO_LARGE` before schema validation runs.
- Response violating schema in `warn` → result returned, warning event emitted, body redacted in logs.
- Response violating schema in `enforce` → stable error, no payload leakage.
- Valid response → unchanged (regression).
- Non-JSON response → existing behavior preserved and documented.

### Documentation

- `CONFIGURATION.md`: `server.maxResponseBytes`, `server.maxToolInputBytes`, `server.validateResponses`.
- `ARCHITECTURE.md`: serialization path and bounds.
- `docs/troubleshooting.md`: response-validation errors.
- `ROADMAP.md`: the M10 bounded-serialization criterion must reflect the actual implementation.
- `CHANGELOG.md`.

### Done when

- No code path stringifies an unbounded value.
- Response validation is configurable and covered by tests.

### Validation

```bash
pnpm --filter @chainmcp/core test
pnpm --filter @chainmcp/executor test
```

**Status (2026-10-28):** Complete. Implemented bounded JSON serialization, response schema validation with `warn` and `enforce` modes, input size caps, and error payload redaction in commit `7b0a13d`.

---

## RM-11 — Support form, multipart, and cookie parameters

- **Priority:** P2
- **Depends on:** RM-05
- **Status:** Complete (2026-10-28)

### Evidence

- The compiler rejects `cookie` parameters (`PARAMETER_LOCATIONS` at `packages/compiler/src/compile.ts:85` contains only `path`, `query`, `header`).
- Request bodies are JSON-only; `application/x-www-form-urlencoded` and `multipart/form-data` are not handled.
- The executor sets JSON content types unconditionally.

Many real OpenAPI specs use all three.

### Required changes

1. Compiler:
   - Add `cookie` to supported locations with explicit serialization rules.
   - Recognize `application/x-www-form-urlencoded` and `multipart/form-data` request bodies and emit a discriminated body descriptor.
   - Reject unsupported media types with a stable diagnostic rather than silently treating them as JSON.
2. Executor:
   - Encode `form-urlencoded` bodies with correct `style`/`explode` semantics.
   - Support `multipart/form-data` including file/binary fields, with a size cap per part and a total cap.
   - Send cookie parameters as a `Cookie` header, preserving explicit caller-supplied cookies only when policy allows.
   - Never allow cookie parameters to override transport-owned cookies.
3. Security:
   - `Cookie` remains in `FORBIDDEN_HEADER_PARAMETERS` for header parameters; cookie _parameters_ are a distinct, validated channel.
   - Reject CR/LF injection in names and values.
   - Do not log cookie values (ensure redaction covers them).
4. Keep JSON behavior unchanged.

### Tests

- `form-urlencoded` body with nested object + `explode: true/false` → exact wire bytes.
- `multipart/form-data` with text and binary parts → exact boundary and content types.
- Cookie parameter → correct `Cookie` header; no header-injection possible with `\r\n`.
- Unsupported media type → compile diagnostic.
- Oversized multipart part → rejected.
- Redaction test: cookie value never appears in logs.

### Documentation

- `docs/openapi-support.md`: media-type matrix.
- `CONFIGURATION.md`: multipart limits.
- `SECURITY.md`: cookie handling.

### Done when

- The media-type matrix is complete and tested.
- No new header-injection vector exists.

### Validation

```bash
pnpm --filter @chainmcp/compiler test
pnpm --filter @chainmcp/executor test
pnpm --filter @chainmcp/core test
```

**Status (2026-10-28):** Complete. Compiler and executor support `cookie` parameters with RFC 6265 token names and injection defenses, `application/x-www-form-urlencoded` with per-property `explode: true/false`, and `multipart/form-data` with text, binary base64 decode, JSON parts, and `maxMultipartPartBytes` / `maxRequestBytes` bounds. All tests passing.

---

## RM-12 — Classify non-removal contract changes as breaking in `diff`

- **Priority:** P1
- **Depends on:** none
- **Blocks:** none

### Evidence

`packages/cli/src/commands/diff.ts` treats only removed tools as breaking. A tool whose required fields grew, whose enum narrowed, whose type changed, or whose parameter became required is reported as non-breaking.

This makes `chainmcp diff --fail-on-breaking` unsafe as a CI gate: it passes changes that will break existing clients.

### Required changes

1. Define a breaking-change taxonomy and implement it:
   - **Breaking:** tool removed; tool renamed; new required input; input type narrowed; enum values removed; required response field removed; response type changed incompatibly; auth requirement added; server/base URL changed.
   - **Potentially breaking:** optional input became required; default changed; description-only changes are non-breaking.
   - **Non-breaking:** new optional input; new tool; new enum value on a request-only field; description changes.
2. Diff at the schema level, not just the tool list. Walk the compiled JSON Schema for inputs and outputs.
3. Support severity levels and `--fail-on` (`breaking` default, `breaking+potential`, `none`).
4. Emit machine-readable output (`--json`) with a stable shape: `{ breaking: [], potentiallyBreaking: [], nonBreaking: [] }`.
5. Add a `schemaVersion` to the diff output so consumers can rely on the shape.
6. Do not attempt semantic version inference from text; use structural comparison.

### Tests

- Tool removed → breaking.
- New required field → breaking.
- Optional field → required → potentially breaking.
- Enum value removed → breaking.
- Type widened/narrowed → breaking/potential per taxonomy.
- Description-only change → non-breaking.
- Auth requirement added → breaking.
- `--fail-on` exit codes for each level.
- `--json` shape snapshot.

### Documentation

- `API_REFERENCE.md`: `chainmcp diff` flags, output shape, taxonomy.
- `docs/migration-and-rollback.md`: using `diff` in CI.
- `CHANGELOG.md`.

### Done when

- Every taxonomy row has a test.
- `--fail-on-breaking` fails on a newly required field.

### Validation

```bash
pnpm --filter @chainmcp/cli test
pnpm --filter @chainmcp/compiler test
```

**Status (2026-10-28):** Complete. Implemented deep recursive schema diffing engine `diffContracts` in `@chainmcp/compiler` with the full breaking-change taxonomy across tools, inputs, constraints, authentication, base URLs, and response schemas. Updated CLI `chainmcp diff` with `--fail-on` (`breaking`, `breaking+potential`, `none`), `--fail-on-breaking`, and `--json` machine-readable output (`schemaVersion: 1`). Added unit tests for every taxonomy row and CLI integration tests for flags and exit codes. Documentation updated in `API_REFERENCE.md`, `docs/migration-and-rollback.md`, and `CHANGELOG.md`. All tests passing.

---

## RM-13 — Remove implicit `"default"` tenant fallback

- **Priority:** P1
- **Depends on:** RM-01

### Evidence

- `packages/cli/src/commands/serve.ts:155`: `(auth?.extra?.tenantId as string) ?? options.tenantId ?? "default"`
- `packages/cli/src/commands/gateway-serve.ts:195`: same fallback chain ending in `"default"`.
- `packages/cli/src/commands/dev.ts:187`: `options.tenantId ?? "default"`.
- `packages/cli/src/templates.ts:269`: same in the generated server.

Consequence: default-tenant contracts are reachable over unauthenticated stdio, and a caller that authenticates without a tenant claim silently lands in the default tenant.

### Required changes

1. Remove the `"default"` fallback. If no tenant can be resolved, fail the call with `TENANT_REQUIRED` (do not guess).
2. Keep an explicit escape hatch for development:
   - `--tenant <id>` on the CLI, and `tenant: string` in config, defaulting to **unset**.
   - When unset and no auth tenant is present, stdio serves only tenant-less/code-first tools, or refuses to start if gateway mode is active.
3. Gateway mode: require a tenant resolver. `gateway serve` without a verifier or explicit `--tenant` must refuse to start.
4. Multi-tenant path: cross-tenant lookups continue to fail closed as `TOOL_NOT_FOUND` (preserve existing behavior and its tests).
5. Emit an audit event when a tenant cannot be resolved.
6. Update generated server template identically, or it will reintroduce the fallback.

### Tests

- Authenticated principal without `tenantId` → `TENANT_REQUIRED`, tool not executed.
- No auth + no `--tenant` + gateway mode → startup error.
- Explicit `--tenant acme` → resolves correctly.
- Authenticated principal with `tenantId: acme` → wins over the CLI default (document precedence).
- Cross-tenant access → `TOOL_NOT_FOUND` (regression).
- Generated server text does not contain `?? "default"`.

### Documentation

- `docs/dynamic-gateway.md`: tenant resolution rules.
- `CONFIGURATION.md`: `tenant` field.
- `docs/authentication.md`: tenant claim expectations.
- `CHANGELOG.md`: breaking change note.

### Done when

- `grep -rn '"default"' packages/cli/src packages/gateway/src` returns no tenant fallback.
- All tenant tests pass.

### Validation

```bash
pnpm --filter @chainmcp/cli test
pnpm --filter @chainmcp/gateway test
```

**Status (2026-10-28):** Complete. Removed all implicit `"default"` tenant fallbacks across `@chainmcp/cli` (`serve.ts`, `gateway-serve.ts`, `dev.ts`, `templates.ts`) and `@chainmcp/gateway`. Introduced `TENANT_REQUIRED` runtime error code in `@chainmcp/core` and `@chainmcp/server`. Enforced multi-tenant `listTools` and `resolveTool` rejection when tenant ID is empty or whitespace. Added `--tenant <id>` CLI flag and `tenant: string` in `@chainmcp/config` defaulting to unset. Enforced dynamic gateway startup validation requiring inbound verifier (`auth.inbound`) or explicit tenant fallback (`--tenant` / `config.tenant`). Enforced authenticated principal tenant claim precedence over explicit default (`authTenant ?? explicitTenant`). Added `"tenant_resolution_failed"` audit event emission on DynamicGateway. Verified `grep -rn '"default"' packages/cli/src packages/gateway/src` returns zero matches. All tests passing.

---

## RM-14 — Wire `ToolTracer` into the runtime and server

- **Priority:** P2
- **Depends on:** none

### Evidence

`ToolTracer`, `startToolSpan`, and `endToolSpan` exist in `packages/core` but have zero call sites outside their own module. Only metrics are integrated (`RollingAnalyticsAggregator`, `OpenTelemetryMetricsSink`). Documentation claims OpenTelemetry tracing is supported.

### Required changes

1. Add tracing configuration:
   ```yaml
   analytics:
     openTelemetry:
       enabled: false
       serviceName: chainmcp
       tracing:
         enabled: false
         sampleRatio: 0.1
   ```
2. Wire spans around tool execution in the runtime:
   - Span name: `tool.<name>`.
   - Attributes: tool name, contract revision, tenant (hashed or allowed), outcome, duration, request ID, cached flag.
   - **Never** attach arguments, headers, or response bodies.
3. Propagate context through the executor and cache paths so nested spans (compile, upstream call, projection) are children rather than orphan roots.
4. Ensure spans end on error and on cancellation.
5. Export through the configured OTLP endpoint if one exists; otherwise document that spans are recorded locally and dropped.
6. If tracing cannot be delivered, remove the claim from the docs instead (coordinate with RM-25).

### Tests

- Enabled tracing → one span per tool call with the expected attributes.
- Disabled → no span.
- Error path → span marked error, no payload leakage.
- Cancellation → span ends, no leak.
- Attributes contain no secrets (assert against a redaction fixture).
- Child spans share the trace ID.

### Documentation

- `docs/analytics.md`: tracing vs metrics.

### Done when

- Tracing configuration is parsed and wired through `buildRuntimeOptions` and `DynamicGateway`.
- Spans named `tool.<name>` are created on tool calls with correlation attributes and no payload leaks.
- Child spans (`cache.read`, `upstream.call`, `projection`, `cache.write`) inherit parent trace context.
- Spans end on success, error, and cancellation.
- All tests pass.

### Validation

```bash
pnpm --filter @chainmcp/analytics test
pnpm --filter @chainmcp/core test
pnpm --filter @chainmcp/config test
pnpm --filter @chainmcp/gateway test
pnpm --filter @chainmcp/cli test
```

**Status (2026-10-29):** Complete. Wired `ToolTracer` into `@chainmcp/core` runtime, `@chainmcp/config` runtime options builder, `@chainmcp/gateway` dynamic runtime snapshotting, and `@chainmcp/cli` gateway-serve command. Added `analytics.openTelemetry.tracing` (`enabled`, `sampleRatio`) and `endpoint` to configuration schemas. Implemented root span `tool.<name>` with correlation attributes (`tool.name`, `mcp.tool_name`, `tenant.id`, `principal.id`, `mcp.request_id`, `contract.revision`, `outcome`, `duration_ms`, `cache.outcome`, `cached`) and child spans (`cache.read`, `upstream.call`, `projection`, `cache.write`) sharing trace context via OpenTelemetry `withSpan`. Enforced strict body/argument/header exclusion from traces and scrubbed secret tokens from error status messages. Handled cancellation cleanly with `outcome: "cancelled"`. Added unit and integration tests across core, analytics, and config. Synchronized `docs/analytics.md`, `CONFIGURATION.md`, `API_REFERENCE.md`, `ROADMAP.md`, and `CHANGELOG.md`.

- `CONFIGURATION.md`: tracing block.
- `ARCHITECTURE.md`: observability topology.
- `API_REFERENCE.md`: public tracer types.

### Done when

- Spans are emitted on real calls, not just constructible in tests.
- No sensitive attribute exists.

### Validation

```bash
pnpm --filter @chainmcp/core test
pnpm --filter @chainmcp/server test
```

---

# Wave 3 — Operability and release

## RM-15 — Wire the Redis rate limiter through the CLI and config

- **Priority:** P1
- **Depends on:** none
- **Blocks:** RM-16

### Evidence

`packages/config/src/index.ts:525-530`

```ts
if (config.provider === "redis") {
  if (!options?.redisClient) {
    throw new TypeError(
      "Distributed rate limiter requires a Redis client (options.redisClient)",
    );
  }
```

No CLI or config path constructs a `RedisRateLimitClient`. Compare `createCacheStoreFromConfig` (`:586-597`), which auto-creates a client from `config.redis.url` or `CHAINMCP_REDIS_URL`.

Result: setting `rateLimit.provider: redis` is a guaranteed runtime failure from every CLI command and generated server.

### Required changes

1. Make `createRateLimiterFromConfig` self-sufficient when `provider === "redis"`:
   - Use `options.redisClient` if provided.
   - Else use `options.redisUrl ?? config.redis.url ?? process.env.CHAINMCP_REDIS_URL`.
   - Else throw a message that names both the config key and the env var.
2. Reuse the same client instance as the cache when both are Redis-backed (avoid two connection sets).
3. Add `rateLimit.redis.url` to `RateLimitConfigSchema` if it does not exist; otherwise document that it reuses `cache.redis.url`.
4. Wire the factory into `packages/cli/src/commands/serve.ts`, `dev.ts`, `gateway-serve.ts`, and the generated server template.
5. Add connection health logging at startup: provider, reachability, key prefix, and quota summary (no secrets).
6. Ensure rate limiting is applied per tenant where configured, and that a Redis outage fails closed or open according to an explicit, documented policy.

### Tests

- `rateLimit.provider: redis` with URL in config → client constructed, no throw (integration test gated on `CHAINMCP_REDIS_URL`, skipped when absent).
- With `CHAINMCP_REDIS_URL` only → constructed.
- With neither → error message names both keys.
- Shared client: cache + rate limiter use the same instance.
- CLI `serve` with Redis rate limiting starts and enforces a quota (integration).

### Documentation

- `docs/rate-limiting.md`: Redis setup, required env, failure policy.
- `CONFIGURATION.md`: `rateLimit.redis`.
- `docs/deployment.md`: Redis topology.

### Done when

- `provider: redis` never throws from the CLI for lack of a client when a URL is configured.
- Failure policy is explicit and tested.

### Validation

```bash
pnpm --filter @chainmcp/config test
pnpm --filter @chainmcp/rate-limit test
pnpm --filter @chainmcp/cli test
```

**Status (2026-10-29):** Completed in RM-15. Redis rate limiter auto-constructs client from config URL or `CHAINMCP_REDIS_URL`, shares client instance with cache store, logs startup connection health, and enforces explicit failure policy (`fail-closed` by default, `fail-open` configurable). Validated with unit and CLI integration tests.

---

## RM-16 — Harden the Redis client (TLS, ACL, pooling, reconnect)

- **Priority:** P2
- **Depends on:** RM-15

### Evidence

`packages/cache-redis/src/client.ts`:

- Ignores `rediss://` — no TLS.
- Ignores the username component of the URL — no ACL support.
- Opens a new TCP connection per command — no pooling.
- No reconnect/backoff, no pipelining, no health checks.

This is not production-grade for a managed Redis (ElastiCache, Upstash, Redis Cloud) where TLS and ACL users are standard.

### Required changes

1. Parse `redis://` and `rediss://` fully:
   - `rediss` → `tls.connect` with sane defaults, optional CA/cert/key.
   - Username + password → `AUTH user pass`; password-only → `AUTH pass`; no credentials → no `AUTH`.
   - Non-default port, database index, and query parameters handled or explicitly rejected.
2. Add a small connection pool (default 2-4 sockets) with:
   - Lazy connect.
   - Health check on checkout.
   - Exponential backoff with jitter and a cap.
   - Per-command timeout (already partially present).
   - Graceful drain on shutdown.
3. Keep the `RedisCacheStore` and `DistributedRateLimiter` interfaces unchanged; this is an adapter-internal change.
4. Redact credentials in every error message and log line.
5. Document that `CHAINMCP_REDIS_URL` may contain credentials and must not be logged.

### Tests

- `rediss://` selects TLS (assert on the socket/options, mocked).
- Username/password → correct `AUTH` sequence.
- Pool reuses connections across sequential commands.
- Dropped connection → reconnect with backoff, command succeeds after recovery.
- Shutdown drains the pool.
- Error messages never contain the password (fixture assertion).

### Documentation

- `docs/caching.md` and `docs/rate-limiting.md`: URL formats and TLS.
- `CONFIGURATION.md`: TLS options.
- `SECURITY.md`: credential handling.

### Done when

- `rediss://` works against a TLS test server.
- No password appears in any error path.

### Validation

```bash
pnpm --filter @chainmcp/cache-redis test
pnpm --filter @chainmcp/rate-limit test
```

---

## RM-17 — Add secret interpolation and implement documented env vars

- **Priority:** P1
- **Depends on:** none

### Evidence

- Inbound tokens and API keys (`security.auth.inbound`) and OAuth `clientSecret` must be literal values in `chainmcp.config.yaml`.
- No env interpolation exists anywhere in config parsing.
- `CONFIGURATION.md` documents `CHAINMCP_UPSTREAM_TIMEOUT_MS` and `CHAINMCP_SECRET_PROVIDER`, neither of which is implemented.
- `CONFIGURATION.md` documents `CHAINMCP_DATABASE_URL` for a database that does not exist.

### Required changes

1. Implement `${VAR}` interpolation for string config values:
   - Syntax: `${VAR}` and `${VAR:-default}`.
   - Applied only to designated secret-bearing fields, not to arbitrary strings (avoid surprising URL mutation).
   - Missing variable with no default → startup error naming the field and variable.
   - Never log resolved values.
2. Alternatively (or additionally) support a `file:`/`env:` credential source in config, so `clientSecret: { env: "OAUTH_CLIENT_SECRET" }` is valid. Choose one design and document it; do not implement both silently.
3. Implement or remove the documented env vars:
   - `CHAINMCP_UPSTREAM_TIMEOUT_MS` → wire to executor timeout, or delete from docs.
   - `CHAINMCP_SECRET_PROVIDER` → wire to credential-provider selection, or delete.
   - `CHAINMCP_DATABASE_URL` → delete (no database exists in this architecture).
4. Add `chainmcp config explain` (or equivalent) that prints the resolved config with secrets redacted — useful for debugging without leaking.
5. Reject configs that contain obvious literal secrets in committed files? Do not add heuristics; instead document the recommended pattern and warn when a value matches a high-entropy pattern only if it is cheap and low-false-positive. Otherwise skip.

### Tests

- `${TOKEN}` resolves from env.
- `${TOKEN:-fallback}` uses fallback when unset.
- Missing `${TOKEN}` → startup error naming field + variable.
- Resolved value never appears in logs or `config explain` output.
- `file:`/`env:` credential source works end to end (if that design is chosen).
- Documented env vars either have a test or are absent from docs (assert docs mention only implemented keys — see RM-25).

### Documentation

- `CONFIGURATION.md`: interpolation syntax, supported fields, env var table with only implemented entries.
- `SECURITY.md`: secret handling guidance.
- `docs/authentication.md`: credential sources.

### Done when

- A user can keep secrets out of the config file.
- Docs list no unimplemented env var.

### Validation

```bash
pnpm --filter @chainmcp/config test
pnpm --filter @chainmcp/cli test
```

---

## RM-18 — Stamp generated projects with the real CLI version

- **Priority:** P1
- **Depends on:** none
- **Blocks:** RM-20

### Evidence

`packages/cli/src/templates.ts`:

- `:12` — `const versionSpec = isWorkspace ? "workspace:*" : "^0.1.0";`
- `:45` — `version: options.version ?? "0.1.0"`
- `:263` — `version: "0.1.0"`

Every generated project pins the first release. After a `0.2.0` or `1.0.0` release, generated projects install stale, incompatible packages — or fail to install at all once `0.1.0` is unpublished.

### Required changes

1. Read the CLI's own version at runtime from its `package.json` (bundled or imported), not a literal.
2. Use that version for:
   - generated `package.json` dependency specs (`^<version>`)
   - generated server `version` field
   - the manifest's `generator.version`
3. Preserve workspace mode for in-repo tests (`workspace:*`) via an explicit option, not by sniffing the filesystem heuristically.
4. Add a build-time assertion that no hardcoded semver literal remains in `templates.ts`.
5. Ensure the version is available in the published package (do not rely on a repo-relative path that does not exist after publish).

### Tests

- Generate a project with a stubbed version `9.9.9` → every emitted version field is `9.9.9`.
- Workspace mode still emits `workspace:*`.
- Snapshot the generated `package.json` to prevent accidental literal reintroduction.
- Published-package simulation: run the generator from a packed tarball and confirm the version resolves.

### Documentation

- `docs/generated-servers.md`: version pinning behavior.
- `RELEASES.md`: note that generated projects track the generator version.

### Done when

- `grep -n "0\.1\.0" packages/cli/src/templates.ts` returns nothing.
- Generated output tracks the CLI version.

### Validation

```bash
pnpm --filter @chainmcp/cli test
pnpm --filter @chainmcp/cli build
```

---

## RM-19 — Fix the changeset fixed group to cover all 13 packages

- **Priority:** P1
- **Depends on:** none

### Evidence

`.changeset/config.json` lists 8 packages in `fixed`:

```
@chainmcp/auth, @chainmcp/cache-redis, @chainmcp/compiler, @chainmcp/core,
@chainmcp/config, @chainmcp/executor, @chainmcp/rate-limit, @chainmcp/server
```

Missing: `@chainmcp/analytics`, `@chainmcp/authoring`, `@chainmcp/cli`, `@chainmcp/gateway`, `@chainmcp/json-navigation`.

`scripts/sync-version.mjs` requires all 13 to share one version. So `changeset version` can produce a state that `pnpm version:check` rejects — the release PR fails.

### Required changes

1. Add the five missing packages to the `fixed` group.
2. Confirm `ignore: []` is intentional.
3. Add a test or CI check that asserts the `fixed` group equals the workspace package set:
   - Read `pnpm-workspace.yaml` / `packages/*/package.json`.
   - Compare against `.changeset/config.json`.
   - Fail on drift.
4. Document the invariant in `RELEASES.md`: all public packages share one version.
5. Run a dry-run `changeset version` on a scratch copy and confirm `sync-version.mjs --check` passes.

### Tests

- New script `scripts/check-changeset-config.mjs` (or a node test) that fails when a package is missing from `fixed`.
- CI wiring in the existing check pipeline.

### Documentation

- `RELEASES.md`: versioning invariant.
- `CONTRIBUTING.md` (if it exists): changeset expectations.

### Done when

- `fixed` contains all 13 package names.
- The drift check runs in CI and fails on removal.

### Validation

```bash
node scripts/check-changeset-config.mjs
pnpm version:check
git diff --exit-code .changeset
```

---

## RM-20 — Verify the build manifest at runtime and add a true clean-install e2e

- **Priority:** P1
- **Depends on:** RM-18

### Evidence

- The generated server never reads `chainmcp.manifest.json` or `compiled-tools.json`; it recompiles the spec at startup (`packages/cli/src/templates.ts:211-245`). Artifacts can therefore drift from what was built, and nothing notices.
- `packages/cli/tests/end-to-end.test.ts` "clean installation" symlinks workspace `node_modules` instead of installing published packages, so packaging and version-pinning bugs are invisible.

### Required changes

1. Manifest verification at startup:
   - Read `chainmcp.manifest.json`.
   - Verify: schema version, generator version compatibility, spec hash, compiled revision, tool count, and per-tool schema hash.
   - Mismatch → fail fast with a clear error and a remediation hint (`rebuild`, `--allow-manifest-drift` for development).
2. Prefer loading `compiled-tools.json` over recompiling at startup:
   - Recompile only in `dev` mode or when explicitly requested.
   - This makes startup deterministic and fast, and makes the manifest meaningful.
3. Record in the manifest:
   - spec source (path or URL, with URL normalized and credential-free)
   - spec content hash
   - compiler version and diagnostic summary
   - generated-at timestamp (already present?)
   - package versions
4. Clean-install e2e:
   - `pnpm pack` each required package into a temp dir.
   - Generate a project pointing at the tarballs.
   - `pnpm install --offline` (or with a local registry) in a temp directory.
   - Start the server and call one tool.
   - Assert no workspace symlinks are used.
5. Add a negative test: tamper with `compiled-tools.json` → startup fails.

### Tests

- Manifest matches → starts.
- Spec changed after build → startup fails with a drift error.
- `compiled-tools.json` tampered → startup fails.
- `--allow-manifest-drift` → starts with a warning.
- Tarball install → server starts, tool call succeeds, no `workspace:` specifiers resolved.
- Manifest records the spec hash and compiler version.

### Documentation

- `docs/generated-servers.md`: build artifacts and verification.
- `docs/deployment.md`: artifact integrity in CI/CD.
- `API_REFERENCE.md`: manifest schema.

### Done when

- A stale artifact cannot start silently.
- The e2e test fails if a package is not publishable.

### Validation

```bash
pnpm --filter @chainmcp/cli test
pnpm check
```

---

## RM-21 — Make HTTP shutdown actually graceful

- **Priority:** P2
- **Depends on:** RM-02

### Evidence

`packages/server/src/http.ts` calls `closeAllConnections()` immediately on shutdown. `docs/deployment.md` claims "gracefully completes pending tool calls." In-flight requests are destroyed.

### Required changes

1. Shutdown sequence:
   - Stop accepting new connections (`server.close()`).
   - Stop accepting new requests on existing keep-alive connections.
   - Wait up to `server.shutdownTimeoutMs` (default 10 s) for in-flight requests.
   - Then force-close remaining connections.
2. Propagate the abort signal to in-flight tool executions so they can cancel cooperatively.
3. Return `503` with `Connection: close` for requests received after shutdown begins.
4. Ensure `SIGINT`/`SIGTERM` handling is idempotent and exits with the correct code.
5. Drain Redis/cache connections and flush analytics.
6. Document the exact semantics (drain vs. cancel).

### Tests

- In-flight slow tool + shutdown → request completes, then process exits.
- Request arriving after shutdown starts → `503`.
- Hung tool exceeding the timeout → forced close, documented exit code.
- Double `SIGTERM` → idempotent.
- Cache/Redis drained once.

### Documentation

- `docs/deployment.md`: replace the false claim with the real sequence and timeout.
- `CONFIGURATION.md`: `server.shutdownTimeoutMs`.

### Done when

- The documented behavior matches the observed behavior under test.

### Validation

```bash
pnpm --filter @chainmcp/server test
```

---

## RM-22 — Implement `tools/list` pagination

- **Priority:** P2
- **Depends on:** none

### Evidence

`packages/server/src/index.ts:231` states the handler "answers once with no `nextCursor`." Docs mention pagination. Gateway and large contracts can exceed client limits.

### Required changes

1. Add `server.toolsPageSize` (default e.g. 100, `0` = unlimited).
2. Implement cursor-based pagination:
   - Opaque, stable cursor encoding (e.g. base64 of last tool name + revision).
   - Deterministic ordering (sorted by name) so cursors remain valid.
   - Reject unknown/expired cursors with a stable error.
3. Invalidate cursors when the tools list changes (or encode the revision and reject stale cursors).
4. Ensure `listChanged` notifications and pagination interact correctly.
5. Paginate `tools/list` only; do not paginate per-call responses.

### Tests

- 250 tools, page size 100 → 3 pages, no duplicates, no omissions.
- Cursor from a previous revision → stable error.
- Page size 0 → single page (backward compatible).
- Tool added between pages → documented behavior (recommend: stale cursor error, not silent skew).

### Documentation

- `API_REFERENCE.md`: pagination semantics and config key.
- `docs/concepts.md` / `docs/generated-servers.md`: large-contract guidance.

### Done when

- A client can enumerate 1,000 tools without truncation.

### Validation

```bash
pnpm --filter @chainmcp/server test
```

---

## RM-23 — Connect JSON navigation tools to upstream result handles

- **Priority:** P2
- **Depends on:** none

### Evidence

The JSON navigation tools accept a `json` argument containing the full payload. They are not wired to upstream tool results, so a model must paste a potentially huge document back into a tool call — exactly the token cost the feature exists to avoid. Limits exist (`maxResultBytes`, `maxVisitedNodes`) but the integration does not.

### Required changes

1. Introduce a result handle registry:
   - When a tool result exceeds a threshold, store it (bounded TTL, bounded total bytes, per-tenant isolation) and return a handle (`chainmcp://result/<id>`) plus a compact summary.
   - Handles are opaque, unguessable, and scoped to the tenant/principal that produced them.
2. Extend navigation tools to accept `handle` **or** inline `json`:
   - `handle` preferred; `json` kept for compatibility.
   - Reject handles from a different tenant.
3. Bound the registry: max entries, max bytes, TTL, LRU eviction. Never persist to disk by default.
4. Ensure eviction is observable (stable error `RESULT_HANDLE_EXPIRED`).
5. Apply the same limits as the inline path (`maxDepth`, `maxArrayItems`, `maxResultBytes`).
6. Redact handles from logs.

### Tests

- Large result → handle returned, payload not inlined.
- Navigation by handle → same output as inline `json`.
- Cross-tenant handle → rejected.
- Expired/evicted handle → `RESULT_HANDLE_EXPIRED`.
- Registry respects max bytes and evicts LRU.
- Inline `json` still works (regression).

### Documentation

- `docs/json-navigation.md`: handle workflow and limits.
- `CONFIGURATION.md`: registry bounds.
- `SECURITY.md`: handle scoping.

### Done when

- A model can inspect a large result without re-sending it.

### Validation

```bash
pnpm --filter @chainmcp/json-navigation test
pnpm --filter @chainmcp/core test
```

---

## RM-24 — Allow injecting an exact tokenizer

- **Priority:** P2
- **Depends on:** none

### Evidence

`packages/config/src/index.ts:607-622`: `createTokenizerFromConfig` always returns an estimate (`measurement: "estimate"`, `ceil(text.length / charactersPerToken)`). `TokenMetricsConfigSchema.tokenizer` accepts only `"approximate" | "none"`. There is no way to supply a real tokenizer, so `output.maxTokens` enforcement is approximate in every CLI deployment.

### Required changes

1. Extend the tokenizer contract:
   - Add `"exact"` as a provider option.
   - Add a registration hook: `setTokenizerFactory(fn)` or `tokenMetrics.tokenizerModule` (a module specifier) so deployments can inject one.
2. Keep the default as `"approximate"` and keep `measurement` honest. Never label an estimate as exact.
3. When `"exact"` is requested but no factory is registered → fail fast at startup with a clear error. Do not silently fall back to approximate.
4. Ensure the injected tokenizer is used consistently by:
   - output budgeting
   - token metrics
   - analytics aggregation
5. Document the accuracy implications and the `measurement` field.

### Tests

- `approximate` → labeled `estimate`, existing counts unchanged.
- `exact` with a registered factory → labeled `exact`, uses the factory.
- `exact` without a factory → startup error.
- Budget enforcement uses the same tokenizer instance as metrics.
- A tokenizer that throws → stable error, no crash loop.

### Documentation

- `docs/token-accounting.md`: measurement modes and accuracy.
- `CONFIGURATION.md`: `tokenMetrics` fields.
- `API_REFERENCE.md`: tokenizer interface.

### Done when

- An operator can guarantee exact counts, and the label always reflects reality.

### Validation

```bash
pnpm --filter @chainmcp/config test
pnpm --filter @chainmcp/core test
pnpm --filter @chainmcp/analytics test
```

---

# Wave 4 — Documentation truth

## RM-25 — Documentation truth pass across all stale claims

- **Priority:** P1
- **Depends on:** RM-01 … RM-24 (run after code changes settle)

### Evidence

Documentation is the product spec in this repository, and multiple files assert behavior that does not exist. Full inventory:

| File                             | Location                     | False or stale claim                                                                 | Reality                                                                |
| -------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| `ROADMAP.md`                     | M2 section                   | Remote transport auth not implemented                                                | Implemented in `serveHttp` + verifier                                  |
| `ARCHITECTURE.md`                | `:336`                       | HTTP/remote auth not implemented                                                     | Implemented                                                            |
| `API_REFERENCE.md`               | `:1527`                      | HTTP/remote auth not implemented                                                     | Implemented                                                            |
| `API_REFERENCE.md`               | `:605`, `:775`, `:779`       | Compiler not CLI-wired; credentials/auth not implemented                             | Both wired                                                             |
| `API_REFERENCE.md`               | `:1477`                      | `listChanged: false`                                                                 | Multi-tenant path defaults `true` (`packages/server/src/index.ts:240`) |
| `API_REFERENCE.md`               | throughout                   | Missing `serveHttp`, verifiers, `chainmcp diff`, `gateway serve`, `--transport http` | All exist                                                              |
| `docs/openapi-support.md`        | whole file, dated 2026-10-21 | Credentials/CLI/auth unimplemented; stale subset table                               | Needs regeneration                                                     |
| `docs/getting-started.md`        | auth section                 | Auth policies not enforced                                                           | Executor enforces                                                      |
| `CONFIGURATION.md`               | config reference             | Omits `cache`, `tokenMetrics`, `projection`, HTTP `auth.inbound`, gateway config     | All exist                                                              |
| `docs/authentication.md`         | whole file                   | Omits inbound HTTP verifiers                                                         | `createBearerTokenVerifier`, `createApiKeyVerifier` exist              |
| `docs/deployment.md`             | whole file                   | Stdio-only; omits gateway/HTTP                                                       | Both supported; also claims graceful shutdown (RM-21)                  |
| `docs/supported-versions.md`     | matrix                       | MCP `2024-11-05` only                                                                | SDK supports through `2025-11-25`; Node 20 is EOL, not "Active LTS"    |
| `docs/troubleshooting.md`        | `:14`                        | `file:///Users/...` absolute link                                                    | Must be a relative link                                                |
| `docs/troubleshooting.md`        | validation section           | References Ajv                                                                       | Custom validator used                                                  |
| `docs/troubleshooting.md`        | limits section               | `security.maxResponseBytes`                                                          | Actual key is `server.maxResponseBytes`                                |
| `docs/troubleshooting.md`        | timeouts                     | Per-operation timeout overrides                                                      | Not supported                                                          |
| `docs/migration-and-rollback.md` | `:84`                        | `file:///Users/...` absolute link                                                    | Must be a relative link                                                |
| `examples/README.md`             | list                         | Omits `examples/gateway`                                                             | Directory exists                                                       |

### Required changes

1. Work file by file. For each claim, verify against current source before editing; do not copy this table blindly if code changed.
2. Rewrite `docs/openapi-support.md` as a generated-or-verified matrix:
   - security schemes
   - parameter locations and styles
   - media types
   - unsupported constructs and their diagnostics
   - response validation mode
3. Regenerate `CONFIGURATION.md` from `ChainMcpConfigSchema` so it cannot omit keys. Add a test or script that fails when a schema key is undocumented (see RM-26).
4. Regenerate `API_REFERENCE.md` coverage: every exported symbol and CLI command must appear. Add a check.
5. Fix all `file:///Users/...` links to repository-relative paths.
6. Correct the MCP protocol matrix and Node support claim; align with the installed SDK's `SUPPORTED_PROTOCOL_VERSIONS` and the actual Node engine range.
7. `docs/deployment.md`: document HTTP, gateway, shutdown semantics, and the secure-by-default behavior from RM-03.
8. `docs/authentication.md`: add inbound verifiers and tenant requirements.
9. `examples/README.md`: list every example, with a one-line purpose.
10. Add a "Docs status" date line to each rewritten file so staleness is visible.

### Tests / checks

- Link checker for local links and `file:///` rejection.
- Config-key coverage check (schema keys ⊆ `CONFIGURATION.md` headings).
- CLI command coverage check (every `chainmcp <cmd>` in `cli.ts` appears in `API_REFERENCE.md`).
- Exported-symbol coverage check (best-effort; can be a curated allowlist).
- Markdown lint/format via existing Prettier run.

### Documentation

This milestone **is** documentation. Also update `docs/README.md` index and `CHANGELOG.md`.

### Done when

- Every row in the evidence table is corrected.
- The three coverage checks pass in CI.
- No `file:///Users/` string exists in the repository.

### Validation

```bash
pnpm format:check
node scripts/check-docs.mjs        # new, from this milestone
grep -rn "file:///Users/" . --exclude-dir=node_modules --exclude-dir=.git
```

---

## RM-26 — Correct the risk register and add claim-drift guards

- **Priority:** P2
- **Depends on:** RM-25

### Evidence

`docs/risk-register.md` marks as "Done" five items that are not implemented:

| ID       | Claim                          | Reality                            |
| -------- | ------------------------------ | ---------------------------------- |
| `GEN-03` | Per-operation server URLs done | Ignored by compiler (RM-05)        |
| `RUN-03` | Retries/circuit breakers done  | Deferred; no implementation        |
| `RUN-04` | Orphan cleanup done            | Roadmap defers it                  |
| `ENT-04` | Pluggable storage done         | Gateway registry is in-memory only |
| `GEN-07` | Deterministic AST codegen done | No AST codegen exists              |

Combined with stale roadmap checkboxes, a reader cannot tell what is actually implemented.

### Required changes

1. Re-audit every risk-register row against source. Mark each:
   - `Done` — with a code path and test reference.
   - `Partial` — with the specific gap and the milestone that closes it.
   - `Deferred` — with the roadmap milestone that owns it.
   - `Not planned` — with rationale.
2. Add columns: `Evidence` (file/test link), `Verified on` (date), `Owner milestone`.
3. Reconcile `ROADMAP.md` checkboxes with the same audit. A checked box must have a test reference.
4. Add a guard script:
   - For each `Done` row, require a non-empty `Evidence` field pointing at an existing file path.
   - Fail CI if the path does not exist.
   - Fail if a checked roadmap item has no evidence link.
5. Remove or clearly label aspirational text in `RELEASES.md` / `README.md` that claims 1.0 readiness while the version is `0.1.0` and P0 items are open.

### Tests

- New script `scripts/check-claims.mjs`:
  - Parses the risk register table.
  - Verifies every `Done` row has an existing evidence path.
  - Verifies roadmap checkboxes carry evidence.
- CI wiring alongside `version:check`.

### Documentation

- `docs/risk-register.md`: rewritten.
- `ROADMAP.md`: corrected checkboxes.
- `RELEASES.md`, `README.md`: status honesty.
- `CHANGELOG.md`.

### Done when

- No `Done` claim lacks a code reference.
- The guard runs in CI and fails on a broken reference.

### Validation

```bash
node scripts/check-claims.mjs
pnpm check
```

---

## Cross-cutting definition of done

A milestone is complete only when all of the following are true:

1. Implementation is present and matches the scope above.
2. New tests exist for the positive case, the negative case, and the security-relevant boundary.
3. `pnpm check` passes from the repository root (format, lint, rules, build, typecheck, tests, version check, SBOM check).
4. Documentation listed in the milestone is updated, and `CONFIGURATION.md` / `API_REFERENCE.md` reflect any new public surface.
5. Compatibility impact is stated: breaking, additive, or internal.
6. Actual command output is reported — not a summary claim.
7. Any deferred sub-item is written down with a reason, not silently dropped.

---

## Known limitations that no milestone here fixes

These are real gaps but out of scope for this plan. They should be tracked explicitly so they are not mistaken for solved:

- No persistence for gateway contract revisions (restart loses history).
- No distributed cache coordination beyond Redis primitives.
- No hosted control plane (intentionally out of scope per `AGENTS.md`).
- No OAuth authorization-server implementation (only client credentials for upstream).
- Approximate token counting remains the default even after RM-24 (by design).

---

## Progress log

Append one line per completed milestone: `RM-XX — <date> — <commit> — <validation result>`.

```

```

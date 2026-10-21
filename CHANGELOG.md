# Changelog

All notable project changes are recorded here.

The project is pre-release. Versions and release dates must reflect actual published artifacts.

## Unreleased

### Documentation

- Define product vision and package boundaries.
- Specify generated-server and dynamic-gateway modes.
- Define configuration and public interface contracts.
- Document security requirements and release gates.
- Establish coding-agent workflow and roadmap milestones.
- Add explicit production logging requirements to Milestone 6.
- Document timeout and cancellation as cooperative `AbortSignal` propagation, with executor responsibility for resource release.
- Record ADRs 0001–0009 and maintain an ADR index with current statuses.
- Document the implemented Milestone 1 `RuntimeEvent` shape and mark `cache_hit`, `tokenCount`, `attributes`, and optional event fields as Milestone 4/6 targets rather than current behavior.
- Document authorization and rate-limit adapter contracts, including the distinction between policy denial and adapter failure.
- Record ADR 0008, the MCP authorization mapping (tenant-bound registration, tenancy modes, identity-scoped listing), and document the tenant-bound runtime groundwork in `API_REFERENCE.md` and `ARCHITECTURE.md`.
- Document the `@chainmcp/auth` package and its `OperationScopeAuthorizer` default, including the exact-match scope semantics and the protected-diagnostics cause contract.
- Document the first Milestone 3 compiler slice, its supported/rejected OpenAPI surface, deterministic manifest hashes, and its metadata-only boundary in `API_REFERENCE.md`, `ARCHITECTURE.md`, `docs/openapi-support.md`, and ADR 0015.
- Document response metadata mapping and object `allOf` flattening, including the unvalidated status of response schemas and the remaining input union-composition limits, in `API_REFERENCE.md`, `ARCHITECTURE.md`, `docs/openapi-support.md`, and ADR 0016.
- Document explicit OR/AND authentication policy mapping, anonymous alternatives, scope validation, and the unenforced boundary in `API_REFERENCE.md`, `ARCHITECTURE.md`, `docs/openapi-support.md`, and ADR 0017.
- Document the upstream executor, request/response mapping, destination policy, cancellation binding, and remaining credential/validation limits in `API_REFERENCE.md`, `ARCHITECTURE.md`, `SECURITY.md`, `docs/openapi-support.md`, `docs/generated-servers.md`, and ADR 0018.
- Document the `chainmcp/no-blocking-io` lint rule and its runtime-source scope in `DEVELOPMENT.md`.

### Implementation

- Add a pnpm workspace with strict TypeScript, lint/format, test, typecheck, build, and CI configuration.
- Add `@chainmcp/core` with registration, discovery, supported-subset input validation, authorization/rate-limit hooks, timeout/cancellation handling, metrics, and deterministic identity-partitioned cache-key serialization.
- Add `@chainmcp/config` with strict Zod validation and defaults for the implemented configuration subset.
- Wrap unexpected execution failures in a stable, safe runtime error and keep metrics delivery from delaying tool results.
- Fix input validation to enforce array-valued (`type: [...]`) declarations and object/array keywords in schemas that omit `type`; empty or malformed type declarations now fail closed.
- Reject unsupported validation keywords and schema forms at tool registration with `CONTRACT_INVALID` instead of silently skipping them. Bound schema nesting to 32 levels, reject cyclic schemas, and cap validation depth so hostile input cannot surface as `UPSTREAM_FAILURE`.
- Export `auditInputSchema` and its diagnostic types from `@chainmcp/core` so the compiler can apply the same supported-schema rules at compile time.
- Hash cache keys with SHA-256 under a versioned namespace, bound canonical input to 64 KiB, and omit `undefined` object properties.
- Add a bounded process-local LRU cache with entry-count, retained-byte, per-entry, and TTL limits. Require hashed cache keys, reject callable `toJSON` values so serialization cannot escape the value bounds, and clone cached JSON values.
- Version cache keys to v2 and include a required non-secret authorization partition alongside tenant, principal, contract, tool, and canonical arguments. Identity fields that are blank after trimming are rejected.
- Integrate caching into invocation for tools that opt in with `ToolDefinition.cache` and a runtime store. Cache reads run after authorization, validation, and rate limiting; misses execute and store successful results with the tool TTL, while key, partition, read, and write failures bypass caching without failing the call.
- Report `cacheOutcome` (`hit`, `miss`, or `bypass`) on invocation events and add exact-match `invalidateCachedResult` for trusted operator code. Hashed keys still cannot be invalidated by prefix or tenant.
- Add a synchronous `Tokenizer` adapter interface and record exact or estimated token counts plus serialized payload bytes on successful invocation events. No tokenizer is bundled, measurement failures never change results, and cache hits are measured too.
- Add per-tool output projection and token budgets: `output` opts a tool into a deployment-supplied `ResultProjector`, and `output.maxTokens` rejects over-budget results before they are cached or returned. Projection must produce JSON, failures never fall back to the raw result, and cached entries contain only projected output. New error codes are `OUTPUT_POLICY_VIOLATION` and `OUTPUT_LIMIT_EXCEEDED`.
- Add `createFieldProjector()` and `output.fields` for bounded declarative include/exclude projection. Paths traverse arrays element-wise, reject prototype-sensitive segments, enforce depth/node/path limits, and never mutate the source result.
- Add `@chainmcp/cache-redis`, an optional shared `CacheStore` adapter with validated hashed keys and JSON values, bounded entry size, TTL, and per-command latency. It accepts a narrow client wrapper rather than bundling a Redis SDK.
- Classify invocation failures by stage. Untyped authorizer failures now fail closed as `AUTH_FORBIDDEN` with a safe message and retain their cause instead of surfacing as `UPSTREAM_FAILURE`.
- Replace the throwing `RateLimiter.check` contract with an explicit `RateLimitDecision`. Only `{ allowed: false }` produces `RATE_LIMITED` and the `rate_limited` metrics outcome; limiter failures, missing decisions, and a thrown `RATE_LIMITED` code become `UPSTREAM_FAILURE`.
- Preserve typed authorization failures so operators can distinguish policy denial from adapter infrastructure failure.
- Compare object keys as own properties during validation. `additionalProperties: false` now rejects undeclared keys named after `Object.prototype` members such as `toString` or `__proto__`, and `required` is no longer satisfied by an inherited name.
- Cap reported validation issues at 20 per call and append a truncation marker, so a large invalid input can no longer inflate the client-facing `INPUT_INVALID` message.
- Reject non-finite `enum` entries such as `NaN` and `Infinity` at registration. They cannot appear in JSON, and the type check rejects non-finite numbers before the enum comparison, so such an entry could never match.
- Measure `RuntimeEvent.durationMs` with a monotonic `performance.now` clock (`RuntimeOptions.monotonicNow`) instead of the wall clock, so system clock adjustments cannot distort or invert a duration. `RuntimeOptions.now` now only supplies the event `timestamp`; both clocks remain injectable for deterministic tests. See `docs/adr/0007-wall-clock-and-monotonic-duration.md`.
- Add publish metadata (`license`, `repository`, `publishConfig.access`) to `@chainmcp/core` and `@chainmcp/config` so the scoped packages can be published publicly.
- Add release and commit tooling: Conventional Commit enforcement (`commitlint`), staged-file formatting and linting (`lint-staged`), a `pre-commit` typecheck, Husky hooks, and Changesets with a fixed `@chainmcp/core`/`@chainmcp/config`/`@chainmcp/server` group and a root version-sync check.
- Add `@chainmcp/auth` with `OperationScopeAuthorizer`, the ADR 0008 default authorizer: it denies with `AUTH_FORBIDDEN` unless every `operation.requiredScopes` entry is present in `principal.scopes` (exact token match, no wildcards; missing/empty requirements impose none), retains the ungranted requirements only as a protected diagnostic cause, and denies malformed definitions or principal data instead of failing open. Tenant matches stay structural in the runtime, so composing the scope authorizer cannot weaken tenant isolation. Composition tests demonstrate scope enforcement, safe metrics, and authorization ordering in a multi-tenant runtime; dependency boundaries, version sync, and the changeset fixed group extended to the new package.
- Add `@chainmcp/server` with official MCP SDK tool listing and invocation, safe runtime error mapping, a serialized response byte cap, local stdio serving, and idempotent connection shutdown.
- Change pre-1.0 context factories to receive MCP request metadata; run context resolution inside runtime accounting and map failures to `AUTH_FORBIDDEN` with metrics.
- Wire stdio EOF, abort, SIGINT, and SIGTERM to shutdown; expose transport closure and make concurrent close calls await completion. Add lifecycle regression tests.
- Require an exact non-null object root for MCP tool schemas, explain the audited SDK schema conversion, and test validation parity, cancellation, non-JSON results, timeouts, connection failure, and stdio lifecycle.
- Add tenant-bound registration and tenancy modes to `@chainmcp/core` (ADR 0008). A single-tenant runtime may pin `RuntimeOptions.tenantId`, stamps tools without `ownerTenantId` with the pin, rejects foreign bindings with `CONFIG_INVALID`, and denies cross-tenant callers with `AUTH_FORBIDDEN` before adapters run. A multi-tenant runtime requires an authorizer at construction, requires a non-empty `ownerTenantId` per tool, allows repeated tool names across tenants, scopes tool resolution and per-call listing to the caller's tenant, and rejects cross-tenant tools with `TOOL_NOT_FOUND` (no metrics event), keeping cross-tenant calls indistinguishable from unknown tools. `listTools` without a caller context is `AUTH_REQUIRED`. Milestone 2 single-tenant behavior without a pin is unchanged. The `@chainmcp/server` safe-error mapping covers the new `CONFIG_INVALID` and `AUTH_REQUIRED` codes.
- Adopt identity-filtered listing in `@chainmcp/server` (ADR 0008). A multi-tenant runtime is now adapted through low-level per-request `tools/list` and `tools/call` handlers instead of failing closed: per-request identity is established via `createContext`, listing is scoped to the caller's tenant against the same registry `callTool` resolves against, listing failures that cannot establish identity fail closed with a safe protocol error, and serialization, response byte caps, and safe error mapping are shared with the snapshot path so both modes cannot drift. Single-tenant snapshot behavior, including all Milestone 2 exit criteria, is unchanged, and cross-tenant calls remain indistinguishable from unknown tools at the MCP surface.
- Declare `tenantMode` on the `ToolRuntime` interface and dispatch the MCP adapter on that declaration instead of on `InMemoryToolRuntime`. A custom multi-tenant runtime can no longer be mistaken for a single-tenant one and listed without a caller context; a server regression test exercises a non-`InMemoryToolRuntime` implementation.
- Preserve typed `RuntimeError`s thrown by context factories. Untyped identity-resolution failures still fail closed as `AUTH_FORBIDDEN`, but an identity-provider outage now keeps `UPSTREAM_FAILURE`, so operators can distinguish it from a policy denial in metrics (ADR 0006, ADR 0008).
- Map `RuntimeErrorCode` to client-safe messages through an exhaustive `Record`, making a newly added code a compile error, and bound `maxResponseBytes` to 100 MB to match the configuration limit.
- Set `license: "UNLICENSED"` in every workspace package, replacing the invalid `TODO` placeholder that would fail publish validation. Choosing and documenting a real license remains an open Milestone 0 item.
- Build before `typecheck` and `test` in `pnpm check`. Cross-package imports resolve through each package's built `dist`, so the previous order only passed when stale artifacts happened to exist and failed on a clean checkout.
- Add `chainmcp/no-blocking-io`, a custom ESLint rule that rejects synchronous `fs` and `child_process` APIs on runtime source paths, including aliased/namespace imports, `require`, and dynamic import. RuleTester coverage runs through `pnpm test:rules` in `pnpm check`.
- Add `@chainmcp/compiler` with the first Milestone 3 slice: bounded YAML/JSON parsing, OpenAPI 3.0/3.1 structural validation, local `$ref` resolution with cycle/depth limits, deterministic operation enumeration and tool names, object-root input schemas from path/query/header parameters and JSON request bodies, 3.0 `nullable` translation, `readOnly` input filtering, `auditInputSchema` enforcement, security OR/AND metadata, and deterministic source/contract/toolset hashes with `diffManifests()`. It emits metadata only; executors and authentication enforcement remain open.
- Map declared OpenAPI responses into deterministic metadata with status keys, descriptions, selected media types, and translated schemas. Response schemas resolve local `$ref`s, drop `writeOnly` fields, preserve composition, and are explicitly not applied as output validation. Flatten object `allOf` intersections for inputs, rejecting incompatible properties, non-object members, and sibling validation keywords. Include responses in per-tool hashes.
- Derive `CompiledOperation.authentication` as explicit OR alternatives and AND scheme sets with credential metadata and sorted, deduplicated scopes. Preserve anonymous alternatives, reject scopes on non-OAuth/OIDC schemes, and diagnose undeclared OAuth2 scopes. Include authentication details in per-tool hashes. Policies are metadata only; no credentials are resolved or enforced.
- Add the compiler package to the fixed release group and root version-sync check.
- Record sorted path/query/header parameter bindings and JSON request-body media metadata on `CompiledOperation`, include them in per-tool hashes, and reject transport/credential headers such as `Content-Type` and `User-Agent` as tool inputs.
- Add `@chainmcp/executor` with `createUpstreamExecutor()`: compile output becomes runnable tools with bounded path/query/header/JSON-body mapping; exact host allowlists; HTTPS by default; fixed protocol/port; same-host redirect revalidation; rejection of any loopback, private, shared, link-local, metadata, multicast, documentation, or reserved DNS answer; pinned lookups with peer verification; no proxy environment or connection reuse; compression refusal; URL/header/request/response/redirect/time caps; and `context.signal`/total-timeout binding. It does not inject credentials, enforce authentication, validate response schemas, or retry.

### Breaking changes

- `RateLimiter.check` now returns `RateLimitDecision` (`{ allowed: boolean }`) instead of `Promise<void>`. Throwing `RuntimeError("RATE_LIMITED")` no longer denies a call; it is treated as a limiter failure. The package is pre-1.0, so this change is recorded rather than deprecated. See `docs/adr/0006-stage-aware-policy-errors.md`.
- `RuntimeOptions.now` no longer measures `durationMs`; it only supplies the event `timestamp`. Inject `RuntimeOptions.monotonicNow` to control durations. The package is pre-1.0, so this change is recorded rather than deprecated.
- `ToolRuntime.listTools` accepts an optional `ToolContext`, and `RuntimeErrorCode` gained `CONFIG_INVALID` and `AUTH_REQUIRED`. `ToolDefinition` gained optional `ownerTenantId`. Existing single-tenant call sites are unaffected. See `docs/adr/0008-mcp-authorization-mapping.md`.
- `ToolRuntime` now requires a `tenantMode` declaration so adapters can select the listing strategy without depending on a concrete class. Custom runtime implementations must add the field; the package is pre-1.0, so this change is recorded rather than deprecated.

### Limitations

- No OpenAPI response-schema validation, CLI, gateway, credential provider, authentication enforcement, generated-server wiring, or concrete cache/auth/rate-limit adapter is included.
- `@chainmcp/compiler` output is operation metadata; `@chainmcp/executor` turns it into runnable tools. Response schemas and authentication policies are not enforced, input `oneOf`/`anyOf`/`not` composition is rejected, remote references and format/numeric/string constraint enforcement remain unsupported, and authentication plus Inspector conformance remain Milestone 3/5 work.
- The core input validator supports only the subset documented in `API_REFERENCE.md`.
- License selection remains unresolved; the existing `LICENSE` file is empty.

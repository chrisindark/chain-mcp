# Limitations

This page is the single catalog of what ChainMcp does **not** do. It consolidates
the per-package limitation notes so operators can assess fit before adopting a
version, and so reviewers can tell a deliberate boundary from a missing feature.

Treat this page as authoritative for the current tree: if a capability is not
described here or in the package documentation, do not assume it exists. Each
entry states whether it is **by design**, **deferred**, or a **known gap** that
should be closed before the related surface is described as production ready.

## Release posture

ChainMcp is still **pre-1.0**: every workspace package and the private root are
on the same pre-1.0 version. Milestones 0–9 in `ROADMAP.md` are implemented and
covered by tests, and Milestone 10 release tooling (supported-version matrix,
SBOM, migration/rollback docs, signed-release workflow) is in place, but no
`1.0.0` artifact has been published. A 1.0 release is intentionally withheld
until the project has broader test coverage and has been exercised in a real
production deployment. `RELEASES.md` records the remaining gates.

Compatibility: while pre-1.0, breaking changes to public APIs and configuration
are permitted. Pin exact versions and read `CHANGELOG.md` before upgrading.

## Product scope

These are deliberate boundaries, not defects:

- **Not an agent framework.** ChainMcp never prompts a model or chooses tools;
  it is the execution and policy layer beneath an MCP client.
- **No hosted control plane.** There is no SaaS dashboard, usage metering, or
  audit UI. The only operator surface is the self-hosted declarative admin
  server, which starts programmatically.
- **No approval gates.** Sensitive calls can only be gated by client-side
  confirmation and by not exposing destructive tools. Human-in-the-loop
  approval is deferred (`ENT-02` in `docs/risk-register.md`).
- **Stateless invocations.** No conversational or intermediate state is stored
  between tool calls; state lives in the calling agent.
- **MCP-facing payloads are JSON.** No file-upload, binary streaming, or media
  transfer surface is exposed to clients.
- **Private destinations are blocked by default.** Loopback, RFC1918, shared
  (CGNAT), link-local, multicast, documentation, reserved, and cloud metadata
  ranges are refused even with `allowInsecureHttp`, so localhost development
  requires an injected transport.

## OpenAPI compiler (`@chainmcp/compiler`)

- **Unsupported schema constructs are rejected, never approximated:** `oneOf`,
  `anyOf`, `not`, `if`/`then`/`else`, dependent schemas, pattern properties,
  schema-valued `additionalProperties`, tuple or boolean `items`, `const`,
  remote `$ref`s, and YAML merge keys. They fail in strict and permissive modes.
- **`allOf` supports object intersections only.** Members that are
  non-object, incompatible, or carry sibling validation keywords are rejected.
- **`contentEncoding`, `contentMediaType`, and unknown keywords** are strict-mode
  errors; permissive mode drops only annotations that cannot weaken validation.
- **Formats are asserted only for** `date-time`, `date`, `time`, `email`,
  `hostname`, `ipv4`, `ipv6`, `uri`, and `uuid`. Other `format` strings remain
  annotations and validate nothing.
- **`pattern` uses the linear-time `re2js` engine** with a 4,096-character cap,
  so PCRE-only syntax (lookaround, backreferences) is rejected.
- **Parameter serialization is narrow:** query supports only `style: form` with
  `explode: true`; path and header support only `style: simple` with
  `explode: false`. Other styles, `allowReserved`, and `allowEmptyValue` are
  rejected in strict mode.
- **No per-operation or path-item `servers` overrides.** All operations execute
  against the single configured `baseUrl`; overrides are rejected (strict) or
  warned (permissive).
- **Callbacks are not supported** and are rejected in strict mode.
- **Response mapping is metadata only.** Status keys, descriptions, media type,
  and translated schemas are recorded, but response `headers` and `links` are
  not mapped, and the compiler itself does not generate an output validator.
- **Authentication policies are mapped but not enforced by the compiler.**
  Enforcement and credential injection happen at runtime in `@chainmcp/executor`.
- **No compile-time I/O.** The compiler never fetches remote documents and does
  not read the filesystem; input is handed in by the caller.
- **No regeneration command owned by the compiler.** Manifest diffing exists,
  but reading and writing manifests is the CLI's job.

## Upstream executor (`@chainmcp/executor`)

- **No retries, backoff, circuit breakers, or health checks.** Failures surface
  immediately; retry policy belongs to the caller or deployment.
- **No streaming, binary bodies, or compression.** Non-JSON media types and any
  `content-encoding` other than `identity` are rejected, and only 2xx responses
  are accepted. Error response bodies are never surfaced to callers.
- **No proxy environment support and no connection reuse.** Both are trade-offs
  of DNS pinning and peer verification; a pooled connection could outlive the
  pinned address.
- **Cross-host redirects are always rejected**, even when both hosts appear in
  the allowlist.
- **Default caps:** 1 MiB response body (10 MiB maximum), 3 redirects (5
  maximum), 15 s timeout (120 s maximum), and 16 KiB of response headers.
- **Custom `UpstreamTransport` is trusted adapter code.** The executor rechecks
  status, size, and JSON shape, but cannot prove an injected transport connected
  to the pinned address.
- **DNS resolution is not cancellable at the OS level.** An abort stops waiting
  and aborts the request, but the resolver promise may settle later.

## Runtime, caching, projection, and token accounting

- **Token counts are estimates by default.** The built-in tokenizer divides
  characters by `charactersPerToken` (default 4) and always reports
  `measurement: "estimate"`. Exact counts require an injected `Tokenizer`; no
  model-specific tokenizer is bundled.
- **No async or remote tokenizers, no per-content-block measurement, and no
  aggregated token exporter.** Aggregation is left to the deployment.
- **Field projection supports include/exclude paths only.** No renames,
  computed fields, or array-index selection.
- **Serialization is not shared.** Projection, measurement, and transport each
  serialize independently, which costs CPU on large payloads.
- **Cache backends are in-memory and Redis only.** No other shared store, no
  bulk or predicate invalidation, and no request coalescing.
- **Caching is read-only and stores projected results.** Changing a projection
  policy requires manual namespace or revision rotation to avoid serving stale
  shapes.
- **Writes are never cached by default**; a tool must opt in with
  `ToolDefinition.cache`.

## Authentication and secrets (`@chainmcp/auth`)

- **Upstream OAuth supports the client-credentials grant only.** Authorization
  code, refresh tokens, token introspection, and OIDC discovery are not
  implemented. The client-credentials grant issues no refresh token, so expiry
  means re-acquiring a token.
- **Cross-process token revocation is limited.** `SecretStore` has no scan
  operation, so `invalidate()` only clears entries the instance knows about;
  other processes depend on token expiry or manual key deletion.
- **`mutualTLS` and `openIdConnect` security schemes are unsupported** —
  rejected in strict mode, warned in permissive mode.
- **No authorization server.** Inbound verification only; ChainMcp never issues
  tokens or runs an OIDC provider.
- **Secret storage is local encryption.** `EncryptedSecretStore` is AES-256-GCM
  with key rotation support but no KMS or HSM integration, so key custody is the
  deployment's responsibility.
- **Inbound verifiers are limited** to static bearer tokens, API keys, and
  HS256/RS256/ES256 JWTs. There is no built-in SSO or external authorization
  adapter, though custom verifiers can be injected.
- **The standalone OAuth token fetcher cannot pin the resolved address**; only
  token requests issued from inside the executor get DNS pinning.

## Server and dynamic gateway

- **MCP pagination is not implemented.** Every `tools/list` responds in one page
  with no `nextCursor`.
- **Gateway contract revisions are in memory.** A restart drops published
  revisions unless the deployment republishes them; there is no database-backed
  contract registry.
- **Publishing replaces a contract's toolset** rather than merging sources.
- **Multi-tenant mode requires resolvable tenant context.** Without an inbound
  verifier or an explicit tenant fallback the gateway refuses to start, and a
  caller with no resolvable tenant fails closed with `TENANT_REQUIRED`.
- **Stdio transport has no remote authentication** — it inherits the trust of
  the process that spawned it. HTTP inbound authentication is enforced.

## Declarative tools and admin (post-1.0 surface)

- **Descriptor version 1 is JSON-only** for request bodies and responses, and
  has per-tool (not per-document) revisions.
- **No database adapter for descriptor revisions.** Defaults are in-memory and a
  single-writer JSON file; there is no cross-process writer lock and no
  retention pruning.
- **`DeclarativeAdmin.restore()` must run at startup** after the gateway is
  constructed. Deployments that skip it serve only what the current process
  published.
- **A crash between gateway publish and record activation** leaves live tools
  with a `candidate` record until the next publish or restart.
- **Preview is static.** Descriptors are validated and rendered but never
  invoked, so preview cannot confirm upstream behavior.
- **Publishing is not rate-limited** by the admin package. Body and descriptor
  limits are size caps, not quotas.
- **No CLI entry point for the admin surface**; it starts programmatically and
  has no hosted UI beyond the bundled console.

## Rate limiting (`@chainmcp/rate-limit`)

- **In-memory windows are LRU-evicted** (default 10,000 tracked windows), so an
  evicted identity can make one extra request after its budget resets.
- **Concurrency denials report a conservative one-second lower bound** rather
  than the exact release time.
- **Distributed limiting requires Redis with `EVAL` support.** Deployment can
  choose `fail-closed` (default) or `fail-open` during a Redis outage; the
  latter loses strict quota enforcement while the backend is unavailable.

## Observability (`@chainmcp/analytics`)

- **OpenTelemetry API only.** No exporter, collector, Prometheus endpoint, or
  dashboard is bundled; the deployment wires its own.
- **No aggregated token or cache-hit exporters**, and no retention policy beyond
  the configured sinks.
- **Request and response bodies are excluded from logs by default**, which is
  intentional redaction but limits payload-level debugging.
- **Admin audit events do not yet flow into the gateway audit stream** (tracked
  as an ADR 0029 follow-up).

## Platform and packaging

- **Node.js 20.11+ (20 and 22 LTS) only.** See `docs/supported-versions.md`.
- **Linux and macOS are the supported operating systems.** Windows is neither
  tested nor listed as supported.
- **PostgreSQL is not implemented.** It appears as intended architecture in the
  product notes, but no metadata-store adapter exists in `packages/`.
- **No hosted or container-managed cleanup.** Orphaned process and container
  cleanup, and multi-OS CI matrices, remain release-hardening work.

## Where to read more

| Area                | Document                              |
| ------------------- | ------------------------------------- |
| OpenAPI subset      | `docs/openapi-support.md`             |
| Authentication      | `docs/authentication.md`              |
| Caching             | `docs/caching.md`                     |
| Token accounting    | `docs/token-accounting.md`            |
| Rate limiting       | `docs/rate-limiting.md`               |
| Declarative tools   | `docs/declarative-tools.md`           |
| Declarative admin   | `docs/declarative-admin.md`           |
| Deployment          | `docs/deployment.md`                  |
| Supported versions  | `docs/supported-versions.md`          |
| Risks and deferrals | `docs/risk-register.md`, `ROADMAP.md` |
| Release gates       | `RELEASES.md`                         |

# Security Policy

## Project status

ChainMcp must be treated as an early-stage project until its runtime, network controls, authentication, and security tests are complete.

## Assets to protect

- Upstream API credentials and refresh tokens.
- User and tenant data.
- API responses and cached values.
- Contract definitions and tool metadata.
- Identity and authorization policies.
- Availability and infrastructure resources.

## Threat model

The implementation must address:

1. Server-side request forgery through malicious API contracts or URLs.
2. DNS rebinding and unsafe redirects.
3. Cross-tenant or cross-principal cache leakage.
4. Credential exposure in logs, errors, traces, and generated code.
5. Unauthorized upstream operations.
6. Malicious or oversized contracts, arguments, and responses.
7. Prompt injection contained in tool names, descriptions, or API data.
8. Resource exhaustion through concurrent requests or expensive JSON traversal.
9. Unsafe retries of payment, deletion, or other non-idempotent operations.
10. Unauthenticated access to remote MCP endpoints.

## Mandatory controls

### Network security

- Require explicit upstream host policies in hosted deployments.
- Block loopback, private, link-local, multicast, and cloud metadata destinations unless a deliberate local-development policy allows them.
- Resolve and validate destination addresses before connecting.
- Revalidate redirects and prevent policy bypass through redirect chains.
- Apply connect, read, and total timeouts.
- Enforce request and response byte limits.
- Avoid forwarding inbound credentials to upstream hosts without explicit policy.
- Enforce hard request body size bounds (`maxRequestBytes`, default 1 MiB) with pre-buffering rejection (`413 Payload Too Large`) and early stream termination to prevent unbounded buffering DoS.
- Protect inbound HTTP endpoints against DNS rebinding: validate Host headers (rejecting missing/malformed hosts with `400 Bad Request`), enforce Host and Origin allowlists (`allowedHosts`, `allowedOrigins`) with `403 Forbidden`, and never echo untrusted request data in error responses.
- Enforce HTTP socket and stream timeouts (`requestTimeoutMs`, default 15,000 ms) to mitigate Slowloris attacks.

Current implementation: `@chainmcp/executor` enforces exact host allowlists,
HTTPS by default, public-address classification for every DNS answer, pinned
lookups with peer verification, same-origin redirect revalidation, request and
response caps, and cancellation binding. Upstream credential resolution and
injection are implemented and covered by `docs/authentication.md`; the executor
validates provider output and never forwards inbound identity. OAuth token
requests are outbound calls too, so the executor fetches them through the same
policy and pinned transport instead of the platform fetch. The default transport
does not honor proxy environment variables or decompress responses. These
controls are covered by unit and local transport tests, not by a production
security review.

### Input validation

- Treat tool arguments as untrusted. Enforce the audited JSON Schema subset at
  registration and again at invocation.
- Do not run contract-supplied regular expressions on a backtracking engine.
  The runtime uses the linear-time `re2js` engine, caps pattern length at 4,096
  characters, and rejects patterns that RE2 cannot compile.
- Use a bounded structural comparison for `uniqueItems` and fail closed when
  the value exceeds the comparison budget.
- Assert only documented formats. Other format strings are annotations, not
  security checks.
- Reject unsupported schema composition at registration rather than silently
  accepting values the contract rejects.

Current implementation: `@chainmcp/core` enforces required fields, primitive
enums, string length/pattern/format constraints, numeric bounds and multiples,
array length and structural uniqueness, and object property counts. String
lengths count Unicode code points. OpenAPI 3.0 boolean exclusive bounds are
normalized by the compiler. Validation still has no overall input-size cap;
executors and adapters must bound request bodies and caller memory.

### Authentication

- Separate inbound MCP identity from upstream API credentials.
- Enforce authorization on every tool invocation.
- Enforce own-property credential lookup (`Object.hasOwn`) for inbound bearer token and API key maps to prevent prototype-chain traversal (such as `constructor` or `__proto__`).
- Strictly validate inbound principal shapes: require non-empty string `tenantId` and `principalId`, and reject malformed principals or principals without a tenant (failing closed).
- Require inbound authentication for HTTP servers and gateways bound to non-loopback interfaces; refuse unauthenticated startup on non-loopback binds unless explicitly permitted via `security.allowUnauthenticatedHttp: true`.
- Fail fast at startup if `requireInboundAuth: true` or `authorizer: "scope"` is configured without a corresponding inbound verifier.
- Store refresh tokens and API credentials through secure secret providers.
- Support expiry, revocation, and rotation.
- Fail closed when identity or authorization cannot be verified. Treat untyped authorization adapter failures as denials and do not expose their details to clients.
- Express rate-limit denials as explicit decisions and fail closed when a decision is missing, so an adapter outage is not confused with a quota denial.

Current implementation: `@chainmcp/server` verifiers (`createBearerTokenVerifier`,
`createApiKeyVerifier`) evaluate token and key maps using own-property semantics
(`Object.hasOwn`) to prevent prototype-chain traversal bypasses. Inbound principals
returned by configured maps or custom callbacks (`verifyToken`, `verifyKey`, `mapClaims`)
are strictly validated against `InboundPrincipalConfig`: both `tenantId` and
`principalId` must be non-empty strings, and any malformed or incomplete principal
fails closed as unauthenticated. `@chainmcp/auth` keeps inbound identity
(`OperationScopeAuthorizer` over `ToolContext.principal`) separate from upstream
credentials, which only `@chainmcp/executor` injects after declared parameters
are mapped, so caller arguments cannot supply or override `authorization`,
`cookie`, or other reserved headers. Credentials come from pluggable providers
and are validated against the declared credential shapes; invalid material is
unresolved and fails closed as `AUTH_REQUIRED`. `SecretStoreCredentialProvider`
reads tenant-scoped keys only, so a missing tenant secret never falls back to a
deployment-wide credential unless `allowGlobalFallback` is enabled explicitly.
`EncryptedSecretStore` protects secrets at rest with AES-256-GCM, random IVs,
key-name AAD binding, and key rotation. OAuth client-credentials token requests
run through the executor's destination policy and pinned transport (exact host
allowlist, public-address classification, peer verification, redirect refusal,
response cap) when the provider runs inside the executor; the standalone fetcher
enforces HTTPS, an explicit host allowlist, redirect refusal, and caps but
cannot pin the resolved address. Token cache keys are derived with a
segment-encoding helper, so identifiers cannot corrupt or collide in the store.
Token invalidation removes in-memory and persistent copies for entries the
instance knows about; because `SecretStore` has no scan operation, cross-process
revocation requires deleting `buildOAuthTokenStoreKey(...)` or relying on token
expiry. `@chainmcp/rate-limit` turns quota and concurrency limits into explicit
decisions, fails closed when Redis commands fail or time out, rolls back quota
recorded by a rejected multi-scope check, bounds local window memory with
least-recently-used eviction, and bounds concurrency permits with safety TTLs.
These controls are covered by unit tests, executor credential/egress tests, and
an opt-in real-Redis integration suite; they have not had a production security
review.

### Caching

- Partition entries by tenant, principal or authorization context, tool, contract revision, and relevant arguments.
- Include a stable, non-secret authorization partition derived from effective grants or policy state; bypass shared caching when one cannot be established.
- Never use raw bearer tokens as cache keys.
- Cache only tools that explicitly opt in as idempotent reads. Never store failed or `undefined` results.
- Resolve identity, authorization, validation, and rate limits before reading the cache; a hit must not bypass them.
- Do not cache mutations by default.
- Never serve a cached response across authorization boundaries.
- Bypass caching when a safe partition cannot be established.
- Treat cache store, partition, and key-derivation failures as bypasses (or read misses), never as invocation failures or reasons to weaken a check.
- Require cache adapters to return isolated values so a caller cannot mutate stored state.
- Expose cache invalidation only to trusted operator code; it is not an MCP tool and must not become an authorization bypass.
- Record cache hit/miss/bypass outcomes without including keys, arguments, or cached values in telemetry.
- Apply opt-in output projection and token budgets before writing to the cache or returning a result. Cache only the projected value; never write the raw result first and project on read.
- Treat projection failures, unserializable projections, and unverifiable budgets as fail-closed errors. Never fall back to the raw result or return an over-budget value.
- Do not treat output projection as authorization: it runs only after authorization and does not grant access. Define field-level policy in trusted deployment code and test it against unauthorized callers.
- Prefer declarative `include` selections for sensitive objects. Bound paths, projection depth, and visited nodes; reject `__proto__`, `prototype`, and `constructor` segments, and copy arbitrary keys with `Object.defineProperty` so JSON data cannot alter prototypes.
- For shared Redis caches, keep credentials and TLS configuration in the client, never in keys, partitions, or telemetry. Use a deployment-specific key prefix, but do not treat it as an authorization boundary; the hashed key and partition remain the isolation mechanism.
- Bound Redis commands with a short timeout. A timed-out command is not necessarily cancelled, so configure client socket/command timeouts and avoid unbounded retries.
- Run tokenizer and projector adapters in-process or inside a trusted boundary. Do not forward serialized results to a third party for counting, and never record payload text in telemetry.
- Never label an estimated token count as exact, and never promise savings from an estimate without a documented baseline.

### Analytics

- Redact authorization headers, cookies, API keys, and sensitive parameters.
- Exclude raw request and response bodies by default.
- Restrict access to detailed telemetry.
- Define retention and deletion behavior.

### Resource controls

- Bound concurrency, execution time, input size, response size, and JSON traversal.
- Avoid unbounded retries and cache stampedes.
- Apply quotas by tenant and principal.
- Ensure cancellation reaches upstream requests.

## Reporting vulnerabilities

Configure a private vulnerability reporting channel before public release. Do not ask reporters to publish exploit details in public issues.

## Production readiness

Before production use, complete security integration tests, dependency scanning, SSRF tests, tenant-isolation tests, and a documented security review.

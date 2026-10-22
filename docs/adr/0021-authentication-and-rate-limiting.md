# ADR 0021: Authentication, Upstream Credentials, Encrypted Secret Storage, and Distributed Rate Limiting

- Status: proposed
- Date: 2026-10-22
- Amended: 2026-10-22 (implementation audit; see "Amendment: audit findings")

## Context and problem

Milestone 5 of the ChainMcp roadmap specifies authentication and rate limiting requirements:

1. Strict separation between inbound MCP caller identity/authorization and upstream API credentials.
2. Pluggable upstream credential providers supporting API keys, HTTP authentication, and OAuth 2.0 tokens.
3. Encrypted secret storage abstraction protecting secrets at rest with support for rotation.
4. Token lifecycle management: expiration detection, automatic token refresh, and revocation.
5. Quotas partitioned by tenant, principal, and tool.
6. Concurrency limits and retry-after calculation.
7. Cross-process quota and concurrency enforcement using a distributed adapter.

Prior to this work:

- `@chainmcp/auth` implemented only the default `OperationScopeAuthorizer` for inbound principal scope validation.
- `@chainmcp/executor` executed upstream HTTP requests with no credential resolution, treating authentication metadata as informational only.
- `@chainmcp/core` defined basic `RateLimiter` and `RateLimitDecision` interfaces without retry-after duration or concurrency release hooks.
- No package existed for quotas, concurrency control, or distributed rate limiting.

## Decision

### 1. Separation of Inbound Authorization and Upstream Credentials

- Inbound MCP identity remains on `ToolContext.principal` and `ToolContext.tenantId`, established by the MCP server adapter. Inbound callers never provide upstream credentials in tool arguments or headers; `RESERVED_REQUEST_HEADERS` prohibits caller-supplied authorization headers.
- The runtime `Authorizer` evaluates inbound access permissions.
- Upstream credentials are independently resolved per operation and tenant via pluggable `UpstreamCredentialProvider` implementations and injected directly into upstream HTTP requests by `@chainmcp/executor`.

### 2. Encrypted Secret Storage (`@chainmcp/auth`)

- Defined `SecretStore` interface (`get`, `set`, `delete`).
- Implemented `InMemorySecretStore` for development and ephemeral storage.
- Implemented `EncryptedSecretStore`:
  - Authenticated encryption using AES-256-GCM.
  - 256-bit keys mapped by key ID in a `KeyRing`.
  - Unique cryptographically random 96-bit (12-byte) IV per encryption.
  - 128-bit (16-byte) authentication tag.
  - Additional Authenticated Data (AAD) bound to the secret key name, preventing ciphertext swapping across keys.
  - Key rotation support: decrypts using any configured key in the ring, encrypts new values with `activeKeyId`, and supports `rotate(key, targetKeyId)`.
  - Fail-closed decryption: corrupted ciphertext, mismatched tag, or missing key throws an error without leaking plaintext.

### 3. Upstream Credential Providers (`@chainmcp/auth`)

- Defined `UpstreamCredential` discriminated union (`apiKey`, `http` bearer/basic, and `oauth2`).
- Defined `UpstreamCredentialProvider` interface with `resolveCredential(context: CredentialResolutionContext)`.
- Provided built-in providers:
  - `StaticCredentialProvider`: maps static credentials or resolvers by scheme name.
  - `EnvCredentialProvider`: resolves credentials from environment variables safely.
  - `SecretStoreCredentialProvider`: resolves credentials stored in an encrypted `SecretStore`.
  - `CompositeCredentialProvider`: chains multiple providers in priority order.

### 4. OAuth 2.0 & Token Lifecycle Management (`@chainmcp/auth`)

- Implemented `OAuthClientCredentialsProvider`:
  - Executes OAuth 2.0 Client Credentials Grant (RFC 6749 Section 4.4). This grant issues no refresh token, so expiry means re-acquiring a token.
  - Caches access tokens in memory or an optional `SecretStore`, keyed by tenant, principal, scheme, and normalized scopes with a segment-encoded store key.
  - Tracks token expiration with safety margin (`expirySkewSeconds`, default 30s).
  - Automatically fetches fresh tokens when expired or nearing expiry.
  - Supports manual invalidation (`invalidate(tenantId?, schemeName?, principalId?)`), which drops matching in-memory entries and deletes their persistent copies. Cross-process revocation of entries another process wrote is explicitly out of scope because `SecretStore` has no scan operation; delete the derived key or rely on expiry.
  - Treats the token endpoint as a policy-bound outbound destination (see section 5).

### 5. Upstream Executor Credential Injection (`@chainmcp/executor`)

- Added optional `credentialProvider` to `UpstreamExecutorOptions`.
- Validates every resolved credential with `normalizeUpstreamCredential`; invalid material counts as unresolved and fails closed.
- For operations declaring `CompiledAuthenticationPolicy`:
  - Evaluates alternative scheme sets (OR list) in contract order.
  - For each alternative, resolves all required schemes (AND list).
  - When an alternative is satisfied, injects credentials into the outgoing request:
    - `apiKey`: headers, query parameters, or cookies.
    - `http` bearer: `Authorization: Bearer <token>`.
    - `http` basic: `Authorization: Basic <base64>`.
    - `oauth2`: `Authorization: <tokenType> <token>`.
  - If no alternative is satisfied:
    - If `allowsAnonymous: true`, proceeds with anonymous request.
    - Otherwise, fails closed with `RuntimeError("AUTH_REQUIRED", "Authentication required")`.
  - All injected headers and query parameters are subject to existing executor byte caps.

- Credential providers are deployment code, so the executor does not trust their
  types: shapes are validated at the boundary.
- OAuth token acquisition reuses the outbound policy. The executor supplies a
  `tokenEndpointFetch` built from its resolver and transport, so token requests
  inherit the exact host allowlist (the provider's `allowedTokenHosts`, else the
  configured token URL host), HTTPS enforcement, public-address classification,
  DNS pinning, peer verification, redirect refusal, and the response cap. The provider's
  built-in fetcher remains for standalone use and requires an explicit
  allowlist, refuses redirects, and enforces HTTPS and size caps, but cannot pin
  the resolved address.
- `SecretStoreCredentialProvider` resolves tenant-scoped keys only. A shared
  deployment-wide credential is opt-in via `allowGlobalFallback`, so a tenant
  without its own secret fails closed instead of authenticating with another
  tenant's credential.

### 6. Quotas, Concurrency Limits, and Distributed Rate Limiting (`@chainmcp/rate-limit`)

- Extended `@chainmcp/core`:
  - Added optional `retryAfterSeconds?: number` to `RateLimitDecision`.
  - Added optional `release?(context, toolName)` to `RateLimiter`.
  - Propagated `retryAfterSeconds` onto `RuntimeError("RATE_LIMITED")`.
  - Added invocation cleanup in `finally` to trigger `rateLimiter.release()`.
- Created package `@chainmcp/rate-limit`:
  - `InMemoryRateLimiter`: Sliding-window quota tracker and concurrency manager. Quota denials report the time until the oldest request leaves the window; concurrency denials report a one-second lower bound. Sliding windows are bounded (`maxTrackedWindows`, default 10,000) with least-recently-used eviction and immediate removal of fully expired windows.
  - `DistributedRateLimiter`: Redis-backed distributed rate limiter using injectable `RedisRateLimitClient`.
    - Sliding window quota check using atomic Lua scripts (sorted sets with score timestamps, per-request members, and a key TTL of twice the window).
    - Every matching scope is evaluated per call; when a later scope denies, the entries this call already recorded are removed with `ZREM`, so a rejected call never consumes another scope's budget. Rollback failures are isolated and can only over-count.
    - Concurrency slot acquisition and release using atomic Lua scripts with safety TTLs (default 60 seconds).
    - Operates uniformly across multiple processes sharing the same Redis cluster. The Lua scripts are proven against a real Redis by an opt-in integration suite that CI runs with a Redis service container.

## Amendment: audit findings

An implementation audit found four behavioral defects and several overstated
claims. The decisions above incorporate the fixes:

1. **Token cache keys were not valid secret-store keys.** Multi-scope or
   character-rich tenant, principal, scheme, or scope values produced keys the
   store rejects. Keys are now derived by a shared helper that base64url-encodes
   each segment and digests over-long keys.
2. **Invalidation left persistent entries usable by other instances.** Invalidation
   now deletes the persistent copy of every entry it can identify, and the
   remaining cross-process limitation is documented instead of being described as
   revocation.
3. **Distributed quota was consumed by denied requests.** A check recorded quota
   for each allowed scope before a later scope could deny. Scope recording is now
   rolled back on denial.
4. **In-memory windows were unbounded.** A stream of new identities grew the map
   without limit. Windows are now evicted least-recently-used first under a
   configurable cap.
5. **Token fetches bypassed the outbound policy.** The standalone fetch had no
   host policy, followed redirects, and was not classified or pinned. Token
   acquisition now runs through the executor's policy and transport.
6. **Provider output and tenant fallback were trusted.** Credential shapes are
   validated, and the tenant-to-global fallback is opt-in.
7. **Retry-after was not client-visible.** The MCP adapter now renders a validated
   retry hint for `RATE_LIMITED` results.

Claims narrowed rather than implemented: no refresh-token flow, no cross-process
token revocation, no exact concurrency retry-after, and no address pinning for
the standalone token fetcher.

## Alternatives considered

- **Pass upstream credentials through `ToolContext`:** Rejected. `ToolContext` represents caller identity from inbound MCP adapters; blending upstream secrets with caller context risks credential leakage into logs, telemetry, and client-facing error handlers.
- **Implement browser-redirect OAuth flows (Authorization Code) in the server:** Deferred. Interactive browser flows require user agent interaction, session storage, and inbound callback endpoints. Backend tool execution requires machine-to-machine upstream authentication (Client Credentials grant).
- **In-memory rate limiting only:** Rejected. The milestone exit criteria explicitly require quota enforcement across processes using a distributed adapter.
- **Client-side concurrency locking without TTLs:** Rejected. If a server process crashes while holding a concurrency permit, the slot would leak indefinitely. Safety TTLs on Redis concurrency keys ensure automatic permit reclamation.

## Consequences and trade-offs

- Unauthenticated or unauthorized upstream calls fail closed with `AUTH_REQUIRED` or `AUTH_FORBIDDEN`.
- Secrets remain encrypted at rest and are never included in telemetry, logs, or error responses.
- Distributed quota and concurrency enforcement operates reliably across server processes, with a real-Redis integration suite as evidence.
- Additional package `@chainmcp/rate-limit` is added to the monorepo workspace.
- In-memory window eviction trades strict counting for bounded memory for the least recently used identities.
- The standalone OAuth fetcher cannot pin the resolved address; deployments that need pinning must run the provider through the executor.

## Security implications

- Secrets at rest cannot be read without the AES-256-GCM key and authentication tag verification.
- AAD binding prevents ciphertexts from being transplanted across secret keys.
- Untrusted caller inputs cannot inject or override upstream authorization headers.
- Rate limit denials calculate retry delays without revealing internal quota metrics or infrastructure configurations. MCP clients receive only a bounded whole-second hint.
- Concurrency locks expire safely if processes terminate unexpectedly, at the cost of holding a permit for up to the safety TTL.
- Token endpoint requests are allowlisted and classified like API requests when the executor wires the fetcher, so a token URL cannot become an SSRF path.

## Follow-up actions

- Wire rate limiting and credential provider configuration into `@chainmcp/config` when configuration loading expands.
- Add OpenTelemetry metrics and structured audit logs for authentication denials and quota events in Milestone 6.

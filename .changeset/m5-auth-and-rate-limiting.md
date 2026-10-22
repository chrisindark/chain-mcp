---
"@chainmcp/core": minor
"@chainmcp/auth": minor
"@chainmcp/executor": minor
"@chainmcp/rate-limit": minor
"@chainmcp/server": minor
---

Implement Milestone 5 authentication, secret storage, upstream credentials, and rate limiting:

- Add `EncryptedSecretStore` in `@chainmcp/auth` providing AES-256-GCM authenticated encryption at rest with 96-bit random IVs, 128-bit authentication tags, key-name AAD binding, key rings, and key rotation.
- Add pluggable upstream credential providers (`StaticCredentialProvider`, `EnvCredentialProvider`, `SecretStoreCredentialProvider`, `CompositeCredentialProvider`, and `OAuthClientCredentialsProvider`), with `normalizeUpstreamCredential` validating provider output at the trust boundary.
- Add `buildCredentialStoreKey`, `buildOAuthTokenStoreKey`, and `encodeSecretKeySegment` so tenant, principal, scheme, and scope values always derive valid, collision-free `SecretStore` keys.
- Implement the OAuth 2.0 client credentials grant with token caching, expiry safety margins, automatic re-acquisition, and `invalidate(tenantId?, schemeName?, principalId?)`. Invalidation also deletes persistent cache entries; cross-process revocation of entries another process wrote remains out of scope because `SecretStore` has no scan operation.
- Require an explicit token endpoint allowlist (`allowedTokenHosts`) or `allowAnyTokenHost`, enforce HTTPS unless `allowInsecureHttp` is set, and refuse redirects and URL credentials in the built-in token fetcher.
- Wire `credentialProvider` into `@chainmcp/executor` with explicit OR/AND authentication policy evaluation, header/query/cookie injection, and fail-closed `AUTH_REQUIRED` enforcement. OAuth token requests run through the executor's destination policy and pinned transport instead of the platform fetch.
- Default `SecretStoreCredentialProvider` to tenant-scoped secrets; a deployment-wide credential now requires `allowGlobalFallback: true`.
- Add `@chainmcp/rate-limit` with `InMemoryRateLimiter` (bounded, least-recently-used sliding windows via `maxTrackedWindows`) and `DistributedRateLimiter` (Redis-backed atomic Lua scripts for rolling-window quotas and concurrency permits). A denied multi-scope check rolls back quota it already recorded.
- Extend `@chainmcp/core` with `retryAfterSeconds` on `RateLimitDecision` and `RuntimeError`, and `release?(context, toolName)` concurrency permit release hook.
- Surface a bounded retry hint (`Retry after N seconds`) in the client-visible `RATE_LIMITED` error from `@chainmcp/server`.

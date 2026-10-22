---
"@chainmcp/core": minor
"@chainmcp/auth": minor
"@chainmcp/executor": minor
"@chainmcp/rate-limit": minor
---

Implement Milestone 5 authentication, secret storage, upstream credentials, and rate limiting:

- Add `EncryptedSecretStore` in `@chainmcp/auth` providing AES-256-GCM authenticated encryption at rest with 96-bit random IVs, 128-bit authentication tags, key-name AAD binding, key rings, and key rotation.
- Add pluggable upstream credential providers (`StaticCredentialProvider`, `EnvCredentialProvider`, `SecretStoreCredentialProvider`, `CompositeCredentialProvider`, and `OAuthClientCredentialsProvider`).
- Implement OAuth 2.0 Client Credentials flow with automatic token caching, expiration safety margins, automatic refresh, and invalidation.
- Wire `credentialProvider` into `@chainmcp/executor` with explicit OR/AND authentication policy evaluation, header/query/cookie injection, and fail-closed `AUTH_REQUIRED` enforcement.
- Add `@chainmcp/rate-limit` package providing `InMemoryRateLimiter` and `DistributedRateLimiter` (Redis-backed with atomic Lua scripts for rolling window quotas and concurrency permits) with exact `retryAfterSeconds` calculation across server processes.
- Extend `@chainmcp/core` with `retryAfterSeconds` on `RateLimitDecision` and `RuntimeError`, and `release?(context, toolName)` concurrency permit release hook.

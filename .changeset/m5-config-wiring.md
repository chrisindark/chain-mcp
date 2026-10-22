---
"@chainmcp/config": minor
"@chainmcp/executor": minor
---

Wire network security allowlists, rate limiting, and upstream authentication into `@chainmcp/config`:

- Enforce strict hostname validation and lowercase normalization on `security.allowedUpstreamHosts`, rejecting schemes, ports, paths, queries, credentials, and wildcards.
- Export `normalizeAllowedHost` and `normalizeHostname` from `@chainmcp/executor`.
- Add `rateLimit` and `auth` schema sections to `ChainMcpConfigSchema`.
- Add factory and wiring helpers: `buildExecutorOptions`, `buildRuntimeOptions`, `createRateLimiterFromConfig`, `createAuthorizerFromConfig`, and `createUpstreamCredentialProviderFromConfig`.

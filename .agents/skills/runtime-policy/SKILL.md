---
name: runtime-policy
description: Guidelines for managing authentication, Redis/memory caching, rate limiting, token accounting, and output projection in ChainMcp runtime. Use when changing execution policy layers.
---

# Runtime Policy Management in ChainMcp

ChainMcp executes all MCP tool invocations through a composable security and policy pipeline:

1. **Inbound Identity & Auth** (`packages/auth`)
2. **Rate Limiting & Concurrency** (`packages/rate-limit`)
3. **Partitioned Hashed Cache** (`packages/cache-redis`, `packages/core`)
4. **Execution & Upstream Transport** (`packages/executor`)
5. **Output Projection & Token Budgets** (`packages/core`, `packages/json-navigation`)

## 1. Authentication & Scopes (`packages/auth`)

- Inbound identity is represented by `Principal` (`id`, `scopes`, `attributes`).
- `OperationScopeAuthorizer` verifies that `context.principal.scopes` contains the required permissions before executing the tool.
- Upstream credentials must remain strictly isolated from inbound client identity.

## 2. Partitioned Caching (`packages/cache-redis`)

- Cache keys must be generated using `createCacheKey()` with versioned, hashed inputs incorporating tenant, principal context, tool name, and normalized parameters.
- Cache eligibility: Only idempotent, side-effect-free tools should have cache policies enabled.
- Authorization checks must **never** be bypassed simply because a result exists in the cache.

## 3. Rate & Concurrency Limits (`packages/rate-limit`)

- Enforce per-tenant and per-principal token-bucket or sliding-window rate limits.
- Return structured `STAGE_AWARE` policy errors when limits are exceeded.

## 4. Output Projection & Token Budgets (`packages/core`)

- Tokenizer calculates output token footprints.
- Field projection filters out extraneous nested properties to conform with caller token budgets.

## 5. Verification

- Test auth package: `pnpm --filter @chainmcp/auth test`
- Test cache package: `pnpm --filter @chainmcp/cache-redis test`
- Test rate-limit package: `pnpm --filter @chainmcp/rate-limit test`

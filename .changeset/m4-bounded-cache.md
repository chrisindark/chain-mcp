---
"@chainmcp/core": minor
"@chainmcp/cache-redis": minor
---

Add a bounded in-memory LRU `CacheStore` adapter and move cache keys to v2
with a required non-secret `authorizationPartition`. `createCacheKey` now
rejects blank identity fields, and the store rejects callable `toJSON` values.
Wire opt-in per-tool caching into invocation: reads run after authorization,
validation, and rate limiting, and key, partition, read, and write failures
bypass caching instead of failing the call. Report `cacheOutcome` on invocation
events and add exact-match `invalidateCachedResult` for trusted operator code.
Add an optional `Tokenizer` adapter that records exact or estimated token counts
and the serialized payload size on successful invocation events. Add per-tool
output projection and token budgets: `ToolDefinition.output` opts into a
deployment-supplied `ResultProjector`, and `maxTokens` rejects over-budget or
uncountable results before caching or returning them. Projected output must be
JSON, cached entries contain only the projection, and projection/budget failures
never fall back to the raw result. Add `createFieldProjector()` with bounded
declarative `output.fields` include/exclude paths. Add `@chainmcp/cache-redis`,
an optional shared cache adapter with validated keys/values, bounded TTL and
entry size, and per-command timeouts. Runtime caching, measurement, projection,
and budgets remain disabled unless the deployment configures them and a tool
opts in.

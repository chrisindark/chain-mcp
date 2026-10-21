---
"@chainmcp/core": minor
---

Add a bounded in-memory LRU `CacheStore` adapter and move cache keys to v2
with a required non-secret `authorizationPartition`. `createCacheKey` now
rejects blank identity fields, and the store rejects callable `toJSON` values.
Wire opt-in per-tool caching into invocation: reads run after authorization,
validation, and rate limiting, and key, partition, read, and write failures
bypass caching instead of failing the call. Report `cacheOutcome` on invocation
events and add exact-match `invalidateCachedResult` for trusted operator code.
Add an optional `Tokenizer` adapter that records exact or estimated token counts
and the serialized payload size on successful invocation events. Runtime caching
and token measurement remain disabled unless the deployment configures them.

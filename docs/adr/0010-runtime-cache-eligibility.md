# ADR 0010 — Runtime cache eligibility and partition binding

- Status: proposed
- Recorded: 2026-10-20

## Context and problem

ADR 0003 makes cache isolation mandatory and ADR 0005 defines the opaque,
versioned cache key, but until now nothing in the invocation path read or wrote
a cache. Wiring one in raises questions that the key format alone cannot answer:

- **Which operations may be cached?** Caching everything by default would
  cache mutations and duplicate side effects.
- **Where does the contract revision come from?** A keyed entry must not be
  shared across compiled contract revisions, including in a gateway that loads
  several revisions.
- **Who computes the authorization partition?** Core does not evaluate policy,
  so it cannot infer effective grants. Falling back to a constant, a token, or
  the tenant alone would silently merge authorization contexts.
- **Can a cache hit bypass authorization or a quota?** It must not.
- **What happens when the cache is unavailable or the key cannot be built?**
  A cache outage must not fail tool calls, and it must not create a weaker
  fallback path that serves unpartitioned data.

## Decision

1. **Caching is opt-in per tool.** `ToolDefinition.cache` carries
   `{ ttlSeconds }`; its absence means "never cache". Only idempotent read
   operations should declare it, and no tool is cached by default. Failed and
   `undefined` results are never stored.
2. **The tool carries its contract revision.** A cacheable tool must declare a
   non-empty `contractRevision`, validated at registration. The revision is
   hashed into every key, so a gateway can serve multiple revisions through one
   runtime without cross-revision hits, and a compiler can emit the revision
   alongside the tool.
3. **The deployment supplies the partition.** `RuntimeOptions.cache` requires a
   `store` and a synchronous `authorizationPartition(context, tool)` callback.
   There is no default partition: core cannot know whether a policy depends on
   scopes, attributes, or resource ownership. The callback must return a stable,
   non-secret description of effective grants or policy state, never a
   credential.
4. **Reads happen after every security stage.** The order is identity,
   authorization, validation, rate limit, key derivation, cache read, execution,
   cache write. A hit therefore never bypasses an access decision or a quota.
5. **Bypass, not failure, for cache problems.** A blank or missing partition, a
   throwing partition callback, uncanonicalizable arguments, a rejected read,
   and a rejected write all degrade to a miss or bypass. They never fail the
   invocation and never widen what may be served.
6. **The store owns resource limits.** The runtime passes the tool TTL and
   treats a store rejection (for example, a TTL above the adapter cap) as "do
   not cache". TTL, entry, and byte bounds remain the adapter's responsibility,
   as in ADR 0003 and ADR 0005.
7. **No request coalescing.** Concurrent misses may execute more than once.
   Cache I/O is outside the per-call execution timeout, so a distributed adapter
   must bound its own latency.
8. **Cache outcomes are observable.** Every invocation of a cache-eligible tool
   on a cache-enabled runtime reports `cacheOutcome` as `hit`, `miss`, or
   `bypass`. A store read failure, partition failure, or key-derivation failure
   is a bypass because no usable lookup occurred; a lookup that finds nothing is
   a miss even if execution or the write later fails. The hit ratio is
   `hit / (hit + miss)`, with bypass excluded and monitored separately. Events
   carry no keys, arguments, or cached values.
9. **Invalidation is exact-match and trusted.** `invalidateCachedResult(name,
input, context)` recomputes the key from the same tool, arguments, and caller
   context and deletes that entry. It resolves the tool with the normal tenant
   scoping, does not run the authorizer, and is not exposed as an MCP tool. Store
   deletion failures propagate to the operator; missing cache, ineligible tools,
   and underivable keys are no-ops. There is no prefix, tenant-wide, or predicate
   invalidation because hashed keys cannot be enumerated (ADR 0005).

## Alternatives considered

- **Cache every tool by default and let deployments opt out.** Rejected: it
  caches mutations unless every author remembers to opt out, and a default that
  can duplicate side effects is the wrong failure direction.
- **Put `contractRevision` on `RuntimeOptions`.** Rejected for now: it ties a
  runtime instance to one revision and conflicts with a gateway serving several
  revisions. A per-tool revision keeps the key correct in both modes.
- **Derive the partition from sorted `principal.scopes` by default.** Rejected:
  it looks safe but silently ignores attribute-based or resource-level policy,
  producing cross-context hits when a custom authorizer is in use.
- **Use the bearer token or tenant as the partition.** Rejected: credentials
  must not enter keys, and tenant alone is already in the key while remaining
  insufficient for authorization changes.
- **Fail the call when the cache is down.** Rejected: it turns an optional
  optimization into an availability dependency and does not improve isolation.
- **Serve a stale entry when authorization cannot be evaluated.** Rejected by
  ADR 0003; authorization always runs before a lookup.
- **Cache `undefined` results.** Rejected: `CacheStore.get` uses `undefined` for
  a miss, so storing it would be indistinguishable from no entry.
- **Report cache hits as a distinct `outcome: "cache_hit"`.** Rejected: it
  changes the meaning of a field existing consumers already branch on. An
  additive `cacheOutcome` keeps invocation success separate from cache behavior.
- **Allow invalidation as an MCP tool.** Rejected: it creates a remote control
  surface that must be authenticated and authorized, and could be used to
  degrade availability. Invalidation stays in trusted operator code.
- **Maintain a key index to enable prefix or tenant-wide invalidation.**
  Rejected for this milestone: it adds a second source of truth that can drift
  and reintroduces raw identity metadata into the store. TTL expiry and store
  namespace rotation cover bulk cleanup.

## Consequences and trade-offs

- Hit rates depend on explicit opt-in and on a correct partition callback.
  Forgetting to declare `cache` is safe but gives no benefit.
- Compilers must emit the contract revision and cache policy for eligible
  operations; until then, generated tools execute every call.
- Bypasses are now visible as `cacheOutcome: "bypass"`; a rising bypass rate
  indicates a store outage or a partition callback that cannot derive a stable
  value.
- Exact-match invalidation requires the original arguments and caller context.
  After a policy change the partition changes, so old entries become unreachable
  rather than being deleted, and they remain until TTL expiry. Immediate bulk
  purge requires rotating the store namespace.
- Cache I/O adds latency on misses without a timeout guarantee; the in-memory
  adapter is fast, and distributed adapters are expected to enforce their own
  bounds.
- Cached values currently bypass output validation and projection, which do not
  exist yet. When output-level policy lands (SEC-05), it must run before
  storing a result, or the cache must store only projected output. Otherwise a
  later projection bug could be masked by a cached raw response.

## Security implications

- Authorization, validation, and rate limiting run before every cache read, so a
  hit cannot grant access or evade a quota.
- Keys include tenant, principal, partition, contract revision, tool, and
  arguments; raw identities and arguments never appear in the store key.
- A missing or ambiguous partition disables caching rather than sharing an
  entry, matching ADR 0003's fail-closed rule.
- Cache failures never surface an unpartitioned fallback and never change the
  tool result.
- The store is trusted infrastructure. A compromised store can return
  arbitrary values, so deployments must protect it; adapter reads must return
  isolated values so callers cannot mutate retained state.
- Invalidation is exact-match, runs no authorization because it is not an MCP
  request, and cannot enumerate another tenant's entries. It must not be
  exposed as a tool without adding an authorization boundary.
- Cache telemetry records only `hit`/`miss`/`bypass`, never keys, arguments, or
  cached values.

## Follow-up actions

- ~~Redis adapter with bounded TTLs, response sizes, timeouts, and failure
  treatment matching this ADR.~~ Implemented in ADR 0014.
- ~~Token metrics (M4), complementing the recorded cache outcomes.~~ Implemented
  in ADR 0011.
- ~~Invalidation and field projection (M4), plus output policy ordering before
  writes (SEC-05).~~ Implemented in ADR 0012 and ADR 0013. Bulk purge still relies
  on TTL expiry or namespace rotation.
- Re-evaluate request coalescing if duplicate upstream calls become a real cost.

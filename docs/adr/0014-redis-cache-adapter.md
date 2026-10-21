# ADR 0014 — Optional Redis cache adapter

- Status: proposed
- Recorded: 2026-10-21

## Context and problem

ADR 0010 made the runtime cache opt-in behind `CacheStore` and shipped a
process-local LRU. Multi-instance deployments need a shared store, but adding a
Redis SDK to `@chainmcp/core` would couple the runtime to one client, one
connection model, and one release cadence. Bundling no adapter at all leaves
each deployment to reimplement key validation, serialization bounds, TTLs, and
timeouts inconsistently.

The adapter also has to fit the existing failure model: a cache outage or corrupt
value must degrade to a bypass or miss, never fail a tool invocation or cross an
authorization boundary.

## Decision

1. **Separate package.** Add `@chainmcp/cache-redis`, depending only on
   `@chainmcp/core`. Core remains free of Redis, network clients, and connection
   management.
2. **A narrow client wrapper, not a Redis SDK.** `RedisCacheClient` exposes
   `get`, `set(key, value, ttlMilliseconds)`, and `delete`. Deployments wrap
   `node-redis`, `ioredis`, or another client in three methods. The adapter never
   owns credentials, TLS, cluster topology, reconnects, or connection lifecycle.
3. **Validate everything the store touches.** Keys must be current-version
   hashed keys from `createCacheKey`. Values are validated with
   `assertJsonCacheValue` before serialization and after parsing. The adapter
   rejects corrupt JSON, oversized entries, non-string values, and invalid
   values instead of returning them.
4. **Bound resources.** Defaults are 256 KiB per key plus serialized value,
   3,600 seconds maximum TTL, and 1,000 ms per command. TTL is converted to
   integer milliseconds with a 1 ms floor. Entry size includes the storage key.
5. **Optional literal namespace.** `keyPrefix` prepends 1-128 printable ASCII
   characters to every storage key. It separates deployments sharing Redis, but
   it is not an authorization boundary.
6. **Bounded command latency.** Each Redis command races a timer. A timeout
   rejects the cache operation; it does not cancel the underlying client
   command, so clients must configure socket and command timeouts too.
7. **Exact deletion only.** `delete` removes one prefixed key. The adapter does
   not scan, flush, or invalidate by prefix or predicate.
8. **No coalescing or distributed locking.** Concurrent misses may execute and
   write more than once, matching the core cache contract.

## Alternatives considered

- **Bundle `redis` or `ioredis` in core.** Rejected: couples the runtime to a
  client and forces every consumer to carry it. Optional peer dependencies still
  complicate installation and versioning.
- **Ship a generic `@chainmcp/cache` package with Redis inside.** Rejected for
  now: the only shared implementation is Redis-specific, and core already owns
  the `CacheStore` contract.
- **Accept a full Redis client type.** Rejected: library signatures differ on
  `set` options and `delete`/`del`, and a structural wrapper keeps the adapter
  testable without a live server.
- **Store objects using RedisJSON.** Rejected: adds a Redis module and changes
  the value contract; serialized JSON is portable across Redis-compatible
  services.
- **Skip value validation and trust the store.** Rejected: a compromised or
  misconfigured store could return arbitrary data; validation also catches
  stale formats and oversized values.
- **Use `SET` without `PX` and keep expiry in the value.** Rejected: duplicates
  Redis's native TTL and risks stale entries.
- **Rely on client timeouts only.** Rejected: clients have different defaults
  and may omit them; the adapter must bound its own request path.
- **Treat corrupt values as misses.** Tempting, but silently deleting or
  ignoring corrupt data can hide an incident. Rejecting lets the runtime report
  a bypass; TTL eventually clears it.
- **Use `keyPrefix` as tenant isolation.** Rejected: authorization isolation is
  already in the hashed key and partition; a prefix is operational namespacing.

## Consequences and trade-offs

- Deployments write a small wrapper around their Redis client and remain in
  control of TLS, authentication, retries, and cluster behavior.
- The adapter does not test against a live Redis instance in normal CI. Its
  command contract, validation, TTL conversion, and timeout behavior are covered
  by deterministic fake-client tests; deployments should run an integration
  smoke test against their Redis topology.
- Corrupt entries cause a bypass until TTL or manual deletion; the adapter does
  not repair or delete them.
- Redis stores serialized JSON, so the adapter allocates the full value on
  write/read. The entry cap bounds retained and returned bytes but not transient
  allocation.
- Per-command timers add overhead and do not cancel in-flight commands. A slow
  client can still consume resources after the adapter has moved on.
- Cache hits are not revalidated against the current tool policy beyond the
  keyed revision/partition; projection-policy changes require namespace or
  revision rotation (ADR 0012).
- No bulk invalidation is available because keys are hashed and deliberately
  non-enumerable.

## Security implications

- Credentials belong to the client configuration, never to keys, partitions,
  logs, or telemetry.
- Use TLS and a private network for shared Redis. The cache contains projected
  responses, which may still be sensitive.
- A deployment-specific prefix prevents accidental cross-environment reads but
  is not authorization; tenant, principal, and partition are in the hashed key.
- Key and value validation prevents an adapter bug from writing raw identities
  or unbounded values into Redis.
- Command timeouts bound latency but are not a hard cancellation guarantee.
- The adapter never logs keys or values.

## Follow-up actions

- Add an opt-in integration suite against a disposable Redis instance in CI.
- Consider `SCAN`-based namespace administration outside the runtime, without
  weakening exact-match invalidation in the request path.
- Revisit request coalescing and cache stampede controls if shared-store load
  shows duplicate upstream calls.
- Define key-prefix and TTL defaults in deployment configuration once the
  configuration schema covers cache adapters.

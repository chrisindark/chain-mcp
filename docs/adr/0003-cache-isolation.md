# ADR 0003 — Mandatory cache isolation

- Status: accepted
- Recorded: 2026-10-19 (reconstructed from existing documentation; no new decision)

## Context and problem

Caching upstream API responses can reduce latency, cost, and rate-limit
consumption, but a shared cache creates a direct cross-tenant and
cross-principal data-leak risk. A cache entry produced under one identity,
authorization context, contract revision, or argument set must never be served
to another. Authentication tokens must not become cache keys, and caching must
not bypass authorization or serve stale data across a policy change.

## Decision

Cache isolation is mandatory and cannot be disabled through operation
configuration.

A cache key must incorporate:

- contract revision;
- tool identity;
- canonicalized arguments;
- tenant identity;
- principal or authorization partition;
- relevant scopes and response-varying inputs;
- a key-format version.

Additional rules:

- Never use raw bearer tokens as cache keys.
- If a safe authorization partition cannot be computed, bypass shared caching.
- Do not cache mutations by default.
- Never serve a cached response across authorization boundaries.
- A cache failure must not result in serving data from another tenant or
  authorization context.
- Store keys are opaque, fixed-length digests of the canonical key material; raw
  identities and arguments do not appear in the store (see ADR 0005).

## Alternatives considered

- **Cache by tool and arguments only.** Rejected: it leaks data across tenants,
  principals, scopes, and contract revisions.
- **Opt-in tenant isolation.** Rejected: a configuration mistake would expose
  data, so isolation must be mandatory.
- **Use the bearer token as part of the key.** Rejected: it puts credentials in
  the store and couples key validity to token rotation.
- **Cache all operations, including mutations.** Rejected: retries and duplicate
  writes can cause incorrect side effects.
- **Serve stale entries when authorization is unavailable.** Rejected:
  authorization must fail closed.

## Consequences and trade-offs

- Hit rates are lower because entries are partitioned by identity and contract
  revision.
- Key construction is more complex and must be versioned when semantics change.
- Authorization changes and contract revisions naturally invalidate entries.
- Store operators cannot inspect or prefix-scan raw tenant identity from keys;
  tenant-scoped operations require separate namespaces or metadata.
- Cache adapters must support safe invalidation and TTL handling.

## Security implications

- Prevents cross-tenant and cross-principal response disclosure.
- Prevents authorization bypass through cached results.
- Keeps credentials out of cache keys and store listings.
- Requires cache-store access controls and encryption at rest; hashed keys are
  not secrets.
- Cache outages must fail open only by bypassing the cache, never by weakening
  authorization.

## Follow-up actions

- ~~Implement bounded in-memory and optional Redis adapters with isolation tests
  (Milestone 4).~~ Implemented in ADR 0010 and ADR 0014.
- Add tests for tenant, principal, scope, revision, and argument partitioning.
- Verify mutation bypass and cache-outage behavior.
- Maintain the key-format version when canonicalization or included fields
  change.

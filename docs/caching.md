# Caching

ChainMcp can cache idempotent read results. Caching is **off by default** at
three levels: a tool must opt in, the runtime must be given a store, and the
deployment must supply an authorization partition. This page describes the
implemented Milestone 4 slice; see `ROADMAP.md` for what remains (Redis and
other shared stores, bulk invalidation, and request coalescing).

## Enabling caching

```ts
import {
  InMemoryCacheStore,
  InMemoryToolRuntime,
  type ToolDefinition,
} from "@chainmcp/core";

const runtime = new InMemoryToolRuntime({
  cache: {
    store: new InMemoryCacheStore(),
    // Stable, non-secret description of effective grants or policy state.
    // Use a canonical encoding; this example is scope-only.
    authorizationPartition: (context) =>
      JSON.stringify([...context.principal.scopes].sort()),
  },
});

const lookupItem: ToolDefinition = {
  name: "lookup_item",
  description: "Read an item from the catalog",
  inputSchema: {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string" } },
    additionalProperties: false,
  },
  operation: { requiredScopes: ["read"] },
  contractRevision: "catalog-2026-10-20",
  cache: { ttlSeconds: 60 },
  async execute(input) {
    // Idempotent read only. Mutations must not declare `cache`.
    return { id: (input as { id: string }).id, name: "Example" };
  },
};

runtime.register(lookupItem);
```

`cache.ttlSeconds` must be a positive finite number. A cacheable tool must also
declare a non-empty `contractRevision`; registration rejects missing or invalid
values with `CONTRACT_INVALID`.

Declaring `cache` without a runtime store is inert: every call executes.
Declaring `cache` on a mutation is a mistake the runtime cannot detect; do not
do it.

## Invocation order

```
identity -> authorization -> validation -> rate limit
         -> cache key -> cache read -> execute
         -> output projection -> token budget -> cache write -> measure
```

A cache hit never skips identity resolution, authorization, validation, or the
rate limiter. Those stages run on every call, so a cached response is never
served to a caller who would have been denied. A hit does skip execution,
projection, and the budget check because the entry was already projected and
checked when it was written. Projection and budget failures happen before the
cache write, so the raw or over-budget result is never stored.

## What the key includes

The runtime calls `createCacheKey` with:

- the caller's tenant and principal;
- the partition returned by `authorizationPartition`;
- the tool's `contractRevision` and name;
- the validated arguments.

The result is an opaque, versioned SHA-256 digest (`chainmcp:cache:v2:...`).
Raw identities, arguments, and the partition do not appear in the store. See
`docs/adr/0005-versioned-hashed-cache-keys.md`.

## Partition requirements

The partition must distinguish every authorization context that could change
the result: scopes, roles, attribute-based rules, resource ownership, and
policy version. It must be stable for a given set of grants and must never be a
bearer token or other credential.

There is no default partition. If effective grants cannot be represented
safely, return `undefined` and the runtime bypasses caching. Returning a blank
value, throwing, or producing arguments that cannot be canonicalized (for
example, a function-valued extra property) also bypasses. A bypass affects only
that call: the tool still executes normally.

A scope-only partition is safe only for a scope-only authorizer. A custom
authorizer that also depends on `principal.attributes` or resource ownership
must include those inputs in the partition, or bypass caching.

## Failure behavior

Cache problems degrade rather than fail:

| Situation                                      | Behavior                        |
| ---------------------------------------------- | ------------------------------- |
| Tool does not declare `cache`                  | Execute; no cache access.       |
| Runtime has no `cache` option                  | Execute; declarations are inert |
| Partition missing, blank, or throws            | Execute; no read or write.      |
| Arguments cannot be canonicalized              | Execute; no read or write.      |
| Cache read rejects                             | Treat as a miss and execute.    |
| Cache write rejects (including TTL over a cap) | Return the result; do not cache |
| Tool throws                                    | Return the error; do not cache. |
| Tool returns `undefined`                       | Return it; do not cache.        |
| Output projection fails                        | Fail the call; do not cache.    |
| Token budget is exceeded or uncountable        | Fail the call; do not cache.    |

A cached value is returned without re-running the tool or its input validation.
Store adapters must return isolated values so callers cannot mutate retained
state. `InMemoryCacheStore` parses a fresh JSON copy per hit.

## Projection before caching

A tool that declares `output` is projected by the runtime's `ResultProjector`
before the cache write. Only the projected value is stored, so a later hit
cannot expose fields the projector removed. The first invocation returns the
projected value too: projection is not applied only on writes.

A projection that throws, returns `undefined`, or returns a value that cannot be
JSON-serialized fails with `OUTPUT_POLICY_VIOLATION`; the raw result is never a
fallback. A tool with `output.maxTokens` is also counted after projection; an
over-budget result fails with `OUTPUT_LIMIT_EXCEEDED`, and an unverifiable count
fails with `OUTPUT_POLICY_VIOLATION`. Neither failure writes to the cache.
See `docs/token-accounting.md` and ADR 0012.

Projection may depend on the caller context. The cache key already includes the
tenant, principal, and authorization partition, but if the projector varies with
any other caller attribute, include it in `authorizationPartition` (or bypass
caching); otherwise a projected value can be served to a caller whose projection
should differ.

Projection policy is not part of the cache key. If you enable, change, or remove
a projector or budget for a tool that uses a shared/persistent store, invalidate
its namespace or bump `contractRevision`; otherwise an entry written under the
old policy can still be served until it expires.

## Observability

Every invocation of an eligible tool on a cache-enabled runtime includes a
`cacheOutcome` on its `tool_invocation` metric:

| Value    | Meaning                                                               |
| -------- | --------------------------------------------------------------------- |
| `hit`    | A cached value was served.                                            |
| `miss`   | The lookup succeeded and found nothing; the tool executed.            |
| `bypass` | No usable lookup: partition/key derivation failed or the read failed. |

Tools that do not declare `cache`, and runtimes without a store, omit the field.
`miss` is recorded even when execution or the cache write later fails, because
the lookup itself succeeded. Compute the hit ratio as
`hit / (hit + miss)`; exclude `bypass` from the denominator and alert on it
separately, because it indicates a partition or store problem rather than a
cold cache. Events never carry keys, arguments, or cached values.

`outcome` remains `success`, `error`, or `rate_limited`; a hit is still a
successful invocation. See `API_REFERENCE.md` for the full event shape.

## Invalidation

Hashed keys cannot be enumerated, so invalidation is exact-match:

```ts
await runtime.invalidateCachedResult("lookup_item", { id: "a" }, context);
```

The call recomputes the key from the same tool, arguments, tenant, principal,
partition, and contract revision, then deletes that entry. It is a trusted
operator surface, not an MCP request: it does not run the authorizer and does
not validate arguments against the schema. It resolves the tool with the same
tenant scoping as a call, so a multi-tenant caller cannot invalidate another
tenant's entry. It is a no-op when the runtime has no store, the tool is not
cache-eligible, or the partition/key cannot be derived. Store deletion failures
propagate so the operator can see that invalidation failed.

There is no prefix, tenant-wide, or predicate invalidation. When a policy change
alters the partition, old entries become unreachable and expire by TTL rather
than being deleted. For immediate bulk purge, use a separate store namespace per
deployment or revision and drop it.

## Bounds

`InMemoryCacheStore` is process-local and intended for development and tests.
Defaults:

- 1,000 entries;
- 16 MiB retained key plus serialized-value bytes;
- 256 KiB per entry;
- 3,600-second maximum TTL.

It is an LRU: reads refresh recency, and writes evict the least-recently-used
entry when a limit would be exceeded. Expired entries are reclaimed lazily on
the next read or write; the entry and byte caps still bound total retention. It
only accepts current-version hashed keys, so an adapter cannot accidentally
retain raw identities.

Serialization is not streaming: an oversized value can be allocated as a
temporary string before it is rejected. Values that are non-JSON, cyclic, have
accessors, define a callable `toJSON`, nest deeper than 64 levels, or exceed
50,000 nodes are rejected rather than normalized.

## Security notes

- Authorization always runs before a cache read (ADR 0003, ADR 0010).
- A missing or ambiguous partition bypasses caching; it never falls back to a
  shared entry.
- Keys are hashed but not encrypted. Protect the store, and do not treat keys
  as secrets.
- The store is trusted infrastructure. A compromised store can return arbitrary
  values; adapter reads must return isolated values.
- Do not cache mutations, credentials, or per-request authorization decisions.
- Cache only projected results for tools that declare `output`. Never write the
  raw result first and project on read.
- A shared/persistent store can outlive a projection-policy change. Rotate the
  namespace or revision when projection changes.

## Not implemented yet

- Redis or other shared stores.
- A declarative field-selection policy; projection is a deployment-supplied hook.
- Bulk or predicate cache invalidation.
- Request coalescing and cache-I/O timeouts (distributed adapters must bound
  their own latency).
- Per-content-block token measurement and aggregated token/cache exporters.

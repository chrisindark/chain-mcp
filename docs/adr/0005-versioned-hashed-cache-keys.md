# ADR 0005 — Versioned, hashed cache keys

- Status: proposed
- Date: 2026-10-19

## Context

`createCacheKey` previously returned a plaintext JSON array containing the
tenant ID, principal ID, contract revision, tool name, and canonicalized
arguments. That format exposed identities and argument values in cache-store
keys, grew without bound with argument size, and had no version marker. Any
change to canonicalization would silently redefine the key space: existing
entries would either become misses or, if semantics changed enough, collide with
entries written under the old rules.

## Decision

Cache keys are opaque, fixed-length, versioned digests:

```text
chainmcp:cache:v1:<64 lowercase hex characters>
```

`createCacheKey` canonicalizes the key material, enforces a 64 KiB limit
(`MAX_CACHE_KEY_INPUT_BYTES`) on the canonical JSON payload, hashes the payload
with SHA-256 under a versioned domain separator, and prefixes the digest with
`chainmcp:cache:v1:`. The version is exported as `CACHE_KEY_VERSION`.

Object properties whose value is `undefined` are omitted, matching JSON
serialization and normal TypeScript optional-field usage. `undefined` at the
root or in arrays, sparse arrays, cycles, non-finite numbers, and non-JSON
values remain rejected because they have no unambiguous JSON representation.

Any change to canonicalization, hashed fields, or digest encoding must increment
`CACHE_KEY_VERSION`. The prefix changes with the version so old entries become
misses rather than colliding with new semantics.

## Alternatives considered

- **Keep plaintext keys.** Rejected: exposes tenant and principal identifiers
  and raw arguments in the store, and produces keys as large as the input.
- **Prefix identities in plaintext and hash only arguments.** Rejected: still
  exposes identity data and tenant structure.
- **HMAC with a server-side secret.** Stronger against offline guessing of
  low-entropy identifiers and arguments, but requires shared secret
  distribution and rotation across every cache client. Deferred until the
  threat model requires it.
- **Compress the canonical payload.** Rejected: reduces size but still exposes
  recoverable identity and argument data and leaves key length variable.
- **Hash without a version prefix.** Rejected: cannot distinguish key
  generations after a semantic change.

## Consequences and trade-offs

- Store keys have a fixed, bounded size and do not directly contain identity or
  argument values.
- Keys can no longer be inspected or prefix-scanned by tenant in the store.
  Deployments that need tenant-scoped cleanup must use separate store
  namespaces or external metadata.
- Version bumps intentionally invalidate the cache. A rolling deployment may
  temporarily see misses across mixed versions.
- SHA-256 collisions are negligible for this use, but hashing is not
  encryption. Low-entropy identities or arguments may be guessable offline by
  an attacker who can read the store.

## Security implications

- Reduces accidental disclosure of PII and arguments through key listings,
  logs, and store tooling.
- Tenant and authorization partitioning remain part of the hashed material; a
  key cannot be reused across identities without changing the digest.
- Cache-store access controls, encryption at rest, and key redaction in logs are
  still required.
- Hashed keys must not be treated as secrets or as authorization credentials.

## Follow-up actions

- Use the opaque key format in concrete cache adapters.
- Add a key-version migration or drain procedure when bumping the version.
- Revisit HMAC/peppering if offline guessing becomes a credible threat.

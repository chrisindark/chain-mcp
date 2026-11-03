# ADR 0030 — Descriptor persistence, revision history, and rollback

- **Status:** accepted
- **Date:** 2026-11-02
- **Supersedes:** none
- **Related:** ADR 0026 (dynamic gateway), ADR 0028 (declarative descriptors), ADR 0029 (self-hosted admin surface)

## Context

ADR 0029 introduced the self-hosted declarative admin surface, but descriptor
sets and revision history lived only in process memory and the gateway registry.
A restart lost every published descriptor-backed tool, and the admin surface
could not roll back on its own. The post-1.0 roadmap requires descriptor
persistence with tenant ownership, revision history, and rollback, and
`ENT-04` in `docs/risk-register.md` remains open for that slice.

Two facts shape the decision:

- The gateway registry is also in memory. Durable descriptor records alone do
  not restore tools; startup must republish them.
- Descriptors are data, not code, and contain no credentials, but they define
  what an MCP caller can reach. The stored records are security-relevant
  configuration and need tenant scoping, integrity checks, and bounded size.

The project does not yet ship a database layer, and the open-source MVP must
not grow a hosted control plane.

## Decision

1. Add a `DescriptorRevisionStore` interface in `@chainmcp/admin`. Records are
   keyed by `(tenantId, contractName)` and carry an admin revision id, status,
   toolset hash, validated descriptor documents, per-tool revisions, the
   gateway revision binding, publisher id, and optional rollback target.
2. Status is `candidate | active | superseded | failed`. There is at most one
   active record per tenant/contract. Stores serialize mutations and reject
   duplicate ids, invalid transitions, and per-contract revision limits.
   A mutation is committed before it becomes visible: when a write fails,
   neither the in-memory state nor the snapshot file changes, and the store
   stays usable at its previous consistent snapshot.
3. Ship two implementations:
   - `InMemoryDescriptorRevisionStore`, the default, for tests and explicitly
     ephemeral deployments.
   - `FileDescriptorRevisionStore`, a versioned JSON snapshot written with
     `0600` permissions, a temporary sibling file, `fsync`, and atomic rename.
     It enforces byte and revision caps and validates the file schema on open.
     It is single-writer.
4. Give admin revisions their own `dset_…` id, distinct from the gateway
   `rev_…` id. The gateway revision id is recorded once activation succeeds and
   is linked from revision metadata (`adminRevisionId`).
5. Publish in three steps: write a `candidate` record, publish to the gateway,
   then mark the record active and supersede the previous active record. A
   gateway rejection marks the candidate `failed`; a store rejection prevents
   any gateway call.
6. Implement rollback as **republish**, not as gateway revision mutation:
   revalidate the stored descriptors against the current binding, publish them
   as a new gateway revision, and record a new admin revision with `rollbackOf`.
   This works after a restart, keeps history append-only, and reuses the same
   validation and audit path as publish.
7. Add `DeclarativeAdmin.restore()` to republish the active stored revision of
   every bound contract. It reports `restored`, `skipped`, and `failures`
   instead of throwing, and skips contracts whose gateway revision already
   serves the same toolset hash.
8. Validate store-level structure on write and read, and revalidate descriptor
   semantics on restore and rollback. The store never evaluates descriptors or
   performs network I/O.

## Alternatives considered

- **Persist only after gateway publication.** Rejected: a crash between the two
  steps would leave live tools with no durable record, and the admin surface
  could not reconstruct them.
- **Call `gateway.rollbackContract()`.** Rejected as the primary mechanism:
  gateway revisions disappear on restart, and rollback would fail exactly when
  recovery matters. Republishing from durable descriptors is simpler and keeps
  one code path.
- **Add SQLite or PostgreSQL immediately.** Deferred. It needs driver decisions,
  migrations, and multi-writer semantics. A store interface plus a file
  implementation closes the restart gap without committing the MVP to a
  database, and a database adapter can implement the same interface.
- **One file per revision.** Rejected for now: directory enumeration, partial
  writes, and ordering make atomicity harder than one versioned snapshot under
  the current revision caps.
- **Two-phase gateway commit with prepare/commit.** Rejected: the gateway
  activation is already atomic in memory; the remaining window is between
  processes, which a store-level journal would not close without cross-process
  locks.
- **Keep the admin revision id equal to the gateway revision id.** Rejected:
  the gateway id is only known after publication, but the candidate must be
  durable first. Two ids make the ordering explicit.

## Consequences

- Descriptor-backed tools survive an admin restart when the deployment wires a
  durable store and calls `restore()` after constructing the gateway.
- The file store rewrites the whole snapshot per mutation and caps history at
  100 revisions per contract by default. It is unsuitable for multiple writers
  or very large descriptor sets.
- A crash after `candidate` is written but before activation leaves an inert
  candidate record; it is never served and can be ignored or pruned by a future
  maintenance task.
- A store activation failure after a successful gateway publication leaves live
  tools with an unactivated record. The admin returns a storage error; the
  operator can republish or restart with restore. This window is documented
  rather than hidden.
- The gateway registry still starts empty, so `restore()` is mandatory for
  recovery. Deployments that do not call it keep the previous behavior.
- Rollback creates a new revision rather than reactivating the old gateway
  revision, so gateway history shows an additional activation.

## Security implications

- Store files contain descriptor documents only. Credentials, inbound
  identities, and admin tokens are never written.
- The file is created `0600` in an operator-controlled directory; the API
  never accepts a path. Descriptor-store paths are deployment configuration.
- Structural validation plus descriptor re-validation on restore and rollback
  make a tampered store fail closed instead of publishing unreviewed tools.
- Tenant scoping is enforced by the admin routes before store access, and the
  store API itself requires the tenant/contract pair, so a wrong pair returns
  no record.
- Revision, byte, descriptor, and body caps bound storage growth and validation
  work. The file store is not a rate limiter; operators still need one in front
  of publish.
- Audit events record admin and gateway revision ids, tenant, contract, tool
  count, and reason codes, but never descriptor contents beyond the per-tool
  revisions already returned by the revisions route.

## Follow-up actions

- Add a database-backed store adapter with migrations and multi-writer locking.
- Add revision pruning and retention policy enforcement.
- Add an admin audit sink adapter to the gateway's audit stream.
- Add a CLI command and configuration schema for the admin surface and store.
- Revisit trial invocation once an operator-as-caller model exists.

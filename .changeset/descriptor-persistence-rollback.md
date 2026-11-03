---
"@chainmcp/admin": minor
---

Persist declarative descriptor revisions with tenant ownership, revision
history, restart restore, and rollback. `DescriptorRevisionStore` records move
through `candidate → active → superseded/failed`, with admin `dset_…` ids linked
to gateway `rev_…` ids. The default in-memory store keeps prior behavior;
`FileDescriptorRevisionStore` writes a versioned, schema-validated JSON snapshot
with `0600` permissions, fsync, and atomic rename, and is single-writer.
Publication writes a candidate, publishes to the gateway, then activates it, so
a store rejection prevents publication and a gateway rejection marks the
candidate failed. `POST .../rollback` revalidates a stored superseded revision
and republishes it with `rollbackOf`, and `DeclarativeAdmin.restore()`
republishes active records after a restart. Persisted descriptors contain no
credentials and are revalidated on restore and rollback.

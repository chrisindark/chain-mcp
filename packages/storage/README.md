# @chainmcp/storage

Unified multi-driver persistence, key-value storage, payload/handle store, and telemetry buffering for ChainMcp.

## Capabilities

- **Zero-Native-Addon SQLite Driver (`node:sqlite`):** Runs on Node.js 22 built-in SQLite in WAL mode (`PRAGMA journal_mode = WAL;`) for safe, concurrent multi-process access across stdio MCP servers and Web Studio UIs without `SQLITE_BUSY` errors.
- **In-Memory Driver:** Zero-dependency, ephemeral driver for unit tests, CI pipelines, and stateless CLI validation.
- **Tenant-Scoped Key-Value Store:** Partitioned key-value storage for versioned manifests, revisions, and metadata with TTL expiration.
- **Bounded Blob Payload Store:** Opaque result handle storage (`json_create_handle`) with enforced byte caps and TTL expiration.
- **Non-blocking Telemetry Ring-Buffer:** Batched metric and log emission with automatic row capping and time-based retention pruning.

## Installation

```bash
pnpm add @chainmcp/storage
```

## Usage

```typescript
import {
  createSqliteStorageDriver,
  createMemoryStorageDriver,
} from "@chainmcp/storage";

// 1. Initialize local SQLite driver with WAL mode
const storage = createSqliteStorageDriver({
  path: "~/.chainmcp/studio.db",
});
await storage.init();

// 2. Tenant-scoped KeyValue store
const kv = storage.getKeyValueStore("contracts");
await kv.set("orders_v1", { title: "Order Service" }, { tenantId: "tenant-a" });
const contract = await kv.get("orders_v1", "tenant-a");

// 3. Blob payload store (handles)
const blobStore = storage.getBlobPayloadStore();
await blobStore.put("rhv1.123", JSON.stringify({ large: "payload" }), {
  tenantId: "tenant-a",
  ttlMs: 3600_000,
});
const blob = await blobStore.get("rhv1.123", { tenantId: "tenant-a" });

await storage.close();
```

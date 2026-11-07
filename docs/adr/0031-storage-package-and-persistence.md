# ADR 0031 — Unified persistence, storage drivers, and payload store

- **Status:** accepted
- **Date:** 2026-11-07
- **Supersedes:** none
- **Related:** ADR 0002 (shared runtime), ADR 0023 (JSON navigation & analytics), ADR 0026 (dynamic gateway), ADR 0030 (descriptor persistence and rollback)

## Context

Prior to this decision, ChainMcp handled persistence through two ad-hoc mechanisms:

1. In-memory maps and LRU registries (`ResultHandleRegistry` in `@chainmcp/json-navigation`, `ContractRegistry` in `@chainmcp/gateway`).
2. A single-writer flat JSON file snapshot (`FileDescriptorRevisionStore` in `@chainmcp/admin`).

While sufficient for single-process testing, this design has severe architectural limits as ChainMcp scales:

- Result handles created by `json_create_handle` expire or vanish when the server restarts, and cannot be referenced across multiple gateway worker processes.
- The single-writer JSON snapshot rewrites the entire file upon each revision, lacks concurrent writer arbitration, and cannot support multi-tenant query indexing.
- Invocation telemetry cannot be persisted locally without either using memory sinks (which vanish on exit) or blocking the execution path.
- The platform needs a persistent foundation for the upcoming Web Studio (`chainmcp studio`) where background stdio MCP servers, HTTP gateway instances, and the local web UI can read and write concurrently without locking conflicts.

Node.js 22.13+ is the required runtime baseline (`engines.node: ">=22.13"`). Node 22 provides built-in `node:sqlite`, enabling zero-native-addon local persistence.

## Decision

1. **Establish `@chainmcp/storage`:** Introduce a dedicated package encapsulating database drivers, key-value storage, blob/payload storage, and telemetry buffering behind uniform asynchronous interfaces.
2. **Multi-Driver Architecture:**
   - `StorageDriver`: Lifecycle and connection interface (`init()`, `close()`, `isHealthy()`).
   - `MemoryStorageDriver`: In-memory driver for unit tests, CI, and stateless ephemeral executions.
   - `SqliteStorageDriver` (Default Local): Built on Node.js native `node:sqlite` in **WAL (Write-Ahead Logging)** mode (`PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;`). This permits multiple concurrent reader processes (e.g. stdio servers and studio UI) and serialized writes without `SQLITE_BUSY` contention. Default database path is `~/.chainmcp/studio.db` (configurable).
   - `PostgresStorageDriver`: Driver contract for multi-replica cloud gateway deployments.
3. **Storage Interfaces:**
   - `KeyValueStore<T>`: Tenant-scoped, key-indexed store for structured documents (contracts, revisions, metadata) supporting `get()`, `set()`, `delete()`, `list()`.
   - `BlobPayloadStore`: Tenant- and principal-scoped storage for variable-size JSON payloads (`json_create_handle`) with enforced byte caps (`maxPayloadBytes`), TTL expiration, and automatic eviction.
   - `TelemetryRingBuffer`: Non-blocking, batched append buffer with automatic retention limits (row count cap, e.g. 10,000 records, or time-based TTL pruning).
4. **Data Isolation & Security Invariants:**
   - **Credentials at rest:** Sensitive credentials are never stored in plaintext columns. They must be encrypted using `@chainmcp/auth` (`EncryptedSecretStore`) with AES-256-GCM before passing to the storage driver. The storage layer stores only encrypted ciphertexts, IVs, and auth tags.
   - **Tenant Partitioning:** Every query and key resolution in multi-tenant mode strictly includes `tenantId`. Cross-tenant record leakage is prevented at the query level.
   - **Zero Blocking I/O:** All public driver methods are strictly asynchronous and return `Promise`s.

## Alternatives considered

- **Use `better-sqlite3`.** Rejected: requires native C++ compilation (`node-gyp`), which introduces build friction across macOS, Linux, and container environments. Built-in `node:sqlite` requires zero external compilation.
- **Adopt an ORM (Prisma, TypeORM, Drizzle).** Rejected: heavy dependencies, build overhead, and slow cold-start times. Parameterized SQL with explicit schema DDL provides minimal footprint and transparent debugging.
- **Keep flat JSON files.** Rejected: cannot support concurrent processes, WAL mode, or efficient range queries for telemetry and handle lookups.

## Consequences

- Result handles and admin revisions can safely survive process restarts.
- Multiple local MCP processes and the Web Studio can share `~/.chainmcp/studio.db` concurrently without file locking errors.
- Package boundaries remain clean: `@chainmcp/storage` depends only on `@chainmcp/core` and Node.js built-ins.

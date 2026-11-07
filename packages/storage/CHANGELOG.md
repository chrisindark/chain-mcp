# @chainmcp/storage

## 0.4.0

### Minor Changes

- Introduce `@chainmcp/storage` workspace package with `StorageDriver`, `KeyValueStore`, `BlobPayloadStore`, and `TelemetryRingBuffer` interfaces, providing `MemoryStorageDriver` and zero-native-addon `SqliteStorageDriver` (using Node.js 22 built-in `node:sqlite` in WAL mode) per ADR 0031.

### Patch Changes

- @chainmcp/core@0.4.0

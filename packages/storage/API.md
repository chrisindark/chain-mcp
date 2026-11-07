# API Reference: `@chainmcp/storage`

## Factory Functions

- `createMemoryStorageDriver(options?: MemoryStorageDriverOptions): MemoryStorageDriver`
- `createSqliteStorageDriver(options?: SqliteStorageDriverOptions): SqliteStorageDriver`

## Interfaces

### `StorageDriver`

- `id: string`
- `isConnected: boolean`
- `init(): Promise<void>`
- `close(): Promise<void>`
- `ping(): Promise<boolean>`
- `getKeyValueStore<T>(namespace: string): KeyValueStore<T>`
- `getBlobPayloadStore(namespace?: string): BlobPayloadStore`
- `getTelemetryRingBuffer(options?: TelemetryRingBufferOptions): TelemetryRingBuffer`

### `KeyValueStore<T>`

- `namespace: string`
- `get(key: string, tenantId?: string): Promise<T | null>`
- `set(key: string, value: T, options?: { tenantId?: string; ttlMs?: number }): Promise<void>`
- `delete(key: string, tenantId?: string): Promise<boolean>`
- `list(options?: { tenantId?: string; prefix?: string; limit?: number }): Promise<Array<{ key: string; value: T }>>`
- `clear(tenantId?: string): Promise<void>`

### `BlobPayloadStore`

- `namespace: string`
- `put(handle: string, data: string | Uint8Array, options?: BlobStorePutOptions): Promise<BlobPayload>`
- `get(handle: string, options?: { tenantId?: string; principalId?: string }): Promise<BlobPayload | null>`
- `delete(handle: string, options?: { tenantId?: string; principalId?: string }): Promise<boolean>`
- `pruneExpired(): Promise<number>`

### `TelemetryRingBuffer`

- `push(event: TelemetryEvent): Promise<void>`
- `pushBatch(events: TelemetryEvent[]): Promise<void>`
- `query(options?: TelemetryQueryOptions): Promise<TelemetryEvent[]>`
- `clear(tenantId?: string): Promise<void>`

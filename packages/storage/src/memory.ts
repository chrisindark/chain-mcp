import type {
  BlobPayload,
  BlobPayloadStore,
  BlobStorePutOptions,
  KeyValueStore,
  StorageDriver,
  TelemetryEvent,
  TelemetryQueryOptions,
  TelemetryRingBuffer,
  TelemetryRingBufferOptions,
} from "./types.js";
import { StoragePayloadTooLargeError } from "./types.js";

const DEFAULT_MAX_BLOB_BYTES = 10 * 1024 * 1024; // 10 MiB
const DEFAULT_MAX_TELEMETRY_ENTRIES = 10_000;

interface MemoryKVEntry {
  serializedValue: string;
  tenantId?: string | undefined;
  expiresAt?: number | undefined;
}

export class MemoryKeyValueStore<T = unknown> implements KeyValueStore<T> {
  private readonly store = new Map<string, MemoryKVEntry>();

  constructor(public readonly namespace: string) {}

  private buildKey(key: string, tenantId?: string): string {
    return tenantId ? `${tenantId}::${key}` : `__global__::${key}`;
  }

  public async get(key: string, tenantId?: string): Promise<T | null> {
    const compositeKey = this.buildKey(key, tenantId);
    const entry = this.store.get(compositeKey);
    if (!entry) {
      return null;
    }

    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this.store.delete(compositeKey);
      return null;
    }

    try {
      return JSON.parse(entry.serializedValue) as T;
    } catch {
      return null;
    }
  }

  public async set(
    key: string,
    value: T,
    options?: { tenantId?: string | undefined; ttlMs?: number | undefined },
  ): Promise<void> {
    const compositeKey = this.buildKey(key, options?.tenantId);
    const expiresAt = options?.ttlMs ? Date.now() + options.ttlMs : undefined;
    this.store.set(compositeKey, {
      serializedValue: JSON.stringify(value),
      tenantId: options?.tenantId,
      expiresAt,
    });
  }

  public async delete(key: string, tenantId?: string): Promise<boolean> {
    const compositeKey = this.buildKey(key, tenantId);
    return this.store.delete(compositeKey);
  }

  public async list(options?: {
    tenantId?: string | undefined;
    prefix?: string | undefined;
    limit?: number | undefined;
  }): Promise<Array<{ key: string; value: T }>> {
    const results: Array<{ key: string; value: T }> = [];
    const prefixTarget = options?.prefix ?? "";
    const limit = options?.limit ?? 100;
    const now = Date.now();

    for (const [compKey, entry] of this.store.entries()) {
      if (entry.expiresAt && now > entry.expiresAt) {
        this.store.delete(compKey);
        continue;
      }

      if (options?.tenantId && entry.tenantId !== options.tenantId) {
        continue;
      }
      if (!options?.tenantId && entry.tenantId) {
        continue;
      }

      const rawKey = entry.tenantId
        ? compKey.slice(entry.tenantId.length + 2)
        : compKey.slice("__global__::".length);

      if (prefixTarget && !rawKey.startsWith(prefixTarget)) {
        continue;
      }

      try {
        const val = JSON.parse(entry.serializedValue) as T;
        results.push({ key: rawKey, value: val });
        if (results.length >= limit) {
          break;
        }
      } catch {
        // Skip unparseable
      }
    }

    return results;
  }

  public async clear(tenantId?: string): Promise<void> {
    if (!tenantId) {
      this.store.clear();
      return;
    }
    for (const [compKey, entry] of this.store.entries()) {
      if (entry.tenantId === tenantId) {
        this.store.delete(compKey);
      }
    }
  }
}

export class MemoryBlobPayloadStore implements BlobPayloadStore {
  private readonly store = new Map<string, BlobPayload>();

  constructor(public readonly namespace: string = "default") {}

  private buildKey(handle: string, tenantId?: string): string {
    return tenantId ? `${tenantId}::${handle}` : `__global__::${handle}`;
  }

  public async put(
    handle: string,
    data: string | Uint8Array,
    options?: BlobStorePutOptions,
  ): Promise<BlobPayload> {
    const strData =
      typeof data === "string" ? data : new TextDecoder().decode(data);
    const byteSize = Buffer.byteLength(strData, "utf8");
    const maxBytes = options?.maxByteSize ?? DEFAULT_MAX_BLOB_BYTES;

    if (byteSize > maxBytes) {
      throw new StoragePayloadTooLargeError(byteSize, maxBytes);
    }

    const now = Date.now();
    const expiresAt = options?.ttlMs ? now + options.ttlMs : undefined;

    const payload: BlobPayload = {
      handle,
      data: strData,
      byteSize,
      tenantId: options?.tenantId,
      principalId: options?.principalId,
      createdAt: now,
      expiresAt,
    };

    const compKey = this.buildKey(handle, options?.tenantId);
    this.store.set(compKey, payload);
    return payload;
  }

  public async get(
    handle: string,
    options?: {
      tenantId?: string | undefined;
      principalId?: string | undefined;
    },
  ): Promise<BlobPayload | null> {
    const compKey = this.buildKey(handle, options?.tenantId);
    const payload = this.store.get(compKey);
    if (!payload) {
      return null;
    }

    if (payload.expiresAt && Date.now() > payload.expiresAt) {
      this.store.delete(compKey);
      return null;
    }

    if (options?.principalId && payload.principalId !== options.principalId) {
      return null;
    }

    return payload;
  }

  public async delete(
    handle: string,
    options?: {
      tenantId?: string | undefined;
      principalId?: string | undefined;
    },
  ): Promise<boolean> {
    const compKey = this.buildKey(handle, options?.tenantId);
    const existing = this.store.get(compKey);
    if (!existing) {
      return false;
    }
    if (options?.principalId && existing.principalId !== options.principalId) {
      return false;
    }
    return this.store.delete(compKey);
  }

  public async pruneExpired(): Promise<number> {
    const now = Date.now();
    let count = 0;
    for (const [key, payload] of this.store.entries()) {
      if (payload.expiresAt && now > payload.expiresAt) {
        this.store.delete(key);
        count++;
      }
    }
    return count;
  }
}

export class MemoryTelemetryRingBuffer implements TelemetryRingBuffer {
  private entries: TelemetryEvent[] = [];
  private readonly maxEntries: number;

  constructor(options?: TelemetryRingBufferOptions) {
    this.maxEntries = options?.maxEntries ?? DEFAULT_MAX_TELEMETRY_ENTRIES;
  }

  public async push(event: TelemetryEvent): Promise<void> {
    this.entries.push(event);
    if (this.entries.length > this.maxEntries) {
      this.entries.splice(0, this.entries.length - this.maxEntries);
    }
  }

  public async pushBatch(events: TelemetryEvent[]): Promise<void> {
    this.entries.push(...events);
    if (this.entries.length > this.maxEntries) {
      this.entries.splice(0, this.entries.length - this.maxEntries);
    }
  }

  public async query(
    options?: TelemetryQueryOptions,
  ): Promise<TelemetryEvent[]> {
    let result = this.entries;

    if (options?.tenantId) {
      result = result.filter((e) => e.tenantId === options.tenantId);
    }
    if (options?.toolName) {
      result = result.filter((e) => e.toolName === options.toolName);
    }
    if (options?.since !== undefined) {
      const since = options.since;
      result = result.filter((e) => e.timestamp >= since);
    }
    if (options?.until !== undefined) {
      const until = options.until;
      result = result.filter((e) => e.timestamp <= until);
    }
    if (options?.isError !== undefined) {
      const isErr = options.isError;
      result = result.filter((e) => (e.isError ?? false) === isErr);
    }

    if (options?.order === "desc") {
      result = [...result].sort((a, b) => b.timestamp - a.timestamp);
      const offset = options?.offset ?? 0;
      const limit = options?.limit ?? 100;
      return result.slice(offset, offset + limit);
    }

    const limit = options?.limit ?? 100;
    if (options?.offset !== undefined && options.offset > 0) {
      return result.slice(options.offset, options.offset + limit);
    }
    return result.slice(-limit);
  }

  public async clear(tenantId?: string): Promise<void> {
    if (!tenantId) {
      this.entries = [];
    } else {
      this.entries = this.entries.filter((e) => e.tenantId !== tenantId);
    }
  }
}

export class MemoryStorageDriver implements StorageDriver {
  public readonly id = "memory";
  public isConnected = false;

  private readonly kvStores = new Map<string, MemoryKeyValueStore<unknown>>();
  private readonly blobStores = new Map<string, MemoryBlobPayloadStore>();
  private telemetryBuffer: MemoryTelemetryRingBuffer | undefined = undefined;

  public async init(): Promise<void> {
    this.isConnected = true;
  }

  public async close(): Promise<void> {
    this.isConnected = false;
    this.kvStores.clear();
    this.blobStores.clear();
    this.telemetryBuffer = undefined;
  }

  public async ping(): Promise<boolean> {
    return this.isConnected;
  }

  public getKeyValueStore<T = unknown>(namespace: string): KeyValueStore<T> {
    let store = this.kvStores.get(namespace);
    if (!store) {
      store = new MemoryKeyValueStore<unknown>(namespace);
      this.kvStores.set(namespace, store);
    }
    return store as unknown as KeyValueStore<T>;
  }

  public getBlobPayloadStore(namespace: string = "default"): BlobPayloadStore {
    let store = this.blobStores.get(namespace);
    if (!store) {
      store = new MemoryBlobPayloadStore(namespace);
      this.blobStores.set(namespace, store);
    }
    return store;
  }

  public getTelemetryRingBuffer(
    options?: TelemetryRingBufferOptions,
  ): TelemetryRingBuffer {
    if (!this.telemetryBuffer) {
      this.telemetryBuffer = new MemoryTelemetryRingBuffer(options);
    }
    return this.telemetryBuffer;
  }
}

export function createMemoryStorageDriver(): MemoryStorageDriver {
  return new MemoryStorageDriver();
}

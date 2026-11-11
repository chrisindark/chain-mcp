export class StorageError extends Error {
  public readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StorageError";
    this.code = code;
  }
}

export class StoragePayloadTooLargeError extends StorageError {
  constructor(byteSize: number, maxBytes: number) {
    super(
      "PAYLOAD_TOO_LARGE",
      `Payload size of ${byteSize} bytes exceeds the maximum allowed limit of ${maxBytes} bytes`,
    );
  }
}

export interface StorageDriverOptions {
  path?: string | undefined;
  readOnly?: boolean | undefined;
}

export interface StorageDriver {
  readonly id: string;
  readonly isConnected: boolean;

  init(): Promise<void>;
  close(): Promise<void>;
  ping(): Promise<boolean>;

  getKeyValueStore<T = unknown>(namespace: string): KeyValueStore<T>;
  getBlobPayloadStore(namespace?: string): BlobPayloadStore;
  getTelemetryRingBuffer(
    options?: TelemetryRingBufferOptions,
  ): TelemetryRingBuffer;
}

export interface KeyValueStore<T = unknown> {
  readonly namespace: string;

  get(key: string, tenantId?: string): Promise<T | null>;
  set(
    key: string,
    value: T,
    options?: { tenantId?: string | undefined; ttlMs?: number | undefined },
  ): Promise<void>;
  delete(key: string, tenantId?: string): Promise<boolean>;
  list(options?: {
    tenantId?: string | undefined;
    prefix?: string | undefined;
    limit?: number | undefined;
  }): Promise<Array<{ key: string; value: T }>>;
  clear(tenantId?: string): Promise<void>;
}

export interface BlobPayload {
  handle: string;
  data: string;
  byteSize: number;
  tenantId?: string | undefined;
  principalId?: string | undefined;
  createdAt: number;
  expiresAt?: number | undefined;
}

export interface BlobStorePutOptions {
  tenantId?: string | undefined;
  principalId?: string | undefined;
  ttlMs?: number | undefined;
  maxByteSize?: number | undefined;
}

export interface BlobPayloadStore {
  readonly namespace: string;

  put(
    handle: string,
    data: string | Uint8Array,
    options?: BlobStorePutOptions,
  ): Promise<BlobPayload>;
  get(
    handle: string,
    options?: {
      tenantId?: string | undefined;
      principalId?: string | undefined;
    },
  ): Promise<BlobPayload | null>;
  delete(
    handle: string,
    options?: {
      tenantId?: string | undefined;
      principalId?: string | undefined;
    },
  ): Promise<boolean>;
  pruneExpired(): Promise<number>;
}

export interface TelemetryEvent {
  id: string;
  timestamp: number;
  tenantId?: string | undefined;
  toolName?: string | undefined;
  durationMs?: number | undefined;
  isError?: boolean | undefined;
  errorCode?: string | undefined;
  cached?: boolean | undefined;
  tokenCount?: number | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface TelemetryRingBufferOptions {
  maxEntries?: number | undefined;
  retentionMs?: number | undefined;
}

export interface TelemetryQueryOptions {
  tenantId?: string | undefined;
  toolName?: string | undefined;
  since?: number | undefined;
  until?: number | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
  isError?: boolean | undefined;
  order?: "asc" | "desc" | undefined;
}

export interface TelemetryRingBuffer {
  push(event: TelemetryEvent): Promise<void>;
  pushBatch(events: TelemetryEvent[]): Promise<void>;
  query(options?: TelemetryQueryOptions): Promise<TelemetryEvent[]>;
  clear(tenantId?: string): Promise<void>;
}

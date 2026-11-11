import { DatabaseSync } from "node:sqlite";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";

import type {
  BlobPayload,
  BlobPayloadStore,
  BlobStorePutOptions,
  KeyValueStore,
  StorageDriver,
  StorageDriverOptions,
  TelemetryEvent,
  TelemetryQueryOptions,
  TelemetryRingBuffer,
  TelemetryRingBufferOptions,
} from "./types.js";
import { StorageError, StoragePayloadTooLargeError } from "./types.js";

const DEFAULT_MAX_BLOB_BYTES = 10 * 1024 * 1024; // 10 MiB
const DEFAULT_MAX_TELEMETRY_ENTRIES = 10_000;

export interface SqliteStorageDriverOptions extends StorageDriverOptions {
  busyTimeoutMs?: number | undefined;
}

function resolveDbPath(inputPath?: string): string {
  if (!inputPath || inputPath === ":memory:") {
    return ":memory:";
  }
  if (inputPath.startsWith("~/")) {
    return resolve(homedir(), inputPath.slice(2));
  }
  return resolve(process.cwd(), inputPath);
}

export class SqliteKeyValueStore<T = unknown> implements KeyValueStore<T> {
  constructor(
    private readonly db: DatabaseSync,
    public readonly namespace: string,
  ) {}

  public async get(key: string, tenantId?: string): Promise<T | null> {
    const tid = tenantId ?? "";
    const stmt = this.db.prepare(`
      SELECT value, expires_at FROM chainmcp_kv
      WHERE namespace = ? AND tenant_id = ? AND key = ?
    `);
    const row = stmt.get(this.namespace, tid, key) as
      { value: string; expires_at: number | null } | undefined;

    if (!row) {
      return null;
    }

    if (row.expires_at !== null && Date.now() > row.expires_at) {
      const del = this.db.prepare(`
        DELETE FROM chainmcp_kv
        WHERE namespace = ? AND tenant_id = ? AND key = ?
      `);
      del.run(this.namespace, tid, key);
      return null;
    }

    try {
      return JSON.parse(row.value) as T;
    } catch {
      return null;
    }
  }

  public async set(
    key: string,
    value: T,
    options?: { tenantId?: string | undefined; ttlMs?: number | undefined },
  ): Promise<void> {
    const tid = options?.tenantId ?? "";
    const now = Date.now();
    const expiresAt = options?.ttlMs ? now + options.ttlMs : null;
    const serialized = JSON.stringify(value);

    const stmt = this.db.prepare(`
      INSERT INTO chainmcp_kv (namespace, tenant_id, key, value, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(namespace, tenant_id, key) DO UPDATE SET
        value = excluded.value,
        created_at = excluded.created_at,
        expires_at = excluded.expires_at
    `);
    stmt.run(this.namespace, tid, key, serialized, now, expiresAt);
  }

  public async delete(key: string, tenantId?: string): Promise<boolean> {
    const tid = tenantId ?? "";
    const stmt = this.db.prepare(`
      DELETE FROM chainmcp_kv
      WHERE namespace = ? AND tenant_id = ? AND key = ?
    `);
    const result = stmt.run(this.namespace, tid, key);
    return Number(result.changes) > 0;
  }

  public async list(options?: {
    tenantId?: string | undefined;
    prefix?: string | undefined;
    limit?: number | undefined;
  }): Promise<Array<{ key: string; value: T }>> {
    const tid = options?.tenantId ?? "";
    const limit = options?.limit ?? 100;
    const now = Date.now();
    const prefix = options?.prefix ?? "";

    const stmt = this.db.prepare(`
      SELECT key, value, expires_at FROM chainmcp_kv
      WHERE namespace = ? AND tenant_id = ? AND key LIKE ?
      ORDER BY key ASC
      LIMIT ?
    `);
    const rows = stmt.all(this.namespace, tid, `${prefix}%`, limit) as Array<{
      key: string;
      value: string;
      expires_at: number | null;
    }>;

    const results: Array<{ key: string; value: T }> = [];
    for (const row of rows) {
      if (row.expires_at !== null && now > row.expires_at) {
        continue;
      }
      try {
        results.push({
          key: row.key,
          value: JSON.parse(row.value) as T,
        });
      } catch {
        // Skip unparseable
      }
    }

    return results;
  }

  public async clear(tenantId?: string): Promise<void> {
    if (tenantId !== undefined) {
      const stmt = this.db.prepare(`
        DELETE FROM chainmcp_kv
        WHERE namespace = ? AND tenant_id = ?
      `);
      stmt.run(this.namespace, tenantId);
    } else {
      const stmt = this.db.prepare(`
        DELETE FROM chainmcp_kv
        WHERE namespace = ?
      `);
      stmt.run(this.namespace);
    }
  }
}

export class SqliteBlobPayloadStore implements BlobPayloadStore {
  constructor(
    private readonly db: DatabaseSync,
    public readonly namespace: string = "default",
  ) {}

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

    const tid = options?.tenantId ?? "";
    const pid = options?.principalId ?? null;
    const now = Date.now();
    const expiresAt = options?.ttlMs ? now + options.ttlMs : null;

    const stmt = this.db.prepare(`
      INSERT INTO chainmcp_blobs (namespace, handle, tenant_id, principal_id, data, byte_size, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(namespace, tenant_id, handle) DO UPDATE SET
        principal_id = excluded.principal_id,
        data = excluded.data,
        byte_size = excluded.byte_size,
        created_at = excluded.created_at,
        expires_at = excluded.expires_at
    `);
    stmt.run(
      this.namespace,
      handle,
      tid,
      pid,
      strData,
      byteSize,
      now,
      expiresAt,
    );

    return {
      handle,
      data: strData,
      byteSize,
      tenantId: options?.tenantId,
      principalId: options?.principalId,
      createdAt: now,
      expiresAt: expiresAt ?? undefined,
    };
  }

  public async get(
    handle: string,
    options?: {
      tenantId?: string | undefined;
      principalId?: string | undefined;
    },
  ): Promise<BlobPayload | null> {
    const tid = options?.tenantId ?? "";
    const stmt = this.db.prepare(`
      SELECT principal_id, data, byte_size, created_at, expires_at
      FROM chainmcp_blobs
      WHERE namespace = ? AND tenant_id = ? AND handle = ?
    `);
    const row = stmt.get(this.namespace, tid, handle) as
      | {
          principal_id: string | null;
          data: string;
          byte_size: number;
          created_at: number;
          expires_at: number | null;
        }
      | undefined;

    if (!row) {
      return null;
    }

    if (row.expires_at !== null && Date.now() > row.expires_at) {
      const del = this.db.prepare(`
        DELETE FROM chainmcp_blobs
        WHERE namespace = ? AND tenant_id = ? AND handle = ?
      `);
      del.run(this.namespace, tid, handle);
      return null;
    }

    if (options?.principalId && row.principal_id !== options.principalId) {
      return null;
    }

    return {
      handle,
      data: row.data,
      byteSize: row.byte_size,
      tenantId: options?.tenantId,
      principalId: row.principal_id ?? undefined,
      createdAt: row.created_at,
      expiresAt: row.expires_at ?? undefined,
    };
  }

  public async delete(
    handle: string,
    options?: {
      tenantId?: string | undefined;
      principalId?: string | undefined;
    },
  ): Promise<boolean> {
    const tid = options?.tenantId ?? "";
    if (options?.principalId) {
      const stmt = this.db.prepare(`
        DELETE FROM chainmcp_blobs
        WHERE namespace = ? AND tenant_id = ? AND handle = ? AND principal_id = ?
      `);
      const result = stmt.run(this.namespace, tid, handle, options.principalId);
      return Number(result.changes) > 0;
    } else {
      const stmt = this.db.prepare(`
        DELETE FROM chainmcp_blobs
        WHERE namespace = ? AND tenant_id = ? AND handle = ?
      `);
      const result = stmt.run(this.namespace, tid, handle);
      return Number(result.changes) > 0;
    }
  }

  public async pruneExpired(): Promise<number> {
    const stmt = this.db.prepare(`
      DELETE FROM chainmcp_blobs
      WHERE namespace = ? AND expires_at IS NOT NULL AND expires_at < ?
    `);
    const result = stmt.run(this.namespace, Date.now());
    return Number(result.changes);
  }
}

export class SqliteTelemetryRingBuffer implements TelemetryRingBuffer {
  private readonly maxEntries: number;

  constructor(
    private readonly db: DatabaseSync,
    options?: TelemetryRingBufferOptions,
  ) {
    this.maxEntries = options?.maxEntries ?? DEFAULT_MAX_TELEMETRY_ENTRIES;
  }

  public async push(event: TelemetryEvent): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO chainmcp_telemetry (id, timestamp, tenant_id, tool_name, duration_ms, is_error, error_code, cached, token_count, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      event.id,
      event.timestamp,
      event.tenantId ?? null,
      event.toolName ?? null,
      event.durationMs ?? null,
      event.isError ? 1 : 0,
      event.errorCode ?? null,
      event.cached ? 1 : 0,
      event.tokenCount ?? null,
      event.metadata ? JSON.stringify(event.metadata) : null,
    );

    this.pruneBuffer();
  }

  public async pushBatch(events: TelemetryEvent[]): Promise<void> {
    if (events.length === 0) return;

    this.db.exec("BEGIN TRANSACTION;");
    try {
      const stmt = this.db.prepare(`
        INSERT INTO chainmcp_telemetry (id, timestamp, tenant_id, tool_name, duration_ms, is_error, error_code, cached, token_count, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const event of events) {
        stmt.run(
          event.id,
          event.timestamp,
          event.tenantId ?? null,
          event.toolName ?? null,
          event.durationMs ?? null,
          event.isError ? 1 : 0,
          event.errorCode ?? null,
          event.cached ? 1 : 0,
          event.tokenCount ?? null,
          event.metadata ? JSON.stringify(event.metadata) : null,
        );
      }
      this.db.exec("COMMIT;");
    } catch (err) {
      this.db.exec("ROLLBACK;");
      throw err;
    }

    this.pruneBuffer();
  }

  private pruneBuffer(): void {
    const pruneStmt = this.db.prepare(`
      DELETE FROM chainmcp_telemetry
      WHERE id NOT IN (
        SELECT id FROM chainmcp_telemetry
        ORDER BY timestamp DESC
        LIMIT ?
      )
    `);
    pruneStmt.run(this.maxEntries);
  }

  public async query(
    options?: TelemetryQueryOptions,
  ): Promise<TelemetryEvent[]> {
    let sql = "SELECT * FROM chainmcp_telemetry WHERE 1=1";
    const params: Array<string | number> = [];

    if (options?.tenantId) {
      sql += " AND tenant_id = ?";
      params.push(options.tenantId);
    }
    if (options?.toolName) {
      sql += " AND tool_name = ?";
      params.push(options.toolName);
    }
    if (options?.since !== undefined) {
      sql += " AND timestamp >= ?";
      params.push(options.since);
    }
    if (options?.until !== undefined) {
      sql += " AND timestamp <= ?";
      params.push(options.until);
    }
    if (options?.isError !== undefined) {
      sql += " AND is_error = ?";
      params.push(options.isError ? 1 : 0);
    }

    const order = options?.order === "desc" ? "DESC" : "ASC";
    sql += ` ORDER BY timestamp ${order} LIMIT ?`;
    params.push(options?.limit ?? 100);

    if (options?.offset !== undefined && options.offset > 0) {
      sql += " OFFSET ?";
      params.push(options.offset);
    }

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as Array<{
      id: string;
      timestamp: number;
      tenant_id: string | null;
      tool_name: string | null;
      duration_ms: number | null;
      is_error: number;
      error_code: string | null;
      cached: number;
      token_count: number | null;
      metadata: string | null;
    }>;

    return rows.map((r) => ({
      id: r.id,
      timestamp: r.timestamp,
      tenantId: r.tenant_id ?? undefined,
      toolName: r.tool_name ?? undefined,
      durationMs: r.duration_ms ?? undefined,
      isError: r.is_error === 1,
      errorCode: r.error_code ?? undefined,
      cached: r.cached === 1,
      tokenCount: r.token_count ?? undefined,
      metadata: r.metadata ? JSON.parse(r.metadata) : undefined,
    }));
  }

  public async clear(tenantId?: string): Promise<void> {
    if (tenantId) {
      const stmt = this.db.prepare(
        "DELETE FROM chainmcp_telemetry WHERE tenant_id = ?",
      );
      stmt.run(tenantId);
    } else {
      this.db.exec("DELETE FROM chainmcp_telemetry;");
    }
  }
}

export class SqliteStorageDriver implements StorageDriver {
  public readonly id = "sqlite";
  public isConnected = false;

  private db: DatabaseSync | undefined = undefined;
  private readonly resolvedPath: string;
  private readonly busyTimeoutMs: number;

  private readonly kvStores = new Map<string, SqliteKeyValueStore<unknown>>();
  private readonly blobStores = new Map<string, SqliteBlobPayloadStore>();
  private telemetryBuffer: SqliteTelemetryRingBuffer | undefined = undefined;

  constructor(options?: SqliteStorageDriverOptions) {
    this.resolvedPath = resolveDbPath(options?.path);
    this.busyTimeoutMs = options?.busyTimeoutMs ?? 5000;
  }

  public async init(): Promise<void> {
    if (this.isConnected) {
      return;
    }

    if (this.resolvedPath !== ":memory:") {
      await mkdir(dirname(this.resolvedPath), { recursive: true });
    }

    try {
      this.db = new DatabaseSync(this.resolvedPath);

      if (this.resolvedPath !== ":memory:") {
        this.db.exec("PRAGMA journal_mode = WAL;");
        this.db.exec("PRAGMA synchronous = NORMAL;");
      }
      this.db.exec(`PRAGMA busy_timeout = ${this.busyTimeoutMs};`);
      this.db.exec("PRAGMA foreign_keys = ON;");

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS chainmcp_kv (
          namespace TEXT NOT NULL,
          tenant_id TEXT NOT NULL DEFAULT '',
          key TEXT NOT NULL,
          value TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          expires_at INTEGER,
          PRIMARY KEY (namespace, tenant_id, key)
        );
        CREATE INDEX IF NOT EXISTS idx_chainmcp_kv_exp ON chainmcp_kv (expires_at);

        CREATE TABLE IF NOT EXISTS chainmcp_blobs (
          namespace TEXT NOT NULL,
          handle TEXT NOT NULL,
          tenant_id TEXT NOT NULL DEFAULT '',
          principal_id TEXT,
          data TEXT NOT NULL,
          byte_size INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          expires_at INTEGER,
          PRIMARY KEY (namespace, tenant_id, handle)
        );
        CREATE INDEX IF NOT EXISTS idx_chainmcp_blobs_exp ON chainmcp_blobs (expires_at);

        CREATE TABLE IF NOT EXISTS chainmcp_telemetry (
          id TEXT PRIMARY KEY,
          timestamp INTEGER NOT NULL,
          tenant_id TEXT,
          tool_name TEXT,
          duration_ms REAL,
          is_error INTEGER NOT NULL DEFAULT 0,
          error_code TEXT,
          cached INTEGER NOT NULL DEFAULT 0,
          token_count INTEGER,
          metadata TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_chainmcp_telemetry_ts ON chainmcp_telemetry (timestamp);
        CREATE INDEX IF NOT EXISTS idx_chainmcp_telemetry_tenant ON chainmcp_telemetry (tenant_id);
      `);

      this.isConnected = true;
    } catch (err) {
      throw new StorageError(
        "SQLITE_INIT_FAILED",
        `Failed to initialize SQLite storage at '${this.resolvedPath}': ${(err as Error).message}`,
        { cause: err },
      );
    }
  }

  public async close(): Promise<void> {
    if (!this.isConnected || !this.db) {
      return;
    }
    this.isConnected = false;
    this.kvStores.clear();
    this.blobStores.clear();
    this.telemetryBuffer = undefined;
    this.db.close();
    this.db = undefined;
  }

  public async ping(): Promise<boolean> {
    if (!this.isConnected || !this.db) {
      return false;
    }
    try {
      const stmt = this.db.prepare("SELECT 1 as alive;");
      const res = stmt.get() as { alive: number } | undefined;
      return res?.alive === 1;
    } catch {
      return false;
    }
  }

  public getKeyValueStore<T = unknown>(namespace: string): KeyValueStore<T> {
    if (!this.db || !this.isConnected) {
      throw new StorageError(
        "NOT_CONNECTED",
        "Storage driver is not initialized",
      );
    }
    let store = this.kvStores.get(namespace);
    if (!store) {
      store = new SqliteKeyValueStore<unknown>(this.db, namespace);
      this.kvStores.set(namespace, store);
    }
    return store as unknown as KeyValueStore<T>;
  }

  public getBlobPayloadStore(namespace: string = "default"): BlobPayloadStore {
    if (!this.db || !this.isConnected) {
      throw new StorageError(
        "NOT_CONNECTED",
        "Storage driver is not initialized",
      );
    }
    let store = this.blobStores.get(namespace);
    if (!store) {
      store = new SqliteBlobPayloadStore(this.db, namespace);
      this.blobStores.set(namespace, store);
    }
    return store;
  }

  public getTelemetryRingBuffer(
    options?: TelemetryRingBufferOptions,
  ): TelemetryRingBuffer {
    if (!this.db || !this.isConnected) {
      throw new StorageError(
        "NOT_CONNECTED",
        "Storage driver is not initialized",
      );
    }
    if (!this.telemetryBuffer) {
      this.telemetryBuffer = new SqliteTelemetryRingBuffer(this.db, options);
    }
    return this.telemetryBuffer;
  }
}

export function createSqliteStorageDriver(
  options?: SqliteStorageDriverOptions,
): SqliteStorageDriver {
  return new SqliteStorageDriver(options);
}

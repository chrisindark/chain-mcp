import * as net from "node:net";
import * as tls from "node:tls";
import type { RedisCacheClient } from "./index.js";

export interface SimpleRedisTlsOptions {
  ca?: string | Buffer | undefined;
  cert?: string | Buffer | undefined;
  key?: string | Buffer | undefined;
  rejectUnauthorized?: boolean | undefined;
  servername?: string | undefined;
}

export interface SimpleRedisOptions {
  url?: string | undefined;
  host?: string | undefined;
  port?: number | undefined;
  username?: string | undefined;
  password?: string | undefined;
  database?: number | undefined;
  timeoutMs?: number | undefined;
  tls?: boolean | SimpleRedisTlsOptions | undefined;
  ca?: string | Buffer | undefined;
  cert?: string | Buffer | undefined;
  key?: string | Buffer | undefined;
  rejectUnauthorized?: boolean | undefined;
  minConnections?: number | undefined;
  maxConnections?: number | undefined;
  maxRetries?: number | undefined;
  retryBaseMs?: number | undefined;
  retryCapMs?: number | undefined;
  healthCheckOnCheckout?: boolean | undefined;
  createSocket?:
    | ((
        isTls: boolean,
        options: {
          host: string;
          port: number;
          tlsOptions: tls.ConnectionOptions;
        },
      ) => net.Socket)
    | undefined;
}

export interface SimpleRedisClientStatus {
  totalConnections: number;
  idleConnections: number;
  activeConnections: number;
  waitQueueLength: number;
  isClosed: boolean;
}

export interface SimpleRedisClient extends RedisCacheClient {
  eval(script: string, keys: string[], args: string[]): Promise<unknown>;
  close(): Promise<void>;
  disconnect(): Promise<void>;
  getStatus(): SimpleRedisClientStatus;
}

/**
 * Redacts credentials from a Redis URL string for safe logging and error reporting.
 */
export function redactRedisUrl(urlString: string): string {
  try {
    const parsed = new URL(urlString);
    if (parsed.password) {
      parsed.password = "REDACTED";
    }
    if (parsed.username && parsed.username !== "default") {
      parsed.username = "REDACTED";
    }
    return parsed.toString();
  } catch {
    return "[REDACTED_URL]";
  }
}

/**
 * Replaces any occurrence of secrets in the given string with [REDACTED].
 */
export function sanitizeString(
  input: string,
  secrets: readonly string[],
): string {
  let result = input;
  for (const secret of secrets) {
    if (secret && secret.length > 0) {
      result = result.split(secret).join("[REDACTED]");
      const encoded = encodeURIComponent(secret);
      if (encoded !== secret) {
        result = result.split(encoded).join("[REDACTED]");
      }
    }
  }
  return result;
}

/**
 * Sanitizes message, stack, and cause of an error to ensure credentials are never leaked.
 */
export function sanitizeError(err: Error, secrets: readonly string[]): Error {
  const sanitized = sanitizeString(err.message, secrets);
  if (sanitized !== err.message) {
    err.message = sanitized;
  }
  if (err.stack) {
    err.stack = sanitizeString(err.stack, secrets);
  }
  if (err.cause instanceof Error) {
    sanitizeError(err.cause, secrets);
  }
  return err;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface ResolvedRedisConfig {
  host: string;
  port: number;
  username?: string | undefined;
  password?: string | undefined;
  database: number;
  isTls: boolean;
  tlsOptions: tls.ConnectionOptions;
  timeoutMs: number;
  minConnections: number;
  maxConnections: number;
  maxRetries: number;
  retryBaseMs: number;
  retryCapMs: number;
  healthCheckOnCheckout: boolean;
  secrets: string[];
  createSocket?:
    | ((
        isTls: boolean,
        options: {
          host: string;
          port: number;
          tlsOptions: tls.ConnectionOptions;
        },
      ) => net.Socket)
    | undefined;
}

function resolveRedisConfig(
  urlOrOptions: string | SimpleRedisOptions,
): ResolvedRedisConfig {
  let host = "127.0.0.1";
  let port = 6379;
  let username: string | undefined;
  let password: string | undefined;
  let database = 0;
  let isTls = false;
  let timeoutMs = 2000;
  let minConnections = 0;
  let maxConnections = 4;
  let maxRetries = 3;
  let retryBaseMs = 50;
  let retryCapMs = 1000;
  let healthCheckOnCheckout = true;
  let createSocket:
    | ((
        isTls: boolean,
        options: {
          host: string;
          port: number;
          tlsOptions: tls.ConnectionOptions;
        },
      ) => net.Socket)
    | undefined;
  const secrets: string[] = [];

  const rawUrl =
    typeof urlOrOptions === "string" ? urlOrOptions : urlOrOptions.url;

  let urlTlsOptions: tls.ConnectionOptions = {};

  if (rawUrl) {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new TypeError("Invalid Redis connection URL");
    }

    if (parsed.protocol !== "redis:" && parsed.protocol !== "rediss:") {
      throw new TypeError(
        `Invalid Redis URL protocol: '${parsed.protocol}' (expected 'redis:' or 'rediss:')`,
      );
    }

    if (parsed.protocol === "rediss:") {
      isTls = true;
    }

    host = parsed.hostname || "127.0.0.1";
    if (parsed.port) {
      const p = Number.parseInt(parsed.port, 10);
      if (Number.isNaN(p) || p < 1 || p > 65535) {
        throw new TypeError(`Invalid Redis URL port: '${parsed.port}'`);
      }
      port = p;
    }

    if (parsed.username) {
      const u = decodeURIComponent(parsed.username);
      if (u.length > 0) username = u;
    }

    if (parsed.password) {
      password = decodeURIComponent(parsed.password);
      secrets.push(password);
      if (parsed.password !== password) {
        secrets.push(parsed.password);
      }
    }

    // Pathname check (database index)
    if (parsed.pathname && parsed.pathname !== "" && parsed.pathname !== "/") {
      const dbMatch = /^\/(\d+)$/.exec(parsed.pathname);
      if (!dbMatch) {
        throw new TypeError(
          `Invalid Redis URL path: '${parsed.pathname}'. Only numeric database index (e.g. /0 or /1) is supported`,
        );
      }
      database = Number.parseInt(dbMatch[1]!, 10);
    }

    // Query parameters
    for (const [key, val] of parsed.searchParams) {
      switch (key) {
        case "timeoutMs": {
          const t = Number.parseInt(val, 10);
          if (t > 0) timeoutMs = t;
          break;
        }
        case "rejectUnauthorized":
          urlTlsOptions.rejectUnauthorized = val !== "false";
          break;
        case "maxConnections": {
          const m = Number.parseInt(val, 10);
          if (m > 0) maxConnections = m;
          break;
        }
        case "database":
        case "db": {
          const d = Number.parseInt(val, 10);
          if (!Number.isNaN(d) && d >= 0) database = d;
          break;
        }
        default:
          throw new TypeError(
            `Unsupported Redis URL query parameter: '${key}'`,
          );
      }
    }
  }

  // Explicit options overrides
  if (typeof urlOrOptions === "object" && urlOrOptions !== null) {
    if (urlOrOptions.host) host = urlOrOptions.host;
    if (urlOrOptions.port) {
      if (urlOrOptions.port < 1 || urlOrOptions.port > 65535) {
        throw new TypeError(`Invalid Redis port: ${urlOrOptions.port}`);
      }
      port = urlOrOptions.port;
    }
    if (urlOrOptions.username !== undefined) username = urlOrOptions.username;
    if (urlOrOptions.password !== undefined) {
      password = urlOrOptions.password;
      secrets.push(password);
    }
    if (urlOrOptions.database !== undefined) database = urlOrOptions.database;
    if (urlOrOptions.timeoutMs !== undefined)
      timeoutMs = urlOrOptions.timeoutMs;
    if (urlOrOptions.minConnections !== undefined) {
      minConnections = urlOrOptions.minConnections;
    }
    if (urlOrOptions.maxConnections !== undefined) {
      maxConnections = urlOrOptions.maxConnections;
    }
    if (urlOrOptions.maxRetries !== undefined) {
      maxRetries = urlOrOptions.maxRetries;
    }
    if (urlOrOptions.retryBaseMs !== undefined) {
      retryBaseMs = urlOrOptions.retryBaseMs;
    }
    if (urlOrOptions.retryCapMs !== undefined) {
      retryCapMs = urlOrOptions.retryCapMs;
    }
    if (urlOrOptions.healthCheckOnCheckout !== undefined) {
      healthCheckOnCheckout = urlOrOptions.healthCheckOnCheckout;
    }
    if (urlOrOptions.createSocket !== undefined) {
      createSocket = urlOrOptions.createSocket;
    }

    if (urlOrOptions.tls) {
      isTls = true;
      if (typeof urlOrOptions.tls === "object") {
        urlTlsOptions = { ...urlTlsOptions, ...urlOrOptions.tls };
      }
    }
    if (urlOrOptions.ca !== undefined) urlTlsOptions.ca = urlOrOptions.ca;
    if (urlOrOptions.cert !== undefined) urlTlsOptions.cert = urlOrOptions.cert;
    if (urlOrOptions.key !== undefined) urlTlsOptions.key = urlOrOptions.key;
    if (urlOrOptions.rejectUnauthorized !== undefined) {
      urlTlsOptions.rejectUnauthorized = urlOrOptions.rejectUnauthorized;
    }
  }

  const tlsOptions: tls.ConnectionOptions = {
    host,
    port,
    servername: urlTlsOptions.servername ?? (net.isIP(host) ? undefined : host),
    rejectUnauthorized: urlTlsOptions.rejectUnauthorized ?? true,
    ...urlTlsOptions,
  };

  return {
    host,
    port,
    ...(username !== undefined ? { username } : {}),
    ...(password !== undefined ? { password } : {}),
    database,
    isTls,
    tlsOptions,
    timeoutMs,
    minConnections,
    maxConnections,
    maxRetries,
    retryBaseMs,
    retryCapMs,
    healthCheckOnCheckout,
    secrets,
    ...(createSocket !== undefined ? { createSocket } : {}),
  };
}

class PooledConnection {
  public inUse = false;
  public lastActiveAt = Date.now();
  public destroyed = false;
  private buffer = Buffer.alloc(0);
  private currentCommand?:
    | {
        resolve: (val: unknown) => void;
        reject: (err: Error) => void;
        timer: NodeJS.Timeout;
      }
    | undefined;

  constructor(
    public readonly socket: net.Socket,
    private readonly secrets: readonly string[],
  ) {
    socket.setKeepAlive(true, 30_000);
    socket.setNoDelay(true);

    socket.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.tryParseResponse();
    });

    socket.on("error", (err) => {
      this.handleSocketTermination(err);
    });

    socket.on("close", () => {
      this.handleSocketTermination();
    });
  }

  isAlive(): boolean {
    return !this.destroyed && !this.socket.destroyed && this.socket.writable;
  }

  private tryParseResponse(): void {
    if (!this.currentCommand) return;
    try {
      const parsed = parseResp(this.buffer, this.secrets);
      if (parsed !== undefined) {
        this.buffer = this.buffer.subarray(parsed.offset);
        const cmd = this.currentCommand;
        this.currentCommand = undefined;
        clearTimeout(cmd.timer);
        if (parsed.error) {
          cmd.reject(parsed.error);
        } else {
          cmd.resolve(parsed.value);
        }
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.handleSocketTermination(error);
    }
  }

  private handleSocketTermination(err?: Error): void {
    this.destroyed = true;
    if (this.currentCommand) {
      const cmd = this.currentCommand;
      this.currentCommand = undefined;
      clearTimeout(cmd.timer);
      const reportedError =
        err ?? new Error("Redis connection closed prematurely");
      cmd.reject(sanitizeError(reportedError, this.secrets));
    }
  }

  async execute(args: readonly string[], timeoutMs: number): Promise<unknown> {
    if (!this.isAlive()) {
      throw new Error("Redis connection is closed");
    }
    if (this.currentCommand !== undefined) {
      throw new Error("Redis connection is busy");
    }

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.destroy();
        reject(new Error(`Redis command timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.currentCommand = { resolve, reject, timer };

      let resp = `*${args.length}\r\n`;
      for (const arg of args) {
        const byteLen = Buffer.byteLength(arg, "utf8");
        resp += `$${byteLen}\r\n${arg}\r\n`;
      }
      this.socket.write(resp);
    });
  }

  async ping(timeoutMs = 500): Promise<void> {
    const res = await this.execute(["PING"], timeoutMs);
    if (res !== "PONG") {
      throw new Error(`Unexpected Redis PING response: ${String(res)}`);
    }
  }

  destroy(): void {
    this.destroyed = true;
    if (this.currentCommand) {
      const cmd = this.currentCommand;
      this.currentCommand = undefined;
      clearTimeout(cmd.timer);
      cmd.reject(new Error("Redis connection destroyed"));
    }
    this.socket.removeAllListeners();
    this.socket.destroy();
  }
}

class ConnectionPool {
  private idleConnections: PooledConnection[] = [];
  private allConnections = new Set<PooledConnection>();
  private pendingConnecting = 0;
  private waitQueue: Array<{
    resolve: (conn: PooledConnection) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];
  private isClosed = false;

  constructor(private readonly config: ResolvedRedisConfig) {}

  private async rawConnect(): Promise<PooledConnection> {
    const {
      isTls,
      host,
      port,
      tlsOptions,
      username,
      password,
      database,
      timeoutMs,
      secrets,
      createSocket,
    } = this.config;

    const socket = await new Promise<net.Socket>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          sock.destroy();
          reject(new Error(`Redis connection timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);

      const sock: net.Socket = createSocket
        ? createSocket(isTls, { host, port, tlsOptions })
        : isTls
          ? tls.connect(tlsOptions)
          : net.connect({ host, port });

      const event = isTls ? "secureConnect" : "connect";

      sock.once(event, () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(sock);
        }
      });

      sock.once("error", (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          sock.destroy();
          reject(sanitizeError(err, secrets));
        }
      });
    });

    const conn = new PooledConnection(socket, secrets);

    try {
      // AUTH if credentials present
      if (password) {
        if (username) {
          await conn.execute(["AUTH", username, password], timeoutMs);
        } else {
          await conn.execute(["AUTH", password], timeoutMs);
        }
      }

      // SELECT database if non-zero
      if (database > 0) {
        await conn.execute(["SELECT", String(database)], timeoutMs);
      }
    } catch (err) {
      conn.destroy();
      const rawError = err instanceof Error ? err : new Error(String(err));
      throw sanitizeError(rawError, secrets);
    }

    return conn;
  }

  private async createConnectionWithBackoff(): Promise<PooledConnection> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      if (this.isClosed) {
        throw new Error("Redis client is closed");
      }
      try {
        const conn = await this.rawConnect();
        this.allConnections.add(conn);
        return conn;
      } catch (err) {
        const raw = err instanceof Error ? err : new Error(String(err));
        lastError = sanitizeError(raw, this.config.secrets);

        // Do not retry on auth failure
        if (
          lastError.message.includes("WRONGPASS") ||
          lastError.message.includes("NOAUTH") ||
          lastError.message.includes("ERR invalid password")
        ) {
          throw lastError;
        }

        if (attempt < this.config.maxRetries) {
          const jitter = Math.random() * 20;
          const delay =
            Math.min(
              this.config.retryCapMs,
              this.config.retryBaseMs * Math.pow(2, attempt),
            ) + jitter;
          await sleep(delay);
        }
      }
    }
    throw lastError ?? new Error("Failed to connect to Redis");
  }

  async acquire(): Promise<PooledConnection> {
    if (this.isClosed) {
      throw new Error("Redis client is closed");
    }

    // Check idle connections
    while (this.idleConnections.length > 0) {
      const conn = this.idleConnections.pop()!;
      if (!conn.isAlive()) {
        this.destroyConnection(conn);
        continue;
      }
      if (this.config.healthCheckOnCheckout) {
        try {
          await conn.ping();
        } catch {
          this.destroyConnection(conn);
          continue;
        }
      }
      conn.inUse = true;
      conn.lastActiveAt = Date.now();
      return conn;
    }

    // Create a new connection if under capacity (counting in-flight connects)
    if (
      this.allConnections.size + this.pendingConnecting <
      this.config.maxConnections
    ) {
      this.pendingConnecting++;
      try {
        const conn = await this.createConnectionWithBackoff();
        conn.inUse = true;
        conn.lastActiveAt = Date.now();
        return conn;
      } finally {
        this.pendingConnecting--;
      }
    }

    // Pool capacity reached: wait in queue
    return new Promise<PooledConnection>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waitQueue.findIndex((w) => w.timer === timer);
        if (idx !== -1) {
          this.waitQueue.splice(idx, 1);
          reject(
            new Error(
              "Redis connection pool exhausted (timeout waiting for connection)",
            ),
          );
        }
      }, this.config.timeoutMs);

      this.waitQueue.push({ resolve, reject, timer });
    });
  }

  release(conn: PooledConnection): void {
    conn.inUse = false;
    conn.lastActiveAt = Date.now();

    if (this.isClosed || !conn.isAlive()) {
      this.destroyConnection(conn);
      return;
    }

    while (this.waitQueue.length > 0) {
      const waiter = this.waitQueue.shift()!;
      clearTimeout(waiter.timer);
      conn.inUse = true;
      waiter.resolve(conn);
      return;
    }

    this.idleConnections.push(conn);
  }

  destroyConnection(conn: PooledConnection): void {
    conn.destroy();
    this.allConnections.delete(conn);
    const idx = this.idleConnections.indexOf(conn);
    if (idx !== -1) {
      this.idleConnections.splice(idx, 1);
    }
  }

  async executeCommand(args: readonly string[]): Promise<unknown> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      if (this.isClosed) {
        throw new Error("Redis client is closed");
      }
      let conn: PooledConnection | undefined;
      try {
        conn = await this.acquire();
        const res = await conn.execute(args, this.config.timeoutMs);
        this.release(conn);
        return res;
      } catch (err) {
        if (conn) {
          this.destroyConnection(conn);
        }
        const raw = err instanceof Error ? err : new Error(String(err));
        lastError = sanitizeError(raw, this.config.secrets);

        // Do not retry on client closed or normal Redis command error (syntax, type, etc)
        if (
          this.isClosed ||
          raw.message.includes("Redis error:") ||
          raw.message.includes("timed out")
        ) {
          throw lastError;
        }

        // Dropped connection / network reset: retry with backoff
        if (attempt < this.config.maxRetries) {
          const jitter = Math.random() * 20;
          const delay =
            Math.min(
              this.config.retryCapMs,
              this.config.retryBaseMs * Math.pow(2, attempt),
            ) + jitter;
          await sleep(delay);
          continue;
        }
        throw lastError;
      }
    }
    throw lastError ?? new Error("Redis command failed");
  }

  async drain(): Promise<void> {
    if (this.isClosed) return;
    this.isClosed = true;

    for (const waiter of this.waitQueue) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("Redis client is closed"));
    }
    this.waitQueue = [];

    for (const conn of this.idleConnections) {
      conn.destroy();
      this.allConnections.delete(conn);
    }
    this.idleConnections = [];

    if (this.allConnections.size > 0) {
      const drainTimeout = 500;
      const start = Date.now();
      while (
        this.allConnections.size > 0 &&
        Date.now() - start < drainTimeout
      ) {
        await sleep(10);
      }
      for (const conn of this.allConnections) {
        conn.destroy();
      }
      this.allConnections.clear();
    }
  }

  getStatus(): SimpleRedisClientStatus {
    const idle = this.idleConnections.length;
    const total = this.allConnections.size;
    return {
      totalConnections: total,
      idleConnections: idle,
      activeConnections: total - idle,
      waitQueueLength: this.waitQueue.length,
      isClosed: this.isClosed,
    };
  }
}

/**
 * Creates a zero-dependency Redis client implementing RedisCacheClient and eval
 * using the standard Redis Serialization Protocol (RESP2) over a Node socket,
 * with connection pooling, reconnect backoff, TLS, and credential redaction.
 */
export function createSimpleRedisClient(
  urlOrOptions: string | SimpleRedisOptions,
): SimpleRedisClient {
  const config = resolveRedisConfig(urlOrOptions);
  const pool = new ConnectionPool(config);

  return {
    async get(key: string): Promise<string | null | undefined> {
      const res = await pool.executeCommand(["GET", key]);
      if (res === null || res === undefined) return null;
      return String(res);
    },

    async set(
      key: string,
      value: string,
      ttlMilliseconds: number,
    ): Promise<unknown> {
      return await pool.executeCommand([
        "SET",
        key,
        value,
        "PX",
        String(ttlMilliseconds),
      ]);
    },

    async delete(key: string): Promise<unknown> {
      return await pool.executeCommand(["DEL", key]);
    },

    async eval(
      script: string,
      keys: string[],
      args: string[],
    ): Promise<unknown> {
      return await pool.executeCommand([
        "EVAL",
        script,
        String(keys.length),
        ...keys,
        ...args,
      ]);
    },

    async close(): Promise<void> {
      await pool.drain();
    },

    async disconnect(): Promise<void> {
      await pool.drain();
    },

    getStatus(): SimpleRedisClientStatus {
      return pool.getStatus();
    },
  };
}

export const createSimpleRedisCacheClient = createSimpleRedisClient;

interface ParsedResp {
  value: unknown;
  error?: Error | undefined;
  offset: number;
}

function parseResp(
  buf: Buffer,
  secrets: readonly string[],
): ParsedResp | undefined {
  return parseRespValue(buf, 0, secrets);
}

function parseRespValue(
  buf: Buffer,
  offset: number,
  secrets: readonly string[],
): ParsedResp | undefined {
  if (offset >= buf.length) return undefined;
  const prefix = String.fromCharCode(buf[offset]!);

  const crlf = buf.indexOf("\r\n", offset);
  if (crlf === -1) return undefined;

  const line = buf.toString("utf8", offset + 1, crlf);
  const next = crlf + 2;

  switch (prefix) {
    case "+": // Simple string
      return { value: line, offset: next };
    case "-": {
      // Error
      const sanitized = sanitizeString(line, secrets);
      return {
        value: undefined,
        error: new Error(`Redis error: ${sanitized}`),
        offset: next,
      };
    }
    case ":": // Integer
      return { value: Number.parseInt(line, 10), offset: next };
    case "$": {
      // Bulk string
      const len = Number.parseInt(line, 10);
      if (len === -1) {
        return { value: null, offset: next };
      }
      if (buf.length < next + len + 2) return undefined;
      const val = buf.toString("utf8", next, next + len);
      return { value: val, offset: next + len + 2 };
    }
    case "*": {
      // Array
      const count = Number.parseInt(line, 10);
      if (count === -1) {
        return { value: null, offset: next };
      }
      const items: unknown[] = [];
      let cursor = next;
      for (let i = 0; i < count; i++) {
        const item = parseRespValue(buf, cursor, secrets);
        if (item === undefined) return undefined;
        if (item.error) {
          return { value: undefined, error: item.error, offset: item.offset };
        }
        items.push(item.value);
        cursor = item.offset;
      }
      return { value: items, offset: cursor };
    }
    default:
      throw new Error(`Unsupported RESP type prefix: '${prefix}'`);
  }
}

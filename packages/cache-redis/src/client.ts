import { Socket } from "node:net";
import type { RedisCacheClient } from "./index.js";

export interface SimpleRedisOptions {
  url?: string | undefined;
  host?: string | undefined;
  port?: number | undefined;
  password?: string | undefined;
  timeoutMs?: number | undefined;
}

export interface SimpleRedisClient extends RedisCacheClient {
  eval(script: string, keys: string[], args: string[]): Promise<unknown>;
}

/**
 * Creates a zero-dependency Redis client implementing RedisCacheClient and eval
 * using the standard Redis Serialization Protocol (RESP2) over a Node socket.
 */
export function createSimpleRedisClient(
  urlOrOptions: string | SimpleRedisOptions,
): SimpleRedisClient {
  let host = "127.0.0.1";
  let port = 6379;
  let password: string | undefined;
  let timeoutMs = 2000;

  if (typeof urlOrOptions === "string") {
    const parsed = new URL(urlOrOptions);
    host = parsed.hostname || "127.0.0.1";
    port = parsed.port ? Number.parseInt(parsed.port, 10) : 6379;
    if (parsed.password) password = decodeURIComponent(parsed.password);
  } else {
    if (urlOrOptions.url) {
      const parsed = new URL(urlOrOptions.url);
      host = parsed.hostname || "127.0.0.1";
      port = parsed.port ? Number.parseInt(parsed.port, 10) : 6379;
      if (parsed.password) password = decodeURIComponent(parsed.password);
    }
    if (urlOrOptions.host) host = urlOrOptions.host;
    if (urlOrOptions.port) port = urlOrOptions.port;
    if (urlOrOptions.password) password = urlOrOptions.password;
    if (urlOrOptions.timeoutMs) timeoutMs = urlOrOptions.timeoutMs;
  }

  async function executeCommand(args: string[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const socket = new Socket();
      let buffer = Buffer.alloc(0);
      let settled = false;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          socket.destroy();
          reject(new Error(`Redis command timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);

      function cleanup() {
        clearTimeout(timer);
        socket.removeAllListeners();
        socket.destroy();
      }

      function sendArgs(commandArgs: string[]) {
        let resp = `*${commandArgs.length}\r\n`;
        for (const arg of commandArgs) {
          const byteLen = Buffer.byteLength(arg, "utf8");
          resp += `$${byteLen}\r\n${arg}\r\n`;
        }
        socket.write(resp);
      }

      socket.connect(port, host, () => {
        if (password) {
          sendArgs(["AUTH", password]);
        }
        sendArgs(args);
      });

      socket.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        try {
          const parsed = parseResp(buffer, password ? 2 : 1);
          if (parsed !== undefined) {
            settled = true;
            cleanup();
            resolve(parsed);
          }
        } catch (err) {
          settled = true;
          cleanup();
          reject(err);
        }
      });

      socket.on("error", (err) => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(err);
        }
      });

      socket.on("close", () => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(new Error("Redis connection closed prematurely"));
        }
      });
    });
  }

  return {
    async get(key: string): Promise<string | null | undefined> {
      const res = await executeCommand(["GET", key]);
      if (res === null || res === undefined) return null;
      return String(res);
    },

    async set(
      key: string,
      value: string,
      ttlMilliseconds: number,
    ): Promise<unknown> {
      return await executeCommand([
        "SET",
        key,
        value,
        "PX",
        String(ttlMilliseconds),
      ]);
    },

    async delete(key: string): Promise<unknown> {
      return await executeCommand(["DEL", key]);
    },

    async eval(
      script: string,
      keys: string[],
      args: string[],
    ): Promise<unknown> {
      return await executeCommand([
        "EVAL",
        script,
        String(keys.length),
        ...keys,
        ...args,
      ]);
    },
  };
}

export const createSimpleRedisCacheClient = createSimpleRedisClient;

function parseResp(buf: Buffer, expectedResponses = 1): unknown | undefined {
  let offset = 0;
  let result: unknown;

  for (let i = 0; i < expectedResponses; i++) {
    const parsed = parseRespValue(buf, offset);
    if (parsed === undefined) return undefined;
    result = parsed.value;
    offset = parsed.offset;
  }

  return result;
}

function parseRespValue(
  buf: Buffer,
  offset: number,
): { value: unknown; offset: number } | undefined {
  if (offset >= buf.length) return undefined;
  const prefix = String.fromCharCode(buf[offset]!);

  const crlf = buf.indexOf("\r\n", offset);
  if (crlf === -1) return undefined;

  const line = buf.toString("utf8", offset + 1, crlf);
  const next = crlf + 2;

  switch (prefix) {
    case "+": // Simple string
      return { value: line, offset: next };
    case "-": // Error
      throw new Error(`Redis error: ${line}`);
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
        const item = parseRespValue(buf, cursor);
        if (item === undefined) return undefined;
        items.push(item.value);
        cursor = item.offset;
      }
      return { value: items, offset: cursor };
    }
    default:
      throw new Error(`Unsupported RESP type prefix: '${prefix}'`);
  }
}

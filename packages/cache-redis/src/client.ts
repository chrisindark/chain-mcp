import { Socket } from "node:net";
import type { RedisCacheClient } from "./index.js";

export interface SimpleRedisOptions {
  url?: string | undefined;
  host?: string | undefined;
  port?: number | undefined;
  password?: string | undefined;
  timeoutMs?: number | undefined;
}

/**
 * Creates a zero-dependency Redis client implementing RedisCacheClient
 * using the standard Redis Serialization Protocol (RESP2) over a Node socket.
 */
export function createSimpleRedisCacheClient(
  urlOrOptions: string | SimpleRedisOptions,
): RedisCacheClient {
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
  };
}

function parseResp(buf: Buffer, expectedResponses = 1): unknown | undefined {
  let offset = 0;
  let result: unknown;

  for (let i = 0; i < expectedResponses; i++) {
    if (offset >= buf.length) return undefined;
    const prefix = String.fromCharCode(buf[offset]!);

    const crlf = buf.indexOf("\r\n", offset);
    if (crlf === -1) return undefined;

    const line = buf.toString("utf8", offset + 1, crlf);
    offset = crlf + 2;

    switch (prefix) {
      case "+": // Simple string
        result = line;
        break;
      case "-": // Error
        throw new Error(`Redis error: ${line}`);
      case ":": // Integer
        result = Number.parseInt(line, 10);
        break;
      case "$": {
        // Bulk string
        const len = Number.parseInt(line, 10);
        if (len === -1) {
          result = null;
          break;
        }
        if (buf.length < offset + len + 2) return undefined;
        result = buf.toString("utf8", offset, offset + len);
        offset += len + 2;
        break;
      }
      default:
        throw new Error(`Unsupported RESP type prefix: '${prefix}'`);
    }
  }

  return result;
}

import * as net from "node:net";
import { describe, expect, it } from "vitest";
import { createSimpleRedisClient } from "../src/client.js";

function createMockServer(
  onCommand?: (args: string[], socket: net.Socket) => void,
) {
  const activeSockets = new Set<net.Socket>();

  const server = net.createServer((socket) => {
    activeSockets.add(socket);
    let buffer = Buffer.alloc(0);

    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (buffer.length === 0) break;
        if (buffer[0] !== 42) break;
        const crlf = buffer.indexOf("\r\n");
        if (crlf === -1) break;
        const count = Number.parseInt(buffer.toString("utf8", 1, crlf), 10);
        let cursor = crlf + 2;
        const args: string[] = [];
        let complete = true;
        for (let i = 0; i < count; i++) {
          if (cursor >= buffer.length || buffer[cursor] !== 36) {
            complete = false;
            break;
          }
          const nextCrlf = buffer.indexOf("\r\n", cursor);
          if (nextCrlf === -1) {
            complete = false;
            break;
          }
          const len = Number.parseInt(
            buffer.toString("utf8", cursor + 1, nextCrlf),
            10,
          );
          const valStart = nextCrlf + 2;
          const valEnd = valStart + len;
          if (buffer.length < valEnd + 2) {
            complete = false;
            break;
          }
          args.push(buffer.toString("utf8", valStart, valEnd));
          cursor = valEnd + 2;
        }
        if (!complete) break;
        buffer = buffer.subarray(cursor);

        if (onCommand) {
          onCommand(args, socket);
        } else {
          const cmd = args[0]?.toUpperCase();
          if (cmd === "PING") {
            socket.write("+PONG\r\n");
          } else if (cmd === "AUTH" || cmd === "SELECT" || cmd === "SET") {
            socket.write("+OK\r\n");
          } else if (cmd === "GET") {
            socket.write("$4\r\ntest\r\n");
          } else if (cmd === "DEL") {
            socket.write(":1\r\n");
          } else {
            socket.write("+OK\r\n");
          }
        }
      }
    });

    socket.on("close", () => {
      activeSockets.delete(socket);
    });
  });

  return {
    server,
    close: async () => {
      for (const s of activeSockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe("SimpleRedisClient / SimpleRedisPool Deep Coverage", () => {
  describe("Option parsing and validation", () => {
    it("rejects invalid Redis port", () => {
      expect(() =>
        createSimpleRedisClient({ host: "127.0.0.1", port: 99999 }),
      ).toThrow(/Invalid Redis port: 99999/);

      expect(() =>
        createSimpleRedisClient({ host: "127.0.0.1", port: -1 }),
      ).toThrow(/Invalid Redis port: -1/);
    });

    it("parses options with password, minConnections, healthCheckOnCheckout, and tls object", () => {
      const client = createSimpleRedisClient({
        host: "127.0.0.1",
        port: 6379,
        password: "secret_password",
        minConnections: 2,
        healthCheckOnCheckout: true,
        tls: { rejectUnauthorized: false },
      });
      expect(client).toBeDefined();
    });
  });

  describe("RESP parser edge cases via commands", () => {
    it("handles null array (*-1) and array with items (*2)", async () => {
      const mock = createMockServer((args, socket) => {
        const cmd = args[0]?.toUpperCase();
        if (cmd === "EVAL") {
          const script = args[1];
          if (script === "return-null-array") {
            socket.write("*-1\r\n");
          } else if (script === "return-items-array") {
            socket.write("*2\r\n$3\r\nfoo\r\n$3\r\nbar\r\n");
          } else if (script === "return-nested-error") {
            socket.write("*1\r\n-ERR nested error\r\n");
          } else {
            socket.write("+OK\r\n");
          }
        }
      });

      await new Promise<void>((resolve) =>
        mock.server.listen(0, "127.0.0.1", resolve),
      );
      const port = (mock.server.address() as net.AddressInfo).port;

      const client = createSimpleRedisClient({
        host: "127.0.0.1",
        port,
        timeoutMs: 1000,
      });

      try {
        const resNull = await client.eval("return-null-array", [], []);
        expect(resNull).toBeNull();

        const resItems = await client.eval("return-items-array", [], []);
        expect(resItems).toEqual(["foo", "bar"]);

        await expect(
          client.eval("return-nested-error", [], []),
        ).rejects.toThrow(/nested error/);
      } finally {
        await client.close();
        await mock.close();
      }
    });

    it("handles unexpected RESP prefix", async () => {
      const mock = createMockServer((args, socket) => {
        // Return an unsupported prefix '?'
        socket.write("?invalid\r\n");
      });

      await new Promise<void>((resolve) =>
        mock.server.listen(0, "127.0.0.1", resolve),
      );
      const port = (mock.server.address() as net.AddressInfo).port;

      const client = createSimpleRedisClient({
        host: "127.0.0.1",
        port,
        timeoutMs: 1000,
      });

      try {
        await expect(client.get("test")).rejects.toThrow();
      } finally {
        await client.close();
        await mock.close();
      }
    });
  });

  describe("Pool connection lifecycle and queue management", () => {
    it("rejects execute when client is closed", async () => {
      const mock = createMockServer();
      await new Promise<void>((resolve) =>
        mock.server.listen(0, "127.0.0.1", resolve),
      );
      const port = (mock.server.address() as net.AddressInfo).port;

      const client = createSimpleRedisClient({
        host: "127.0.0.1",
        port,
        timeoutMs: 1000,
      });

      // Warm up connection
      await client.get("warmup");
      await client.close();

      await expect(client.get("after-close")).rejects.toThrow(
        /Redis client is closed/,
      );

      await mock.close();
    });

    it("handles ping failure during healthCheckOnCheckout and recovers", async () => {
      let pingCount = 0;
      const mock = createMockServer((args, socket) => {
        const cmd = args[0]?.toUpperCase();
        if (cmd === "PING") {
          pingCount++;
          if (pingCount === 1) {
            // Unexpected response fails health check and destroys connection
            socket.write("+UNEXPECTED\r\n");
            return;
          }
          socket.write("+PONG\r\n");
        } else if (cmd === "GET") {
          socket.write("$5\r\nhello\r\n");
        }
      });

      await new Promise<void>((resolve) =>
        mock.server.listen(0, "127.0.0.1", resolve),
      );
      const port = (mock.server.address() as net.AddressInfo).port;

      const client = createSimpleRedisClient({
        host: "127.0.0.1",
        port,
        healthCheckOnCheckout: true,
        timeoutMs: 1000,
      });

      try {
        // First command uses and releases connection
        await client.get("k1");
        // Second command triggers checkout health check ping (returns +UNEXPECTED, fails, destroys, recreates)
        const val = await client.get("k2");
        expect(val).toBe("hello");
      } finally {
        await client.close();
        await mock.close();
      }
    });

    it("times out waiting in waitQueue when pool capacity is exhausted", async () => {
      const mock = createMockServer((args, socket) => {
        // Never respond to GET so the connection stays checked out
        const cmd = args[0]?.toUpperCase();
        if (cmd === "AUTH" || cmd === "SELECT") {
          socket.write("+OK\r\n");
        }
      });

      await new Promise<void>((resolve) =>
        mock.server.listen(0, "127.0.0.1", resolve),
      );
      const port = (mock.server.address() as net.AddressInfo).port;

      const client = createSimpleRedisClient({
        host: "127.0.0.1",
        port,
        maxConnections: 1,
        maxRetries: 0,
        timeoutMs: 50,
      });

      try {
        // First command holds the single connection
        const p1 = client.get("hang");
        p1.catch(() => {});
        // Second command enters wait queue and times out
        await expect(client.get("blocked")).rejects.toThrow(
          /Redis connection pool exhausted/,
        );
      } finally {
        await client.close();
        await mock.close();
      }
    });

    it("rejects queued waiters when pool is closed/drained", async () => {
      const mock = createMockServer();
      await new Promise<void>((resolve) =>
        mock.server.listen(0, "127.0.0.1", resolve),
      );
      const port = (mock.server.address() as net.AddressInfo).port;

      const client = createSimpleRedisClient({
        host: "127.0.0.1",
        port,
        maxConnections: 1,
        timeoutMs: 5000,
      });

      try {
        const p1 = client.get("hang");
        p1.catch(() => {});
        const p2 = client.get("blocked");
        // Catch p2 to prevent unhandled rejection
        const errPromise = p2.catch((e) => e);
        // Immediately close client while p2 is in wait queue
        await client.close();
        const err = await errPromise;
        expect(err.message).toContain("Redis client is closed");
      } finally {
        await mock.close();
      }
    });
  });

  describe("Connection socket termination and timeouts", () => {
    it("times out when connection cannot be established", async () => {
      const client = createSimpleRedisClient({
        host: "10.255.255.1",
        port: 81,
        timeoutMs: 50,
        maxRetries: 0,
      });

      await expect(client.get("key")).rejects.toThrow(
        /Redis connection timed out/,
      );
    });
  });
});

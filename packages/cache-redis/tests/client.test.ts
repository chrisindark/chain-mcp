import * as net from "node:net";
import * as tls from "node:tls";
import { describe, expect, it } from "vitest";
import { createSimpleRedisClient, redactRedisUrl } from "../src/client.js";

const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQCc9DzW9/w4QfZm
du1KRmaKCkz6Vim5nXKMrkcoJc+CdC4fdbpqlJSDdCnUAHkoqJ+YbH8cqtJeQi4+
HRLI305EevgjlJ8unNl0Pz6fSJArr0r/fipzAHnJLB6wwJ9sByX9tx6nuSzAfHUp
eCB+vHbtIa7+ALn29ABVT1F/znTE0ri/oOmmNUjNoI8ty3hx3t6W+SlBM/kwjzL6
ukF64Lu+n2FonalrhOWskw8oMMK/rh/YjuxLe0D1RgdK3/rTVot9+C+nrIZalFXp
5Nnpq9E7d4dy3VTysywWjRYBDCH3o7AHo1dy/6In4HhCnm9SNUpP55f6gDg8xw0h
Ot2enXtvAgMBAAECggEAORDEHhTD62BwSgjrdZnrJj1gh5RUT1xjjaq/zGUS8Yd0
TZPsV1v2M2VE4APcCWBlxnGMNcwV+JdvYL4JWmd2eYeMOMOMrNHybkWgayFi6b8u
MX6ZyH5fyTj1X6ZpUEm5EmpGBw1YrBOUNaOrjOjRBJ6+lTOGabeFd38DTsitw/GX
sj7JhE5mZBW50eFJZBG5RBkLzliAqOV9g10zOSu2d4LlzrTkc93tEcEo2HvZaM8A
BrtZ17a203UBTrCQsZrHS4McooTyuPPh+wbo6omEhutwPSC/fh8kfQrGj1sddqkm
KIUZVjhzMpZj5lHdrpPFUdxw7Pjg4CFShepaj/3YwQKBgQDSjx/VOZijJTJEdxvQ
+y41BIAY5ZbK1MojTG2yGn7mD5lAjNyAVIWFW4fsLTNYFt0Lh8czViX8QWixo1RA
1cg1jqb3/SYlywSo2zkUBYqArHcaE8Pdoml+786hg3lQtvH1BHo08jTw/rIcufmN
SNNPhR6tHZuD18abJs5T5RYCVwKBgQC+05D7ozvL1fCSDkcwy8oWy020GQr99DiC
HPj9UrpHyitUiijeDEV1NKgCWFLJdFcbu0ct3APY2xotsPromDo5gQS4kpIuj5OD
IDHww6h64klzQL+vc16pth2E7UojcbNE0GpksP15C9r1wx0VQfb5UD7EV6cPJWsq
bwE5o0OQqQKBgQDLjHbujxZiqOO2Uhq+5QNfV3FqIBCtFhYvF4R4B6sjRnMVdtb2
7D6Dk9+LTorzHm8j5WeJ1j80ZBsMluMtJj28oKIC3GOTZ3aisgK0u0KQb6lXuUHA
sXAguTzc4JdXkvPGtERbiMXrL50JrjN0BLHajsr/+b5MLz0c4d/WNIEZUwKBgCpc
JI73iUqSTzjc2ojGdDHjJ3iXJo2BLRoU/GCfgKJ3Cm9VzASejLyb17/Ng3Mc1Elf
pUlU0bXNzV3fL5N6V1J0hWvDfZfAX2p4Nx3PERNWMB/Ze7Oi1JyvxJXBZve/QaBA
850ufNXl/9EWYtpZLk3htk03d+ow0D03Lvpwd4shAoGBAKzMBUZPYqwiTPVADIqq
DwudHOutbheFu4C4JhCQCC24y2a27Kf7Ib7pAL6e1OTuN4d9IxRMwIf1Xr9juzek
z6qedOjHhUAj2FJeYlvUvMTtsBK9jsKtEDGxD8dkX/nOIcvSFgYK2Lq7mDWYwdTB
ap0EN0ddKs/L8t8fB8U14Ahi
-----END PRIVATE KEY-----`;

const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIC6DCCAdCgAwIBAgIUcB0z8uPBel7SKIH8gELzMQ0Dx8YwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MTAyNzExMTgyNloXDTM2MTAy
NDExMTgyNlowFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEAnPQ81vf8OEH2ZnbtSkZmigpM+lYpuZ1yjK5HKCXPgnQu
H3W6apSUg3Qp1AB5KKifmGx/HKrSXkIuPh0SyN9ORHr4I5SfLpzZdD8+n0iQK69K
/34qcwB5ySwesMCfbAcl/bcep7kswHx1KXggfrx27SGu/gC59vQAVU9Rf850xNK4
v6DppjVIzaCPLct4cd7elvkpQTP5MI8y+rpBeuC7vp9haJ2pa4TlrJMPKDDCv64f
2I7sS3tA9UYHSt/601aLffgvp6yGWpRV6eTZ6avRO3eHct1U8rMsFo0WAQwh96Ow
B6NXcv+iJ+B4Qp5vUjVKT+eX+oA4PMcNITrdnp17bwIDAQABozIwMDAdBgNVHQ4E
FgQUGKp7nv8s1l/+cp9fxhPWtoTmVNwwDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG
9w0BAQsFAAOCAQEAUdXDYOvDicfrNJXqX0Z2j/R7nloG48kH1r7d6SoXpdXvGL6t
9qIEjnw+Rxcjgy9hVtLuxTKkTyoaFUi+woc3v4pnRyzrkRxC+wZBP5QcrphNeqql
/LH7rVGuqI5CtWVosLXePX9Iq5gp4Rz1LDtDALl5zHfi2RWbKAX/O+l52K4+eQOL
+7IS5Kij5Dv8h/2Fw8lfcQ2nmPZjGn93RVmrbHISCW7DsVnNKKiwCcbQS7L35XeV
+vUxuMJC4F2ygCR+d7XZu3R9JVJDY6RP0ajNWIPnECvWgkXxyZa0GsW9svNoQSqg
DF3daExmno2gJnNsVZwt9kxn7NLO4SJaeroEpA==
-----END CERTIFICATE-----`;

/**
 * Creates an in-memory mock RESP TCP or TLS server for tests.
 */
function createMockServer(
  options: {
    tls?: { key: string; cert: string };
    onCommand?: (args: string[]) => string;
  } = {},
) {
  const commandsReceived: string[][] = [];
  let connectionCount = 0;
  const activeSockets = new Set<net.Socket>();

  function handleSocket(socket: net.Socket) {
    connectionCount++;
    activeSockets.add(socket);
    let buffer = Buffer.alloc(0);

    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (buffer.length === 0) break;
        if (buffer[0] !== 42) {
          // not '*'
          break;
        }
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
        commandsReceived.push(args);

        const custom = options.onCommand?.(args);
        if (custom) {
          socket.write(custom);
          continue;
        }

        const cmd = args[0]?.toUpperCase();
        if (cmd === "AUTH") {
          socket.write("+OK\r\n");
        } else if (cmd === "SELECT") {
          socket.write("+OK\r\n");
        } else if (cmd === "PING") {
          socket.write("+PONG\r\n");
        } else if (cmd === "GET") {
          const key = args[1];
          if (key === "missing") {
            socket.write("$-1\r\n");
          } else {
            socket.write("$5\r\nvalue\r\n");
          }
        } else if (cmd === "SET") {
          socket.write("+OK\r\n");
        } else if (cmd === "DEL") {
          socket.write(":1\r\n");
        } else if (cmd === "EVAL") {
          socket.write("+OK\r\n");
        } else {
          socket.write(`-ERR unknown command '${cmd}'\r\n`);
        }
      }
    });

    socket.on("close", () => {
      activeSockets.delete(socket);
    });
  }

  const server = options.tls
    ? tls.createServer(
        { key: options.tls.key, cert: options.tls.cert },
        handleSocket,
      )
    : net.createServer(handleSocket);

  return {
    server,
    commandsReceived,
    getConnectionCount: () => connectionCount,
    activeSockets,
    async start(): Promise<number> {
      return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
          const addr = server.address() as net.AddressInfo;
          resolve(addr.port);
        });
      });
    },
    async stop(): Promise<void> {
      for (const s of activeSockets) {
        s.destroy();
      }
      return new Promise((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

describe("Hardened SimpleRedisClient (RM-16)", () => {
  describe("URL and Options Parsing", () => {
    it("parses valid redis:// URL", async () => {
      const client = createSimpleRedisClient("redis://127.0.0.1:6379");
      expect(client).toBeDefined();
      await client.close();
    });

    it("parses valid rediss:// URL and enables TLS", async () => {
      const client = createSimpleRedisClient("rediss://127.0.0.1:6380");
      expect(client).toBeDefined();
      await client.close();
    });

    it("parses database index in URL pathname", async () => {
      const client = createSimpleRedisClient("redis://127.0.0.1:6379/3");
      expect(client).toBeDefined();
      await client.close();
    });

    it("parses search query parameters", async () => {
      const client = createSimpleRedisClient(
        "redis://127.0.0.1:6379?timeoutMs=5000&rejectUnauthorized=false&maxConnections=8&database=2",
      );
      expect(client).toBeDefined();
      await client.close();
    });

    it("rejects invalid URL protocols", () => {
      expect(() => createSimpleRedisClient("http://127.0.0.1:6379")).toThrow(
        /expected 'redis:' or 'rediss:'/,
      );
      expect(() => createSimpleRedisClient("ws://127.0.0.1:6379")).toThrow(
        /expected 'redis:' or 'rediss:'/,
      );
    });

    it("rejects invalid ports", () => {
      expect(() => createSimpleRedisClient("redis://127.0.0.1:999999")).toThrow(
        /Invalid Redis/,
      );
      expect(() =>
        createSimpleRedisClient({ host: "127.0.0.1", port: 99999 }),
      ).toThrow(/Invalid Redis port/);
    });

    it("rejects invalid pathnames", () => {
      expect(() =>
        createSimpleRedisClient("redis://127.0.0.1:6379/foo"),
      ).toThrow(/Only numeric database index/);
    });

    it("rejects unsupported query parameters", () => {
      expect(() =>
        createSimpleRedisClient("redis://127.0.0.1:6379?unknownParam=123"),
      ).toThrow(/Unsupported Redis URL query parameter: 'unknownParam'/);
    });
  });

  describe("Authentication Handshake", () => {
    it("sends AUTH with username and password when both provided", async () => {
      const mock = createMockServer();
      const port = await mock.start();

      const client = createSimpleRedisClient(
        `redis://alice:supersecret@127.0.0.1:${port}`,
      );
      await client.get("foo");
      await client.close();
      await mock.stop();

      expect(mock.commandsReceived[0]).toEqual([
        "AUTH",
        "alice",
        "supersecret",
      ]);
    });

    it("sends AUTH with password only when username is empty", async () => {
      const mock = createMockServer();
      const port = await mock.start();

      const client = createSimpleRedisClient(
        `redis://:supersecret@127.0.0.1:${port}`,
      );
      await client.get("foo");
      await client.close();
      await mock.stop();

      expect(mock.commandsReceived[0]).toEqual(["AUTH", "supersecret"]);
    });

    it("sends NO AUTH when credentials are omitted", async () => {
      const mock = createMockServer();
      const port = await mock.start();

      const client = createSimpleRedisClient(`redis://127.0.0.1:${port}`);
      await client.get("foo");
      await client.close();
      await mock.stop();

      expect(mock.commandsReceived[0]).toEqual(["GET", "foo"]);
    });

    it("sends SELECT when database index is configured", async () => {
      const mock = createMockServer();
      const port = await mock.start();

      const client = createSimpleRedisClient(`redis://127.0.0.1:${port}/5`);
      await client.get("foo");
      await client.close();
      await mock.stop();

      expect(mock.commandsReceived[0]).toEqual(["SELECT", "5"]);
      expect(mock.commandsReceived[1]).toEqual(["GET", "foo"]);
    });
  });

  describe("TLS Support", () => {
    it("selects TLS when rediss:// is used (assert socket creation options)", async () => {
      let capturedIsTls: boolean | undefined;
      let capturedOptions: unknown;

      const client = createSimpleRedisClient({
        url: "rediss://secure-redis.test:6380",
        maxRetries: 0,
        createSocket: (isTls, opts) => {
          capturedIsTls = isTls;
          capturedOptions = opts;
          const s = new net.Socket();
          process.nextTick(() =>
            s.emit("error", new Error("mock socket exit")),
          );
          return s;
        },
      });

      await expect(client.get("foo")).rejects.toThrow("mock socket exit");
      expect(capturedIsTls).toBe(true);
      expect(capturedOptions).toMatchObject({
        host: "secure-redis.test",
        port: 6380,
        tlsOptions: expect.objectContaining({
          host: "secure-redis.test",
          port: 6380,
          servername: "secure-redis.test",
          rejectUnauthorized: true,
        }),
      });
      await client.close();
    });

    it("connects and executes commands against a live TLS test server", async () => {
      const mock = createMockServer({
        tls: { key: TEST_KEY, cert: TEST_CERT },
      });
      const port = await mock.start();

      const client = createSimpleRedisClient({
        url: `rediss://127.0.0.1:${port}`,
        ca: TEST_CERT,
        rejectUnauthorized: false,
      });

      const setResult = await client.set("key", "val", 60000);
      expect(setResult).toBe("OK");

      const getResult = await client.get("key");
      expect(getResult).toBe("value");

      const delResult = await client.delete("key");
      expect(delResult).toBe(1);

      await client.close();
      await mock.stop();
    });
  });

  describe("Connection Pooling", () => {
    it("reuses a single connection across sequential commands", async () => {
      const mock = createMockServer();
      const port = await mock.start();

      const client = createSimpleRedisClient(`redis://127.0.0.1:${port}`);

      for (let i = 0; i < 5; i++) {
        await client.get(`key-${i}`);
      }

      const status = client.getStatus();
      expect(status.totalConnections).toBe(1);
      expect(mock.getConnectionCount()).toBe(1);

      await client.close();
      await mock.stop();
    });

    it("respects maxConnections and queues concurrent requests", async () => {
      const mock = createMockServer();
      const port = await mock.start();

      const client = createSimpleRedisClient({
        url: `redis://127.0.0.1:${port}`,
        maxConnections: 2,
      });

      const results = await Promise.all([
        client.get("a"),
        client.get("b"),
        client.get("c"),
        client.get("d"),
      ]);

      expect(results).toEqual(["value", "value", "value", "value"]);
      const status = client.getStatus();
      expect(status.totalConnections).toBeLessThanOrEqual(2);
      expect(mock.getConnectionCount()).toBeLessThanOrEqual(2);

      await client.close();
      await mock.stop();
    });

    it("gracefully drains pool on close / disconnect", async () => {
      const mock = createMockServer();
      const port = await mock.start();

      const client = createSimpleRedisClient(`redis://127.0.0.1:${port}`);
      await client.get("init");

      expect(client.getStatus().totalConnections).toBe(1);
      expect(client.getStatus().idleConnections).toBe(1);

      await client.close();

      const closedStatus = client.getStatus();
      expect(closedStatus.isClosed).toBe(true);
      expect(closedStatus.totalConnections).toBe(0);
      expect(closedStatus.idleConnections).toBe(0);

      await expect(client.get("after-close")).rejects.toThrow(
        "Redis client is closed",
      );

      await mock.stop();
    });
  });

  describe("Reconnect and Backoff", () => {
    it("reconnects with backoff when an idle connection is dropped", async () => {
      const mock = createMockServer();
      const port = await mock.start();

      const client = createSimpleRedisClient({
        url: `redis://127.0.0.1:${port}`,
        retryBaseMs: 10,
        retryCapMs: 50,
      });

      // Command 1 creates and idles a connection
      const r1 = await client.get("first");
      expect(r1).toBe("value");

      // Server drops all active sockets
      for (const sock of mock.activeSockets) {
        sock.destroy();
      }

      // Small pause to let close event propagate
      await new Promise((resolve) => setTimeout(resolve, 20));

      // Command 2 detects dead connection and transparently reconnects
      const r2 = await client.get("second");
      expect(r2).toBe("value");

      expect(mock.getConnectionCount()).toBe(2);

      await client.close();
      await mock.stop();
    });
  });

  describe("Credential Redaction", () => {
    it("never leaks password in AUTH error messages or stack traces", async () => {
      const secret = "super-secret-password-xyz";
      const mock = createMockServer({
        onCommand(args) {
          if (args[0] === "AUTH") {
            return `-WRONGPASS invalid username-password pair with secret '${args[1]}' for user\r\n`;
          }
          return "+OK\r\n";
        },
      });
      const port = await mock.start();

      const client = createSimpleRedisClient({
        url: `redis://:${secret}@127.0.0.1:${port}`,
        maxRetries: 0,
      });

      let caughtError: Error | undefined;
      try {
        await client.get("foo");
      } catch (err) {
        caughtError = err as Error;
      }

      expect(caughtError).toBeDefined();
      expect(caughtError!.message).not.toContain(secret);
      expect(caughtError!.message).toContain("[REDACTED]");
      if (caughtError!.stack) {
        expect(caughtError!.stack).not.toContain(secret);
      }

      await client.close();
      await mock.stop();
    });

    it("never leaks password in connection failure errors", async () => {
      const secret = "another-super-secret-pwd";
      // Point to an unassigned port that fails connection immediately
      const client = createSimpleRedisClient({
        url: `redis://:${secret}@127.0.0.1:49999`,
        maxRetries: 0,
        timeoutMs: 500,
      });

      let caughtError: Error | undefined;
      try {
        await client.get("foo");
      } catch (err) {
        caughtError = err as Error;
      }

      expect(caughtError).toBeDefined();
      expect(caughtError!.message).not.toContain(secret);
      if (caughtError!.stack) {
        expect(caughtError!.stack).not.toContain(secret);
      }

      await client.close();
    });

    it("redactRedisUrl strips passwords and usernames", () => {
      const redacted = redactRedisUrl(
        "redis://user:mysecretpassword@127.0.0.1:6379/1?timeoutMs=1000",
      );
      expect(redacted).not.toContain("mysecretpassword");
      expect(redacted).not.toContain("user");
      expect(redacted).toContain("REDACTED");
    });
  });
});

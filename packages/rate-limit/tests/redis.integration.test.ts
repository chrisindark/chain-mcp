import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import type { ToolContext } from "@chainmcp/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DistributedRateLimiter,
  type RedisRateLimitClient,
} from "../src/index.js";

/**
 * Redis integration tests for the Lua scripts.
 *
 * These run only when `CHAINMCP_TEST_REDIS_URL` is set, for example:
 *
 *   CHAINMCP_TEST_REDIS_URL=redis://127.0.0.1:6379 \
 *     pnpm --filter @chainmcp/rate-limit test
 *
 * The unit tests use a JavaScript fake of the scripts, which cannot prove that
 * the Lua itself is accepted by Redis or that expiry and rollbacks behave as
 * documented. This suite closes that gap without adding a client dependency: it
 * speaks just enough RESP to run `EVAL` and to clean up afterwards.
 */

type RedisReply = string | number | null | RedisReply[];

function parseReply(
  buffer: Buffer,
  offset: number,
): { value: RedisReply; offset: number } | undefined {
  const lineEnd = buffer.indexOf("\r\n", offset);
  if (lineEnd === -1) return undefined;
  const type = String.fromCharCode(buffer[offset]!);
  const line = buffer.subarray(offset + 1, lineEnd).toString("utf8");
  const next = lineEnd + 2;

  switch (type) {
    case "+":
      return { value: line, offset: next };
    case "-":
      throw new Error(`Redis error: ${line}`);
    case ":":
      return { value: Number(line), offset: next };
    case "$": {
      const length = Number(line);
      if (length === -1) return { value: null, offset: next };
      if (buffer.length < next + length + 2) return undefined;
      return {
        value: buffer.subarray(next, next + length).toString("utf8"),
        offset: next + length + 2,
      };
    }
    case "*": {
      const count = Number(line);
      if (count === -1) return { value: null, offset: next };
      const items: RedisReply[] = [];
      let cursor = next;
      for (let index = 0; index < count; index += 1) {
        const parsed = parseReply(buffer, cursor);
        if (parsed === undefined) return undefined;
        items.push(parsed.value);
        cursor = parsed.offset;
      }
      return { value: items, offset: cursor };
    }
    default:
      throw new Error(`Unsupported Redis reply type: ${type}`);
  }
}

/** Minimal RESP client: one command in flight at a time is enough here. */
class RedisTestClient implements RedisRateLimitClient {
  private buffer = Buffer.alloc(0);
  private readonly wakeups: Array<() => void> = [];
  private failure: Error | undefined;
  private closed = false;

  private constructor(private readonly socket: Socket) {
    socket.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.wake();
    });
    socket.on("error", (error) => {
      this.failure = error;
      this.wake();
    });
    socket.on("close", () => {
      this.closed = true;
      this.wake();
    });
  }

  static async connect(url: string): Promise<RedisTestClient> {
    const parsed = new URL(url);
    const socket = createConnection({
      host: parsed.hostname,
      port: parsed.port === "" ? 6379 : Number(parsed.port),
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    return new RedisTestClient(socket);
  }

  async command(args: readonly string[]): Promise<RedisReply> {
    const encoded = [`*${args.length}`];
    for (const arg of args) {
      encoded.push(`$${Buffer.byteLength(arg, "utf8")}`, arg);
    }
    this.socket.write(`${encoded.join("\r\n")}\r\n`);

    for (;;) {
      const parsed = parseReply(this.buffer, 0);
      if (parsed !== undefined) {
        this.buffer = this.buffer.subarray(parsed.offset);
        return parsed.value;
      }
      if (this.failure !== undefined) throw this.failure;
      if (this.closed) throw new Error("Redis connection closed");
      await new Promise<void>((resolve) => this.wakeups.push(resolve));
    }
  }

  async eval(script: string, keys: string[], args: string[]): Promise<unknown> {
    return this.command([
      "EVAL",
      script,
      String(keys.length),
      ...keys,
      ...args,
    ]);
  }

  async quit(): Promise<void> {
    if (this.closed) return;
    const closed = new Promise<void>((resolve) =>
      this.socket.once("close", resolve),
    );
    this.socket.end();
    await closed;
  }

  private wake(): void {
    for (const resolve of this.wakeups.splice(0)) resolve();
  }
}

const redisUrl = process.env.CHAINMCP_TEST_REDIS_URL;
const describeRedis = redisUrl === undefined ? describe.skip : describe;

const context = (tenantId: string): ToolContext => ({
  requestId: "req-integration",
  tenantId,
  principal: { id: "user-integration", scopes: [] },
});

describeRedis("Redis-backed rate limiting (integration)", () => {
  let client: RedisTestClient;
  const prefix = `chainmcp:test:${randomUUID()}:`;

  beforeAll(async () => {
    client = await RedisTestClient.connect(redisUrl ?? "");
  });

  afterAll(async () => {
    if (client === undefined) return;
    try {
      const keys = (await client.command(["KEYS", `${prefix}*`])) as
        string[] | null;
      if (keys !== null && keys.length > 0) {
        await client.command(["DEL", ...keys]);
      }
    } finally {
      await client.quit();
    }
  });

  it("enforces a shared quota across two limiter instances", async () => {
    const keyPrefix = `${prefix}shared:`;
    let clock = 1_000_000;
    const now = () => clock;
    const processA = new DistributedRateLimiter({
      client,
      keyPrefix,
      now,
      tenantQuota: { maxRequests: 3, windowMs: 15_000 },
    });
    const processB = new DistributedRateLimiter({
      client,
      keyPrefix,
      now,
      tenantQuota: { maxRequests: 3, windowMs: 15_000 },
    });
    const ctx = context("tenant-shared");

    expect((await processA.check(ctx, "tool")).allowed).toBe(true);
    expect((await processA.check(ctx, "tool")).allowed).toBe(true);
    expect((await processB.check(ctx, "tool")).allowed).toBe(true);

    const denied = await processB.check(ctx, "tool");
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBe(15);

    clock += 15_001;
    expect((await processA.check(ctx, "tool")).allowed).toBe(true);
  });

  it("rolls back recorded scopes when a later scope denies", async () => {
    const keyPrefix = `${prefix}multi:`;
    let clock = 2_000_000;
    const limiter = new DistributedRateLimiter({
      client,
      keyPrefix,
      now: () => clock,
      tenantQuota: { maxRequests: 2, windowMs: 60_000 },
      toolQuota: { maxRequests: 1, windowMs: 1_000 },
    });
    const ctx = context("tenant-multi");
    const tenantKey = `${keyPrefix}quota:tenant:tenant-multi`;

    expect((await limiter.check(ctx, "tool")).allowed).toBe(true);
    expect(await client.command(["ZCARD", tenantKey])).toBe(1);

    // Denied by the tool scope after the tenant scope already recorded.
    expect((await limiter.check(ctx, "tool")).allowed).toBe(false);
    expect(await client.command(["ZCARD", tenantKey])).toBe(1);

    clock += 1_001;
    expect((await limiter.check(ctx, "tool")).allowed).toBe(true);
    expect(await client.command(["ZCARD", tenantKey])).toBe(2);

    clock += 1_001;
    expect((await limiter.check(ctx, "tool")).allowed).toBe(false);
    expect(await client.command(["ZCARD", tenantKey])).toBe(2);
  });

  it("sets a crash-safety TTL on quota keys", async () => {
    const keyPrefix = `${prefix}ttl:`;
    const limiter = new DistributedRateLimiter({
      client,
      keyPrefix,
      tenantQuota: { maxRequests: 5, windowMs: 10_000 },
    });
    const ctx = context("tenant-ttl");
    expect((await limiter.check(ctx, "tool")).allowed).toBe(true);

    const ttlMs = (await client.command([
      "PTTL",
      `${keyPrefix}quota:tenant:tenant-ttl`,
    ])) as number;
    expect(ttlMs).toBeGreaterThan(0);
    expect(ttlMs).toBeLessThanOrEqual(20_000);
  });

  it("shares concurrency permits across instances and releases them", async () => {
    const keyPrefix = `${prefix}permits:`;
    const processA = new DistributedRateLimiter({
      client,
      keyPrefix,
      globalConcurrency: 2,
    });
    const processB = new DistributedRateLimiter({
      client,
      keyPrefix,
      globalConcurrency: 2,
    });
    const ctx = context("tenant-concurrency");

    expect((await processA.check(ctx, "a")).allowed).toBe(true);
    expect((await processB.check(ctx, "b")).allowed).toBe(true);
    expect((await processA.check(ctx, "c")).allowed).toBe(false);

    await processA.release(ctx, "a");
    expect((await processB.check(ctx, "c")).allowed).toBe(true);
  });

  it("expires concurrency permits with a TTL so a crashed holder cannot block forever", async () => {
    const keyPrefix = `${prefix}crash:`;
    const limiter = new DistributedRateLimiter({
      client,
      keyPrefix,
      globalConcurrency: { maxConcurrent: 1, ttlSeconds: 5 },
    });
    const ctx = context("tenant-crash");
    expect((await limiter.check(ctx, "a")).allowed).toBe(true);

    const ttlSeconds = (await client.command([
      "TTL",
      `${keyPrefix}concurrency:global`,
    ])) as number;
    expect(ttlSeconds).toBeGreaterThan(0);
    expect(ttlSeconds).toBeLessThanOrEqual(5);
  });
});

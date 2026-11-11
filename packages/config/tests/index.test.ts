import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  BaseUrlSchema,
  buildExecutorOptions,
  buildReadinessDeps,
  buildRuntimeOptions,
  createAuthorizerFromConfig,
  createCacheStoreFromConfig,
  createHandleRegistryOptionsFromConfig,
  createLoggerFromConfig,
  createNavigationLimitsFromConfig,
  createOtlpIngestionSinkFromConfig,
  createRateLimiterFromConfig,
  createStorageDriverFromConfig,
  createTokenizerFromConfig,
  createUpstreamCredentialProviderFromConfig,
  filterToolsByConfig,
  loadTokenizerFromConfig,
  logRateLimiterStartup,
  parseConfig,
  parseGatewayConfig,
  registerTokenizerFactory,
  resolveLogLevel,
  safeParseConfig,
  safeParseGatewayConfig,
  StorageConfigSchema,
  TokenizerConfigError,
  unregisterTokenizerFactory,
} from "../src/index.js";
import { OperationScopeAuthorizer } from "@chainmcp/auth";
import {
  DistributedRateLimiter,
  InMemoryRateLimiter,
  type RedisRateLimitClient,
} from "@chainmcp/rate-limit";
import {
  InMemoryCacheStore,
  type ToolContext,
  type ToolDefinition,
} from "@chainmcp/core";
import { RedisCacheStore, type RedisCacheClient } from "@chainmcp/cache-redis";
import { MemoryStorageDriver, SqliteStorageDriver } from "@chainmcp/storage";
import {
  MemorySink,
  OpenTelemetryMetricsSink,
  RollingAnalyticsAggregator,
  StructuredLogger,
  ToolTracer,
} from "@chainmcp/analytics";

const toolContext = (tenantId = "tenant-1"): ToolContext => ({
  requestId: "req-1",
  tenantId,
  principal: { id: "user-1", scopes: ["read"] },
});

describe("configuration schema", () => {
  it("applies conservative defaults to a minimal configuration", () => {
    const config = parseConfig({ version: 1, name: "catalog" });
    expect(config).toMatchObject({
      version: 1,
      name: "catalog",
      server: {
        transport: "stdio",
        host: "127.0.0.1",
        port: 3333,
        requestTimeoutMs: 15_000,
        shutdownTimeoutMs: 10_000,
        toolsPageSize: 100,
        maxResponseBytes: 1_000_000,
        maxRequestBytes: 1_048_576,
        maxMultipartPartBytes: 1_048_576,
        maxToolInputBytes: 1_048_576,
        validateResponses: "warn",
        allowedHosts: [],
        allowedOrigins: [],
        enableDnsRebindingProtection: false,
        cors: {
          allowedOrigins: [],
          allowedHeaders: [],
          allowCredentials: false,
          maxAgeSeconds: 600,
        },
      },
      security: {
        requireInboundAuth: false,
        allowUnauthenticatedHttp: false,
        allowedUpstreamHosts: [],
        redactHeaders: ["authorization", "cookie", "x-api-key"],
      },
      rateLimit: {
        enabled: false,
        provider: "memory",
        redis: {
          keyPrefix: "chainmcp:ratelimit:",
          commandTimeoutMs: 1_000,
        },
        maxTrackedWindows: 10_000,
      },
      auth: {
        inbound: {
          requireInboundAuth: false,
          authorizer: "scope",
        },
        upstream: {
          providers: [],
        },
      },
    });
  });

  it("applies field defaults to empty or partial nested objects", () => {
    expect(
      parseConfig({
        version: 1,
        name: "catalog",
        server: {},
        security: {},
        rateLimit: {},
        auth: {},
      }),
    ).toMatchObject({
      server: {
        transport: "stdio",
        host: "127.0.0.1",
        port: 3333,
        requestTimeoutMs: 15_000,
        shutdownTimeoutMs: 10_000,
        toolsPageSize: 100,
        maxResponseBytes: 1_000_000,
        maxRequestBytes: 1_048_576,
        maxMultipartPartBytes: 1_048_576,
        maxToolInputBytes: 1_048_576,
        validateResponses: "warn",
        allowedHosts: [],
        allowedOrigins: [],
        enableDnsRebindingProtection: false,
        cors: {
          allowedOrigins: [],
          allowedHeaders: [],
          allowCredentials: false,
          maxAgeSeconds: 600,
        },
      },
      security: {
        requireInboundAuth: false,
        allowUnauthenticatedHttp: false,
        allowedUpstreamHosts: [],
        redactHeaders: ["authorization", "cookie", "x-api-key"],
      },
      rateLimit: {
        enabled: false,
        provider: "memory",
      },
      auth: {
        inbound: { requireInboundAuth: false, authorizer: "scope" },
        upstream: { providers: [] },
      },
    });

    expect(
      parseConfig({
        version: 1,
        name: "catalog",
        server: { port: 4444 },
        security: { requireInboundAuth: true },
        rateLimit: { enabled: true, requestsPerMinute: 120 },
      }),
    ).toMatchObject({
      server: {
        transport: "stdio",
        host: "127.0.0.1",
        port: 4444,
        requestTimeoutMs: 15_000,
        maxResponseBytes: 1_000_000,
      },
      security: {
        requireInboundAuth: true,
        allowedUpstreamHosts: [],
        redactHeaders: ["authorization", "cookie", "x-api-key"],
      },
      rateLimit: {
        enabled: true,
        requestsPerMinute: 120,
      },
    });
  });

  it("accepts a custom shutdown timeout including zero (immediate force close)", () => {
    expect(
      parseConfig({
        version: 1,
        name: "catalog",
        server: { shutdownTimeoutMs: 2_500 },
      }).server.shutdownTimeoutMs,
    ).toBe(2_500);
    expect(
      parseConfig({
        version: 1,
        name: "catalog",
        server: { shutdownTimeoutMs: 0 },
      }).server.shutdownTimeoutMs,
    ).toBe(0);
    expect(() =>
      parseConfig({
        version: 1,
        name: "catalog",
        server: { shutdownTimeoutMs: -1 },
      }),
    ).toThrow();
  });

  it("accepts a custom tools page size, including zero (pagination disabled)", () => {
    expect(
      parseConfig({
        version: 1,
        name: "catalog",
        server: { toolsPageSize: 25 },
      }).server.toolsPageSize,
    ).toBe(25);
    expect(
      parseConfig({
        version: 1,
        name: "catalog",
        server: { toolsPageSize: 0 },
      }).server.toolsPageSize,
    ).toBe(0);
    expect(() =>
      parseConfig({
        version: 1,
        name: "catalog",
        server: { toolsPageSize: -1 },
      }),
    ).toThrow();
    expect(() =>
      parseConfig({
        version: 1,
        name: "catalog",
        server: { toolsPageSize: 1.5 },
      }),
    ).toThrow();
  });

  it("rejects unknown fields, invalid ports, and unsupported versions", () => {
    expect(() => parseConfig({ version: 2, name: "catalog" })).toThrow();
    expect(() =>
      parseConfig({ version: 1, name: "catalog", unknown: true }),
    ).toThrow();
    expect(() =>
      parseConfig({ version: 1, name: "catalog", server: { port: 70_000 } }),
    ).toThrow();
    expect(() =>
      parseConfig({ version: 1, name: "catalog", server: { port: 0 } }),
    ).toThrow();
  });

  it("parses and validates server.validateResponses and server.maxToolInputBytes", () => {
    const defaultConfig = parseConfig({ version: 1, name: "catalog" });
    expect(defaultConfig.server.validateResponses).toBe("warn");
    expect(defaultConfig.server.maxToolInputBytes).toBe(1_048_576);

    const offConfig = parseConfig({
      version: 1,
      name: "catalog",
      server: { validateResponses: "off", maxToolInputBytes: 4096 },
    });
    expect(offConfig.server.validateResponses).toBe("off");
    expect(offConfig.server.maxToolInputBytes).toBe(4096);

    const enforceConfig = parseConfig({
      version: 1,
      name: "catalog",
      server: { validateResponses: "enforce" },
    });
    expect(enforceConfig.server.validateResponses).toBe("enforce");

    expect(() =>
      parseConfig({
        version: 1,
        name: "catalog",
        server: { validateResponses: "invalid" as unknown as "warn" },
      }),
    ).toThrow();
  });
});

describe("security.allowedUpstreamHosts validation and normalization", () => {
  it("accepts and normalizes valid domain names, trailing dots, and IP literals", () => {
    const config = parseConfig({
      version: 1,
      name: "test",
      security: {
        allowedUpstreamHosts: [
          "api.example.com",
          "API.EXAMPLE.ORG.", // uppercase and trailing dot
          "192.168.1.1",
          "[2001:db8::1]",
        ],
      },
    });

    expect(config.security.allowedUpstreamHosts).toEqual([
      "api.example.com",
      "api.example.org",
      "192.168.1.1",
      "2001:db8:0:0:0:0:0:1",
    ]);
  });

  it("rejects invalid hosts with schemes, ports, paths, queries, credentials, or wildcards", () => {
    const invalidHosts = [
      "https://api.example.com",
      "http://api.example.com",
      "api.example.com:8080",
      "api.example.com/v1",
      "api.example.com?query=1",
      "api.example.com#hash",
      "user:pass@api.example.com",
      "*.example.com",
      "api.*.com",
      "",
      "   ",
      "api .example.com",
    ];

    for (const badHost of invalidHosts) {
      const res = safeParseConfig({
        version: 1,
        name: "test",
        security: {
          allowedUpstreamHosts: [badHost],
        },
      });
      expect(res.success, `Expected host '${badHost}' to be rejected`).toBe(
        false,
      );
    }
  });
});

describe("rateLimit configuration and factory", () => {
  it("parses shorthand and structured quota/concurrency policies", () => {
    const config = parseConfig({
      version: 1,
      name: "test",
      rateLimit: {
        enabled: true,
        requestsPerMinute: 60,
        concurrency: 5,
        globalQuota: { maxRequests: 100, windowMs: 30_000 },
        globalConcurrency: 10,
        tenantQuota: { maxRequests: 50, windowMs: 60_000 },
        tenantConcurrency: 2,
        toolQuota: {
          expensiveTool: { maxRequests: 5, windowMs: 60_000 },
        },
        toolConcurrency: {
          expensiveTool: 1,
        },
        redis: {
          keyPrefix: "custom:prefix:",
          commandTimeoutMs: 2_000,
        },
        maxTrackedWindows: 5_000,
      },
    });

    expect(config.rateLimit).toMatchObject({
      enabled: true,
      provider: "memory",
      requestsPerMinute: 60,
      concurrency: 5,
      globalQuota: { maxRequests: 100, windowMs: 30_000 },
      globalConcurrency: 10,
      tenantQuota: { maxRequests: 50, windowMs: 60_000 },
      tenantConcurrency: 2,
      toolQuota: {
        expensiveTool: { maxRequests: 5, windowMs: 60_000 },
      },
      toolConcurrency: {
        expensiveTool: 1,
      },
      redis: {
        keyPrefix: "custom:prefix:",
        commandTimeoutMs: 2_000,
      },
      maxTrackedWindows: 5_000,
    });
  });

  it("returns undefined when rate limiting is disabled", () => {
    const limiter = createRateLimiterFromConfig({
      enabled: false,
      provider: "memory",
      failurePolicy: "fail-closed",
      redis: { keyPrefix: "p:", commandTimeoutMs: 1000 },
      maxTrackedWindows: 1000,
    });
    expect(limiter).toBeUndefined();
  });

  it("instantiates InMemoryRateLimiter with mapped shorthand requestsPerMinute and concurrency", async () => {
    const mockTime = 1_000_000;
    const limiter = createRateLimiterFromConfig(
      {
        enabled: true,
        provider: "memory",
        failurePolicy: "fail-closed",
        requestsPerMinute: 2,
        concurrency: 1,
        redis: { keyPrefix: "p:", commandTimeoutMs: 1000 },
        maxTrackedWindows: 1000,
      },
      { now: () => mockTime },
    );

    expect(limiter).toBeInstanceOf(InMemoryRateLimiter);
    const ctx = toolContext();

    // 1st call acquires concurrency permit and consumes quota
    expect((await limiter!.check(ctx, "tool-1")).allowed).toBe(true);
    // While in-flight, 2nd concurrent call is denied by concurrency: 1
    const deniedConcurrency = await limiter!.check(ctx, "tool-1");
    expect(deniedConcurrency.allowed).toBe(false);

    // Release slot after 1st invocation completes
    await limiter!.release?.(ctx, "tool-1");

    // 2nd call now succeeds
    expect((await limiter!.check(ctx, "tool-1")).allowed).toBe(true);
    await limiter!.release?.(ctx, "tool-1");

    // 3rd call denied by quota (requestsPerMinute: 2 reached in current window)
    const deniedQuota = await limiter!.check(ctx, "tool-1");
    expect(deniedQuota.allowed).toBe(false);
    expect(deniedQuota.retryAfterSeconds).toBe(60);
  });

  it("instantiates DistributedRateLimiter when provider is redis", async () => {
    const mockRedis: RedisRateLimitClient = {
      eval: vi.fn(async (script) => {
        if (script.includes("ACQUIRE_CONCURRENCY")) return 1;
        if (script.includes("ZREMRANGEBYSCORE")) return [1, 0];
        return 1;
      }),
    };

    const limiter = createRateLimiterFromConfig(
      {
        enabled: true,
        provider: "redis",
        failurePolicy: "fail-closed",
        globalQuota: { maxRequests: 10, windowMs: 60_000 },
        globalConcurrency: 5,
        redis: { keyPrefix: "prod:rl:", commandTimeoutMs: 1500 },
        maxTrackedWindows: 1000,
      },
      { redisClient: mockRedis },
    );

    expect(limiter).toBeInstanceOf(DistributedRateLimiter);
    const decision = await limiter!.check(toolContext(), "tool-1");
    expect(decision.allowed).toBe(true);
    expect(mockRedis.eval).toHaveBeenCalled();
  });

  it("throws TypeError if provider is redis but redisClient is not supplied", () => {
    expect(() =>
      createRateLimiterFromConfig({
        enabled: true,
        provider: "redis",
        failurePolicy: "fail-closed",
        redis: { keyPrefix: "p:", commandTimeoutMs: 1000 },
        maxTrackedWindows: 1000,
      }),
    ).toThrow(/rateLimit\.redis\.url.*CHAINMCP_REDIS_URL/);
  });

  it("constructs DistributedRateLimiter when provider is redis and url is in config", () => {
    const limiter = createRateLimiterFromConfig({
      enabled: true,
      provider: "redis",
      failurePolicy: "fail-closed",
      redis: {
        url: "redis://127.0.0.1:6379",
        keyPrefix: "test:rl:",
        commandTimeoutMs: 1000,
      },
      maxTrackedWindows: 1000,
    });
    expect(limiter).toBeInstanceOf(DistributedRateLimiter);
    expect((limiter as DistributedRateLimiter).client).toBeDefined();
    expect((limiter as DistributedRateLimiter).failurePolicy).toBe(
      "fail-closed",
    );
  });

  it("constructs DistributedRateLimiter when provider is redis and CHAINMCP_REDIS_URL is in env", () => {
    const prev = process.env.CHAINMCP_REDIS_URL;
    try {
      process.env.CHAINMCP_REDIS_URL = "redis://127.0.0.1:6380";
      const limiter = createRateLimiterFromConfig({
        enabled: true,
        provider: "redis",
        failurePolicy: "fail-open",
        redis: { keyPrefix: "env:rl:", commandTimeoutMs: 2000 },
        maxTrackedWindows: 1000,
      });
      expect(limiter).toBeInstanceOf(DistributedRateLimiter);
      expect((limiter as DistributedRateLimiter).client).toBeDefined();
      expect((limiter as DistributedRateLimiter).failurePolicy).toBe(
        "fail-open",
      );
    } finally {
      if (prev !== undefined) {
        process.env.CHAINMCP_REDIS_URL = prev;
      } else {
        delete process.env.CHAINMCP_REDIS_URL;
      }
    }
  });

  it("parses redis.tls options in RateLimitConfigSchema", () => {
    const config = parseConfig({
      version: 1,
      name: "test",
      rateLimit: {
        enabled: true,
        provider: "redis",
        redis: {
          url: "rediss://127.0.0.1:6380",
          tls: {
            rejectUnauthorized: false,
            servername: "redis.example.com",
            ca: "mock-ca",
          },
        },
      },
    });
    expect(config.rateLimit.redis.tls).toEqual({
      rejectUnauthorized: false,
      servername: "redis.example.com",
      ca: "mock-ca",
    });
  });

  it("shares the same Redis client instance between rateLimiter and cacheStore in buildRuntimeOptions", () => {
    const config = parseConfig({
      version: 1,
      name: "shared-client-test",
      rateLimit: {
        enabled: true,
        provider: "redis",
        redis: { url: "redis://127.0.0.1:6379" },
      },
      cache: {
        enabled: true,
        provider: "redis",
        redis: { url: "redis://127.0.0.1:6379" },
      },
    });

    const runtimeOptions = buildRuntimeOptions(config);
    expect(runtimeOptions.rateLimiter).toBeInstanceOf(DistributedRateLimiter);
    expect(runtimeOptions.cache?.store).toBeInstanceOf(RedisCacheStore);

    const rateLimitClient = (
      runtimeOptions.rateLimiter as DistributedRateLimiter
    ).client;
    const cacheClient = (runtimeOptions.cache?.store as RedisCacheStore).client;
    expect(rateLimitClient).toBe(cacheClient);
  });

  it("buildReadinessDeps is empty when no Redis dependencies are configured", () => {
    const config = parseConfig({ version: 1, name: "no-deps" });
    expect(buildReadinessDeps(config, {})).toEqual([]);
  });

  it("buildReadinessDeps probes the Redis client and never writes (fail-closed limiter)", async () => {
    const config = parseConfig({
      version: 1,
      name: "redis-ready",
      rateLimit: {
        enabled: true,
        provider: "redis",
        failurePolicy: "fail-closed",
        redis: { url: "redis://127.0.0.1:6379" },
      },
    });
    const evalCalls: string[] = [];
    const client: RedisRateLimitClient = {
      async eval(script) {
        evalCalls.push(script);
        return 1;
      },
    };
    const limiter = createRateLimiterFromConfig(config.rateLimit, {
      redisClient: client,
    });
    const deps = buildReadinessDeps(config, { rateLimiter: limiter });
    expect(deps).toEqual([
      { name: "rate-limiter", check: expect.any(Function) },
    ]);
    await expect(deps[0]!.check()).resolves.toBe(true);
    expect(evalCalls).toEqual(["return 1"]);
  });

  it("buildReadinessDeps reports an unreachable fail-closed limiter as unhealthy", async () => {
    const config = parseConfig({
      version: 1,
      name: "redis-down",
      rateLimit: {
        enabled: true,
        provider: "redis",
        failurePolicy: "fail-closed",
        redis: { url: "redis://127.0.0.1:6379" },
      },
    });
    const client: RedisRateLimitClient = {
      async eval() {
        throw new Error("ECONNREFUSED redis://user:password@secret-host");
      },
    };
    const limiter = createRateLimiterFromConfig(config.rateLimit, {
      redisClient: client,
    });
    const deps = buildReadinessDeps(config, { rateLimiter: limiter });
    await expect(deps[0]!.check()).resolves.toBe(false);
  });

  it("buildReadinessDeps marks a fail-open limiter degradedReady", () => {
    const config = parseConfig({
      version: 1,
      name: "redis-open",
      rateLimit: {
        enabled: true,
        provider: "redis",
        failurePolicy: "fail-open",
        redis: { url: "redis://127.0.0.1:6379" },
      },
    });
    const client: RedisRateLimitClient = {
      async eval() {
        return 1;
      },
    };
    const limiter = createRateLimiterFromConfig(config.rateLimit, {
      redisClient: client,
    });
    const deps = buildReadinessDeps(config, { rateLimiter: limiter });
    expect(deps[0]?.degradedReady).toBe(true);
  });

  it("buildReadinessDeps probes the cache store with a read, never a write", async () => {
    const config = parseConfig({
      version: 1,
      name: "cache-ready",
      cache: {
        enabled: true,
        provider: "redis",
        redis: { url: "redis://127.0.0.1:6379" },
      },
    });
    const calls: string[] = [];
    const cacheClient: RedisCacheClient = {
      async get(key) {
        calls.push(`get ${key}`);
        return null;
      },
      async set(key) {
        calls.push(`set ${key}`);
      },
      async delete(key) {
        calls.push(`delete ${key}`);
      },
    };
    const store = createCacheStoreFromConfig(config.cache, {
      redisClient: cacheClient,
    });
    const deps = buildReadinessDeps(config, { cacheStore: store });
    expect(deps[0]?.name).toBe("cache");
    await expect(deps[0]!.check()).resolves.toBe(true);
    expect(calls).toEqual(["get chainmcp:readiness:probe"]);
  });

  it("buildReadinessDeps reports an unreachable cache store as unhealthy", async () => {
    const config = parseConfig({
      version: 1,
      name: "cache-down",
      cache: {
        enabled: true,
        provider: "redis",
        redis: { url: "redis://127.0.0.1:6379" },
      },
    });
    const cacheClient: RedisCacheClient = {
      async get() {
        throw new Error("ECONNREFUSED");
      },
      async set() {},
      async delete() {},
    };
    const store = createCacheStoreFromConfig(config.cache, {
      redisClient: cacheClient,
    });
    const deps = buildReadinessDeps(config, { cacheStore: store });
    await expect(deps[0]!.check()).resolves.toBe(false);
  });

  it("logRateLimiterStartup logs connection health and quota summary without secrets", async () => {
    const logs: Array<{
      message: string;
      context?: Record<string, unknown> | undefined;
    }> = [];
    const mockLogger = {
      info(message: string, context?: Record<string, unknown>) {
        logs.push({ message, ...(context !== undefined ? { context } : {}) });
      },
      warn(message: string, context?: Record<string, unknown>) {
        logs.push({ message, ...(context !== undefined ? { context } : {}) });
      },
      debug() {},
      error() {},
    };

    const mockClient: RedisRateLimitClient = {
      async eval() {
        return 1;
      },
    };

    const health = await logRateLimiterStartup(
      {
        enabled: true,
        provider: "redis",
        failurePolicy: "fail-closed",
        requestsPerMinute: 120,
        concurrency: 10,
        redis: {
          url: "redis://:secret-password@127.0.0.1:6379",
          keyPrefix: "app:rl:",
          commandTimeoutMs: 1000,
        },
        maxTrackedWindows: 1000,
      },
      { logger: mockLogger, client: mockClient },
    );

    expect(health).toBeDefined();
    expect(health?.provider).toBe("redis");
    expect(health?.reachability).toBe("reachable");
    expect(health?.keyPrefix).toBe("app:rl:");
    expect(health?.quotaSummary.globalQuota?.maxRequests).toBe(120);
    expect(health?.quotaSummary.globalConcurrency).toBe(10);

    expect(logs.length).toBe(1);
    expect(logs[0]?.message).toBe("Rate limiter initialized");
    // Assert no password or URL in log output
    const logString = JSON.stringify(logs[0]);
    expect(logString).not.toContain("secret-password");
    expect(logString).not.toContain("redis://");
  });
});

describe("auth configuration and factories", () => {
  it("parses an explicit JWT tenant claim and rejects blank claim names", () => {
    const config = parseConfig({
      version: 1,
      name: "test",
      auth: { inbound: { jwt: { secret: "s", tenantClaim: " org_id " } } },
    });
    expect(config.auth.inbound.jwt?.tenantClaim).toBe("org_id");

    const invalid = safeParseConfig({
      version: 1,
      name: "test",
      auth: { inbound: { jwt: { secret: "s", tenantClaim: "  " } } },
    });
    expect(invalid.success).toBe(false);
  });

  it("parses static, env, secretStore, and oauth provider configurations", () => {
    const config = parseConfig({
      version: 1,
      name: "test",
      auth: {
        inbound: {
          requireInboundAuth: true,
          authorizer: "scope",
        },
        upstream: {
          providers: [
            {
              type: "static",
              credentials: {
                api_key: "my-key",
                bearer_auth: {
                  type: "http",
                  scheme: "bearer",
                  token: "tok",
                },
                basic_auth: {
                  type: "http",
                  scheme: "basic",
                  username: "u",
                  password: "p",
                },
                oauth_auth: {
                  type: "oauth2",
                  token: "otok",
                  tokenType: "Bearer",
                  expiresAt: 100000,
                  scopes: ["read"],
                },
              },
            },
            {
              type: "env",
              prefix: "CUSTOM_AUTH_",
            },
            {
              type: "secretStore",
              activeKeyId: "k1",
              keys: { k1: "a".repeat(64) },
              allowGlobalFallback: true,
            },
            {
              type: "oauth",
              tokenUrl: "https://auth.example.com/token",
              clientId: "cid",
              clientSecret: "csec",
              scopes: ["read", "write"],
              schemeNames: ["oauth_auth"],
              expirySkewSeconds: 45,
              allowedTokenHosts: ["auth.example.com"],
            },
          ],
        },
      },
    });

    expect(config.auth.upstream.providers).toHaveLength(4);
    expect(config.auth.inbound).toMatchObject({
      requireInboundAuth: true,
      authorizer: "scope",
    });
  });

  it("createAuthorizerFromConfig creates OperationScopeAuthorizer or returns undefined", () => {
    const authorizer = createAuthorizerFromConfig({
      requireInboundAuth: true,
      authorizer: "scope",
    });
    expect(authorizer).toBeInstanceOf(OperationScopeAuthorizer);

    const noneAuthorizer = createAuthorizerFromConfig({
      requireInboundAuth: true,
      authorizer: "none",
    });
    expect(noneAuthorizer).toBeUndefined();
  });

  it("createUpstreamCredentialProviderFromConfig builds single or composite providers", async () => {
    // 1. Empty providers returns undefined
    expect(
      createUpstreamCredentialProviderFromConfig({ providers: [] }),
    ).toBeUndefined();

    // 2. Single static provider returns provider that resolves credentials
    const singleStatic = createUpstreamCredentialProviderFromConfig({
      providers: [
        {
          type: "static",
          credentials: {
            test_key: "secret-key-123",
          },
        },
      ],
    });
    expect(singleStatic).toBeDefined();
    const cred = await singleStatic!.resolveCredential({
      tenantId: "t1",
      toolName: "op",
      schemeName: "test_key",
      schemeType: "apiKey",
      parameterName: "X-Key",
      parameterLocation: "header",
    });
    expect(cred).toEqual({
      type: "apiKey",
      name: "X-Key",
      location: "header",
      value: "secret-key-123",
    });

    // 3. Composite provider with static and env
    process.env["CHAINMCP_AUTH_ENV_KEY"] = "from-env-secret";
    try {
      const composite = createUpstreamCredentialProviderFromConfig({
        providers: [
          {
            type: "static",
            credentials: { static_scheme: "static-val" },
          },
          {
            type: "env",
            prefix: "CHAINMCP_AUTH_",
          },
        ],
      });
      expect(composite).toBeDefined();

      // Resolves from first (static)
      const resStatic = await composite!.resolveCredential({
        tenantId: "t1",
        toolName: "op",
        schemeName: "static_scheme",
        schemeType: "apiKey",
        parameterName: "X-Static",
        parameterLocation: "header",
      });
      expect(resStatic).toMatchObject({ value: "static-val" });

      // Resolves from second (env)
      const resEnv = await composite!.resolveCredential({
        tenantId: "t1",
        toolName: "op",
        schemeName: "env_key",
        schemeType: "apiKey",
        parameterName: "X-Env",
        parameterLocation: "header",
      });
      expect(resEnv).toMatchObject({ value: "from-env-secret" });
    } finally {
      delete process.env["CHAINMCP_AUTH_ENV_KEY"];
    }
  });
});

describe("buildExecutorOptions and buildRuntimeOptions", () => {
  it("buildExecutorOptions wires security.allowedUpstreamHosts, timeoutMs, maxResponseBytes, and credentials", async () => {
    const config = parseConfig({
      version: 1,
      name: "test",
      server: {
        requestTimeoutMs: 25_000,
        maxResponseBytes: 2_500_000,
      },
      security: {
        allowedUpstreamHosts: ["api.example.com", "backup.example.com"],
      },
      auth: {
        upstream: {
          providers: [
            {
              type: "static",
              credentials: { my_key: "system-key-val" },
            },
          ],
        },
      },
    });

    const opts = buildExecutorOptions(config, {
      baseUrl: "https://api.example.com/v1",
    });

    expect(opts.baseUrl).toBe("https://api.example.com/v1");
    expect(opts.allowedHosts).toEqual([
      "api.example.com",
      "backup.example.com",
    ]);
    expect(opts.timeoutMs).toBe(25_000);
    expect(opts.maxResponseBytes).toBe(2_500_000);
    expect(opts.credentialProvider).toBeDefined();

    const cred = await opts.credentialProvider!.resolveCredential({
      tenantId: "t1",
      toolName: "op",
      schemeName: "my_key",
      schemeType: "apiKey",
      parameterName: "X-Key",
      parameterLocation: "header",
    });
    expect(cred).toMatchObject({ value: "system-key-val" });
  });

  it("buildExecutorOptions fails closed if allowedUpstreamHosts is empty and no override provided", () => {
    const config = parseConfig({
      version: 1,
      name: "test",
      security: {
        allowedUpstreamHosts: [],
      },
    });

    expect(() =>
      buildExecutorOptions(config, {
        baseUrl: "https://api.example.com",
      }),
    ).toThrow(/security.allowedUpstreamHosts is empty/);
  });

  it("buildRuntimeOptions wires authorizer, rateLimiter, and defaultTimeoutMs", () => {
    const config = parseConfig({
      version: 1,
      name: "test",
      server: {
        requestTimeoutMs: 12_000,
      },
      security: {
        requireInboundAuth: true,
      },
      rateLimit: {
        enabled: true,
        requestsPerMinute: 60,
      },
    });

    const runtimeOpts = buildRuntimeOptions(config);
    expect(runtimeOpts.defaultTimeoutMs).toBe(12_000);
    expect(runtimeOpts.authorizer).toBeInstanceOf(OperationScopeAuthorizer);
    expect(runtimeOpts.rateLimiter).toBeInstanceOf(InMemoryRateLimiter);
    expect(runtimeOpts.maxToolInputBytes).toBe(1_048_576);
    expect(runtimeOpts.maxResponseBytes).toBe(1_000_000);
    expect(runtimeOpts.onShutdown).toBeUndefined();
  });

  it("buildRuntimeOptions drains the Redis client it created exactly once", async () => {
    const config = parseConfig({
      version: 1,
      name: "test",
      rateLimit: {
        enabled: true,
        provider: "redis",
        requestsPerMinute: 60,
      },
      cache: {
        enabled: true,
        provider: "redis",
      },
    });

    const runtimeOpts = buildRuntimeOptions(
      config,
      {},
      { env: { CHAINMCP_REDIS_URL: "redis://127.0.0.1:1" } },
    );
    expect(runtimeOpts.onShutdown).toBeTypeOf("function");

    await expect(runtimeOpts.onShutdown?.()).resolves.toBeUndefined();
    // The factory-owned client is idempotent, so a repeated teardown is safe.
    await expect(runtimeOpts.onShutdown?.()).resolves.toBeUndefined();
  });

  it("buildExecutorOptions and buildRuntimeOptions configure response validation and input size caps", () => {
    const config = parseConfig({
      version: 1,
      name: "test",
      server: {
        validateResponses: "enforce",
        maxToolInputBytes: 50_000,
        maxResponseBytes: 200_000,
        maxRequestBytes: 300_000,
        maxMultipartPartBytes: 150_000,
      },
      security: {
        allowedUpstreamHosts: ["api.example.com"],
      },
    });

    const execOpts = buildExecutorOptions(config, {
      baseUrl: "https://api.example.com",
    });
    expect(execOpts.validateResponses).toBe("enforce");
    expect(execOpts.maxResponseBytes).toBe(200_000);
    expect(execOpts.maxRequestBytes).toBe(300_000);
    expect(execOpts.maxMultipartPartBytes).toBe(150_000);

    const runtimeOpts = buildRuntimeOptions(config);
    expect(runtimeOpts.maxToolInputBytes).toBe(50_000);
    expect(runtimeOpts.maxResponseBytes).toBe(200_000);
  });

  describe("logging configuration and factory", () => {
    it("parses logging configuration defaults", () => {
      const config = parseConfig({ version: 1, name: "test" });
      expect(config.logging).toEqual({
        level: "info",
        destination: "stdout",
        redactKeys: [],
        includeRequestBodies: false,
        includeResponseBodies: false,
      });
    });

    it("resolves log levels with environment variable overrides", () => {
      expect(resolveLogLevel(undefined, "info")).toBe("info");
      expect(resolveLogLevel("debug", "warn")).toBe("debug");
      expect(resolveLogLevel("ERROR", "info")).toBe("error");
      expect(resolveLogLevel("invalid", "info")).toBe("info");
    });

    it("creates structured logger from config and respects memory sink", () => {
      const config = parseConfig({
        version: 1,
        name: "test",
        logging: {
          level: "warn",
          destination: "memory",
          redactKeys: ["custom_secret"],
        },
      });

      const sink = new MemorySink();
      const logger = createLoggerFromConfig(config.logging, { sink });
      expect(logger).toBeInstanceOf(StructuredLogger);

      logger.info("should be filtered");
      logger.warn("warning with secret", { custom_secret: "12345" });

      expect(sink.getRecords()).toHaveLength(1);
      expect(sink.getRecords()[0]?.context?.custom_secret).toBe("[REDACTED]");
    });
  });

  describe("jsonNavigation configuration", () => {
    it("parses jsonNavigation defaults", () => {
      const config = parseConfig({ version: 1, name: "test" });
      expect(config.jsonNavigation).toEqual({
        enabled: true,
        maxDepth: 16,
        maxArrayItems: 1_000,
        maxResultBytes: 50_000,
        maxVisitedNodes: 50_000,
        timeoutMs: 5_000,
        handles: {
          enabled: true,
          maxPerPrincipal: 50,
          maxPerTenant: 250,
          maxTotal: 1_000,
          maxBytes: 1_000_000,
          maxTotalBytes: 8_000_000,
          ttlMs: 600_000,
          minBytes: 0,
        },
      });
    });

    it("maps handle config into registry options when enabled", () => {
      const config = parseConfig({
        version: 1,
        name: "test",
        jsonNavigation: { handles: { enabled: true, maxPerPrincipal: 10 } },
      });
      expect(
        createHandleRegistryOptionsFromConfig(config.jsonNavigation),
      ).toEqual({
        maxPerPrincipal: 10,
        maxPerTenant: 250,
        maxTotal: 1_000,
        maxBytes: 1_000_000,
        maxTotalBytes: 8_000_000,
        ttlMs: 600_000,
        minBytes: 0,
      });
    });

    it("returns undefined handle options when handles are disabled", () => {
      const config = parseConfig({
        version: 1,
        name: "test",
        jsonNavigation: { handles: { enabled: false } },
      });
      expect(
        createHandleRegistryOptionsFromConfig(config.jsonNavigation),
      ).toBeUndefined();
    });

    it("maps config into NavigationLimits", () => {
      const config = parseConfig({
        version: 1,
        name: "test",
        jsonNavigation: {
          maxDepth: 8,
          maxArrayItems: 200,
          maxResultBytes: 25_000,
        },
      });

      const limits = createNavigationLimitsFromConfig(config.jsonNavigation);
      expect(limits).toMatchObject({
        maxDepth: 8,
        maxArrayItems: 200,
        maxResultBytes: 25_000,
      });
    });
  });

  describe("analytics and telemetry wiring", () => {
    it("parses analytics defaults", () => {
      const config = parseConfig({ version: 1, name: "test" });
      expect(config.analytics).toEqual({
        enabled: true,
        includeArguments: false,
        includeResponseBodies: false,
        retentionDays: 14,
        openTelemetry: {
          enabled: false,
          serviceName: "chainmcp",
          tracing: {
            enabled: false,
            sampleRatio: 0.1,
          },
          ingestion: {
            enabled: false,
            maxRequestBytes: 5242880,
          },
        },
      });
    });

    it("parses custom openTelemetry tracing configuration", () => {
      const config = parseConfig({
        version: 1,
        name: "test",
        analytics: {
          openTelemetry: {
            enabled: true,
            serviceName: "custom-service",
            tracing: {
              enabled: true,
              sampleRatio: 0.5,
            },
          },
        },
      });
      expect(config.analytics.openTelemetry.tracing).toEqual({
        enabled: true,
        sampleRatio: 0.5,
      });
    });

    it("wires rolling aggregator when openTelemetry is disabled", () => {
      const config = parseConfig({
        version: 1,
        name: "test",
        analytics: {
          enabled: true,
          openTelemetry: { enabled: false },
        },
      });

      const runtimeOpts = buildRuntimeOptions(config);
      expect(runtimeOpts.metrics).toBeInstanceOf(RollingAnalyticsAggregator);
      expect(runtimeOpts.logger).toBeInstanceOf(StructuredLogger);
      expect(runtimeOpts.tracer).toBeUndefined();
    });

    it("wires OpenTelemetryMetricsSink when openTelemetry is enabled", () => {
      const config = parseConfig({
        version: 1,
        name: "test",
        analytics: {
          enabled: true,
          openTelemetry: { enabled: true, serviceName: "test-service" },
        },
      });

      const runtimeOpts = buildRuntimeOptions(config);
      expect(runtimeOpts.metrics).toBeInstanceOf(OpenTelemetryMetricsSink);
      expect(runtimeOpts.tracer).toBeUndefined();
    });

    it("wires ToolTracer when openTelemetry and tracing are both enabled", () => {
      const config = parseConfig({
        version: 1,
        name: "test",
        analytics: {
          enabled: true,
          openTelemetry: {
            enabled: true,
            serviceName: "test-service",
            tracing: {
              enabled: true,
              sampleRatio: 0.75,
            },
          },
        },
      });

      const runtimeOpts = buildRuntimeOptions(config);
      expect(runtimeOpts.tracer).toBeInstanceOf(ToolTracer);
    });

    it("creates OtlpIngestionSink when openTelemetry and ingestion are both enabled", () => {
      const config = parseConfig({
        version: 1,
        name: "test",
        analytics: {
          enabled: true,
          openTelemetry: {
            enabled: true,
            ingestion: {
              enabled: true,
              maxRequestBytes: 2 * 1024 * 1024,
            },
          },
        },
      });

      const sink = createOtlpIngestionSinkFromConfig(config.analytics);
      expect(sink).toBeDefined();

      const disabledConfig = parseConfig({
        version: 1,
        name: "test",
        analytics: {
          enabled: true,
          openTelemetry: {
            enabled: true,
            ingestion: { enabled: false },
          },
        },
      });
      expect(
        createOtlpIngestionSinkFromConfig(disabledConfig.analytics),
      ).toBeUndefined();
    });
  });

  describe("cache, tokenMetrics, and projection configuration and factories", () => {
    it("parses cache, tokenMetrics, and projection defaults", () => {
      const config = parseConfig({
        version: 1,
        name: "test-cache",
      });

      expect(config.cache).toEqual({
        enabled: false,
        provider: "memory",
        ttlSeconds: 300,
        maxEntries: 10_000,
        redis: {
          keyPrefix: "chainmcp:cache:",
          commandTimeoutMs: 1_000,
        },
      });

      expect(config.tokenMetrics).toEqual({
        enabled: false,
        tokenizer: "approximate",
        modelId: "cl100k_base",
        charactersPerToken: 4,
      });

      expect(config.projection).toEqual({
        enabled: true,
      });
    });

    it("creates InMemoryCacheStore when cache is enabled and provider is memory", () => {
      const store = createCacheStoreFromConfig({
        enabled: true,
        provider: "memory",
        ttlSeconds: 600,
        maxEntries: 500,
        redis: { keyPrefix: "test:", commandTimeoutMs: 1_000 },
      });

      expect(store).toBeInstanceOf(InMemoryCacheStore);
    });

    it("returns undefined when cache is disabled", () => {
      const store = createCacheStoreFromConfig({
        enabled: false,
        provider: "memory",
        ttlSeconds: 600,
        maxEntries: 500,
        redis: { keyPrefix: "test:", commandTimeoutMs: 1_000 },
      });

      expect(store).toBeUndefined();
    });

    it("creates RedisCacheStore when provider is redis and client is provided", () => {
      const mockRedisClient: RedisCacheClient = {
        get: vi.fn(),
        set: vi.fn(),
        delete: vi.fn(),
      };

      const store = createCacheStoreFromConfig(
        {
          enabled: true,
          provider: "redis",
          ttlSeconds: 300,
          maxEntries: 1_000,
          redis: { keyPrefix: "chainmcp:test:", commandTimeoutMs: 1_000 },
        },
        { redisClient: mockRedisClient },
      );

      expect(store).toBeInstanceOf(RedisCacheStore);
    });

    it("throws TypeError if provider is redis but neither client nor URL is provided", () => {
      expect(() =>
        createCacheStoreFromConfig({
          enabled: true,
          provider: "redis",
          ttlSeconds: 300,
          maxEntries: 1_000,
          redis: { keyPrefix: "chainmcp:test:", commandTimeoutMs: 1_000 },
        }),
      ).toThrow(TypeError);
    });

    it("creates RedisCacheStore with URL and TLS in config", () => {
      const store = createCacheStoreFromConfig({
        enabled: true,
        provider: "redis",
        ttlSeconds: 300,
        maxEntries: 1_000,
        redis: {
          url: "rediss://127.0.0.1:6380",
          keyPrefix: "chainmcp:test:",
          commandTimeoutMs: 1_000,
          tls: { rejectUnauthorized: false },
        },
      });

      expect(store).toBeInstanceOf(RedisCacheStore);
      expect((store as RedisCacheStore).client).toBeDefined();
    });

    it("creates approximate tokenizer from config", () => {
      const tokenizer = createTokenizerFromConfig({
        enabled: true,
        tokenizer: "approximate",
        modelId: "gpt-4o",
        charactersPerToken: 4,
      });

      expect(tokenizer).toBeDefined();
      expect(tokenizer?.id).toBe("gpt-4o");
      expect(tokenizer?.measurement).toBe("estimate");
      expect(tokenizer?.count("12345678")).toBe(2);
      expect(tokenizer?.count("12345")).toBe(2);
      expect(tokenizer?.count("")).toBe(0);
    });

    it("fails fast when exact measurement has no tokenizer source", () => {
      expect(() =>
        createTokenizerFromConfig({
          enabled: true,
          tokenizer: "exact",
          modelId: "gpt-4o",
          charactersPerToken: 4,
        }),
      ).toThrowError(
        expect.objectContaining({ code: "TOKENIZER_SOURCE_REQUIRED" }),
      );
    });

    it("loads an exact tokenizer from a registered factory", async () => {
      const adapter = {
        id: "gpt-4o",
        measurement: "exact" as const,
        count: (text: string) => text.length,
      };
      const factory = vi.fn(() => adapter);
      registerTokenizerFactory("gpt-4o", factory);
      try {
        const tokenizer = await loadTokenizerFromConfig({
          enabled: true,
          tokenizer: "exact",
          modelId: "gpt-4o",
          charactersPerToken: 4,
        });

        expect(factory).toHaveBeenCalledOnce();
        expect(tokenizer).toBe(adapter);
        expect(tokenizer?.measurement).toBe("exact");
      } finally {
        unregisterTokenizerFactory("gpt-4o");
      }
    });

    it("rejects an exact factory that declares an estimate", async () => {
      registerTokenizerFactory("gpt-4o", () => ({
        id: "gpt-4o",
        measurement: "estimate",
        count: () => 1,
      }));
      try {
        await expect(
          loadTokenizerFromConfig({
            enabled: true,
            tokenizer: "exact",
            modelId: "gpt-4o",
            charactersPerToken: 4,
          }),
        ).rejects.toMatchObject({ code: "TOKENIZER_INVALID" });
      } finally {
        unregisterTokenizerFactory("gpt-4o");
      }
    });

    it("wraps tokenizer factory failures with a stable code", async () => {
      registerTokenizerFactory("gpt-4o", () => {
        throw new Error("factory exploded");
      });
      try {
        await expect(
          loadTokenizerFromConfig({
            enabled: true,
            tokenizer: "exact",
            modelId: "gpt-4o",
            charactersPerToken: 4,
          }),
        ).rejects.toMatchObject({ code: "TOKENIZER_FACTORY_FAILED" });
      } finally {
        unregisterTokenizerFactory("gpt-4o");
      }
    });

    it("rejects an exact configuration with no registered factory", async () => {
      await expect(
        loadTokenizerFromConfig({
          enabled: true,
          tokenizer: "exact",
          modelId: "unregistered-model",
          charactersPerToken: 4,
        }),
      ).rejects.toMatchObject({ code: "TOKENIZER_SOURCE_REQUIRED" });
    });

    it("wraps tokenizer module load failures with a stable code", async () => {
      const dir = await mkdtemp(join(tmpdir(), "chainmcp-tokenizer-"));
      try {
        await expect(
          loadTokenizerFromConfig(
            {
              enabled: true,
              tokenizer: "exact",
              modelId: "gpt-4o",
              charactersPerToken: 4,
              module: "./missing-tokenizer.mjs",
            },
            { baseDir: dir },
          ),
        ).rejects.toMatchObject({ code: "TOKENIZER_MODULE_INVALID" });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("rejects blank tokenizer factory registrations", () => {
      expect(() =>
        registerTokenizerFactory(" ", () => ({
          id: "x",
          measurement: "exact",
          count: () => 1,
        })),
      ).toThrow(TypeError);
    });

    it("loads an exact tokenizer module relative to the config directory", async () => {
      const dir = await mkdtemp(join(tmpdir(), "chainmcp-tokenizer-"));
      try {
        await writeFile(
          join(dir, "tokenizer.mjs"),
          `export function createTokenizer(config) {
            return {
              id: config.modelId,
              measurement: "exact",
              count: (text) => text.length,
            };
          }\n`,
          "utf8",
        );

        const tokenizer = await loadTokenizerFromConfig(
          {
            enabled: true,
            tokenizer: "exact",
            modelId: "gpt-4o-mini",
            charactersPerToken: 4,
            module: "./tokenizer.mjs",
          },
          { baseDir: dir },
        );

        expect(tokenizer?.id).toBe("gpt-4o-mini");
        expect(tokenizer?.measurement).toBe("exact");
        expect(tokenizer?.count("hello")).toBe(5);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("rejects module adapters that do not match modelId", async () => {
      const dir = await mkdtemp(join(tmpdir(), "chainmcp-tokenizer-"));
      try {
        await writeFile(
          join(dir, "tokenizer.mjs"),
          `export default function createTokenizer() {
            return {
              id: "other-model",
              measurement: "exact",
              count: (text) => text.length,
            };
          }\n`,
          "utf8",
        );

        await expect(
          loadTokenizerFromConfig(
            {
              enabled: true,
              tokenizer: "exact",
              modelId: "gpt-4o",
              charactersPerToken: 4,
              module: "./tokenizer.mjs",
            },
            { baseDir: dir },
          ),
        ).rejects.toMatchObject({ code: "TOKENIZER_INVALID" });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("rejects tokenizer modules without a factory export", async () => {
      const dir = await mkdtemp(join(tmpdir(), "chainmcp-tokenizer-"));
      try {
        await writeFile(
          join(dir, "tokenizer.mjs"),
          `export const tokenizer = {
            id: "gpt-4o",
            measurement: "exact",
            count: (text) => text.length,
          };\n`,
          "utf8",
        );

        await expect(
          loadTokenizerFromConfig(
            {
              enabled: true,
              tokenizer: "exact",
              modelId: "gpt-4o",
              charactersPerToken: 4,
              module: "./tokenizer.mjs",
            },
            { baseDir: dir },
          ),
        ).rejects.toMatchObject({ code: "TOKENIZER_MODULE_INVALID" });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("requires tokenMetrics.tokenizer: exact when module is configured", () => {
      const result = safeParseConfig({
        version: 1,
        name: "invalid-tokenizer-module",
        tokenMetrics: { module: "./tokenizer.mjs" },
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toContain(
          "tokenMetrics.module requires tokenMetrics.tokenizer: exact",
        );
      }
    });

    it("rejects exact configuration in buildRuntimeOptions unless a tokenizer is injected", () => {
      const config = parseConfig({
        version: 1,
        name: "exact-without-factory",
        tokenMetrics: { enabled: true, tokenizer: "exact", modelId: "gpt-4o" },
      });

      expect(() => buildRuntimeOptions(config)).toThrow(TokenizerConfigError);

      const adapter = {
        id: "gpt-4o",
        measurement: "exact" as const,
        count: (text: string) => text.length,
      };
      const runtimeOptions = buildRuntimeOptions(config, {
        tokenizer: adapter,
      });
      expect(runtimeOptions.tokenizer).toBe(adapter);
    });

    it("wires cache, tokenizer, and projector into buildRuntimeOptions", () => {
      const config = parseConfig({
        version: 1,
        name: "test-runtime",
        cache: {
          enabled: true,
          provider: "memory",
          ttlSeconds: 120,
          maxEntries: 200,
        },
        tokenMetrics: {
          enabled: true,
          modelId: "test-model",
          charactersPerToken: 3,
        },
        projection: {
          enabled: true,
        },
      });

      const runtimeOpts = buildRuntimeOptions(config);
      expect(runtimeOpts.cache).toBeDefined();
      expect(runtimeOpts.cache?.store).toBeInstanceOf(InMemoryCacheStore);
      const dummyTool: ToolDefinition = {
        name: "testTool",
        description: "test",
        inputSchema: { type: "object" },
        operation: {},
        execute: async () => ({}),
      };
      expect(
        runtimeOpts.cache?.authorizationPartition(toolContext(), dummyTool),
      ).toBe("read");

      expect(runtimeOpts.tokenizer).toBeDefined();
      expect(runtimeOpts.tokenizer?.id).toBe("test-model");
      expect(runtimeOpts.tokenizer?.count("123456")).toBe(2);

      expect(runtimeOpts.projector).toBeDefined();
    });

    it("passes defaultReadCacheTtlSeconds to buildExecutorOptions when cache is enabled", () => {
      const config = parseConfig({
        version: 1,
        name: "test-exec",
        security: {
          allowedUpstreamHosts: ["api.example.com"],
        },
        cache: {
          enabled: true,
          ttlSeconds: 450,
        },
      });

      const execOpts = buildExecutorOptions(config, {
        baseUrl: "https://api.example.com",
      });

      expect(execOpts.defaultReadCacheTtlSeconds).toBe(450);
    });
  });

  describe("gateway configuration schema", () => {
    it("parses valid gateway configuration with contracts and server settings", () => {
      const config = parseGatewayConfig({
        version: 1,
        name: "my-gateway",
        server: {
          transport: "http",
          port: 8080,
          host: "0.0.0.0",
        },
        contracts: [
          {
            name: "petstore",
            tenantId: "tenant-1",
            spec: "./petstore.yaml",
            destination: {
              baseUrl: "https://api.petstore.com",
              allowedHosts: ["api.petstore.com"],
            },
            auth: {
              requiredScopes: ["pets:read"],
            },
          },
        ],
      });

      expect(config.version).toBe(1);
      expect(config.name).toBe("my-gateway");
      expect(config.server.transport).toBe("http");
      expect(config.server.port).toBe(8080);
      expect(config.server.host).toBe("0.0.0.0");
      expect(config.contracts).toHaveLength(1);
      expect(config.contracts[0]?.name).toBe("petstore");
      expect(config.contracts[0]?.tenantId).toBe("tenant-1");
      expect(config.contracts[0]?.autoActivate).toBe(true);
    });

    it("rejects invalid contract names or missing destinations", () => {
      const result = safeParseGatewayConfig({
        version: 1,
        name: "invalid-gw",
        contracts: [
          {
            name: "invalid name with spaces!",
            tenantId: "t1",
            spec: "./spec.yaml",
            destination: {
              baseUrl: "https://example.com",
              allowedHosts: [],
            },
          },
        ],
      });

      expect(result.success).toBe(false);
    });
  });

  describe("Server CORS configuration", () => {
    it("parses valid CORS object configuration", () => {
      const config = parseConfig({
        version: 1,
        name: "test-server",
        server: {
          cors: {
            enabled: true,
            allowedOrigins: [
              "https://app.example.com",
              "https://admin.example.com",
            ],
            allowedHeaders: ["X-Tenant-Key", "X-Trace-Id"],
            allowCredentials: true,
            maxAgeSeconds: 3600,
          },
        },
      });

      expect(config.server.cors).toEqual({
        enabled: true,
        allowedOrigins: [
          "https://app.example.com",
          "https://admin.example.com",
        ],
        allowedHeaders: ["X-Tenant-Key", "X-Trace-Id"],
        allowCredentials: true,
        maxAgeSeconds: 3600,
      });
    });

    it("parses shorthand cors: false and cors: true", () => {
      const disabled = parseConfig({
        version: 1,
        name: "test-server",
        server: { cors: false },
      });
      expect(disabled.server.cors).toEqual({
        enabled: false,
        allowedOrigins: [],
        allowedHeaders: [],
        allowCredentials: false,
        maxAgeSeconds: 600,
      });

      const enabled = parseConfig({
        version: 1,
        name: "test-server",
        server: { cors: true },
      });
      expect(enabled.server.cors).toEqual({
        enabled: true,
        allowedOrigins: [],
        allowedHeaders: [],
        allowCredentials: false,
        maxAgeSeconds: 600,
      });
    });

    it("allows wildcard origin '*' when allowCredentials is false", () => {
      const config = parseConfig({
        version: 1,
        name: "test-server",
        server: {
          cors: {
            allowedOrigins: ["*"],
            allowCredentials: false,
          },
        },
      });
      expect(config.server.cors.allowedOrigins).toEqual(["*"]);
      expect(config.server.cors.allowCredentials).toBe(false);
    });

    it("rejects wildcard origin '*' when allowCredentials is true", () => {
      const result = safeParseConfig({
        version: 1,
        name: "test-server",
        server: {
          cors: {
            allowedOrigins: ["*"],
            allowCredentials: true,
          },
        },
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        const errorMsg = result.error.issues[0]?.message;
        expect(errorMsg).toContain(
          "Wildcard origin ('*') cannot be used when allowCredentials is true",
        );
      }
    });

    it("allows specific origin when allowCredentials is true", () => {
      const config = parseConfig({
        version: 1,
        name: "test-server",
        server: {
          cors: {
            allowedOrigins: ["https://app.example.com"],
            allowCredentials: true,
          },
        },
      });
      expect(config.server.cors.allowedOrigins).toEqual([
        "https://app.example.com",
      ]);
      expect(config.server.cors.allowCredentials).toBe(true);
    });
  });

  describe("BaseUrlSchema and upstream base URL handling (RM-06)", () => {
    it("validates and normalizes valid absolute HTTP and HTTPS URLs with port and path", () => {
      expect(BaseUrlSchema.parse("http://127.0.0.1:8080")).toBe(
        "http://127.0.0.1:8080",
      );
      expect(BaseUrlSchema.parse("https://api.example.com:8443/v2")).toBe(
        "https://api.example.com:8443/v2",
      );
      expect(BaseUrlSchema.parse("https://api.example.com/v1/subpath")).toBe(
        "https://api.example.com/v1/subpath",
      );
    });

    it("normalizes trailing slashes exactly once", () => {
      expect(BaseUrlSchema.parse("https://api.example.com/")).toBe(
        "https://api.example.com",
      );
      expect(BaseUrlSchema.parse("https://api.example.com///")).toBe(
        "https://api.example.com",
      );
      expect(BaseUrlSchema.parse("https://api.example.com/v2/")).toBe(
        "https://api.example.com/v2",
      );
      expect(BaseUrlSchema.parse("https://api.example.com/v2///")).toBe(
        "https://api.example.com/v2",
      );
      expect(BaseUrlSchema.parse("http://127.0.0.1:8080/")).toBe(
        "http://127.0.0.1:8080",
      );
    });

    it("rejects URLs with embedded credentials", () => {
      expect(() =>
        BaseUrlSchema.parse("https://user:pass@api.example.com"),
      ).toThrow(/credentials/);
      expect(() => BaseUrlSchema.parse("https://user@api.example.com")).toThrow(
        /credentials/,
      );
      expect(() =>
        BaseUrlSchema.parse("https://:pass@api.example.com"),
      ).toThrow(/credentials/);
    });

    it("rejects URLs with query parameters or fragments", () => {
      expect(() =>
        BaseUrlSchema.parse("https://api.example.com/v2?query=1"),
      ).toThrow(/query parameters or fragments/);
      expect(() =>
        BaseUrlSchema.parse("https://api.example.com/v2#section"),
      ).toThrow(/query parameters or fragments/);
    });

    it("rejects non-HTTP/HTTPS schemes and relative URLs", () => {
      expect(() => BaseUrlSchema.parse("ftp://api.example.com")).toThrow(
        /Only http: and https: are supported/,
      );
      expect(() => BaseUrlSchema.parse("/v2/pets")).toThrow(
        /not a valid absolute URL/,
      );
      expect(() => BaseUrlSchema.parse("api.example.com/v2")).toThrow(
        /not a valid absolute URL/,
      );
    });

    it("auto-derives baseUrl host into security.allowedUpstreamHosts in ChainMcpConfigSchema", () => {
      const config = parseConfig({
        version: 1,
        name: "test-server",
        contract: {
          source: "./spec/openapi.yaml",
          baseUrl: "https://api.example.com/v2/",
        },
      });

      expect(config.contract?.baseUrl).toBe("https://api.example.com/v2");
      expect(config.security.allowedUpstreamHosts).toContain("api.example.com");
    });

    it("preserves explicit extra allowedUpstreamHosts when baseUrl host is auto-derived", () => {
      const config = parseConfig({
        version: 1,
        name: "test-server",
        contract: {
          source: "./spec/openapi.yaml",
          baseUrl: "https://api.example.com/v2",
        },
        security: {
          allowedUpstreamHosts: ["auxiliary.example.com"],
        },
      });

      expect(config.security.allowedUpstreamHosts).toEqual([
        "api.example.com",
        "auxiliary.example.com",
      ]);
    });

    it("parses security.allowInsecureHttp", () => {
      const config = parseConfig({
        version: 1,
        name: "test-server",
        contract: {
          source: "./spec/openapi.yaml",
          baseUrl: "http://127.0.0.1:8080",
        },
        security: {
          allowInsecureHttp: true,
        },
      });

      expect(config.security.allowInsecureHttp).toBe(true);
      expect(config.contract?.baseUrl).toBe("http://127.0.0.1:8080");
      expect(config.security.allowedUpstreamHosts).toContain("127.0.0.1");
    });

    it("buildExecutorOptions resolves baseUrl from config.contract.baseUrl", () => {
      const config = parseConfig({
        version: 1,
        name: "test-server",
        contract: {
          source: "./spec/openapi.yaml",
          baseUrl: "https://api.example.com/v2",
        },
      });

      const options = buildExecutorOptions(config);
      expect(options.baseUrl).toBe("https://api.example.com/v2");
      expect(options.allowedHosts).toContain("api.example.com");
    });

    it("buildExecutorOptions propagates security.allowInsecureHttp", () => {
      const config = parseConfig({
        version: 1,
        name: "test-server",
        contract: {
          source: "./spec/openapi.yaml",
          baseUrl: "http://127.0.0.1:8080",
        },
        security: {
          allowInsecureHttp: true,
        },
      });

      const options = buildExecutorOptions(config);
      expect(options.baseUrl).toBe("http://127.0.0.1:8080");
      expect(options.allowInsecureHttp).toBe(true);
      expect(options.allowedHosts).toContain("127.0.0.1");
    });

    it("auto-derives destination.allowedHosts from baseUrl in GatewayContractDestinationSchema", () => {
      const gatewayConfig = parseGatewayConfig({
        version: 1,
        name: "gateway",
        contracts: [
          {
            name: "service-a",
            tenantId: "tenant-1",
            spec: "https://example.com/openapi.json",
            destination: {
              baseUrl: "https://internal.service.local:9000/api",
            },
          },
        ],
      });

      const contract = gatewayConfig.contracts[0];
      expect(contract?.destination.baseUrl).toBe(
        "https://internal.service.local:9000/api",
      );
      expect(contract?.destination.allowedHosts).toEqual([
        "internal.service.local",
      ]);
    });

    it("parses storage config and creates storage drivers", async () => {
      expect(StorageConfigSchema.parse({})).toEqual({
        enabled: false,
        driver: "memory",
        busyTimeoutMs: 5_000,
      });

      const defaultCfg = parseConfig({
        version: 1,
        name: "default-storage",
      });
      expect(defaultCfg.storage).toEqual({
        enabled: false,
        driver: "memory",
        busyTimeoutMs: 5_000,
      });
      expect(createStorageDriverFromConfig(defaultCfg.storage)).toBeUndefined();

      const memoryCfg = parseConfig({
        version: 1,
        name: "memory-storage",
        storage: { enabled: true, driver: "memory" },
      });
      const memDriver = createStorageDriverFromConfig(memoryCfg.storage);
      expect(memDriver).toBeInstanceOf(MemoryStorageDriver);

      const sqliteCfg = parseConfig({
        version: 1,
        name: "sqlite-storage",
        storage: {
          enabled: true,
          driver: "sqlite",
          path: ":memory:",
          busyTimeoutMs: 2_500,
        },
      });
      const sqliteDriver = createStorageDriverFromConfig(sqliteCfg.storage);
      expect(sqliteDriver).toBeInstanceOf(SqliteStorageDriver);
    });

    it("wires storageDriver into createHandleRegistryOptionsFromConfig", () => {
      const config = parseConfig({
        version: 1,
        name: "storage-handles",
        jsonNavigation: { handles: { enabled: true } },
      });
      const driver = new MemoryStorageDriver();
      const options = createHandleRegistryOptionsFromConfig(
        config.jsonNavigation,
        driver,
      );
      expect(options?.storageDriver).toBe(driver);
    });

    it("parses contract tools filter config and filters tool definitions", () => {
      const config = parseConfig({
        version: 1,
        name: "filtered-contract",
        contract: {
          source: "./pets.yaml",
          tools: {
            include: ["get_pet", "list_pets"],
            exclude: ["list_pets"],
          },
        },
      });
      expect(config.contract?.tools).toEqual({
        include: ["get_pet", "list_pets"],
        exclude: ["list_pets"],
      });

      const tools = [
        { name: "get_pet" },
        { name: "list_pets" },
        { name: "delete_pet" },
      ];
      const filtered = filterToolsByConfig(tools, config.contract?.tools);
      expect(filtered).toEqual([{ name: "get_pet" }]);
    });
  });
});

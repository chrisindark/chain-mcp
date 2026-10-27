import { describe, expect, it, vi } from "vitest";
import {
  buildExecutorOptions,
  buildRuntimeOptions,
  createAuthorizerFromConfig,
  createCacheStoreFromConfig,
  createLoggerFromConfig,
  createNavigationLimitsFromConfig,
  createRateLimiterFromConfig,
  createTokenizerFromConfig,
  createUpstreamCredentialProviderFromConfig,
  parseConfig,
  parseGatewayConfig,
  resolveLogLevel,
  safeParseConfig,
  safeParseGatewayConfig,
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
import {
  MemorySink,
  OpenTelemetryMetricsSink,
  RollingAnalyticsAggregator,
  StructuredLogger,
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
        maxResponseBytes: 1_000_000,
        maxRequestBytes: 1_048_576,
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
        maxResponseBytes: 1_000_000,
        maxRequestBytes: 1_048_576,
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
        redis: { keyPrefix: "p:", commandTimeoutMs: 1000 },
        maxTrackedWindows: 1000,
      }),
    ).toThrow(/requires a Redis client/);
  });
});

describe("auth configuration and factories", () => {
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
      });
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
        },
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
});

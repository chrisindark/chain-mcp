import { describe, expect, it, vi } from "vitest";
import {
  DistributedRateLimiter,
  type RedisRateLimitClient,
} from "@chainmcp/rate-limit";
import { RedisCacheStore, type RedisCacheClient } from "@chainmcp/cache-redis";
import type { Logger } from "@chainmcp/core";
import {
  buildExecutorOptions,
  buildReadinessDeps,
  createUpstreamCredentialProviderFromConfig,
  logRateLimiterStartup,
  parseConfig,
  type ChainMcpConfig,
  type UpstreamAuthConfig,
} from "../src/index.js";

describe("config additional coverage", () => {
  describe("createUpstreamCredentialProviderFromConfig", () => {
    it("handles oauth2 static credentials and secretStore with encrypted keys", () => {
      const config: UpstreamAuthConfig = {
        providers: [
          {
            type: "static",
            credentials: {
              authScheme1: {
                type: "oauth2",
                token: "test-token",
                tokenType: "Bearer",
                expiresAt: 123456789,
                scopes: ["read", "write"],
              },
            },
          },
          {
            type: "secretStore",
            activeKeyId: "key-1",
            keys: {
              "key-1": "0123456789abcdef0123456789abcdef",
            },
            allowGlobalFallback: true,
          },
        ],
      };

      const provider = createUpstreamCredentialProviderFromConfig(config);
      expect(provider).toBeDefined();
    });

    it("handles oauth client credentials provider and composite provider", () => {
      const config: UpstreamAuthConfig = {
        providers: [
          {
            type: "oauth",
            tokenUrl: "https://auth.example.com/token",
            clientId: "test-client",
            clientSecret: "test-secret",
            scopes: ["api"],
            schemeNames: ["oauth2"],
            expirySkewSeconds: 30,
          },
          {
            type: "env",
            prefix: "TEST_UPSTREAM_",
          },
        ],
      };

      const provider = createUpstreamCredentialProviderFromConfig(config);
      expect(provider).toBeDefined();
    });

    it("returns undefined when providers array is empty", () => {
      const provider = createUpstreamCredentialProviderFromConfig({
        providers: [],
      });
      expect(provider).toBeUndefined();
    });
  });

  describe("buildExecutorOptions error validation", () => {
    it("throws when allowedUpstreamHosts is empty", () => {
      const config = parseConfig({
        version: 1,
        name: "test-app",
        security: {
          allowedUpstreamHosts: ["example.com"],
        },
      });

      expect(() =>
        buildExecutorOptions(config, { allowedHosts: [] }),
      ).toThrowError(/security.allowedUpstreamHosts is empty/);
    });

    it("throws when baseUrl cannot be resolved", () => {
      const config = {
        name: "test-app",
        security: { allowedUpstreamHosts: ["example.com"] },
        server: {
          requestTimeoutMs: 1000,
          maxResponseBytes: 1024,
          validateResponses: false,
        },
        auth: { upstream: {} },
      } as unknown as ChainMcpConfig;

      expect(() =>
        buildExecutorOptions(config, {
          allowedHosts: ["example.com"],
          baseUrl: "",
        }),
      ).toThrowError(/no baseUrl provided/);
    });
  });

  describe("buildReadinessDeps and logRateLimiterStartup", () => {
    it("builds readiness deps for distributed rate limiter and redis cache store", async () => {
      const config = parseConfig({
        version: 1,
        name: "test-app",
        security: {
          allowedUpstreamHosts: ["api.example.com"],
        },
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

      const mockRedisClient = {
        eval: vi.fn().mockResolvedValue(1),
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn().mockResolvedValue("OK"),
        delete: vi.fn().mockResolvedValue(1),
        status: "ready",
      };

      const limiter = new DistributedRateLimiter({
        client: mockRedisClient as unknown as RedisRateLimitClient,
        keyPrefix: "test:rl:",
        failurePolicy: "fail-open",
      });

      const store = new RedisCacheStore({
        client: mockRedisClient as unknown as RedisCacheClient,
        keyPrefix: "test:cache:",
      });

      const deps = buildReadinessDeps(config, {
        rateLimiter: limiter,
        cacheStore: store,
      });

      expect(deps).toHaveLength(2);
      expect(deps[0]?.name).toBe("rate-limiter");
      expect(deps[0]?.degradedReady).toBe(true);
      expect(await deps[0]!.check()).toBe(true);

      expect(deps[1]?.name).toBe("cache");
      expect(await deps[1]!.check()).toBe(true);
    });

    it("logs rate limiter startup when redis is unreachable", async () => {
      const warnMock = vi.fn();
      const logger: Logger = {
        info: vi.fn(),
        warn: warnMock,
        error: vi.fn(),
        debug: vi.fn(),
      };

      const failingClient = {
        eval: vi.fn().mockRejectedValue(new Error("connection refused")),
      };

      const parsed = parseConfig({
        version: 1,
        name: "test-server",
        rateLimit: {
          enabled: true,
          provider: "redis",
          redis: { url: "redis://127.0.0.1:6379", keyPrefix: "rl:" },
        },
      });

      const health = await logRateLimiterStartup(parsed.rateLimit, {
        logger,
        client: failingClient as unknown as RedisRateLimitClient,
      });

      expect(health?.reachability).toBe("unreachable");
      expect(warnMock).toHaveBeenCalledWith(
        "Rate limiter initialized (Redis unreachable)",
        expect.anything(),
      );
    });

    it("returns undefined when rate limiter is not enabled", async () => {
      const parsed = parseConfig({
        version: 1,
        name: "test-server",
        rateLimit: { enabled: false },
      });
      const res = await logRateLimiterStartup(parsed.rateLimit);
      expect(res).toBeUndefined();
    });
  });
});

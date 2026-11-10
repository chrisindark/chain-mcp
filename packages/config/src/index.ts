import { z } from "zod";
import {
  InMemoryCacheStore,
  createFieldProjector,
  type Authorizer,
  type CacheStore,
  type Logger,
  type LogLevel,
  type MetricsSink,
  type RateLimiter,
  type ResultProjector,
  type RuntimeCacheOptions,
  type RuntimeOptions,
  type Tokenizer,
} from "@chainmcp/core";
import {
  RedisCacheStore,
  createSimpleRedisCacheClient,
  createSimpleRedisClient,
  redactRedisUrl,
  type RedisCacheClient,
  type SimpleRedisClient,
  type SimpleRedisClientStatus,
  type SimpleRedisOptions,
  type SimpleRedisTlsOptions,
} from "@chainmcp/cache-redis";

export {
  createSimpleRedisClient,
  createSimpleRedisCacheClient,
  redactRedisUrl,
  type RedisCacheClient,
  type RedisRateLimitClient,
  type SimpleRedisClient,
  type SimpleRedisClientStatus,
  type SimpleRedisOptions,
  type SimpleRedisTlsOptions,
};
import {
  CompositeCredentialProvider,
  EncryptedSecretStore,
  EnvCredentialProvider,
  InMemorySecretStore,
  OAuthClientCredentialsProvider,
  OperationScopeAuthorizer,
  SecretStoreCredentialProvider,
  StaticCredentialProvider,
  type OAuthTokenFetcher,
  type SecretStore,
  type StaticCredentialValue,
  type UpstreamCredentialProvider,
} from "@chainmcp/auth";
import {
  DistributedRateLimiter,
  InMemoryRateLimiter,
  type RedisRateLimitClient,
} from "@chainmcp/rate-limit";
import {
  normalizeAllowedHost,
  type UpstreamExecutorOptions,
} from "@chainmcp/executor";
import {
  createLogger,
  ConsoleSink,
  MemorySink,
  OpenTelemetryMetricsSink,
  OtlpIngestionSink,
  RollingAnalyticsAggregator,
  ToolTracer,
  type LogSink,
} from "@chainmcp/analytics";
import type {
  HandleRegistryOptions,
  NavigationLimits,
} from "@chainmcp/json-navigation";
import {
  MemoryStorageDriver,
  SqliteStorageDriver,
  type StorageDriver,
} from "@chainmcp/storage";
import {
  TokenizerConfigError,
  createApproximateTokenizer,
  createTokenizerFromConfig,
  getTokenizerFactory,
  loadTokenizerFromConfig,
  registerTokenizerFactory,
  unregisterTokenizerFactory,
  type LoadTokenizerOptions,
  type TokenizerConfigErrorCode,
  type TokenizerFactory,
  type TokenizerSelectionConfig,
} from "./tokenizer.js";

export {
  TokenizerConfigError,
  createApproximateTokenizer,
  createTokenizerFromConfig,
  getTokenizerFactory,
  loadTokenizerFromConfig,
  registerTokenizerFactory,
  unregisterTokenizerFactory,
  type LoadTokenizerOptions,
  type TokenizerConfigErrorCode,
  type TokenizerFactory,
  type TokenizerSelectionConfig,
};

export {
  redactConfigSecrets,
  resolveConfigSecrets,
  SecretResolutionError,
  type ResolvedConfigSecrets,
  type ResolveConfigSecretsOptions,
  type SecretResolutionFailure,
  type SecretResolutionSource,
} from "./secrets.js";

/**
 * Strict schema for allowed upstream hosts.
 * Rejects schemes, ports, paths, queries, credentials, and wildcards.
 * Normalizes hostnames to lowercase without trailing dots.
 */
export const AllowedHostSchema = z
  .string()
  .trim()
  .min(1)
  .refine(
    (val) => {
      try {
        normalizeAllowedHost(val);
        return true;
      } catch {
        return false;
      }
    },
    {
      message:
        "Allowed host must be a valid hostname or IP address without schemes, ports, paths, queries, credentials, or wildcards",
    },
  )
  .transform((val) => normalizeAllowedHost(val));

export const QuotaPolicyConfigSchema = z
  .object({
    maxRequests: z.number().int().positive(),
    windowMs: z.number().int().positive().default(60_000),
  })
  .strict();

export type QuotaPolicyConfig = z.infer<typeof QuotaPolicyConfigSchema>;

export const RedisTlsConfigSchema = z
  .object({
    rejectUnauthorized: z.boolean().optional(),
    ca: z.string().optional(),
    cert: z.string().optional(),
    key: z.string().optional(),
    servername: z.string().optional(),
  })
  .strict();

export type RedisTlsConfig = z.infer<typeof RedisTlsConfigSchema>;

export const RateLimitConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    provider: z.enum(["memory", "redis"]).default("memory"),
    failurePolicy: z
      .enum(["fail-closed", "fail-open"])
      .optional()
      .default("fail-closed"),
    requestsPerMinute: z.number().int().positive().optional(),
    concurrency: z.number().int().positive().optional(),
    globalQuota: QuotaPolicyConfigSchema.optional(),
    globalConcurrency: z.number().int().positive().optional(),
    tenantQuota: QuotaPolicyConfigSchema.optional(),
    tenantConcurrency: z.number().int().positive().optional(),
    toolQuota: z.record(z.string(), QuotaPolicyConfigSchema).optional(),
    toolConcurrency: z
      .record(z.string(), z.number().int().positive())
      .optional(),
    redis: z
      .object({
        url: z.string().optional(),
        keyPrefix: z.string().min(1).default("chainmcp:ratelimit:"),
        commandTimeoutMs: z
          .number()
          .int()
          .positive()
          .max(30_000)
          .default(1_000),
        tls: RedisTlsConfigSchema.optional(),
      })
      .strict()
      .prefault({}),
    maxTrackedWindows: z.number().int().positive().default(10_000),
  })
  .strict()
  .prefault({});

export type RateLimitConfig = z.infer<typeof RateLimitConfigSchema>;

export const InboundPrincipalConfigSchema = z
  .object({
    tenantId: z.string().min(1),
    principalId: z.string().min(1),
    scopes: z.array(z.string()).optional(),
  })
  .strict();

export type InboundPrincipalConfig = z.infer<
  typeof InboundPrincipalConfigSchema
>;

export const InboundJwtConfigSchema = z
  .object({
    secret: z.string().optional(),
    publicKey: z.string().optional(),
    jwksUri: z.string().url().optional(),
    jwksCacheTtlMs: z.number().int().positive().optional(),
    issuer: z.string().optional(),
    audience: z.string().optional(),
    clockToleranceSeconds: z.number().int().nonnegative().default(30),
    /**
     * Explicit claim carrying the tenant id. Multi-tenant gateways require this
     * (or an explicit `tenant` fallback) because implicit claim names are not
     * consulted there.
     */
    tenantClaim: z.string().trim().min(1).max(128).optional(),
  })
  .strict();

export type InboundJwtConfig = z.infer<typeof InboundJwtConfigSchema>;

export const InboundAuthConfigSchema = z
  .object({
    requireInboundAuth: z.boolean().default(false),
    authorizer: z.enum(["scope", "none"]).default("scope"),
    tokens: z.record(z.string(), InboundPrincipalConfigSchema).optional(),
    apiKeys: z.record(z.string(), InboundPrincipalConfigSchema).optional(),
    apiKeyHeader: z.string().optional(),
    jwt: InboundJwtConfigSchema.optional(),
  })
  .strict()
  .prefault({});

export type InboundAuthConfig = z.infer<typeof InboundAuthConfigSchema>;

export const UpstreamStaticCredentialSchema = z.union([
  z.string(),
  z
    .object({
      type: z.literal("apiKey"),
      name: z.string().min(1),
      location: z.enum(["header", "query", "cookie"]),
      value: z.string().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal("http"),
      scheme: z.literal("bearer"),
      token: z.string().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal("http"),
      scheme: z.literal("basic"),
      username: z.string(),
      password: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal("oauth2"),
      token: z.string().min(1),
      tokenType: z.string().default("Bearer"),
      expiresAt: z.number().int().positive().optional(),
      scopes: z.array(z.string()).optional(),
    })
    .strict(),
]);

export const UpstreamProviderConfigSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("static"),
      credentials: z.record(z.string(), UpstreamStaticCredentialSchema),
    })
    .strict(),
  z
    .object({
      type: z.literal("env"),
      prefix: z.string().default("CHAINMCP_AUTH_"),
    })
    .strict(),
  z
    .object({
      type: z.literal("secretStore"),
      activeKeyId: z.string().min(1).optional(),
      keys: z.record(z.string(), z.string()).optional(),
      allowGlobalFallback: z.boolean().default(false),
    })
    .strict(),
  z
    .object({
      type: z.literal("oauth"),
      tokenUrl: z.string().min(1),
      clientId: z.string().min(1),
      clientSecret: z.string().min(1),
      scopes: z.array(z.string()).optional(),
      schemeNames: z.array(z.string()).optional(),
      expirySkewSeconds: z.number().int().nonnegative().default(30),
      allowedTokenHosts: z.array(z.string()).optional(),
    })
    .strict(),
]);

export const UpstreamAuthConfigSchema = z
  .object({
    providers: z.array(UpstreamProviderConfigSchema).default([]),
  })
  .strict()
  .prefault({});

export const AuthConfigSchema = z
  .object({
    inbound: InboundAuthConfigSchema,
    upstream: UpstreamAuthConfigSchema,
  })
  .strict()
  .prefault({});

export type AuthConfig = z.infer<typeof AuthConfigSchema>;
export type UpstreamAuthConfig = z.infer<typeof UpstreamAuthConfigSchema>;
export type UpstreamProviderConfig = z.infer<
  typeof UpstreamProviderConfigSchema
>;

/**
 * Strict schema for upstream base URLs.
 * Requires absolute http:// or https:// URL.
 * Rejects credentials, query parameters, and fragments.
 * Normalizes trailing slashes to produce a canonical base URL.
 */
export const BaseUrlSchema = z
  .string()
  .min(1)
  .transform((val, ctx) => {
    let parsed: URL;
    try {
      parsed = new URL(val);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Invalid base URL: '${val}' is not a valid absolute URL`,
      });
      return z.NEVER;
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Invalid base URL scheme: '${parsed.protocol}'. Only http: and https: are supported.`,
      });
      return z.NEVER;
    }

    if (parsed.username !== "" || parsed.password !== "") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Base URL must not contain credentials (username or password)",
      });
      return z.NEVER;
    }

    if (parsed.search !== "" || parsed.hash !== "") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Base URL must not contain query parameters or fragments",
      });
      return z.NEVER;
    }

    const pathname = parsed.pathname.replace(/\/+$/, "");
    return `${parsed.origin}${pathname}`;
  });

export type BaseUrl = z.infer<typeof BaseUrlSchema>;

export const ContractConfigSchema = z
  .object({
    source: z.string().min(1),
    strict: z.boolean().default(true),
    baseUrl: BaseUrlSchema.optional(),
  })
  .strict();

export type ContractConfig = z.infer<typeof ContractConfigSchema>;

export const LogLevelSchema = z.enum([
  "debug",
  "info",
  "warn",
  "error",
  "silent",
]);

export const LoggingConfigSchema = z
  .object({
    level: LogLevelSchema.default("info"),
    destination: z.enum(["stdout", "stderr", "memory"]).default("stdout"),
    redactKeys: z.array(z.string().min(1)).default([]),
    includeRequestBodies: z.boolean().default(false),
    includeResponseBodies: z.boolean().default(false),
  })
  .strict()
  .prefault({});

export type LoggingConfig = z.infer<typeof LoggingConfigSchema>;

export const JsonNavigationConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    maxDepth: z.number().int().min(1).max(64).default(16),
    maxArrayItems: z.number().int().min(1).max(10_000).default(1_000),
    maxResultBytes: z.number().int().min(1).max(10_000_000).default(50_000),
    maxVisitedNodes: z.number().int().min(1).max(1_000_000).default(50_000),
    timeoutMs: z.number().int().min(1).max(60_000).default(5_000),
    /**
     * Result-handle registry. When `handles.enabled` is true the
     * caller can `json_create_handle` a large document once and navigate
     * it by handle from then on, without pasting the payload back inline.
     */
    handles: z
      .object({
        enabled: z.boolean().default(true),
        /** Per-principal LRU capacity. Defaults to 50. */
        maxPerPrincipal: z.number().int().min(1).max(1_000).default(50),
        /** Per-tenant capacity. Defaults to 250. */
        maxPerTenant: z.number().int().min(1).max(10_000).default(250),
        /** Absolute handle capacity. Defaults to 1,000. */
        maxTotal: z.number().int().min(1).max(100_000).default(1_000),
        /** Byte cap per stored document. Defaults to 1,000,000. */
        maxBytes: z.number().int().min(1).max(100_000_000).default(1_000_000),
        /** Total byte cap across all stored documents. Defaults to 8,000,000. */
        maxTotalBytes: z
          .number()
          .int()
          .min(1)
          .max(1_000_000_000)
          .default(8_000_000),
        /** Handle TTL in ms. Defaults to 600,000 (10 minutes). */
        ttlMs: z.number().int().min(1).max(86_400_000).default(600_000),
        /** Minimum document bytes before a handle is returned by the auto path. Defaults to 0. */
        minBytes: z.number().int().min(0).max(100_000_000).default(0),
      })
      .strict()
      .prefault({}),
  })
  .strict()
  .prefault({});

export type JsonNavigationConfig = z.infer<typeof JsonNavigationConfigSchema>;

export const AnalyticsConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    includeArguments: z.boolean().default(false),
    includeResponseBodies: z.boolean().default(false),
    retentionDays: z.number().int().positive().default(14),
    openTelemetry: z
      .object({
        enabled: z.boolean().default(false),
        serviceName: z.string().min(1).default("chainmcp"),
        tracing: z
          .object({
            enabled: z.boolean().default(false),
            sampleRatio: z.number().min(0).max(1).default(0.1),
          })
          .strict()
          .prefault({}),
        ingestion: z
          .object({
            enabled: z.boolean().default(false),
            maxRequestBytes: z
              .number()
              .int()
              .positive()
              .max(100 * 1024 * 1024)
              .default(5 * 1024 * 1024),
          })
          .strict()
          .prefault({}),
      })
      .strict()
      .prefault({}),
  })
  .strict()
  .prefault({});

export type AnalyticsConfig = z.infer<typeof AnalyticsConfigSchema>;

export const CacheConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    provider: z.enum(["memory", "redis"]).default("memory"),
    ttlSeconds: z.number().int().positive().default(300),
    maxEntries: z.number().int().positive().default(10_000),
    redis: z
      .object({
        url: z.string().optional(),
        keyPrefix: z.string().default("chainmcp:cache:"),
        commandTimeoutMs: z.number().int().positive().default(1_000),
        tls: RedisTlsConfigSchema.optional(),
      })
      .strict()
      .prefault({}),
  })
  .strict()
  .prefault({});

export type CacheConfig = z.infer<typeof CacheConfigSchema>;

export const StorageConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    driver: z.enum(["memory", "sqlite"]).default("memory"),
    path: z.string().optional(),
    busyTimeoutMs: z.number().int().positive().default(5_000),
  })
  .strict()
  .prefault({});

export type StorageConfig = z.infer<typeof StorageConfigSchema>;

export function createStorageDriverFromConfig(
  config: StorageConfig,
): StorageDriver | undefined {
  if (!config.enabled) return undefined;
  if (config.driver === "sqlite") {
    return new SqliteStorageDriver({
      ...(config.path ? { path: config.path } : {}),
      busyTimeoutMs: config.busyTimeoutMs,
    });
  }
  return new MemoryStorageDriver();
}

export const TokenMetricsConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    tokenizer: z.enum(["approximate", "exact", "none"]).default("approximate"),
    modelId: z.string().default("cl100k_base"),
    charactersPerToken: z.number().positive().default(4),
    /**
     * Module that exports `createTokenizer(config)` for exact measurement.
     * Relative paths are resolved from the directory containing the
     * configuration file. Programmatic deployments may register a factory
     * instead of using a module.
     */
    module: z.string().min(1).optional(),
  })
  .strict()
  .prefault({})
  .superRefine((config, ctx) => {
    if (config.module !== undefined && config.tokenizer !== "exact") {
      ctx.addIssue({
        code: "custom",
        path: ["module"],
        message: "tokenMetrics.module requires tokenMetrics.tokenizer: exact",
      });
    }
  });

export type TokenMetricsConfig = z.infer<typeof TokenMetricsConfigSchema>;

export const ProjectionConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
  })
  .strict()
  .prefault({});

export type ProjectionConfig = z.infer<typeof ProjectionConfigSchema>;

export const CorsConfigObjectSchema = z
  .object({
    enabled: z.boolean().optional(),
    allowedOrigins: z.array(z.string().min(1)).default([]),
    allowedHeaders: z.array(z.string().min(1)).default([]),
    allowCredentials: z.boolean().default(false),
    maxAgeSeconds: z.number().int().nonnegative().default(600),
  })
  .strict()
  .prefault({})
  .refine(
    (data) => !(data.allowedOrigins.includes("*") && data.allowCredentials),
    {
      message:
        "Wildcard origin ('*') cannot be used when allowCredentials is true",
      path: ["allowedOrigins"],
    },
  );

export const CorsConfigSchema = z.preprocess(
  (val) => (typeof val === "boolean" ? { enabled: val } : (val ?? {})),
  CorsConfigObjectSchema,
);

export type CorsConfig = z.infer<typeof CorsConfigObjectSchema>;

export const ServerConfigSchema = z
  .object({
    transport: z.enum(["stdio", "http"]).default("stdio"),
    host: z.string().default("127.0.0.1"),
    port: z.number().int().min(1).max(65535).default(3333),
    path: z.string().default("/mcp"),
    requestTimeoutMs: z.number().int().positive().max(300_000).default(15_000),
    shutdownTimeoutMs: z
      .number()
      .int()
      .nonnegative()
      .max(300_000)
      .default(10_000),
    /**
     * Page size for `tools/list`. `0` disables pagination.
     */
    toolsPageSize: z.number().int().nonnegative().max(10_000).default(100),
    maxResponseBytes: z
      .number()
      .int()
      .positive()
      .max(100_000_000)
      .default(1_000_000),
    maxRequestBytes: z
      .number()
      .int()
      .positive()
      .max(100_000_000)
      .default(1_048_576),
    maxMultipartPartBytes: z
      .number()
      .int()
      .positive()
      .max(100_000_000)
      .default(1_048_576),
    maxToolInputBytes: z
      .number()
      .int()
      .positive()
      .max(100_000_000)
      .default(1_048_576),
    validateResponses: z.enum(["off", "warn", "enforce"]).default("warn"),
    allowedHosts: z.array(z.string().min(1)).default([]),
    allowedOrigins: z.array(z.string().min(1)).default([]),
    enableDnsRebindingProtection: z.boolean().default(false),
    cors: CorsConfigSchema,
  })
  .strict()
  .prefault({});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

export const SecurityConfigSchema = z
  .object({
    requireInboundAuth: z.boolean().default(false),
    allowUnauthenticatedHttp: z.boolean().default(false),
    allowInsecureHttp: z.boolean().default(false),
    allowedUpstreamHosts: z.array(AllowedHostSchema).default([]),
    redactHeaders: z
      .array(z.string().min(1))
      .default(["authorization", "cookie", "x-api-key"]),
  })
  .strict()
  .prefault({});

export type SecurityConfig = z.infer<typeof SecurityConfigSchema>;

export const ChainMcpConfigSchema = z
  .object({
    version: z.literal(1),
    name: z.string().min(1).max(128),
    tenant: z.string().min(1).optional(),
    contract: ContractConfigSchema.optional(),
    server: ServerConfigSchema,
    security: SecurityConfigSchema,
    rateLimit: RateLimitConfigSchema,
    cache: CacheConfigSchema,
    storage: StorageConfigSchema,
    tokenMetrics: TokenMetricsConfigSchema,
    projection: ProjectionConfigSchema,
    auth: AuthConfigSchema,
    logging: LoggingConfigSchema,
    jsonNavigation: JsonNavigationConfigSchema,
    analytics: AnalyticsConfigSchema,
  })
  .strict()
  .transform((cfg) => {
    if (cfg.contract?.baseUrl) {
      const parsed = new URL(cfg.contract.baseUrl);
      const host = normalizeAllowedHost(parsed.hostname);
      if (!cfg.security.allowedUpstreamHosts.includes(host)) {
        return {
          ...cfg,
          security: {
            ...cfg.security,
            allowedUpstreamHosts: [host, ...cfg.security.allowedUpstreamHosts],
          },
        };
      }
    }
    return cfg;
  });

export type ChainMcpConfig = z.infer<typeof ChainMcpConfigSchema>;

export function parseConfig(input: unknown): ChainMcpConfig {
  return ChainMcpConfigSchema.parse(input);
}

export function safeParseConfig(
  input: unknown,
): ReturnType<typeof ChainMcpConfigSchema.safeParse> {
  return ChainMcpConfigSchema.safeParse(input);
}

export const GatewayContractDestinationSchema = z
  .object({
    baseUrl: BaseUrlSchema,
    allowedHosts: z.array(AllowedHostSchema).default([]),
    allowInsecureHttp: z.boolean().default(false),
  })
  .strict()
  .transform((dest) => {
    const parsed = new URL(dest.baseUrl);
    const host = normalizeAllowedHost(parsed.hostname);
    if (!dest.allowedHosts.includes(host)) {
      return {
        ...dest,
        allowedHosts: [host, ...dest.allowedHosts],
      };
    }
    return dest;
  });

export type GatewayContractDestination = z.infer<
  typeof GatewayContractDestinationSchema
>;

export const GatewayContractAuthConfigSchema = z
  .object({
    requiredScopes: z.array(z.string().min(1)).optional(),
  })
  .strict();

export type GatewayContractAuthConfig = z.infer<
  typeof GatewayContractAuthConfigSchema
>;

export const GatewayContractLimitsSchema = z
  .object({
    timeoutMs: z.number().int().positive().optional(),
    maxResponseBytes: z.number().int().positive().optional(),
    maxRequestBytes: z.number().int().positive().optional(),
    maxRedirects: z.number().int().nonnegative().optional(),
  })
  .strict();

export type GatewayContractLimits = z.infer<typeof GatewayContractLimitsSchema>;

export const GatewayContractConfigSchema = z
  .object({
    name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
    tenantId: z.string().min(1),
    spec: z.string().min(1),
    destination: GatewayContractDestinationSchema,
    auth: GatewayContractAuthConfigSchema.optional(),
    limits: GatewayContractLimitsSchema.optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    autoActivate: z.boolean().default(true),
  })
  .strict();

export type GatewayContractConfig = z.infer<typeof GatewayContractConfigSchema>;

export const GatewayConfigSchema = z
  .object({
    version: z.literal(1),
    name: z.string().min(1).max(128).default("chainmcp-gateway"),
    tenant: z.string().min(1).optional(),
    server: ServerConfigSchema,
    security: SecurityConfigSchema,
    rateLimit: RateLimitConfigSchema,
    cache: CacheConfigSchema,
    storage: StorageConfigSchema,
    tokenMetrics: TokenMetricsConfigSchema,
    projection: ProjectionConfigSchema,
    auth: AuthConfigSchema,
    logging: LoggingConfigSchema,
    jsonNavigation: JsonNavigationConfigSchema,
    analytics: AnalyticsConfigSchema,
    // Declared on the gateway schema so the gateway deployment can also serve
    // dependency readiness; the CLI wires `buildReadinessDeps` into `serveHttp`.
    contracts: z.array(GatewayContractConfigSchema).default([]),
  })
  .strict();

export type GatewayConfig = z.infer<typeof GatewayConfigSchema>;

export function parseGatewayConfig(input: unknown): GatewayConfig {
  return GatewayConfigSchema.parse(input);
}

export function safeParseGatewayConfig(
  input: unknown,
): ReturnType<typeof GatewayConfigSchema.safeParse> {
  return GatewayConfigSchema.safeParse(input);
}

export interface RateLimiterFactoryOptions {
  redisClient?: RedisRateLimitClient | undefined;
  redisUrl?: string | undefined;
  now?: (() => number) | undefined;
  logger?: Logger | undefined;
}

export function createRateLimiterFromConfig(
  config: RateLimitConfig,
  options?: RateLimiterFactoryOptions,
): RateLimiter | undefined {
  if (!config.enabled) {
    return undefined;
  }

  const globalQuota =
    config.globalQuota ??
    (config.requestsPerMinute !== undefined
      ? { maxRequests: config.requestsPerMinute, windowMs: 60_000 }
      : undefined);

  const globalConcurrency = config.globalConcurrency ?? config.concurrency;

  const toolQuota =
    config.toolQuota !== undefined
      ? (toolName: string) => config.toolQuota?.[toolName]
      : undefined;

  const toolConcurrency =
    config.toolConcurrency !== undefined
      ? (toolName: string) => config.toolConcurrency?.[toolName]
      : undefined;

  if (config.provider === "redis") {
    let client = options?.redisClient;
    if (!client) {
      const url =
        options?.redisUrl ??
        (config.redis.url?.trim() || undefined) ??
        process.env.CHAINMCP_REDIS_URL;
      if (!url) {
        throw new TypeError(
          "Redis rate limiter requires a Redis client (options.redisClient), 'rateLimit.redis.url', or environment variable 'CHAINMCP_REDIS_URL'",
        );
      }
      client = createSimpleRedisClient({
        url,
        ...(config.redis.tls ? { tls: config.redis.tls } : {}),
        timeoutMs: config.redis.commandTimeoutMs,
      });
    }
    return new DistributedRateLimiter({
      client,
      keyPrefix: config.redis.keyPrefix,
      commandTimeoutMs: config.redis.commandTimeoutMs,
      failurePolicy: config.failurePolicy ?? "fail-closed",
      ...(options?.logger !== undefined ? { logger: options.logger } : {}),
      ...(globalQuota !== undefined ? { globalQuota } : {}),
      ...(globalConcurrency !== undefined ? { globalConcurrency } : {}),
      ...(config.tenantQuota !== undefined
        ? { tenantQuota: config.tenantQuota }
        : {}),
      ...(config.tenantConcurrency !== undefined
        ? { tenantConcurrency: config.tenantConcurrency }
        : {}),
      ...(toolQuota !== undefined ? { toolQuota } : {}),
      ...(toolConcurrency !== undefined ? { toolConcurrency } : {}),
      ...(options?.now !== undefined ? { now: options.now } : {}),
    });
  }

  return new InMemoryRateLimiter({
    ...(globalQuota !== undefined ? { globalQuota } : {}),
    ...(globalConcurrency !== undefined ? { globalConcurrency } : {}),
    ...(config.tenantQuota !== undefined
      ? { tenantQuota: config.tenantQuota }
      : {}),
    ...(config.tenantConcurrency !== undefined
      ? { tenantConcurrency: config.tenantConcurrency }
      : {}),
    ...(toolQuota !== undefined ? { toolQuota } : {}),
    ...(toolConcurrency !== undefined ? { toolConcurrency } : {}),
    maxTrackedWindows: config.maxTrackedWindows,
    ...(options?.now !== undefined ? { now: options.now } : {}),
  });
}

export interface CacheStoreFactoryOptions {
  redisClient?: RedisCacheClient | undefined;
  redisUrl?: string | undefined;
}

export function createCacheStoreFromConfig(
  config: CacheConfig,
  options?: CacheStoreFactoryOptions,
): CacheStore | undefined {
  if (!config.enabled) {
    return undefined;
  }
  if (config.provider === "memory") {
    const memoryOptions: { maxEntries?: number; maxTtlSeconds?: number } = {
      maxEntries: config.maxEntries,
    };
    if (config.ttlSeconds !== undefined) {
      memoryOptions.maxTtlSeconds = Math.max(config.ttlSeconds, 3_600);
    }
    return new InMemoryCacheStore(memoryOptions);
  }
  if (config.provider === "redis") {
    let client = options?.redisClient;
    if (!client) {
      const url =
        options?.redisUrl ?? config.redis.url ?? process.env.CHAINMCP_REDIS_URL;
      if (!url) {
        throw new TypeError(
          "Redis cache store requires a Redis client (options.redisClient) or CHAINMCP_REDIS_URL",
        );
      }
      client = createSimpleRedisCacheClient({
        url,
        ...(config.redis.tls ? { tls: config.redis.tls } : {}),
        timeoutMs: config.redis.commandTimeoutMs,
      });
    }
    return new RedisCacheStore({
      client,
      keyPrefix: config.redis.keyPrefix,
      commandTimeoutMs: config.redis.commandTimeoutMs,
    });
  }
  return undefined;
}

function normalizeStaticCredential(
  raw: z.infer<typeof UpstreamStaticCredentialSchema>,
): StaticCredentialValue {
  if (typeof raw === "string") return raw;
  if (raw.type === "apiKey" || raw.type === "http") return raw;
  if (raw.type === "oauth2") {
    return {
      type: "oauth2",
      token: raw.token,
      ...(raw.tokenType !== undefined ? { tokenType: raw.tokenType } : {}),
      ...(raw.expiresAt !== undefined ? { expiresAt: raw.expiresAt } : {}),
      ...(raw.scopes !== undefined ? { scopes: raw.scopes } : {}),
    };
  }
  return raw;
}

export function createAuthorizerFromConfig(
  config: InboundAuthConfig,
): Authorizer | undefined {
  if (config.authorizer === "scope") {
    return new OperationScopeAuthorizer();
  }
  return undefined;
}

export interface CredentialProviderFactoryOptions {
  secretStore?: SecretStore;
  tokenStore?: SecretStore;
  fetchToken?: OAuthTokenFetcher;
  now?: () => number;
}

export function createUpstreamCredentialProviderFromConfig(
  config: UpstreamAuthConfig,
  options?: CredentialProviderFactoryOptions,
): UpstreamCredentialProvider | undefined {
  if (!config.providers || config.providers.length === 0) {
    return undefined;
  }

  const providers: UpstreamCredentialProvider[] = [];

  for (const providerConfig of config.providers) {
    switch (providerConfig.type) {
      case "static": {
        const credentials: Record<string, StaticCredentialValue> = {};
        for (const [key, val] of Object.entries(providerConfig.credentials)) {
          credentials[key] = normalizeStaticCredential(val);
        }
        providers.push(
          new StaticCredentialProvider({
            credentials,
          }),
        );
        break;
      }
      case "env": {
        providers.push(
          new EnvCredentialProvider({
            prefix: providerConfig.prefix,
          }),
        );
        break;
      }
      case "secretStore": {
        let store = options?.secretStore;
        if (!store) {
          if (providerConfig.activeKeyId && providerConfig.keys) {
            store = new EncryptedSecretStore({
              store: new InMemorySecretStore(),
              activeKeyId: providerConfig.activeKeyId,
              keys: providerConfig.keys,
            });
          } else {
            store = new InMemorySecretStore();
          }
        }
        providers.push(
          new SecretStoreCredentialProvider({
            store,
            allowGlobalFallback: providerConfig.allowGlobalFallback,
          }),
        );
        break;
      }
      case "oauth": {
        providers.push(
          new OAuthClientCredentialsProvider({
            tokenUrl: providerConfig.tokenUrl,
            clientId: providerConfig.clientId,
            clientSecret: providerConfig.clientSecret,
            ...(providerConfig.scopes !== undefined
              ? { scopes: providerConfig.scopes }
              : {}),
            ...(providerConfig.schemeNames !== undefined
              ? { schemeNames: providerConfig.schemeNames }
              : {}),
            expirySkewSeconds: providerConfig.expirySkewSeconds,
            ...(options?.fetchToken !== undefined
              ? { fetchToken: options.fetchToken }
              : {}),
            ...(options?.tokenStore !== undefined
              ? { tokenStore: options.tokenStore }
              : {}),
            ...(options?.now !== undefined ? { now: options.now } : {}),
          }),
        );
        break;
      }
    }
  }

  if (providers.length === 0) {
    return undefined;
  }
  if (providers.length === 1) {
    return providers[0];
  }
  return new CompositeCredentialProvider(providers);
}

export interface BuildExecutorOptionsOverrides extends Partial<UpstreamExecutorOptions> {
  baseUrl?: string;
}

export function buildExecutorOptions(
  config: ChainMcpConfig,
  overrides?: BuildExecutorOptionsOverrides,
  factoryOptions?: CredentialProviderFactoryOptions,
): UpstreamExecutorOptions {
  const allowedHosts =
    overrides?.allowedHosts ?? config.security.allowedUpstreamHosts;

  if (allowedHosts.length === 0) {
    throw new TypeError(
      "Cannot build executor options: security.allowedUpstreamHosts is empty. At least one allowed host must be configured.",
    );
  }

  const baseUrl =
    overrides?.baseUrl ??
    config.contract?.baseUrl ??
    (allowedHosts[0] ? `https://${allowedHosts[0]}` : undefined);

  if (!baseUrl) {
    throw new TypeError(
      "Cannot build executor options: no baseUrl provided and neither contract.baseUrl nor security.allowedUpstreamHosts is configured.",
    );
  }

  const credentialProvider =
    overrides?.credentialProvider ??
    createUpstreamCredentialProviderFromConfig(
      config.auth.upstream,
      factoryOptions,
    );

  const allowInsecureHttp =
    overrides?.allowInsecureHttp ?? config.security.allowInsecureHttp;

  return {
    baseUrl,
    allowedHosts,
    timeoutMs: overrides?.timeoutMs ?? config.server.requestTimeoutMs,
    maxResponseBytes:
      overrides?.maxResponseBytes ?? config.server.maxResponseBytes,
    validateResponses:
      overrides?.validateResponses ?? config.server.validateResponses,
    ...(overrides?.logger !== undefined ? { logger: overrides.logger } : {}),
    ...(credentialProvider !== undefined ? { credentialProvider } : {}),
    ...(allowInsecureHttp !== undefined ? { allowInsecureHttp } : {}),
    ...(overrides?.resolveHost !== undefined
      ? { resolveHost: overrides.resolveHost }
      : {}),
    ...(overrides?.transport !== undefined
      ? { transport: overrides.transport }
      : {}),
    ...(overrides?.maxRequestBytes !== undefined
      ? { maxRequestBytes: overrides.maxRequestBytes }
      : config.server.maxRequestBytes !== undefined
        ? { maxRequestBytes: config.server.maxRequestBytes }
        : {}),
    ...(overrides?.maxMultipartPartBytes !== undefined
      ? { maxMultipartPartBytes: overrides.maxMultipartPartBytes }
      : config.server.maxMultipartPartBytes !== undefined
        ? { maxMultipartPartBytes: config.server.maxMultipartPartBytes }
        : {}),
    ...(overrides?.maxRedirects !== undefined
      ? { maxRedirects: overrides.maxRedirects }
      : {}),
    ...(overrides?.contractRevision !== undefined
      ? { contractRevision: overrides.contractRevision }
      : {}),
    ...(overrides?.defaultReadCacheTtlSeconds !== undefined
      ? { defaultReadCacheTtlSeconds: overrides.defaultReadCacheTtlSeconds }
      : config.cache.enabled && config.cache.ttlSeconds > 0
        ? { defaultReadCacheTtlSeconds: config.cache.ttlSeconds }
        : {}),
    ...(overrides?.ownerTenantId !== undefined
      ? { ownerTenantId: overrides.ownerTenantId }
      : {}),
  };
}

export function resolveLogLevel(
  envValue?: string,
  configuredLevel: LogLevel = "info",
): LogLevel {
  if (envValue) {
    const normalized = envValue.trim().toLowerCase();
    if (
      normalized === "debug" ||
      normalized === "info" ||
      normalized === "warn" ||
      normalized === "error" ||
      normalized === "silent"
    ) {
      return normalized;
    }
  }
  return configuredLevel;
}

export interface LoggerFromConfigOptions {
  env?: Record<string, string | undefined> | undefined;
  sink?: LogSink | undefined;
  auditSink?: LogSink | undefined;
}

export function createLoggerFromConfig(
  config: LoggingConfig,
  options?: LoggerFromConfigOptions,
): Logger {
  const envLevel =
    options?.env?.["CHAINMCP_LOG_LEVEL"] ?? process.env["CHAINMCP_LOG_LEVEL"];
  const level = resolveLogLevel(envLevel, config.level);

  let diagnosticSink: LogSink;
  if (options?.sink) {
    diagnosticSink = options.sink;
  } else if (config.destination === "stderr") {
    diagnosticSink = new ConsoleSink({
      stdout: (msg) => process.stderr.write(msg + "\n"),
      stderr: (msg) => process.stderr.write(msg + "\n"),
    });
  } else if (config.destination === "memory") {
    diagnosticSink = new MemorySink();
  } else {
    diagnosticSink = new ConsoleSink();
  }

  return createLogger({
    level,
    diagnosticSink,
    auditSink: options?.auditSink,
    redaction: {
      additionalSensitiveKeys: config.redactKeys,
      includeBodies:
        config.includeRequestBodies || config.includeResponseBodies,
    },
  });
}

export function createNavigationLimitsFromConfig(
  config: JsonNavigationConfig,
): NavigationLimits {
  return {
    maxDepth: config.maxDepth,
    maxArrayItems: config.maxArrayItems,
    maxResultBytes: config.maxResultBytes,
    maxVisitedNodes: config.maxVisitedNodes,
    timeoutMs: config.timeoutMs,
  };
}

/**
 * Build the result-handle registry options for a deployment from its JSON
 * navigation config, or `undefined` when handles are disabled.
 */
export function createHandleRegistryOptionsFromConfig(
  config: JsonNavigationConfig,
  storageDriver?: StorageDriver,
): HandleRegistryOptions | undefined {
  if (!config.handles.enabled) return undefined;
  return {
    ...(storageDriver !== undefined ? { storageDriver } : {}),
    maxPerPrincipal: config.handles.maxPerPrincipal,
    maxPerTenant: config.handles.maxPerTenant,
    maxTotal: config.handles.maxTotal,
    maxBytes: config.handles.maxBytes,
    maxTotalBytes: config.handles.maxTotalBytes,
    ttlMs: config.handles.ttlMs,
    minBytes: config.handles.minBytes,
  };
}

/**
 * Build an OTLP ingestion sink from analytics configuration, or `undefined`
 * if OTLP ingestion is disabled.
 */
export function createOtlpIngestionSinkFromConfig(
  config: AnalyticsConfig,
  dependencies?: {
    metricsSink?: MetricsSink | undefined;
    storageDriver?: StorageDriver | undefined;
    logger?: Logger | undefined;
  },
): OtlpIngestionSink | undefined {
  if (
    !config.enabled ||
    !config.openTelemetry.enabled ||
    !config.openTelemetry.ingestion.enabled
  ) {
    return undefined;
  }

  const ringBuffer = dependencies?.storageDriver
    ? dependencies.storageDriver.getTelemetryRingBuffer()
    : undefined;

  return new OtlpIngestionSink({
    ...(dependencies?.metricsSink !== undefined
      ? { metricsSink: dependencies.metricsSink }
      : {}),
    ...(ringBuffer !== undefined ? { telemetryRingBuffer: ringBuffer } : {}),
    ...(dependencies?.logger !== undefined
      ? { logger: dependencies.logger }
      : {}),
    maxRequestBytes: config.openTelemetry.ingestion.maxRequestBytes,
  });
}

export function buildRuntimeOptions(
  config: ChainMcpConfig,
  overrides?: Partial<RuntimeOptions>,
  factoryOptions?: {
    rateLimiterOptions?: RateLimiterFactoryOptions;
    cacheStoreOptions?: CacheStoreFactoryOptions;
    env?: Record<string, string | undefined>;
    diagnosticSink?: LogSink;
    auditSink?: LogSink;
  },
): RuntimeOptions {
  const requireInboundAuth =
    config.security.requireInboundAuth ||
    config.auth.inbound.requireInboundAuth;

  const authorizer =
    overrides?.authorizer ??
    (requireInboundAuth
      ? createAuthorizerFromConfig(config.auth.inbound)
      : undefined);

  const logger =
    overrides?.logger ??
    (config.logging.level !== "silent"
      ? createLoggerFromConfig(config.logging, {
          env: factoryOptions?.env,
          sink: factoryOptions?.diagnosticSink,
          auditSink: factoryOptions?.auditSink,
        })
      : undefined);

  const rateLimitUsesRedis =
    config.rateLimit.enabled && config.rateLimit.provider === "redis";
  const cacheUsesRedis =
    config.cache.enabled && config.cache.provider === "redis";

  const passedLimiterClient = factoryOptions?.rateLimiterOptions?.redisClient;
  const passedCacheClient = factoryOptions?.cacheStoreOptions?.redisClient;

  let sharedClient: SimpleRedisClient | undefined;
  if (
    !passedLimiterClient &&
    !passedCacheClient &&
    (rateLimitUsesRedis || cacheUsesRedis)
  ) {
    const redisUrl =
      factoryOptions?.rateLimiterOptions?.redisUrl ??
      (config.rateLimit.redis.url?.trim() || undefined) ??
      factoryOptions?.cacheStoreOptions?.redisUrl ??
      (config.cache.redis.url?.trim() || undefined) ??
      factoryOptions?.env?.CHAINMCP_REDIS_URL ??
      process.env.CHAINMCP_REDIS_URL;

    if (redisUrl) {
      const tls = config.rateLimit.redis.tls ?? config.cache.redis.tls;
      const timeoutMs = Math.max(
        config.rateLimit.redis.commandTimeoutMs,
        config.cache.redis.commandTimeoutMs,
      );
      sharedClient = createSimpleRedisClient({
        url: redisUrl,
        ...(tls ? { tls } : {}),
        timeoutMs,
      });
    }
  } else if (
    passedLimiterClient &&
    !passedCacheClient &&
    cacheUsesRedis &&
    "get" in passedLimiterClient &&
    "set" in passedLimiterClient &&
    "delete" in passedLimiterClient
  ) {
    sharedClient = passedLimiterClient as SimpleRedisClient;
  } else if (
    passedCacheClient &&
    !passedLimiterClient &&
    rateLimitUsesRedis &&
    "eval" in passedCacheClient
  ) {
    sharedClient = passedCacheClient as SimpleRedisClient;
  }

  const rateLimiterOptions: RateLimiterFactoryOptions = {
    ...factoryOptions?.rateLimiterOptions,
    ...((passedLimiterClient ?? sharedClient)
      ? { redisClient: passedLimiterClient ?? sharedClient }
      : {}),
    ...(logger ? { logger } : {}),
  };

  const cacheStoreOptions: CacheStoreFactoryOptions = {
    ...factoryOptions?.cacheStoreOptions,
    ...((passedCacheClient ?? sharedClient)
      ? { redisClient: passedCacheClient ?? sharedClient }
      : {}),
  };

  const rateLimiter =
    overrides?.rateLimiter ??
    createRateLimiterFromConfig(config.rateLimit, rateLimiterOptions);

  let metrics: MetricsSink | undefined = overrides?.metrics;
  if (metrics === undefined && config.analytics.enabled) {
    if (config.analytics.openTelemetry.enabled) {
      metrics = new OpenTelemetryMetricsSink({
        meterName: config.analytics.openTelemetry.serviceName,
      });
    } else {
      metrics = new RollingAnalyticsAggregator({
        retentionMs: config.analytics.retentionDays * 86_400_000,
      });
    }
  }

  let tracer = overrides?.tracer;
  if (
    tracer === undefined &&
    config.analytics.enabled &&
    config.analytics.openTelemetry.enabled &&
    config.analytics.openTelemetry.tracing.enabled
  ) {
    tracer = new ToolTracer({
      tracerName: config.analytics.openTelemetry.serviceName,
      sampleRatio: config.analytics.openTelemetry.tracing.sampleRatio,
    });
  }

  let cache: RuntimeCacheOptions | undefined = overrides?.cache;
  if (cache === undefined && config.cache.enabled) {
    const store = createCacheStoreFromConfig(config.cache, cacheStoreOptions);
    if (store) {
      cache = {
        store,
        authorizationPartition(context) {
          return context.principal.scopes.length > 0
            ? [...context.principal.scopes].sort().join(",")
            : "public";
        },
      };
    }
  }

  let onShutdown = overrides?.onShutdown;
  if (
    sharedClient !== undefined &&
    sharedClient !== passedLimiterClient &&
    sharedClient !== passedCacheClient
  ) {
    const client = sharedClient;
    const overrideShutdown = onShutdown;
    onShutdown = async () => {
      try {
        await overrideShutdown?.();
      } finally {
        // The factory created this client for the runtime, so the runtime owns
        // its one and only drain. Caller-supplied clients are left untouched.
        await client.close();
      }
    };
  }

  const tokenizer: Tokenizer | undefined =
    overrides?.tokenizer ??
    (config.tokenMetrics.enabled
      ? createTokenizerFromConfig(config.tokenMetrics)
      : undefined);

  const projector: ResultProjector | undefined =
    overrides?.projector ??
    (config.projection.enabled ? createFieldProjector() : undefined);

  return {
    ...(authorizer !== undefined ? { authorizer } : {}),
    ...(rateLimiter !== undefined ? { rateLimiter } : {}),
    ...(logger !== undefined ? { logger } : {}),
    ...(metrics !== undefined ? { metrics } : {}),
    ...(tracer !== undefined ? { tracer } : {}),
    defaultTimeoutMs:
      overrides?.defaultTimeoutMs ?? config.server.requestTimeoutMs,
    ...(overrides?.tenantMode !== undefined
      ? { tenantMode: overrides.tenantMode }
      : {}),
    ...(overrides?.tenantId !== undefined
      ? { tenantId: overrides.tenantId }
      : config.tenant !== undefined
        ? { tenantId: config.tenant }
        : {}),
    ...(overrides?.now !== undefined ? { now: overrides.now } : {}),
    ...(overrides?.monotonicNow !== undefined
      ? { monotonicNow: overrides.monotonicNow }
      : {}),
    ...(cache !== undefined ? { cache } : {}),
    ...(tokenizer !== undefined ? { tokenizer } : {}),
    ...(projector !== undefined ? { projector } : {}),
    ...(onShutdown !== undefined ? { onShutdown } : {}),
    maxToolInputBytes:
      overrides?.maxToolInputBytes ?? config.server.maxToolInputBytes,
    maxResponseBytes:
      overrides?.maxResponseBytes ?? config.server.maxResponseBytes,
  };
}

export interface RateLimiterStartupHealth {
  provider: "memory" | "redis";
  reachability: "reachable" | "unreachable" | "local";
  keyPrefix: string;
  quotaSummary: {
    globalQuota?: QuotaPolicyConfig | undefined;
    globalConcurrency?: number | undefined;
    tenantQuotaConfigured: boolean;
    tenantConcurrencyConfigured: boolean;
    toolQuotaCount: number;
    toolConcurrencyCount: number;
  };
}

/**
 * Dependency checks for `serveHttp`'s `/readyz` probe.
 *
 * Each check resolves `true` when the dependency is healthy. The checks
 * never write: the rate limiter probes `eval("return 1")` and the cache
 * store probes a read of an absent key (a read fails only when Redis is
 * unreachable, so it proves liveness without writing). Both are bounded by
 * a short timeout so a hung Redis cannot stall the probe. `fail-open`
 * limiters are reported `degradedReady`, mirroring the call path: an
 * unreachable Redis keeps `/readyz` at 200 `degraded`, while a
 * `fail-closed` limiter or a cache outage returns 503. Error details are
 * never mirrored into the probe response.
 */
export interface ReadinessDep {
  name: string;
  check: () => boolean | Promise<boolean>;
  degradedReady?: boolean | undefined;
}

const READINESS_PROBE_TIMEOUT_MS = 500;

async function probeWithTimeout(
  action: () => Promise<unknown>,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(action),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("readiness probe timed out")),
          READINESS_PROBE_TIMEOUT_MS,
        );
        timer.unref();
      }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function buildReadinessDeps(
  config: ChainMcpConfig | GatewayConfig,
  options?: {
    rateLimiter?: RateLimiter | undefined;
    cacheStore?: CacheStore | undefined;
  },
): ReadinessDep[] {
  const deps: ReadinessDep[] = [];

  if (
    config.rateLimit.enabled &&
    config.rateLimit.provider === "redis" &&
    options?.rateLimiter instanceof DistributedRateLimiter
  ) {
    const limiter = options.rateLimiter;
    deps.push({
      name: "rate-limiter",
      ...(limiter.failurePolicy === "fail-open"
        ? { degradedReady: true as const }
        : {}),
      check: () =>
        probeWithTimeout(() =>
          Promise.resolve(limiter.client.eval("return 1", [], [])),
        ),
    });
  }

  if (
    config.cache.enabled &&
    config.cache.provider === "redis" &&
    options?.cacheStore instanceof RedisCacheStore
  ) {
    const store = options.cacheStore;
    deps.push({
      name: "cache",
      // A read of a key that does not exist resolves `undefined` on a
      // healthy Redis and rejects only when Redis is unreachable, so it
      // proves liveness without writing anything.
      check: () =>
        probeWithTimeout(() =>
          Promise.resolve(store.client.get("chainmcp:readiness:probe")),
        ),
    });
  }

  return deps;
}

export async function logRateLimiterStartup(
  config: RateLimitConfig,
  options?: {
    logger?: Logger | undefined;
    client?: RedisRateLimitClient | undefined;
  },
): Promise<RateLimiterStartupHealth | undefined> {
  if (!config.enabled) {
    return undefined;
  }

  const globalQuota =
    config.globalQuota ??
    (config.requestsPerMinute !== undefined
      ? { maxRequests: config.requestsPerMinute, windowMs: 60_000 }
      : undefined);
  const globalConcurrency = config.globalConcurrency ?? config.concurrency;

  const quotaSummary = {
    globalQuota,
    globalConcurrency,
    tenantQuotaConfigured: config.tenantQuota !== undefined,
    tenantConcurrencyConfigured: config.tenantConcurrency !== undefined,
    toolQuotaCount: Object.keys(config.toolQuota ?? {}).length,
    toolConcurrencyCount: Object.keys(config.toolConcurrency ?? {}).length,
  };

  if (config.provider === "memory") {
    const health: RateLimiterStartupHealth = {
      provider: "memory",
      reachability: "local",
      keyPrefix: "in-memory",
      quotaSummary,
    };
    options?.logger?.info(
      "Rate limiter initialized",
      health as unknown as Record<string, unknown>,
    );
    return health;
  }

  let reachability: "reachable" | "unreachable" = "unreachable";
  if (options?.client && typeof options.client.eval === "function") {
    try {
      await options.client.eval("return 1", [], []);
      reachability = "reachable";
    } catch {
      reachability = "unreachable";
    }
  }

  const health: RateLimiterStartupHealth = {
    provider: "redis",
    reachability,
    keyPrefix: config.redis.keyPrefix,
    quotaSummary,
  };

  if (reachability === "reachable") {
    options?.logger?.info(
      "Rate limiter initialized",
      health as unknown as Record<string, unknown>,
    );
  } else {
    options?.logger?.warn(
      "Rate limiter initialized (Redis unreachable)",
      health as unknown as Record<string, unknown>,
    );
  }

  return health;
}

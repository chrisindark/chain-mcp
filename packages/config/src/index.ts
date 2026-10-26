import { z } from "zod";
import type {
  Authorizer,
  Logger,
  LogLevel,
  MetricsSink,
  RateLimiter,
  RuntimeOptions,
} from "@chainmcp/core";
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
  RollingAnalyticsAggregator,
  type LogSink,
} from "@chainmcp/analytics";
import type { NavigationLimits } from "@chainmcp/json-navigation";

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

export const RateLimitConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    provider: z.enum(["memory", "redis"]).default("memory"),
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
        keyPrefix: z.string().min(1).default("chainmcp:ratelimit:"),
        commandTimeoutMs: z
          .number()
          .int()
          .positive()
          .max(30_000)
          .default(1_000),
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
    issuer: z.string().optional(),
    audience: z.string().optional(),
    clockToleranceSeconds: z.number().int().nonnegative().default(30),
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

export const ContractConfigSchema = z
  .object({
    source: z.string().min(1),
    strict: z.boolean().default(true),
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
      })
      .strict()
      .prefault({}),
  })
  .strict()
  .prefault({});

export type AnalyticsConfig = z.infer<typeof AnalyticsConfigSchema>;

export const ChainMcpConfigSchema = z
  .object({
    version: z.literal(1),
    name: z.string().min(1).max(128),
    contract: ContractConfigSchema.optional(),
    server: z
      .object({
        transport: z.enum(["stdio", "http"]).default("stdio"),
        host: z.string().default("127.0.0.1"),
        port: z.number().int().min(1).max(65535).default(3333),
        path: z.string().default("/mcp"),
        requestTimeoutMs: z
          .number()
          .int()
          .positive()
          .max(300_000)
          .default(15_000),
        maxResponseBytes: z
          .number()
          .int()
          .positive()
          .max(100_000_000)
          .default(1_000_000),
      })
      .strict()
      // prefault, not default: Zod 4 `.default({})` short-circuits inner
      // parsing and would return `{}` without the field defaults above.
      .prefault({}),
    security: z
      .object({
        requireInboundAuth: z.boolean().default(false),
        allowedUpstreamHosts: z.array(AllowedHostSchema).default([]),
        redactHeaders: z
          .array(z.string().min(1))
          .default(["authorization", "cookie", "x-api-key"]),
      })
      .strict()
      .prefault({}),
    rateLimit: RateLimitConfigSchema,
    auth: AuthConfigSchema,
    logging: LoggingConfigSchema,
    jsonNavigation: JsonNavigationConfigSchema,
    analytics: AnalyticsConfigSchema,
  })
  .strict();

export type ChainMcpConfig = z.infer<typeof ChainMcpConfigSchema>;

export function parseConfig(input: unknown): ChainMcpConfig {
  return ChainMcpConfigSchema.parse(input);
}

export function safeParseConfig(
  input: unknown,
): ReturnType<typeof ChainMcpConfigSchema.safeParse> {
  return ChainMcpConfigSchema.safeParse(input);
}

export interface RateLimiterFactoryOptions {
  redisClient?: RedisRateLimitClient;
  now?: () => number;
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
    if (!options?.redisClient) {
      throw new TypeError(
        "Distributed rate limiter requires a Redis client (options.redisClient)",
      );
    }
    return new DistributedRateLimiter({
      client: options.redisClient,
      keyPrefix: config.redis.keyPrefix,
      commandTimeoutMs: config.redis.commandTimeoutMs,
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
  baseUrl: string;
}

export function buildExecutorOptions(
  config: ChainMcpConfig,
  overrides: BuildExecutorOptionsOverrides,
  factoryOptions?: CredentialProviderFactoryOptions,
): UpstreamExecutorOptions {
  const allowedHosts =
    overrides.allowedHosts ?? config.security.allowedUpstreamHosts;

  if (allowedHosts.length === 0) {
    throw new TypeError(
      "Cannot build executor options: security.allowedUpstreamHosts is empty. At least one allowed host must be configured.",
    );
  }

  const credentialProvider =
    overrides.credentialProvider ??
    createUpstreamCredentialProviderFromConfig(
      config.auth.upstream,
      factoryOptions,
    );

  return {
    baseUrl: overrides.baseUrl,
    allowedHosts,
    timeoutMs: overrides.timeoutMs ?? config.server.requestTimeoutMs,
    maxResponseBytes:
      overrides.maxResponseBytes ?? config.server.maxResponseBytes,
    ...(credentialProvider !== undefined ? { credentialProvider } : {}),
    ...(overrides.allowInsecureHttp !== undefined
      ? { allowInsecureHttp: overrides.allowInsecureHttp }
      : {}),
    ...(overrides.resolveHost !== undefined
      ? { resolveHost: overrides.resolveHost }
      : {}),
    ...(overrides.transport !== undefined
      ? { transport: overrides.transport }
      : {}),
    ...(overrides.maxRequestBytes !== undefined
      ? { maxRequestBytes: overrides.maxRequestBytes }
      : {}),
    ...(overrides.maxRedirects !== undefined
      ? { maxRedirects: overrides.maxRedirects }
      : {}),
    ...(overrides.contractRevision !== undefined
      ? { contractRevision: overrides.contractRevision }
      : {}),
    ...(overrides.ownerTenantId !== undefined
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

export function buildRuntimeOptions(
  config: ChainMcpConfig,
  overrides?: Partial<RuntimeOptions>,
  factoryOptions?: {
    rateLimiterOptions?: RateLimiterFactoryOptions;
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

  const rateLimiter =
    overrides?.rateLimiter ??
    createRateLimiterFromConfig(
      config.rateLimit,
      factoryOptions?.rateLimiterOptions,
    );

  const logger =
    overrides?.logger ??
    (config.logging.level !== "silent"
      ? createLoggerFromConfig(config.logging, {
          env: factoryOptions?.env,
          sink: factoryOptions?.diagnosticSink,
          auditSink: factoryOptions?.auditSink,
        })
      : undefined);

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

  return {
    ...(authorizer !== undefined ? { authorizer } : {}),
    ...(rateLimiter !== undefined ? { rateLimiter } : {}),
    ...(logger !== undefined ? { logger } : {}),
    ...(metrics !== undefined ? { metrics } : {}),
    defaultTimeoutMs:
      overrides?.defaultTimeoutMs ?? config.server.requestTimeoutMs,
    ...(overrides?.tenantMode !== undefined
      ? { tenantMode: overrides.tenantMode }
      : {}),
    ...(overrides?.tenantId !== undefined
      ? { tenantId: overrides.tenantId }
      : {}),
    ...(overrides?.now !== undefined ? { now: overrides.now } : {}),
    ...(overrides?.monotonicNow !== undefined
      ? { monotonicNow: overrides.monotonicNow }
      : {}),
    ...(overrides?.cache !== undefined ? { cache: overrides.cache } : {}),
    ...(overrides?.tokenizer !== undefined
      ? { tokenizer: overrides.tokenizer }
      : {}),
    ...(overrides?.projector !== undefined
      ? { projector: overrides.projector }
      : {}),
  };
}

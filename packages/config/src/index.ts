import { z } from "zod";
import type { Authorizer, RateLimiter, RuntimeOptions } from "@chainmcp/core";
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

export const InboundAuthConfigSchema = z
  .object({
    requireInboundAuth: z.boolean().default(false),
    authorizer: z.enum(["scope", "none"]).default("scope"),
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

export const ChainMcpConfigSchema = z
  .object({
    version: z.literal(1),
    name: z.string().min(1).max(128),
    contract: ContractConfigSchema.optional(),
    server: z
      .object({
        transport: z.literal("stdio").default("stdio"),
        host: z.string().default("127.0.0.1"),
        port: z.number().int().min(1).max(65535).default(3333),
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

export function buildRuntimeOptions(
  config: ChainMcpConfig,
  overrides?: Partial<RuntimeOptions>,
  factoryOptions?: {
    rateLimiterOptions?: RateLimiterFactoryOptions;
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

  return {
    ...(authorizer !== undefined ? { authorizer } : {}),
    ...(rateLimiter !== undefined ? { rateLimiter } : {}),
    defaultTimeoutMs:
      overrides?.defaultTimeoutMs ?? config.server.requestTimeoutMs,
    ...(overrides?.metrics !== undefined ? { metrics: overrides.metrics } : {}),
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

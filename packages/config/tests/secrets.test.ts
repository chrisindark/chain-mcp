import { describe, expect, it } from "vitest";

import {
  parseConfig,
  parseGatewayConfig,
  redactConfigSecrets,
  resolveConfigSecrets,
  SecretResolutionError,
} from "../src/index.js";

const secretConfig = {
  version: 1,
  name: "catalog",
  auth: {
    inbound: {
      tokens: {
        "${INBOUND_TOKEN}": {
          tenantId: "tenant-1",
          principalId: "client-1",
        },
      },
      apiKeys: {
        "${INBOUND_API_KEY:-dev-key}": {
          tenantId: "tenant-1",
          principalId: "client-2",
        },
      },
      jwt: { secret: "${JWT_SECRET}" },
    },
    upstream: {
      providers: [
        {
          type: "static",
          credentials: {
            apiKey: {
              type: "apiKey",
              name: "x-api-key",
              location: "header",
              value: "${UPSTREAM_API_KEY}",
            },
            bearer: {
              type: "http",
              scheme: "bearer",
              token: "${BEARER_TOKEN}",
            },
            basic: {
              type: "http",
              scheme: "basic",
              username: "${BASIC_USER}",
              password: "${BASIC_PASSWORD}",
            },
          },
        },
        {
          type: "oauth",
          tokenUrl: "https://auth.example.com/token",
          clientId: "client-id",
          clientSecret: "${OAUTH_CLIENT_SECRET}",
        },
        {
          type: "secretStore",
          keys: { "key-1": "${STORE_KEY}" },
        },
      ],
    },
  },
  cache: {
    redis: {
      url: "redis://:${REDIS_PASSWORD}@cache.example.com:6379/0",
      tls: { key: "${REDIS_TLS_KEY}" },
    },
  },
  rateLimit: {
    redis: { url: "${RATE_LIMIT_REDIS_URL}" },
  },
};

const env = {
  INBOUND_TOKEN: "token-abc",
  JWT_SECRET: "jwt-secret",
  UPSTREAM_API_KEY: "upstream-secret",
  BEARER_TOKEN: "bearer-secret",
  BASIC_USER: "basic-user",
  BASIC_PASSWORD: "basic-password",
  OAUTH_CLIENT_SECRET: "oauth-secret",
  STORE_KEY: "store-key",
  REDIS_PASSWORD: "redis-password",
  REDIS_TLS_KEY: "redis-tls-key",
  RATE_LIMIT_REDIS_URL: "redis://ratelimit.example.com:6379",
};

describe("resolveConfigSecrets", () => {
  it("resolves every designated credential field", () => {
    const { config, sources } = resolveConfigSecrets(secretConfig, { env });
    const auth = config.auth as {
      inbound: {
        tokens: Record<string, unknown>;
        apiKeys: Record<string, unknown>;
        jwt: { secret: string };
      };
      upstream: {
        providers: Array<Record<string, unknown>>;
      };
    };

    expect(Object.keys(auth.inbound.tokens)).toEqual(["token-abc"]);
    expect(auth.inbound.tokens["token-abc"]).toEqual({
      tenantId: "tenant-1",
      principalId: "client-1",
    });
    expect(Object.keys(auth.inbound.apiKeys)).toEqual(["dev-key"]);
    expect(auth.inbound.jwt.secret).toBe("jwt-secret");

    const staticProvider = auth.upstream.providers[0] as {
      credentials: Record<string, Record<string, string>>;
    };
    expect(staticProvider.credentials.apiKey?.value).toBe("upstream-secret");
    expect(staticProvider.credentials.bearer?.token).toBe("bearer-secret");
    expect(staticProvider.credentials.basic?.username).toBe("basic-user");
    expect(staticProvider.credentials.basic?.password).toBe("basic-password");

    const oauthProvider = auth.upstream.providers[1] as {
      clientSecret: string;
    };
    expect(oauthProvider.clientSecret).toBe("oauth-secret");

    const secretStoreProvider = auth.upstream.providers[2] as {
      keys: Record<string, string>;
    };
    expect(secretStoreProvider.keys["key-1"]).toBe("store-key");

    const cache = config.cache as {
      redis: { url: string; tls: { key: string } };
    };
    expect(cache.redis.url).toBe(
      "redis://:redis-password@cache.example.com:6379/0",
    );
    expect(cache.redis.tls.key).toBe("redis-tls-key");

    const rateLimit = config.rateLimit as { redis: { url: string } };
    expect(rateLimit.redis.url).toBe("redis://ratelimit.example.com:6379");

    expect(sources.length).toBeGreaterThan(0);
    const tokenSource = sources.find(
      (source) => source.field === "auth.inbound.tokens[#1]",
    );
    expect(tokenSource).toEqual({
      field: "auth.inbound.tokens[#1]",
      variables: ["INBOUND_TOKEN"],
      usesDefault: false,
      literal: false,
    });

    const defaultSource = sources.find(
      (source) => source.field === "auth.inbound.apiKeys[#1]",
    );
    expect(defaultSource?.usesDefault).toBe(true);
  });

  it("prefers the environment value over a default and treats empty as unset", () => {
    const { config } = resolveConfigSecrets(
      { auth: { inbound: { jwt: { secret: "${JWT:-fallback-jwt}" } } } },
      { env: { JWT: "real-jwt" } },
    );
    expect(
      (config as { auth: { inbound: { jwt: { secret: string } } } }).auth
        .inbound.jwt.secret,
    ).toBe("real-jwt");

    const empty = resolveConfigSecrets(
      { auth: { inbound: { jwt: { secret: "${JWT:-fallback-jwt}" } } } },
      { env: { JWT: "" } },
    );
    expect(
      (empty.config as { auth: { inbound: { jwt: { secret: string } } } }).auth
        .inbound.jwt.secret,
    ).toBe("fallback-jwt");
  });

  it("does not interpolate non-secret fields", () => {
    const input = {
      version: 1,
      name: "${NAME}",
      contract: {
        source: "${SPEC_PATH}",
        baseUrl: "https://api.example.com",
      },
      security: { allowedUpstreamHosts: ["api.example.com"] },
    };
    const { config, sources } = resolveConfigSecrets(input, { env: {} });
    expect((config as { name: string }).name).toBe("${NAME}");
    expect((config as { contract: { source: string } }).contract.source).toBe(
      "${SPEC_PATH}",
    );
    expect(sources).toEqual([]);
  });

  it("accepts literal credentials and marks them as literal", () => {
    const { config, sources } = resolveConfigSecrets(
      { auth: { inbound: { jwt: { secret: "literal-secret" } } } },
      { env: {} },
    );
    expect(
      (config as { auth: { inbound: { jwt: { secret: string } } } }).auth
        .inbound.jwt.secret,
    ).toBe("literal-secret");
    expect(sources).toEqual([
      {
        field: "auth.inbound.jwt.secret",
        variables: [],
        usesDefault: false,
        literal: true,
      },
    ]);
  });

  it("does not mutate the input document", () => {
    const input = {
      auth: { inbound: { jwt: { secret: "${JWT_SECRET}" } } },
    };
    resolveConfigSecrets(input, { env: { JWT_SECRET: "resolved" } });
    expect(input.auth.inbound.jwt.secret).toBe("${JWT_SECRET}");
  });

  it("fails with the field and variable when a reference has no value", () => {
    const error = captureError(() =>
      resolveConfigSecrets(
        {
          auth: {
            upstream: {
              providers: [
                {
                  type: "oauth",
                  tokenUrl: "https://auth.example.com/token",
                  clientId: "id",
                  clientSecret: "${MISSING_OAUTH_SECRET}",
                },
              ],
            },
          },
        },
        { env: {} },
      ),
    );

    expect(error).toBeInstanceOf(SecretResolutionError);
    expect(error.code).toBe("SECRET_UNRESOLVED");
    expect(error.field).toBe("auth.upstream.providers[0].clientSecret");
    expect(error.variable).toBe("MISSING_OAUTH_SECRET");
    expect(error.message).toContain("MISSING_OAUTH_SECRET");
    expect(error.message).toContain("auth.upstream.providers[0].clientSecret");
  });

  it("fails on malformed references without echoing the value", () => {
    const error = captureError(() =>
      resolveConfigSecrets(
        { auth: { inbound: { jwt: { secret: "prefix-${lower-case}" } } } },
        { env: {} },
      ),
    );

    expect(error.code).toBe("SECRET_UNRESOLVED");
    expect(error.field).toBe("auth.inbound.jwt.secret");
    expect(error.message).toContain("invalid secret reference");
    expect(error.message).not.toContain("lower-case");
  });

  it("leaves resolved values containing dollar signs verbatim", () => {
    const { config } = resolveConfigSecrets(
      { auth: { inbound: { jwt: { secret: "${JWT_SECRET}" } } } },
      { env: { JWT_SECRET: "pa$$-${NOT_EXPANDED}" } },
    );
    expect(
      (config as { auth: { inbound: { jwt: { secret: string } } } }).auth
        .inbound.jwt.secret,
    ).toBe("pa$$-${NOT_EXPANDED}");
  });

  it("produces a config that passes schema validation", () => {
    const { config } = resolveConfigSecrets(
      {
        version: 1,
        name: "catalog",
        security: { allowedUpstreamHosts: ["api.example.com"] },
        auth: {
          inbound: {
            requireInboundAuth: true,
            tokens: {
              "${INBOUND_TOKEN}": {
                tenantId: "tenant-1",
                principalId: "client-1",
              },
            },
          },
          upstream: {
            providers: [
              {
                type: "oauth",
                tokenUrl: "https://auth.example.com/token",
                clientId: "client-id",
                clientSecret: "${OAUTH_CLIENT_SECRET}",
              },
            ],
          },
        },
      },
      { env },
    );

    const parsed = parseConfig(config);
    expect(Object.keys(parsed.auth.inbound.tokens ?? {})).toEqual([
      "token-abc",
    ]);
    expect(parsed.auth.upstream.providers[0]).toMatchObject({
      type: "oauth",
      clientSecret: "oauth-secret",
    });
  });

  it("resolves gateway contract auth and Redis credentials", () => {
    const { config } = resolveConfigSecrets(
      {
        version: 1,
        name: "gateway",
        contracts: [],
        cache: { provider: "redis", redis: { url: "${CACHE_URL}" } },
        auth: {
          upstream: {
            providers: [{ type: "env", prefix: "CHAINMCP_AUTH_" }],
          },
        },
      },
      { env: { CACHE_URL: "redis://cache.example.com:6379" } },
    );

    const parsed = parseGatewayConfig(config);
    expect(parsed.cache.redis.url).toBe("redis://cache.example.com:6379");
  });
});

describe("redactConfigSecrets", () => {
  it("removes every credential value from the output", () => {
    const { config } = resolveConfigSecrets(secretConfig, { env });
    const redacted = redactConfigSecrets(config);
    const serialized = JSON.stringify(redacted);

    for (const secret of [
      "token-abc",
      "dev-key",
      "jwt-secret",
      "upstream-secret",
      "bearer-secret",
      "basic-user",
      "basic-password",
      "oauth-secret",
      "store-key",
      "redis-password",
      "redis-tls-key",
      "ratelimit.example.com",
    ]) {
      expect(serialized).not.toContain(secret);
    }

    expect(serialized).toContain("[REDACTED]");
    expect(serialized).toContain("[REDACTED:1]");
    expect(serialized).toContain("[REDACTED:2]");
  });

  it("redacts literal credentials as well", () => {
    const redacted = redactConfigSecrets({
      auth: {
        inbound: {
          jwt: { secret: "literal-secret" },
          tokens: { "literal-token": { tenantId: "t", principalId: "p" } },
        },
      },
    });
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain("literal-secret");
    expect(serialized).not.toContain("literal-token");
  });

  it("does not mutate the input document", () => {
    const input = { auth: { inbound: { jwt: { secret: "keep-me" } } } };
    redactConfigSecrets(input);
    expect(input.auth.inbound.jwt.secret).toBe("keep-me");
  });
});

function captureError(fn: () => unknown): SecretResolutionError {
  try {
    fn();
  } catch (error) {
    if (error instanceof SecretResolutionError) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected a SecretResolutionError");
}

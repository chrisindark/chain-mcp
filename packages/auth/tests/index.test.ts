import {
  InMemoryToolRuntime,
  RuntimeError,
  type ToolContext,
  type ToolDefinition,
} from "@chainmcp/core";
import { describe, expect, it, vi } from "vitest";

import { OperationScopeAuthorizer } from "../src/index.js";

const context = (scopes: string[]): ToolContext => ({
  requestId: "request-1",
  tenantId: "tenant-1",
  principal: { id: "user-1", scopes },
});

const contextWithBrokenPrincipal = {
  requestId: "request-1",
  tenantId: "tenant-1",
  principal: { id: "user-1", scopes: undefined },
} as unknown as ToolContext;

function tool(requiredScopes: readonly string[] = []): ToolDefinition {
  return {
    name: "lookup_item",
    description: "Look up a test item",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
    operation: { requiredScopes },
    ownerTenantId: "tenant-1",
    execute: async (input) => input,
  };
}

async function authorizeResult(
  authorizer: OperationScopeAuthorizer,
  definition: ToolDefinition,
  callerContext: ToolContext,
): Promise<unknown> {
  try {
    await authorizer.authorize(definition, callerContext);
    return "allowed";
  } catch (error) {
    return error;
  }
}

describe("OperationScopeAuthorizer", () => {
  it("allows tools that declare no required scopes", () => {
    const authorizer = new OperationScopeAuthorizer();
    expect(() => authorizer.authorize(tool(), context([]))).not.toThrow();
    expect(() =>
      authorizer.authorize(tool(["read"]), context(["read"])),
    ).not.toThrow();
  });

  it("grants when every required scope is present, without order or duplicate sensitivity", () => {
    const authorizer = new OperationScopeAuthorizer();
    expect(() =>
      authorizer.authorize(tool(["a", "b"]), context(["b", "a", "a"])),
    ).not.toThrow();
    expect(() =>
      authorizer.authorize(tool(["a", "a"]), context(["a"])),
    ).not.toThrow();
  });

  it("denies missing scopes fail closed with the safe message and a diagnostic cause", async () => {
    const authorizer = new OperationScopeAuthorizer();
    const failure = await authorizeResult(
      authorizer,
      tool(["read", "write"]),
      context(["read"]),
    );
    expect(failure).toBeInstanceOf(RuntimeError);
    const denial = failure as RuntimeError;
    expect(denial.code).toBe("AUTH_FORBIDDEN");
    expect(denial.message).toBe("Access denied");
    // The client-facing message never carries scope names; they are retained
    // only for protected diagnostics.
    expect(JSON.stringify(denial)).not.toContain("read");
    expect(denial.cause).toBeInstanceOf(Error);
    expect((denial.cause as Error).message).toContain("write");
  });

  it("matches scope tokens exactly", async () => {
    const authorizer = new OperationScopeAuthorizer();
    const failure = await authorizeResult(
      authorizer,
      tool(["read"]),
      context(["READ", "readWrite", "read:write"]),
    );
    expect(failure).toBeInstanceOf(RuntimeError);
    expect((failure as RuntimeError).code).toBe("AUTH_FORBIDDEN");
  });

  it("denies when the principal carries no scopes", async () => {
    const authorizer = new OperationScopeAuthorizer();
    const failure = await authorizeResult(
      authorizer,
      tool(["read"]),
      contextWithBrokenPrincipal,
    );
    expect(failure).toBeInstanceOf(RuntimeError);
    expect((failure as RuntimeError).code).toBe("AUTH_FORBIDDEN");
  });

  it("denies a required scope that is not a string", async () => {
    const authorizer = new OperationScopeAuthorizer();
    const failure = await authorizeResult(
      authorizer,
      tool(["read", 42 as unknown as string]),
      context(["read", "42"]),
    );
    expect(failure).toBeInstanceOf(RuntimeError);
    expect((failure as RuntimeError).code).toBe("AUTH_FORBIDDEN");
    expect((failure as RuntimeError).cause).toBeInstanceOf(Error);
  });

  describe("composition with the shared runtime (ADR 0008)", () => {
    function tenantTool(
      ownerTenantId: string,
      requiredScopes: readonly string[],
      execute: ToolDefinition["execute"],
    ): ToolDefinition {
      return {
        ...tool(requiredScopes),
        name: "lookup_item",
        ownerTenantId,
        execute,
      };
    }

    const tenantToolContext = (
      tenantId: string,
      scopes: string[],
    ): ToolContext => ({
      requestId: "request-2",
      tenantId,
      principal: { id: `user-${tenantId}`, scopes },
    });

    function scopedRuntime(
      scopeAuthorizer: OperationScopeAuthorizer,
      metrics?: { record: (event: unknown) => void },
    ): InMemoryToolRuntime {
      return new InMemoryToolRuntime({
        tenantMode: "multi-tenant",
        authorizer: scopeAuthorizer,
        ...(metrics ? { metrics } : {}),
      });
    }

    it("enforces required scopes in a multi-tenant runtime and records the denial", async () => {
      const scopeAuthorizer = new OperationScopeAuthorizer();
      const authorizeSpy = vi.spyOn(scopeAuthorizer, "authorize");
      const metrics = vi.fn();
      const runtime = scopedRuntime(scopeAuthorizer, { record: metrics });
      runtime.register(
        tenantTool("tenant-1", ["read"], async (input) => input),
      );

      await expect(
        runtime.callTool(
          "lookup_item",
          { id: "a" },
          tenantToolContext("tenant-1", []),
        ),
      ).rejects.toMatchObject({ code: "AUTH_FORBIDDEN" });
      expect(authorizeSpy).toHaveBeenCalledOnce();
      expect(metrics).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: "error",
          errorCode: "AUTH_FORBIDDEN",
          tenantId: "tenant-1",
          toolName: "lookup_item",
        }),
      );
    });

    it("grants qualified same-tenant calls", async () => {
      const runtime = scopedRuntime(new OperationScopeAuthorizer());
      runtime.register(
        tenantTool("tenant-1", ["read"], async (input) => input),
      );
      await expect(
        runtime.callTool(
          "lookup_item",
          { id: "a" },
          tenantToolContext("tenant-1", ["read"]),
        ),
      ).resolves.toEqual({ id: "a" });
    });

    it("cross-tenant calls fail structurally before the authorizer runs", async () => {
      const scopeAuthorizer = new OperationScopeAuthorizer();
      const authorizeSpy = vi.spyOn(scopeAuthorizer, "authorize");
      const runtime = scopedRuntime(scopeAuthorizer);
      runtime.register(
        tenantTool("tenant-2", ["read"], async (input) => input),
      );
      await expect(
        runtime.callTool(
          "lookup_item",
          { id: "a" },
          tenantToolContext("tenant-1", ["read"]),
        ),
      ).rejects.toMatchObject({ code: "TOOL_NOT_FOUND" });
      expect(authorizeSpy).not.toHaveBeenCalled();
    });
  });
});

import * as crypto from "node:crypto";
import {
  EncryptedSecretStore,
  InMemorySecretStore,
  StaticCredentialProvider,
  EnvCredentialProvider,
  SecretStoreCredentialProvider,
  CompositeCredentialProvider,
  OAuthClientCredentialsProvider,
  buildCredentialStoreKey,
  buildOAuthTokenStoreKey,
  defaultTokenFetcher,
  normalizeUpstreamCredential,
  MAX_TOKEN_RESPONSE_BYTES,
} from "../src/index.js";

describe("SecretStore and EncryptedSecretStore", () => {
  const key1 = crypto.randomBytes(32);
  const key2 = crypto.randomBytes(32);
  const key1Hex = key1.toString("hex");

  it("stores and retrieves plaintext secrets in InMemorySecretStore", async () => {
    const store = new InMemorySecretStore();
    await store.set("api_key", "secret-value-123");
    expect(await store.get("api_key")).toBe("secret-value-123");
    expect(await store.get("unknown")).toBeUndefined();
    await store.delete("api_key");
    expect(await store.get("api_key")).toBeUndefined();
  });

  it("validates key names to prevent illegal characters or prototype pollution", async () => {
    const store = new InMemorySecretStore();
    await expect(store.set("__proto__", "val")).rejects.toThrow(TypeError);
    await expect(store.set("bad key with spaces", "val")).rejects.toThrow(
      TypeError,
    );
  });

  it("encrypts secrets at rest using AES-256-GCM and decrypts with the active key", async () => {
    const rawStore = new InMemorySecretStore();
    const encryptedStore = new EncryptedSecretStore({
      store: rawStore,
      activeKeyId: "k1",
      keys: { k1: key1Hex },
    });

    await encryptedStore.set("upstream:token", "super-secret-token");

    // The raw store must hold ciphertext, not plaintext!
    const rawValue = await rawStore.get("upstream:token");
    expect(rawValue).toBeDefined();
    expect(rawValue).not.toContain("super-secret-token");
    expect(rawValue).toMatch(/^v1:k1:[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/);

    // Decrypts cleanly through the encrypted store
    const decrypted = await encryptedStore.get("upstream:token");
    expect(decrypted).toBe("super-secret-token");
  });

  it("fails closed when auth tag is corrupted or ciphertext is modified", async () => {
    const rawStore = new InMemorySecretStore();
    const encryptedStore = new EncryptedSecretStore({
      store: rawStore,
      activeKeyId: "k1",
      keys: { k1: key1 },
    });

    await encryptedStore.set("token", "secret");
    const raw = (await rawStore.get("token"))!;
    const parts = raw.split(":");
    // Tamper with ciphertext hex (parts[4])
    const tamperedCipher = "00" + parts[4]!.slice(2);
    parts[4] = tamperedCipher;
    await rawStore.set("token", parts.join(":"));

    await expect(encryptedStore.get("token")).rejects.toThrow(
      /authentication verification failed/,
    );
  });

  it("fails closed when ciphertext is swapped across different keys (AAD mismatch)", async () => {
    const rawStore = new InMemorySecretStore();
    const encryptedStore = new EncryptedSecretStore({
      store: rawStore,
      activeKeyId: "k1",
      keys: { k1: key1 },
    });

    await encryptedStore.set("keyA", "secretA");
    const rawA = (await rawStore.get("keyA"))!;
    // Attacker copies ciphertext from keyA to keyB
    await rawStore.set("keyB", rawA);

    // Reading keyB must fail because AAD was bound to keyA
    await expect(encryptedStore.get("keyB")).rejects.toThrow(
      /authentication verification failed/,
    );
  });

  it("supports key rotation across multiple key versions in the key ring", async () => {
    const rawStore = new InMemorySecretStore();
    const storeV1 = new EncryptedSecretStore({
      store: rawStore,
      activeKeyId: "k1",
      keys: { k1: key1 },
    });

    await storeV1.set("db_password", "mypassword1");

    // Upgrade to store with k2 as active, but retaining k1 in ring
    const storeV2 = new EncryptedSecretStore({
      store: rawStore,
      activeKeyId: "k2",
      keys: { k1: key1, k2: key2 },
    });

    // Old secret encrypted with k1 can still be decrypted
    expect(await storeV2.get("db_password")).toBe("mypassword1");

    // Rotate the key for db_password
    const rotated = await storeV2.rotate("db_password");
    expect(rotated).toBe(true);

    // Raw store now has ciphertext encrypted with k2!
    const rawAfterRotate = (await rawStore.get("db_password"))!;
    expect(rawAfterRotate).toMatch(/^v1:k2:/);
    expect(await storeV2.get("db_password")).toBe("mypassword1");
  });

  it("validates key IDs against KEY_ID_PATTERN to prevent delimiter injection", async () => {
    const rawStore = new InMemorySecretStore();

    // Rejects keyId with colons
    expect(
      () =>
        new EncryptedSecretStore({
          store: rawStore,
          activeKeyId: "k:1",
          keys: { "k:1": key1 },
        }),
    ).toThrow(TypeError);

    // Rejects keyId with spaces or symbols
    expect(
      () =>
        new EncryptedSecretStore({
          store: rawStore,
          activeKeyId: "key with spaces",
          keys: { "key with spaces": key1 },
        }),
    ).toThrow(TypeError);

    // Rejects reserved key IDs
    expect(
      () =>
        new EncryptedSecretStore({
          store: rawStore,
          activeKeyId: "__proto__",
          keys: { __proto__: key1 },
        }),
    ).toThrow(TypeError);

    const validStore = new EncryptedSecretStore({
      store: rawStore,
      activeKeyId: "valid_key-1",
      keys: { "valid_key-1": key1 },
    });

    // Rejects rotate to invalid key ID
    await validStore.set("test_key", "secret");
    await expect(validStore.rotate("test_key", "bad:target")).rejects.toThrow(
      TypeError,
    );

    // Rejects ciphertext containing invalid keyId
    await rawStore.set(
      "corrupted_keyid",
      `v1:bad:key:${crypto.randomBytes(12).toString("hex")}:${crypto.randomBytes(16).toString("hex")}:deadbeef`,
    );
    await expect(validStore.get("corrupted_keyid")).rejects.toThrow(
      /Invalid or unsupported ciphertext format/,
    );
  });
});

describe("UpstreamCredentialProviders", () => {
  it("resolves static credentials by scheme name", async () => {
    const provider = new StaticCredentialProvider({
      credentials: {
        api_key: "my-api-key-val",
        bearer_auth: { type: "http", scheme: "bearer", token: "tok-123" },
        basic_auth: { username: "admin", password: "pwd" },
      },
    });

    const apiKey = await provider.resolveCredential({
      tenantId: "t1",
      toolName: "getPet",
      schemeName: "api_key",
      schemeType: "apiKey",
      parameterName: "X-API-KEY",
      parameterLocation: "header",
    });
    expect(apiKey).toEqual({
      type: "apiKey",
      name: "X-API-KEY",
      location: "header",
      value: "my-api-key-val",
    });

    const bearer = await provider.resolveCredential({
      tenantId: "t1",
      toolName: "getPet",
      schemeName: "bearer_auth",
      schemeType: "http",
      httpScheme: "bearer",
    });
    expect(bearer).toEqual({
      type: "http",
      scheme: "bearer",
      token: "tok-123",
    });

    const basic = await provider.resolveCredential({
      tenantId: "t1",
      toolName: "getPet",
      schemeName: "basic_auth",
      schemeType: "http",
      httpScheme: "basic",
    });
    expect(basic).toEqual({
      type: "http",
      scheme: "basic",
      username: "admin",
      password: "pwd",
    });

    const unknown = await provider.resolveCredential({
      tenantId: "t1",
      toolName: "getPet",
      schemeName: "missing",
      schemeType: "http",
    });
    expect(unknown).toBeUndefined();
  });

  it("resolves credentials from environment variables", async () => {
    const env = {
      CHAINMCP_AUTH_PETSTORE_KEY: "pet-secret",
      CUSTOM_BEARER_VAR: "bearer-secret-token",
    };
    const provider = new EnvCredentialProvider({
      env,
      mappings: {
        my_bearer: "CUSTOM_BEARER_VAR",
      },
    });

    const apiKey = await provider.resolveCredential({
      tenantId: "t1",
      toolName: "getPet",
      schemeName: "petstore_key",
      schemeType: "apiKey",
      parameterName: "api_key",
      parameterLocation: "query",
    });
    expect(apiKey).toEqual({
      type: "apiKey",
      name: "api_key",
      location: "query",
      value: "pet-secret",
    });

    const bearer = await provider.resolveCredential({
      tenantId: "t1",
      toolName: "getPet",
      schemeName: "my_bearer",
      schemeType: "http",
      httpScheme: "bearer",
    });
    expect(bearer).toEqual({
      type: "http",
      scheme: "bearer",
      token: "bearer-secret-token",
    });
  });

  it("resolves credentials from an encrypted SecretStore by tenant", async () => {
    const secretStore = new InMemorySecretStore();
    await secretStore.set(
      buildCredentialStoreKey({ tenantId: "tenant-1", schemeName: "api_key" }),
      JSON.stringify({
        type: "apiKey",
        name: "X-Key",
        location: "header",
        value: "tenant1-secret",
      }),
    );
    await secretStore.set(
      buildCredentialStoreKey({ schemeName: "global_bearer" }),
      "global-token-xyz",
    );

    const provider = new SecretStoreCredentialProvider({ store: secretStore });

    const tenantKey = await provider.resolveCredential({
      tenantId: "tenant-1",
      toolName: "lookup",
      schemeName: "api_key",
      schemeType: "apiKey",
    });
    expect(tenantKey).toEqual({
      type: "apiKey",
      name: "X-Key",
      location: "header",
      value: "tenant1-secret",
    });

    // The deployment-wide key must not satisfy another tenant by default.
    const otherTenant = await provider.resolveCredential({
      tenantId: "tenant-2",
      toolName: "lookup",
      schemeName: "api_key",
      schemeType: "apiKey",
    });
    expect(otherTenant).toBeUndefined();

    const globalWithoutOptIn = await provider.resolveCredential({
      tenantId: "tenant-2",
      toolName: "lookup",
      schemeName: "global_bearer",
      schemeType: "http",
      httpScheme: "bearer",
    });
    expect(globalWithoutOptIn).toBeUndefined();
  });

  it("uses the shared credential only when allowGlobalFallback is enabled", async () => {
    const secretStore = new InMemorySecretStore();
    await secretStore.set(
      buildCredentialStoreKey({ schemeName: "global_bearer" }),
      "global-token-xyz",
    );

    const provider = new SecretStoreCredentialProvider({
      store: secretStore,
      allowGlobalFallback: true,
    });

    const globalBearer = await provider.resolveCredential({
      tenantId: "tenant-2",
      toolName: "lookup",
      schemeName: "global_bearer",
      schemeType: "http",
      httpScheme: "bearer",
    });
    expect(globalBearer).toEqual({
      type: "http",
      scheme: "bearer",
      token: "global-token-xyz",
    });
  });

  it("derives store keys that satisfy the secret-store key grammar", async () => {
    // Tenant and principal identifiers from real identity systems often
    // contain characters the secret store rejects, such as '@' or spaces.
    const secretStore = new EncryptedSecretStore({
      store: new InMemorySecretStore(),
      activeKeyId: "k1",
      keys: { k1: crypto.randomBytes(32) },
    });
    const key = buildCredentialStoreKey({
      tenantId: "user@example.com / tenant one",
      schemeName: "my scheme",
    });
    await secretStore.set(key, "secret-value");
    await expect(secretStore.get(key)).resolves.toBe("secret-value");
    expect(key).not.toContain("@");
    expect(key).not.toContain(" ");
  });

  it("treats malformed credential material as unresolved instead of trusting the type", async () => {
    // A configured value that is not a valid credential must fail closed with
    // no credential, not reach request construction as an unvalidated object.
    const provider = new StaticCredentialProvider({
      credentials: {
        missing_value: { type: "apiKey", name: "X-Key" } as never,
        missing_token: { type: "http", scheme: "bearer" } as never,
        null_value: null as never,
        colonless_basic: "userpass",
      },
    });

    const apiKey = await provider.resolveCredential({
      tenantId: "t1",
      toolName: "op",
      schemeName: "missing_value",
      schemeType: "apiKey",
    });
    expect(apiKey).toBeUndefined();

    const bearer = await provider.resolveCredential({
      tenantId: "t1",
      toolName: "op",
      schemeName: "missing_token",
      schemeType: "http",
    });
    expect(bearer).toBeUndefined();

    const nullValue = await provider.resolveCredential({
      tenantId: "t1",
      toolName: "op",
      schemeName: "null_value",
      schemeType: "http",
    });
    expect(nullValue).toBeUndefined();

    // A declared basic scheme needs a `user:password` separator.
    const basic = await provider.resolveCredential({
      tenantId: "t1",
      toolName: "op",
      schemeName: "colonless_basic",
      schemeType: "http",
      httpScheme: "basic",
    });
    expect(basic).toBeUndefined();
  });

  it("validates credential shapes and rejects unknown variants", () => {
    expect(
      normalizeUpstreamCredential({
        type: "apiKey",
        name: "X-Key",
        location: "sideways",
        value: "secret",
      }),
    ).toBeUndefined();
    expect(
      normalizeUpstreamCredential({
        type: "oauth2",
        token: "token",
        scopes: ["read", 7],
      }),
    ).toBeUndefined();
    expect(normalizeUpstreamCredential(null)).toBeUndefined();
    expect(normalizeUpstreamCredential({ type: "unknown" })).toBeUndefined();
    expect(
      normalizeUpstreamCredential({
        type: "http",
        scheme: "basic",
        username: "",
        password: "",
      }),
    ).toBeUndefined();
    expect(
      normalizeUpstreamCredential({
        type: "http",
        scheme: "basic",
        username: "user",
        password: "",
      }),
    ).toEqual({
      type: "http",
      scheme: "basic",
      username: "user",
      password: "",
    });
  });

  it("chains multiple providers in CompositeCredentialProvider", async () => {
    const p1 = new StaticCredentialProvider({ credentials: { s1: "cred1" } });
    const p2 = new StaticCredentialProvider({ credentials: { s2: "cred2" } });
    const composite = new CompositeCredentialProvider([p1, p2]);

    const res1 = await composite.resolveCredential({
      tenantId: "t",
      toolName: "tool",
      schemeName: "s1",
      schemeType: "apiKey",
    });
    expect(res1).toMatchObject({ type: "apiKey", value: "cred1" });

    const res2 = await composite.resolveCredential({
      tenantId: "t",
      toolName: "tool",
      schemeName: "s2",
      schemeType: "apiKey",
    });
    expect(res2).toMatchObject({ type: "apiKey", value: "cred2" });

    const res3 = await composite.resolveCredential({
      tenantId: "t",
      toolName: "tool",
      schemeName: "s3",
      schemeType: "apiKey",
    });
    expect(res3).toBeUndefined();
  });
});

describe("OAuthClientCredentialsProvider", () => {
  it("acquires, caches, and automatically refreshes tokens upon expiry", async () => {
    let mockTime = 1_000_000;
    const now = () => mockTime;

    let fetchCount = 0;
    const fetchToken = vi.fn(
      async (
        _url: string,
        body: URLSearchParams,
        headers: Record<string, string>,
      ) => {
        fetchCount++;
        expect(body.get("grant_type")).toBe("client_credentials");
        expect(headers.authorization).toContain("Basic ");
        return {
          access_token: `access-token-${fetchCount}`,
          token_type: "Bearer",
          expires_in: 3600, // 1 hour
          scope: "read write",
        };
      },
    );

    const provider = new OAuthClientCredentialsProvider({
      tokenUrl: "https://auth.example.com/oauth/token",
      clientId: "test-client",
      clientSecret: "test-secret",
      fetchToken,
      now,
      expirySkewSeconds: 30,
    });

    const req = {
      tenantId: "t1",
      toolName: "fetchData",
      schemeName: "oauth",
      schemeType: "oauth2",
      requiredScopes: ["read"],
    };

    // First call: fetches new token
    const cred1 = await provider.resolveCredential(req);
    expect(cred1).toEqual({
      type: "oauth2",
      token: "access-token-1",
      tokenType: "Bearer",
      expiresAt: 1_000_000 + 3600 * 1000,
      scopes: ["read", "write"],
    });
    expect(fetchCount).toBe(1);

    // Second call 10 minutes later: returns cached token without calling endpoint
    mockTime += 600 * 1000;
    const cred2 = await provider.resolveCredential(req);
    expect(cred2).toMatchObject({ type: "oauth2", token: "access-token-1" });
    expect(fetchCount).toBe(1);

    // Advance time past expiry (3600s - 30s skew = 3570s threshold)
    mockTime += 3000 * 1000;
    const cred3 = await provider.resolveCredential(req);
    expect(cred3).toMatchObject({ type: "oauth2", token: "access-token-2" });
    expect(fetchCount).toBe(2);

    // Manual invalidation forces refresh
    await provider.invalidate("t1", "oauth");
    const cred4 = await provider.resolveCredential(req);
    expect(cred4).toMatchObject({ type: "oauth2", token: "access-token-3" });
    expect(fetchCount).toBe(3);
  });

  it("partitions token cache by normalized scopes and principal ID", async () => {
    let tokenIndex = 0;
    const fetchToken = vi.fn(async (_url: string, body: URLSearchParams) => {
      tokenIndex++;
      const scope = body.get("scope") ?? "";
      return {
        access_token: `tok-${tokenIndex}-${scope}`,
        token_type: "Bearer",
        expires_in: 3600,
      };
    });

    const provider = new OAuthClientCredentialsProvider({
      tokenUrl: "https://auth.example.com/oauth/token",
      clientId: "test-client",
      clientSecret: "test-secret",
      fetchToken,
    });

    const expectOAuthToken = (cred: unknown): string => {
      expect(cred).toMatchObject({ type: "oauth2" });
      return (cred as { token: string }).token;
    };

    // 1. Unordered scopes resolve to the same cached token
    const tokenAB1 = await provider.resolveCredential({
      tenantId: "t1",
      toolName: "op",
      schemeName: "oauth",
      schemeType: "oauth2",
      requiredScopes: ["read", "write"],
    });
    const tokenAB2 = await provider.resolveCredential({
      tenantId: "t1",
      toolName: "op",
      schemeName: "oauth",
      schemeType: "oauth2",
      requiredScopes: ["write", "read", "read"], // unordered and duplicate
    });
    expect(expectOAuthToken(tokenAB1)).toBe(expectOAuthToken(tokenAB2));
    expect(fetchToken).toHaveBeenCalledTimes(1);

    // 2. Different scopes fetch a distinct token
    const tokenRead = await provider.resolveCredential({
      tenantId: "t1",
      toolName: "op",
      schemeName: "oauth",
      schemeType: "oauth2",
      requiredScopes: ["read"],
    });
    expect(expectOAuthToken(tokenRead)).not.toBe(expectOAuthToken(tokenAB1));
    expect(fetchToken).toHaveBeenCalledTimes(2);

    // 3. Different principalId partition the cache
    const tokenUser1 = await provider.resolveCredential({
      tenantId: "t1",
      principalId: "user-1",
      toolName: "op",
      schemeName: "oauth",
      schemeType: "oauth2",
      requiredScopes: ["read"],
    });
    const tokenUser2 = await provider.resolveCredential({
      tenantId: "t1",
      principalId: "user-2",
      toolName: "op",
      schemeName: "oauth",
      schemeType: "oauth2",
      requiredScopes: ["read"],
    });
    expect(expectOAuthToken(tokenUser1)).not.toBe(expectOAuthToken(tokenRead));
    expect(expectOAuthToken(tokenUser2)).not.toBe(expectOAuthToken(tokenUser1));
    expect(fetchToken).toHaveBeenCalledTimes(4);

    // 4. Invalidation with principalId targets only that principal
    await provider.invalidate("t1", "oauth", "user-1");
    // user-1 fetches again
    await provider.resolveCredential({
      tenantId: "t1",
      principalId: "user-1",
      toolName: "op",
      schemeName: "oauth",
      schemeType: "oauth2",
      requiredScopes: ["read"],
    });
    expect(fetchToken).toHaveBeenCalledTimes(5);

    // user-2 uses its cached token
    await provider.resolveCredential({
      tenantId: "t1",
      principalId: "user-2",
      toolName: "op",
      schemeName: "oauth",
      schemeType: "oauth2",
      requiredScopes: ["read"],
    });
    expect(fetchToken).toHaveBeenCalledTimes(5);
  });

  it("passes context.signal through to fetchToken", async () => {
    let receivedSignal: AbortSignal | undefined;
    const fetchToken = vi.fn(
      async (
        _url: string,
        _body: URLSearchParams,
        _headers: Record<string, string>,
        options?: { signal?: AbortSignal },
      ) => {
        receivedSignal = options?.signal;
        return {
          access_token: "tok-signal",
          token_type: "Bearer",
        };
      },
    );

    const provider = new OAuthClientCredentialsProvider({
      tokenUrl: "https://auth.example.com/oauth/token",
      clientId: "test-client",
      clientSecret: "test-secret",
      fetchToken,
    });

    const controller = new AbortController();
    await provider.resolveCredential({
      tenantId: "t1",
      toolName: "op",
      schemeName: "oauth",
      schemeType: "oauth2",
      signal: controller.signal,
    });

    expect(receivedSignal).toBe(controller.signal);
  });
});

describe("defaultTokenFetcher", () => {
  it("fetches and parses JSON token response", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          access_token: "fetched-token-123",
          token_type: "Bearer",
          expires_in: 3600,
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    });

    try {
      const res = await defaultTokenFetcher(
        "https://auth.example.com/token",
        new URLSearchParams({ grant_type: "client_credentials" }),
        {},
        { allowedHosts: ["auth.example.com"] },
      );
      expect(res.access_token).toBe("fetched-token-123");
      expect(res.token_type).toBe("Bearer");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects non-JSON content types", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => {
      return new Response("<html>Bad Gateway</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    });

    try {
      await expect(
        defaultTokenFetcher(
          "https://auth.example.com/token",
          new URLSearchParams(),
          {},
          { allowedHosts: ["auth.example.com"] },
        ),
      ).rejects.toThrow(/non-JSON/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects responses exceeding MAX_TOKEN_RESPONSE_BYTES", async () => {
    const originalFetch = globalThis.fetch;
    const oversizedBody = "a".repeat(MAX_TOKEN_RESPONSE_BYTES + 100);
    globalThis.fetch = vi.fn(async () => {
      return new Response(oversizedBody, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    try {
      await expect(
        defaultTokenFetcher(
          "https://auth.example.com/token",
          new URLSearchParams(),
          {},
          { allowedHosts: ["auth.example.com"] },
        ),
      ).rejects.toThrow(/exceeded maximum size/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("aborts when caller signal is cancelled", async () => {
    const controller = new AbortController();
    controller.abort(new Error("caller cancelled"));

    await expect(
      defaultTokenFetcher(
        "https://auth.example.com/token",
        new URLSearchParams(),
        {},
        { signal: controller.signal, allowedHosts: ["auth.example.com"] },
      ),
    ).rejects.toThrow("caller cancelled");
  });
});

describe("OAuth token cache persistence and revocation", () => {
  const oauthContext = {
    tenantId: "tenant-1",
    toolName: "op",
    schemeName: "oauth",
    schemeType: "oauth2",
  };

  const encryptedStore = (): EncryptedSecretStore =>
    new EncryptedSecretStore({
      store: new InMemorySecretStore(),
      activeKeyId: "k1",
      keys: { k1: crypto.randomBytes(32) },
    });

  it("persists tokens across provider instances when a scheme has several scopes", async () => {
    const tokenStore = encryptedStore();
    let fetchCount = 0;
    const fetchToken = vi.fn(async () => {
      fetchCount += 1;
      return {
        access_token: `token-${fetchCount}`,
        token_type: "Bearer",
        expires_in: 3600,
      };
    });
    const config = {
      tokenUrl: "https://auth.example.com/token",
      clientId: "c",
      clientSecret: "s",
      scopes: ["catalog:read", "catalog:write"],
      tokenStore,
      fetchToken,
      now: () => 1_000_000,
    };

    const first = new OAuthClientCredentialsProvider(config);
    await expect(first.resolveCredential(oauthContext)).resolves.toMatchObject({
      token: "token-1",
    });

    // A restarted process shares only the persistent store.
    const second = new OAuthClientCredentialsProvider(config);
    await expect(second.resolveCredential(oauthContext)).resolves.toMatchObject(
      { token: "token-1" },
    );
    expect(fetchToken).toHaveBeenCalledTimes(1);
  });

  it("keeps partitions store-safe for principals with reserved characters", async () => {
    const tokenStore = encryptedStore();
    let fetchCount = 0;
    const fetchToken = vi.fn(async () => {
      fetchCount += 1;
      return {
        access_token: `token-${fetchCount}`,
        token_type: "Bearer",
        expires_in: 3600,
      };
    });
    const config = {
      tokenUrl: "https://auth.example.com/token",
      clientId: "c",
      clientSecret: "s",
      tokenStore,
      fetchToken,
      now: () => 1_000_000,
    };

    const context = {
      ...oauthContext,
      principalId: "user@example.com/work group",
    };
    const first = new OAuthClientCredentialsProvider(config);
    await expect(first.resolveCredential(context)).resolves.toMatchObject({
      token: "token-1",
    });
    const second = new OAuthClientCredentialsProvider(config);
    await expect(second.resolveCredential(context)).resolves.toMatchObject({
      token: "token-1",
    });
    expect(fetchToken).toHaveBeenCalledTimes(1);
  });

  it("removes the persistent copy when invalidate() is called without filters", async () => {
    const tokenStore = encryptedStore();
    let fetchCount = 0;
    const fetchToken = vi.fn(async () => {
      fetchCount += 1;
      return {
        access_token: `token-${fetchCount}`,
        token_type: "Bearer",
        expires_in: 3600,
      };
    });
    const config = {
      tokenUrl: "https://auth.example.com/token",
      clientId: "c",
      clientSecret: "s",
      tokenStore,
      fetchToken,
      now: () => 1_000_000,
    };

    const first = new OAuthClientCredentialsProvider(config);
    await first.resolveCredential(oauthContext);
    await first.invalidate();

    // Another process must not resurrect the revoked token from the store.
    const second = new OAuthClientCredentialsProvider(config);
    await expect(second.resolveCredential(oauthContext)).resolves.toMatchObject(
      { token: "token-2" },
    );
    expect(fetchToken).toHaveBeenCalledTimes(2);
  });

  it("invalidates only the matching tenant", async () => {
    const tokenStore = encryptedStore();
    let fetchCount = 0;
    const fetchToken = vi.fn(async () => {
      fetchCount += 1;
      return {
        access_token: `token-${fetchCount}`,
        token_type: "Bearer",
        expires_in: 3600,
      };
    });
    const config = {
      tokenUrl: "https://auth.example.com/token",
      clientId: "c",
      clientSecret: "s",
      tokenStore,
      fetchToken,
      now: () => 1_000_000,
    };

    const provider = new OAuthClientCredentialsProvider(config);
    await provider.resolveCredential({ ...oauthContext, tenantId: "tenant-1" });
    await provider.resolveCredential({ ...oauthContext, tenantId: "tenant-2" });
    expect(fetchToken).toHaveBeenCalledTimes(2);

    await provider.invalidate("tenant-1", "oauth");

    await expect(
      provider.resolveCredential({ ...oauthContext, tenantId: "tenant-2" }),
    ).resolves.toMatchObject({ token: "token-2" });
    await expect(
      provider.resolveCredential({ ...oauthContext, tenantId: "tenant-1" }),
    ).resolves.toMatchObject({ token: "token-3" });
    expect(fetchToken).toHaveBeenCalledTimes(3);
  });

  it("bypasses a failing token store instead of failing credential resolution", async () => {
    let fetchCount = 0;
    const fetchToken = vi.fn(async () => {
      fetchCount += 1;
      return {
        access_token: `token-${fetchCount}`,
        token_type: "Bearer",
        expires_in: 3600,
      };
    });
    const provider = new OAuthClientCredentialsProvider({
      tokenUrl: "https://auth.example.com/token",
      clientId: "c",
      clientSecret: "s",
      fetchToken,
      now: () => 1_000_000,
      tokenStore: {
        get: async () => {
          throw new Error("store offline");
        },
        set: async () => {
          throw new Error("store offline");
        },
        delete: async () => {
          throw new Error("store offline");
        },
      },
    });

    await expect(
      provider.resolveCredential(oauthContext),
    ).resolves.toMatchObject({ token: "token-1" });
    await expect(
      provider.resolveCredential(oauthContext),
    ).resolves.toMatchObject({ token: "token-1" });
    expect(fetchToken).toHaveBeenCalledTimes(1);
  });

  it("bounds the length of a derived token store key", () => {
    const key = buildOAuthTokenStoreKey({
      tenantId: "tenant-1",
      principalId: "user-1",
      schemeName: "oauth",
      normalizedScopes: Array.from({ length: 60 }, (_, i) => `scope:${i}`).join(
        " ",
      ),
    });
    expect(key.length).toBeLessThanOrEqual(256);
    expect(key).toMatch(/^[a-zA-Z0-9_:./-]{1,256}$/);
  });
});

describe("OAuth token endpoint policy", () => {
  const config = {
    tokenUrl: "https://auth.example.com/token",
    clientId: "c",
    clientSecret: "s",
  };
  const oauthContext = {
    tenantId: "tenant-1",
    toolName: "op",
    schemeName: "oauth",
    schemeType: "oauth2",
  };

  it("requires an allowlist or an explicit opt-out", async () => {
    await expect(
      defaultTokenFetcher(
        "https://auth.example.com/token",
        new URLSearchParams(),
        {},
      ),
    ).rejects.toThrow(/must be allowlisted/);
  });

  it("rejects a host outside the declared allowlist", async () => {
    await expect(
      defaultTokenFetcher(
        "https://evil.example/token",
        new URLSearchParams(),
        {},
        { allowedHosts: ["auth.example.com"] },
      ),
    ).rejects.toThrow(/not allowlisted/);
  });

  it("requires HTTPS unless plain HTTP is explicitly allowed", async () => {
    await expect(
      defaultTokenFetcher(
        "http://auth.example.com/token",
        new URLSearchParams(),
        {},
        {
          allowedHosts: ["auth.example.com"],
        },
      ),
    ).rejects.toThrow(/Plain HTTP/);

    const originalFetch = globalThis.fetch;
    const calls: Array<{ redirect?: string | undefined }> = [];
    globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      calls.push({ redirect: init?.redirect });
      return new Response(JSON.stringify({ access_token: "t" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    try {
      await expect(
        defaultTokenFetcher(
          "http://auth.example.com/token",
          new URLSearchParams(),
          {},
          { allowedHosts: ["auth.example.com"], allowInsecureHttp: true },
        ),
      ).resolves.toMatchObject({ access_token: "t" });
      expect(calls[0]?.redirect).toBe("manual");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("refuses redirects instead of following them to another origin", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://attacker.example/token" },
        }),
    ) as typeof fetch;
    try {
      await expect(
        defaultTokenFetcher(
          "https://auth.example.com/token",
          new URLSearchParams(),
          {},
          { allowedHosts: ["auth.example.com"] },
        ),
      ).rejects.toThrow(/redirects are not followed/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("validates configured token hosts at construction", () => {
    expect(
      () =>
        new OAuthClientCredentialsProvider({
          ...config,
          allowedTokenHosts: ["https://auth.example.com/token"],
        }),
    ).toThrow(TypeError);
    expect(
      () =>
        new OAuthClientCredentialsProvider({
          ...config,
          allowedTokenHosts: ["*.example.com"],
        }),
    ).toThrow(/wildcards/);
  });

  it("forwards the allowlist and caller signal to the configured fetcher", async () => {
    let received: { allowedHosts?: readonly string[]; signal?: AbortSignal } =
      {};
    const fetchToken = vi.fn(
      async (
        _url: string,
        _body: URLSearchParams,
        _headers: Readonly<Record<string, string>>,
        options?: { allowedHosts?: readonly string[]; signal?: AbortSignal },
      ) => {
        received = options ?? {};
        return { access_token: "tok", token_type: "Bearer" };
      },
    );
    const controller = new AbortController();
    const provider = new OAuthClientCredentialsProvider({
      ...config,
      allowedTokenHosts: ["auth.example.com"],
      fetchToken,
    });

    await provider.resolveCredential({
      ...oauthContext,
      signal: controller.signal,
    });
    expect(received.allowedHosts).toEqual(["auth.example.com"]);
    expect(received.signal).toBe(controller.signal);
  });

  it("prefers an executor-supplied token endpoint fetcher over the local one", async () => {
    const localFetcher = vi.fn(async () => ({ access_token: "local" }));
    const egressFetcher = vi.fn(async () => ({ access_token: "pinned" }));
    const provider = new OAuthClientCredentialsProvider({
      ...config,
      fetchToken: localFetcher,
    });

    await expect(
      provider.resolveCredential({
        ...oauthContext,
        tokenEndpointFetch: egressFetcher,
      }),
    ).resolves.toMatchObject({ token: "pinned" });
    expect(localFetcher).not.toHaveBeenCalled();
    expect(egressFetcher).toHaveBeenCalledTimes(1);
  });
});

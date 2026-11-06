import { describe, expect, it } from "vitest";
import {
  RuntimeError,
  type ToolContext,
  type ToolDefinition,
} from "@chainmcp/core";
import { OperationScopeAuthorizer } from "../src/authorizer.js";
import {
  CompositeCredentialProvider,
  normalizeUpstreamCredential,
  StaticCredentialProvider,
} from "../src/credentials.js";
import {
  buildCredentialStoreKey,
  buildOAuthTokenStoreKey,
} from "../src/keys.js";
import {
  encodeSecretKeySegment,
  EncryptedSecretStore,
  InMemorySecretStore,
} from "../src/secret-store.js";

describe("Auth Package Additional Tests", () => {
  describe("OperationScopeAuthorizer", () => {
    const authorizer = new OperationScopeAuthorizer();

    function dummyTool(requiredScopes?: string[]): ToolDefinition {
      return {
        name: "testTool",
        description: "Test tool description",
        operation: {
          ...(requiredScopes ? { requiredScopes } : {}),
        },
        inputSchema: { type: "object" },
        execute: async () => ({}),
      };
    }

    it("allows execution when tool has no required scopes or empty required scopes", () => {
      const toolNoScopes = dummyTool();
      const toolEmptyScopes = dummyTool([]);
      const context: ToolContext = {
        tenantId: "tenant-1",
        requestId: "req-1",
        principal: { id: "user-1", scopes: [] },
      };

      expect(() => authorizer.authorize(toolNoScopes, context)).not.toThrow();
      expect(() =>
        authorizer.authorize(toolEmptyScopes, context),
      ).not.toThrow();
    });

    it("allows execution when principal has all required scopes", () => {
      const tool = dummyTool(["read:data", "write:data"]);
      const context: ToolContext = {
        tenantId: "tenant-1",
        requestId: "req-1",
        principal: {
          id: "user-1",
          scopes: ["read:data", "write:data", "extra:scope"],
        },
      };

      expect(() => authorizer.authorize(tool, context)).not.toThrow();
    });

    it("throws AUTH_FORBIDDEN when required scopes are missing", () => {
      const tool = dummyTool(["admin:write"]);
      const context: ToolContext = {
        tenantId: "tenant-1",
        requestId: "req-1",
        principal: {
          id: "user-1",
          scopes: ["read:only"],
        },
      };

      expect(() => authorizer.authorize(tool, context)).toThrowError(
        RuntimeError,
      );
      try {
        authorizer.authorize(tool, context);
      } catch (err) {
        expect((err as RuntimeError).code).toBe("AUTH_FORBIDDEN");
        expect((err as RuntimeError).message).toBe("Access denied");
      }
    });

    it("formats non-string entries in requiredScopes during error generation", () => {
      const tool = dummyTool([123 as unknown as string]);
      const context: ToolContext = {
        tenantId: "tenant-1",
        requestId: "req-1",
        principal: { id: "u1", scopes: [] },
      };

      try {
        authorizer.authorize(tool, context);
        expect.unreachable();
      } catch (err) {
        expect(
          ((err as RuntimeError).cause as Error | undefined)?.message,
        ).toContain("[not-a-string]");
      }
    });
  });

  describe("keys.ts - buildCredentialStoreKey and buildOAuthTokenStoreKey", () => {
    it("validates schemeName requirement", () => {
      expect(() =>
        buildCredentialStoreKey({} as { schemeName: string }),
      ).toThrow("buildCredentialStoreKey requires a schemeName");
    });

    it("hashes keys exceeding MAX_SECRET_KEY_LENGTH (256 characters)", () => {
      const longScheme = "x".repeat(300);
      const globalKey = buildCredentialStoreKey({ schemeName: longScheme });
      expect(globalKey).toMatch(/^cred:v1:global:h:[a-f0-9]{64}$/);

      const longTenant = "t".repeat(200);
      const tenantKey = buildCredentialStoreKey({
        tenantId: longTenant,
        schemeName: longScheme,
      });
      expect(tenantKey).toMatch(/^cred:v1:tenant:h:[a-f0-9]{64}$/);

      const oauthKey = buildOAuthTokenStoreKey({
        tenantId: longTenant,
        principalId: "p".repeat(200),
        schemeName: longScheme,
        normalizedScopes: "scope1 scope2 scope3",
      });
      expect(oauthKey).toMatch(/^oauth:token:v2:h:[a-f0-9]{64}$/);
    });

    it("produces standard readable keys for normal inputs", () => {
      const key = buildCredentialStoreKey({
        tenantId: "tenant-1",
        schemeName: "api_key",
      });
      expect(key).toContain("cred:v1:tenant:tenant:");
      expect(key.length).toBeLessThanOrEqual(256);
    });
  });

  describe("secret-store.ts - InMemorySecretStore and EncryptedSecretStore", () => {
    it("validates encodeSecretKeySegment inputs", () => {
      expect(() => encodeSecretKeySegment(123 as unknown as string)).toThrow(
        "Secret key segments must be strings",
      );
      expect(encodeSecretKeySegment("hello/world?#")).toBe(
        "aGVsbG8vd29ybGQ_Iw",
      );
    });

    it("verifies InMemorySecretStore clear, size, and key validation", async () => {
      const store = new InMemorySecretStore();
      expect(store.size).toBe(0);

      await store.set("key1", "val1");
      expect(store.size).toBe(1);
      expect(await store.get("key1")).toBe("val1");

      // Reserved and invalid keys throw
      await expect(store.get("__proto__")).rejects.toThrow(
        "Invalid secret key name",
      );
      await expect(store.set("bad key with spaces", "v")).rejects.toThrow(
        "Invalid secret key name",
      );
      await expect(store.set("key2", 123 as unknown as string)).rejects.toThrow(
        "Secret value must be a string",
      );
      await expect(store.delete("constructor")).rejects.toThrow(
        "Invalid secret key name",
      );

      store.clear();
      expect(store.size).toBe(0);
      expect(await store.get("key1")).toBeUndefined();
    });

    it("validates EncryptedSecretStore configuration constraints", () => {
      const store = new InMemorySecretStore();
      const validKeyHex = "a".repeat(64);

      expect(
        () =>
          new EncryptedSecretStore(
            null as unknown as {
              store: InMemorySecretStore;
              activeKeyId: string;
              keys: Record<string, string>;
            },
          ),
      ).toThrow("EncryptedSecretStore requires options");

      expect(
        () =>
          new EncryptedSecretStore({
            store: null as unknown as InMemorySecretStore,
            activeKeyId: "k1",
            keys: { k1: validKeyHex },
          }),
      ).toThrow("EncryptedSecretStore requires a valid underlying store");

      expect(
        () =>
          new EncryptedSecretStore({
            store,
            activeKeyId: "",
            keys: { k1: validKeyHex },
          }),
      ).toThrow("EncryptedSecretStore requires a non-empty activeKeyId");

      expect(
        () =>
          new EncryptedSecretStore({
            store,
            activeKeyId: "k1",
            keys: { k2: validKeyHex },
          }),
      ).toThrow("activeKeyId 'k1' not found in provided keys");

      // Key buffer validation
      expect(
        () =>
          new EncryptedSecretStore({
            store,
            activeKeyId: "k1",
            keys: { k1: Buffer.alloc(16) },
          }),
      ).toThrow("must be exactly 32 bytes");

      expect(
        () =>
          new EncryptedSecretStore({
            store,
            activeKeyId: "k1",
            keys: { k1: "invalid-key-string" },
          }),
      ).toThrow("must be a 64-character hex string or 32 UTF-8 bytes");

      expect(
        () =>
          new EncryptedSecretStore({
            store,
            activeKeyId: "k1",
            keys: { k1: 12345 as unknown as string },
          }),
      ).toThrow("must be a Buffer or string");
    });

    it("verifies EncryptedSecretStore size bounds, error handling, and rotation", async () => {
      const memStore = new InMemorySecretStore();
      const keyHex1 = "1".repeat(64);
      const keyHex2 = "2".repeat(64);

      const encStore = new EncryptedSecretStore({
        store: memStore,
        activeKeyId: "k1",
        keys: { k1: keyHex1, k2: keyHex2 },
      });

      // Reject secret value exceeding 1 MiB
      const largeSecret = "a".repeat(1024 * 1024 + 1);
      await expect(encStore.set("test_key", largeSecret)).rejects.toThrowError(
        RangeError,
      );

      // Successfully encrypt and decrypt
      await encStore.set("test_key", "secret_value");
      expect(await encStore.get("test_key")).toBe("secret_value");

      // Rotate non-existent key returns false
      expect(await encStore.rotate("non_existent")).toBe(false);

      // Rotate to invalid key ID throws
      await expect(
        encStore.rotate("test_key", "non_configured_key"),
      ).rejects.toThrow(
        "Target key ID 'non_configured_key' not found in key ring",
      );

      // Rotate to k2 successfully
      const rotated = await encStore.rotate("test_key", "k2");
      expect(rotated).toBe(true);
      expect(await encStore.get("test_key")).toBe("secret_value");

      // Underlying store returned non-string throws TypeError
      await memStore.set("corrupted_key", "not encrypted json format");
      await expect(encStore.get("corrupted_key")).rejects.toThrow();

      // Delete secret
      await encStore.delete("test_key");
      expect(await encStore.get("test_key")).toBeUndefined();
    });
  });

  describe("credentials.ts - normalizeUpstreamCredential and Provider edge cases", () => {
    it("validates various credential shapes in normalizeUpstreamCredential", () => {
      expect(normalizeUpstreamCredential(null)).toBeUndefined();
      expect(normalizeUpstreamCredential("string")).toBeUndefined();

      // apiKey validations
      expect(
        normalizeUpstreamCredential({
          type: "apiKey",
          name: "",
          location: "header",
          value: "v",
        }),
      ).toBeUndefined();
      expect(
        normalizeUpstreamCredential({
          type: "apiKey",
          name: "k",
          location: "body",
          value: "v",
        }),
      ).toBeUndefined();
      expect(
        normalizeUpstreamCredential({
          type: "apiKey",
          name: "k",
          location: "header",
          value: "",
        }),
      ).toBeUndefined();
      expect(
        normalizeUpstreamCredential({
          type: "apiKey",
          name: "k",
          location: "header",
          value: "v",
        }),
      ).toEqual({
        type: "apiKey",
        name: "k",
        location: "header",
        value: "v",
      });

      // http validations
      expect(
        normalizeUpstreamCredential({
          type: "http",
          scheme: "bearer",
          token: "",
        }),
      ).toBeUndefined();
      expect(
        normalizeUpstreamCredential({
          type: "http",
          scheme: "bearer",
          token: "tok123",
        }),
      ).toEqual({
        type: "http",
        scheme: "bearer",
        token: "tok123",
      });

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
          username: "u",
          password: 123,
        }),
      ).toBeUndefined();
      expect(
        normalizeUpstreamCredential({
          type: "http",
          scheme: "basic",
          username: "admin",
          password: "pwd",
        }),
      ).toEqual({
        type: "http",
        scheme: "basic",
        username: "admin",
        password: "pwd",
      });
      expect(
        normalizeUpstreamCredential({ type: "http", scheme: "digest" }),
      ).toBeUndefined();

      // oauth2 validations
      expect(
        normalizeUpstreamCredential({ type: "oauth2", token: "" }),
      ).toBeUndefined();
      expect(
        normalizeUpstreamCredential({
          type: "oauth2",
          token: "tok",
          tokenType: "",
        }),
      ).toBeUndefined();
      expect(
        normalizeUpstreamCredential({
          type: "oauth2",
          token: "tok",
          expiresAt: Number.NaN,
        }),
      ).toBeUndefined();
      expect(
        normalizeUpstreamCredential({
          type: "oauth2",
          token: "tok",
          scopes: ["read", 123],
        }),
      ).toBeUndefined();
      expect(
        normalizeUpstreamCredential({
          type: "oauth2",
          token: "tok",
          tokenType: "Bearer",
          expiresAt: 1234567890,
          scopes: ["read", "write"],
        }),
      ).toEqual({
        type: "oauth2",
        token: "tok",
        tokenType: "Bearer",
        expiresAt: 1234567890,
        scopes: ["read", "write"],
      });

      // Unknown type
      expect(normalizeUpstreamCredential({ type: "custom" })).toBeUndefined();
    });

    it("handles secret normalization across apiKey, basic, bearer, and oauth2 contexts", async () => {
      const provider = new StaticCredentialProvider({
        credentials: {
          apiKeyScheme: "secret_api_key_value",
          basicValidScheme: "myuser:mypassword",
          basicInvalidScheme: "nopasswordcolon",
          basicEmptyUserScheme: ":onlypassword",
          bearerScheme: "my_bearer_token",
          oauthScheme: "my_oauth_token",
          jsonCredentialScheme: JSON.stringify({
            token: "json_bearer_token",
            tokenType: "Bearer",
            expiresAt: 9999999999,
            scopes: ["api:access"],
          }),
          usernamePasswordObjectScheme: {
            username: "objuser",
            password: "objpassword",
          },
        },
      });

      // apiKey
      const resApiKey = await provider.resolveCredential({
        tenantId: "t1",
        toolName: "tool1",
        schemeName: "apiKeyScheme",
        schemeType: "apiKey",
        parameterName: "X-Custom-Key",
        parameterLocation: "header",
      });
      expect(resApiKey).toEqual({
        type: "apiKey",
        name: "X-Custom-Key",
        location: "header",
        value: "secret_api_key_value",
      });

      // basic valid
      const resBasicValid = await provider.resolveCredential({
        tenantId: "t1",
        toolName: "tool1",
        schemeName: "basicValidScheme",
        schemeType: "http",
        httpScheme: "basic",
      });
      expect(resBasicValid).toEqual({
        type: "http",
        scheme: "basic",
        username: "myuser",
        password: "mypassword",
      });

      // basic invalid without colon
      const resBasicInvalid = await provider.resolveCredential({
        tenantId: "t1",
        toolName: "tool1",
        schemeName: "basicInvalidScheme",
        schemeType: "http",
        httpScheme: "basic",
      });
      expect(resBasicInvalid).toBeUndefined();

      // basic starting with colon
      const resBasicEmptyUser = await provider.resolveCredential({
        tenantId: "t1",
        toolName: "tool1",
        schemeName: "basicEmptyUserScheme",
        schemeType: "http",
        httpScheme: "basic",
      });
      expect(resBasicEmptyUser).toBeUndefined();

      // bearer
      const resBearer = await provider.resolveCredential({
        tenantId: "t1",
        toolName: "tool1",
        schemeName: "bearerScheme",
        schemeType: "http",
        httpScheme: "bearer",
      });
      expect(resBearer).toEqual({
        type: "http",
        scheme: "bearer",
        token: "my_bearer_token",
      });

      // oauth2
      const resOauth = await provider.resolveCredential({
        tenantId: "t1",
        toolName: "tool1",
        schemeName: "oauthScheme",
        schemeType: "oauth2",
      });
      expect(resOauth).toEqual({
        type: "oauth2",
        token: "my_oauth_token",
      });

      // JSON credential object
      const resJson = await provider.resolveCredential({
        tenantId: "t1",
        toolName: "tool1",
        schemeName: "jsonCredentialScheme",
        schemeType: "oauth2",
      });
      expect(resJson).toEqual({
        type: "oauth2",
        token: "json_bearer_token",
        tokenType: "Bearer",
        expiresAt: 9999999999,
        scopes: ["api:access"],
      });

      // Object with username and password
      const resObj = await provider.resolveCredential({
        tenantId: "t1",
        toolName: "tool1",
        schemeName: "usernamePasswordObjectScheme",
        schemeType: "http",
        httpScheme: "basic",
      });
      expect(resObj).toEqual({
        type: "http",
        scheme: "basic",
        username: "objuser",
        password: "objpassword",
      });
    });

    it("verifies CompositeCredentialProvider validation and resolution cascade", async () => {
      expect(
        () => new CompositeCredentialProvider(null as unknown as []),
      ).toThrow("CompositeCredentialProvider requires an array of providers");

      const p1 = new StaticCredentialProvider({ credentials: {} });
      const p2 = new StaticCredentialProvider({
        credentials: { foundScheme: "token_from_p2" },
      });

      const composite = new CompositeCredentialProvider([p1, p2]);
      const resolved = await composite.resolveCredential({
        tenantId: "t1",
        toolName: "tool1",
        schemeName: "foundScheme",
        schemeType: "http",
        httpScheme: "bearer",
      });

      expect(resolved).toEqual({
        type: "http",
        scheme: "bearer",
        token: "token_from_p2",
      });

      const notFound = await composite.resolveCredential({
        tenantId: "t1",
        toolName: "tool1",
        schemeName: "missingScheme",
        schemeType: "http",
      });
      expect(notFound).toBeUndefined();
    });
  });
});

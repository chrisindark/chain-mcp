import { describe, expect, it } from "vitest";
import {
  createApiKeyVerifier,
  createBearerTokenVerifier,
  createCompositeVerifier,
  createJwtVerifier,
  type InboundPrincipalConfig,
} from "../src/index.js";

describe("Inbound Auth Verifier Prototype and Input Hardening (RM-01)", () => {
  describe("createBearerTokenVerifier", () => {
    const configuredVerifier = createBearerTokenVerifier({
      tokens: {
        "SecretToken-123": {
          tenantId: "tenant-acme",
          principalId: "user-alice",
          scopes: ["read:data", "write:data"],
        },
        "no-scopes-token": {
          tenantId: "tenant-solo",
          principalId: "user-bob",
        },
      },
    });

    it("rejects prototype-chain property names as tokens (constructor, __proto__, toString, valueOf, hasOwnProperty)", async () => {
      const prototypeKeys = [
        "constructor",
        "__proto__",
        "toString",
        "valueOf",
        "hasOwnProperty",
        "isPrototypeOf",
        "propertyIsEnumerable",
      ];

      for (const protoKey of prototypeKeys) {
        const result = await configuredVerifier.verify({
          headers: { authorization: `Bearer ${protoKey}` },
        });
        expect(
          result,
          `Bearer ${protoKey} should evaluate to undefined`,
        ).toBeUndefined();
      }
    });

    it("authenticates a valid configured bearer token with correct tenant, principal, and scopes", async () => {
      const result = await configuredVerifier.verify({
        headers: { authorization: "Bearer SecretToken-123" },
      });

      expect(result).toBeDefined();
      expect(result?.context.tenantId).toBe("tenant-acme");
      expect(result?.context.principal.id).toBe("user-alice");
      expect(result?.context.principal.scopes).toEqual([
        "read:data",
        "write:data",
      ]);
      expect(result?.authInfo?.token).toBe("SecretToken-123");
      expect(result?.authInfo?.clientId).toBe("user-alice");
      expect(result?.authInfo?.scopes).toEqual(["read:data", "write:data"]);
      expect(result?.authInfo?.extra).toEqual({
        tenantId: "tenant-acme",
        principalId: "user-alice",
      });
    });

    it("authenticates a valid token with scopes: undefined as scopes: []", async () => {
      const result = await configuredVerifier.verify({
        headers: { authorization: "Bearer no-scopes-token" },
      });

      expect(result).toBeDefined();
      expect(result?.context.tenantId).toBe("tenant-solo");
      expect(result?.context.principal.id).toBe("user-bob");
      expect(result?.context.principal.scopes).toEqual([]);
      expect(result?.authInfo?.scopes).toEqual([]);
    });

    it("enforces exact case sensitivity for bearer token lookup", async () => {
      const lowerResult = await configuredVerifier.verify({
        headers: { authorization: "Bearer secrettoken-123" },
      });
      expect(lowerResult).toBeUndefined();

      const exactResult = await configuredVerifier.verify({
        headers: { authorization: "Bearer SecretToken-123" },
      });
      expect(exactResult).toBeDefined();
    });

    it("rejects empty, whitespace-only, or non-bearer credentials", async () => {
      expect(
        await configuredVerifier.verify({
          headers: { authorization: "Bearer " },
        }),
      ).toBeUndefined();
      expect(
        await configuredVerifier.verify({
          headers: { authorization: "Bearer    " },
        }),
      ).toBeUndefined();
      expect(
        await configuredVerifier.verify({
          headers: { authorization: "Basic dXNlcjpwYXNz" },
        }),
      ).toBeUndefined();
      expect(
        await configuredVerifier.verify({
          headers: {},
        }),
      ).toBeUndefined();
    });

    it("rejects custom verifyToken callbacks returning invalid shapes", async () => {
      // Returning empty object
      const emptyVerifier = createBearerTokenVerifier({
        verifyToken: async () => ({}) as unknown as InboundPrincipalConfig,
      });
      expect(
        await emptyVerifier.verify({
          headers: { authorization: "Bearer any-token" },
        }),
      ).toBeUndefined();

      // Returning principalId without tenantId
      const noTenantVerifier = createBearerTokenVerifier({
        verifyToken: async () =>
          ({ principalId: "user-1" }) as unknown as InboundPrincipalConfig,
      });
      expect(
        await noTenantVerifier.verify({
          headers: { authorization: "Bearer any-token" },
        }),
      ).toBeUndefined();

      // Returning tenantId without principalId
      const noPrincipalVerifier = createBearerTokenVerifier({
        verifyToken: async () =>
          ({ tenantId: "tenant-1" }) as unknown as InboundPrincipalConfig,
      });
      expect(
        await noPrincipalVerifier.verify({
          headers: { authorization: "Bearer any-token" },
        }),
      ).toBeUndefined();

      // Returning empty string tenantId
      const emptyTenantVerifier = createBearerTokenVerifier({
        verifyToken: async () => ({ tenantId: "", principalId: "user-1" }),
      });
      expect(
        await emptyTenantVerifier.verify({
          headers: { authorization: "Bearer any-token" },
        }),
      ).toBeUndefined();

      // Returning whitespace-only principalId
      const wsPrincipalVerifier = createBearerTokenVerifier({
        verifyToken: async () => ({
          tenantId: "tenant-1",
          principalId: "   ",
        }),
      });
      expect(
        await wsPrincipalVerifier.verify({
          headers: { authorization: "Bearer any-token" },
        }),
      ).toBeUndefined();

      // Returning non-array or non-string scopes
      const badScopesVerifier = createBearerTokenVerifier({
        verifyToken: async () =>
          ({
            tenantId: "tenant-1",
            principalId: "user-1",
            scopes: ["read", 123 as unknown as string],
          }) as unknown as InboundPrincipalConfig,
      });
      expect(
        await badScopesVerifier.verify({
          headers: { authorization: "Bearer any-token" },
        }),
      ).toBeUndefined();
    });
  });

  describe("createApiKeyVerifier", () => {
    const configuredApiKeyVerifier = createApiKeyVerifier({
      headerName: "x-api-key",
      keys: {
        "Key-Secret-ABC": {
          tenantId: "tenant-key-org",
          principalId: "service-worker",
          scopes: ["admin"],
        },
        "no-scopes-key": {
          tenantId: "tenant-key-org",
          principalId: "readonly-worker",
        },
      },
    });

    it("rejects prototype-chain property names as API keys (constructor, __proto__, toString, etc.)", async () => {
      const prototypeKeys = [
        "constructor",
        "__proto__",
        "toString",
        "valueOf",
        "hasOwnProperty",
        "isPrototypeOf",
      ];

      for (const protoKey of prototypeKeys) {
        const result = await configuredApiKeyVerifier.verify({
          headers: { "x-api-key": protoKey },
        });
        expect(
          result,
          `x-api-key: ${protoKey} should evaluate to undefined`,
        ).toBeUndefined();
      }
    });

    it("authenticates a valid configured API key with correct tenant, principal, and scopes", async () => {
      const result = await configuredApiKeyVerifier.verify({
        headers: { "X-API-KEY": "Key-Secret-ABC" },
      });

      expect(result).toBeDefined();
      expect(result?.context.tenantId).toBe("tenant-key-org");
      expect(result?.context.principal.id).toBe("service-worker");
      expect(result?.context.principal.scopes).toEqual(["admin"]);
      expect(result?.authInfo?.token).toBe("Key-Secret-ABC");
    });

    it("authenticates a valid API key with scopes: undefined as scopes: []", async () => {
      const result = await configuredApiKeyVerifier.verify({
        headers: { "x-api-key": "no-scopes-key" },
      });

      expect(result).toBeDefined();
      expect(result?.context.tenantId).toBe("tenant-key-org");
      expect(result?.context.principal.id).toBe("readonly-worker");
      expect(result?.context.principal.scopes).toEqual([]);
      expect(result?.authInfo?.scopes).toEqual([]);
    });

    it("enforces exact case sensitivity for API key lookup", async () => {
      const lowerResult = await configuredApiKeyVerifier.verify({
        headers: { "x-api-key": "key-secret-abc" },
      });
      expect(lowerResult).toBeUndefined();

      const exactResult = await configuredApiKeyVerifier.verify({
        headers: { "x-api-key": "Key-Secret-ABC" },
      });
      expect(exactResult).toBeDefined();
    });

    it("supports custom API key header name with prototype resistance", async () => {
      const customVerifier = createApiKeyVerifier({
        headerName: "X-Tenant-Auth-Key",
        keys: {
          "custom-key-1": {
            tenantId: "t-custom",
            principalId: "p-custom",
          },
        },
      });

      expect(
        await customVerifier.verify({
          headers: { "x-tenant-auth-key": "constructor" },
        }),
      ).toBeUndefined();
      expect(
        await customVerifier.verify({
          headers: { "X-Tenant-Auth-Key": "__proto__" },
        }),
      ).toBeUndefined();

      const validResult = await customVerifier.verify({
        headers: { "x-tenant-auth-key": "custom-key-1" },
      });
      expect(validResult).toBeDefined();
      expect(validResult?.context.tenantId).toBe("t-custom");
      expect(validResult?.context.principal.id).toBe("p-custom");
    });

    it("rejects empty, whitespace-only, or missing API key values", async () => {
      expect(
        await configuredApiKeyVerifier.verify({
          headers: { "x-api-key": "" },
        }),
      ).toBeUndefined();
      expect(
        await configuredApiKeyVerifier.verify({
          headers: { "x-api-key": "   " },
        }),
      ).toBeUndefined();
      expect(
        await configuredApiKeyVerifier.verify({
          headers: {},
        }),
      ).toBeUndefined();
    });

    it("rejects custom verifyKey callbacks returning invalid shapes", async () => {
      const emptyVerifier = createApiKeyVerifier({
        verifyKey: async () => ({}) as unknown as InboundPrincipalConfig,
      });
      expect(
        await emptyVerifier.verify({
          headers: { "x-api-key": "any-key" },
        }),
      ).toBeUndefined();

      const noTenantVerifier = createApiKeyVerifier({
        verifyKey: async () =>
          ({ principalId: "user-1" }) as unknown as InboundPrincipalConfig,
      });
      expect(
        await noTenantVerifier.verify({
          headers: { "x-api-key": "any-key" },
        }),
      ).toBeUndefined();

      const emptyTenantVerifier = createApiKeyVerifier({
        verifyKey: async () => ({ tenantId: "", principalId: "user-1" }),
      });
      expect(
        await emptyTenantVerifier.verify({
          headers: { "x-api-key": "any-key" },
        }),
      ).toBeUndefined();
    });
  });

  describe("createJwtVerifier with mapClaims", () => {
    it("rejects custom mapClaims returning malformed principals", async () => {
      const verifier = createJwtVerifier({
        secret: "test-secret-at-least-32-chars-long!",
        mapClaims: async () => ({}) as unknown as InboundPrincipalConfig,
      });

      // Construct a valid signed JWT
      const header = Buffer.from(
        JSON.stringify({ alg: "HS256", typ: "JWT" }),
      ).toString("base64url");
      const payload = Buffer.from(
        JSON.stringify({
          sub: "user-123",
          exp: Math.floor(Date.now() / 1000) + 3600,
        }),
      ).toString("base64url");
      const { createHmac } = await import("node:crypto");
      const sig = createHmac("sha256", "test-secret-at-least-32-chars-long!")
        .update(`${header}.${payload}`)
        .digest("base64url");
      const jwt = `${header}.${payload}.${sig}`;

      const result = await verifier.verify({
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(result).toBeUndefined();
    });
  });

  describe("Verifier headerNames exposure (RM-04)", () => {
    it("exposes expected headerNames for all verifiers and deduplicates in composite", () => {
      const bearer = createBearerTokenVerifier({ tokens: {} });
      expect(bearer.headerNames).toEqual(["Authorization"]);

      const defaultApiKey = createApiKeyVerifier({ keys: {} });
      expect(defaultApiKey.headerNames).toEqual(["X-API-Key"]);

      const customApiKey = createApiKeyVerifier({
        headerName: "X-Tenant-Key",
        keys: {},
      });
      expect(customApiKey.headerNames).toEqual(["X-Tenant-Key"]);

      const jwt = createJwtVerifier({
        secret: "test-secret-at-least-32-chars-long!",
      });
      expect(jwt.headerNames).toEqual(["Authorization"]);

      const composite = createCompositeVerifier([bearer, customApiKey, jwt]);
      // Case-insensitively deduplicated: "Authorization" only appears once
      expect(composite.headerNames).toEqual(["Authorization", "X-Tenant-Key"]);
    });
  });
});

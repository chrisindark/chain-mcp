import { describe, expect, it } from "vitest";
import type {
  CompileDiagnostic,
  CompiledSecurityScheme,
} from "../src/types.js";
import {
  buildAuthenticationPolicy,
  parseSecurityRequirements,
  parseSecuritySchemes,
} from "../src/security.js";

describe("Compiler Security Processing (security.ts)", () => {
  describe("parseSecuritySchemes", () => {
    it("returns empty object when components is missing or not a plain object", () => {
      const diag1: CompileDiagnostic[] = [];
      const res1 = parseSecuritySchemes({}, "3.0", diag1);
      expect(res1).toEqual({});
      expect(diag1).toHaveLength(0);

      const diag2: CompileDiagnostic[] = [];
      const res2 = parseSecuritySchemes(
        { components: "invalid" },
        "3.0",
        diag2,
      );
      expect(res2).toEqual({});
      expect(diag2).toHaveLength(1);
      expect(diag2[0]?.code).toBe("DOCUMENT_INVALID");
      expect(diag2[0]?.message).toContain("must be an object");
    });

    it("returns empty object when components.securitySchemes is missing or not a plain object", () => {
      const diag1: CompileDiagnostic[] = [];
      const res1 = parseSecuritySchemes({ components: {} }, "3.0", diag1);
      expect(res1).toEqual({});
      expect(diag1).toHaveLength(0);

      const diag2: CompileDiagnostic[] = [];
      const res2 = parseSecuritySchemes(
        { components: { securitySchemes: ["not an object"] } },
        "3.0",
        diag2,
      );
      expect(res2).toEqual({});
      expect(diag2).toHaveLength(1);
      expect(diag2[0]?.code).toBe("DOCUMENT_INVALID");
    });

    it("rejects empty scheme names and non-object schemes", () => {
      const diag: CompileDiagnostic[] = [];
      const res = parseSecuritySchemes(
        {
          components: {
            securitySchemes: {
              "   ": { type: "apiKey", name: "key", in: "header" },
              invalidRaw: "not an object",
            },
          },
        },
        "3.0",
        diag,
      );
      expect(res).toEqual({});
      expect(diag).toHaveLength(2);
      expect(diag[0]?.code).toBe("SECURITY_SCHEME_INVALID");
      expect(diag[0]?.message).toContain("must be non-empty");
      expect(diag[1]?.code).toBe("SECURITY_SCHEME_INVALID");
      expect(diag[1]?.message).toContain("must be an object");
    });

    it("validates scheme types across OpenAPI 3.0 vs 3.1", () => {
      const diag30: CompileDiagnostic[] = [];
      parseSecuritySchemes(
        {
          components: {
            securitySchemes: {
              mtls: { type: "mutualTLS" },
              unknown: { type: "custom" },
              numeric: { type: 123 },
            },
          },
        },
        "3.0",
        diag30,
      );
      expect(diag30).toHaveLength(3);
      expect(diag30[0]?.message).toContain(
        "unsupported type 'mutualTLS' for OpenAPI 3.0",
      );
      expect(diag30[1]?.message).toContain(
        "unsupported type 'custom' for OpenAPI 3.0",
      );
      expect(diag30[2]?.message).toContain(
        "unsupported type '123' for OpenAPI 3.0",
      );

      const diag31: CompileDiagnostic[] = [];
      const res31 = parseSecuritySchemes(
        {
          components: {
            securitySchemes: {
              mtls: { type: "mutualTLS" },
            },
          },
        },
        "3.1",
        diag31,
        { strict: false },
      );
      expect(res31.mtls).toBeDefined();
      expect(diag31).toHaveLength(1);
      expect(diag31[0]?.severity).toBe("warning");
      expect(diag31[0]?.code).toBe("UNSUPPORTED_SECURITY_SCHEME");
    });

    it("validates scheme description type", () => {
      const diag: CompileDiagnostic[] = [];
      const res = parseSecuritySchemes(
        {
          components: {
            securitySchemes: {
              badDesc: {
                type: "apiKey",
                name: "api_key",
                in: "header",
                description: 42,
              },
              goodDesc: {
                type: "apiKey",
                name: "api_key2",
                in: "query",
                description: "Valid description",
              },
            },
          },
        },
        "3.0",
        diag,
      );
      expect(diag).toHaveLength(1);
      expect(diag[0]?.message).toContain("description must be a string");
      expect(res.goodDesc?.description).toBe("Valid description");
    });

    it("validates apiKey schemes (name and in locations)", () => {
      const diag: CompileDiagnostic[] = [];
      const res = parseSecuritySchemes(
        {
          components: {
            securitySchemes: {
              missingName: { type: "apiKey", name: "", in: "header" },
              invalidIn: { type: "apiKey", name: "token", in: "body" },
              validHeader: { type: "apiKey", name: "X-API-Key", in: "header" },
              validQuery: { type: "apiKey", name: "api_token", in: "query" },
              validCookie: { type: "apiKey", name: "session_id", in: "cookie" },
            },
          },
        },
        "3.0",
        diag,
      );
      expect(diag).toHaveLength(2);
      expect(diag[0]?.message).toContain("requires a non-empty name");
      expect(diag[1]?.message).toContain(
        "requires 'in' to be query, header, or cookie",
      );
      expect(res.validHeader).toEqual({
        name: "validHeader",
        type: "apiKey",
        parameterName: "X-API-Key",
        parameterLocation: "header",
      });
      expect(res.validQuery?.parameterLocation).toBe("query");
      expect(res.validCookie?.parameterLocation).toBe("cookie");
    });

    it("validates http schemes (scheme and bearerFormat)", () => {
      const diag: CompileDiagnostic[] = [];
      const res = parseSecuritySchemes(
        {
          components: {
            securitySchemes: {
              emptyScheme: { type: "http", scheme: "" },
              invalidBearerFormat: {
                type: "http",
                scheme: "bearer",
                bearerFormat: 123,
              },
              validBearer: {
                type: "http",
                scheme: "bearer",
                bearerFormat: "JWT",
              },
              validBasic: { type: "http", scheme: "basic" },
            },
          },
        },
        "3.0",
        diag,
      );
      expect(diag).toHaveLength(2);
      expect(diag[0]?.message).toContain("requires a non-empty scheme");
      expect(diag[1]?.message).toContain("bearerFormat must be a string");
      expect(res.validBearer).toEqual({
        name: "validBearer",
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
      });
      expect(res.validBasic).toEqual({
        name: "validBasic",
        type: "http",
        scheme: "basic",
      });
    });

    it("validates oauth2 schemes (flows and scopes)", () => {
      const diag: CompileDiagnostic[] = [];
      const res = parseSecuritySchemes(
        {
          components: {
            securitySchemes: {
              emptyFlows: { type: "oauth2", flows: {} },
              invalidFlowItem: {
                type: "oauth2",
                flows: { clientCredentials: "invalid" },
              },
              invalidScopes: {
                type: "oauth2",
                flows: {
                  clientCredentials: {
                    tokenUrl: "https://auth.example.com",
                    scopes: null,
                  },
                },
              },
              validOauth2: {
                type: "oauth2",
                flows: {
                  clientCredentials: {
                    tokenUrl: "https://auth.example.com/token",
                    scopes: {
                      "read:users": "Read users",
                      "write:users": "Write users",
                    },
                  },
                },
              },
            },
          },
        },
        "3.0",
        diag,
      );
      expect(diag.length).toBeGreaterThanOrEqual(3);
      expect(diag[0]?.message).toContain("requires a non-empty flows object");
      expect(diag[1]?.message).toContain("requires a scopes object");
      expect(res.validOauth2?.flows).toBeDefined();
    });

    it("validates openIdConnect schemes (openIdConnectUrl and strict vs non-strict)", () => {
      const diag1: CompileDiagnostic[] = [];
      parseSecuritySchemes(
        {
          components: {
            securitySchemes: {
              badUrl: { type: "openIdConnect", openIdConnectUrl: "  " },
            },
          },
        },
        "3.0",
        diag1,
      );
      expect(diag1).toHaveLength(1);
      expect(diag1[0]?.message).toContain(
        "requires a non-empty openIdConnectUrl",
      );

      const diagStrict: CompileDiagnostic[] = [];
      const resStrict = parseSecuritySchemes(
        {
          components: {
            securitySchemes: {
              oidc: {
                type: "openIdConnect",
                openIdConnectUrl:
                  "https://oidc.example.com/.well-known/openid-configuration",
              },
            },
          },
        },
        "3.0",
        diagStrict,
        { strict: true },
      );
      expect(resStrict.oidc).toBeDefined();
      expect(diagStrict).toHaveLength(1);
      expect(diagStrict[0]?.severity).toBe("error");
      expect(diagStrict[0]?.code).toBe("UNSUPPORTED_SECURITY_SCHEME");

      const diagNonStrict: CompileDiagnostic[] = [];
      const resNonStrict = parseSecuritySchemes(
        {
          components: {
            securitySchemes: {
              oidc: {
                type: "openIdConnect",
                openIdConnectUrl:
                  "https://oidc.example.com/.well-known/openid-configuration",
              },
            },
          },
        },
        "3.0",
        diagNonStrict,
        { strict: false },
      );
      expect(resNonStrict.oidc).toBeDefined();
      expect(diagNonStrict).toHaveLength(1);
      expect(diagNonStrict[0]?.severity).toBe("warning");
      expect(diagNonStrict[0]?.code).toBe("UNSUPPORTED_SECURITY_SCHEME");
    });
  });

  describe("parseSecurityRequirements", () => {
    const schemes: Record<string, CompiledSecurityScheme> = {
      apiKeyAuth: {
        name: "apiKeyAuth",
        type: "apiKey",
        parameterName: "X-Key",
        parameterLocation: "header",
      },
      bearerAuth: {
        name: "bearerAuth",
        type: "http",
        scheme: "bearer",
      },
      oauth2Auth: {
        name: "oauth2Auth",
        type: "oauth2",
        flows: {
          clientCredentials: {
            scopes: { read: "Read access", write: "Write access" },
          },
        },
      },
    };

    it("rejects non-array requirements", () => {
      const diag: CompileDiagnostic[] = [];
      const res = parseSecurityRequirements(
        "not an array",
        schemes,
        diag,
        "#/security",
      );
      expect(res).toBeUndefined();
      expect(diag).toHaveLength(1);
      expect(diag[0]?.code).toBe("SECURITY_INVALID");
      expect(diag[0]?.message).toContain("must be an array");
    });

    it("rejects non-object requirement entries", () => {
      const diag: CompileDiagnostic[] = [];
      const res = parseSecurityRequirements(
        ["invalid item"],
        schemes,
        diag,
        "#/security",
      );
      expect(res).toBeUndefined();
      expect(diag).toHaveLength(1);
      expect(diag[0]?.code).toBe("SECURITY_INVALID");
      expect(diag[0]?.message).toContain("must be an object");
    });

    it("rejects requirements referencing unknown schemes", () => {
      const diag: CompileDiagnostic[] = [];
      const res = parseSecurityRequirements(
        [{ unknownScheme: [] }],
        schemes,
        diag,
        "#/security",
      );
      expect(res).toBeUndefined();
      expect(diag).toHaveLength(1);
      expect(diag[0]?.code).toBe("SECURITY_INVALID");
      expect(diag[0]?.message).toContain(
        "references unknown scheme 'unknownScheme'",
      );
    });

    it("rejects non-string array scopes", () => {
      const diag1: CompileDiagnostic[] = [];
      const res1 = parseSecurityRequirements(
        [{ oauth2Auth: "read" }],
        schemes,
        diag1,
        "#/security",
      );
      expect(res1).toBeUndefined();
      expect(diag1).toHaveLength(1);
      expect(diag1[0]?.message).toContain("must be an array of strings");

      const diag2: CompileDiagnostic[] = [];
      const res2 = parseSecurityRequirements(
        [{ oauth2Auth: [123] }],
        schemes,
        diag2,
        "#/security",
      );
      expect(res2).toBeUndefined();
      expect(diag2).toHaveLength(1);
      expect(diag2[0]?.message).toContain("must be an array of strings");
    });

    it("parses valid security requirements successfully", () => {
      const diag: CompileDiagnostic[] = [];
      const res = parseSecurityRequirements(
        [
          { apiKeyAuth: [] },
          { oauth2Auth: ["read", "write"] },
          {}, // anonymous alternative
        ],
        schemes,
        diag,
        "#/security",
      );
      expect(diag).toHaveLength(0);
      expect(res).toHaveLength(3);
      expect(res?.[0]).toEqual({ apiKeyAuth: [] });
      expect(res?.[1]).toEqual({ oauth2Auth: ["read", "write"] });
      expect(res?.[2]).toEqual({});
      expect(Object.isFrozen(res)).toBe(true);
      expect(Object.isFrozen(res?.[0])).toBe(true);
    });
  });

  describe("buildAuthenticationPolicy", () => {
    const schemes: Record<string, CompiledSecurityScheme> = {
      apiKeyAuth: {
        name: "apiKeyAuth",
        type: "apiKey",
        parameterName: "X-Key",
        parameterLocation: "header",
      },
      httpBearer: {
        name: "httpBearer",
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
      },
      oauth2Auth: {
        name: "oauth2Auth",
        type: "oauth2",
        flows: {
          clientCredentials: {
            scopes: { "read:data": "Read", "write:data": "Write" },
          },
        },
      },
      oidcAuth: {
        name: "oidcAuth",
        type: "openIdConnect",
        openIdConnectUrl: "https://auth.example.com",
      },
    };

    it("handles anonymous access when requirements are empty or include empty alternative", () => {
      const diag1: CompileDiagnostic[] = [];
      const policy1 = buildAuthenticationPolicy(
        [],
        schemes,
        true,
        diag1,
        "#/security",
      );
      expect(policy1?.allowsAnonymous).toBe(true);
      expect(policy1?.alternatives).toHaveLength(0);

      const diag2: CompileDiagnostic[] = [];
      const policy2 = buildAuthenticationPolicy(
        [{ apiKeyAuth: [] }, {}],
        schemes,
        true,
        diag2,
        "#/security",
      );
      expect(policy2?.allowsAnonymous).toBe(true);
      expect(policy2?.alternatives).toHaveLength(2);
      expect(policy2?.alternatives[1]?.schemes).toHaveLength(0);
    });

    it("rejects scopes on non-oauth2/non-openIdConnect schemes", () => {
      const diag: CompileDiagnostic[] = [];
      const policy = buildAuthenticationPolicy(
        [{ apiKeyAuth: ["admin"] }],
        schemes,
        true,
        diag,
        "#/security",
      );
      expect(policy).toBeUndefined();
      expect(diag).toHaveLength(1);
      expect(diag[0]?.code).toBe("SECURITY_REQUIREMENT_INVALID");
      expect(diag[0]?.message).toContain("must not declare scopes");
    });

    it("handles undeclared scopes in strict vs non-strict mode", () => {
      const diagStrict: CompileDiagnostic[] = [];
      const policyStrict = buildAuthenticationPolicy(
        [{ oauth2Auth: ["read:data", "undeclared:scope"] }],
        schemes,
        true,
        diagStrict,
        "#/security",
      );
      expect(policyStrict).toBeUndefined();
      expect(diagStrict).toHaveLength(1);
      expect(diagStrict[0]?.severity).toBe("error");
      expect(diagStrict[0]?.message).toContain(
        "uses undeclared scopes: undeclared:scope",
      );

      const diagNonStrict: CompileDiagnostic[] = [];
      const policyNonStrict = buildAuthenticationPolicy(
        [{ oauth2Auth: ["read:data", "undeclared:scope"] }],
        schemes,
        false,
        diagNonStrict,
        "#/security",
      );
      expect(policyNonStrict).toBeDefined();
      expect(diagNonStrict).toHaveLength(1);
      expect(diagNonStrict[0]?.severity).toBe("warning");
      expect(policyNonStrict?.alternatives[0]?.schemes[0]?.scopes).toEqual([
        "read:data",
        "undeclared:scope",
      ]);
    });

    it("sorts scheme names and deduplicates scopes deterministically", () => {
      const diag: CompileDiagnostic[] = [];
      const policy = buildAuthenticationPolicy(
        [
          {
            oauth2Auth: ["write:data", "read:data", "read:data"],
            apiKeyAuth: [],
            httpBearer: [],
          },
        ],
        schemes,
        true,
        diag,
        "#/security",
      );
      expect(diag).toHaveLength(0);
      expect(policy).toBeDefined();
      const alt = policy?.alternatives[0];
      expect(alt?.schemes.map((s) => s.name)).toEqual([
        "apiKeyAuth",
        "httpBearer",
        "oauth2Auth",
      ]);
      const oauth = alt?.schemes.find((s) => s.name === "oauth2Auth");
      expect(oauth?.scopes).toEqual(["read:data", "write:data"]);
      const bearer = alt?.schemes.find((s) => s.name === "httpBearer");
      expect(bearer?.httpScheme).toBe("bearer");
      expect(bearer?.bearerFormat).toBe("JWT");
      const apiKey = alt?.schemes.find((s) => s.name === "apiKeyAuth");
      expect(apiKey?.parameterName).toBe("X-Key");
      expect(apiKey?.parameterLocation).toBe("header");
    });

    it("handles openIdConnect schemes with scopes", () => {
      const diag: CompileDiagnostic[] = [];
      const policy = buildAuthenticationPolicy(
        [{ oidcAuth: ["openid", "profile"] }],
        schemes,
        true,
        diag,
        "#/security",
      );
      expect(diag).toHaveLength(0);
      expect(policy).toBeDefined();
      expect(policy?.alternatives[0]?.schemes[0]?.openIdConnectUrl).toBe(
        "https://auth.example.com",
      );
      expect(policy?.alternatives[0]?.schemes[0]?.scopes).toEqual([
        "openid",
        "profile",
      ]);
    });

    it("rejects unknown schemes defensively if passed directly to buildAuthenticationPolicy", () => {
      const diag: CompileDiagnostic[] = [];
      const policy = buildAuthenticationPolicy(
        [{ nonexistent: [] }],
        schemes,
        true,
        diag,
        "#/security",
      );
      expect(policy).toBeUndefined();
      expect(diag).toHaveLength(1);
      expect(diag[0]?.code).toBe("SECURITY_INVALID");
    });
  });
});

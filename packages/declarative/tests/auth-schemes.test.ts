import { describe, expect, it } from "vitest";

import {
  DeclarativeDescriptorError,
  normalizeAuthSchemeMap,
} from "../src/index.js";

describe("normalizeAuthSchemeMap", () => {
  it("returns an empty frozen object when input is undefined", () => {
    const map = normalizeAuthSchemeMap(undefined);
    expect(map).toEqual({});
    expect(Object.isFrozen(map)).toBe(true);
  });

  it("rejects non-object inputs", () => {
    const invalidInputs = [null, "invalid", 123, true, [1, 2, 3]];
    for (const input of invalidInputs) {
      expect(() => normalizeAuthSchemeMap(input)).toThrow(
        DeclarativeDescriptorError,
      );
      try {
        normalizeAuthSchemeMap(input);
      } catch (err) {
        expect((err as DeclarativeDescriptorError).code).toBe(
          "AUTH_SCHEME_INVALID",
        );
        expect((err as DeclarativeDescriptorError).message).toContain(
          "Auth scheme map must be a plain object",
        );
      }
    }
  });

  it("rejects invalid scheme names and reserved keys", () => {
    const invalidNames = [
      "has space",
      "special@char",
      "scheme!",
      "a".repeat(65),
      "prototype",
      "constructor",
    ];
    for (const name of invalidNames) {
      const obj = { [name]: { type: "oauth2" } };
      expect(() => normalizeAuthSchemeMap(obj)).toThrow(
        DeclarativeDescriptorError,
      );
      try {
        normalizeAuthSchemeMap(obj);
      } catch (err) {
        expect((err as DeclarativeDescriptorError).code).toBe(
          "AUTH_SCHEME_INVALID",
        );
        expect((err as DeclarativeDescriptorError).message).toContain(
          `Auth scheme name '${name}' is invalid`,
        );
      }
    }
  });

  it("rejects non-object scheme definitions", () => {
    const invalidValues = [null, 42, "apiKey", [1, 2]];
    for (const val of invalidValues) {
      expect(() => normalizeAuthSchemeMap({ myScheme: val })).toThrow(
        DeclarativeDescriptorError,
      );
      try {
        normalizeAuthSchemeMap({ myScheme: val });
      } catch (err) {
        expect((err as DeclarativeDescriptorError).code).toBe(
          "AUTH_SCHEME_INVALID",
        );
        expect((err as DeclarativeDescriptorError).message).toContain(
          "Auth scheme 'myScheme' must be an object",
        );
      }
    }
  });

  describe("apiKey scheme", () => {
    it("rejects unknown properties on apiKey schemes", () => {
      expect(() =>
        normalizeAuthSchemeMap({
          api_key: {
            type: "apiKey",
            parameterName: "x-api-key",
            parameterLocation: "header",
            extraProp: true,
          },
        }),
      ).toThrow("Auth scheme 'api_key' contains unknown property 'extraProp'");
    });

    it("rejects invalid parameterLocation values", () => {
      expect(() =>
        normalizeAuthSchemeMap({
          api_key: {
            type: "apiKey",
            parameterName: "key",
            parameterLocation: "body",
          },
        }),
      ).toThrow(
        "apiKey schemes require parameterLocation 'query', 'header', or 'cookie'",
      );
    });

    it("rejects non-string parameterName", () => {
      expect(() =>
        normalizeAuthSchemeMap({
          api_key: {
            type: "apiKey",
            parameterName: 12345,
            parameterLocation: "header",
          },
        }),
      ).toThrow("apiKey schemes require a parameterName");
    });

    it("validates header parameter names", () => {
      const res = normalizeAuthSchemeMap({
        api_key: {
          type: "apiKey",
          parameterName: "X-Api-Key",
          parameterLocation: "header",
        },
      });
      expect(res.api_key).toEqual({
        type: "apiKey",
        parameterName: "X-Api-Key",
        parameterLocation: "header",
      });

      const invalidHeaders = ["X Api Key", "X:Api:Key", "X@Key", "constructor"];
      for (const hdr of invalidHeaders) {
        expect(() =>
          normalizeAuthSchemeMap({
            api_key: {
              type: "apiKey",
              parameterName: hdr,
              parameterLocation: "header",
            },
          }),
        ).toThrow("apiKey parameterName is not a valid header");
      }
    });

    it("validates query and cookie parameter names", () => {
      const validMap = normalizeAuthSchemeMap({
        q_auth: {
          type: "apiKey",
          parameterName: "token_id",
          parameterLocation: "query",
        },
        c_auth: {
          type: "apiKey",
          parameterName: "session-cookie",
          parameterLocation: "cookie",
        },
      });
      expect(validMap.q_auth).toEqual({
        type: "apiKey",
        parameterName: "token_id",
        parameterLocation: "query",
      });
      expect(validMap.c_auth).toEqual({
        type: "apiKey",
        parameterName: "session-cookie",
        parameterLocation: "cookie",
      });

      const invalidNames = [
        "",
        "x".repeat(65),
        "constructor",
        "key&val",
        "key=val",
        "key;val",
        "key,val",
        "key#val",
        "key?val",
        "key/val",
        "key\x00name",
        "key\x1fname",
        "key\x7fname",
      ];

      for (const name of invalidNames) {
        expect(() =>
          normalizeAuthSchemeMap({
            q_auth: {
              type: "apiKey",
              parameterName: name,
              parameterLocation: "query",
            },
          }),
        ).toThrow("apiKey parameterName is not a valid query name");

        expect(() =>
          normalizeAuthSchemeMap({
            c_auth: {
              type: "apiKey",
              parameterName: name,
              parameterLocation: "cookie",
            },
          }),
        ).toThrow("apiKey parameterName is not a valid cookie name");
      }
    });
  });

  describe("http scheme", () => {
    it("rejects unknown properties on http schemes", () => {
      expect(() =>
        normalizeAuthSchemeMap({
          my_http: {
            type: "http",
            httpScheme: "bearer",
            extra: "invalid",
          },
        }),
      ).toThrow("Auth scheme 'my_http' contains unknown property 'extra'");
    });

    it("rejects invalid httpScheme", () => {
      expect(() =>
        normalizeAuthSchemeMap({
          my_http: {
            type: "http",
            httpScheme: "digest",
          },
        }),
      ).toThrow("http schemes require httpScheme 'basic' or 'bearer'");
    });

    it("normalizes basic http scheme", () => {
      const res = normalizeAuthSchemeMap({
        my_basic: {
          type: "http",
          httpScheme: "basic",
        },
      });
      expect(res.my_basic).toEqual({
        type: "http",
        httpScheme: "basic",
      });
    });

    it("normalizes bearer http scheme with and without bearerFormat", () => {
      const res = normalizeAuthSchemeMap({
        b1: {
          type: "http",
          httpScheme: "bearer",
        },
        b2: {
          type: "http",
          httpScheme: "bearer",
          bearerFormat: "JWT",
        },
      });
      expect(res.b1).toEqual({
        type: "http",
        httpScheme: "bearer",
      });
      expect(res.b2).toEqual({
        type: "http",
        httpScheme: "bearer",
        bearerFormat: "JWT",
      });
    });

    it("rejects invalid bearerFormat", () => {
      const invalidFormats = [123, "", "   ", "x".repeat(65)];
      for (const fmt of invalidFormats) {
        expect(() =>
          normalizeAuthSchemeMap({
            b: {
              type: "http",
              httpScheme: "bearer",
              bearerFormat: fmt,
            },
          }),
        ).toThrow("bearerFormat must be a short non-empty string");
      }
    });

    it("rejects bearerFormat on non-bearer httpScheme", () => {
      expect(() =>
        normalizeAuthSchemeMap({
          b: {
            type: "http",
            httpScheme: "basic",
            bearerFormat: "JWT",
          },
        }),
      ).toThrow("bearerFormat applies only to bearer schemes");
    });
  });

  describe("oauth2 scheme", () => {
    it("normalizes valid oauth2 scheme", () => {
      const res = normalizeAuthSchemeMap({
        my_oauth: {
          type: "oauth2",
        },
      });
      expect(res.my_oauth).toEqual({
        type: "oauth2",
      });
    });

    it("rejects unknown properties on oauth2 scheme", () => {
      expect(() =>
        normalizeAuthSchemeMap({
          my_oauth: {
            type: "oauth2",
            flows: {},
          },
        }),
      ).toThrow("Auth scheme 'my_oauth' contains unknown property 'flows'");
    });
  });

  describe("unsupported scheme types", () => {
    it("rejects unknown scheme types", () => {
      expect(() =>
        normalizeAuthSchemeMap({
          open_id: {
            type: "openIdConnect",
          },
        }),
      ).toThrow("type must be 'apiKey', 'http', or 'oauth2'");
    });
  });
});

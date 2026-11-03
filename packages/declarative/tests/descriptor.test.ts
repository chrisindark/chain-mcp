import { describe, expect, it } from "vitest";

import {
  DeclarativeDescriptorError,
  MAX_DESCRIPTOR_BYTES,
  parseDeclarativeToolDescriptor,
  parseDeclarativeToolDescriptorJson,
  type DeclarativeToolDescriptor,
} from "../src/index.js";

function baseDescriptor(
  overrides: Partial<DeclarativeToolDescriptor> = {},
): DeclarativeToolDescriptor {
  return {
    descriptorVersion: 1,
    name: "get_user",
    description: "Fetches one user",
    request: {
      method: "GET",
      path: "/users/{userId}",
      parameters: [
        { name: "userId", in: "path", required: true },
        { name: "limit", in: "query" },
      ],
    },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["userId"],
      properties: {
        userId: { type: "string", minLength: 1 },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
    },
    ...overrides,
  };
}

function expectCode(
  fn: () => unknown,
  code: DeclarativeDescriptorError["code"],
): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(DeclarativeDescriptorError);
    expect((error as DeclarativeDescriptorError).code).toBe(code);
    return;
  }
  throw new Error(`Expected ${code}, but the call succeeded`);
}

describe("parseDeclarativeToolDescriptor", () => {
  it("lowers a GET descriptor into deterministic executor metadata", () => {
    const parsed = parseDeclarativeToolDescriptor(baseDescriptor());

    expect(parsed.operation.name).toBe("get_user");
    expect(parsed.operation.method).toBe("get");
    expect(parsed.operation.path).toBe("/users/{userId}");
    expect(parsed.operation.readOnly).toBe(true);
    expect(parsed.operation.responses).toEqual([]);
    expect(parsed.operation.sourceLocation).toBe("declarative:get_user");
    expect(parsed.operation.parameters).toEqual([
      { name: "limit", in: "query", required: false },
      { name: "userId", in: "path", required: true },
    ]);
    expect(parsed.operation.requestBody).toBeUndefined();
    expect(parsed.revision).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(parsed.descriptor.request.parameters).toEqual([
      { name: "userId", in: "path", required: true },
      { name: "limit", in: "query", required: false },
    ]);
  });

  it("derives one revision from key order and omitted defaults", () => {
    const first = baseDescriptor();
    const secondRaw = {
      inputSchema: {
        properties: {
          limit: { maximum: 100, minimum: 1, type: "integer" },
          userId: { minLength: 1, type: "string" },
        },
        required: ["userId"],
        additionalProperties: false,
        type: "object",
      },
      request: {
        parameters: [
          { required: true, in: "path", name: "userId" },
          { in: "query", name: "limit", required: false },
        ],
        path: "/users/{userId}",
        method: "get",
      },
      description: "Fetches one user",
      name: "get_user",
      descriptorVersion: 1,
    };

    expect(parseDeclarativeToolDescriptor(secondRaw).revision).toBe(
      parseDeclarativeToolDescriptor(first).revision,
    );
  });

  it("rejects unsupported descriptor versions", () => {
    expectCode(
      () =>
        parseDeclarativeToolDescriptor({
          ...baseDescriptor(),
          descriptorVersion: 2,
        }),
      "DESCRIPTOR_VERSION_UNSUPPORTED",
    );
  });

  it("rejects unknown descriptor keys", () => {
    expectCode(
      () =>
        parseDeclarativeToolDescriptor({ ...baseDescriptor(), extra: true }),
      "DESCRIPTOR_INVALID",
    );
  });

  it("rejects absolute, protocol-relative, dot-segment, and malformed paths", () => {
    for (const path of [
      "https://evil.example/users/{userId}",
      "//evil.example/users/{userId}",
      "/users/../admin/{userId}",
      "/users/{userId}?debug=1",
      "/users/{userId",
      "/users//{userId}",
    ]) {
      expectCode(
        () =>
          parseDeclarativeToolDescriptor(
            baseDescriptor({
              request: {
                method: "GET",
                path,
                parameters: [{ name: "userId", in: "path", required: true }],
              },
              inputSchema: {
                type: "object",
                additionalProperties: false,
                required: ["userId"],
                properties: { userId: { type: "string" } },
              },
            }),
          ),
        "PATH_INVALID",
      );
    }
  });

  it("requires path parameters to match placeholders exactly once", () => {
    expectCode(
      () =>
        parseDeclarativeToolDescriptor(
          baseDescriptor({
            request: {
              method: "GET",
              path: "/users/{userId}",
              parameters: [{ name: "userId", in: "query" }],
            },
          }),
        ),
      "PATH_INVALID",
    );

    expectCode(
      () =>
        parseDeclarativeToolDescriptor(
          baseDescriptor({
            request: {
              method: "GET",
              path: "/users/{userId}/{userId}",
              parameters: [{ name: "userId", in: "path", required: true }],
            },
          }),
        ),
      "PATH_INVALID",
    );
  });

  it("rejects unaudited schemas and permissive additional properties", () => {
    expectCode(
      () =>
        parseDeclarativeToolDescriptor(
          baseDescriptor({
            inputSchema: {
              type: "object",
              required: ["userId"],
              properties: { userId: { type: "string" } },
            },
          }),
        ),
      "SCHEMA_INVALID",
    );

    expectCode(
      () =>
        parseDeclarativeToolDescriptor(
          baseDescriptor({
            inputSchema: {
              type: "object",
              additionalProperties: false,
              oneOf: [{ properties: { userId: { type: "string" } } }],
              properties: { userId: { type: "string" } },
            },
          }),
        ),
      "SCHEMA_INVALID",
    );
  });

  it("rejects unbound input properties and non-primitive parameter schemas", () => {
    expectCode(
      () =>
        parseDeclarativeToolDescriptor(
          baseDescriptor({
            inputSchema: {
              type: "object",
              additionalProperties: false,
              required: ["userId"],
              properties: {
                userId: { type: "string" },
                limit: { type: "integer" },
                unbound: { type: "string" },
              },
            },
          }),
        ),
      "BINDING_INVALID",
    );

    expectCode(
      () =>
        parseDeclarativeToolDescriptor(
          baseDescriptor({
            inputSchema: {
              type: "object",
              additionalProperties: false,
              required: ["userId"],
              properties: {
                userId: { type: "string" },
                limit: {
                  type: "object",
                  properties: { min: { type: "number" } },
                },
              },
            },
          }),
        ),
      "BINDING_INVALID",
    );
  });

  it("rejects transport-owned header parameters", () => {
    expectCode(
      () =>
        parseDeclarativeToolDescriptor(
          baseDescriptor({
            request: {
              method: "GET",
              path: "/users/{userId}",
              parameters: [
                { name: "userId", in: "path", required: true },
                { name: "Authorization", in: "header" },
              ],
            },
            inputSchema: {
              type: "object",
              additionalProperties: false,
              required: ["userId"],
              properties: {
                userId: { type: "string" },
                Authorization: { type: "string" },
              },
            },
          }),
        ),
      "PARAMETER_INVALID",
    );
  });

  it("rejects required parameters missing from the schema required list", () => {
    expectCode(
      () =>
        parseDeclarativeToolDescriptor(
          baseDescriptor({
            request: {
              method: "GET",
              path: "/users/{userId}",
              parameters: [
                { name: "userId", in: "path", required: true },
                { name: "limit", in: "query", required: true },
              ],
            },
          }),
        ),
      "PARAMETER_INVALID",
    );

    expectCode(
      () =>
        parseDeclarativeToolDescriptor(
          baseDescriptor({
            request: {
              method: "GET",
              path: "/users/{userId}",
              parameters: [{ name: "userId", in: "path" }],
            },
          }),
        ),
      "PARAMETER_INVALID",
    );
  });

  it("lowers OR alternatives and sorted OAuth scopes", () => {
    const parsed = parseDeclarativeToolDescriptor(baseDescriptor(), {
      authSchemes: {
        api_key: {
          type: "apiKey",
          parameterName: "X-API-Key",
          parameterLocation: "header",
        },
        oauth: { type: "oauth2" },
      },
    });
    const descriptor = baseDescriptor({
      authentication: {
        alternatives: [
          { schemes: [{ name: "api_key" }] },
          { schemes: [{ name: "oauth", scopes: ["write", "read", "read"] }] },
          { schemes: [] },
        ],
      },
      policy: { requiredScopes: ["users:write", "users:read", "users:read"] },
    });
    const authenticated = parseDeclarativeToolDescriptor(descriptor, {
      authSchemes: {
        api_key: {
          type: "apiKey",
          parameterName: "X-API-Key",
          parameterLocation: "header",
        },
        oauth: { type: "oauth2" },
      },
    });

    expect(parsed.operation.authentication.allowsAnonymous).toBe(false);
    expect(authenticated.operation.authentication).toEqual({
      allowsAnonymous: true,
      alternatives: [
        {
          schemes: [
            {
              name: "api_key",
              type: "apiKey",
              scopes: [],
              parameterName: "X-API-Key",
              parameterLocation: "header",
            },
          ],
        },
        {
          schemes: [
            {
              name: "oauth",
              type: "oauth2",
              scopes: ["read", "write"],
            },
          ],
        },
        { schemes: [] },
      ],
    });
    expect(authenticated.operation.security).toEqual([
      { api_key: [] },
      { oauth: ["read", "write"] },
      {},
    ]);
    expect(authenticated.operation.operation.requiredScopes).toEqual([
      "users:read",
      "users:write",
    ]);
  });

  it("rejects unknown schemes and scopes on non-OAuth schemes", () => {
    expectCode(
      () =>
        parseDeclarativeToolDescriptor(
          baseDescriptor({
            authentication: {
              alternatives: [{ schemes: [{ name: "missing" }] }],
            },
          }),
        ),
      "AUTH_SCHEME_UNKNOWN",
    );

    expectCode(
      () =>
        parseDeclarativeToolDescriptor(
          baseDescriptor({
            authentication: {
              alternatives: [
                { schemes: [{ name: "api_key", scopes: ["read"] }] },
              ],
            },
          }),
          {
            authSchemes: {
              api_key: {
                type: "apiKey",
                parameterName: "X-API-Key",
                parameterLocation: "header",
              },
            },
          },
        ),
      "AUTH_SCHEME_INVALID",
    );
  });

  it("rejects invalid cache, timeout, and output policy values", () => {
    expectCode(
      () =>
        parseDeclarativeToolDescriptor(
          baseDescriptor({
            request: { method: "POST", path: "/users", parameters: [] },
            inputSchema: {
              type: "object",
              additionalProperties: false,
              properties: {},
            },
            policy: { cacheTtlSeconds: 30 },
          }),
        ),
      "POLICY_INVALID",
    );

    expectCode(
      () =>
        parseDeclarativeToolDescriptor(
          baseDescriptor({ policy: { timeoutMs: 0 } }),
        ),
      "POLICY_INVALID",
    );

    expectCode(
      () =>
        parseDeclarativeToolDescriptor(
          baseDescriptor({
            policy: { outputFields: { include: ["id"], exclude: ["secret"] } },
          }),
        ),
      "POLICY_INVALID",
    );
  });

  it("rejects GET bodies and non-JSON body media types", () => {
    expectCode(
      () =>
        parseDeclarativeToolDescriptor(
          baseDescriptor({
            request: {
              method: "GET",
              path: "/users/{userId}",
              parameters: [{ name: "userId", in: "path", required: true }],
              body: { required: false },
            },
            inputSchema: {
              type: "object",
              additionalProperties: false,
              required: ["userId"],
              properties: {
                userId: { type: "string" },
                body: { type: "object", properties: {} },
              },
            },
          }),
        ),
      "BODY_INVALID",
    );

    expectCode(
      () =>
        parseDeclarativeToolDescriptor({
          descriptorVersion: 1,
          name: "create_user",
          description: "Creates a user",
          request: {
            method: "POST",
            path: "/users",
            parameters: [],
            body: { mediaType: "text/plain", required: true },
          },
          inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["body"],
            properties: { body: { type: "object", properties: {} } },
          },
        }),
      "BODY_INVALID",
    );
  });

  it("accepts a required JSON body and binds it to `body`", () => {
    const parsed = parseDeclarativeToolDescriptor({
      descriptorVersion: 1,
      name: "create_user",
      description: "Creates a user",
      request: {
        method: "POST",
        path: "/users",
        parameters: [],
        body: { required: true },
      },
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["body"],
        properties: {
          body: {
            type: "object",
            additionalProperties: false,
            required: ["name"],
            properties: { name: { type: "string" } },
          },
        },
      },
    });

    expect(parsed.operation.requestBody).toEqual({
      mediaType: "application/json",
      required: true,
      kind: "json",
    });
  });
});

describe("parseDeclarativeToolDescriptorJson", () => {
  it("parses JSON descriptors", () => {
    const parsed = parseDeclarativeToolDescriptorJson(
      JSON.stringify(baseDescriptor()),
    );
    expect(parsed.descriptor.name).toBe("get_user");
  });

  it("rejects invalid and oversized JSON", () => {
    expectCode(
      () => parseDeclarativeToolDescriptorJson("{"),
      "DESCRIPTOR_INVALID",
    );
    expectCode(
      () =>
        parseDeclarativeToolDescriptorJson(
          JSON.stringify({
            ...baseDescriptor(),
            description: "a".repeat(MAX_DESCRIPTOR_BYTES),
          }),
        ),
      "DESCRIPTOR_TOO_LARGE",
    );
  });
});

import { describe, expect, it } from "vitest";

import {
  DeclarativeDescriptorError,
  MAX_DECLARATIVE_AUTH_ALTERNATIVES,
  MAX_DECLARATIVE_AUTH_SCHEMES,
  MAX_DECLARATIVE_CACHE_TTL_SECONDS,
  MAX_DECLARATIVE_DESCRIPTION_LENGTH,
  MAX_DECLARATIVE_PARAMETERS,
  MAX_DECLARATIVE_PROPERTIES,
  MAX_DECLARATIVE_SCOPES,
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
      parameters: [{ name: "userId", in: "path", required: true }],
    },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["userId"],
      properties: {
        userId: { type: "string", minLength: 1 },
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

describe("parseDeclarativeToolDescriptorJson additional tests", () => {
  it("rejects non-string and non-object inputs", () => {
    expectCode(
      () => parseDeclarativeToolDescriptorJson(123 as unknown as string),
      "DESCRIPTOR_INVALID",
    );
    expectCode(
      () => parseDeclarativeToolDescriptorJson('"not an object"'),
      "DESCRIPTOR_INVALID",
    );
  });
});

describe("parseDeclarativeToolDescriptor edge cases", () => {
  it("rejects non-plain object or oversized input", () => {
    expectCode(
      () => parseDeclarativeToolDescriptor([1, 2, 3]),
      "DESCRIPTOR_INVALID",
    );
    expectCode(
      () =>
        parseDeclarativeToolDescriptor({
          ...baseDescriptor(),
          description: "x".repeat(MAX_DESCRIPTOR_BYTES),
        }),
      "DESCRIPTOR_TOO_LARGE",
    );
  });

  it("validates descriptor name", () => {
    expectCode(
      () =>
        parseDeclarativeToolDescriptor(
          baseDescriptor({ name: "invalid name with space" }),
        ),
      "NAME_INVALID",
    );
    expectCode(
      () =>
        parseDeclarativeToolDescriptor(baseDescriptor({ name: "bad@name" })),
      "NAME_INVALID",
    );
  });

  it("validates descriptor description", () => {
    expectCode(
      () => parseDeclarativeToolDescriptor(baseDescriptor({ description: "" })),
      "DESCRIPTION_INVALID",
    );
    expectCode(
      () =>
        parseDeclarativeToolDescriptor(baseDescriptor({ description: "   " })),
      "DESCRIPTION_INVALID",
    );
    expectCode(
      () =>
        parseDeclarativeToolDescriptor(
          baseDescriptor({
            description: "a".repeat(MAX_DECLARATIVE_DESCRIPTION_LENGTH + 1),
          }),
        ),
      "DESCRIPTION_INVALID",
    );
  });

  it("validates HTTP method", () => {
    expectCode(
      () =>
        parseDeclarativeToolDescriptor(
          baseDescriptor({
            request: {
              method: "OPTIONS" as unknown as "GET",
              path: "/users/{userId}",
              parameters: [{ name: "userId", in: "path", required: true }],
            },
          }),
        ),
      "METHOD_UNSUPPORTED",
    );
  });

  it("validates path length, percent encoding, and placeholder names", () => {
    expectCode(
      () =>
        parseDeclarativeToolDescriptor(
          baseDescriptor({
            request: {
              method: "GET",
              path: "/" + "a".repeat(2049) + "/{userId}",
              parameters: [{ name: "userId", in: "path", required: true }],
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
              path: "/users/%ZZ/{userId}",
              parameters: [{ name: "userId", in: "path", required: true }],
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
              path: "/users/{user!id}",
              parameters: [{ name: "user!id", in: "path", required: true }],
            },
            inputSchema: {
              type: "object",
              additionalProperties: false,
              required: ["user!id"],
              properties: { "user!id": { type: "string" } },
            },
          }),
        ),
      "PATH_INVALID",
    );
  });

  it("validates inputSchema structure and property limits", () => {
    expectCode(
      () =>
        parseDeclarativeToolDescriptor(
          baseDescriptor({
            inputSchema:
              "not an object" as unknown as DeclarativeToolDescriptor["inputSchema"],
          }),
        ),
      "SCHEMA_INVALID",
    );
    expectCode(
      () =>
        parseDeclarativeToolDescriptor(
          baseDescriptor({
            inputSchema: {
              type: "string",
            } as unknown as DeclarativeToolDescriptor["inputSchema"],
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
              properties: "invalid" as unknown as Record<string, unknown>,
            } as unknown as DeclarativeToolDescriptor["inputSchema"],
          }),
        ),
      "SCHEMA_INVALID",
    );

    // Reserved property name
    expectCode(
      () =>
        parseDeclarativeToolDescriptor(
          baseDescriptor({
            inputSchema: {
              type: "object",
              additionalProperties: false,
              properties: {
                userId: { type: "string" },
                constructor: { type: "string" },
              },
            },
          }),
        ),
      "SCHEMA_INVALID",
    );

    // Too many properties
    const manyProps: Record<string, { type: string }> = {
      userId: { type: "string" },
    };
    for (let i = 0; i < MAX_DECLARATIVE_PROPERTIES + 1; i++) {
      manyProps[`prop_${i}`] = { type: "string" };
    }
    expectCode(
      () =>
        parseDeclarativeToolDescriptor(
          baseDescriptor({
            inputSchema: {
              type: "object",
              additionalProperties: false,
              properties: manyProps,
            },
          }),
        ),
      "SCHEMA_INVALID",
    );
  });

  it("validates parameter counts and declarations", () => {
    // Too many parameters (> 100)
    const manyParams: DeclarativeToolDescriptor["request"]["parameters"] =
      Array.from({ length: MAX_DECLARATIVE_PARAMETERS + 1 }, () => ({
        name: "userId",
        in: "query",
      }));
    expectCode(
      () =>
        parseDeclarativeToolDescriptor(
          baseDescriptor({
            request: {
              method: "GET",
              path: "/users/{userId}",
              parameters: manyParams,
            },
          }),
        ),
      "PARAMETER_INVALID",
    );

    // Invalid parameter name
    expectCode(
      () =>
        parseDeclarativeToolDescriptor(
          baseDescriptor({
            request: {
              method: "GET",
              path: "/users/{userId}",
              parameters: [
                { name: "userId", in: "path", required: true },
                { name: "bad param!", in: "query" },
              ],
            },
            inputSchema: {
              type: "object",
              additionalProperties: false,
              required: ["userId"],
              properties: {
                userId: { type: "string" },
                "bad param!": { type: "string" },
              },
            },
          }),
        ),
      "PARAMETER_INVALID",
    );

    // Unsupported parameter location (fails raw schema parse)
    expectCode(
      () =>
        parseDeclarativeToolDescriptor(
          baseDescriptor({
            request: {
              method: "GET",
              path: "/users/{userId}",
              parameters: [
                { name: "userId", in: "path", required: true },
                { name: "foo", in: "body" as unknown as "query" },
              ],
            },
            inputSchema: {
              type: "object",
              additionalProperties: false,
              required: ["userId"],
              properties: {
                userId: { type: "string" },
                foo: { type: "string" },
              },
            },
          }),
        ),
      "DESCRIPTOR_INVALID",
    );

    // Declared twice in same location
    expectCode(
      () =>
        parseDeclarativeToolDescriptor(
          baseDescriptor({
            request: {
              method: "GET",
              path: "/users/{userId}",
              parameters: [
                { name: "userId", in: "path", required: true },
                { name: "filter", in: "query" },
                { name: "filter", in: "query" },
              ],
            },
            inputSchema: {
              type: "object",
              additionalProperties: false,
              required: ["userId"],
              properties: {
                userId: { type: "string" },
                filter: { type: "string" },
              },
            },
          }),
        ),
      "PARAMETER_INVALID",
    );

    // Bound to more than one request location
    expectCode(
      () =>
        parseDeclarativeToolDescriptor(
          baseDescriptor({
            request: {
              method: "GET",
              path: "/users/{userId}",
              parameters: [
                { name: "userId", in: "path", required: true },
                { name: "token", in: "query" },
                { name: "token", in: "header" },
              ],
            },
            inputSchema: {
              type: "object",
              additionalProperties: false,
              required: ["userId"],
              properties: {
                userId: { type: "string" },
                token: { type: "string" },
              },
            },
          }),
        ),
      "PARAMETER_INVALID",
    );

    // Header parameter with invalid header name
    expectCode(
      () =>
        parseDeclarativeToolDescriptor(
          baseDescriptor({
            request: {
              method: "GET",
              path: "/users/{userId}",
              parameters: [
                { name: "userId", in: "path", required: true },
                { name: "Bad Header", in: "header" },
              ],
            },
            inputSchema: {
              type: "object",
              additionalProperties: false,
              required: ["userId"],
              properties: {
                userId: { type: "string" },
                "Bad Header": { type: "string" },
              },
            },
          }),
        ),
      "PARAMETER_INVALID",
    );

    // Parameter missing matching inputSchema property
    expectCode(
      () =>
        parseDeclarativeToolDescriptor(
          baseDescriptor({
            request: {
              method: "GET",
              path: "/users/{userId}",
              parameters: [
                { name: "userId", in: "path", required: true },
                { name: "unmatched", in: "query" },
              ],
            },
            inputSchema: {
              type: "object",
              additionalProperties: false,
              required: ["userId"],
              properties: { userId: { type: "string" } },
            },
          }),
        ),
      "PARAMETER_INVALID",
    );
  });

  it("validates parameter schema bindings and types", () => {
    // Path parameter cannot be array
    expectCode(
      () =>
        parseDeclarativeToolDescriptor(
          baseDescriptor({
            request: {
              method: "GET",
              path: "/users/{userId}",
              parameters: [{ name: "userId", in: "path", required: true }],
            },
            inputSchema: {
              type: "object",
              additionalProperties: false,
              required: ["userId"],
              properties: {
                userId: { type: "array", items: { type: "string" } },
              },
            },
          }),
        ),
      "BINDING_INVALID",
    );

    // Array parameter with non-primitive item type
    expectCode(
      () =>
        parseDeclarativeToolDescriptor(
          baseDescriptor({
            request: {
              method: "GET",
              path: "/users/{userId}",
              parameters: [
                { name: "userId", in: "path", required: true },
                { name: "tags", in: "query" },
              ],
            },
            inputSchema: {
              type: "object",
              additionalProperties: false,
              required: ["userId"],
              properties: {
                userId: { type: "string" },
                tags: { type: "array", items: { type: "object" } },
              },
            },
          }),
        ),
      "BINDING_INVALID",
    );

    // Union type containing non-primitive
    expectCode(
      () =>
        parseDeclarativeToolDescriptor(
          baseDescriptor({
            request: {
              method: "GET",
              path: "/users/{userId}",
              parameters: [
                { name: "userId", in: "path", required: true },
                { name: "val", in: "query" },
              ],
            },
            inputSchema: {
              type: "object",
              additionalProperties: false,
              required: ["userId"],
              properties: {
                userId: { type: "string" },
                val: { type: ["string", "object"] },
              },
            },
          }),
        ),
      "BINDING_INVALID",
    );

    // Valid union type of primitives
    const parsedUnion = parseDeclarativeToolDescriptor(
      baseDescriptor({
        request: {
          method: "GET",
          path: "/users/{userId}",
          parameters: [
            { name: "userId", in: "path", required: true },
            { name: "val", in: "query" },
          ],
        },
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["userId"],
          properties: {
            userId: { type: "string" },
            val: { type: ["string", "number"] },
          },
        },
      }),
    );
    expect(parsedUnion.descriptor.name).toBe("get_user");
  });

  it("validates request body and binding to inputSchema.body", () => {
    // Body specified in request but not in inputSchema
    expectCode(
      () =>
        parseDeclarativeToolDescriptor(
          baseDescriptor({
            request: {
              method: "POST",
              path: "/users/{userId}",
              parameters: [{ name: "userId", in: "path", required: true }],
              body: { required: false },
            },
          }),
        ),
      "BINDING_INVALID",
    );

    // Required body not in inputSchema.required
    expectCode(
      () =>
        parseDeclarativeToolDescriptor(
          baseDescriptor({
            request: {
              method: "POST",
              path: "/users/{userId}",
              parameters: [{ name: "userId", in: "path", required: true }],
              body: { required: true },
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
  });

  it("validates authentication alternatives, schemes, and scopes", () => {
    // Empty alternatives
    expectCode(
      () =>
        parseDeclarativeToolDescriptor(
          baseDescriptor({
            authentication: { alternatives: [] },
          }),
        ),
      "DESCRIPTOR_INVALID",
    );

    // Too many alternatives
    const manyAlts = Array.from(
      { length: MAX_DECLARATIVE_AUTH_ALTERNATIVES + 1 },
      () => ({
        schemes: [{ name: "auth1" }],
      }),
    );
    expectCode(
      () =>
        parseDeclarativeToolDescriptor(
          baseDescriptor({
            authentication: { alternatives: manyAlts },
          }),
        ),
      "DESCRIPTOR_INVALID",
    );

    // Too many schemes in an alternative
    const manySchemes = Array.from(
      { length: MAX_DECLARATIVE_AUTH_SCHEMES + 1 },
      (_, i) => ({
        name: `auth_${i}`,
      }),
    );
    expectCode(
      () =>
        parseDeclarativeToolDescriptor(
          baseDescriptor({
            authentication: { alternatives: [{ schemes: manySchemes }] },
          }),
        ),
      "DESCRIPTOR_INVALID",
    );

    // Invalid scheme name in reference
    expectCode(
      () =>
        parseDeclarativeToolDescriptor(
          baseDescriptor({
            authentication: {
              alternatives: [{ schemes: [{ name: "bad scheme!" }] }],
            },
          }),
        ),
      "AUTH_SCHEME_INVALID",
    );

    // Duplicate scheme reference in alternative
    expectCode(
      () =>
        parseDeclarativeToolDescriptor(
          baseDescriptor({
            authentication: {
              alternatives: [
                { schemes: [{ name: "my_auth" }, { name: "my_auth" }] },
              ],
            },
          }),
          { authSchemes: { my_auth: { type: "oauth2" } } },
        ),
      "AUTH_SCHEME_INVALID",
    );

    // Too many scopes
    const manyScopes = Array.from(
      { length: MAX_DECLARATIVE_SCOPES + 1 },
      (_, i) => `scope_${i}`,
    );
    expectCode(
      () =>
        parseDeclarativeToolDescriptor(
          baseDescriptor({
            authentication: {
              alternatives: [
                { schemes: [{ name: "my_auth", scopes: manyScopes }] },
              ],
            },
          }),
          { authSchemes: { my_auth: { type: "oauth2" } } },
        ),
      "AUTH_SCHEME_INVALID",
    );

    // Invalid scope string (empty or control chars)
    expectCode(
      () =>
        parseDeclarativeToolDescriptor(
          baseDescriptor({
            authentication: {
              alternatives: [{ schemes: [{ name: "my_auth", scopes: [""] }] }],
            },
          }),
          { authSchemes: { my_auth: { type: "oauth2" } } },
        ),
      "AUTH_SCHEME_INVALID",
    );

    // Http scheme reference with bearerFormat
    const parsedHttp = parseDeclarativeToolDescriptor(
      baseDescriptor({
        authentication: {
          alternatives: [{ schemes: [{ name: "jwt_auth" }] }],
        },
      }),
      {
        authSchemes: {
          jwt_auth: {
            type: "http",
            httpScheme: "bearer",
            bearerFormat: "JWT",
          },
        },
      },
    );
    expect(parsedHttp.operation.authentication).toBeDefined();
  });

  it("validates policy cache, tokens, output fields, and required scopes", () => {
    // Invalid cacheTtlSeconds
    expectCode(
      () =>
        parseDeclarativeToolDescriptor(
          baseDescriptor({
            policy: { cacheTtlSeconds: 0 },
          }),
        ),
      "POLICY_INVALID",
    );
    expectCode(
      () =>
        parseDeclarativeToolDescriptor(
          baseDescriptor({
            policy: { cacheTtlSeconds: MAX_DECLARATIVE_CACHE_TTL_SECONDS + 1 },
          }),
        ),
      "POLICY_INVALID",
    );

    // Invalid maxOutputTokens
    expectCode(
      () =>
        parseDeclarativeToolDescriptor(
          baseDescriptor({
            policy: { maxOutputTokens: -1 },
          }),
        ),
      "POLICY_INVALID",
    );

    // Too many requiredScopes
    const manyScopes = Array.from(
      { length: MAX_DECLARATIVE_SCOPES + 1 },
      (_, i) => `scope_${i}`,
    );
    expectCode(
      () =>
        parseDeclarativeToolDescriptor(
          baseDescriptor({
            policy: { requiredScopes: manyScopes },
          }),
        ),
      "POLICY_INVALID",
    );

    // Invalid requiredScope string
    expectCode(
      () =>
        parseDeclarativeToolDescriptor(
          baseDescriptor({
            policy: { requiredScopes: [""] },
          }),
        ),
      "POLICY_INVALID",
    );

    // Valid policy with outputFields include
    const parsedInclude = parseDeclarativeToolDescriptor(
      baseDescriptor({
        policy: {
          cacheTtlSeconds: 60,
          maxOutputTokens: 2000,
          outputFields: {
            include: ["id", "name"],
          },
        },
      }),
    );
    expect(parsedInclude.descriptor.name).toBe("get_user");

    // Valid policy with outputFields exclude
    const parsedExclude = parseDeclarativeToolDescriptor(
      baseDescriptor({
        policy: {
          outputFields: {
            exclude: ["secret"],
          },
        },
      }),
    );
    expect(parsedExclude.descriptor.name).toBe("get_user");
  });

  it("enforces canonical JSON limits (depth, nodes, types)", () => {
    // Deeply nested object
    let deep: Record<string, unknown> = { val: 1 };
    for (let i = 0; i < 25; i++) {
      deep = { nested: deep };
    }
    expectCode(
      () =>
        parseDeclarativeToolDescriptor({
          ...baseDescriptor(),
          extra: deep,
        } as unknown as DeclarativeToolDescriptor),
      "DESCRIPTOR_INVALID",
    );

    // Non-JSON value (BigInt)
    expectCode(
      () =>
        parseDeclarativeToolDescriptor({
          ...baseDescriptor(),
          extra: BigInt(42),
        } as unknown as DeclarativeToolDescriptor),
      "DESCRIPTOR_INVALID",
    );
  });
});

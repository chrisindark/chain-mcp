import { readFile } from "node:fs/promises";

import { auditInputSchema } from "@chainmcp/core";
import { describe, expect, it } from "vitest";

import {
  MAX_SOURCE_BYTES_LIMIT,
  OpenApiCompiler,
  compileOpenApi,
  diffManifests,
  type CompileOptions,
  type CompileResult,
} from "../src/index.js";

type ObjectMap = Record<string, unknown>;

async function fixture(name: string): Promise<string> {
  return readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

function operation(overrides: ObjectMap = {}): ObjectMap {
  return {
    operationId: "testOp",
    responses: { "200": { description: "ok" } },
    ...overrides,
  };
}

function baseDocument(
  paths: ObjectMap,
  extra: ObjectMap = {},
  version = "3.0.3",
): ObjectMap {
  return {
    openapi: version,
    info: { title: "Test API", version: "1.0.0" },
    paths,
    ...extra,
  };
}

function compileDocument(
  document: unknown,
  options?: CompileOptions,
): CompileResult {
  return compileOpenApi(JSON.stringify(document), options);
}

function codes(result: CompileResult): string[] {
  return result.diagnostics.map((diagnostic) => diagnostic.code);
}

function singleTool(result: CompileResult) {
  expect(result.tools).toHaveLength(1);
  const [tool] = result.tools;
  if (tool === undefined) throw new Error("expected a compiled tool");
  return tool;
}

describe("OpenAPI 3.0 compilation", () => {
  it("compiles operations, parameters, bodies, and security deterministically", async () => {
    const source = await fixture("petstore-3.0.yaml");
    const compiler = new OpenApiCompiler();
    const result = await compiler.compile(source);

    expect(result.ok).toBe(true);
    expect(result.manifest.openapiVersion).toBe("3.0");
    expect(result.tools.map((tool) => tool.name)).toEqual([
      "List_Pets",
      "createPet",
      "getPet",
    ]);
    expect(result.manifest.toolCount).toBe(3);
    expect(result.manifest.tools.map((tool) => tool.name)).toEqual([
      "List_Pets",
      "createPet",
      "getPet",
    ]);
    expect(
      result.manifest.tools.every((tool) => tool.hash.startsWith("sha256:")),
    ).toBe(true);
    expect(codes(result)).toContain("TOOL_NAME_NORMALIZED");

    const listPets = result.tools[0];
    expect(listPets?.readOnly).toBe(true);
    expect(listPets?.security).toEqual([{ api_key: [] }]);
    expect(listPets?.authentication).toEqual({
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
      ],
      allowsAnonymous: false,
    });
    expect(Object.keys(listPets?.inputSchema.properties ?? {})).toEqual([
      "X-Request-Id",
      "limit",
    ]);
    expect(listPets?.inputSchema.required).toEqual([]);
    expect(listPets?.parameters).toEqual([
      { name: "X-Request-Id", in: "header", required: false },
      { name: "limit", in: "query", required: false },
    ]);
    expect(listPets?.requestBody).toBeUndefined();

    const createPet = result.tools[1];
    expect(createPet?.parameters).toEqual([]);
    expect(createPet?.requestBody).toEqual({
      mediaType: "application/json",
      required: true,
    });
    expect(createPet?.readOnly).toBe(false);
    const body = (createPet?.inputSchema.properties as ObjectMap)
      .body as ObjectMap;
    expect(body).toMatchObject({
      type: "object",
      required: ["name"],
      additionalProperties: false,
    });
    expect(Object.keys(body.properties as ObjectMap)).toEqual(["name", "tag"]);
    expect((body.properties as ObjectMap).id).toBeUndefined();

    const getPet = result.tools[2];
    expect(getPet?.security).toEqual([]);
    expect(getPet?.authentication).toEqual({
      alternatives: [],
      allowsAnonymous: true,
    });
    expect(getPet?.inputSchema.required).toEqual(["petId"]);
    expect(getPet?.parameters).toEqual([
      { name: "petId", in: "path", required: true },
    ]);
    expect(getPet?.requestBody).toBeUndefined();
    expect(getPet?.responses).toEqual([
      {
        status: "200",
        description: "A pet",
        mediaType: "application/json",
        schema: {
          type: "object",
          required: ["id", "name"],
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            tag: {
              type: ["string", "null"],
              enum: ["dog", "cat", null],
            },
          },
          additionalProperties: false,
        },
      },
    ]);
    expect(listPets?.responses[0]?.schema).toMatchObject({
      type: "array",
      items: { type: "object" },
    });

    for (const tool of result.tools) {
      expect(auditInputSchema(tool.inputSchema).supported).toBe(true);
    }
  });

  it("translates 3.0 nullable type and enum declarations", () => {
    const result = compileDocument(
      baseDocument({
        "/x": {
          get: operation({
            parameters: [
              {
                name: "tag",
                in: "query",
                schema: {
                  type: "string",
                  nullable: true,
                  enum: ["a"],
                },
              },
            ],
          }),
        },
      }),
    );

    const tool = singleTool(result);
    expect(tool.inputSchema.properties).toEqual({
      tag: { type: ["string", "null"], enum: ["a", null] },
    });
    expect(result.ok).toBe(true);
  });

  it("rejects nullable without a sibling type and in OpenAPI 3.1", () => {
    const missingType = compileDocument(
      baseDocument({
        "/x": {
          get: operation({
            parameters: [
              {
                name: "tag",
                in: "query",
                schema: { nullable: true },
              },
            ],
          }),
        },
      }),
    );
    expect(missingType.ok).toBe(false);
    expect(codes(missingType)).toContain("SCHEMA_NULLABLE_INVALID");
    expect(missingType.tools).toHaveLength(0);

    const version31 = compileDocument(
      baseDocument(
        {
          "/x": {
            get: operation({
              parameters: [
                {
                  name: "tag",
                  in: "query",
                  schema: { type: "string", nullable: true },
                },
              ],
            }),
          },
        },
        {},
        "3.1.0",
      ),
    );
    expect(version31.ok).toBe(false);
    expect(codes(version31)).toContain("SCHEMA_NULLABLE_INVALID");
  });

  it("drops nullable: false without changing the type", () => {
    const result = compileDocument(
      baseDocument({
        "/x": {
          get: operation({
            parameters: [
              {
                name: "tag",
                in: "query",
                schema: { type: "string", nullable: false },
              },
            ],
          }),
        },
      }),
    );
    expect(singleTool(result).inputSchema.properties).toEqual({
      tag: { type: "string" },
    });
  });
});

describe("OpenAPI 3.1 compilation", () => {
  it("preserves null unions and AND/OR security requirements", async () => {
    const source = await fixture("petstore-3.1.yaml");
    const result = compileOpenApi(source);

    expect(result.ok).toBe(true);
    expect(result.manifest.openapiVersion).toBe("3.1");
    expect(result.tools.map((tool) => tool.name)).toEqual([
      "getItem",
      "replaceItem",
    ]);
    expect(result.securitySchemes.oauth).toMatchObject({ type: "oauth2" });
    expect(result.securitySchemes.bearer).toMatchObject({
      type: "http",
      scheme: "bearer",
      bearerFormat: "JWT",
    });

    const getItem = result.tools[0];
    expect(getItem?.security).toEqual([
      { oauth: ["items:read"] },
      { bearer: [] },
    ]);
    expect(getItem?.authentication.allowsAnonymous).toBe(false);
    expect(
      getItem?.authentication.alternatives.map((alternative) =>
        alternative.schemes.map((scheme) => ({
          name: scheme.name,
          type: scheme.type,
          scopes: scheme.scopes,
        })),
      ),
    ).toEqual([
      [{ name: "oauth", type: "oauth2", scopes: ["items:read"] }],
      [{ name: "bearer", type: "http", scopes: [] }],
    ]);
    expect((getItem?.inputSchema.properties as ObjectMap).filter).toEqual({
      type: ["string", "null"],
      enum: ["active", "archived", null],
    });

    const itemResponse = getItem?.responses[0];
    expect(itemResponse).toMatchObject({
      status: "200",
      description: "An item",
      mediaType: "application/json",
    });
    const itemSchema = itemResponse?.schema as ObjectMap;
    expect(itemSchema.allOf).toHaveLength(2);
    expect((itemSchema.allOf as ObjectMap[])[1]?.properties).toEqual({
      id: { type: "string", readOnly: true },
    });

    const replaceItem = result.tools[1];
    expect(replaceItem?.security).toEqual([
      { oauth: ["items:write"], bearer: [] },
    ]);
    expect(replaceItem?.authentication.alternatives).toHaveLength(1);
    expect(
      replaceItem?.authentication.alternatives[0]?.schemes.map(
        (scheme) => `${scheme.name}:${scheme.scopes.join(",")}`,
      ),
    ).toEqual(["bearer:", "oauth:items:write"]);
  });
});

describe("determinism and manifests", () => {
  it("produces byte-identical metadata and hashes for the same input", async () => {
    const source = await fixture("petstore-3.0.yaml");
    const first = compileOpenApi(source);
    const second = compileOpenApi(source);

    expect(second.tools).toEqual(first.tools);
    expect(second.diagnostics).toEqual(first.diagnostics);
    expect(second.manifest).toEqual(first.manifest);
    expect(second.sourceHash).toBe(first.sourceHash);
    expect(second.contractRevision).toBe(first.contractRevision);
    expect(second.manifest.toolsetHash).toBe(first.manifest.toolsetHash);
  });

  it("reports added, removed, changed, and unchanged tools", () => {
    const one = compileDocument(
      baseDocument({ "/a": { get: operation({ operationId: "a" }) } }),
    );
    const two = compileDocument(
      baseDocument({
        "/a": { get: operation({ operationId: "a" }) },
        "/b": { get: operation({ operationId: "b" }) },
      }),
    );
    const changed = compileDocument(
      baseDocument({
        "/a": {
          get: operation({ operationId: "a", summary: "Changed" }),
        },
      }),
    );

    expect(diffManifests(one.manifest, two.manifest)).toEqual({
      added: ["b"],
      removed: [],
      changed: [],
      unchanged: ["a"],
    });
    expect(diffManifests(two.manifest, one.manifest)).toEqual({
      added: [],
      removed: ["b"],
      changed: [],
      unchanged: ["a"],
    });
    expect(diffManifests(one.manifest, changed.manifest)).toEqual({
      added: [],
      removed: [],
      changed: ["a"],
      unchanged: [],
    });
    expect(one.manifest.toolsetHash).not.toBe(changed.manifest.toolsetHash);
    expect(() =>
      diffManifests(one.manifest, {
        ...one.manifest,
        manifestVersion: 2 as 1,
      }),
    ).toThrow(TypeError);
  });
});

describe("reference resolution", () => {
  it("resolves nested local references", () => {
    const result = compileDocument(
      baseDocument(
        {
          "/x": {
            post: operation({
              requestBody: {
                required: true,
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/A" },
                  },
                },
              },
            }),
          },
        },
        {
          components: {
            schemas: {
              A: {
                type: "object",
                properties: { b: { $ref: "#/components/schemas/B" } },
              },
              B: {
                type: "object",
                properties: { value: { type: "string" } },
              },
            },
          },
        },
      ),
    );

    const tool = singleTool(result);
    const body = (tool.inputSchema.properties as ObjectMap).body as ObjectMap;
    expect(body).toEqual({
      type: "object",
      properties: {
        b: {
          type: "object",
          properties: { value: { type: "string" } },
        },
      },
    });
  });

  it("detects circular references", () => {
    const result = compileDocument(
      baseDocument(
        {
          "/x": {
            post: operation({
              requestBody: {
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/A" },
                  },
                },
              },
            }),
          },
        },
        {
          components: {
            schemas: {
              A: {
                type: "object",
                properties: { b: { $ref: "#/components/schemas/B" } },
              },
              B: {
                type: "object",
                properties: { a: { $ref: "#/components/schemas/A" } },
              },
            },
          },
        },
      ),
    );
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain("REF_CYCLE");
    expect(result.tools).toHaveLength(0);
  });

  it("refuses remote references without fetching them", () => {
    const result = compileDocument(
      baseDocument({
        "/x": {
          post: operation({
            requestBody: {
              content: {
                "application/json": {
                  schema: { $ref: "https://example.com/schema.json" },
                },
              },
            },
          }),
        },
      }),
    );
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain("REF_REMOTE_UNSUPPORTED");
  });

  it("enforces the configured reference depth", () => {
    const result = compileDocument(
      baseDocument(
        {
          "/x": {
            post: operation({
              requestBody: {
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/A" },
                  },
                },
              },
            }),
          },
        },
        {
          components: {
            schemas: {
              A: { $ref: "#/components/schemas/B" },
              B: { $ref: "#/components/schemas/C" },
              C: { type: "object" },
            },
          },
        },
      ),
      { maxRefDepth: 1 },
    );
    expect(codes(result)).toContain("REF_DEPTH_EXCEEDED");
  });
});

describe("schema composition", () => {
  const bodyOf = (schema: ObjectMap) =>
    compileDocument(
      baseDocument({
        "/x": {
          post: operation({
            requestBody: {
              required: true,
              content: { "application/json": { schema } },
            },
          }),
        },
      }),
    );

  it("flattens object allOf schemas and resolves their references", () => {
    const result = compileDocument(
      baseDocument(
        {
          "/x": {
            post: operation({
              requestBody: {
                required: true,
                content: {
                  "application/json": {
                    schema: {
                      allOf: [
                        {
                          type: "object",
                          properties: { id: { type: "string" } },
                          required: ["id"],
                        },
                        { $ref: "#/components/schemas/Audit" },
                        {
                          allOf: [
                            {
                              type: "object",
                              properties: { note: { type: "string" } },
                            },
                          ],
                        },
                      ],
                      description: "Combined",
                    },
                  },
                },
              },
            }),
          },
        },
        {
          components: {
            schemas: {
              Audit: {
                type: "object",
                properties: { createdAt: { type: "string" } },
                required: ["createdAt"],
              },
            },
          },
        },
      ),
    );

    const tool = singleTool(result);
    const body = (tool.inputSchema.properties as ObjectMap).body;
    expect(body).toEqual({
      type: "object",
      description: "Combined",
      properties: {
        createdAt: { type: "string" },
        id: { type: "string" },
        note: { type: "string" },
      },
      required: ["createdAt", "id"],
    });
  });

  it("rejects incompatible, non-object, and ambiguous allOf members", () => {
    const incompatible = bodyOf({
      allOf: [
        { type: "object", properties: { id: { type: "string" } } },
        { type: "object", properties: { id: { type: "integer" } } },
      ],
    });
    expect(codes(incompatible)).toContain("SCHEMA_COMPOSITION_UNSUPPORTED");

    const primitive = bodyOf({ allOf: [{ type: "string" }] });
    expect(codes(primitive)).toContain("SCHEMA_COMPOSITION_UNSUPPORTED");

    // Flattening a closed member is safe only when it declares every property
    // contributed by the other members.
    const closedSafe = bodyOf({
      allOf: [
        {
          type: "object",
          properties: {
            a: { type: "string" },
            b: { type: "integer" },
          },
          additionalProperties: false,
        },
        {
          type: "object",
          properties: { b: { type: "integer" } },
          required: ["b"],
        },
      ],
    });
    expect(singleTool(closedSafe).inputSchema.properties).toEqual({
      body: {
        type: "object",
        properties: {
          a: { type: "string" },
          b: { type: "integer" },
        },
        required: ["b"],
        additionalProperties: false,
      },
    });

    const closedUnsafe = bodyOf({
      allOf: [
        {
          type: "object",
          properties: { a: { type: "string" } },
          additionalProperties: false,
        },
        { type: "object", properties: { b: { type: "integer" } } },
      ],
    });
    expect(codes(closedUnsafe)).toContain("SCHEMA_COMPOSITION_UNSUPPORTED");

    const sibling = bodyOf({
      type: "object",
      allOf: [{ type: "object", properties: { id: { type: "string" } } }],
    });
    expect(codes(sibling)).toContain("SCHEMA_COMPOSITION_UNSUPPORTED");

    const nullable = compileDocument(
      baseDocument({
        "/x": {
          get: operation({
            parameters: [
              {
                name: "value",
                in: "query",
                schema: {
                  nullable: true,
                  type: "object",
                  allOf: [{ type: "object" }],
                },
              },
            ],
          }),
        },
      }),
      { strict: false },
    );
    expect(codes(nullable)).toContain("SCHEMA_COMPOSITION_UNSUPPORTED");
  });

  it("detects cycles through allOf references", () => {
    const result = compileDocument(
      baseDocument(
        {
          "/x": {
            post: operation({
              requestBody: {
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/A" },
                  },
                },
              },
            }),
          },
        },
        {
          components: {
            schemas: {
              A: { allOf: [{ $ref: "#/components/schemas/A" }] },
            },
          },
        },
      ),
    );
    expect(codes(result)).toContain("REF_CYCLE");
    expect(result.tools).toHaveLength(0);
  });
});

describe("responses", () => {
  it("maps statuses, JSON schemas, and write-only output fields", () => {
    const result = compileDocument(
      baseDocument({
        "/x": {
          get: operation({
            operationId: "x",
            responses: {
              "404": { description: "Not found" },
              "200": {
                description: "OK",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      required: ["id", "secret"],
                      properties: {
                        id: { type: "string", readOnly: true },
                        name: { type: "string" },
                        secret: { type: "string", writeOnly: true },
                      },
                      additionalProperties: false,
                    },
                  },
                },
              },
            },
          }),
        },
      }),
    );

    const tool = singleTool(result);
    expect(tool.responses).toEqual([
      {
        status: "200",
        description: "OK",
        mediaType: "application/json",
        schema: {
          type: "object",
          properties: {
            id: { type: "string", readOnly: true },
            name: { type: "string" },
          },
          required: ["id"],
          additionalProperties: false,
        },
      },
      { status: "404", description: "Not found" },
    ]);
    expect(result.ok).toBe(true);
  });

  it("resolves referenced responses and composes output schemas", () => {
    const result = compileDocument(
      baseDocument(
        {
          "/x": {
            get: operation({
              responses: { "200": { $ref: "#/components/responses/Item" } },
            }),
          },
        },
        {
          components: {
            responses: {
              Item: {
                description: "An item",
                content: {
                  "application/json": {
                    schema: {
                      oneOf: [
                        { $ref: "#/components/schemas/Item" },
                        { type: "null" },
                      ],
                    },
                  },
                },
              },
            },
            schemas: {
              Item: {
                type: "object",
                properties: { id: { type: "string" } },
              },
            },
          },
        },
      ),
    );

    const tool = singleTool(result);
    expect(tool.responses).toEqual([
      {
        status: "200",
        description: "An item",
        mediaType: "application/json",
        schema: {
          oneOf: [
            { type: "object", properties: { id: { type: "string" } } },
            { type: "null" },
          ],
        },
      },
    ]);
  });

  it("supports 3.1 ranges and rejects them in 3.0", () => {
    const range = { "2XX": { description: "Success" } };
    const document = baseDocument(
      { "/x": { get: operation({ responses: range }) } },
      {},
      "3.1.0",
    );
    const result31 = compileDocument(document);
    expect(result31.ok).toBe(true);
    expect(singleTool(result31).responses).toEqual([
      { status: "2XX", description: "Success" },
    ]);

    const result30 = compileDocument(
      baseDocument({ "/x": { get: operation({ responses: range }) } }),
    );
    expect(codes(result30)).toContain("RESPONSE_INVALID");
    expect(result30.tools).toHaveLength(0);
  });

  it("records non-JSON content without a schema and warns", () => {
    const result = compileDocument(
      baseDocument({
        "/x": {
          get: operation({
            responses: {
              "200": {
                description: "CSV",
                content: { "text/csv": { schema: { type: "string" } } },
              },
            },
          }),
        },
      }),
    );

    expect(result.ok).toBe(true);
    expect(singleTool(result).responses).toEqual([
      { status: "200", description: "CSV", mediaType: "text/csv" },
    ]);
    expect(
      result.diagnostics.find(
        (diagnostic) => diagnostic.code === "RESPONSE_UNSUPPORTED",
      )?.severity,
    ).toBe("warning");
  });

  it("rejects malformed response objects", () => {
    const missingDescription = compileDocument(
      baseDocument({
        "/x": { get: operation({ responses: { "200": {} } }) },
      }),
    );
    expect(codes(missingDescription)).toContain("RESPONSE_INVALID");

    const badStatus = compileDocument(
      baseDocument({
        "/x": {
          get: operation({ responses: { "2000": { description: "Bad" } } }),
        },
      }),
    );
    expect(codes(badStatus)).toContain("RESPONSE_INVALID");

    const badSchema = compileDocument(
      baseDocument({
        "/x": {
          get: operation({
            responses: {
              "200": {
                description: "Bad",
                content: { "application/json": { schema: "not a schema" } },
              },
            },
          }),
        },
      }),
    );
    expect(codes(badSchema)).toContain("RESPONSE_INVALID");

    const unknownField = compileDocument(
      baseDocument({
        "/x": {
          get: operation({
            responses: { "200": { description: "Bad", body: "no" } },
          }),
        },
      }),
    );
    expect(codes(unknownField)).toContain("RESPONSE_INVALID");
  });

  it("includes response metadata in per-tool hashes", () => {
    const compileWith = (description: string) =>
      compileDocument(
        baseDocument({
          "/x": {
            get: operation({
              operationId: "x",
              responses: { "200": { description } },
            }),
          },
        }),
      );

    const first = compileWith("One");
    const second = compileWith("Two");
    expect(diffManifests(first.manifest, second.manifest)).toEqual({
      added: [],
      removed: [],
      changed: ["x"],
      unchanged: [],
    });
  });
});

describe("tool naming", () => {
  it("falls back to method and path when operationId is absent", () => {
    const result = compileDocument(
      baseDocument({
        "/pets/{petId}": {
          get: operation({
            operationId: undefined,
            responses: { "200": { description: "ok" } },
          }),
        },
      }),
    );
    const tool = singleTool(result);
    expect(tool.name).toBe("get_pets_petId");
    expect(tool.description).toBe("GET /pets/{petId}");
  });

  it("fails collisions in strict mode and renames them in permissive mode", () => {
    const document = baseDocument({
      "/a": { get: operation({ operationId: "same" }) },
      "/b": { get: operation({ operationId: "same" }) },
    });
    const strict = compileDocument(document);
    expect(strict.ok).toBe(false);
    expect(strict.tools.map((tool) => tool.name)).toEqual(["same"]);
    expect(codes(strict)).toContain("TOOL_NAME_COLLISION");

    const permissive = compileDocument(document, { strict: false });
    expect(permissive.ok).toBe(true);
    expect(permissive.tools.map((tool) => tool.name)).toEqual([
      "same",
      "same_2",
    ]);
    expect(
      permissive.diagnostics.find(
        (diagnostic) => diagnostic.code === "TOOL_NAME_COLLISION",
      )?.severity,
    ).toBe("warning");
  });

  it("normalizes names to the runtime character set", () => {
    const result = compileDocument(
      baseDocument({
        "/x": {
          get: operation({ operationId: "get/thing by id" }),
        },
      }),
    );
    expect(singleTool(result).name).toBe("get_thing_by_id");
    expect(codes(result)).toContain("TOOL_NAME_NORMALIZED");
  });
});

describe("unsupported schemas", () => {
  const parameterDocument = (schema: ObjectMap, version = "3.0.3") =>
    baseDocument(
      {
        "/x": {
          get: operation({
            parameters: [{ name: "value", in: "query", schema }],
          }),
        },
      },
      {},
      version,
    );

  it("preserves supported validation constraints", () => {
    const result = compileDocument(
      parameterDocument({
        type: "object",
        required: ["name"],
        properties: {
          name: {
            type: "string",
            minLength: 2,
            maxLength: 20,
            pattern: "^[a-z]+$",
            format: "email",
          },
          count: {
            type: "number",
            minimum: 0,
            maximum: 10,
            multipleOf: 0.5,
          },
          tags: {
            type: "array",
            minItems: 1,
            maxItems: 3,
            uniqueItems: true,
            items: { type: "string" },
          },
        },
        minProperties: 1,
        maxProperties: 3,
      }),
    );

    expect(result.ok).toBe(true);
    expect(singleTool(result).inputSchema.properties).toEqual({
      value: {
        type: "object",
        required: ["name"],
        properties: {
          name: {
            type: "string",
            minLength: 2,
            maxLength: 20,
            pattern: "^[a-z]+$",
            format: "email",
          },
          count: {
            type: "number",
            minimum: 0,
            maximum: 10,
            multipleOf: 0.5,
          },
          tags: {
            type: "array",
            minItems: 1,
            maxItems: 3,
            uniqueItems: true,
            items: { type: "string" },
          },
        },
        minProperties: 1,
        maxProperties: 3,
      },
    });
  });

  it("normalizes OpenAPI 3.0 boolean exclusive bounds", () => {
    const result = compileDocument(
      parameterDocument({
        type: "number",
        minimum: 1,
        exclusiveMinimum: true,
        maximum: 10,
        exclusiveMaximum: false,
      }),
    );

    expect(result.ok).toBe(true);
    expect(singleTool(result).inputSchema.properties).toEqual({
      value: {
        type: "number",
        exclusiveMinimum: 1,
        maximum: 10,
      },
    });

    const invalid = compileDocument(
      parameterDocument({
        type: "number",
        exclusiveMinimum: true,
      }),
    );
    expect(invalid.ok).toBe(false);
    expect(codes(invalid)).toContain("SCHEMA_INVALID");
  });

  it("preserves OpenAPI 3.1 numeric exclusive bounds", () => {
    const result = compileDocument(
      parameterDocument(
        {
          type: "number",
          exclusiveMinimum: 1,
          exclusiveMaximum: 10,
        },
        "3.1.0",
      ),
    );

    expect(result.ok).toBe(true);
    expect(singleTool(result).inputSchema.properties).toEqual({
      value: {
        type: "number",
        exclusiveMinimum: 1,
        exclusiveMaximum: 10,
      },
    });
  });

  it("rejects unsupported annotation keywords in strict mode and drops them in permissive mode", () => {
    const document = parameterDocument({
      type: "string",
      contentEncoding: "base64",
    });
    const strict = compileDocument(document);
    expect(strict.ok).toBe(false);
    expect(strict.tools).toHaveLength(0);
    expect(codes(strict)).toContain("SCHEMA_UNSUPPORTED");

    const permissive = compileDocument(document, { strict: false });
    expect(permissive.ok).toBe(true);
    expect(singleTool(permissive).inputSchema.properties).toEqual({
      value: { type: "string" },
    });
    expect(
      permissive.diagnostics.find(
        (diagnostic) => diagnostic.code === "SCHEMA_UNSUPPORTED",
      )?.severity,
    ).toBe("warning");
  });

  it("rejects union composition even in permissive mode", () => {
    const result = compileDocument(
      parameterDocument({
        oneOf: [{ type: "string" }, { type: "integer" }],
      }),
      { strict: false },
    );
    expect(result.ok).toBe(false);
    expect(result.tools).toHaveLength(0);
    expect(codes(result)).toContain("SCHEMA_COMPOSITION_UNSUPPORTED");
  });

  it("rejects schema-valued additionalProperties and unknown keywords", () => {
    const additional = compileDocument(
      parameterDocument({
        type: "object",
        additionalProperties: { type: "string" },
      }),
      { strict: false },
    );
    expect(codes(additional)).toContain("SCHEMA_UNSUPPORTED");

    const unknown = compileDocument(
      parameterDocument({ type: "string", unknownKeyword: true }),
      { strict: false },
    );
    expect(codes(unknown)).toContain("SCHEMA_UNSUPPORTED");
  });

  it("rejects nullable alongside a reference", () => {
    const result = compileDocument(
      baseDocument(
        {
          "/x": {
            get: operation({
              parameters: [
                {
                  name: "value",
                  in: "query",
                  schema: {
                    $ref: "#/components/schemas/Value",
                    nullable: true,
                  },
                },
              ],
            }),
          },
        },
        { components: { schemas: { Value: { type: "string" } } } },
      ),
    );
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain("REF_SIBLINGS_UNSUPPORTED");
  });
});

describe("parameters and request bodies", () => {
  it("requires path parameters to be required", () => {
    const result = compileDocument(
      baseDocument({
        "/x/{id}": {
          get: operation({
            parameters: [
              { name: "id", in: "path", schema: { type: "string" } },
            ],
          }),
        },
      }),
    );
    expect(codes(result)).toContain("PARAMETER_INVALID");
    expect(result.tools).toHaveLength(0);
  });

  it("rejects cookie, content-encoded, and credential header parameters", () => {
    const cookie = compileDocument(
      baseDocument({
        "/x": {
          get: operation({
            parameters: [
              { name: "session", in: "cookie", schema: { type: "string" } },
            ],
          }),
        },
      }),
    );
    expect(codes(cookie)).toContain("PARAMETER_UNSUPPORTED");

    const authorization = compileDocument(
      baseDocument({
        "/x": {
          get: operation({
            parameters: [
              {
                name: "Authorization",
                in: "header",
                schema: { type: "string" },
              },
            ],
          }),
        },
      }),
    );
    expect(codes(authorization)).toContain("PARAMETER_UNSUPPORTED");

    const contentType = compileDocument(
      baseDocument({
        "/x": {
          get: operation({
            parameters: [
              {
                name: "Content-Type",
                in: "header",
                schema: { type: "string" },
              },
            ],
          }),
        },
      }),
    );
    expect(codes(contentType)).toContain("PARAMETER_UNSUPPORTED");

    const expectHeader = compileDocument(
      baseDocument({
        "/x": {
          get: operation({
            parameters: [
              {
                name: "Expect",
                in: "header",
                schema: { type: "string" },
              },
            ],
          }),
        },
      }),
    );
    expect(codes(expectHeader)).toContain("PARAMETER_UNSUPPORTED");

    const content = compileDocument(
      baseDocument({
        "/x": {
          get: operation({
            parameters: [
              {
                name: "filter",
                in: "query",
                content: {
                  "application/json": { schema: { type: "string" } },
                },
              },
            ],
          }),
        },
      }),
    );
    expect(codes(content)).toContain("PARAMETER_UNSUPPORTED");
  });

  it("rejects duplicate parameter names across locations", () => {
    const result = compileDocument(
      baseDocument({
        "/x": {
          get: operation({
            parameters: [
              { name: "id", in: "query", schema: { type: "string" } },
              { name: "id", in: "header", schema: { type: "string" } },
            ],
          }),
        },
      }),
    );
    expect(codes(result)).toContain("PARAMETER_DUPLICATE");
  });

  it("maps JSON request bodies and honors required", () => {
    const document = baseDocument({
      "/x": {
        post: operation({
          requestBody: {
            required: true,
            content: {
              "application/json; charset=utf-8": {
                schema: {
                  type: "object",
                  properties: { name: { type: "string" } },
                },
              },
            },
          },
        }),
      },
    });
    const result = compileDocument(document);
    const tool = singleTool(result);
    expect(tool.inputSchema.required).toEqual(["body"]);
    expect(tool.inputSchema.properties).toEqual({
      body: {
        type: "object",
        properties: { name: { type: "string" } },
      },
    });
  });

  it("rejects non-JSON bodies and body/parameter collisions", () => {
    const nonJson = compileDocument(
      baseDocument({
        "/x": {
          post: operation({
            requestBody: {
              content: {
                "text/plain": { schema: { type: "string" } },
              },
            },
          }),
        },
      }),
    );
    expect(codes(nonJson)).toContain("REQUEST_BODY_UNSUPPORTED");

    const collision = compileDocument(
      baseDocument({
        "/x": {
          post: operation({
            parameters: [
              { name: "body", in: "query", schema: { type: "string" } },
            ],
            requestBody: {
              content: {
                "application/json": { schema: { type: "object" } },
              },
            },
          }),
        },
      }),
    );
    expect(codes(collision)).toContain("PARAMETER_DUPLICATE");
  });
});

describe("security structures", () => {
  it("rejects unknown schemes and invalid scheme definitions", () => {
    const unknown = compileDocument(
      baseDocument({
        "/x": {
          get: operation({ security: [{ missing: [] }] }),
        },
      }),
    );
    expect(codes(unknown)).toContain("SECURITY_INVALID");

    const unknownGlobal = compileDocument(
      baseDocument(
        { "/x": { get: operation() } },
        { security: [{ missing: [] }] },
      ),
    );
    expect(codes(unknownGlobal)).toContain("SECURITY_INVALID");
    expect(unknownGlobal.tools).toHaveLength(0);

    const invalid = compileDocument(
      baseDocument(
        { "/x": { get: operation() } },
        {
          components: {
            securitySchemes: { key: { type: "apiKey", name: "X-Key" } },
          },
        },
      ),
    );
    expect(codes(invalid)).toContain("SECURITY_SCHEME_INVALID");
  });

  it("rejects mutualTLS in OpenAPI 3.0 (invalid) and 3.1 in strict mode, accepts with warning in permissive mode", () => {
    const document = (version: string) =>
      baseDocument(
        { "/x": { get: operation({ security: [{ mtls: [] }] }) } },
        {
          components: {
            securitySchemes: { mtls: { type: "mutualTLS" } },
          },
        },
        version,
      );

    const result30 = compileDocument(document("3.0.3"));
    expect(result30.ok).toBe(false);
    expect(codes(result30)).toContain("SECURITY_SCHEME_INVALID");

    const result31Strict = compileDocument(document("3.1.0"));
    expect(result31Strict.ok).toBe(false);
    expect(codes(result31Strict)).toContain("UNSUPPORTED_SECURITY_SCHEME");
    expect(
      result31Strict.diagnostics.find(
        (d) => d.code === "UNSUPPORTED_SECURITY_SCHEME",
      )?.severity,
    ).toBe("error");

    const result31Permissive = compileDocument(document("3.1.0"), {
      strict: false,
    });
    expect(result31Permissive.ok).toBe(true);
    expect(codes(result31Permissive)).toContain("UNSUPPORTED_SECURITY_SCHEME");
    expect(
      result31Permissive.diagnostics.find(
        (d) => d.code === "UNSUPPORTED_SECURITY_SCHEME",
      )?.severity,
    ).toBe("warning");
    expect(
      result31Permissive.manifest.warnings?.some(
        (w) => w.code === "UNSUPPORTED_SECURITY_SCHEME",
      ),
    ).toBe(true);
    expect(result31Permissive.securitySchemes.mtls).toEqual({
      name: "mtls",
      type: "mutualTLS",
    });
    expect(
      singleTool(result31Permissive).authentication.alternatives[0]?.schemes[0],
    ).toEqual({ name: "mtls", type: "mutualTLS", scopes: [] });
  });

  it("builds explicit OR/AND policies and preserves anonymous alternatives", () => {
    const flows = {
      clientCredentials: {
        tokenUrl: "https://example.com/token",
        scopes: { read: "Read" },
      },
    };
    const result = compileDocument(
      baseDocument(
        {
          "/x": {
            get: operation({
              security: [{ key: [] }, { oauth: ["read", "read"] }, {}],
            }),
          },
        },
        {
          components: {
            securitySchemes: {
              key: { type: "apiKey", name: "X-Key", in: "header" },
              oauth: { type: "oauth2", flows },
            },
          },
        },
      ),
    );

    expect(singleTool(result).authentication).toEqual({
      alternatives: [
        {
          schemes: [
            {
              name: "key",
              type: "apiKey",
              scopes: [],
              parameterName: "X-Key",
              parameterLocation: "header",
            },
          ],
        },
        {
          schemes: [
            {
              name: "oauth",
              type: "oauth2",
              scopes: ["read"],
              flows,
            },
          ],
        },
        { schemes: [] },
      ],
      allowsAnonymous: true,
    });
  });

  it("rejects scopes on non-OAuth schemes", () => {
    const result = compileDocument(
      baseDocument(
        {
          "/x": {
            get: operation({ security: [{ key: ["read"] }] }),
          },
        },
        {
          components: {
            securitySchemes: {
              key: { type: "apiKey", name: "X-Key", in: "header" },
            },
          },
        },
      ),
    );

    expect(codes(result)).toContain("SECURITY_REQUIREMENT_INVALID");
    expect(result.tools).toHaveLength(0);
  });

  it("rejects undeclared OAuth2 scopes in strict mode and warns in permissive mode", () => {
    const document = baseDocument(
      {
        "/x": {
          get: operation({ security: [{ oauth: ["write"] }] }),
        },
      },
      {
        components: {
          securitySchemes: {
            oauth: {
              type: "oauth2",
              flows: {
                clientCredentials: {
                  tokenUrl: "https://example.com/token",
                  scopes: { read: "Read" },
                },
              },
            },
          },
        },
      },
    );

    const strict = compileDocument(document);
    expect(strict.ok).toBe(false);
    expect(strict.tools).toHaveLength(0);
    expect(codes(strict)).toContain("SECURITY_REQUIREMENT_INVALID");

    const permissive = compileDocument(document, { strict: false });
    expect(permissive.ok).toBe(true);
    expect(
      permissive.diagnostics.find(
        (diagnostic) => diagnostic.code === "SECURITY_REQUIREMENT_INVALID",
      )?.severity,
    ).toBe("warning");
    expect(
      singleTool(permissive).authentication.alternatives[0]?.schemes[0]?.scopes,
    ).toEqual(["write"]);
  });

  it("preserves OpenID Connect scopes without a declared scope catalog in permissive mode", () => {
    const result = compileDocument(
      baseDocument(
        {
          "/x": {
            get: operation({ security: [{ oidc: ["email"] }] }),
          },
        },
        {
          components: {
            securitySchemes: {
              oidc: {
                type: "openIdConnect",
                openIdConnectUrl:
                  "https://example.com/.well-known/openid-configuration",
              },
            },
          },
        },
      ),
      { strict: false },
    );

    expect(result.ok).toBe(true);
    expect(codes(result)).toContain("UNSUPPORTED_SECURITY_SCHEME");
    expect(
      result.diagnostics.find((d) => d.code === "UNSUPPORTED_SECURITY_SCHEME")
        ?.severity,
    ).toBe("warning");
    expect(
      singleTool(result).authentication.alternatives[0]?.schemes[0],
    ).toEqual({
      name: "oidc",
      type: "openIdConnect",
      scopes: ["email"],
      openIdConnectUrl: "https://example.com/.well-known/openid-configuration",
    });
  });

  it("includes authentication details in per-tool hashes", () => {
    const compileWith = (parameterName: string) =>
      compileDocument(
        baseDocument(
          {
            "/x": {
              get: operation({
                operationId: "x",
                security: [{ key: [] }],
              }),
            },
          },
          {
            components: {
              securitySchemes: {
                key: {
                  type: "apiKey",
                  name: parameterName,
                  in: "header",
                },
              },
            },
          },
        ),
      );

    expect(
      diffManifests(
        compileWith("X-One").manifest,
        compileWith("X-Two").manifest,
      ),
    ).toEqual({
      added: [],
      removed: [],
      changed: ["x"],
      unchanged: [],
    });
  });
});

describe("document validation", () => {
  it("reports parse and document failures", () => {
    expect(codes(compileOpenApi("openapi: ["))).toContain(
      "SOURCE_PARSE_FAILED",
    );
    expect(codes(compileOpenApi("a: 1\n---\nb: 2"))).toContain(
      "SOURCE_PARSE_FAILED",
    );
    expect(codes(compileOpenApi("[]"))).toContain("DOCUMENT_INVALID");
    expect(codes(compileOpenApi("openapi: 3.0.0\nopenapi: 3.0.1\n"))).toContain(
      "SOURCE_PARSE_FAILED",
    );
  });

  it("rejects unsupported versions and malformed roots", () => {
    expect(
      codes(
        compileDocument({
          openapi: "2.0",
          info: { title: "Old", version: "1" },
          paths: {},
        }),
      ),
    ).toContain("OPENAPI_VERSION_UNSUPPORTED");

    expect(
      codes(
        compileDocument({
          openapi: "3.0.3",
          info: { title: "", version: "1" },
          paths: {},
        }),
      ),
    ).toContain("DOCUMENT_INVALID");

    expect(
      codes(
        compileDocument({
          openapi: "3.0.3",
          info: { title: "Test", version: "1" },
          paths: [],
        }),
      ),
    ).toContain("DOCUMENT_INVALID");
  });

  it("rejects invalid paths and operations", () => {
    expect(
      codes(compileDocument(baseDocument({ pets: { get: operation() } }))),
    ).toContain("PATH_INVALID");

    expect(
      codes(
        compileDocument(
          baseDocument({
            "/x": { get: { operationId: "x" } },
          }),
        ),
      ),
    ).toContain("OPERATION_INVALID");

    expect(
      codes(
        compileDocument(
          baseDocument({
            "/x": { get: "not an operation" },
          }),
        ),
      ),
    ).toContain("OPERATION_INVALID");
  });

  it("excludes deprecated operations by default", () => {
    const document = baseDocument({
      "/x": {
        get: operation({ operationId: "old", deprecated: true }),
      },
    });
    const excluded = compileDocument(document);
    expect(excluded.ok).toBe(true);
    expect(excluded.tools).toHaveLength(0);
    expect(codes(excluded)).toContain("DEPRECATED_OPERATION");

    const included = compileDocument(document, { includeDeprecated: true });
    expect(included.tools.map((tool) => tool.name)).toEqual(["old"]);

    const invalid = compileDocument(
      baseDocument({
        "/x": { get: operation({ deprecated: "yes" }) },
      }),
    );
    expect(invalid.ok).toBe(false);
    expect(codes(invalid)).toContain("OPERATION_INVALID");
  });

  it("enforces source and operation limits", () => {
    const sourceTooLarge = compileDocument(
      baseDocument({ "/x": { get: operation() } }),
      { maxSourceBytes: 10 },
    );
    expect(codes(sourceTooLarge)).toContain("SOURCE_TOO_LARGE");
    expect(sourceTooLarge.tools).toHaveLength(0);

    const operationLimit = compileDocument(
      baseDocument({
        "/a": { get: operation({ operationId: "a" }) },
        "/b": { get: operation({ operationId: "b" }) },
      }),
      { maxOperations: 1 },
    );
    expect(operationLimit.tools.map((tool) => tool.name)).toEqual(["a"]);
    expect(codes(operationLimit)).toContain("OPERATION_LIMIT_EXCEEDED");
  });

  it("does not let prototype-sensitive names pollute result objects", () => {
    const result = compileDocument(
      baseDocument(
        {
          "/x": {
            get: operation({
              parameters: [
                {
                  name: "__proto__",
                  in: "query",
                  schema: { type: "string" },
                },
              ],
              security: [Object.fromEntries([["__proto__", []]])],
            }),
          },
        },
        {
          components: {
            securitySchemes: Object.fromEntries([
              ["__proto__", { type: "apiKey", name: "X-Key", in: "header" }],
            ]),
          },
        },
      ),
    );

    expect(result.ok).toBe(true);
    const tool = singleTool(result);
    expect(
      Object.hasOwn(tool.inputSchema.properties as object, "__proto__"),
    ).toBe(true);
    expect(Object.hasOwn(result.securitySchemes, "__proto__")).toBe(true);
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(result.securitySchemes)).toBe(
      Object.prototype,
    );
  });

  it("validates compiler options", () => {
    expect(() => compileOpenApi("{}", { maxRefDepth: 0 })).toThrow(TypeError);
    expect(() =>
      compileOpenApi("{}", {
        maxSourceBytes: MAX_SOURCE_BYTES_LIMIT + 1,
      }),
    ).toThrow(TypeError);
    expect(() =>
      compileOpenApi("{}", { strict: "yes" as unknown as boolean }),
    ).toThrow(TypeError);
    expect(() =>
      compileOpenApi("{}", null as unknown as CompileOptions),
    ).toThrow(TypeError);
  });
});

describe("RM-05 OpenAPI ignored constructs rejection and validation", () => {
  it("rejects operation-level servers in strict mode and warns in permissive mode", () => {
    const doc = baseDocument({
      "/items": {
        get: operation({
          servers: [{ url: "https://override.example.com" }],
        }),
      },
    });

    // strict: true (default)
    const strictResult = compileDocument(doc, { strict: true });
    expect(strictResult.ok).toBe(false);
    expect(codes(strictResult)).toContain("UNSUPPORTED_SERVERS");
    const strictDiag = strictResult.diagnostics.find(
      (d) => d.code === "UNSUPPORTED_SERVERS",
    );
    expect(strictDiag?.severity).toBe("error");
    expect(strictDiag?.location).toBe("#/paths/~1items/get/servers");
    expect(strictDiag?.message).toContain(
      "Operation 'servers' override is not supported",
    );
    expect(strictDiag?.message).toContain("strict: false");
    expect(strictResult.tools).toHaveLength(0);

    // strict: false (permissive mode)
    const permissiveResult = compileDocument(doc, { strict: false });
    expect(permissiveResult.ok).toBe(true);
    expect(codes(permissiveResult)).toContain("UNSUPPORTED_SERVERS");
    const permissiveDiag = permissiveResult.diagnostics.find(
      (d) => d.code === "UNSUPPORTED_SERVERS",
    );
    expect(permissiveDiag?.severity).toBe("warning");
    expect(permissiveResult.tools).toHaveLength(1);
    expect(permissiveResult.manifest.warnings).toBeDefined();
    expect(
      permissiveResult.manifest.warnings?.some(
        (w) => w.code === "UNSUPPORTED_SERVERS",
      ),
    ).toBe(true);
    expect(
      permissiveResult.tools[0]?.warnings?.some(
        (w) => w.code === "UNSUPPORTED_SERVERS",
      ),
    ).toBe(true);
  });

  it("rejects path-item-level servers in strict mode and warns in permissive mode", () => {
    const doc = baseDocument({
      "/items": {
        servers: [{ url: "https://path-override.example.com" }],
        get: operation(),
      },
    });

    const strictResult = compileDocument(doc, { strict: true });
    expect(strictResult.ok).toBe(false);
    expect(codes(strictResult)).toContain("UNSUPPORTED_SERVERS");
    const strictDiag = strictResult.diagnostics.find(
      (d) => d.code === "UNSUPPORTED_SERVERS",
    );
    expect(strictDiag?.severity).toBe("error");
    expect(strictDiag?.location).toBe("#/paths/~1items/servers");
    expect(strictResult.tools).toHaveLength(0);

    const permissiveResult = compileDocument(doc, { strict: false });
    expect(permissiveResult.ok).toBe(true);
    expect(codes(permissiveResult)).toContain("UNSUPPORTED_SERVERS");
    const permissiveDiag = permissiveResult.diagnostics.find(
      (d) => d.code === "UNSUPPORTED_SERVERS",
    );
    expect(permissiveDiag?.severity).toBe("warning");
    expect(permissiveResult.tools).toHaveLength(1);
    expect(
      permissiveResult.manifest.warnings?.some(
        (w) => w.code === "UNSUPPORTED_SERVERS",
      ),
    ).toBe(true);
    expect(
      permissiveResult.tools[0]?.warnings?.some(
        (w) => w.code === "UNSUPPORTED_SERVERS",
      ),
    ).toBe(true);
  });

  it("rejects operation-level callbacks in strict mode and warns in permissive mode", () => {
    const doc = baseDocument({
      "/items": {
        post: operation({
          callbacks: {
            onEvent: {
              "{$request.body#/callbackUrl}": {
                post: {
                  responses: { "200": { description: "callback received" } },
                },
              },
            },
          },
        }),
      },
    });

    const strictResult = compileDocument(doc, { strict: true });
    expect(strictResult.ok).toBe(false);
    expect(codes(strictResult)).toContain("UNSUPPORTED_CALLBACKS");
    const strictDiag = strictResult.diagnostics.find(
      (d) => d.code === "UNSUPPORTED_CALLBACKS",
    );
    expect(strictDiag?.severity).toBe("error");
    expect(strictDiag?.location).toBe("#/paths/~1items/post/callbacks");
    expect(strictDiag?.message).toContain(
      "Operation 'callbacks' (inbound webhooks) are not supported",
    );
    expect(strictResult.tools).toHaveLength(0);

    const permissiveResult = compileDocument(doc, { strict: false });
    expect(permissiveResult.ok).toBe(true);
    expect(codes(permissiveResult)).toContain("UNSUPPORTED_CALLBACKS");
    const permissiveDiag = permissiveResult.diagnostics.find(
      (d) => d.code === "UNSUPPORTED_CALLBACKS",
    );
    expect(permissiveDiag?.severity).toBe("warning");
    expect(permissiveResult.tools).toHaveLength(1);
    expect(
      permissiveResult.manifest.warnings?.some(
        (w) => w.code === "UNSUPPORTED_CALLBACKS",
      ),
    ).toBe(true);
    expect(
      permissiveResult.tools[0]?.warnings?.some(
        (w) => w.code === "UNSUPPORTED_CALLBACKS",
      ),
    ).toBe(true);
  });

  it("rejects non-default parameter style, explode, and allowReserved combinations in strict mode and warns in permissive mode", () => {
    const docWithCustomStyle = baseDocument({
      "/items": {
        get: operation({
          parameters: [
            {
              name: "filter",
              in: "query",
              style: "deepObject",
              schema: { type: "object" },
            },
          ],
        }),
      },
    });

    // style: "deepObject"
    const strictStyle = compileDocument(docWithCustomStyle, { strict: true });
    expect(strictStyle.ok).toBe(false);
    expect(codes(strictStyle)).toContain("PARAMETER_UNSUPPORTED");
    const styleDiag = strictStyle.diagnostics.find(
      (d) => d.code === "PARAMETER_UNSUPPORTED",
    );
    expect(styleDiag?.severity).toBe("error");
    expect(styleDiag?.location).toBe("#/paths/~1items/get/parameters/0/style");
    expect(styleDiag?.message).toContain(
      "Query parameter 'filter' specifies unsupported style 'deepObject'",
    );
    expect(styleDiag?.message).toContain("only 'form' is supported");

    const permissiveStyle = compileDocument(docWithCustomStyle, {
      strict: false,
    });
    expect(permissiveStyle.ok).toBe(true);
    expect(codes(permissiveStyle)).toContain("PARAMETER_UNSUPPORTED");
    expect(
      permissiveStyle.manifest.warnings?.some(
        (w) => w.code === "PARAMETER_UNSUPPORTED",
      ),
    ).toBe(true);

    // explode: false
    const docWithExplodeFalse = baseDocument({
      "/items": {
        get: operation({
          parameters: [
            {
              name: "tags",
              in: "query",
              explode: false,
              schema: { type: "array", items: { type: "string" } },
            },
          ],
        }),
      },
    });

    const strictExplode = compileDocument(docWithExplodeFalse, {
      strict: true,
    });
    expect(strictExplode.ok).toBe(false);
    expect(codes(strictExplode)).toContain("PARAMETER_UNSUPPORTED");
    const explodeDiag = strictExplode.diagnostics.find(
      (d) => d.code === "PARAMETER_UNSUPPORTED",
    );
    expect(explodeDiag?.severity).toBe("error");
    expect(explodeDiag?.location).toBe(
      "#/paths/~1items/get/parameters/0/explode",
    );
    expect(explodeDiag?.message).toContain(
      "Query parameter 'tags' specifies unsupported explode: false",
    );

    const permissiveExplode = compileDocument(docWithExplodeFalse, {
      strict: false,
    });
    expect(permissiveExplode.ok).toBe(true);
    expect(codes(permissiveExplode)).toContain("PARAMETER_UNSUPPORTED");
    expect(
      permissiveExplode.manifest.warnings?.some(
        (w) => w.code === "PARAMETER_UNSUPPORTED",
      ),
    ).toBe(true);

    // allowReserved: true
    const docWithAllowReserved = baseDocument({
      "/items": {
        get: operation({
          parameters: [
            {
              name: "queryParam",
              in: "query",
              allowReserved: true,
              schema: { type: "string" },
            },
          ],
        }),
      },
    });

    const strictReserved = compileDocument(docWithAllowReserved, {
      strict: true,
    });
    expect(strictReserved.ok).toBe(false);
    expect(codes(strictReserved)).toContain("PARAMETER_UNSUPPORTED");
    const reservedDiag = strictReserved.diagnostics.find(
      (d) => d.code === "PARAMETER_UNSUPPORTED",
    );
    expect(reservedDiag?.severity).toBe("error");
    expect(reservedDiag?.location).toBe(
      "#/paths/~1items/get/parameters/0/allowReserved",
    );
    expect(reservedDiag?.message).toContain(
      "Query parameter 'queryParam' specifies unsupported allowReserved: true",
    );

    const permissiveReserved = compileDocument(docWithAllowReserved, {
      strict: false,
    });
    expect(permissiveReserved.ok).toBe(true);
    expect(codes(permissiveReserved)).toContain("PARAMETER_UNSUPPORTED");
    expect(
      permissiveReserved.manifest.warnings?.some(
        (w) => w.code === "PARAMETER_UNSUPPORTED",
      ),
    ).toBe(true);
  });

  it("accepts default parameter style, explode, and allowReserved combinations without warnings", () => {
    const doc = baseDocument({
      "/items/{itemId}": {
        get: operation({
          parameters: [
            {
              name: "itemId",
              in: "path",
              required: true,
              style: "simple",
              explode: false,
              schema: { type: "string" },
            },
            {
              name: "q",
              in: "query",
              style: "form",
              explode: true,
              allowReserved: false,
              schema: { type: "string" },
            },
            {
              name: "X-Trace",
              in: "header",
              style: "simple",
              explode: false,
              schema: { type: "string" },
            },
          ],
        }),
      },
    });

    const result = compileDocument(doc, { strict: true });
    expect(result.ok).toBe(true);
    expect(result.tools).toHaveLength(1);
    expect(codes(result)).not.toContain("PARAMETER_UNSUPPORTED");
    expect(codes(result)).not.toContain("PARAMETER_INVALID");
    expect(result.manifest.warnings).toBeUndefined();
  });

  it("rejects unknown parameter keys in strict mode and warns in permissive mode", () => {
    const docWithUnknown = baseDocument({
      "/items": {
        get: operation({
          parameters: [
            {
              name: "search",
              in: "query",
              unknownProp: "badValue",
              schema: { type: "string" },
            },
          ],
        }),
      },
    });

    const strictResult = compileDocument(docWithUnknown, { strict: true });
    expect(strictResult.ok).toBe(false);
    expect(codes(strictResult)).toContain("PARAMETER_INVALID");
    const diag = strictResult.diagnostics.find(
      (d) => d.code === "PARAMETER_INVALID",
    );
    expect(diag?.severity).toBe("error");
    expect(diag?.location).toBe("#/paths/~1items/get/parameters/0");
    expect(diag?.message).toContain(
      "Unsupported parameter field 'unknownProp'",
    );
    expect(diag?.message).toContain("x-unknownProp");

    const permissiveResult = compileDocument(docWithUnknown, { strict: false });
    expect(permissiveResult.ok).toBe(true);
    expect(codes(permissiveResult)).toContain("PARAMETER_INVALID");
    const warnDiag = permissiveResult.diagnostics.find(
      (d) => d.code === "PARAMETER_INVALID",
    );
    expect(warnDiag?.severity).toBe("warning");
    expect(permissiveResult.tools).toHaveLength(1);
    expect(
      permissiveResult.manifest.warnings?.some(
        (w) => w.code === "PARAMETER_INVALID",
      ),
    ).toBe(true);

    // Extension fields (x-*) are allowed
    const docWithExtension = baseDocument({
      "/items": {
        get: operation({
          parameters: [
            {
              name: "search",
              in: "query",
              "x-custom-field": "goodValue",
              schema: { type: "string" },
            },
          ],
        }),
      },
    });
    const extResult = compileDocument(docWithExtension, { strict: true });
    expect(extResult.ok).toBe(true);
    expect(codes(extResult)).not.toContain("PARAMETER_INVALID");
  });

  it("does not swallow any diagnostics: all are returned in the diagnostics array", () => {
    const doc = baseDocument({
      "/items": {
        servers: [{ url: "https://override.example.com" }],
        get: operation({
          callbacks: { cb: {} },
          parameters: [
            {
              name: "filter",
              in: "query",
              style: "deepObject",
              schema: { type: "object" },
            },
          ],
        }),
      },
    });

    const result = compileDocument(doc, { strict: false });
    expect(result.ok).toBe(true);
    const resultCodes = codes(result);
    expect(resultCodes).toContain("UNSUPPORTED_SERVERS");
    expect(resultCodes).toContain("UNSUPPORTED_CALLBACKS");
    expect(resultCodes).toContain("PARAMETER_UNSUPPORTED");

    // All diagnostics must have code, message, severity, and location
    for (const d of result.diagnostics) {
      expect(typeof d.code).toBe("string");
      expect(typeof d.message).toBe("string");
      expect(d.message.length).toBeGreaterThan(0);
      expect(d.severity === "error" || d.severity === "warning").toBe(true);
      expect(typeof d.location).toBe("string");
      expect(d.location?.startsWith("#")).toBe(true);
    }
  });
});

describe("RM-09 unsupported security schemes rejection and warning", () => {
  const oidcDoc = (version = "3.1.0") =>
    baseDocument(
      {
        "/users": {
          get: operation({
            operationId: "getUsers",
            security: [{ oidcAuth: ["read:users"] }],
          }),
        },
      },
      {
        components: {
          securitySchemes: {
            oidcAuth: {
              type: "openIdConnect",
              openIdConnectUrl:
                "https://auth.example.com/.well-known/openid-configuration",
            },
          },
        },
      },
      version,
    );

  const mtlsDoc = (version = "3.1.0") =>
    baseDocument(
      {
        "/secure": {
          get: operation({
            operationId: "getSecure",
            security: [{ mtlsAuth: [] }],
          }),
        },
      },
      {
        components: {
          securitySchemes: {
            mtlsAuth: {
              type: "mutualTLS",
              description: "Client certificate authentication",
            },
          },
        },
      },
      version,
    );

  it("rejects openIdConnect in strict mode with UNSUPPORTED_SECURITY_SCHEME", () => {
    const result = compileDocument(oidcDoc());
    expect(result.ok).toBe(false);
    const diagnostic = result.diagnostics.find(
      (d) => d.code === "UNSUPPORTED_SECURITY_SCHEME",
    );
    expect(diagnostic).toBeDefined();
    expect(diagnostic?.severity).toBe("error");
    expect(diagnostic?.location).toBe("#/components/securitySchemes/oidcAuth");
    expect(diagnostic?.message).toContain("openIdConnect");
  });

  it("accepts openIdConnect in permissive mode with warning in manifest", () => {
    const result = compileDocument(oidcDoc(), { strict: false });
    expect(result.ok).toBe(true);
    const diagnostic = result.diagnostics.find(
      (d) => d.code === "UNSUPPORTED_SECURITY_SCHEME",
    );
    expect(diagnostic).toBeDefined();
    expect(diagnostic?.severity).toBe("warning");
    expect(diagnostic?.location).toBe("#/components/securitySchemes/oidcAuth");
    expect(
      result.manifest.warnings?.some(
        (w) => w.code === "UNSUPPORTED_SECURITY_SCHEME",
      ),
    ).toBe(true);
    expect(result.securitySchemes.oidcAuth).toEqual({
      name: "oidcAuth",
      type: "openIdConnect",
      openIdConnectUrl:
        "https://auth.example.com/.well-known/openid-configuration",
    });
  });

  it("rejects mutualTLS in OpenAPI 3.1 in strict mode with UNSUPPORTED_SECURITY_SCHEME", () => {
    const result = compileDocument(mtlsDoc("3.1.0"));
    expect(result.ok).toBe(false);
    const diagnostic = result.diagnostics.find(
      (d) => d.code === "UNSUPPORTED_SECURITY_SCHEME",
    );
    expect(diagnostic).toBeDefined();
    expect(diagnostic?.severity).toBe("error");
    expect(diagnostic?.location).toBe("#/components/securitySchemes/mtlsAuth");
    expect(diagnostic?.message).toContain("mutualTLS");
  });

  it("accepts mutualTLS in permissive mode with warning in manifest", () => {
    const result = compileDocument(mtlsDoc("3.1.0"), { strict: false });
    expect(result.ok).toBe(true);
    const diagnostic = result.diagnostics.find(
      (d) => d.code === "UNSUPPORTED_SECURITY_SCHEME",
    );
    expect(diagnostic).toBeDefined();
    expect(diagnostic?.severity).toBe("warning");
    expect(diagnostic?.location).toBe("#/components/securitySchemes/mtlsAuth");
    expect(
      result.manifest.warnings?.some(
        (w) => w.code === "UNSUPPORTED_SECURITY_SCHEME",
      ),
    ).toBe(true);
    expect(result.securitySchemes.mtlsAuth).toEqual({
      name: "mtlsAuth",
      type: "mutualTLS",
      description: "Client certificate authentication",
    });
  });

  it("compiles supported schemes (apiKey, http, oauth2) without UNSUPPORTED_SECURITY_SCHEME diagnostics", () => {
    const doc = baseDocument(
      {
        "/pets": {
          get: operation({
            operationId: "getPets",
            security: [
              { apiKeyHeader: [] },
              { bearerHttp: [] },
              { basicHttp: [] },
              { oauthClient: ["read:pets"] },
            ],
          }),
        },
      },
      {
        components: {
          securitySchemes: {
            apiKeyHeader: {
              type: "apiKey",
              in: "header",
              name: "X-API-Key",
            },
            bearerHttp: {
              type: "http",
              scheme: "bearer",
              bearerFormat: "JWT",
            },
            basicHttp: {
              type: "http",
              scheme: "basic",
            },
            oauthClient: {
              type: "oauth2",
              flows: {
                clientCredentials: {
                  tokenUrl: "https://auth.example.com/oauth/token",
                  scopes: { "read:pets": "Read pets" },
                },
              },
            },
          },
        },
      },
    );

    const result = compileDocument(doc, { strict: true });
    expect(result.ok).toBe(true);
    expect(codes(result)).not.toContain("UNSUPPORTED_SECURITY_SCHEME");
    expect(result.manifest.warnings).toBeUndefined();
    expect(Object.keys(result.securitySchemes).sort()).toEqual([
      "apiKeyHeader",
      "basicHttp",
      "bearerHttp",
      "oauthClient",
    ]);
  });
});

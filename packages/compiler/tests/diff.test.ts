import { describe, expect, it } from "vitest";
import { diffContracts, type ContractDiffTool } from "../src/index.js";

describe("RM-12: Contract Diffing & Breaking Change Taxonomy", () => {
  it("classifies tool removal as breaking", () => {
    const prevTools: ContractDiffTool[] = [
      { name: "getPet", method: "get", path: "/pets/{id}" },
      { name: "deletePet", method: "delete", path: "/pets/{id}" },
    ];
    const nextTools: ContractDiffTool[] = [
      { name: "getPet", method: "get", path: "/pets/{id}" },
    ];

    const result = diffContracts(prevTools, nextTools);
    expect(result.schemaVersion).toBe(1);
    expect(result.hasChanges).toBe(true);
    expect(result.hasBreakingChanges).toBe(true);
    expect(result.hasPotentiallyBreakingChanges).toBe(false);
    expect(result.removedTools).toEqual(["deletePet"]);
    expect(result.breaking).toHaveLength(1);
    expect(result.breaking[0]).toMatchObject({
      classification: "breaking",
      code: "TOOL_REMOVED",
      tool: "deletePet",
    });
  });

  it("classifies tool renaming as breaking", () => {
    const prevTools: ContractDiffTool[] = [
      { name: "findPetById", method: "get", path: "/pets/{id}" },
    ];
    const nextTools: ContractDiffTool[] = [
      { name: "getPetById", method: "get", path: "/pets/{id}" },
    ];

    const result = diffContracts(prevTools, nextTools);
    expect(result.hasBreakingChanges).toBe(true);
    expect(result.removedTools).toContain("findPetById");
    expect(result.addedTools).toContain("getPetById");
    expect(result.breaking.some((c) => c.code === "TOOL_RENAMED")).toBe(true);
  });

  it("classifies new tool added as non-breaking", () => {
    const prevTools: ContractDiffTool[] = [
      { name: "getPet", method: "get", path: "/pets/{id}" },
    ];
    const nextTools: ContractDiffTool[] = [
      { name: "getPet", method: "get", path: "/pets/{id}" },
      { name: "createPet", method: "post", path: "/pets" },
    ];

    const result = diffContracts(prevTools, nextTools);
    expect(result.hasChanges).toBe(true);
    expect(result.hasBreakingChanges).toBe(false);
    expect(result.hasPotentiallyBreakingChanges).toBe(false);
    expect(result.addedTools).toEqual(["createPet"]);
    expect(result.nonBreaking.some((c) => c.code === "TOOL_ADDED")).toBe(true);
  });

  it("classifies adding a new required input parameter as breaking", () => {
    const prevTools: ContractDiffTool[] = [
      {
        name: "listPets",
        inputSchema: {
          type: "object",
          properties: {
            limit: { type: "integer" },
          },
          required: [],
        },
      },
    ];
    const nextTools: ContractDiffTool[] = [
      {
        name: "listPets",
        inputSchema: {
          type: "object",
          properties: {
            limit: { type: "integer" },
            tenantId: { type: "string" },
          },
          required: ["tenantId"],
        },
      },
    ];

    const result = diffContracts(prevTools, nextTools);
    expect(result.hasBreakingChanges).toBe(true);
    expect(result.breaking.some((c) => c.code === "INPUT_REQUIRED_ADDED")).toBe(
      true,
    );
  });

  it("classifies adding a new optional input parameter as non-breaking", () => {
    const prevTools: ContractDiffTool[] = [
      {
        name: "listPets",
        inputSchema: {
          type: "object",
          properties: {
            limit: { type: "integer" },
          },
          required: [],
        },
      },
    ];
    const nextTools: ContractDiffTool[] = [
      {
        name: "listPets",
        inputSchema: {
          type: "object",
          properties: {
            limit: { type: "integer" },
            offset: { type: "integer" },
          },
          required: [],
        },
      },
    ];

    const result = diffContracts(prevTools, nextTools);
    expect(result.hasBreakingChanges).toBe(false);
    expect(result.hasPotentiallyBreakingChanges).toBe(false);
    expect(
      result.nonBreaking.some((c) => c.code === "INPUT_OPTIONAL_ADDED"),
    ).toBe(true);
  });

  it("classifies removing an input parameter as breaking", () => {
    const prevTools: ContractDiffTool[] = [
      {
        name: "listPets",
        inputSchema: {
          type: "object",
          properties: {
            limit: { type: "integer" },
            filter: { type: "string" },
          },
          required: [],
        },
      },
    ];
    const nextTools: ContractDiffTool[] = [
      {
        name: "listPets",
        inputSchema: {
          type: "object",
          properties: {
            limit: { type: "integer" },
          },
          required: [],
        },
      },
    ];

    const result = diffContracts(prevTools, nextTools);
    expect(result.hasBreakingChanges).toBe(true);
    expect(
      result.breaking.some((c) => c.code === "INPUT_PROPERTY_REMOVED"),
    ).toBe(true);
  });

  it("classifies optional input becoming required as potentially breaking", () => {
    const prevTools: ContractDiffTool[] = [
      {
        name: "listPets",
        inputSchema: {
          type: "object",
          properties: {
            limit: { type: "integer" },
          },
          required: [],
        },
      },
    ];
    const nextTools: ContractDiffTool[] = [
      {
        name: "listPets",
        inputSchema: {
          type: "object",
          properties: {
            limit: { type: "integer" },
          },
          required: ["limit"],
        },
      },
    ];

    const result = diffContracts(prevTools, nextTools);
    expect(result.hasBreakingChanges).toBe(false);
    expect(result.hasPotentiallyBreakingChanges).toBe(true);
    expect(
      result.potentiallyBreaking.some(
        (c) => c.code === "INPUT_BECAME_REQUIRED",
      ),
    ).toBe(true);
  });

  it("classifies required input becoming optional as non-breaking", () => {
    const prevTools: ContractDiffTool[] = [
      {
        name: "listPets",
        inputSchema: {
          type: "object",
          properties: {
            limit: { type: "integer" },
          },
          required: ["limit"],
        },
      },
    ];
    const nextTools: ContractDiffTool[] = [
      {
        name: "listPets",
        inputSchema: {
          type: "object",
          properties: {
            limit: { type: "integer" },
          },
          required: [],
        },
      },
    ];

    const result = diffContracts(prevTools, nextTools);
    expect(result.hasBreakingChanges).toBe(false);
    expect(result.hasPotentiallyBreakingChanges).toBe(false);
    expect(
      result.nonBreaking.some((c) => c.code === "INPUT_BECAME_OPTIONAL"),
    ).toBe(true);
  });

  it("classifies input type narrowing as breaking", () => {
    const prevTools: ContractDiffTool[] = [
      {
        name: "listPets",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: ["string", "integer"] },
          },
        },
      },
    ];
    const nextTools: ContractDiffTool[] = [
      {
        name: "listPets",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string" },
          },
        },
      },
    ];

    const result = diffContracts(prevTools, nextTools);
    expect(result.hasBreakingChanges).toBe(true);
    expect(result.breaking.some((c) => c.code === "INPUT_TYPE_NARROWED")).toBe(
      true,
    );
  });

  it("classifies input type widening as non-breaking", () => {
    const prevTools: ContractDiffTool[] = [
      {
        name: "listPets",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string" },
          },
        },
      },
    ];
    const nextTools: ContractDiffTool[] = [
      {
        name: "listPets",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: ["string", "integer"] },
          },
        },
      },
    ];

    const result = diffContracts(prevTools, nextTools);
    expect(result.hasBreakingChanges).toBe(false);
    expect(
      result.nonBreaking.some((c) => c.code === "INPUT_TYPE_WIDENED"),
    ).toBe(true);
  });

  it("classifies input enum value removal as breaking", () => {
    const prevTools: ContractDiffTool[] = [
      {
        name: "findPets",
        inputSchema: {
          type: "object",
          properties: {
            status: { type: "string", enum: ["available", "pending", "sold"] },
          },
        },
      },
    ];
    const nextTools: ContractDiffTool[] = [
      {
        name: "findPets",
        inputSchema: {
          type: "object",
          properties: {
            status: { type: "string", enum: ["available", "sold"] },
          },
        },
      },
    ];

    const result = diffContracts(prevTools, nextTools);
    expect(result.hasBreakingChanges).toBe(true);
    expect(
      result.breaking.some((c) => c.code === "INPUT_ENUM_VALUE_REMOVED"),
    ).toBe(true);
  });

  it("classifies input enum value addition as non-breaking", () => {
    const prevTools: ContractDiffTool[] = [
      {
        name: "findPets",
        inputSchema: {
          type: "object",
          properties: {
            status: { type: "string", enum: ["available", "sold"] },
          },
        },
      },
    ];
    const nextTools: ContractDiffTool[] = [
      {
        name: "findPets",
        inputSchema: {
          type: "object",
          properties: {
            status: {
              type: "string",
              enum: ["available", "sold", "reserved"],
            },
          },
        },
      },
    ];

    const result = diffContracts(prevTools, nextTools);
    expect(result.hasBreakingChanges).toBe(false);
    expect(
      result.nonBreaking.some((c) => c.code === "INPUT_ENUM_VALUE_ADDED"),
    ).toBe(true);
  });

  it("classifies default value changes as potentially breaking", () => {
    const prevTools: ContractDiffTool[] = [
      {
        name: "listPets",
        inputSchema: {
          type: "object",
          properties: {
            limit: { type: "integer", default: 20 },
          },
        },
      },
    ];
    const nextTools: ContractDiffTool[] = [
      {
        name: "listPets",
        inputSchema: {
          type: "object",
          properties: {
            limit: { type: "integer", default: 50 },
          },
        },
      },
    ];

    const result = diffContracts(prevTools, nextTools);
    expect(result.hasBreakingChanges).toBe(false);
    expect(result.hasPotentiallyBreakingChanges).toBe(true);
    expect(
      result.potentiallyBreaking.some(
        (c) => c.code === "INPUT_DEFAULT_CHANGED",
      ),
    ).toBe(true);
  });

  it("classifies tightening input constraints (minLength, maxLength, minimum, maximum, pattern) as breaking", () => {
    const prevTools: ContractDiffTool[] = [
      {
        name: "createPet",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", minLength: 1, maxLength: 100 },
            age: { type: "integer", minimum: 0, maximum: 50 },
            tag: { type: "string" },
          },
        },
      },
    ];
    const nextTools: ContractDiffTool[] = [
      {
        name: "createPet",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", minLength: 5, maxLength: 50 },
            age: { type: "integer", minimum: 1, maximum: 30 },
            tag: { type: "string", pattern: "^[a-z]+$" },
          },
        },
      },
    ];

    const result = diffContracts(prevTools, nextTools);
    expect(result.hasBreakingChanges).toBe(true);
    const tightened = result.breaking.filter(
      (c) => c.code === "INPUT_CONSTRAINT_TIGHTENED",
    );
    expect(tightened.length).toBe(5); // minLength increased, maxLength decreased, minimum increased, maximum decreased, pattern added
  });

  it("classifies description changes as non-breaking", () => {
    const prevTools: ContractDiffTool[] = [
      {
        name: "getPet",
        description: "Old description",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string", description: "Old field description" },
          },
        },
      },
    ];
    const nextTools: ContractDiffTool[] = [
      {
        name: "getPet",
        description: "New updated description",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string", description: "New field description" },
          },
        },
      },
    ];

    const result = diffContracts(prevTools, nextTools);
    expect(result.hasChanges).toBe(true);
    expect(result.hasBreakingChanges).toBe(false);
    expect(result.hasPotentiallyBreakingChanges).toBe(false);
    expect(
      result.nonBreaking.filter((c) => c.code === "DESCRIPTION_CHANGED").length,
    ).toBe(2);
  });

  it("classifies adding authentication requirement as breaking and relaxing as non-breaking", () => {
    const anonTools: ContractDiffTool[] = [
      {
        name: "getPublicPet",
        authentication: {
          allowsAnonymous: true,
          alternatives: [],
        },
      },
    ];
    const authTools: ContractDiffTool[] = [
      {
        name: "getPublicPet",
        authentication: {
          allowsAnonymous: false,
          alternatives: [
            {
              schemes: [
                {
                  name: "apiKeyAuth",
                  type: "apiKey",
                  parameterLocation: "header",
                  parameterName: "X-API-KEY",
                  scopes: [],
                },
              ],
            },
          ],
        },
      },
    ];

    const breakResult = diffContracts(anonTools, authTools);
    expect(breakResult.hasBreakingChanges).toBe(true);
    expect(
      breakResult.breaking.some((c) => c.code === "AUTH_REQUIREMENT_ADDED"),
    ).toBe(true);

    const relaxResult = diffContracts(authTools, anonTools);
    expect(relaxResult.hasBreakingChanges).toBe(false);
    expect(
      relaxResult.nonBreaking.some(
        (c) => c.code === "AUTH_REQUIREMENT_RELAXED",
      ),
    ).toBe(true);
  });

  it("classifies baseUrl origin change as breaking and path change as potentially breaking", () => {
    const prev = { baseUrl: "https://api.v1.example.com/v1", tools: [] };
    const nextOrigin = {
      baseUrl: "https://api.v2.example.com/v1",
      tools: [],
    };
    const nextPath = {
      baseUrl: "https://api.v1.example.com/v2",
      tools: [],
    };

    const originResult = diffContracts(prev, nextOrigin);
    expect(originResult.hasBreakingChanges).toBe(true);
    expect(
      originResult.breaking.some((c) => c.code === "BASE_URL_CHANGED"),
    ).toBe(true);

    const pathResult = diffContracts(prev, nextPath);
    expect(pathResult.hasBreakingChanges).toBe(false);
    expect(pathResult.hasPotentiallyBreakingChanges).toBe(true);
    expect(
      pathResult.potentiallyBreaking.some(
        (c) => c.code === "BASE_URL_PATH_CHANGED",
      ),
    ).toBe(true);
  });

  it("classifies removing required response field as breaking", () => {
    const prevTools: ContractDiffTool[] = [
      {
        name: "getPet",
        responses: [
          {
            status: "200",
            description: "Success",
            schema: {
              type: "object",
              properties: {
                id: { type: "string" },
                name: { type: "string" },
              },
              required: ["id", "name"],
            },
          },
        ],
      },
    ];
    const nextTools: ContractDiffTool[] = [
      {
        name: "getPet",
        responses: [
          {
            status: "200",
            description: "Success",
            schema: {
              type: "object",
              properties: {
                id: { type: "string" },
              },
              required: ["id"],
            },
          },
        ],
      },
    ];

    const result = diffContracts(prevTools, nextTools);
    expect(result.hasBreakingChanges).toBe(true);
    expect(
      result.breaking.some((c) => c.code === "RESPONSE_FIELD_REMOVED"),
    ).toBe(true);
  });

  it("classifies response field type changed incompatibly as breaking", () => {
    const prevTools: ContractDiffTool[] = [
      {
        name: "getPet",
        responses: [
          {
            status: "200",
            description: "Success",
            schema: {
              type: "object",
              properties: {
                id: { type: "string" },
              },
            },
          },
        ],
      },
    ];
    const nextTools: ContractDiffTool[] = [
      {
        name: "getPet",
        responses: [
          {
            status: "200",
            description: "Success",
            schema: {
              type: "object",
              properties: {
                id: { type: "integer" },
              },
            },
          },
        ],
      },
    ];

    const result = diffContracts(prevTools, nextTools);
    expect(result.hasBreakingChanges).toBe(true);
    expect(
      result.breaking.some((c) => c.code === "RESPONSE_TYPE_CHANGED"),
    ).toBe(true);
  });

  it("classifies adding enum value to response as potentially breaking", () => {
    const prevTools: ContractDiffTool[] = [
      {
        name: "getPet",
        responses: [
          {
            status: "200",
            description: "Success",
            schema: {
              type: "object",
              properties: {
                status: { type: "string", enum: ["active", "inactive"] },
              },
            },
          },
        ],
      },
    ];
    const nextTools: ContractDiffTool[] = [
      {
        name: "getPet",
        responses: [
          {
            status: "200",
            description: "Success",
            schema: {
              type: "object",
              properties: {
                status: {
                  type: "string",
                  enum: ["active", "inactive", "archived"],
                },
              },
            },
          },
        ],
      },
    ];

    const result = diffContracts(prevTools, nextTools);
    expect(result.hasBreakingChanges).toBe(false);
    expect(result.hasPotentiallyBreakingChanges).toBe(true);
    expect(
      result.potentiallyBreaking.some(
        (c) => c.code === "RESPONSE_ENUM_VALUE_ADDED",
      ),
    ).toBe(true);
  });

  it("diffs nested object properties and array items recursively", () => {
    const prevTools: ContractDiffTool[] = [
      {
        name: "updateProfile",
        inputSchema: {
          type: "object",
          properties: {
            user: {
              type: "object",
              properties: {
                contact: {
                  type: "object",
                  properties: {
                    email: { type: "string" },
                  },
                  required: ["email"],
                },
              },
            },
            tags: {
              type: "array",
              items: {
                type: "string",
                minLength: 2,
              },
            },
          },
        },
      },
    ];
    const nextTools: ContractDiffTool[] = [
      {
        name: "updateProfile",
        inputSchema: {
          type: "object",
          properties: {
            user: {
              type: "object",
              properties: {
                contact: {
                  type: "object",
                  properties: {
                    email: { type: "string" },
                    phone: { type: "string" },
                  },
                  required: ["email", "phone"],
                },
              },
            },
            tags: {
              type: "array",
              items: {
                type: "string",
                minLength: 5,
              },
            },
          },
        },
      },
    ];

    const result = diffContracts(prevTools, nextTools);
    expect(result.hasBreakingChanges).toBe(true);
    expect(
      result.breaking.some(
        (c) =>
          c.code === "INPUT_REQUIRED_ADDED" &&
          c.path ===
            "inputSchema.properties.user.properties.contact.properties.phone",
      ),
    ).toBe(true);
    expect(
      result.breaking.some(
        (c) =>
          c.code === "INPUT_CONSTRAINT_TIGHTENED" &&
          c.path === "inputSchema.properties.tags.items.minLength",
      ),
    ).toBe(true);
  });
});

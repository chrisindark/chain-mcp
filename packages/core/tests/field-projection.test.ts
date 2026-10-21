import { describe, expect, it } from "vitest";

import {
  createFieldProjector,
  FieldSelectionError,
  InMemoryCacheStore,
  InMemoryToolRuntime,
  MAX_FIELD_PROJECTION_NODES,
  type FieldSelection,
  type RuntimeEvent,
  type ToolContext,
  type ToolDefinition,
  type ToolOutputPolicy,
} from "../src/index.js";

const context: ToolContext = {
  requestId: "req-1",
  tenantId: "tenant-1",
  principal: { id: "user-1", scopes: ["read"] },
};

function tool(
  fields: FieldSelection,
  execute: ToolDefinition["execute"] = async () => ({}),
  overrides: Partial<ToolDefinition> = {},
): ToolDefinition {
  return {
    name: "lookup_item",
    description: "Look up a test item",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      additionalProperties: false,
    },
    operation: {},
    output: { fields },
    execute,
    ...overrides,
  };
}

function project(fields: FieldSelection, result: unknown): unknown {
  return createFieldProjector().project({
    tool: tool(fields),
    context,
    result,
  });
}

describe("declarative field projection", () => {
  it("includes only selected nested fields", () => {
    const result = {
      id: "a",
      name: "Example",
      secret: "hidden",
      profile: { email: "a@example.test", token: "hidden" },
      items: [{ id: 1, secret: "hidden", nested: { keep: true, drop: true } }],
    };

    expect(
      project(
        {
          include: ["id", "profile.email", "items.id", "items.nested.keep"],
        },
        result,
      ),
    ).toEqual({
      id: "a",
      profile: { email: "a@example.test" },
      items: [{ id: 1, nested: { keep: true } }],
    });
  });

  it("excludes selected fields and retains the rest", () => {
    const result = {
      id: "a",
      secret: "hidden",
      profile: { email: "a@example.test", token: "hidden" },
      items: [{ id: 1, secret: "hidden", name: "Example" }],
    };

    expect(
      project({ exclude: ["secret", "profile.token", "items.secret"] }, result),
    ).toEqual({
      id: "a",
      profile: { email: "a@example.test" },
      items: [{ id: 1, name: "Example" }],
    });
  });

  it("traverses arrays element-wise, including root arrays", () => {
    expect(
      project({ include: ["id"] }, [
        { id: 1, secret: "a" },
        { id: 2, secret: "b" },
      ]),
    ).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it("replaces unmatched array elements with null under an include policy", () => {
    expect(
      project(
        { include: ["items.id"] },
        { items: [{ id: 1, secret: "a" }, "primitive", 2, null] },
      ),
    ).toEqual({ items: [{ id: 1 }, null, null, null] });
  });

  it("retains a whole selected subtree", () => {
    const profile = { email: "a@example.test", token: "included" };
    expect(project({ include: ["profile"] }, { profile })).toEqual({ profile });
  });

  it("does not mutate the original result", () => {
    const result = {
      keep: { nested: true },
      drop: { secret: true },
      items: [{ keep: 1, drop: 2 }],
    };
    const snapshot = structuredClone(result);

    project({ exclude: ["drop", "items.drop"] }, result);
    project({ include: ["keep", "items.keep"] }, result);

    expect(result).toEqual(snapshot);
  });

  it("passes through tools without field selection", () => {
    const result = { secret: "still here" };
    const projector = createFieldProjector();
    const plain: ToolDefinition = {
      ...tool({ include: ["id"] }),
      output: {},
    };

    expect(projector.project({ tool: plain, context, result })).toBe(result);
  });

  it("keeps an own __proto__ key without polluting prototypes", () => {
    const result = JSON.parse(
      '{"keep":1,"drop":2,"__proto__":{"polluted":true}}',
    ) as Record<string, unknown>;

    const projected = project({ exclude: ["drop"] }, result) as Record<
      string,
      unknown
    >;

    expect(Object.getPrototypeOf(projected)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    const descriptor = Object.getOwnPropertyDescriptor(projected, "__proto__");
    expect(descriptor?.value).toEqual({ polluted: true });
    expect(projected.keep).toBe(1);
    expect(projected).not.toHaveProperty("drop");
  });

  it("rejects projections nested beyond the depth limit", () => {
    let result: unknown = { id: 1 };
    for (let index = 0; index < 70; index += 1) {
      result = [result];
    }

    expect(() => project({ include: ["id"] }, result)).toThrow(
      FieldSelectionError,
    );
  });

  it("rejects projections beyond the node limit", () => {
    const result = Array.from(
      { length: MAX_FIELD_PROJECTION_NODES },
      (_, id) => ({ id }),
    );

    expect(() => project({ include: ["id"] }, result)).toThrow(
      FieldSelectionError,
    );
  });

  it("applies the built-in projector before caching", async () => {
    const store = new InMemoryCacheStore();
    const events: RuntimeEvent[] = [];
    const metrics = {
      record: (event: RuntimeEvent) => {
        events.push(event);
      },
    };
    const runtime = new InMemoryToolRuntime({
      projector: createFieldProjector(),
      cache: { store, authorizationPartition: () => "read" },
      metrics,
    });
    runtime.register(
      tool(
        { include: ["id", "items.id"] },
        async () => ({
          id: "a",
          secret: "hidden",
          items: [{ id: 1, secret: "hidden" }],
        }),
        { contractRevision: "rev-1", cache: { ttlSeconds: 60 } },
      ),
    );

    await expect(
      runtime.callTool("lookup_item", { id: "a" }, context),
    ).resolves.toEqual({ id: "a", items: [{ id: 1 }] });
    await expect(
      runtime.callTool("lookup_item", { id: "a" }, context),
    ).resolves.toEqual({ id: "a", items: [{ id: 1 }] });
    expect(events.map((event) => event.cacheOutcome)).toEqual(["miss", "hit"]);
  });

  it("turns invalid runtime selections into an output policy failure", async () => {
    const runtime = new InMemoryToolRuntime({
      projector: createFieldProjector(),
    });
    const mutableOutput: ToolOutputPolicy = {
      fields: { include: ["id"] },
    };
    runtime.register({
      ...tool({ include: ["id"] }),
      output: mutableOutput,
    });
    mutableOutput.fields = {};

    await expect(
      runtime.callTool("lookup_item", { id: "a" }, context),
    ).rejects.toMatchObject({ code: "OUTPUT_POLICY_VIOLATION" });
  });
});

describe("field selection validation", () => {
  it("rejects ambiguous, empty, duplicate, and malformed selections", () => {
    const invalid: unknown[] = [
      {},
      { include: [] },
      { include: ["id"], exclude: ["secret"] },
      { include: ["id", "id"] },
      { include: ["a..b"] },
      { include: [".a"] },
      { include: ["a."] },
      { include: ["  id"] },
      { include: ["id  "] },
      { include: ["__proto__"] },
      { include: ["constructor.prototype"] },
      { include: [""] },
      { include: [1] },
      { include: ["a".repeat(257)] },
      { include: [Array.from({ length: 17 }, () => "a").join(".")] },
      { include: Array.from({ length: 65 }, (_, index) => `p${index}`) },
      { include: ["bad\u0000path"] },
      { other: ["id"] },
      { include: ["id"], other: true },
    ];

    for (const fields of invalid) {
      const runtime = new InMemoryToolRuntime({
        projector: createFieldProjector(),
      });
      expect(() =>
        runtime.register({
          ...tool({ include: ["row"] }),
          output: { fields: fields as FieldSelection },
        }),
      ).toThrowError(expect.objectContaining({ code: "CONTRACT_INVALID" }));
    }
  });

  it("accepts include and exclude selections independently", () => {
    for (const fields of [
      { include: ["id", "items.id"] },
      { exclude: ["secret", "items.secret"] },
    ]) {
      const runtime = new InMemoryToolRuntime({
        projector: createFieldProjector(),
      });
      expect(() => runtime.register(tool(fields))).not.toThrow();
    }
  });
});

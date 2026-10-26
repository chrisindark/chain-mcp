import { describe, expect, it } from "vitest";
import { z } from "zod";
import { InMemoryToolRuntime } from "@chainmcp/core";
import {
  createManualToolSource,
  defineTool,
  ManualToolSource,
} from "../src/index.js";

describe("ManualToolSource", () => {
  it("allows adding and defining tools", () => {
    const source = createManualToolSource();

    source.defineTool({
      name: "tool_a",
      description: "First tool",
      execute: async () => "a",
    });

    const toolB = defineTool({
      name: "tool_b",
      description: "Second tool",
      execute: async () => "b",
    });
    source.addTool(toolB);

    const tools = source.getTools();
    expect(tools).toHaveLength(2);
    expect(tools.map((t) => t.name)).toEqual(["tool_a", "tool_b"]);
  });

  it("prevents duplicate tool names within the same source", () => {
    const source = createManualToolSource();
    source.defineTool({
      name: "duplicate_name",
      description: "Original",
      execute: async () => 1,
    });

    expect(() =>
      source.defineTool({
        name: "duplicate_name",
        description: "Duplicate",
        execute: async () => 2,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "INVALID_TOOL_DEFINITION",
      }),
    );
  });

  it("can be constructed with initial tools", () => {
    const toolA = defineTool({
      name: "init_tool",
      description: "Initial",
      execute: async () => "init",
    });

    const source = new ManualToolSource([toolA]);
    expect(source.getTools()).toHaveLength(1);
    expect(source.getTools()[0]?.name).toBe("init_tool");
  });

  it("integrates seamlessly with InMemoryToolRuntime via registerSource", async () => {
    const runtime = new InMemoryToolRuntime();
    const source = createManualToolSource();

    source.defineTool({
      name: "greet_user",
      description: "Greets a user by name",
      schema: z.object({
        name: z.string(),
      }),
      execute: async ({ name }) => `Hello, ${name}!`,
    });

    await runtime.registerSource(source);

    const listed = runtime.listTools();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.name).toBe("greet_user");

    const result = await runtime.callTool(
      "greet_user",
      { name: "World" },
      {
        requestId: "r-1",
        tenantId: "default",
        principal: { id: "caller", scopes: [] },
      },
    );

    expect(result).toBe("Hello, World!");
  });
});

import { describe, expect, it, vi } from "vitest";
import { InMemoryToolRuntime } from "@chainmcp/core";
import type { CompiledOperation } from "@chainmcp/compiler";
import {
  createOpenApiToolSource,
  OpenApiToolSource,
  type UpstreamExecutor,
} from "../src/index.js";

const sampleOperation: CompiledOperation = {
  name: "getPet",
  description: "Get a pet by ID",
  method: "get",
  path: "/pets/{petId}",
  readOnly: true,
  deprecated: false,
  parameters: [],
  responses: [],
  security: [],
  authentication: { alternatives: [], allowsAnonymous: true },
  sourceLocation: "#/paths/~1pets~1{petId}/get",
  inputSchema: {
    type: "object",
    required: ["petId"],
    properties: {
      petId: { type: "string" },
    },
    additionalProperties: false,
  },
  operation: {},
};

describe("OpenApiToolSource", () => {
  it("creates tools from compiled operations via UpstreamExecutor", async () => {
    const mockExecutor: UpstreamExecutor = {
      createTool: vi.fn(),
      createTools: vi.fn((ops: readonly CompiledOperation[]) =>
        ops.map((op) => ({
          name: op.name,
          description: op.description,
          inputSchema: op.inputSchema,
          operation: op.operation,
          execute: async () => ({ id: "123", name: "Fido" }),
        })),
      ),
    };

    const source = createOpenApiToolSource({
      executor: mockExecutor,
      operations: [sampleOperation],
    });

    expect(source).toBeInstanceOf(OpenApiToolSource);
    expect(mockExecutor.createTools).toHaveBeenCalledWith([sampleOperation]);

    const tools = source.getTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe("getPet");

    // Register with InMemoryToolRuntime via registerSource
    const runtime = new InMemoryToolRuntime();
    await runtime.registerSource(source);
    expect(runtime.listTools()).toHaveLength(1);
    expect(runtime.listTools()[0]?.name).toBe("getPet");
  });

  it("validates constructor options", () => {
    const mockExecutor: UpstreamExecutor = {
      createTool: vi.fn(),
      createTools: vi.fn(() => []),
    };

    expect(
      // @ts-expect-error -- test missing options
      () => new OpenApiToolSource(),
    ).toThrow(TypeError);

    expect(
      // @ts-expect-error -- test missing executor
      () => new OpenApiToolSource({ operations: [] }),
    ).toThrow(
      "OpenApiToolSource requires an UpstreamExecutor with createTools()",
    );

    expect(
      () =>
        new OpenApiToolSource({
          executor: mockExecutor,
          operations: "not-array" as unknown as readonly CompiledOperation[],
        }),
    ).toThrow("OpenApiToolSource requires an array of CompiledOperation");
  });
});

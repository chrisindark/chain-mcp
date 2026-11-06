import { describe, expect, it } from "vitest";

import { createUpstreamExecutor } from "@chainmcp/executor";

import {
  createDeclarativeToolSource,
  DeclarativeDescriptorError,
  MAX_DECLARATIVE_DESCRIPTORS,
  type DeclarativeToolDescriptor,
  type DeclarativeToolSourceOptions,
} from "../src/index.js";

function getDescriptor(): DeclarativeToolDescriptor {
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
        userId: { type: "string" },
      },
    },
  };
}

function fixture() {
  const executor = createUpstreamExecutor({
    baseUrl: "https://api.example.com/v1",
    allowedHosts: ["api.example.com"],
    resolveHost: async () => ["93.184.216.34"],
    transport: {
      async request() {
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: new TextEncoder().encode(JSON.stringify({ ok: true })),
        };
      },
    },
  });
  return { executor };
}

describe("DeclarativeToolSource options and edge cases", () => {
  it("validates constructor options and bounds", () => {
    const { executor } = fixture();

    expect(() =>
      createDeclarativeToolSource(
        null as unknown as DeclarativeToolSourceOptions,
      ),
    ).toThrow(
      new DeclarativeDescriptorError(
        "EXECUTOR_INVALID",
        "DeclarativeToolSource options must be an object",
      ),
    );

    expect(() =>
      createDeclarativeToolSource({
        descriptors: [],
        executor: {} as unknown as typeof executor,
      }),
    ).toThrow(
      new DeclarativeDescriptorError(
        "EXECUTOR_INVALID",
        "DeclarativeToolSource requires an UpstreamExecutor with createTool()",
      ),
    );

    expect(() =>
      createDeclarativeToolSource({
        executor,
        descriptors: "not an array" as unknown as [],
      }),
    ).toThrow(
      new DeclarativeDescriptorError(
        "DESCRIPTOR_INVALID",
        "DeclarativeToolSource requires an array of descriptors",
      ),
    );

    const tooMany = Array.from(
      { length: MAX_DECLARATIVE_DESCRIPTORS + 1 },
      (_, i) => ({
        ...getDescriptor(),
        name: `tool_${i}`,
      }),
    );
    expect(() =>
      createDeclarativeToolSource({
        executor,
        descriptors: tooMany,
      }),
    ).toThrow(
      new DeclarativeDescriptorError(
        "DESCRIPTOR_INVALID",
        `A source cannot declare more than ${MAX_DECLARATIVE_DESCRIPTORS} descriptors`,
      ),
    );
  });

  it("exposes getDescriptors() and handles executor.createTool failures", () => {
    const { executor } = fixture();
    const source = createDeclarativeToolSource({
      executor,
      descriptors: [getDescriptor()],
    });
    const descriptors = source.getDescriptors();
    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]?.descriptor.name).toBe("get_user");

    const failingExecutor = {
      createTool: () => {
        throw new Error("simulated bind failure");
      },
    };
    expect(() =>
      createDeclarativeToolSource({
        executor: failingExecutor as unknown as typeof executor,
        descriptors: [getDescriptor()],
      }),
    ).toThrow(
      "Descriptor 'get_user' could not be bound to the executor: simulated bind failure",
    );
  });
});

import { describe, expect, it, vi } from "vitest";

import {
  InMemoryCacheStore,
  InMemoryToolRuntime,
  type RuntimeEvent,
  type Tokenizer,
  type ToolContext,
  type ToolDefinition,
} from "../src/index.js";

const context: ToolContext = {
  requestId: "req-1",
  tenantId: "tenant-1",
  principal: { id: "user-1", scopes: ["read"] },
};

function tool(execute: ToolDefinition["execute"]): ToolDefinition {
  return {
    name: "lookup_item",
    description: "Look up a test item",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      additionalProperties: false,
    },
    operation: {},
    execute,
  };
}

function tokenizer(overrides: Partial<Tokenizer> = {}): Tokenizer {
  return {
    id: "test-exact",
    measurement: "exact",
    count: (text) => text.length,
    ...overrides,
  };
}

function recorder(): {
  events: RuntimeEvent[];
  metrics: { record(event: RuntimeEvent): void };
} {
  const events: RuntimeEvent[] = [];
  return {
    events,
    metrics: {
      record: (event) => {
        events.push(event);
      },
    },
  };
}

describe("token accounting", () => {
  it("records an exact measurement of the serialized result", async () => {
    const result = { value: "fresh" };
    const count = vi.fn((text: string) => text.length);
    const { events, metrics } = recorder();
    const runtime = new InMemoryToolRuntime({
      tokenizer: tokenizer({ count }),
      metrics,
    });
    runtime.register(tool(async () => result));

    await runtime.callTool("lookup_item", { id: "a" }, context);

    const text = JSON.stringify(result);
    expect(count).toHaveBeenCalledWith(text);
    expect(events[0]?.tokenUsage).toEqual({
      count: text.length,
      measurement: "exact",
      tokenizer: "test-exact",
      payloadBytes: Buffer.byteLength(text, "utf8"),
    });
  });

  it("labels adapter estimates as estimates", async () => {
    const { events, metrics } = recorder();
    const runtime = new InMemoryToolRuntime({
      tokenizer: tokenizer({
        id: "rough-estimate",
        measurement: "estimate",
        count: () => 4,
      }),
      metrics,
    });
    runtime.register(tool(async () => "abc"));

    await runtime.callTool("lookup_item", { id: "a" }, context);

    expect(events[0]?.tokenUsage).toMatchObject({
      count: 4,
      measurement: "estimate",
      tokenizer: "rough-estimate",
    });
  });

  it("measures cache hits as well as misses", async () => {
    const count = vi.fn((text: string) => text.length);
    const { events, metrics } = recorder();
    const runtime = new InMemoryToolRuntime({
      tokenizer: tokenizer({ count }),
      metrics,
      cache: {
        store: new InMemoryCacheStore(),
        authorizationPartition: () => "read",
      },
    });
    runtime.register({
      ...tool(async () => ({ value: "fresh" })),
      contractRevision: "rev-1",
      cache: { ttlSeconds: 60 },
    });

    await runtime.callTool("lookup_item", { id: "a" }, context);
    await runtime.callTool("lookup_item", { id: "a" }, context);

    expect(events.map((event) => event.cacheOutcome)).toEqual(["miss", "hit"]);
    expect(events[1]?.tokenUsage).toEqual(events[0]?.tokenUsage);
    expect(count).toHaveBeenCalledTimes(2);
  });

  it("omits measurement when no tokenizer is configured", async () => {
    const { events, metrics } = recorder();
    const runtime = new InMemoryToolRuntime({ metrics });
    runtime.register(tool(async () => ({ value: "fresh" })));

    await runtime.callTool("lookup_item", { id: "a" }, context);

    expect(events[0]).not.toHaveProperty("tokenUsage");
  });

  it("omits measurement for failed calls without invoking the tokenizer", async () => {
    const count = vi.fn((text: string) => text.length);
    const { events, metrics } = recorder();
    const runtime = new InMemoryToolRuntime({
      tokenizer: tokenizer({ count }),
      metrics,
    });
    runtime.register(
      tool(async () => {
        throw new Error("upstream down");
      }),
    );

    await expect(
      runtime.callTool("lookup_item", { id: "a" }, context),
    ).rejects.toMatchObject({ code: "UPSTREAM_FAILURE" });

    expect(count).not.toHaveBeenCalled();
    expect(events[0]).not.toHaveProperty("tokenUsage");
  });

  it("omits measurement for undefined and un-serializable results", async () => {
    const undefinedEvents = recorder();
    const undefinedRuntime = new InMemoryToolRuntime({
      tokenizer: tokenizer(),
      metrics: undefinedEvents.metrics,
    });
    undefinedRuntime.register(tool(async () => undefined));
    await undefinedRuntime.callTool("lookup_item", { id: "a" }, context);
    expect(undefinedEvents.events[0]).not.toHaveProperty("tokenUsage");

    const cyclicEvents = recorder();
    const cyclicRuntime = new InMemoryToolRuntime({
      tokenizer: tokenizer(),
      metrics: cyclicEvents.metrics,
    });
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    cyclicRuntime.register(tool(async () => cyclic));
    await expect(
      cyclicRuntime.callTool("lookup_item", { id: "a" }, context),
    ).resolves.toBe(cyclic);
    expect(cyclicEvents.events[0]).not.toHaveProperty("tokenUsage");
  });

  it("ignores tokenizer failures and invalid counts", async () => {
    for (const count of [
      () => {
        throw new Error("tokenizer down");
      },
      () => -1,
      () => 1.5,
      () => Number.NaN,
      () => Number.POSITIVE_INFINITY,
    ]) {
      const { events, metrics } = recorder();
      const runtime = new InMemoryToolRuntime({
        tokenizer: tokenizer({ count }),
        metrics,
      });
      runtime.register(tool(async () => ({ value: "fresh" })));

      await expect(
        runtime.callTool("lookup_item", { id: "a" }, context),
      ).resolves.toEqual({ value: "fresh" });
      expect(events[0]?.outcome).toBe("success");
      expect(events[0]).not.toHaveProperty("tokenUsage");
    }
  });

  it("rejects invalid tokenizer configuration", () => {
    const invalid = [
      { id: "", measurement: "exact" as const, count: () => 1 },
      { id: "   ", measurement: "exact" as const, count: () => 1 },
      {
        id: "x",
        measurement: "approximate" as unknown as "exact",
        count: () => 1,
      },
      { id: "x", measurement: "exact" as const, count: undefined as never },
    ];
    for (const tokenizerConfig of invalid) {
      expect(
        () =>
          new InMemoryToolRuntime({
            tokenizer: tokenizerConfig as Tokenizer,
          }),
      ).toThrowError(expect.objectContaining({ code: "CONFIG_INVALID" }));
    }
  });
});

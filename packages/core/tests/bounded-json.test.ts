import { describe, expect, it, vi } from "vitest";
import {
  SerializationLimitError,
  stringifyBounded,
} from "../src/bounded-json.js";

describe("stringifyBounded (RM-10)", () => {
  it("serializes primitives, null, and empty structures within bounds", () => {
    expect(stringifyBounded(null, { maxBytes: 10 })).toBe("null");
    expect(stringifyBounded(true, { maxBytes: 10 })).toBe("true");
    expect(stringifyBounded(false, { maxBytes: 10 })).toBe("false");
    expect(stringifyBounded(42, { maxBytes: 10 })).toBe("42");
    expect(stringifyBounded("hello", { maxBytes: 10 })).toBe('"hello"');
    expect(stringifyBounded([], { maxBytes: 10 })).toBe("[]");
    expect(stringifyBounded({}, { maxBytes: 10 })).toBe("{}");
    expect(stringifyBounded(undefined, { maxBytes: 10 })).toBeUndefined();
    expect(stringifyBounded(() => {}, { maxBytes: 10 })).toBeUndefined();
    expect(stringifyBounded(Symbol("test"), { maxBytes: 10 })).toBeUndefined();
  });

  it("serializes nested objects and arrays correctly", () => {
    const input = {
      name: "alice",
      age: 30,
      active: true,
      tags: ["admin", "staff"],
      nested: { x: 1 },
      ignored: undefined,
    };
    const expected = JSON.stringify(input);
    const result = stringifyBounded(input, { maxBytes: 1000 });
    expect(result).toBe(expected);
  });

  it("honors toJSON methods", () => {
    const custom = {
      toJSON() {
        return { customKey: "customValue" };
      },
    };
    expect(stringifyBounded(custom, { maxBytes: 100 })).toBe(
      '{"customKey":"customValue"}',
    );
  });

  it("detects circular references and throws TypeError", () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(() => stringifyBounded(cyclic, { maxBytes: 1000 })).toThrow(
      "Converting circular structure to JSON",
    );
  });

  it("accepts a payload exactly at the limit", () => {
    const obj = { a: 1 }; // '{"a":1}' has length 7
    const serialized = JSON.stringify(obj);
    const byteLength = Buffer.byteLength(serialized, "utf8");
    expect(byteLength).toBe(7);

    const result = stringifyBounded(obj, { maxBytes: 7 });
    expect(result).toBe(serialized);
  });

  it("rejects a payload that exceeds the limit by 1 byte", () => {
    const obj = { a: 1 }; // '{"a":1}' is 7 bytes
    expect(() => stringifyBounded(obj, { maxBytes: 6 })).toThrow(
      SerializationLimitError,
    );
  });

  it("rejects 2x maxResponseBytes payload without allocating full string or evaluating subsequent elements", () => {
    const maxBytes = 50;
    const trapFn = vi.fn();

    // The first item alone is already 60 bytes ("x" * 58 + quotes), exceeding maxBytes (50).
    // The second item has a getter trap that must NEVER be called because traversal aborts early.
    const dangerousItem = {
      get trap() {
        trapFn();
        return "exploded";
      },
    };

    const payload = ["x".repeat(58), dangerousItem];

    expect(() => stringifyBounded(payload, { maxBytes })).toThrow(
      SerializationLimitError,
    );
    // Sentinel check: verify trap was NEVER evaluated
    expect(trapFn).not.toHaveBeenCalled();
  });

  it("rejects huge single string without allocating giant string buffer", () => {
    const hugeString = "a".repeat(100_000);
    expect(() => stringifyBounded(hugeString, { maxBytes: 50 })).toThrow(
      SerializationLimitError,
    );
  });

  it("enforces maxDepth limit", () => {
    let deep: Record<string, unknown> = { x: 1 };
    for (let i = 0; i < 20; i++) {
      deep = { child: deep };
    }
    expect(() =>
      stringifyBounded(deep, { maxBytes: 10_000, maxDepth: 10 }),
    ).toThrow("maximum depth");
  });

  it("enforces maxNodes limit", () => {
    const wideArray = Array.from({ length: 500 }, (_, i) => ({ id: i }));
    expect(() =>
      stringifyBounded(wideArray, { maxBytes: 100_000, maxNodes: 50 }),
    ).toThrow("maximum node limit");
  });
});

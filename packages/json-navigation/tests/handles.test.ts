import { describe, expect, it } from "vitest";
import type { ToolContext } from "@chainmcp/core";
import {
  RESULT_HANDLE_EXPIRED,
  ResultHandleExpiredError,
  ResultHandleRegistry,
  ResultHandleTooLargeError,
} from "../src/handles.js";
import { createJsonNavigationTools } from "../src/tools.js";

const alice = { tenantId: "tenant-1", principalId: "alice" };
const bob = { tenantId: "tenant-1", principalId: "bob" };
const eve = { tenantId: "tenant-2", principalId: "alice" };

describe("ResultHandleRegistry", () => {
  it("round-trips a stored document for its creator", () => {
    const registry = new ResultHandleRegistry();
    const handle = registry.store({ a: 1 }, alice);
    expect(handle).toMatch(/rhv1\./);
    expect(registry.resolve(handle, alice)).toEqual({ a: 1 });
  });

  it("mints an opaque handle that contains no tenant or principal payload", () => {
    const registry = new ResultHandleRegistry();
    const handle = registry.store({ secret: "s3cr3t" }, alice);
    expect(handle).not.toContain("tenant-1");
    expect(handle).not.toContain("alice");
    expect(handle).not.toContain("s3cr3t");
  });

  it("rejects a cross-principal lookup with RESULT_HANDLE_EXPIRED (no existence leak)", () => {
    const registry = new ResultHandleRegistry();
    const handle = registry.store({ a: 1 }, alice);
    let caught: unknown;
    try {
      registry.resolve(handle, bob);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ResultHandleExpiredError);
    expect((caught as Error).message).toContain(RESULT_HANDLE_EXPIRED);
  });

  it("rejects a cross-tenant lookup with RESULT_HANDLE_EXPIRED", () => {
    const registry = new ResultHandleRegistry();
    const handle = registry.store({ a: 1 }, alice);
    expect(() => registry.resolve(handle, eve)).toThrowError(
      RESULT_HANDLE_EXPIRED,
    );
  });

  it("rejects unknown handles with RESULT_HANDLE_EXPIRED", () => {
    const registry = new ResultHandleRegistry();
    expect(() =>
      registry.resolve("rhv1.1.aaaaaaaaaaaaaaaaaaaaaa", alice),
    ).toThrowError(RESULT_HANDLE_EXPIRED);
    expect(() =>
      registry.resolve("rhv1.9999.aaaaaaaaaaaaaaaaaaaaaa", alice),
    ).toThrowError(RESULT_HANDLE_EXPIRED);
  });

  it("rejects tampered handles with RESULT_HANDLE_EXPIRED", () => {
    const registry = new ResultHandleRegistry();
    const handle = registry.store({ a: 1 }, alice);
    // Flip the last tag character (the tag is the last dash-separated segment).
    const tampered = handle.slice(0, -1) + (handle.endsWith("A") ? "B" : "A");
    expect(tampered).not.toBe(handle);
    expect(() => registry.resolve(tampered, alice)).toThrowError(
      RESULT_HANDLE_EXPIRED,
    );
  });

  it("expires handles after their TTL", () => {
    let now = 1_000;
    const registry = new ResultHandleRegistry({
      ttlMs: 1_000,
      now: () => now,
    });
    const handle = registry.store({ a: 1 }, alice);
    expect(registry.resolve(handle, alice)).toEqual({ a: 1 });
    now += 1_001;
    expect(() => registry.resolve(handle, alice)).toThrowError(
      RESULT_HANDLE_EXPIRED,
    );
  });

  it("evicts the least-recently-used handle when the per-principal cap is hit", () => {
    let now = 0;
    const registry = new ResultHandleRegistry({
      maxPerPrincipal: 2,
      ttlMs: 60_000,
      now: () => now++,
    });
    const h1 = registry.store({ i: 1 }, alice);
    const h2 = registry.store({ i: 2 }, alice);
    // Touch h1 so h2 becomes the least-recently-used.
    registry.resolve(h1, alice);
    const h3 = registry.store({ i: 3 }, alice);
    expect(registry.size).toBe(2);
    expect(() => registry.resolve(h2, alice)).toThrowError(
      RESULT_HANDLE_EXPIRED,
    );
    expect(registry.resolve(h1, alice)).toEqual({ i: 1 });
    expect(registry.resolve(h3, alice)).toEqual({ i: 3 });
  });

  it("enforces the per-tenant cap across principals in the same tenant", () => {
    const registry = new ResultHandleRegistry({
      maxPerTenant: 2,
      maxPerPrincipal: 10,
      ttlMs: 60_000,
    });
    const h1 = registry.store({ i: 1 }, alice);
    registry.store({ i: 2 }, bob);
    registry.store({ i: 3 }, alice);
    expect(registry.size).toBe(2);
    expect(() => registry.resolve(h1, alice)).toThrowError(
      RESULT_HANDLE_EXPIRED,
    );
  });

  it("caps total bytes and evicts the oldest entries", () => {
    const registry = new ResultHandleRegistry({
      maxTotalBytes: 20,
      maxBytes: 100,
      maxTotal: 1_000,
      ttlMs: 60_000,
    });
    const big = { data: "x".repeat(10) }; // ~19 bytes serialized
    registry.store(big, alice);
    registry.store(big, alice);
    expect(registry.totalBytesUsed).toBeLessThanOrEqual(20);
  });

  it("rejects documents above the byte cap instead of silently truncating", () => {
    const registry = new ResultHandleRegistry({ maxBytes: 10 });
    expect(() => registry.store({ data: "x".repeat(50) }, alice)).toThrowError(
      ResultHandleTooLargeError,
    );
    expect(registry.size).toBe(0);
  });

  it("storeIfLarge returns null below minBytes and a handle above it", () => {
    const registry = new ResultHandleRegistry({ minBytes: 100 });
    expect(registry.storeIfLarge({ a: 1 }, alice)).toBeNull();
    const handle = registry.storeIfLarge({ data: "x".repeat(200) }, alice);
    expect(handle).toMatch(/rhv1\./);
    expect(registry.resolve(handle!, alice)).toEqual({ data: "x".repeat(200) });
  });

  it("fresh entries do not collide across registries with different secrets", () => {
    const a = new ResultHandleRegistry();
    const b = new ResultHandleRegistry();
    const handle = a.store({ i: 1 }, alice);
    expect(() => b.resolve(handle, alice)).toThrowError(RESULT_HANDLE_EXPIRED);
  });

  describe("navigation tools with handles", () => {
    const registry = new ResultHandleRegistry();
    const tools = createJsonNavigationTools(undefined, registry);
    const inspectTool = tools[0]!;
    const selectTool = tools[1]!;
    const createHandleTool = tools[4]!;
    const aliceCtx: ToolContext = {
      requestId: "req-1",
      tenantId: "tenant-1",
      principal: { id: "alice", scopes: [] },
    };
    const bobCtx: ToolContext = {
      requestId: "req-2",
      tenantId: "tenant-1",
      principal: { id: "bob", scopes: [] },
    };

    it("creates a fifth tool: json_create_handle", () => {
      expect(tools.map((t) => t.name)).toContain("json_create_handle");
    });

    it("round-trips: create a handle, then navigate by handle instead of inline json", async () => {
      const doc = { users: [{ id: 1 }, { id: 2 }] };
      const { handle } = (await createHandleTool.execute(
        { json: doc },
        aliceCtx,
      )) as { handle: string; bytes: number };
      expect(handle).toMatch(/rhv1\./);
      const selected = await selectTool.execute(
        { handle, path: "$.users[1].id" },
        aliceCtx,
      );
      expect(selected).toBe(2);
      const shape = (await inspectTool.execute({ handle }, aliceCtx)) as {
        type: string;
        keys: string[];
      };
      expect(shape.type).toBe("object");
      expect(shape.keys).toEqual(["users"]);
    });

    it("rejects a cross-principal handle with RESULT_HANDLE_EXPIRED", async () => {
      const { handle } = (await createHandleTool.execute(
        { json: { a: 1 } },
        aliceCtx,
      )) as { handle: string };
      await expect(
        selectTool.execute({ handle, path: "$.a" }, bobCtx),
      ).rejects.toThrowError(RESULT_HANDLE_EXPIRED);
    });

    it("prefers the handle over inline json when both are present", async () => {
      const { handle } = (await createHandleTool.execute(
        { json: { viaHandle: true } },
        aliceCtx,
      )) as { handle: string };
      const res = await selectTool.execute(
        { handle, json: { viaHandle: false }, path: "$.viaHandle" },
        aliceCtx,
      );
      expect(res).toBe(true);
    });

    it("rejects unknown handles even with a fresh registry (handles are on by default)", async () => {
      const tools = createJsonNavigationTools();
      await expect(
        tools[1]!.execute(
          { handle: "rhv1.1.aaaaaaaaaaaaaaaaaaaaaa", path: "$.a" },
          aliceCtx,
        ),
      ).rejects.toThrowError(RESULT_HANDLE_EXPIRED);
    });
  });
});

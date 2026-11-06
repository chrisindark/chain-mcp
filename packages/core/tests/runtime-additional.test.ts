import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SCHEMA_VALIDATION_LIMITS,
  InMemoryToolRuntime,
  RuntimeError,
  validateJsonSchema,
  type ToolContext,
  type ToolDefinition,
} from "../src/index.js";

describe("Core Runtime & Schema Additional Tests", () => {
  describe("validateJsonSchema advanced features", () => {
    it("validates patternProperties against matching keys", () => {
      const schema = {
        type: "object",
        patternProperties: {
          "^s_": { type: "string" },
          "^n_": { type: "number" },
        },
      };

      const validResult = validateJsonSchema(schema, {
        s_name: "Alice",
        n_age: 30,
        other: [1, 2, 3], // does not match any pattern
      });
      expect(validResult.valid).toBe(true);

      const invalidResult = validateJsonSchema(schema, {
        s_name: 12345, // should be string
      });
      expect(invalidResult.valid).toBe(false);
      expect(invalidResult.issues.length).toBeGreaterThan(0);
    });

    it("validates additionalProperties schema when combined with patternProperties", () => {
      const schema = {
        type: "object",
        properties: {
          known: { type: "string" },
        },
        patternProperties: {
          "^pattern_": { type: "number" },
        },
        additionalProperties: { type: "boolean" },
      };

      const valid = validateJsonSchema(schema, {
        known: "ok",
        pattern_num: 42,
        extraFlag: true,
      });
      expect(valid.valid).toBe(true);

      const invalid = validateJsonSchema(schema, {
        known: "ok",
        extraFlag: "not a boolean",
      });
      expect(invalid.valid).toBe(false);
    });

    it("validates prefixItems in arrays", () => {
      const schema = {
        type: "array",
        prefixItems: [{ type: "string" }, { type: "number" }],
        items: { type: "boolean" },
      };

      const valid = validateJsonSchema(schema, ["text", 42, true, false]);
      expect(valid.valid).toBe(true);

      const invalidPrefix = validateJsonSchema(schema, [123, 42, true]);
      expect(invalidPrefix.valid).toBe(false);

      const invalidRest = validateJsonSchema(schema, [
        "text",
        42,
        "not-boolean",
      ]);
      expect(invalidRest.valid).toBe(false);
    });

    it("validates array contains with minContains and maxContains bounds", () => {
      const schema = {
        type: "array",
        contains: { type: "number" },
        minContains: 2,
        maxContains: 3,
      };

      // Only 1 number (min is 2)
      const tooFew = validateJsonSchema(schema, ["a", 1, "b"]);
      expect(tooFew.valid).toBe(false);
      expect(tooFew.issues[0]).toContain(
        "must contain at least 2 matching items",
      );

      // 4 numbers (max is 3)
      const tooMany = validateJsonSchema(schema, [1, 2, 3, 4]);
      expect(tooMany.valid).toBe(false);
      expect(tooMany.issues[0]).toContain(
        "must contain at most 3 matching items",
      );

      // 2 numbers (valid)
      const valid = validateJsonSchema(schema, ["a", 1, "b", 2]);
      expect(valid.valid).toBe(true);
    });

    it("enforces maxArrayLength limit in limits", () => {
      const schema = { type: "array" };
      const res = validateJsonSchema(schema, [1, 2, 3, 4, 5], 10, {
        ...DEFAULT_SCHEMA_VALIDATION_LIMITS,
        maxArrayLength: 3,
      });
      expect(res.valid).toBe(false);
      expect(res.issues[0]).toContain("must have at most 3 items");
    });
  });

  describe("InMemoryToolRuntime edge cases", () => {
    it("rejects empty ownerTenantId in single-tenant mode", () => {
      const runtime = new InMemoryToolRuntime({ tenantMode: "single-tenant" });
      const badTool: ToolDefinition = {
        name: "toolWithEmptyOwner",
        description: "bad tool",
        operation: {},
        ownerTenantId: "",
        inputSchema: { type: "object" },
        execute: async () => ({}),
      };

      expect(() => runtime.register(badTool)).toThrowError(RuntimeError);
      expect(() => runtime.register(badTool)).toThrowError(
        "declares an empty ownerTenantId",
      );
    });

    it("rejects empty tenantId when listing tools in multi-tenant mode", () => {
      const runtime = new InMemoryToolRuntime({
        tenantMode: "multi-tenant",
        authorizer: { authorize: () => {} },
      });
      const context: ToolContext = {
        tenantId: "   ",
        requestId: "req-1",
        principal: { id: "user-1", scopes: [] },
      };

      expect(() => runtime.listTools(context)).toThrowError(RuntimeError);
      expect(() => runtime.listTools(context)).toThrowError(
        "A non-empty tenantId is required to list tools in multi-tenant mode",
      );
    });

    it("flushes metrics and calls onShutdown during close, sharing promise across calls", async () => {
      const flushFn = vi.fn().mockResolvedValue(undefined);
      const onShutdownFn = vi.fn().mockResolvedValue(undefined);

      const runtime = new InMemoryToolRuntime({
        metrics: {
          record: () => {},
          flush: flushFn,
        },
        onShutdown: onShutdownFn,
      });

      const p1 = runtime.close();
      const p2 = runtime.close();

      expect(p1).toBe(p2);
      await p1;

      expect(flushFn).toHaveBeenCalledTimes(1);
      expect(onShutdownFn).toHaveBeenCalledTimes(1);
    });

    it("isolates errors thrown in metrics.flush and onShutdown during close", async () => {
      const runtime = new InMemoryToolRuntime({
        metrics: {
          record: () => {},
          flush: async () => {
            throw new Error("flush error");
          },
        },
        onShutdown: async () => {
          throw new Error("shutdown error");
        },
      });

      await expect(runtime.close()).resolves.toBeUndefined();
    });

    it("invokes logger.audit during cache invalidation and isolates logger errors", async () => {
      const auditFn = vi.fn().mockImplementation(() => {
        throw new Error("logger failure");
      });

      const mockStore = {
        get: vi.fn(),
        set: vi.fn(),
        delete: vi.fn().mockResolvedValue(undefined),
      };

      const runtime = new InMemoryToolRuntime({
        cache: {
          store: mockStore,
          authorizationPartition: () => "read",
        },
        logger: {
          debug: () => {},
          info: () => {},
          warn: () => {},
          error: () => {},
          audit: auditFn,
        },
      });

      const tool: ToolDefinition = {
        name: "cachedTool",
        description: "cached tool",
        operation: {},
        contractRevision: "rev_1",
        inputSchema: { type: "object" },
        cache: { ttlSeconds: 30 },
        execute: async () => ({ data: "result" }),
      };

      runtime.register(tool);

      await runtime.invalidateCachedResult(
        "cachedTool",
        {},
        {
          tenantId: "tenant-1",
          principal: { id: "user-1", scopes: [] },
          requestId: "req-1",
        },
      );

      expect(mockStore.delete).toHaveBeenCalledTimes(1);
      expect(auditFn).toHaveBeenCalledTimes(1);
    });
  });
});

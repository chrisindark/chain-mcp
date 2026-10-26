import { describe, it, expect } from "vitest";
import type { ToolContext } from "@chainmcp/core";
import {
  inspectShape,
  selectPath,
  parseJsonPath,
  paginate,
  filterData,
  createJsonNavigationTools,
  JsonNavigationLimitError,
  JsonPathSyntaxError,
  JsonNavigationError,
  type PaginatedResult,
} from "../src/index.js";

describe("JSON Navigation", () => {
  describe("inspectShape", () => {
    it("summarizes primitive types accurately", () => {
      expect(inspectShape("hello")).toMatchObject({
        type: "string",
        depth: 1,
        totalNodes: 1,
        byteEstimate: 5,
      });
      expect(inspectShape(42)).toMatchObject({
        type: "number",
        depth: 1,
        totalNodes: 1,
      });
      expect(inspectShape(true)).toMatchObject({
        type: "boolean",
        depth: 1,
        totalNodes: 1,
      });
      expect(inspectShape(null)).toMatchObject({
        type: "null",
        depth: 1,
        totalNodes: 1,
      });
    });

    it("summarizes array structures with item types and sample shapes", () => {
      const data = [
        { id: 1, name: "Alice" },
        { id: 2, name: "Bob" },
      ];
      const summary = inspectShape(data);
      expect(summary.type).toBe("array");
      expect(summary.itemCount).toBe(2);
      expect(summary.itemTypes).toEqual(["object"]);
      expect(summary.sampleItemShape).toBeDefined();
      expect(summary.sampleItemShape?.keys).toEqual(["id", "name"]);
    });

    it("summarizes object structures with keys and property summaries", () => {
      const data = {
        name: "ChainMcp",
        version: 1,
        features: ["cache", "auth"],
      };
      const summary = inspectShape(data);
      expect(summary.type).toBe("object");
      expect(summary.propertyCount).toBe(3);
      expect(summary.keys).toEqual(["name", "version", "features"]);
      expect(summary.properties?.name?.type).toBe("string");
      expect(summary.properties?.version?.type).toBe("number");
      expect(summary.properties?.features?.type).toBe("array");
    });

    it("detects and prevents infinite loops on circular references", () => {
      const circular: Record<string, unknown> = { a: 1 };
      circular.self = circular;
      expect(() => inspectShape(circular)).toThrowError(JsonNavigationError);
    });

    it("enforces depth bounds during shape inspection", () => {
      let nested: Record<string, unknown> = { value: "deep" };
      for (let i = 0; i < 20; i++) {
        nested = { child: nested };
      }
      expect(() =>
        inspectShape(nested, { maxDepth: 10, throwOnDepthLimit: true }),
      ).toThrowError(JsonNavigationLimitError);

      const truncatedSummary = inspectShape(nested, { maxDepth: 10 });
      expect(truncatedSummary.truncated).toBe(true);
    });
  });

  describe("selectPath", () => {
    const fixture = {
      store: {
        name: "Tech Books",
        location: { city: "SF", zip: "94105" },
        books: [
          { id: 1, title: "TypeScript Handbook", price: 30, inStock: true },
          { id: 2, title: "Modern MCP", price: 45, inStock: false },
          { id: 3, title: "Distributed Systems", price: 60, inStock: true },
        ],
      },
    };

    it("selects simple root and nested properties", () => {
      expect(selectPath(fixture, "$.store.name")).toBe("Tech Books");
      expect(selectPath(fixture, "store.location.city")).toBe("SF");
    });

    it("selects array items by positive and negative indices", () => {
      expect(selectPath(fixture, "$.store.books[0].title")).toBe(
        "TypeScript Handbook",
      );
      expect(selectPath(fixture, "$.store.books[-1].title")).toBe(
        "Distributed Systems",
      );
    });

    it("selects array slices", () => {
      const titles = selectPath(fixture, "$.store.books[0:2].title");
      expect(titles).toEqual(["TypeScript Handbook", "Modern MCP"]);
    });

    it("selects all items with wildcard", () => {
      const titles = selectPath(fixture, "$.store.books[*].title");
      expect(titles).toEqual([
        "TypeScript Handbook",
        "Modern MCP",
        "Distributed Systems",
      ]);
    });

    it("evaluates filter expressions", () => {
      const inStock = selectPath(
        fixture,
        "$.store.books[?(@.inStock == true)].title",
      );
      expect(inStock).toEqual(["TypeScript Handbook", "Distributed Systems"]);

      const cheap = selectPath(fixture, "$.store.books[?(@.price < 40)].title");
      expect(cheap).toEqual(["TypeScript Handbook"]);

      const truthy = selectPath(fixture, "$.store.books[?(@.inStock)].id");
      expect(truthy).toEqual([1, 3]);
    });

    it("blocks dangerous prototype pollution properties", () => {
      expect(() => parseJsonPath("$.store.__proto__")).toThrowError(
        JsonPathSyntaxError,
      );
      expect(() => parseJsonPath("$.store.constructor")).toThrowError(
        JsonPathSyntaxError,
      );
      expect(() => parseJsonPath("$.store['prototype']")).toThrowError(
        JsonPathSyntaxError,
      );
      expect(() =>
        parseJsonPath("$.store[?(@.__proto__ == 'bad')]"),
      ).toThrowError(JsonPathSyntaxError);
    });

    it("throws syntax error on malformed paths", () => {
      expect(() => selectPath(fixture, "")).toThrowError(JsonPathSyntaxError);
      expect(() => selectPath(fixture, "store..books")).toThrowError(
        JsonPathSyntaxError,
      );
      expect(() => selectPath(fixture, "store.books[unclosed")).toThrowError(
        JsonPathSyntaxError,
      );
    });

    it("enforces maxResultBytes on path selection", () => {
      expect(() =>
        selectPath(fixture, "$.store.books[*]", { maxResultBytes: 20 }),
      ).toThrowError(JsonNavigationLimitError);
    });
  });

  describe("paginate", () => {
    const items = Array.from({ length: 100 }, (_, i) => ({
      id: i + 1,
      name: `Item ${i + 1}`,
    }));

    it("paginates array using offset and limit", () => {
      const result = paginate(items, { offset: 10, limit: 5 });
      expect(result.items).toHaveLength(5);
      expect(result.items[0]).toEqual({ id: 11, name: "Item 11" });
      expect(result.totalItems).toBe(100);
      expect(result.hasMore).toBe(true);
    });

    it("paginates array using page and pageSize", () => {
      const result = paginate(items, { page: 3, pageSize: 10 });
      expect(result.items).toHaveLength(10);
      expect(result.items[0]).toEqual({ id: 21, name: "Item 21" });
      expect(result.page).toBe(3);
      expect(result.totalPages).toBe(10);
      expect(result.hasMore).toBe(true);
    });

    it("handles last page accurately", () => {
      const result = paginate(items, { page: 10, pageSize: 10 });
      expect(result.items).toHaveLength(10);
      expect(result.hasMore).toBe(false);
    });

    it("paginates object entries", () => {
      const obj = { a: 1, b: 2, c: 3, d: 4 };
      const result = paginate(obj, { limit: 2 });
      expect(result.items).toEqual([
        { key: "a", value: 1 },
        { key: "b", value: 2 },
      ]);
      expect(result.totalItems).toBe(4);
      expect(result.hasMore).toBe(true);
    });
  });

  describe("filterData", () => {
    const users = [
      { id: 1, name: "Alice", role: "admin", age: 30, tags: ["core", "dev"] },
      { id: 2, name: "Bob", role: "user", age: 25, tags: ["dev"] },
      { id: 3, name: "Charlie", role: "user", age: 35, tags: ["sales"] },
      { id: 4, name: "Diana", role: "admin", age: 28, tags: ["core"] },
    ];

    it("filters with comparison operators", () => {
      const admins = filterData(users, {
        field: "role",
        op: "eq",
        value: "admin",
      });
      expect(admins.map((u) => (u as Record<string, unknown>)["name"])).toEqual(
        ["Alice", "Diana"],
      );

      const older = filterData(users, {
        field: "age",
        op: "gte",
        value: 30,
      });
      expect(older.map((u) => (u as Record<string, unknown>)["name"])).toEqual([
        "Alice",
        "Charlie",
      ]);

      const containsTag = filterData(users, {
        field: "tags",
        op: "contains",
        value: "core",
      });
      expect(
        containsTag.map((u) => (u as Record<string, unknown>)["name"]),
      ).toEqual(["Alice", "Diana"]);
    });

    it("evaluates composite and/or/not logical filters", () => {
      const filter = {
        and: [
          { field: "role", op: "eq" as const, value: "admin" },
          { field: "age", op: "lt" as const, value: 30 },
        ],
      };
      const result = filterData(users, filter);
      expect(result.map((u) => (u as Record<string, unknown>)["name"])).toEqual(
        ["Diana"],
      );
    });
  });

  describe("createJsonNavigationTools", () => {
    const tools = createJsonNavigationTools();
    const inspectTool = tools[0]!;
    const selectTool = tools[1]!;
    const paginateTool = tools[2]!;
    const filterTool = tools[3]!;
    const dummyContext: ToolContext = {
      requestId: "req-1",
      tenantId: "tenant-1",
      principal: { id: "user-1", scopes: [] },
    };

    it("creates all 4 standard JSON navigation tools", () => {
      expect(tools.map((t) => t.name)).toEqual([
        "json_inspect_shape",
        "json_select_path",
        "json_paginate",
        "json_filter",
      ]);
    });

    it("executes json_inspect_shape tool", async () => {
      const res = await inspectTool.execute(
        { json: JSON.stringify({ a: 1, b: "two" }) },
        dummyContext,
      );
      expect(res).toMatchObject({
        type: "object",
        keys: ["a", "b"],
      });
    });

    it("executes json_select_path tool", async () => {
      const res = await selectTool.execute(
        { json: { users: [{ id: 1 }, { id: 2 }] }, path: "$.users[0].id" },
        dummyContext,
      );
      expect(res).toBe(1);
    });

    it("executes json_paginate tool", async () => {
      const res = (await paginateTool.execute(
        { json: [1, 2, 3, 4, 5], limit: 2, offset: 2 },
        dummyContext,
      )) as PaginatedResult;
      expect(res.items).toEqual([3, 4]);
      expect(res.totalItems).toBe(5);
    });

    it("executes json_filter tool", async () => {
      const res = (await filterTool.execute(
        {
          json: [
            { id: 1, status: "active" },
            { id: 2, status: "pending" },
          ],
          field: "status",
          op: "eq",
          value: "active",
        },
        dummyContext,
      )) as unknown[];
      expect(res).toEqual([{ id: 1, status: "active" }]);
    });
  });
});

import { describe, expect, it } from "vitest";
import {
  filterData,
  inspectShape,
  JsonNavigationError,
  JsonNavigationLimitError,
  JsonPathSyntaxError,
  NavigationBudget,
  parseJsonPath,
  selectPath,
} from "../src/index.js";

describe("JSON Navigation Additional Tests", () => {
  describe("filterData edge cases and operators", () => {
    it("rejects non-array input", () => {
      expect(() =>
        filterData({ not: "an array" }, { field: "a", op: "eq", value: 1 }),
      ).toThrowError(JsonNavigationError);
    });

    const dataset = [
      {
        id: 1,
        name: "Alice",
        age: 25,
        tags: ["admin", "staff"],
        active: true,
        profile: { city: "NYC" },
      },
      {
        id: 2,
        name: "Bob",
        age: 30,
        tags: ["staff"],
        active: false,
        profile: { city: "SF" },
      },
      { id: 3, name: "Charlie", age: 35, tags: ["guest"], active: true },
    ];

    it("evaluates comparisons: neq, gte, lt, lte, and exists", () => {
      // exists
      const hasCity = filterData(dataset, {
        field: "profile.city",
        op: "exists",
      });
      expect(hasCity.map((x) => (x as { name: string }).name)).toEqual([
        "Alice",
        "Bob",
      ]);

      // neq
      const notBob = filterData(dataset, {
        field: "name",
        op: "neq",
        value: "Bob",
      });
      expect(notBob).toHaveLength(2);

      // gte
      const gte30 = filterData(dataset, { field: "age", op: "gte", value: 30 });
      expect(gte30.map((x) => (x as { name: string }).name)).toEqual([
        "Bob",
        "Charlie",
      ]);

      // lt
      const lt30 = filterData(dataset, { field: "age", op: "lt", value: 30 });
      expect(lt30.map((x) => (x as { name: string }).name)).toEqual(["Alice"]);

      // lte
      const lte30 = filterData(dataset, { field: "age", op: "lte", value: 30 });
      expect(lte30.map((x) => (x as { name: string }).name)).toEqual([
        "Alice",
        "Bob",
      ]);
    });

    it("returns false for numeric comparisons on non-numbers", () => {
      const res = filterData(dataset, { field: "name", op: "gt", value: 10 });
      expect(res).toHaveLength(0);
    });

    it("evaluates contains on strings and arrays", () => {
      // String contains
      const containsAl = filterData(dataset, {
        field: "name",
        op: "contains",
        value: "Al",
      });
      expect(containsAl.map((x) => (x as { name: string }).name)).toEqual([
        "Alice",
      ]);

      // Array contains
      const containsAdmin = filterData(dataset, {
        field: "tags",
        op: "contains",
        value: "admin",
      });
      expect(containsAdmin.map((x) => (x as { name: string }).name)).toEqual([
        "Alice",
      ]);

      // Non-string/non-array contains returns false
      const containsNonArray = filterData(dataset, {
        field: "age",
        op: "contains",
        value: "something",
      });
      expect(containsNonArray).toHaveLength(0);
    });

    it("evaluates in operator", () => {
      const inAges = filterData(dataset, {
        field: "age",
        op: "in",
        value: [25, 35],
      });
      expect(inAges.map((x) => (x as { name: string }).name)).toEqual([
        "Alice",
        "Charlie",
      ]);

      // Non-array pred.value returns false
      const inInvalid = filterData(dataset, {
        field: "age",
        op: "in",
        value: "not an array",
      });
      expect(inInvalid).toHaveLength(0);
    });

    it("safely handles dangerous prototype keys and missing fields in getField", () => {
      const resDangerous = filterData(dataset, {
        field: "__proto__.polluted",
        op: "exists",
      });
      expect(resDangerous).toHaveLength(0);

      const resConstructor = filterData(dataset, {
        field: "constructor.name",
        op: "exists",
      });
      expect(resConstructor).toHaveLength(0);

      const resMissingMiddle = filterData(dataset, {
        field: "nonexistent.child.deep",
        op: "exists",
      });
      expect(resMissingMiddle).toHaveLength(0);
    });

    it("evaluates logical compound filters: and, or, not", () => {
      // and
      const andFilter = filterData(dataset, {
        and: [
          { field: "active", op: "eq", value: true },
          { field: "age", op: "gt", value: 20 },
          { field: "name", op: "neq", value: "Alice" },
        ],
      });
      expect(andFilter.map((x) => (x as { name: string }).name)).toEqual([
        "Charlie",
      ]);

      // or
      const orFilter = filterData(dataset, {
        or: [
          { field: "name", op: "eq", value: "Alice" },
          { field: "age", op: "gt", value: 30 },
        ],
      });
      expect(orFilter.map((x) => (x as { name: string }).name)).toEqual([
        "Alice",
        "Charlie",
      ]);

      // not
      const notFilter = filterData(dataset, {
        not: { field: "active", op: "eq", value: true },
      });
      expect(notFilter.map((x) => (x as { name: string }).name)).toEqual([
        "Bob",
      ]);
    });
  });

  describe("parseJsonPath syntax and error checking", () => {
    it("rejects invalid path formats with JsonPathSyntaxError", () => {
      expect(() => parseJsonPath("")).toThrowError(JsonPathSyntaxError);
      expect(() => parseJsonPath("   ")).toThrowError(JsonPathSyntaxError);
      expect(() => parseJsonPath("$.users.")).toThrowError(JsonPathSyntaxError);
      expect(() => parseJsonPath("$.users..id")).toThrowError(
        JsonPathSyntaxError,
      );
      expect(() => parseJsonPath("$.__proto__")).toThrowError(
        JsonPathSyntaxError,
      );
      expect(() => parseJsonPath("$.prototype")).toThrowError(
        JsonPathSyntaxError,
      );
      expect(() => parseJsonPath("$[")).toThrowError(JsonPathSyntaxError);
      expect(() => parseJsonPath("$[?name]")).toThrowError(JsonPathSyntaxError);
    });

    it("parses wildcard and slice expressions", () => {
      const wildcard = parseJsonPath("$.users.*");
      expect(wildcard.hasMultiMatch).toBe(true);
      expect(wildcard.segments).toEqual([
        { type: "property", key: "users" },
        { type: "wildcard" },
      ]);

      const slice = parseJsonPath("$[0:10:2]");
      expect(slice.segments).toEqual([
        { type: "slice", start: 0, end: 10, step: 2 },
      ]);
    });

    it("selects paths with array indexing, slicing, and filters", () => {
      const data = {
        users: [
          { id: 1, name: "Alice", active: true },
          { id: 2, name: "Bob", active: false },
          { id: 3, name: "Charlie", active: true },
          { id: 4, name: "David", active: false },
        ],
      };

      // Slice
      const sliced = selectPath(data, "$.users[0:2]");
      expect(sliced).toEqual([
        { id: 1, name: "Alice", active: true },
        { id: 2, name: "Bob", active: false },
      ]);

      // Filter
      const filtered = selectPath(data, "$.users[?(@.active == true)]");
      expect(filtered).toEqual([
        { id: 1, name: "Alice", active: true },
        { id: 3, name: "Charlie", active: true },
      ]);

      // Negative index
      expect(selectPath(data.users, "$[-1]")).toEqual({
        id: 4,
        name: "David",
        active: false,
      });
      expect(selectPath(data.users, "$[-2]")).toEqual({
        id: 3,
        name: "Charlie",
        active: true,
      });

      // Negative step slice with explicit bounds
      const stepSlice = selectPath([1, 2, 3, 4, 5], "$[4:0:-1]");
      expect(stepSlice).toEqual([5, 4, 3, 2]);

      // Negative index slice
      const negSlice = selectPath([1, 2, 3, 4, 5], "$[-3:-1]");
      expect(negSlice).toEqual([3, 4]);

      // Wildcard on object
      const objWildcard = selectPath({ a: 1, b: 2, c: 3 }, "$[*]");
      expect(objWildcard).toEqual([1, 2, 3]);

      // Quoted and unquoted bracket property selector
      expect(selectPath({ "k-1": "v1" }, "$['k-1']")).toBe("v1");
      expect(selectPath({ "k-2": "v2" }, '$["k-2"]')).toBe("v2");
      expect(selectPath({ unquoted: "v3" }, "$[unquoted]")).toBe("v3");

      // Filter comparisons with nested field, truthy, !=, and number
      const usersData = [
        { user: { age: 20 }, active: true, role: "admin" },
        { user: { age: 15 }, active: false, role: "guest" },
      ];
      expect(selectPath(usersData, "$[?(@.user.age >= 18)]")).toHaveLength(1);
      expect(selectPath(usersData, "$[?(@.active)]")).toHaveLength(1);
      expect(selectPath(usersData, "$[?(@.role != 'admin')]")).toHaveLength(1);
    });

    it("rejects malformed filter and slice expressions with JsonPathSyntaxError", () => {
      expect(() => parseJsonPath("$[?(@.id == 1")).toThrowError(
        "Unclosed '(' in filter expression",
      );
      expect(() => parseJsonPath("$[?(@.id == 1)extra")).toThrowError(
        "Expected ']' after filter expression",
      );
      expect(() => parseJsonPath("$[?(@)]")).toThrowError(
        "Empty field in filter expression",
      );
      expect(() => parseJsonPath("$[?(@ == 1)]")).toThrowError(
        "Empty field in filter comparison",
      );
      expect(() => parseJsonPath("$[?(id == 1)]")).toThrowError(
        "Filter expression must start with '@'",
      );
      expect(() => parseJsonPath("$[?(@.__proto__ == 1)]")).toThrowError(
        "Forbidden field '__proto__' in filter",
      );

      expect(() => parseJsonPath("$[1:2:3:4]")).toThrowError(
        "Invalid slice syntax",
      );
      expect(() => parseJsonPath("$[1:2:0]")).toThrowError(
        "Invalid numeric values in slice",
      );
      expect(() => parseJsonPath("$['foo]")).toThrowError(
        "Unterminated quote in property selector",
      );
      expect(() => parseJsonPath("$[foo bar]")).toThrowError(
        "Invalid index or property",
      );
      expect(() => parseJsonPath("$[*foo]")).toThrowError(
        "Expected ']' after '*'",
      );
      expect(() => parseJsonPath("$['foo'bar]")).toThrowError(
        "Expected ']' after quoted property",
      );
      expect(() => parseJsonPath("$[__proto__]")).toThrowError(
        "Forbidden property name",
      );
      expect(() => parseJsonPath("$['constructor']")).toThrowError(
        "Forbidden property name",
      );
    });
  });

  describe("NavigationBudget and resource limits", () => {
    it("enforces maxDepth budget", () => {
      const budget = new NavigationBudget({ maxDepth: 2 });
      expect(() => budget.visitNode(3)).toThrowError(JsonNavigationLimitError);
    });

    it("enforces maxVisitedNodes budget", () => {
      const budget = new NavigationBudget({ maxVisitedNodes: 3 });
      budget.visitNode(1);
      budget.visitNode(1);
      budget.visitNode(1);
      expect(() => budget.visitNode(1)).toThrowError(JsonNavigationLimitError);
    });

    it("enforces maxResultBytes check", () => {
      const budget = new NavigationBudget({ maxResultBytes: 50 });
      expect(() => budget.checkBytes(100)).toThrowError(
        JsonNavigationLimitError,
      );
    });
  });

  describe("inspectShape edge cases", () => {
    it("summarizes heterogeneous arrays", () => {
      const mixed = ["hello", 123, { a: 1 }, null];
      const shape = inspectShape(mixed);
      expect(shape.type).toBe("array");
      expect(shape.itemTypes?.sort()).toEqual([
        "null",
        "number",
        "object",
        "string",
      ]);
    });

    it("detects and rejects circular references with JsonNavigationError", () => {
      const circular: Record<string, unknown> = { a: 1 };
      circular.self = circular;

      expect(() => inspectShape(circular)).toThrowError(
        "Circular reference detected in data",
      );
    });
  });
});

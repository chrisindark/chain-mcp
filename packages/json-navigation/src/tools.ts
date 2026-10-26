import type { ToolDefinition } from "@chainmcp/core";
import { type NavigationLimits, JsonNavigationError } from "./limits.js";
import { inspectShape } from "./shape.js";
import { selectPath } from "./path.js";
import { paginate } from "./paginate.js";
import { filterData, type FilterOp } from "./filter.js";

function parseJsonInput(raw: unknown): unknown {
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch (e) {
      throw new JsonNavigationError(
        `Failed to parse JSON string: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  return raw;
}

export function createJsonNavigationTools(
  limits?: NavigationLimits,
): ToolDefinition[] {
  const inspectShapeTool: ToolDefinition<
    { json: unknown; maxDepth?: number; maxKeys?: number },
    unknown
  > = {
    name: "json_inspect_shape",
    description:
      "Inspect the structure, depth, node counts, and key summary of a JSON document without emitting large payloads.",
    inputSchema: {
      type: "object",
      required: ["json"],
      properties: {
        json: {
          description: "Raw JSON string or structured object/array to inspect",
        },
        maxDepth: {
          type: "number",
          minimum: 1,
          maximum: 64,
          description: "Maximum traversal depth for shape inspection",
        },
        maxKeys: {
          type: "number",
          minimum: 1,
          maximum: 200,
          description: "Maximum number of object keys to enumerate",
        },
      },
    },
    operation: {},
    execute: async (input) => {
      const data = parseJsonInput(input.json);
      return inspectShape(data, {
        ...limits,
        ...(input.maxDepth !== undefined ? { maxDepth: input.maxDepth } : {}),
        ...(input.maxKeys !== undefined ? { maxKeys: input.maxKeys } : {}),
      });
    },
  };

  const selectPathTool: ToolDefinition<
    { json: unknown; path: string },
    unknown
  > = {
    name: "json_select_path",
    description:
      "Query and extract targeted fields from a JSON document using bounded JSON path expressions.",
    inputSchema: {
      type: "object",
      required: ["json", "path"],
      properties: {
        json: {
          description: "Raw JSON string or structured object/array to query",
        },
        path: {
          type: "string",
          minLength: 1,
          description:
            "JSON path expression (e.g. '$.items[0].name', 'users[*].id', 'books[?(@.price < 20)]')",
        },
      },
    },
    operation: {},
    execute: async (input) => {
      const data = parseJsonInput(input.json);
      return selectPath(data, input.path, limits);
    },
  };

  const paginateTool: ToolDefinition<
    {
      json: unknown;
      offset?: number;
      limit?: number;
      page?: number;
      pageSize?: number;
    },
    unknown
  > = {
    name: "json_paginate",
    description:
      "Paginate array items or object entries in a JSON document with bounded page sizes.",
    inputSchema: {
      type: "object",
      required: ["json"],
      properties: {
        json: {
          description: "Raw JSON string or array/object to paginate",
        },
        offset: {
          type: "number",
          minimum: 0,
          description: "0-based offset into items",
        },
        limit: {
          type: "number",
          minimum: 1,
          maximum: 1000,
          description: "Number of items per page",
        },
        page: {
          type: "number",
          minimum: 1,
          description: "1-based page number",
        },
        pageSize: {
          type: "number",
          minimum: 1,
          maximum: 1000,
          description: "Page size when using page-based pagination",
        },
      },
    },
    operation: {},
    execute: async (input) => {
      const data = parseJsonInput(input.json);
      return paginate(data, {
        ...limits,
        ...(input.offset !== undefined ? { offset: input.offset } : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
        ...(input.page !== undefined ? { page: input.page } : {}),
        ...(input.pageSize !== undefined ? { pageSize: input.pageSize } : {}),
      });
    },
  };

  const filterTool: ToolDefinition<
    { json: unknown; field: string; op: string; value?: unknown },
    unknown
  > = {
    name: "json_filter",
    description:
      "Filter array elements in a JSON document by field value predicates.",
    inputSchema: {
      type: "object",
      required: ["json", "field", "op"],
      properties: {
        json: {
          description: "Raw JSON string or array to filter",
        },
        field: {
          type: "string",
          minLength: 1,
          description: "Field path to test (e.g. 'status' or 'address.city')",
        },
        op: {
          type: "string",
          enum: [
            "eq",
            "neq",
            "gt",
            "gte",
            "lt",
            "lte",
            "contains",
            "in",
            "exists",
          ],
          description: "Comparison operator",
        },
        value: {
          description: "Comparison target value",
        },
      },
    },
    operation: {},
    execute: async (input) => {
      const data = parseJsonInput(input.json);
      return filterData(
        data,
        {
          field: input.field,
          op: input.op as FilterOp,
          value: input.value,
        },
        limits,
      );
    },
  };

  return [inspectShapeTool, selectPathTool, paginateTool, filterTool];
}

import type { ToolContext, ToolDefinition } from "@chainmcp/core";
import { type NavigationLimits, JsonNavigationError } from "./limits.js";
import { inspectShape } from "./shape.js";
import { selectPath } from "./path.js";
import { paginate } from "./paginate.js";
import { filterData, type FilterOp } from "./filter.js";
import {
  ResultHandleRegistry,
  type HandleRegistryOptions,
  type PrincipalScope,
} from "./handles.js";

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

function scopeOf(context: ToolContext): PrincipalScope {
  if (!context.tenantId || !context.principal?.id) {
    throw new JsonNavigationError(
      "Result-handle navigation requires a tenant and principal in the tool context",
    );
  }
  return { tenantId: context.tenantId, principalId: context.principal.id };
}

/**
 * Resolve the active document for a navigation tool call: prefer an
 * explicit result `handle` when the caller supplies one, otherwise parse
 * the inline `json` argument. When both are absent the inline parse
 * throws the same error as before.
 */
async function resolveDocument(
  input: { json?: unknown; handle?: string },
  context: ToolContext,
  registry: ResultHandleRegistry,
): Promise<unknown> {
  if (input.handle !== undefined) {
    return await registry.resolveAsync(input.handle, scopeOf(context));
  }
  return parseJsonInput(input.json);
}

export function createJsonNavigationTools(
  limits?: NavigationLimits,
  handleRegistry?: ResultHandleRegistry | HandleRegistryOptions,
): ToolDefinition[] {
  const handles =
    handleRegistry instanceof ResultHandleRegistry
      ? handleRegistry
      : handleRegistry
        ? new ResultHandleRegistry(handleRegistry)
        : new ResultHandleRegistry();
  const inspectShapeTool: ToolDefinition<
    {
      json?: unknown;
      handle?: string;
      maxDepth?: number;
      maxKeys?: number;
    },
    unknown
  > = {
    name: "json_inspect_shape",
    description:
      "Inspect the structure, depth, node counts, and key summary of a JSON document without emitting large payloads. Pass either the inline `json` document or a `handle` returned by a previous navigation call.",
    inputSchema: {
      type: "object",
      properties: {
        json: {
          description:
            "Raw JSON string or structured object/array to inspect. Provide either this or `handle`.",
        },
        handle: {
          type: "string",
          minLength: 1,
          description:
            "Opaque result handle from a previous navigation call. Prefer this over `json` for large documents: the model does not need to paste the full payload back.",
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
    execute: async (input, context) => {
      const data = await resolveDocument(input, context, handles);
      return inspectShape(data, {
        ...limits,
        ...(input.maxDepth !== undefined ? { maxDepth: input.maxDepth } : {}),
        ...(input.maxKeys !== undefined ? { maxKeys: input.maxKeys } : {}),
      });
    },
  };

  const selectPathTool: ToolDefinition<
    { json?: unknown; handle?: string; path: string },
    unknown
  > = {
    name: "json_select_path",
    description:
      "Query and extract targeted fields from a JSON document using bounded JSON path expressions. Pass either the inline `json` document or a `handle` returned by a previous navigation call.",
    inputSchema: {
      type: "object",
      required: ["path"],
      properties: {
        json: {
          description:
            "Raw JSON string or structured object/array to query. Provide either this or `handle`.",
        },
        handle: {
          type: "string",
          minLength: 1,
          description: "Opaque result handle from a previous navigation call.",
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
    execute: async (input, context) => {
      const data = await resolveDocument(input, context, handles);
      return selectPath(data, input.path, limits);
    },
  };

  const paginateTool: ToolDefinition<
    {
      json?: unknown;
      handle?: string;
      offset?: number;
      limit?: number;
      page?: number;
      pageSize?: number;
    },
    unknown
  > = {
    name: "json_paginate",
    description:
      "Paginate array items or object entries in a JSON document with bounded page sizes. Pass either the inline `json` document or a `handle` returned by a previous navigation call.",
    inputSchema: {
      type: "object",
      properties: {
        json: {
          description:
            "Raw JSON string or array/object to paginate. Provide either this or `handle`.",
        },
        handle: {
          type: "string",
          minLength: 1,
          description: "Opaque result handle from a previous navigation call.",
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
    execute: async (input, context) => {
      const data = await resolveDocument(input, context, handles);
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
    {
      json?: unknown;
      handle?: string;
      field: string;
      op: string;
      value?: unknown;
    },
    unknown
  > = {
    name: "json_filter",
    description:
      "Filter array elements in a JSON document by field value predicates. Pass either the inline `json` document or a `handle` returned by a previous navigation call.",
    inputSchema: {
      type: "object",
      required: ["field", "op"],
      properties: {
        json: {
          description:
            "Raw JSON string or array to filter. Provide either this or `handle`.",
        },
        handle: {
          type: "string",
          minLength: 1,
          description: "Opaque result handle from a previous navigation call.",
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
    execute: async (input, context) => {
      const data = await resolveDocument(input, context, handles);
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

  const createHandleTool: ToolDefinition<
    { json: unknown },
    { handle: string; bytes: number }
  > = {
    name: "json_create_handle",
    description:
      "Store a JSON document server-side and return an opaque result handle. Subsequent navigation calls can pass the handle instead of pasting the full document back inline.",
    inputSchema: {
      type: "object",
      required: ["json"],
      properties: {
        json: {
          description: "Raw JSON string or structured object/array to store",
        },
      },
    },
    operation: {},
    execute: async (input, context) => {
      const data = parseJsonInput(input.json);
      const handle = await handles.storeAsync(data, scopeOf(context));
      return { handle, bytes: handles.measureBytes(data) };
    },
  };

  return [
    inspectShapeTool,
    selectPathTool,
    paginateTool,
    filterTool,
    createHandleTool,
  ];
}

import {
  auditInputSchema,
  type JsonSchema,
  type ToolContext,
  type ToolDefinition,
} from "@chainmcp/core";
import { AuthoringError, type DefineToolOptions } from "./types.js";
import { zodToJsonSchema } from "./zod-adapter.js";

const TOOL_NAME_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Defines an MCP tool in application code with definition-time schema lowering
 * and audit. Accepts either a Zod schema or raw JSON Schema, and returns a
 * validated ToolDefinition ready to be registered in ToolRuntime.
 */
export function defineTool<TInput = unknown, TOutput = unknown>(
  options: DefineToolOptions<TInput, TOutput>,
): ToolDefinition<TInput, TOutput> {
  if (!options || typeof options !== "object") {
    throw new TypeError("defineTool options must be an object");
  }

  if (typeof options.name !== "string" || !TOOL_NAME_REGEX.test(options.name)) {
    throw new TypeError(
      "Tool name must be 1-64 letters, numbers, underscores, or hyphens",
    );
  }

  if (
    typeof options.description !== "string" ||
    options.description.trim().length === 0
  ) {
    throw new TypeError("Tool description must be a non-empty string");
  }

  if (typeof options.execute !== "function") {
    throw new TypeError("Tool execute must be a function");
  }

  if (options.schema !== undefined && options.inputSchema !== undefined) {
    throw new AuthoringError(
      "INVALID_TOOL_DEFINITION",
      "Provide either 'schema' (Zod) or 'inputSchema' (JsonSchema), not both",
    );
  }

  let finalInputSchema: JsonSchema;

  if (options.schema !== undefined) {
    finalInputSchema = zodToJsonSchema(options.schema);
  } else if (options.inputSchema !== undefined) {
    const raw = options.inputSchema;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new AuthoringError(
        "SCHEMA_NOT_OBJECT",
        "Tool inputSchema must be an object",
      );
    }
    if (raw.type !== undefined && raw.type !== "object") {
      throw new AuthoringError(
        "SCHEMA_NOT_OBJECT",
        `Tool inputSchema must declare type 'object', but got '${String(raw.type)}'`,
      );
    }
    const auditResult = auditInputSchema(raw);
    if (!auditResult.supported) {
      const firstDiag = auditResult.diagnostics[0];
      const message = firstDiag
        ? `${firstDiag.code}: ${firstDiag.message}`
        : "Schema audit failed";
      throw new AuthoringError(
        "SCHEMA_AUDIT_FAILED",
        message,
        auditResult.diagnostics,
      );
    }
    finalInputSchema = raw;
  } else {
    finalInputSchema = {
      type: "object",
      additionalProperties: false,
    };
  }

  const contractRevision = options.contractRevision ?? options.version;

  const tool: ToolDefinition<TInput, TOutput> = {
    name: options.name,
    description: options.description,
    inputSchema: finalInputSchema,
    operation: options.operation ?? {},
    ...(options.cache !== undefined ? { cache: options.cache } : {}),
    ...(options.output !== undefined ? { output: options.output } : {}),
    ...(contractRevision !== undefined ? { contractRevision } : {}),
    ...(options.ownerTenantId !== undefined
      ? { ownerTenantId: options.ownerTenantId }
      : {}),
    ...(options.timeoutMs !== undefined
      ? { timeoutMs: options.timeoutMs }
      : {}),
    execute: async (
      rawInput: unknown,
      context: ToolContext,
    ): Promise<TOutput> => {
      const parsedInput =
        options.schema !== undefined
          ? (options.schema.parse(rawInput) as TInput)
          : (rawInput as TInput);
      return options.execute(parsedInput, context);
    },
  };

  return tool;
}

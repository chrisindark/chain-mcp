import { auditInputSchema, type JsonSchema } from "@chainmcp/core";
import { z } from "zod";
import { AuthoringError } from "./types.js";

/**
 * Strips meta keywords like `$schema` and `$id` that are not part of the
 * audited MCP tool schema subset.
 */
function stripMetaKeywords(value: unknown): unknown {
  if (typeof value !== "object" || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(stripMetaKeywords);
  }
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value)) {
    if (key === "$schema" || key === "$id") {
      continue;
    }
    result[key] = stripMetaKeywords(val);
  }
  return result;
}

/**
 * Lowers a Zod schema to the audited JSON Schema subset supported by ChainMcp.
 * Rejects unsupported constructs (e.g. non-object root, unbounded constructs,
 * or unsupported keywords) at definition time with typed diagnostics.
 */
export function zodToJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  if (
    !schema ||
    typeof (schema as { safeParse?: unknown }).safeParse !== "function"
  ) {
    throw new AuthoringError(
      "SCHEMA_LOWERING_FAILED",
      "Expected a valid Zod schema instance",
    );
  }

  let rawJsonSchema: unknown;
  try {
    rawJsonSchema = z.toJSONSchema(schema);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new AuthoringError(
      "SCHEMA_LOWERING_FAILED",
      `Failed to lower Zod schema: ${message}`,
    );
  }

  const cleaned = stripMetaKeywords(rawJsonSchema) as Record<string, unknown>;

  if (
    typeof cleaned !== "object" ||
    cleaned === null ||
    Array.isArray(cleaned)
  ) {
    throw new AuthoringError(
      "SCHEMA_NOT_OBJECT",
      "Root tool input schema must be an object",
    );
  }

  if (cleaned.type !== "object") {
    throw new AuthoringError(
      "SCHEMA_NOT_OBJECT",
      `Root tool input schema must declare type 'object', but got '${String(cleaned.type)}'`,
    );
  }

  const auditResult = auditInputSchema(cleaned);
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

  return cleaned as JsonSchema;
}

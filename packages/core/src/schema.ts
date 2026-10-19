export type JsonSchema = Readonly<Record<string, unknown>>;

export type SchemaDiagnosticCode =
  | "SCHEMA_NOT_OBJECT"
  | "SCHEMA_UNSUPPORTED_KEYWORD"
  | "SCHEMA_INVALID_TYPE"
  | "SCHEMA_INVALID_ENUM"
  | "SCHEMA_INVALID_REQUIRED"
  | "SCHEMA_INVALID_PROPERTIES"
  | "SCHEMA_INVALID_ADDITIONAL_PROPERTIES"
  | "SCHEMA_INVALID_ITEMS"
  | "SCHEMA_CYCLE"
  | "SCHEMA_TOO_DEEP";

export interface SchemaDiagnostic {
  code: SchemaDiagnosticCode;
  path: string;
  message: string;
}

export interface SchemaAuditResult {
  supported: boolean;
  diagnostics: readonly SchemaDiagnostic[];
}

export const MAX_SCHEMA_DEPTH = 32;

const SUPPORTED_SCHEMA_KEYWORDS = new Set([
  "type",
  "enum",
  "required",
  "properties",
  "additionalProperties",
  "items",
  "title",
  "description",
  "default",
  "examples",
  "deprecated",
  "readOnly",
  "writeOnly",
  "$comment",
]);

const SUPPORTED_SCHEMA_TYPES = new Set([
  "object",
  "array",
  "string",
  "number",
  "integer",
  "boolean",
  "null",
]);

/**
 * Audit a tool input schema against the runtime's supported JSON Schema subset.
 * Returns every unsupported construct with a stable code, path, and message.
 * Callers must treat a non-empty diagnostics list as unsupported.
 */
export function auditInputSchema(schema: unknown): SchemaAuditResult {
  const diagnostics: SchemaDiagnostic[] = [];
  auditSchema(schema, "$", 0, new Set(), diagnostics);
  return { supported: diagnostics.length === 0, diagnostics };
}

function auditSchema(
  schema: unknown,
  path: string,
  depth: number,
  ancestors: Set<object>,
  diagnostics: SchemaDiagnostic[],
): void {
  if (!isJsonObject(schema)) {
    diagnostics.push({
      code: "SCHEMA_NOT_OBJECT",
      path,
      message: `Schema at ${path} must be an object`,
    });
    return;
  }
  if (depth > MAX_SCHEMA_DEPTH) {
    diagnostics.push({
      code: "SCHEMA_TOO_DEEP",
      path,
      message: `Schema at ${path} exceeds the maximum depth of ${MAX_SCHEMA_DEPTH}`,
    });
    return;
  }
  if (ancestors.has(schema)) {
    diagnostics.push({
      code: "SCHEMA_CYCLE",
      path,
      message: `Schema at ${path} contains a cycle`,
    });
    return;
  }
  ancestors.add(schema);
  try {
    for (const keyword of Object.keys(schema)) {
      if (!SUPPORTED_SCHEMA_KEYWORDS.has(keyword)) {
        diagnostics.push({
          code: "SCHEMA_UNSUPPORTED_KEYWORD",
          path,
          message: `Schema keyword '${keyword}' at ${path} is not supported`,
        });
      }
    }

    auditTypeDeclaration(schema.type, path, diagnostics);

    if ("enum" in schema) {
      if (!Array.isArray(schema.enum) || schema.enum.length === 0) {
        diagnostics.push({
          code: "SCHEMA_INVALID_ENUM",
          path,
          message: `Schema 'enum' at ${path} must be a non-empty array`,
        });
      } else if (schema.enum.some((entry) => !isEnumPrimitive(entry))) {
        diagnostics.push({
          code: "SCHEMA_INVALID_ENUM",
          path,
          message: `Schema 'enum' at ${path} must contain only primitive JSON values`,
        });
      } else if (
        schema.enum.some(
          (entry) => typeof entry === "number" && !Number.isFinite(entry),
        )
      ) {
        // A non-finite entry can never match: it cannot appear in JSON, and the
        // type check rejects non-finite numbers before the enum comparison.
        diagnostics.push({
          code: "SCHEMA_INVALID_ENUM",
          path,
          message: `Schema 'enum' at ${path} must contain only finite numbers; NaN and Infinity cannot be represented`,
        });
      }
    }

    if ("required" in schema) {
      if (
        !Array.isArray(schema.required) ||
        !schema.required.every((key) => typeof key === "string")
      ) {
        diagnostics.push({
          code: "SCHEMA_INVALID_REQUIRED",
          path,
          message: `Schema 'required' at ${path} must be an array of strings`,
        });
      }
    }

    if ("properties" in schema) {
      if (!isJsonObject(schema.properties)) {
        diagnostics.push({
          code: "SCHEMA_INVALID_PROPERTIES",
          path,
          message: `Schema 'properties' at ${path} must be an object`,
        });
      } else {
        for (const [key, propertySchema] of Object.entries(schema.properties)) {
          auditSchema(
            propertySchema,
            `${path}.properties.${key}`,
            depth + 1,
            ancestors,
            diagnostics,
          );
        }
      }
    }

    if (
      "additionalProperties" in schema &&
      typeof schema.additionalProperties !== "boolean"
    ) {
      diagnostics.push({
        code: "SCHEMA_INVALID_ADDITIONAL_PROPERTIES",
        path,
        message: `Schema 'additionalProperties' at ${path} must be a boolean`,
      });
    }

    if ("items" in schema) {
      if (!isJsonObject(schema.items)) {
        diagnostics.push({
          code: "SCHEMA_INVALID_ITEMS",
          path,
          message: `Schema 'items' at ${path} must be an object schema; tuple and boolean forms are not supported`,
        });
      } else {
        auditSchema(
          schema.items,
          `${path}.items`,
          depth + 1,
          ancestors,
          diagnostics,
        );
      }
    }
  } finally {
    ancestors.delete(schema);
  }
}

function isEnumPrimitive(entry: unknown): boolean {
  return (
    entry === null ||
    typeof entry === "string" ||
    typeof entry === "boolean" ||
    typeof entry === "number"
  );
}

function auditTypeDeclaration(
  type: unknown,
  path: string,
  diagnostics: SchemaDiagnostic[],
): void {
  if (type === undefined) return;
  const types = typeof type === "string" ? [type] : type;
  if (!Array.isArray(types) || types.length === 0) {
    diagnostics.push({
      code: "SCHEMA_INVALID_TYPE",
      path,
      message: `Schema 'type' at ${path} must be a string or a non-empty array of strings`,
    });
    return;
  }
  for (const entry of types) {
    if (typeof entry !== "string" || !SUPPORTED_SCHEMA_TYPES.has(entry)) {
      diagnostics.push({
        code: "SCHEMA_INVALID_TYPE",
        path,
        message: `Schema type '${String(entry)}' at ${path} is not supported`,
      });
    }
  }
}

export function isJsonObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

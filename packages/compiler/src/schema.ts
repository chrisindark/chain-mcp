import { MAX_SCHEMA_DEPTH, type JsonSchema } from "@chainmcp/core";

import { isPlainObject } from "./document.js";
import { resolveLocalPointer } from "./refs.js";
import type {
  CompileDiagnostic,
  DiagnosticSeverity,
  OpenApiVersion,
} from "./types.js";

export interface SchemaTranslationContext {
  document: Record<string, unknown>;
  version: OpenApiVersion;
  strict: boolean;
  maxRefDepth: number;
  diagnostics: CompileDiagnostic[];
}

export function translateInputSchema(
  schema: unknown,
  context: SchemaTranslationContext,
): JsonSchema | undefined {
  return translateSchema(schema, context, 0, new Set(), []);
}

/** Constraints the runtime cannot enforce and that cannot be dropped safely. */
const COMPOSITION_KEYWORDS = new Set([
  "allOf",
  "anyOf",
  "oneOf",
  "not",
  "if",
  "then",
  "else",
  "dependentSchemas",
  "dependentRequired",
  "patternProperties",
  "propertyNames",
  "contains",
  "minContains",
  "maxContains",
  "unevaluatedProperties",
  "unevaluatedItems",
]);

/**
 * Supported JSON Schema constraints the runtime validator does not implement.
 * Strict mode rejects them; permissive mode drops them with a warning instead
 * of silently weakening validation.
 */
const UNSUPPORTED_CONSTRAINTS = new Set([
  "const",
  "contentEncoding",
  "contentMediaType",
  "exclusiveMaximum",
  "exclusiveMinimum",
  "format",
  "maxItems",
  "maxLength",
  "maxProperties",
  "maximum",
  "minItems",
  "minLength",
  "minProperties",
  "minimum",
  "multipleOf",
  "pattern",
  "uniqueItems",
]);

const ANNOTATION_KEYWORDS = new Set([
  "title",
  "description",
  "default",
  "examples",
  "deprecated",
  "readOnly",
  "writeOnly",
  "$comment",
]);

/** OpenAPI-only annotations with no effect on runtime validation. */
const DROPPABLE_KEYWORDS = new Set([
  "$anchor",
  "$defs",
  "$id",
  "$schema",
  "definitions",
  "discriminator",
  "example",
  "externalDocs",
  "summary",
  "xml",
]);

function translateSchema(
  schema: unknown,
  context: SchemaTranslationContext,
  depth: number,
  ancestors: Set<object>,
  refStack: readonly string[],
): JsonSchema | undefined {
  if (!isPlainObject(schema)) {
    report(context, "error", "SCHEMA_INVALID", "Schema must be an object");
    return undefined;
  }
  if (depth > MAX_SCHEMA_DEPTH) {
    report(
      context,
      "error",
      "SCHEMA_INVALID",
      `Schema exceeds the maximum depth of ${MAX_SCHEMA_DEPTH}`,
    );
    return undefined;
  }
  if (ancestors.has(schema)) {
    report(context, "error", "SCHEMA_INVALID", "Schema contains a cycle");
    return undefined;
  }
  ancestors.add(schema);
  try {
    if (Object.hasOwn(schema, "$ref")) {
      return translateReference(schema, context, depth, ancestors, refStack);
    }

    const nullable = readNullable(schema, context);
    if (nullable === undefined) return undefined;

    const result: Record<string, unknown> = {};
    const droppedProperties = new Set<string>();

    if (Object.hasOwn(schema, "properties")) {
      if (!isPlainObject(schema.properties)) {
        report(
          context,
          "error",
          "SCHEMA_INVALID",
          "Schema 'properties' must be an object",
        );
        return undefined;
      }
      const propertyEntries: Array<[string, JsonSchema]> = [];
      for (const [name, propertySchema] of Object.entries(schema.properties)) {
        if (isPlainObject(propertySchema) && propertySchema.readOnly === true) {
          // Read-only response fields are not request inputs.
          droppedProperties.add(name);
          continue;
        }
        const translated = translateSchema(
          propertySchema,
          context,
          depth + 1,
          ancestors,
          refStack,
        );
        if (translated === undefined) {
          droppedProperties.add(name);
          continue;
        }
        propertyEntries.push([name, translated]);
      }
      if (propertyEntries.length > 0) {
        // Object.fromEntries defines own data properties, so a key named
        // `__proto__` cannot mutate the properties object's prototype.
        result.properties = Object.fromEntries(propertyEntries);
      }
    }

    if (Object.hasOwn(schema, "required")) {
      if (
        !Array.isArray(schema.required) ||
        !schema.required.every((entry) => typeof entry === "string")
      ) {
        report(
          context,
          "error",
          "SCHEMA_INVALID",
          "Schema 'required' must be an array of strings",
        );
        return undefined;
      }
      const required = schema.required.filter(
        (name) => !droppedProperties.has(name),
      );
      if (required.length > 0) result.required = required;
    }

    for (const [keyword, value] of Object.entries(schema)) {
      if (
        keyword === "$ref" ||
        keyword === "properties" ||
        keyword === "required" ||
        keyword === "nullable"
      ) {
        continue;
      }
      if (keyword === "type") {
        result.type = translateType(value, nullable, context);
        continue;
      }
      if (keyword === "enum") {
        result.enum =
          nullable && Array.isArray(value) && !value.some((e) => e === null)
            ? [...value, null]
            : value;
        continue;
      }
      if (keyword === "additionalProperties") {
        if (typeof value === "boolean") {
          result.additionalProperties = value;
          continue;
        }
        // A schema-valued `additionalProperties` cannot be represented by the
        // runtime. Dropping it would allow arbitrary values.
        report(
          context,
          "error",
          "SCHEMA_UNSUPPORTED",
          "Schema 'additionalProperties' must be boolean",
        );
        return undefined;
      }
      if (keyword === "items") {
        if (!isPlainObject(value)) {
          report(
            context,
            "error",
            "SCHEMA_UNSUPPORTED",
            "Schema 'items' must be an object; tuple and boolean forms are not supported",
          );
          return undefined;
        }
        const items = translateSchema(
          value,
          context,
          depth + 1,
          ancestors,
          refStack,
        );
        if (items === undefined) return undefined;
        result.items = items;
        continue;
      }
      if (ANNOTATION_KEYWORDS.has(keyword)) {
        result[keyword] = value;
        continue;
      }
      if (DROPPABLE_KEYWORDS.has(keyword)) continue;
      if (keyword.startsWith("x-")) continue;

      if (COMPOSITION_KEYWORDS.has(keyword)) {
        // Composition changes which values are valid; dropping it would be a
        // validation bypass, so it is an error even in permissive mode.
        report(
          context,
          "error",
          "SCHEMA_UNSUPPORTED",
          `Schema keyword '${keyword}' is not supported`,
        );
        return undefined;
      }
      if (UNSUPPORTED_CONSTRAINTS.has(keyword)) {
        const severity = context.strict ? "error" : "warning";
        report(
          context,
          severity,
          "SCHEMA_UNSUPPORTED",
          `Schema keyword '${keyword}' is not supported and was ${
            context.strict ? "rejected" : "dropped"
          }`,
        );
        if (context.strict) return undefined;
        continue;
      }
      report(
        context,
        "error",
        "SCHEMA_UNSUPPORTED",
        `Schema keyword '${keyword}' is not supported`,
      );
      return undefined;
    }

    if (nullable) {
      const type = result.type;
      if (type === undefined) {
        // `readNullable` already rejects this; keep the guard so a future
        // change cannot emit a schema whose nullability was dropped.
        return undefined;
      }
    }
    return result;
  } finally {
    ancestors.delete(schema);
  }
}

function translateReference(
  schema: Record<string, unknown>,
  context: SchemaTranslationContext,
  depth: number,
  ancestors: Set<object>,
  refStack: readonly string[],
): JsonSchema | undefined {
  const ref = schema.$ref;
  const siblings = Object.keys(schema).filter(
    (key) =>
      key !== "$ref" &&
      key !== "summary" &&
      key !== "description" &&
      key !== "title" &&
      key !== "example" &&
      key !== "examples" &&
      key !== "$comment",
  );
  if (siblings.length > 0) {
    report(
      context,
      "error",
      "REF_SIBLINGS_UNSUPPORTED",
      `Reference '${String(ref)}' has unsupported sibling keys: ${siblings.join(", ")}`,
    );
    return undefined;
  }
  if (typeof ref !== "string") {
    report(context, "error", "REF_INVALID", "Schema '$ref' must be a string");
    return undefined;
  }
  if (refStack.includes(ref)) {
    report(
      context,
      "error",
      "REF_CYCLE",
      `Circular reference detected: ${[...refStack, ref].join(" -> ")}`,
    );
    return undefined;
  }
  if (refStack.length >= context.maxRefDepth) {
    report(
      context,
      "error",
      "REF_DEPTH_EXCEEDED",
      `Reference chain exceeds the maximum depth of ${context.maxRefDepth}`,
    );
    return undefined;
  }
  const resolved = resolveLocalPointer(context.document, ref);
  if (!resolved.ok) {
    report(context, "error", resolved.code, resolved.message);
    return undefined;
  }
  if (!isPlainObject(resolved.value)) {
    report(
      context,
      "error",
      "REF_INVALID",
      `Reference '${ref}' must resolve to a schema object`,
    );
    return undefined;
  }
  return translateSchema(resolved.value, context, depth + 1, ancestors, [
    ...refStack,
    ref,
  ]);
}

/**
 * Returns whether nullability was requested, or `undefined` when the document
 * is invalid for the declared OpenAPI version. OpenAPI 3.0 uses `nullable`;
 * OpenAPI 3.1 uses the JSON Schema `null` type.
 */
function readNullable(
  schema: Record<string, unknown>,
  context: SchemaTranslationContext,
): boolean | undefined {
  if (!Object.hasOwn(schema, "nullable")) return false;
  if (context.version === "3.1") {
    report(
      context,
      "error",
      "SCHEMA_NULLABLE_INVALID",
      "OpenAPI 3.1 schemas must express nullability with a 'null' type, not 'nullable'",
    );
    return undefined;
  }
  const nullable = schema.nullable;
  if (typeof nullable !== "boolean") {
    report(
      context,
      "error",
      "SCHEMA_NULLABLE_INVALID",
      "Schema 'nullable' must be a boolean",
    );
    return undefined;
  }
  if (!nullable) return false;
  if (!Object.hasOwn(schema, "type")) {
    report(
      context,
      "error",
      "SCHEMA_NULLABLE_INVALID",
      "Schema 'nullable: true' requires a sibling 'type'",
    );
    return undefined;
  }
  return true;
}

function translateType(
  type: unknown,
  nullable: boolean,
  context: SchemaTranslationContext,
): unknown {
  if (!nullable) return type;
  const types =
    typeof type === "string"
      ? [type]
      : Array.isArray(type) && type.every((entry) => typeof entry === "string")
        ? [...type]
        : undefined;
  if (types === undefined) {
    report(
      context,
      "error",
      "SCHEMA_INVALID",
      "Schema 'type' must be a string or an array of strings",
    );
    return type;
  }
  if (!types.includes("null")) types.push("null");
  return types;
}

function report(
  context: SchemaTranslationContext,
  severity: DiagnosticSeverity,
  code: CompileDiagnostic["code"],
  message: string,
): void {
  context.diagnostics.push({ severity, code, message });
}

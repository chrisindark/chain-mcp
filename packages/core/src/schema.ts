import { isIP } from "node:net";

import { RE2JS } from "re2js";

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
  | "SCHEMA_INVALID_CONSTRAINT"
  | "SCHEMA_INVALID_PATTERN"
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

/** Maximum accepted regular-expression length for the `pattern` keyword. */
export const MAX_PATTERN_LENGTH = 4_096;

const MAX_CACHED_PATTERNS = 256;
const MAX_CANONICAL_DEPTH = 64;
const MAX_CANONICAL_NODES = 10_000;

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
  "format",
  "minLength",
  "maxLength",
  "pattern",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
]);

const NON_NEGATIVE_INTEGER_CONSTRAINTS = new Set([
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "minProperties",
  "maxProperties",
]);

const FINITE_NUMBER_CONSTRAINTS = new Set([
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
]);

/**
 * Formats that the runtime asserts. Other JSON Schema formats remain
 * annotations, matching the default behavior of the specification.
 */
const ASSERTED_FORMATS = new Set([
  "date-time",
  "date",
  "time",
  "email",
  "hostname",
  "ipv4",
  "ipv6",
  "uri",
  "uuid",
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

    auditConstraints(schema, path, diagnostics);

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

function auditConstraints(
  schema: Record<string, unknown>,
  path: string,
  diagnostics: SchemaDiagnostic[],
): void {
  for (const keyword of NON_NEGATIVE_INTEGER_CONSTRAINTS) {
    if (!Object.hasOwn(schema, keyword)) continue;
    const value = schema[keyword];
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
      diagnostics.push({
        code: "SCHEMA_INVALID_CONSTRAINT",
        path,
        message: `Schema '${keyword}' at ${path} must be a non-negative safe integer`,
      });
    }
  }

  for (const keyword of FINITE_NUMBER_CONSTRAINTS) {
    if (!Object.hasOwn(schema, keyword)) continue;
    const value = schema[keyword];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      diagnostics.push({
        code: "SCHEMA_INVALID_CONSTRAINT",
        path,
        message: `Schema '${keyword}' at ${path} must be a finite number`,
      });
    }
  }

  if (Object.hasOwn(schema, "multipleOf")) {
    const value = schema.multipleOf;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      diagnostics.push({
        code: "SCHEMA_INVALID_CONSTRAINT",
        path,
        message: `Schema 'multipleOf' at ${path} must be a finite number greater than zero`,
      });
    }
  }

  if (
    Object.hasOwn(schema, "uniqueItems") &&
    typeof schema.uniqueItems !== "boolean"
  ) {
    diagnostics.push({
      code: "SCHEMA_INVALID_CONSTRAINT",
      path,
      message: `Schema 'uniqueItems' at ${path} must be a boolean`,
    });
  }

  if (Object.hasOwn(schema, "format") && typeof schema.format !== "string") {
    diagnostics.push({
      code: "SCHEMA_INVALID_CONSTRAINT",
      path,
      message: `Schema 'format' at ${path} must be a string`,
    });
  }

  if (Object.hasOwn(schema, "pattern")) {
    if (typeof schema.pattern !== "string") {
      diagnostics.push({
        code: "SCHEMA_INVALID_PATTERN",
        path,
        message: `Schema 'pattern' at ${path} must be a string`,
      });
    } else if (schema.pattern.length > MAX_PATTERN_LENGTH) {
      diagnostics.push({
        code: "SCHEMA_INVALID_PATTERN",
        path,
        message: `Schema 'pattern' at ${path} exceeds the maximum length of ${MAX_PATTERN_LENGTH}`,
      });
    } else if (compilePattern(schema.pattern) === undefined) {
      diagnostics.push({
        code: "SCHEMA_INVALID_PATTERN",
        path,
        message: `Schema 'pattern' at ${path} is not a valid RE2 regular expression`,
      });
    }
  }
}

/** Returns true when the runtime asserts this format on string values. */
export function isAssertedFormat(format: string): boolean {
  return ASSERTED_FORMATS.has(format);
}

/**
 * Checks a string against an asserted format. Unknown formats are annotations
 * and always match; callers should use `isAssertedFormat` for diagnostics.
 */
export function matchesFormat(format: string, value: string): boolean {
  switch (format) {
    case "date-time":
      return isDateTime(value);
    case "date":
      return isDate(value);
    case "time":
      return isTime(value);
    case "email":
      return isEmail(value);
    case "hostname":
      return isHostname(value);
    case "ipv4":
      return isIP(value) === 4;
    case "ipv6":
      return isIP(value) === 6;
    case "uri":
      return isUri(value);
    case "uuid":
      return UUID_PATTERN.test(value);
    default:
      return true;
  }
}

const patternCache = new Map<string, RE2JS | null>();

/** Compiles a pattern with the linear-time RE2 engine, caching bounded results. */
function compilePattern(pattern: string): RE2JS | undefined {
  if (pattern.length > MAX_PATTERN_LENGTH) return undefined;
  const cached = patternCache.get(pattern);
  if (cached !== undefined) return cached ?? undefined;
  let compiled: RE2JS | null;
  try {
    compiled = RE2JS.compile(pattern);
  } catch {
    compiled = null;
  }
  if (patternCache.size >= MAX_CACHED_PATTERNS) patternCache.clear();
  patternCache.set(pattern, compiled);
  return compiled ?? undefined;
}

/** Tests an unanchored JSON Schema `pattern` against a string. */
export function patternMatches(pattern: string, value: string): boolean {
  return compilePattern(pattern)?.test(value) ?? false;
}

/**
 * Produces a deterministic key for a JSON value. Returns undefined when the
 * value is not JSON-representable or exceeds the bounded comparison budget, so
 * callers can fail closed rather than silently skipping a constraint.
 */
export function stableValueKey(value: unknown): string | undefined {
  return stableValueKeyInner(value, 0, { nodes: 0 });
}

function stableValueKeyInner(
  value: unknown,
  depth: number,
  budget: { nodes: number },
): string | undefined {
  if (depth > MAX_CANONICAL_DEPTH) return undefined;
  budget.nodes += 1;
  if (budget.nodes > MAX_CANONICAL_NODES) return undefined;

  if (value === null) return "null";
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      return Number.isFinite(value) ? JSON.stringify(value) : undefined;
    case "object":
      break;
    default:
      return undefined;
  }

  if (Array.isArray(value)) {
    const items: string[] = [];
    for (const item of value) {
      const key = stableValueKeyInner(item, depth + 1, budget);
      if (key === undefined) return undefined;
      items.push(key);
    }
    return `[${items.join(",")}]`;
  }
  if (!isJsonObject(value)) return undefined;

  const entries: string[] = [];
  for (const key of Object.keys(value).sort(compareCodeUnits)) {
    const child = stableValueKeyInner(value[key], depth + 1, budget);
    if (child === undefined) return undefined;
    entries.push(`${JSON.stringify(key)}:${child}`);
  }
  return `{${entries.join(",")}}`;
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

const DATE_TIME_PATTERN =
  /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})[Tt](?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2})(?:\.\d+)?(?:[Zz]|(?<sign>[+-])(?<offsetHour>\d{2}):(?<offsetMinute>\d{2}))$/;
const DATE_PATTERN = /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})$/;
const TIME_PATTERN =
  /^(?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2})(?:\.\d+)?(?:[Zz]|(?<sign>[+-])(?<offsetHour>\d{2}):(?<offsetMinute>\d{2}))$/;
const EMAIL_PATTERN =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const UUID_PATTERN =
  /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;

function isDateTime(value: string): boolean {
  const match = DATE_TIME_PATTERN.exec(value);
  const groups = match?.groups;
  if (groups === undefined) return false;
  if (!isValidDate(groups.year, groups.month, groups.day)) return false;
  if (!isValidTime(groups.hour, groups.minute, groups.second)) return false;
  return isValidOffset(groups.offsetHour, groups.offsetMinute);
}

function isDate(value: string): boolean {
  const groups = DATE_PATTERN.exec(value)?.groups;
  return (
    groups !== undefined && isValidDate(groups.year, groups.month, groups.day)
  );
}

function isTime(value: string): boolean {
  const groups = TIME_PATTERN.exec(value)?.groups;
  return (
    groups !== undefined &&
    isValidTime(groups.hour, groups.minute, groups.second) &&
    isValidOffset(groups.offsetHour, groups.offsetMinute)
  );
}

function isValidDate(
  yearText: string | undefined,
  monthText: string | undefined,
  dayText: string | undefined,
): boolean {
  if (
    yearText === undefined ||
    monthText === undefined ||
    dayText === undefined
  ) {
    return false;
  }
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (month < 1 || month > 12 || day < 1) return false;
  return day <= daysInMonth(year, month);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

function isValidTime(
  hourText: string | undefined,
  minuteText: string | undefined,
  secondText: string | undefined,
): boolean {
  if (
    hourText === undefined ||
    minuteText === undefined ||
    secondText === undefined
  ) {
    return false;
  }
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  return hour <= 23 && minute <= 59 && second <= 60;
}

function isValidOffset(
  hourText: string | undefined,
  minuteText: string | undefined,
): boolean {
  if (hourText === undefined && minuteText === undefined) return true;
  if (hourText === undefined || minuteText === undefined) return false;
  return Number(hourText) <= 23 && Number(minuteText) <= 59;
}

function isEmail(value: string): boolean {
  if (value.length > 254) return false;
  const separator = value.lastIndexOf("@");
  if (separator <= 0 || separator > 64) return false;
  return EMAIL_PATTERN.test(value);
}

function isHostname(value: string): boolean {
  const host = value.endsWith(".") ? value.slice(0, -1) : value;
  if (host.length === 0 || host.length > 253) return false;
  for (const label of host.split(".")) {
    if (
      label.length === 0 ||
      label.length > 63 ||
      !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label)
    ) {
      return false;
    }
  }
  return true;
}

function isUri(value: string): boolean {
  if (/\s/.test(value)) return false;
  try {
    return new URL(value).protocol.length > 1;
  } catch {
    return false;
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

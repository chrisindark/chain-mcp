import type { CompileDiagnostic, HttpMethod } from "./types.js";

export const MAX_TOOL_NAME_LENGTH = 64;
export const MAX_TOOL_DESCRIPTION_LENGTH = 4_096;

export interface ToolNameState {
  readonly used: Set<string>;
}

export function createToolName(
  operationId: unknown,
  method: HttpMethod,
  path: string,
  state: ToolNameState,
  diagnostics: CompileDiagnostic[],
  location: string,
  strict: boolean,
): string {
  let raw: string;
  if (operationId === undefined) {
    raw = fallbackName(method, path);
  } else if (
    typeof operationId !== "string" ||
    operationId.trim().length === 0
  ) {
    diagnostics.push({
      severity: "error",
      code: "OPERATION_ID_INVALID",
      message:
        "Operation 'operationId' must be a non-empty string when present",
      location,
    });
    raw = fallbackName(method, path);
  } else {
    raw = operationId;
  }

  const normalized = normalizeName(raw) || fallbackName(method, path);
  if (operationId !== undefined && normalized !== operationId) {
    diagnostics.push({
      severity: "warning",
      code: "TOOL_NAME_NORMALIZED",
      message: `Operation ID '${String(operationId)}' was normalized to '${normalized}'`,
      location,
    });
  }

  const name = uniqueName(normalized, state.used);
  if (name !== normalized) {
    diagnostics.push({
      severity: strict ? "error" : "warning",
      code: "TOOL_NAME_COLLISION",
      message: `Tool name '${normalized}' collides with another operation; renamed to '${name}'`,
      location,
    });
  }
  state.used.add(name);
  return name;
}

export function createToolDescription(
  summary: unknown,
  description: unknown,
  method: HttpMethod,
  path: string,
  diagnostics: CompileDiagnostic[],
  location: string,
): string {
  const summaryText = readText(summary, "summary", diagnostics, location);
  const descriptionText = readText(
    description,
    "description",
    diagnostics,
    location,
  );
  const text =
    summaryText || descriptionText || `${method.toUpperCase()} ${path}`;
  if (text.length <= MAX_TOOL_DESCRIPTION_LENGTH) return text;
  diagnostics.push({
    severity: "warning",
    code: "DESCRIPTION_TRUNCATED",
    message: `Tool description was truncated to ${MAX_TOOL_DESCRIPTION_LENGTH} characters`,
    location,
  });
  return `${text.slice(0, MAX_TOOL_DESCRIPTION_LENGTH - 3)}...`;
}

/**
 * Tool names must match the runtime's `[A-Za-z0-9_-]{1,64}` rule. Invalid
 * characters are replaced rather than dropped so two distinct operation IDs
 * do not silently collapse into the same name.
 */
export function normalizeName(raw: string): string {
  return raw
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, MAX_TOOL_NAME_LENGTH);
}

function fallbackName(method: HttpMethod, path: string): string {
  const segments = path
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.replace(/[{}]/g, ""));
  return normalizeName(`${method}_${segments.join("_") || "root"}`);
}

function uniqueName(base: string, used: ReadonlySet<string>): string {
  if (!used.has(base)) return base;
  for (let index = 2; index < 100_000; index += 1) {
    const suffix = `_${index}`;
    const candidate = `${base.slice(0, MAX_TOOL_NAME_LENGTH - suffix.length)}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
  // Unreachable with a bounded operation count, but fail closed rather than
  // returning a duplicate name.
  throw new Error("Unable to allocate a unique tool name");
}

function readText(
  value: unknown,
  field: string,
  diagnostics: CompileDiagnostic[],
  location: string,
): string {
  if (value === undefined) return "";
  if (typeof value !== "string") {
    diagnostics.push({
      severity: "error",
      code: "OPERATION_INVALID",
      message: `Operation '${field}' must be a string`,
      location,
    });
    return "";
  }
  return value.trim();
}

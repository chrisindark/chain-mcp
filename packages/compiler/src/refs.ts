import { isPlainObject } from "./document.js";
import type { CompileDiagnostic } from "./types.js";

export type LocalRefResult =
  | { ok: true; value: unknown }
  | {
      ok: false;
      code: "REF_REMOTE_UNSUPPORTED" | "REF_INVALID";
      message: string;
    };

/**
 * Resolves a local JSON pointer. Remote references are never fetched; callers
 * receive a diagnostic instead, which keeps compilation offline and avoids an
 * SSRF surface before outbound policy exists.
 */
export function resolveLocalPointer(
  document: Record<string, unknown>,
  ref: unknown,
): LocalRefResult {
  if (typeof ref !== "string" || ref.trim().length === 0) {
    return {
      ok: false,
      code: "REF_INVALID",
      message: "Reference must be a non-empty string",
    };
  }
  if (ref === "#") return { ok: true, value: document };
  if (!ref.startsWith("#/")) {
    return {
      ok: false,
      code: "REF_REMOTE_UNSUPPORTED",
      message: `Remote or non-local reference '${ref}' is not supported`,
    };
  }
  const segments = ref
    .slice(2)
    .split("/")
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
  let current: unknown = document;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9]\d*)$/.test(segment)) {
        return {
          ok: false,
          code: "REF_INVALID",
          message: `Reference '${ref}' does not resolve to a document value`,
        };
      }
      const index = Number(segment);
      if (index >= current.length) {
        return {
          ok: false,
          code: "REF_INVALID",
          message: `Reference '${ref}' does not resolve to a document value`,
        };
      }
      current = current[index];
      continue;
    }
    if (!isPlainObject(current) || !Object.hasOwn(current, segment)) {
      return {
        ok: false,
        code: "REF_INVALID",
        message: `Reference '${ref}' does not resolve to a document value`,
      };
    }
    current = current[segment];
  }
  return { ok: true, value: current };
}

const REF_SIBLING_ANNOTATIONS = new Set(["summary", "description"]);

/**
 * Resolves an object-level `$ref` (path item, parameter, or request body).
 * Sibling keys other than descriptive annotations are rejected rather than
 * silently ignored, so a requirement cannot be dropped by refactoring.
 */
export function resolveObjectReference(
  value: unknown,
  document: Record<string, unknown>,
  diagnostics: CompileDiagnostic[],
  location: string,
): Record<string, unknown> | undefined {
  if (!isPlainObject(value)) {
    diagnostics.push({
      severity: "error",
      code: "REF_INVALID",
      message: `Value at ${location} must be an object`,
      location,
    });
    return undefined;
  }
  if (!Object.hasOwn(value, "$ref")) return value;

  const ref = value.$ref;
  const siblings = Object.keys(value).filter(
    (key) => key !== "$ref" && !REF_SIBLING_ANNOTATIONS.has(key),
  );
  if (siblings.length > 0) {
    diagnostics.push({
      severity: "error",
      code: "REF_SIBLINGS_UNSUPPORTED",
      message: `Reference at ${location} has unsupported sibling keys: ${siblings.join(", ")}`,
      location,
    });
    return undefined;
  }
  const resolved = resolveLocalPointer(document, ref);
  if (!resolved.ok) {
    diagnostics.push({
      severity: "error",
      code: resolved.code,
      message: resolved.message,
      location,
    });
    return undefined;
  }
  if (!isPlainObject(resolved.value)) {
    diagnostics.push({
      severity: "error",
      code: "REF_INVALID",
      message: `Reference '${String(ref)}' at ${location} must resolve to an object`,
      location,
    });
    return undefined;
  }
  return resolved.value;
}

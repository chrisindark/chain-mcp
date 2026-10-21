import { createHash } from "node:crypto";

import { parseAllDocuments } from "yaml";

import type { CompileDiagnostic } from "./types.js";

export const DEFAULT_MAX_SOURCE_BYTES = 5 * 1024 * 1024;
export const MAX_SOURCE_BYTES_LIMIT = 25 * 1024 * 1024;
export const MAX_DOCUMENT_DEPTH = 64;
export const MAX_DOCUMENT_NODES = 250_000;
export const MAX_YAML_ALIASES = 50;

export interface ParsedSource {
  document?: Record<string, unknown>;
  diagnostics: CompileDiagnostic[];
  sourceHash: string;
}

export function parseOpenApiSource(
  source: string,
  maxSourceBytes: number,
): ParsedSource {
  const byteLength = Buffer.byteLength(source, "utf8");
  if (byteLength > maxSourceBytes) {
    return {
      diagnostics: [
        {
          severity: "error",
          code: "SOURCE_TOO_LARGE",
          message: `Source is ${byteLength} bytes, above the configured limit of ${maxSourceBytes}`,
        },
      ],
      // Do not hash an oversized payload; its length is enough to identify the
      // rejected input in diagnostics and manifests.
      sourceHash: hashWithPrefix(`chainmcp:openapi:oversized:${byteLength}`),
    };
  }
  const sourceHash = hashWithPrefix(source);
  const diagnostics: CompileDiagnostic[] = [];

  let documents: ReturnType<typeof parseAllDocuments>;
  try {
    documents = parseAllDocuments(source, {
      prettyErrors: false,
      schema: "core",
      strict: true,
      stringKeys: true,
      uniqueKeys: true,
    });
  } catch (error) {
    diagnostics.push({
      severity: "error",
      code: "SOURCE_PARSE_FAILED",
      message: `OpenAPI source could not be parsed: ${safeErrorMessage(error)}`,
    });
    return { diagnostics, sourceHash };
  }

  if (documents.length !== 1) {
    diagnostics.push({
      severity: "error",
      code: "SOURCE_PARSE_FAILED",
      message: `OpenAPI source must contain exactly one document, found ${documents.length}`,
    });
    return { diagnostics, sourceHash };
  }
  const [parsed] = documents;
  if (parsed === undefined) {
    diagnostics.push({
      severity: "error",
      code: "SOURCE_PARSE_FAILED",
      message: "OpenAPI source is empty",
    });
    return { diagnostics, sourceHash };
  }
  if (parsed.errors.length > 0) {
    diagnostics.push({
      severity: "error",
      code: "SOURCE_PARSE_FAILED",
      message: `OpenAPI source is not valid YAML or JSON: ${safeErrorMessage(
        parsed.errors[0],
      )}`,
    });
    return { diagnostics, sourceHash };
  }

  let value: unknown;
  try {
    value = parsed.toJS({ maxAliasCount: MAX_YAML_ALIASES });
  } catch (error) {
    diagnostics.push({
      severity: "error",
      code: "SOURCE_PARSE_FAILED",
      message: `OpenAPI source could not be converted to data: ${safeErrorMessage(error)}`,
    });
    return { diagnostics, sourceHash };
  }

  try {
    assertBoundedJson(value, "#", 0, new Set(), { nodes: 0 });
  } catch (error) {
    diagnostics.push({
      severity: "error",
      code: "DOCUMENT_INVALID",
      message: safeErrorMessage(error),
    });
    return { diagnostics, sourceHash };
  }

  if (!isPlainObject(value)) {
    diagnostics.push({
      severity: "error",
      code: "DOCUMENT_INVALID",
      message: "OpenAPI document root must be an object",
    });
    return { diagnostics, sourceHash };
  }

  return { document: value, diagnostics, sourceHash };
}

export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function escapePointerSegment(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

export function pointer(...segments: Array<string | number>): string {
  if (segments.length === 0) return "#";
  return `#/${segments
    .map((segment) => escapePointerSegment(String(segment)))
    .join("/")}`;
}

/**
 * Canonical JSON with object keys sorted. The input must already have passed
 * `assertBoundedJson`, so there are no cycles, accessors, or non-JSON values.
 */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (isPlainObject(value)) {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

export function hashWithPrefix(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

interface BoundsState {
  nodes: number;
}

function assertBoundedJson(
  value: unknown,
  path: string,
  depth: number,
  ancestors: Set<object>,
  state: BoundsState,
): void {
  if (depth > MAX_DOCUMENT_DEPTH) {
    throw new Error(
      `Document at ${path} exceeds the maximum depth of ${MAX_DOCUMENT_DEPTH}`,
    );
  }
  state.nodes += 1;
  if (state.nodes > MAX_DOCUMENT_NODES) {
    throw new Error(
      `Document exceeds the maximum of ${MAX_DOCUMENT_NODES} values`,
    );
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`Document at ${path} contains a non-finite number`);
    }
    return;
  }
  if (typeof value !== "object") {
    throw new Error(`Document at ${path} contains a non-JSON value`);
  }
  if (ancestors.has(value)) {
    throw new Error(`Document at ${path} contains a cycle`);
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      value.forEach((item, index) =>
        assertBoundedJson(
          item,
          `${path}[${index}]`,
          depth + 1,
          ancestors,
          state,
        ),
      );
      return;
    }
    if (!isPlainObject(value)) {
      throw new Error(`Document at ${path} must contain only plain objects`);
    }
    for (const [key, item] of Object.entries(value)) {
      const childPath = `${path}/${escapePointerSegment(key)}`;
      assertBoundedJson(item, childPath, depth + 1, ancestors, state);
    }
  } finally {
    ancestors.delete(value);
  }
}

function safeErrorMessage(value: unknown): string {
  const message =
    value instanceof Error
      ? value.message
      : typeof value === "string"
        ? value
        : "unknown parse error";
  return message.length > 500 ? `${message.slice(0, 500)}...` : message;
}

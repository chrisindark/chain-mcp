import type { ResultProjector } from "./index.js";

/**
 * Declarative field selection for tools that opt into `output`. Paths are
 * dot-separated object keys; arrays encountered along a path are traversed
 * element-wise. Exactly one of `include` or `exclude` may be set.
 */
export interface FieldSelection {
  include?: readonly string[];
  exclude?: readonly string[];
}

export const MAX_FIELD_PATHS = 64;
export const MAX_FIELD_PATH_DEPTH = 16;
export const MAX_FIELD_PATH_LENGTH = 256;
export const MAX_FIELD_PROJECTION_DEPTH = 64;
export const MAX_FIELD_PROJECTION_NODES = 50_000;

const DANGEROUS_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

export class FieldSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FieldSelectionError";
  }
}

interface TrieNode {
  terminal: boolean;
  readonly children: Map<string, TrieNode>;
}

interface ProjectionState {
  visited: number;
}

/**
 * Validates a field selection without touching a result. Registration calls
 * this so an invalid policy prevents tool registration instead of failing only
 * when the first response is projected. `createFieldProjector` revalidates at
 * call time as a defense against mutation of the tool definition.
 */
export function assertFieldSelection(
  fields: unknown,
): asserts fields is FieldSelection {
  if (fields === null || typeof fields !== "object" || Array.isArray(fields)) {
    throw new FieldSelectionError("Field selection must be an object");
  }
  const record = fields as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "include" && key !== "exclude") {
      throw new FieldSelectionError(`Field selection cannot contain '${key}'`);
    }
  }
  const hasInclude = record.include !== undefined;
  const hasExclude = record.exclude !== undefined;
  if (hasInclude === hasExclude) {
    throw new FieldSelectionError(
      "Field selection must declare exactly one of include or exclude",
    );
  }
  const paths = hasInclude ? record.include : record.exclude;
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new FieldSelectionError(
      "Field selection paths must be a non-empty array",
    );
  }
  if (paths.length > MAX_FIELD_PATHS) {
    throw new FieldSelectionError(
      `Field selection cannot exceed ${MAX_FIELD_PATHS} paths`,
    );
  }
  const seen = new Set<string>();
  for (const path of paths) {
    assertFieldPath(path);
    if (seen.has(path)) {
      throw new FieldSelectionError(
        "Field selection cannot contain duplicate paths",
      );
    }
    seen.add(path);
  }
}

function assertFieldPath(path: unknown): asserts path is string {
  if (typeof path !== "string" || path.length === 0) {
    throw new FieldSelectionError("Field paths must be non-empty strings");
  }
  if (path !== path.trim()) {
    throw new FieldSelectionError(
      "Field paths cannot have leading or trailing whitespace",
    );
  }
  if (path.length > MAX_FIELD_PATH_LENGTH) {
    throw new FieldSelectionError(
      `Field paths cannot exceed ${MAX_FIELD_PATH_LENGTH} characters`,
    );
  }
  for (const character of path) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint < 0x20 || codePoint === 0x7f)) {
      throw new FieldSelectionError(
        "Field paths cannot contain control characters",
      );
    }
  }
  const segments = path.split(".");
  if (segments.length > MAX_FIELD_PATH_DEPTH) {
    throw new FieldSelectionError(
      `Field paths cannot exceed ${MAX_FIELD_PATH_DEPTH} segments`,
    );
  }
  for (const segment of segments) {
    if (segment.length === 0 || segment.trim().length === 0) {
      throw new FieldSelectionError(
        "Field paths cannot contain empty segments",
      );
    }
    if (DANGEROUS_SEGMENTS.has(segment)) {
      throw new FieldSelectionError(`Field paths cannot contain '${segment}'`);
    }
  }
}

function buildTrie(selection: FieldSelection): TrieNode {
  const root = newNode();
  const paths = selection.include ?? selection.exclude ?? [];
  for (const path of paths) {
    let node = root;
    for (const segment of path.split(".")) {
      let next = node.children.get(segment);
      if (!next) {
        next = newNode();
        node.children.set(segment, next);
      }
      node = next;
    }
    node.terminal = true;
  }
  return root;
}

function newNode(): TrieNode {
  return { terminal: false, children: new Map() };
}

/**
 * Creates the built-in field projector. Tools without `output.fields` pass
 * through unchanged, so one projector can be installed runtime-wide. Include
 * selections retain only named paths (arrays are traversed element-wise);
 * exclude selections clone only the branches they modify and never mutate the
 * original result.
 */
export function createFieldProjector(): ResultProjector {
  return {
    project({ tool, result }) {
      const selection = tool.output?.fields;
      if (selection === undefined) return result;
      assertFieldSelection(selection);
      const trie = buildTrie(selection);
      const state: ProjectionState = { visited: 0 };
      if (selection.include !== undefined) {
        return selectValue(result, trie, state, 0);
      }
      return excludeValue(result, trie, state, 0);
    },
  };
}

function selectValue(
  value: unknown,
  node: TrieNode,
  state: ProjectionState,
  depth: number,
): unknown {
  enterProjection(state, depth);
  if (node.terminal) return value;
  if (Array.isArray(value)) {
    return value.map((item) =>
      item === null || typeof item !== "object"
        ? null
        : selectValue(item, node, state, depth + 1),
    );
  }
  if (!isPlainObject(value)) return null;
  const output: Record<string, unknown> = {};
  for (const [key, child] of node.children) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    setOwn(output, key, selectValue(value[key], child, state, depth + 1));
  }
  return output;
}

function excludeValue(
  value: unknown,
  node: TrieNode,
  state: ProjectionState,
  depth: number,
): unknown {
  enterProjection(state, depth);
  if (Array.isArray(value)) {
    let changed = false;
    const output = value.map((item) => {
      if (item === null || typeof item !== "object") return item;
      const next = excludeValue(item, node, state, depth + 1);
      if (next !== item) changed = true;
      return next;
    });
    return changed ? output : value;
  }
  if (!isPlainObject(value)) {
    if (typeof value === "object" && value !== null) {
      throw new FieldSelectionError(
        "Field projection requires plain JSON objects and arrays",
      );
    }
    return value;
  }
  let changed = false;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    const child = node.children.get(key);
    if (child?.terminal) {
      changed = true;
      continue;
    }
    const childValue = value[key];
    const next = child
      ? excludeValue(childValue, child, state, depth + 1)
      : childValue;
    if (next !== childValue) changed = true;
    setOwn(output, key, next);
  }
  return changed ? output : value;
}

function enterProjection(state: ProjectionState, depth: number): void {
  if (depth > MAX_FIELD_PROJECTION_DEPTH) {
    throw new FieldSelectionError(
      `Field projection cannot exceed ${MAX_FIELD_PROJECTION_DEPTH} levels`,
    );
  }
  state.visited += 1;
  if (state.visited > MAX_FIELD_PROJECTION_NODES) {
    throw new FieldSelectionError(
      `Field projection cannot exceed ${MAX_FIELD_PROJECTION_NODES} nodes`,
    );
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

// Assigning an own `__proto__` key through `output[key] = value` would invoke
// the setter on Object.prototype. defineProperty keeps arbitrary JSON keys as
// data without mutating a prototype chain. Path validation rejects dangerous
// segments, but excluded/untouched input keys are copied too.
function setOwn(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

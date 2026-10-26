import {
  type NavigationLimits,
  NavigationBudget,
  DANGEROUS_KEYS,
  JsonPathSyntaxError,
} from "./limits.js";

export type PathSegment =
  | { type: "property"; key: string }
  | { type: "wildcard" }
  | { type: "index"; index: number }
  | {
      type: "slice";
      start: number | undefined;
      end: number | undefined;
      step: number | undefined;
    }
  | {
      type: "filter";
      field: string[];
      op: "==" | "!=" | "<" | "<=" | ">" | ">=" | "truthy";
      value?: unknown;
    };

export interface CompiledPath {
  segments: readonly PathSegment[];
  hasMultiMatch: boolean;
  rawPath: string;
}

export function parseJsonPath(path: string): CompiledPath {
  if (typeof path !== "string" || path.trim().length === 0) {
    throw new JsonPathSyntaxError("Path must be a non-empty string");
  }

  const raw = path.trim();
  let pos = 0;
  const len = raw.length;

  if (raw[pos] === "$") {
    pos++;
    if (pos === len) {
      return { segments: [], hasMultiMatch: false, rawPath: raw };
    }
    if (raw[pos] === ".") {
      pos++;
    }
  }

  const segments: PathSegment[] = [];
  let hasMultiMatch = false;

  while (pos < len) {
    const ch = raw[pos];

    if (ch === ".") {
      pos++;
      if (pos >= len) {
        throw new JsonPathSyntaxError(
          `Trailing dot in path '${raw}' at position ${pos}`,
        );
      }
      if (raw[pos] === "*") {
        segments.push({ type: "wildcard" });
        hasMultiMatch = true;
        pos++;
        continue;
      }
      // Read identifier
      const start = pos;
      while (pos < len && raw[pos] !== "." && raw[pos] !== "[") {
        pos++;
      }
      const key = raw.slice(start, pos);
      if (!key) {
        throw new JsonPathSyntaxError(
          `Empty property name in path '${raw}' at position ${start}`,
        );
      }
      if (DANGEROUS_KEYS.has(key)) {
        throw new JsonPathSyntaxError(
          `Forbidden property name '${key}' in path`,
        );
      }
      segments.push({ type: "property", key });
    } else if (ch === "[") {
      pos++; // skip '['
      if (pos >= len) {
        throw new JsonPathSyntaxError(`Unclosed bracket in path '${raw}'`);
      }

      // Check for filter: [?(@...)]
      if (raw[pos] === "?") {
        pos++; // skip '?'
        if (pos >= len || raw[pos] !== "(") {
          throw new JsonPathSyntaxError(
            `Expected '(' after '?' in filter expression at position ${pos}`,
          );
        }
        pos++; // skip '('
        const closeParen = raw.indexOf(")", pos);
        if (closeParen === -1) {
          throw new JsonPathSyntaxError(
            `Unclosed '(' in filter expression in '${raw}'`,
          );
        }
        const filterStr = raw.slice(pos, closeParen).trim();
        pos = closeParen + 1;
        if (pos >= len || raw[pos] !== "]") {
          throw new JsonPathSyntaxError(
            `Expected ']' after filter expression at position ${pos}`,
          );
        }
        pos++; // skip ']'

        const filterSegment = parseFilterExpression(filterStr);
        segments.push(filterSegment);
        hasMultiMatch = true;
        continue;
      }

      // Check for wildcard [*]
      if (raw[pos] === "*") {
        pos++;
        if (pos >= len || raw[pos] !== "]") {
          throw new JsonPathSyntaxError(
            `Expected ']' after '*' at position ${pos}`,
          );
        }
        pos++;
        segments.push({ type: "wildcard" });
        hasMultiMatch = true;
        continue;
      }

      // Check for quoted property: ['prop'] or ["prop"]
      if (raw[pos] === "'" || raw[pos] === '"') {
        const quote = raw[pos] as "'" | '"';
        pos++;
        const closeQuote = raw.indexOf(quote, pos);
        if (closeQuote === -1) {
          throw new JsonPathSyntaxError(
            `Unterminated quote in property selector at position ${pos}`,
          );
        }
        const prop = raw.slice(pos, closeQuote);
        pos = closeQuote + 1;
        if (pos >= len || raw[pos] !== "]") {
          throw new JsonPathSyntaxError(
            `Expected ']' after quoted property at position ${pos}`,
          );
        }
        pos++;
        if (DANGEROUS_KEYS.has(prop)) {
          throw new JsonPathSyntaxError(
            `Forbidden property name '${prop}' in path`,
          );
        }
        segments.push({ type: "property", key: prop });
        continue;
      }

      // Index or slice: [0], [-1], [start:end:step]
      const closeBracket = raw.indexOf("]", pos);
      if (closeBracket === -1) {
        throw new JsonPathSyntaxError(
          `Unclosed bracket in path '${raw}' at position ${pos}`,
        );
      }
      const bracketContent = raw.slice(pos, closeBracket).trim();
      pos = closeBracket + 1;

      if (bracketContent.includes(":")) {
        // Slice
        const parts = bracketContent.split(":");
        if (parts.length > 3) {
          throw new JsonPathSyntaxError(
            `Invalid slice syntax '${bracketContent}'`,
          );
        }
        const start = parts[0]?.trim() ? parseInt(parts[0], 10) : undefined;
        const end = parts[1]?.trim() ? parseInt(parts[1], 10) : undefined;
        const step = parts[2]?.trim() ? parseInt(parts[2], 10) : undefined;

        if (
          (start !== undefined && Number.isNaN(start)) ||
          (end !== undefined && Number.isNaN(end)) ||
          (step !== undefined && (Number.isNaN(step) || step === 0))
        ) {
          throw new JsonPathSyntaxError(
            `Invalid numeric values in slice '${bracketContent}'`,
          );
        }

        segments.push({ type: "slice", start, end, step });
        hasMultiMatch = true;
      } else {
        // Index
        const index = parseInt(bracketContent, 10);
        if (Number.isNaN(index)) {
          // Might be unquoted identifier in brackets e.g. [foo]
          if (/^[a-zA-Z0-9_$-]+$/.test(bracketContent)) {
            if (DANGEROUS_KEYS.has(bracketContent)) {
              throw new JsonPathSyntaxError(
                `Forbidden property name '${bracketContent}' in path`,
              );
            }
            segments.push({ type: "property", key: bracketContent });
          } else {
            throw new JsonPathSyntaxError(
              `Invalid index or property '${bracketContent}' in bracket selector`,
            );
          }
        } else {
          segments.push({ type: "index", index });
        }
      }
    } else {
      // Identifier at the start without leading dot
      const start = pos;
      while (pos < len && raw[pos] !== "." && raw[pos] !== "[") {
        pos++;
      }
      const key = raw.slice(start, pos);
      if (!key) {
        throw new JsonPathSyntaxError(
          `Unexpected character '${ch}' at position ${pos}`,
        );
      }
      if (DANGEROUS_KEYS.has(key)) {
        throw new JsonPathSyntaxError(
          `Forbidden property name '${key}' in path`,
        );
      }
      segments.push({ type: "property", key });
    }
  }

  return { segments, hasMultiMatch, rawPath: raw };
}

function parseFilterExpression(filterStr: string): PathSegment & {
  type: "filter";
} {
  // Expected formats:
  // @.field == 'val'
  // @.field != 123
  // @.field > 10
  // @.field
  const trimmed = filterStr.trim();
  if (!trimmed.startsWith("@")) {
    throw new JsonPathSyntaxError(
      `Filter expression must start with '@', got: '${filterStr}'`,
    );
  }

  let rest = trimmed.slice(1);
  if (rest.startsWith(".")) {
    rest = rest.slice(1);
  }

  // Operators: ==, !=, <=, >=, <, >
  const match = rest.match(/^(.*?)\s*(==|!=|<=|>=|<|>)\s*(.*)$/);
  if (!match) {
    // Truthy test on field
    const fieldPath = rest
      .split(".")
      .map((s) => s.trim())
      .filter(Boolean);
    if (fieldPath.length === 0) {
      throw new JsonPathSyntaxError(
        `Empty field in filter expression '${filterStr}'`,
      );
    }
    for (const f of fieldPath) {
      if (DANGEROUS_KEYS.has(f)) {
        throw new JsonPathSyntaxError(`Forbidden field '${f}' in filter`);
      }
    }
    return { type: "filter", field: fieldPath, op: "truthy" };
  }

  const rawField = match[1]?.trim() ?? "";
  const op = match[2] as "==" | "!=" | "<" | "<=" | ">" | ">=";
  const rawValue = match[3]?.trim() ?? "";

  const fieldPath = rawField
    .split(".")
    .map((s) => s.trim())
    .filter(Boolean);
  if (fieldPath.length === 0) {
    throw new JsonPathSyntaxError(
      `Empty field in filter comparison '${filterStr}'`,
    );
  }
  for (const f of fieldPath) {
    if (DANGEROUS_KEYS.has(f)) {
      throw new JsonPathSyntaxError(`Forbidden field '${f}' in filter`);
    }
  }

  let parsedVal: unknown;
  if (
    (rawValue.startsWith("'") && rawValue.endsWith("'")) ||
    (rawValue.startsWith('"') && rawValue.endsWith('"'))
  ) {
    parsedVal = rawValue.slice(1, -1);
  } else if (rawValue === "true") {
    parsedVal = true;
  } else if (rawValue === "false") {
    parsedVal = false;
  } else if (rawValue === "null") {
    parsedVal = null;
  } else {
    const num = Number(rawValue);
    if (!Number.isNaN(num)) {
      parsedVal = num;
    } else {
      parsedVal = rawValue;
    }
  }

  return { type: "filter", field: fieldPath, op, value: parsedVal };
}

export function selectPath(
  data: unknown,
  path: string | CompiledPath,
  options?: NavigationLimits,
): unknown {
  const compiled = typeof path === "string" ? parseJsonPath(path) : path;
  const budget = new NavigationBudget(options);

  function getFieldValue(obj: unknown, fields: string[]): unknown {
    let cur = obj;
    for (const f of fields) {
      if (cur === null || typeof cur !== "object") return undefined;
      if (DANGEROUS_KEYS.has(f)) return undefined;
      cur = (cur as Record<string, unknown>)[f];
    }
    return cur;
  }

  function matchesFilter(
    item: unknown,
    filter: PathSegment & { type: "filter" },
  ): boolean {
    const val = getFieldValue(item, filter.field);
    if (filter.op === "truthy") {
      return Boolean(val);
    }
    switch (filter.op) {
      case "==":
        return val === filter.value;
      case "!=":
        return val !== filter.value;
      case "<":
        return typeof val === "number" && typeof filter.value === "number"
          ? val < filter.value
          : false;
      case "<=":
        return typeof val === "number" && typeof filter.value === "number"
          ? val <= filter.value
          : false;
      case ">":
        return typeof val === "number" && typeof filter.value === "number"
          ? val > filter.value
          : false;
      case ">=":
        return typeof val === "number" && typeof filter.value === "number"
          ? val >= filter.value
          : false;
      default:
        return false;
    }
  }

  let currentNodes: unknown[] = [data];

  for (let sIdx = 0; sIdx < compiled.segments.length; sIdx++) {
    const segment = compiled.segments[sIdx];
    if (segment === undefined) break;
    const nextNodes: unknown[] = [];
    const depth = sIdx + 1;

    for (const node of currentNodes) {
      budget.visitNode(depth);
      if (node === null || typeof node !== "object") {
        continue;
      }

      if (segment.type === "property") {
        if (!Array.isArray(node)) {
          const record = node as Record<string, unknown>;
          if (
            !DANGEROUS_KEYS.has(segment.key) &&
            Object.prototype.hasOwnProperty.call(record, segment.key)
          ) {
            nextNodes.push(record[segment.key]);
          }
        }
      } else if (segment.type === "wildcard") {
        if (Array.isArray(node)) {
          const limit = Math.min(node.length, budget.maxArrayItems);
          for (let i = 0; i < limit; i++) {
            nextNodes.push(node[i]);
          }
        } else {
          const record = node as Record<string, unknown>;
          const keys = Object.keys(record);
          const limit = Math.min(keys.length, budget.maxArrayItems);
          for (let i = 0; i < limit; i++) {
            const k = keys[i];
            if (k !== undefined && !DANGEROUS_KEYS.has(k)) {
              nextNodes.push(record[k]);
            }
          }
        }
      } else if (segment.type === "index") {
        if (Array.isArray(node)) {
          const idx =
            segment.index >= 0 ? segment.index : node.length + segment.index;
          if (idx >= 0 && idx < node.length) {
            nextNodes.push(node[idx]);
          }
        }
      } else if (segment.type === "slice") {
        if (Array.isArray(node)) {
          const len = node.length;
          const step = segment.step ?? 1;
          let start = segment.start ?? (step > 0 ? 0 : len - 1);
          let end = segment.end ?? (step > 0 ? len : -1);

          if (start < 0) start = Math.max(0, len + start);
          if (end < 0) end = Math.max(0, len + end);

          let count = 0;
          if (step > 0) {
            for (
              let i = start;
              i < end && i < len && count < budget.maxArrayItems;
              i += step
            ) {
              nextNodes.push(node[i]);
              count++;
            }
          } else {
            for (
              let i = start;
              i > end && i >= 0 && count < budget.maxArrayItems;
              i += step
            ) {
              nextNodes.push(node[i]);
              count++;
            }
          }
        }
      } else if (segment.type === "filter") {
        if (Array.isArray(node)) {
          let count = 0;
          for (
            let i = 0;
            i < node.length && count < budget.maxArrayItems;
            i++
          ) {
            const item = node[i];
            if (matchesFilter(item, segment)) {
              nextNodes.push(item);
              count++;
            }
          }
        }
      }
    }

    currentNodes = nextNodes;
    if (currentNodes.length === 0) break;
  }

  const result = compiled.hasMultiMatch
    ? currentNodes
    : currentNodes.length > 0
      ? currentNodes[0]
      : undefined;

  budget.assertResultBytes(result);
  return result;
}

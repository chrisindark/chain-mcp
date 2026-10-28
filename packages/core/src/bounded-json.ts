/**
 * Bounded JSON serializer that enforces maximum byte, depth, and node limits
 * incrementally during traversal, preventing unbounded heap allocations.
 */

export interface BoundedStringifyOptions {
  /** Maximum allowed UTF-8 byte length of the resulting JSON string. */
  maxBytes: number;
  /** Maximum recursion depth for nested objects and arrays. Default: 128. */
  maxDepth?: number;
  /** Maximum number of visited values/nodes during traversal. Default: 100,000. */
  maxNodes?: number;
}

export class SerializationLimitError extends Error {
  readonly limitBytes: number;
  readonly observedBytes: number;

  constructor(message: string, limitBytes: number, observedBytes: number) {
    super(message);
    this.name = "SerializationLimitError";
    this.limitBytes = limitBytes;
    this.observedBytes = observedBytes;
  }
}

/**
 * Serializes a value to JSON, aborting immediately without allocating the full string
 * if the output would exceed `options.maxBytes`.
 */
export function stringifyBounded(
  value: unknown,
  options: BoundedStringifyOptions,
): string | undefined {
  const { maxBytes, maxDepth = 128, maxNodes = 100_000 } = options;
  if (!Number.isFinite(maxBytes) || maxBytes < 0) {
    throw new TypeError("maxBytes must be a non-negative number");
  }

  // Root-level undefined, function, or symbol returns undefined in standard JSON.stringify
  if (
    value === undefined ||
    typeof value === "function" ||
    typeof value === "symbol"
  ) {
    return undefined;
  }

  const chunks: string[] = [];
  let currentBytes = 0;
  let visitedNodes = 0;
  const ancestors = new Set<object>();

  function append(chunk: string): void {
    const chunkBytes = Buffer.byteLength(chunk, "utf8");
    if (currentBytes + chunkBytes > maxBytes) {
      throw new SerializationLimitError(
        `JSON output exceeds limit of ${maxBytes} bytes`,
        maxBytes,
        currentBytes + chunkBytes,
      );
    }
    chunks.push(chunk);
    currentBytes += chunkBytes;
  }

  function serialize(val: unknown, key: string, depth: number): void {
    visitedNodes++;
    if (visitedNodes > maxNodes) {
      throw new SerializationLimitError(
        `JSON serialization exceeded maximum node limit of ${maxNodes}`,
        maxBytes,
        currentBytes,
      );
    }
    if (depth > maxDepth) {
      throw new SerializationLimitError(
        `JSON serialization exceeded maximum depth of ${maxDepth}`,
        maxBytes,
        currentBytes,
      );
    }

    if (val === null) {
      append("null");
      return;
    }

    if (typeof val === "boolean") {
      append(val ? "true" : "false");
      return;
    }

    if (typeof val === "number") {
      append(Number.isFinite(val) ? String(val) : "null");
      return;
    }

    if (typeof val === "string") {
      // Cheap bounds pre-check: a string's UTF-8 byte length is at least its character length.
      // With JSON surrounding quotes, minimum byte length is val.length + 2.
      if (val.length + 2 > maxBytes - currentBytes) {
        throw new SerializationLimitError(
          `JSON output exceeds limit of ${maxBytes} bytes`,
          maxBytes,
          currentBytes + val.length + 2,
        );
      }
      append(JSON.stringify(val));
      return;
    }

    if (typeof val === "bigint") {
      throw new TypeError("Do not know how to serialize a BigInt");
    }

    if (typeof val === "object") {
      let resolved: unknown = val;
      if (typeof (val as { toJSON?: unknown }).toJSON === "function") {
        resolved = (val as { toJSON(k: string): unknown }).toJSON(key);
        if (
          resolved === undefined ||
          typeof resolved === "function" ||
          typeof resolved === "symbol"
        ) {
          append("null");
          return;
        }
        if (typeof resolved !== "object" || resolved === null) {
          serialize(resolved, key, depth);
          return;
        }
      }

      if (ancestors.has(resolved as object)) {
        throw new TypeError("Converting circular structure to JSON");
      }
      ancestors.add(resolved as object);

      try {
        if (Array.isArray(resolved)) {
          append("[");
          for (let i = 0; i < resolved.length; i++) {
            if (i > 0) append(",");
            const item = resolved[i];
            if (
              item === undefined ||
              typeof item === "function" ||
              typeof item === "symbol"
            ) {
              append("null");
            } else {
              serialize(item, String(i), depth + 1);
            }
          }
          append("]");
          return;
        }

        append("{");
        let first = true;
        const propKeys = Object.keys(resolved as Record<string, unknown>);
        for (const propKey of propKeys) {
          const propVal = (resolved as Record<string, unknown>)[propKey];
          if (
            propVal === undefined ||
            typeof propVal === "function" ||
            typeof propVal === "symbol"
          ) {
            continue;
          }
          if (!first) append(",");
          first = false;
          append(JSON.stringify(propKey) + ":");
          serialize(propVal, propKey, depth + 1);
        }
        append("}");
      } finally {
        ancestors.delete(resolved as object);
      }
      return;
    }

    append("null");
  }

  serialize(value, "", 0);
  return chunks.join("");
}

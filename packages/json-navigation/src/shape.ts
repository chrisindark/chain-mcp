import {
  type NavigationLimits,
  NavigationBudget,
  DANGEROUS_KEYS,
  JsonNavigationError,
  JsonNavigationLimitError,
} from "./limits.js";

export type JsonType =
  "object" | "array" | "string" | "number" | "boolean" | "null";

export interface ShapeSummary {
  type: JsonType;
  depth: number;
  totalNodes: number;
  byteEstimate: number;
  propertyCount?: number;
  keys?: string[];
  properties?: Record<string, ShapeSummary>;
  itemCount?: number;
  itemTypes?: JsonType[];
  sampleItemShape?: ShapeSummary;
  truncated?: boolean;
}

export interface InspectShapeOptions extends NavigationLimits {
  /** Maximum number of object keys to enumerate in detail. Defaults to 50. */
  maxKeys?: number;
  /**
   * If true, throws JsonNavigationLimitError when traversal depth exceeds maxDepth.
   * If false, truncates child exploration and marks the summary as truncated.
   */
  throwOnDepthLimit?: boolean;
}

export function inspectShape(
  data: unknown,
  options?: InspectShapeOptions,
): ShapeSummary {
  const budget = new NavigationBudget(options);
  const seen = new Set<object>();
  const maxKeys = Math.max(1, options?.maxKeys ?? 50);

  function getJsonType(val: unknown): JsonType {
    if (val === null) return "null";
    if (Array.isArray(val)) return "array";
    const t = typeof val;
    if (t === "string") return "string";
    if (t === "number") return "number";
    if (t === "boolean") return "boolean";
    return "object";
  }

  function walk(val: unknown, depth: number): ShapeSummary {
    budget.visitNode(depth);
    const type = getJsonType(val);

    if (type !== "object" && type !== "array") {
      let byteEstimate = 0;
      if (typeof val === "string") {
        byteEstimate = Buffer.byteLength(val, "utf8");
      } else if (typeof val === "number") {
        byteEstimate = 8;
      } else if (typeof val === "boolean") {
        byteEstimate = 4;
      } else {
        byteEstimate = 4; // null
      }
      return {
        type,
        depth: 1,
        totalNodes: 1,
        byteEstimate,
      };
    }

    if (typeof val === "object" && val !== null) {
      if (seen.has(val)) {
        throw new JsonNavigationError("Circular reference detected in data");
      }
      seen.add(val);
    }

    try {
      if (Array.isArray(val)) {
        const itemCount = val.length;
        const distinctTypes = new Set<JsonType>();

        if (depth >= budget.maxDepth && itemCount > 0) {
          if (options?.throwOnDepthLimit) {
            throw new JsonNavigationLimitError(
              `Traversal depth ${depth} reached maximum of ${budget.maxDepth}`,
              "maxDepth",
            );
          }
          return {
            type: "array",
            depth,
            totalNodes: 1,
            byteEstimate: 2,
            itemCount,
            truncated: true,
          };
        }

        let maxChildDepth = 0;
        let sumChildNodes = 0;
        let sumBytes = 2; // "[]"

        // Sample up to first item in detail
        let sampleItemShape: ShapeSummary | undefined;
        if (itemCount > 0 && depth < budget.maxDepth) {
          sampleItemShape = walk(val[0], depth + 1);
          maxChildDepth = sampleItemShape.depth;
          sumChildNodes += sampleItemShape.totalNodes;
          sumBytes += sampleItemShape.byteEstimate;
        }

        // Count types and estimate remaining items
        const sampleLimit = Math.min(itemCount, budget.maxArrayItems);
        for (let i = 0; i < sampleLimit; i++) {
          const item = val[i];
          distinctTypes.add(getJsonType(item));
        }

        return {
          type: "array",
          depth: maxChildDepth + 1,
          totalNodes: sumChildNodes + 1,
          byteEstimate: sumBytes,
          itemCount,
          itemTypes: [...distinctTypes],
          ...(sampleItemShape ? { sampleItemShape } : {}),
          truncated: itemCount > budget.maxArrayItems,
        };
      }

      // Plain Object
      const record = val as Record<string, unknown>;
      const rawKeys = Object.keys(record).filter((k) => !DANGEROUS_KEYS.has(k));
      const propertyCount = rawKeys.length;
      const displayKeys = rawKeys.slice(0, maxKeys);
      let isTruncated = rawKeys.length > maxKeys;

      if (depth >= budget.maxDepth && propertyCount > 0) {
        if (options?.throwOnDepthLimit) {
          throw new JsonNavigationLimitError(
            `Traversal depth ${depth} reached maximum of ${budget.maxDepth}`,
            "maxDepth",
          );
        }
        return {
          type: "object",
          depth,
          totalNodes: 1,
          byteEstimate: 2,
          propertyCount,
          keys: displayKeys,
          truncated: true,
        };
      }

      const properties: Record<string, ShapeSummary> = {};
      let maxChildDepth = 0;
      let sumChildNodes = 0;
      let sumBytes = 2; // "{}"

      if (depth < budget.maxDepth) {
        for (const k of displayKeys) {
          const childSummary = walk(record[k], depth + 1);
          properties[k] = childSummary;
          if (childSummary.truncated) {
            isTruncated = true;
          }
          maxChildDepth = Math.max(maxChildDepth, childSummary.depth);
          sumChildNodes += childSummary.totalNodes;
          sumBytes +=
            Buffer.byteLength(k, "utf8") + childSummary.byteEstimate + 3; // key + quotes + colon
        }
      }

      return {
        type: "object",
        depth: maxChildDepth + 1,
        totalNodes: sumChildNodes + 1,
        byteEstimate: sumBytes,
        propertyCount,
        keys: displayKeys,
        properties,
        truncated: isTruncated,
      };
    } finally {
      if (typeof val === "object" && val !== null) {
        seen.delete(val);
      }
    }
  }

  return walk(data, 1);
}

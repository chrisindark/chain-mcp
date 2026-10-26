import {
  type NavigationLimits,
  NavigationBudget,
  DANGEROUS_KEYS,
  JsonNavigationError,
} from "./limits.js";

export type FilterOp =
  "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "contains" | "in" | "exists";

export interface SimplePredicate {
  field: string;
  op: FilterOp;
  value?: unknown;
}

export interface LogicalFilter {
  and?: FilterExpression[];
  or?: FilterExpression[];
  not?: FilterExpression;
}

export type FilterExpression = SimplePredicate | LogicalFilter;

export function filterData<T = unknown>(
  data: unknown,
  filter: FilterExpression,
  options?: NavigationLimits,
): T[] {
  const budget = new NavigationBudget(options);

  if (!Array.isArray(data)) {
    throw new JsonNavigationError("Filter requires an array input");
  }

  function getField(obj: unknown, path: string): unknown {
    if (obj === null || typeof obj !== "object") return undefined;
    const parts = path.split(".").map((p) => p.trim());
    let current: unknown = obj;
    for (const part of parts) {
      if (current === null || typeof current !== "object") return undefined;
      if (DANGEROUS_KEYS.has(part)) return undefined;
      current = (current as Record<string, unknown>)[part];
    }
    return current;
  }

  function evaluatePredicate(item: unknown, pred: SimplePredicate): boolean {
    const val = getField(item, pred.field);

    switch (pred.op) {
      case "exists":
        return val !== undefined;
      case "eq":
        return val === pred.value;
      case "neq":
        return val !== pred.value;
      case "gt":
        return typeof val === "number" && typeof pred.value === "number"
          ? val > pred.value
          : false;
      case "gte":
        return typeof val === "number" && typeof pred.value === "number"
          ? val >= pred.value
          : false;
      case "lt":
        return typeof val === "number" && typeof pred.value === "number"
          ? val < pred.value
          : false;
      case "lte":
        return typeof val === "number" && typeof pred.value === "number"
          ? val <= pred.value
          : false;
      case "contains":
        if (typeof val === "string" && typeof pred.value === "string") {
          return val.includes(pred.value);
        }
        if (Array.isArray(val)) {
          return val.includes(pred.value);
        }
        return false;
      case "in":
        if (Array.isArray(pred.value)) {
          return pred.value.includes(val);
        }
        return false;
      default:
        return false;
    }
  }

  function evaluate(
    item: unknown,
    expr: FilterExpression,
    depth: number,
  ): boolean {
    budget.visitNode(depth);

    if ("and" in expr && Array.isArray(expr.and)) {
      return expr.and.every((sub) => evaluate(item, sub, depth + 1));
    }
    if ("or" in expr && Array.isArray(expr.or)) {
      return expr.or.some((sub) => evaluate(item, sub, depth + 1));
    }
    if ("not" in expr && expr.not !== undefined) {
      return !evaluate(item, expr.not, depth + 1);
    }
    if ("field" in expr && "op" in expr) {
      return evaluatePredicate(item, expr);
    }
    return false;
  }

  const results: T[] = [];
  const limit = Math.min(data.length, budget.maxVisitedNodes);

  for (let i = 0; i < limit && results.length < budget.maxArrayItems; i++) {
    const item = data[i];
    if (evaluate(item, filter, 1)) {
      results.push(item as T);
    }
  }

  budget.assertResultBytes(results);
  return results;
}

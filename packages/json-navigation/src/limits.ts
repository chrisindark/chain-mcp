export class JsonNavigationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JsonNavigationError";
  }
}

export class JsonNavigationLimitError extends JsonNavigationError {
  readonly limitName: string;

  constructor(message: string, limitName: string) {
    super(message);
    this.name = "JsonNavigationLimitError";
    this.limitName = limitName;
  }
}

export class JsonPathSyntaxError extends JsonNavigationError {
  constructor(message: string) {
    super(message);
    this.name = "JsonPathSyntaxError";
  }
}

export const DEFAULT_MAX_DEPTH = 16;
export const MAX_ALLOWED_DEPTH = 64;
export const DEFAULT_MAX_VISITED_NODES = 50_000;
export const DEFAULT_MAX_ARRAY_ITEMS = 1_000;
export const DEFAULT_MAX_RESULT_BYTES = 50_000;
export const DEFAULT_TIMEOUT_MS = 5_000;

export const DANGEROUS_KEYS = new Set([
  "__proto__",
  "prototype",
  "constructor",
]);

export interface NavigationLimits {
  maxDepth?: number;
  maxVisitedNodes?: number;
  maxArrayItems?: number;
  maxResultBytes?: number;
  timeoutMs?: number;
}

export class NavigationBudget {
  readonly maxDepth: number;
  readonly maxVisitedNodes: number;
  readonly maxArrayItems: number;
  readonly maxResultBytes: number;
  readonly deadline: number;
  visitedNodes = 0;

  constructor(limits?: NavigationLimits) {
    const configuredDepth = limits?.maxDepth ?? DEFAULT_MAX_DEPTH;
    this.maxDepth = Math.min(Math.max(1, configuredDepth), MAX_ALLOWED_DEPTH);
    this.maxVisitedNodes = Math.max(
      1,
      limits?.maxVisitedNodes ?? DEFAULT_MAX_VISITED_NODES,
    );
    this.maxArrayItems = Math.max(
      1,
      limits?.maxArrayItems ?? DEFAULT_MAX_ARRAY_ITEMS,
    );
    this.maxResultBytes = Math.max(
      1,
      limits?.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES,
    );
    const timeoutMs = Math.max(1, limits?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.deadline = performance.now() + timeoutMs;
  }

  visitNode(currentDepth: number): void {
    if (currentDepth > this.maxDepth) {
      throw new JsonNavigationLimitError(
        `Traversal depth ${currentDepth} exceeded maximum of ${this.maxDepth}`,
        "maxDepth",
      );
    }
    this.visitedNodes++;
    if (this.visitedNodes > this.maxVisitedNodes) {
      throw new JsonNavigationLimitError(
        `Visited nodes (${this.visitedNodes}) exceeded budget of ${this.maxVisitedNodes}`,
        "maxVisitedNodes",
      );
    }
    if (performance.now() > this.deadline) {
      throw new JsonNavigationLimitError(
        "Navigation execution time budget exceeded",
        "timeoutMs",
      );
    }
  }

  checkBytes(bytes: number): void {
    if (bytes > this.maxResultBytes) {
      throw new JsonNavigationLimitError(
        `Result byte size (${bytes} bytes) exceeded limit of ${this.maxResultBytes} bytes`,
        "maxResultBytes",
      );
    }
  }

  assertResultBytes(value: unknown): void {
    if (value === undefined) return;
    const serialized = JSON.stringify(value);
    if (serialized !== undefined) {
      const bytes = Buffer.byteLength(serialized, "utf8");
      this.checkBytes(bytes);
    }
  }
}

import {
  auditInputSchema,
  isJsonObject,
  MAX_SCHEMA_DEPTH,
  type JsonSchema,
} from "./schema.js";

export type {
  JsonSchema,
  SchemaAuditResult,
  SchemaDiagnostic,
  SchemaDiagnosticCode,
} from "./schema.js";
export { auditInputSchema, MAX_SCHEMA_DEPTH } from "./schema.js";

export interface Principal {
  id: string;
  scopes: readonly string[];
  attributes?: Readonly<Record<string, string>>;
}

export interface ToolContext {
  requestId: string;
  tenantId: string;
  principal: Principal;
  signal?: AbortSignal;
}

export interface OperationPolicy {
  requiredScopes?: readonly string[];
}

export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  operation: OperationPolicy;
  timeoutMs?: number;
  execute(input: TInput, context: ToolContext): Promise<TOutput>;
}

export type RuntimeEvent = {
  name: "tool_invocation";
  timestamp: number;
  durationMs: number;
  tenantId: string;
  toolName: string;
  outcome: "success" | "error" | "rate_limited";
  errorCode?: RuntimeErrorCode;
};

export interface CacheStore {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T, ttlSeconds: number): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface RateLimiter {
  check(context: ToolContext, toolName: string): Promise<void>;
}

export interface MetricsSink {
  record(event: RuntimeEvent): void | Promise<void>;
}

export interface Authorizer {
  authorize(tool: ToolDefinition, context: ToolContext): void | Promise<void>;
}

export interface ToolRuntime {
  register(tool: ToolDefinition): void;
  listTools(): ReadonlyArray<{
    name: string;
    description: string;
    inputSchema: JsonSchema;
  }>;
  callTool(
    name: string,
    input: unknown,
    context: ToolContext,
  ): Promise<unknown>;
}

export type RuntimeErrorCode =
  | "TOOL_NOT_FOUND"
  | "TOOL_ALREADY_REGISTERED"
  | "CONTRACT_INVALID"
  | "INPUT_INVALID"
  | "AUTH_FORBIDDEN"
  | "RATE_LIMITED"
  | "CANCELLED"
  | "UPSTREAM_TIMEOUT"
  | "UPSTREAM_FAILURE";

export class RuntimeError extends Error {
  constructor(
    public readonly code: RuntimeErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RuntimeError";
  }
}

export interface RuntimeOptions {
  authorizer?: Authorizer;
  rateLimiter?: RateLimiter;
  metrics?: MetricsSink;
  now?: () => number;
  defaultTimeoutMs?: number;
}

export class InMemoryToolRuntime implements ToolRuntime {
  private readonly tools = new Map<string, ToolDefinition>();
  private readonly now: () => number;

  constructor(private readonly options: RuntimeOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  register(tool: ToolDefinition): void {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(tool.name)) {
      throw new TypeError(
        "Tool name must be 1-64 letters, numbers, underscores, or hyphens",
      );
    }
    if (this.tools.has(tool.name)) {
      throw new RuntimeError(
        "TOOL_ALREADY_REGISTERED",
        `Tool '${tool.name}' is already registered`,
      );
    }
    assertSupportedInputSchema(tool.inputSchema);
    this.tools.set(tool.name, tool);
  }

  listTools(): ReadonlyArray<{
    name: string;
    description: string;
    inputSchema: JsonSchema;
  }> {
    return [...this.tools.values()].map(
      ({ name, description, inputSchema }) => ({
        name,
        description,
        inputSchema,
      }),
    );
  }

  async callTool(
    name: string,
    input: unknown,
    context: ToolContext,
  ): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool)
      throw new RuntimeError("TOOL_NOT_FOUND", `Tool '${name}' was not found`);

    const startedAt = this.now();
    let outcome: RuntimeEvent["outcome"] = "success";
    let errorCode: RuntimeErrorCode | undefined;
    try {
      // Authorization must precede validation: validation errors reveal the
      // tool's schema, which unauthorized callers must not be able to probe.
      await this.options.authorizer?.authorize(tool, context);
      validateInput(tool.inputSchema, input);
      await this.options.rateLimiter?.check(context, name);
      return await executeWithTimeout(
        tool,
        input,
        context,
        this.options.defaultTimeoutMs ?? 15_000,
      );
    } catch (error) {
      outcome =
        error instanceof RuntimeError && error.code === "RATE_LIMITED"
          ? "rate_limited"
          : "error";
      errorCode =
        error instanceof RuntimeError ? error.code : "UPSTREAM_FAILURE";
      if (error instanceof RuntimeError) throw error;
      throw new RuntimeError("UPSTREAM_FAILURE", `Tool '${name}' failed`, {
        cause: error,
      });
    } finally {
      if (this.options.metrics) {
        const event: RuntimeEvent = {
          name: "tool_invocation",
          timestamp: this.now(),
          durationMs: Math.max(0, this.now() - startedAt),
          tenantId: context.tenantId,
          toolName: name,
          outcome,
          ...(errorCode ? { errorCode } : {}),
        };
        try {
          void Promise.resolve(this.options.metrics.record(event)).catch(
            () => {},
          );
        } catch {
          // Telemetry failures must not change the tool result.
        }
      }
    }
  }
}

function assertSupportedInputSchema(schema: unknown): void {
  const [diagnostic] = auditInputSchema(schema).diagnostics;
  if (diagnostic) {
    throw new RuntimeError("CONTRACT_INVALID", diagnostic.message);
  }
}

function validateInput(schema: JsonSchema, input: unknown): void {
  const issues: string[] = [];
  validateValue(schema, input, "$", issues);
  if (issues.length > 0) {
    throw new RuntimeError(
      "INPUT_INVALID",
      `Input does not match schema: ${issues.join("; ")}`,
    );
  }
}

function validateValue(
  schema: JsonSchema,
  value: unknown,
  path: string,
  issues: string[],
  depth = 0,
): void {
  if (depth > MAX_SCHEMA_DEPTH) {
    issues.push(
      `${path} exceeds the maximum validation depth of ${MAX_SCHEMA_DEPTH}`,
    );
    return;
  }
  const type = schema.type;
  if (!matchesTypeDeclaration(type, value)) {
    issues.push(`${path} must be ${describeTypeDeclaration(type)}`);
    return;
  }
  if (
    Array.isArray(schema.enum) &&
    !schema.enum.some((item) => Object.is(item, value))
  ) {
    issues.push(`${path} must be one of the allowed values`);
  }
  if (isJsonObject(value)) {
    const properties = isJsonObject(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (typeof key === "string" && !(key in value))
        issues.push(`${path}.${key} is required`);
    }
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (key in value && isJsonObject(propertySchema)) {
        validateValue(
          propertySchema,
          value[key],
          `${path}.${key}`,
          issues,
          depth + 1,
        );
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) issues.push(`${path}.${key} is not allowed`);
      }
    }
  }
  if (Array.isArray(value) && isJsonObject(schema.items)) {
    value.forEach((item, index) =>
      validateValue(
        schema.items as JsonSchema,
        item,
        `${path}[${index}]`,
        issues,
        depth + 1,
      ),
    );
  }
}

function matchesTypeDeclaration(type: unknown, value: unknown): boolean {
  if (type === undefined) return true;
  if (typeof type === "string") return matchesType(type, value);
  if (Array.isArray(type)) {
    return (
      type.length > 0 &&
      type.some(
        (entry: unknown) =>
          typeof entry === "string" && matchesType(entry, value),
      )
    );
  }
  return false;
}

function describeTypeDeclaration(type: unknown): string {
  if (typeof type === "string") return type;
  if (Array.isArray(type)) {
    const types = type.filter(
      (entry: unknown): entry is string => typeof entry === "string",
    );
    if (types.length > 0) return types.join(" or ");
  }
  return "an allowed type";
}

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case "object":
      return isJsonObject(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return false;
  }
}

// Timeout and cancellation are cooperative: aborting the per-call signal
// rejects the caller, but cannot stop a tool that ignores the signal or
// release resources on its behalf. Executors must bind context.signal to
// abortable I/O and clean up in finally.
async function executeWithTimeout(
  tool: ToolDefinition,
  input: unknown,
  context: ToolContext,
  defaultTimeoutMs: number | undefined,
): Promise<unknown> {
  const timeoutMs = tool.timeoutMs ?? defaultTimeoutMs;
  if (
    timeoutMs !== undefined &&
    (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
  ) {
    throw new TypeError("Tool timeout must be a positive finite number");
  }
  const controller = new AbortController();
  const parentSignal = context.signal;
  if (parentSignal?.aborted) {
    throw new RuntimeError("CANCELLED", `Tool '${tool.name}' was cancelled`, {
      cause: parentSignal.reason,
    });
  }
  const abortFromParent = (): void => controller.abort(parentSignal?.reason);
  let terminationReject: ((error: RuntimeError) => void) | undefined;
  const termination = new Promise<never>((_resolve, reject) => {
    terminationReject = reject;
  });
  const onParentAbort = (): void => {
    abortFromParent();
    terminationReject?.(
      new RuntimeError("CANCELLED", `Tool '${tool.name}' was cancelled`, {
        cause: parentSignal?.reason,
      }),
    );
  };
  parentSignal?.addEventListener("abort", onParentAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  if (timeoutMs !== undefined) {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error("Tool execution timed out"));
      terminationReject?.(
        new RuntimeError("UPSTREAM_TIMEOUT", `Tool '${tool.name}' timed out`),
      );
    }, timeoutMs);
  }
  try {
    const execution = tool.execute(input, {
      ...context,
      signal: controller.signal,
    });
    return await Promise.race([execution, termination]);
  } catch (error) {
    if (
      timedOut &&
      !(error instanceof RuntimeError && error.code === "UPSTREAM_TIMEOUT")
    ) {
      throw new RuntimeError(
        "UPSTREAM_TIMEOUT",
        `Tool '${tool.name}' timed out`,
        { cause: error },
      );
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    parentSignal?.removeEventListener("abort", onParentAbort);
  }
}

export function createCacheKey(parts: {
  tenantId: string;
  principalId: string;
  contractRevision: string;
  toolName: string;
  arguments: unknown;
}): string {
  return JSON.stringify([
    parts.tenantId,
    parts.principalId,
    parts.contractRevision,
    parts.toolName,
    canonicalize(parts.arguments, new Set()),
  ]);
}

function canonicalize(value: unknown, ancestors: Set<object>): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(
        "Cache key arguments cannot contain non-finite numbers",
      );
    }
    return value;
  }
  if (typeof value === "object") {
    if (ancestors.has(value)) {
      throw new TypeError("Cache key arguments cannot contain cycles");
    }
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        return value.map((item) => canonicalize(item, ancestors));
      }
      if (
        !isJsonObject(value) ||
        Object.getOwnPropertySymbols(value).length > 0
      ) {
        throw new TypeError(
          "Cache key arguments must be plain JSON-compatible data",
        );
      }
      return Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [key, canonicalize(value[key], ancestors)]),
      );
    } finally {
      ancestors.delete(value);
    }
  }
  if (
    value === undefined ||
    typeof value === "bigint" ||
    typeof value === "function" ||
    typeof value === "symbol"
  ) {
    throw new TypeError("Cache key arguments must be JSON-compatible");
  }
  return value;
}

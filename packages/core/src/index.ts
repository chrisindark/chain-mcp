import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

import {
  cacheKeyHashDomain,
  cacheKeyPrefix,
  MAX_CACHE_KEY_INPUT_BYTES,
} from "./cache-key.js";
import {
  auditInputSchema,
  isAssertedFormat,
  isJsonObject,
  matchesFormat,
  MAX_SCHEMA_DEPTH,
  patternMatches,
  stableValueKey,
  type JsonSchema,
} from "./schema.js";
import { assertFieldSelection } from "./field-projection.js";
import type { FieldSelection } from "./field-projection.js";
import { stringifyBounded, SerializationLimitError } from "./bounded-json.js";

export type {
  JsonSchema,
  SchemaAuditResult,
  SchemaDiagnostic,
  SchemaDiagnosticCode,
} from "./schema.js";
export { auditInputSchema, MAX_SCHEMA_DEPTH } from "./schema.js";
export { CACHE_KEY_VERSION, MAX_CACHE_KEY_INPUT_BYTES } from "./cache-key.js";
export {
  stringifyBounded,
  SerializationLimitError,
  type BoundedStringifyOptions,
} from "./bounded-json.js";

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

export type ToolContextFactory = () => ToolContext | Promise<ToolContext>;

export interface OperationPolicy {
  requiredScopes?: readonly string[];
}

export interface ToolCachePolicy {
  /**
   * Time-to-live for cached results, in seconds. Store adapters enforce their
   * own upper bound. Caching is opt-in: only idempotent read operations should
   * declare it, and no tool is cached by default.
   */
  ttlSeconds: number;
}

export interface ToolOutputPolicy {
  /**
   * Maximum tokens allowed in the projected result. Requires a runtime
   * tokenizer and is enforced before the result is cached or returned.
   * Omitting it still opts into projection, without a budget.
   */
  maxTokens?: number;
  /**
   * Declarative include/exclude rules for the built-in field projector. Use
   * `createFieldProjector()` as the runtime projector to apply them. Paths are
   * dot-separated keys and traverse arrays element-wise. Registration validates
   * the selection; see `FieldSelection`.
   */
  fields?: FieldSelection;
}

export interface ResultProjectionRequest {
  tool: ToolDefinition;
  context: ToolContext;
  result: unknown;
}

/**
 * Deployment-supplied output policy. A projector returns the exact value the
 * caller and model may see, typically by removing unauthorized or
 * unpresentable fields. The runtime enforces that a projected result has a
 * JSON representation and meets the tool's token budget; it does not decide
 * which fields are safe.
 */
export interface ResultProjector {
  project(request: ResultProjectionRequest): unknown;
}

export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  operation: OperationPolicy;
  /**
   * Immutable contract revision this tool was compiled from. Required when
   * `cache` is set, and hashed into every cache key so revisions cannot share
   * entries.
   */
  contractRevision?: string;
  /** Opt-in caching for an idempotent read operation. Omit for mutations. */
  cache?: ToolCachePolicy;
  /**
   * Opt-in output projection and optional token budget. Requires the runtime
   * to be constructed with a projector; a budget also requires a tokenizer.
   */
  output?: ToolOutputPolicy;
  /**
   * Tenant that owns this tool, bound at registration time. In multi-tenant
   * mode the binding is required. In single-tenant mode an omitted value is
   * stamped with the deployment's pinned tenant (`RuntimeOptions.tenantId`),
   * and an explicit value must match it. See ADR 0008.
   */
  ownerTenantId?: string;
  timeoutMs?: number;
  execute(input: TInput, context: ToolContext): Promise<TOutput>;
}

export interface ToolSource {
  /**
   * Produces the set of tools supplied by this source.
   */
  getTools(): Promise<readonly ToolDefinition[]> | readonly ToolDefinition[];
}

export type RuntimeEvent = {
  name: "tool_invocation";
  timestamp: number;
  durationMs: number;
  tenantId: string;
  toolName: string;
  outcome: "success" | "error" | "rate_limited";
  errorCode?: RuntimeErrorCode;
  /**
   * Cache lookup result for a cache-eligible tool when the runtime has a cache.
   * Absent for tools that are not cache-eligible. `bypass` means no lookup
   * produced a value: the partition or key could not be derived, or the store
   * read failed. The hit ratio is `hit / (hit + miss)`; `bypass` is reported
   * separately because no usable lookup occurred.
   */
  cacheOutcome?: "hit" | "miss" | "bypass";
  /**
   * Token measurement for a successful invocation when a `Tokenizer` is
   * configured. Absent when the tokenizer is not configured, the result cannot
   * be serialized, or the adapter fails or returns an unusable count. Always
   * includes the measurement mode so estimates are never presented as exact.
   */
  tokenUsage?: {
    count: number;
    measurement: "exact" | "estimate";
    tokenizer: string;
    /** UTF-8 bytes of the serialized result presented to the model. */
    payloadBytes: number;
  };
};

export interface CacheStore {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T, ttlSeconds: number): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface RuntimeCacheOptions {
  /**
   * Store used for eligible invocations. Its byte, entry, and TTL limits are
   * the adapter's responsibility; the runtime never caches writes implicitly.
   */
  store: CacheStore;
  /**
   * Derives a stable, non-secret authorization partition from the caller's
   * effective grants or policy state. Return `undefined` to bypass caching for
   * this call. Throwing also bypasses caching; it never fails the tool call.
   * Never return a bearer token or another credential.
   */
  authorizationPartition(
    context: ToolContext,
    tool: ToolDefinition,
  ): string | undefined;
}

export interface RateLimitDecision {
  /**
   * `false` means the limiter denied this invocation. Throwing is reserved for
   * limiter failures; only an explicit denial produces a `rate_limited` event.
   */
  allowed: boolean;
  /**
   * Optional integer number of seconds the caller should wait before retrying.
   * Attached to `RuntimeError.retryAfterSeconds` when `allowed: false`.
   */
  retryAfterSeconds?: number;
}

export interface RateLimiter {
  check(
    context: ToolContext,
    toolName: string,
  ): RateLimitDecision | Promise<RateLimitDecision>;
  /**
   * Optional release hook called when tool execution finishes (on success,
   * failure, timeout, or cancellation), allowing concurrency permits to be released.
   */
  release?(context: ToolContext, toolName: string): void | Promise<void>;
}

export interface MetricsSink {
  record(event: RuntimeEvent): void | Promise<void>;
}

export interface ToolSpan {
  spanContext?(): {
    readonly traceId?: string | undefined;
    readonly spanId?: string | undefined;
    readonly traceFlags?: number | undefined;
  };
  setAttribute?(key: string, value: string | number | boolean): void;
  setAttributes?(attributes: Record<string, string | number | boolean>): void;
  recordException?(error: Error): void;
  setStatus?(status: { code: number; message?: string }): void;
  end?(): void;
}

export interface ToolTracer {
  startToolSpan(
    toolName: string,
    context: ToolContext,
    contractRevision?: string | undefined,
  ): ToolSpan | unknown;
  endToolSpan(
    span: ToolSpan | unknown,
    details?: {
      error?: unknown;
      cacheOutcome?: string | undefined;
      outcome?: "success" | "error" | "rate_limited" | "cancelled" | undefined;
      durationMs?: number | undefined;
      cached?: boolean | undefined;
    },
  ): void;
  startChildSpan?(
    name: string,
    attributes?: Record<string, string | number | boolean> | undefined,
  ): ToolSpan | unknown;
  endSpan?(
    span: ToolSpan | unknown,
    details?: {
      error?: unknown;
      outcome?: "success" | "error" | "rate_limited" | "cancelled" | undefined;
      durationMs?: number | undefined;
    },
  ): void;
  withSpan?<T>(span: ToolSpan | unknown, fn: () => Promise<T> | T): Promise<T>;
}

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

export interface LogCorrelationContext {
  requestId?: string | undefined;
  tenantId?: string | undefined;
  principalId?: string | undefined;
  toolName?: string | undefined;
  contractRevision?: string | undefined;
  [key: string]: unknown;
}

export interface LogRecord {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  timestamp: number;
  category?: "diagnostic" | "audit" | undefined;
  context?: LogCorrelationContext | undefined;
  error?:
    | {
        code?: string | undefined;
        message: string;
        stack?: string | undefined;
      }
    | undefined;
  attributes?: Record<string, unknown> | undefined;
}

export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
  audit?(message: string, context?: Record<string, unknown>): void;
  child?(context: Record<string, unknown>): Logger;
}

export interface Tokenizer {
  /**
   * Stable identifier for the tokenizer or model, for example `cl100k_base` or
   * a model name. Recorded with each measurement.
   */
  readonly id: string;
  /**
   * Whether `count` is authoritative for this tokenizer (`exact`) or an
   * approximation (`estimate`). Adapters must not claim `exact` unless the
   * count matches the tokenizer the model will actually use.
   */
  readonly measurement: "exact" | "estimate";
  /** Counts tokens in the serialized result presented to the model. */
  count(text: string): number;
}

export interface Authorizer {
  authorize(tool: ToolDefinition, context: ToolContext): void | Promise<void>;
}

export interface ToolRuntime {
  /**
   * Tenancy mode implemented by this runtime. Adapters dispatch on this
   * declaration rather than on a concrete class, so a custom runtime that
   * requires a caller context cannot be listed through the single-tenant
   * snapshot path.
   */
  readonly tenantMode: TenantMode;
  register(tool: ToolDefinition): void;
  registerSource?(source: ToolSource): Promise<void>;
  /**
   * Lists tools. In single-tenant mode the listing is unfiltered, matching
   * Milestone 2 behavior. In multi-tenant mode the listing is scoped to the
   * caller's tenant and computed per call; without a context it fails closed
   * with `AUTH_REQUIRED` (ADR 0008).
   */
  listTools(context?: ToolContext): ReadonlyArray<{
    name: string;
    description: string;
    inputSchema: JsonSchema;
  }>;
  callTool(
    name: string,
    input: unknown,
    context: ToolContext | ToolContextFactory,
  ): Promise<unknown>;
  /**
   * Deletes the cached result for one exact invocation. Optional: a runtime
   * without caching support may omit it. Hashed keys cannot be invalidated by
   * prefix or predicate, so callers must supply the same tool, arguments, and
   * caller context used for the cached call. This is a trusted operator
   * surface, not an MCP request: it does not run authorization, and it is a
   * no-op when caching is not configured, the tool is not cache-eligible, or
   * the key cannot be derived. Store deletion failures propagate.
   */
  invalidateCachedResult?(
    name: string,
    input: unknown,
    context: ToolContext,
  ): Promise<void>;
}

export type RuntimeErrorCode =
  | "TOOL_NOT_FOUND"
  | "TOOL_ALREADY_REGISTERED"
  | "CONFIG_INVALID"
  | "CONTRACT_INVALID"
  | "INPUT_INVALID"
  | "INPUT_TOO_LARGE"
  | "AUTH_REQUIRED"
  | "AUTH_FORBIDDEN"
  | "TENANT_REQUIRED"
  | "RATE_LIMITED"
  | "OUTPUT_POLICY_VIOLATION"
  | "OUTPUT_LIMIT_EXCEEDED"
  | "CANCELLED"
  | "UPSTREAM_TIMEOUT"
  | "UPSTREAM_FAILURE";

export class RuntimeError extends Error {
  public readonly retryAfterSeconds?: number;

  constructor(
    public readonly code: RuntimeErrorCode,
    message: string,
    options?: ErrorOptions & { retryAfterSeconds?: number },
  ) {
    super(message, options);
    this.name = "RuntimeError";
    if (
      typeof options?.retryAfterSeconds === "number" &&
      Number.isFinite(options.retryAfterSeconds) &&
      options.retryAfterSeconds >= 0
    ) {
      this.retryAfterSeconds = Math.ceil(options.retryAfterSeconds);
    }
  }
}

export type TenantMode = "single-tenant" | "multi-tenant";

export interface RuntimeOptions {
  authorizer?: Authorizer;
  rateLimiter?: RateLimiter;
  metrics?: MetricsSink;
  /**
   * Injectable OpenTelemetry tracer adapter. Emits correlated spans across tool
   * invocation stages, nested operations, and error paths without leaking
   * arguments or response bodies.
   */
  tracer?: ToolTracer;
  /**
   * Injectable structured logger. Emits correlated diagnostic and audit records
   * across tool invocation stages. Failures in logger invocation are isolated
   * and never alter tool results.
   */
  logger?: Logger;
  /**
   * Tenancy mode. Defaults to `single-tenant`: tools resolve by name exactly
   * as in Milestone 2. `multi-tenant` requires an `Authorizer`, binds every
   * tool to a tenant at registration, scopes resolution and listing to the
   * caller's tenant, and fails closed when not configured; see ADR 0008.
   */
  tenantMode?: TenantMode;
  /**
   * Pinned tenant for single-tenant mode. Registration stamps tools without
   * `ownerTenantId` with this tenant, rejects tools bound to a different
   * tenant, and denies calls whose `ToolContext.tenantId` differs from it.
   * Providing it in `multi-tenant` mode fails construction.
   */
  tenantId?: string;
  /** Wall clock used for the `RuntimeEvent` timestamp. Defaults to `Date.now`. */
  now?: () => number;
  /**
   * Monotonic clock used to measure `durationMs`. Defaults to
   * `performance.now`. Wall-clock time can jump backwards or forwards, so
   * durations must not be derived from `now`.
   */
  monotonicNow?: () => number;
  defaultTimeoutMs?: number;
  /**
   * Enables result caching for tools that opt in through `ToolDefinition.cache`.
   * Cache reads happen after authorization, validation, and rate limiting, so a
   * hit never bypasses those stages. Without this option, cache declarations are
   * inert and every invocation executes.
   */
  cache?: RuntimeCacheOptions;
  /**
   * Enables token measurement of successful results. The adapter supplies its
   * own identifier and declares whether counts are exact or estimates; the
   * runtime never labels an estimate as exact. Measurement failures omit
   * `tokenUsage` and never change the tool result.
   */
  tokenizer?: Tokenizer;
  /**
   * Applies output policy to tools that declare `ToolDefinition.output`.
   * Projection runs after execution and before caching or token measurement.
   * A projector failure, an unserializable result, or a token budget that
   * cannot be verified fails the call closed; it never returns the raw result.
   */
  projector?: ResultProjector;
  /** Maximum allowed tool input arguments size in UTF-8 bytes. Default: 1,048,576 (1 MiB). */
  maxToolInputBytes?: number;
  /** Maximum allowed tool output serialization size in UTF-8 bytes. */
  maxResponseBytes?: number;
}

export class InMemoryToolRuntime implements ToolRuntime {
  /** Tenancy mode selected at construction. See ADR 0008. */
  readonly tenantMode: TenantMode;
  private readonly pinnedTenantId: string | undefined;
  // Tools are stored per tenant so multi-tenant resolution can never observe
  // another tenant's registrations, while `names` preserves the exact
  // Milestone 2 name-keyed behavior in single-tenant mode.
  private readonly tenantTools = new Map<string, Map<string, ToolDefinition>>();
  private readonly names = new Map<string, ToolDefinition>();
  private readonly now: () => number;
  private readonly monotonicNow: () => number;

  constructor(private readonly options: RuntimeOptions = {}) {
    this.now = options.now ?? Date.now;
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    const tenantMode = options.tenantMode ?? "single-tenant";
    if (tenantMode !== "single-tenant" && tenantMode !== "multi-tenant") {
      throw new RuntimeError(
        "CONFIG_INVALID",
        "Tenant mode must be 'single-tenant' or 'multi-tenant'",
      );
    }
    if (tenantMode === "single-tenant") {
      if (
        options.tenantId !== undefined &&
        !isNonEmptyTenantId(options.tenantId)
      ) {
        throw new RuntimeError(
          "CONFIG_INVALID",
          "A single-tenant runtime must pin a non-empty tenant",
        );
      }
    } else {
      // A multi-tenant registry without a mandatory authorization stage would
      // admit cross-tenant access by default, so it cannot be constructed.
      if (!options.authorizer) {
        throw new RuntimeError(
          "CONFIG_INVALID",
          "A multi-tenant runtime requires an authorizer",
        );
      }
      if (options.tenantId !== undefined) {
        throw new RuntimeError(
          "CONFIG_INVALID",
          "Tenant pinning applies only to single-tenant runtimes",
        );
      }
    }
    this.tenantMode = tenantMode;
    this.pinnedTenantId =
      tenantMode === "single-tenant" ? options.tenantId : undefined;
    if (options.cache !== undefined) {
      const store = options.cache.store;
      if (
        typeof store?.get !== "function" ||
        typeof store.set !== "function" ||
        typeof store.delete !== "function"
      ) {
        throw new RuntimeError(
          "CONFIG_INVALID",
          "Runtime cache requires a get/set/delete store",
        );
      }
      if (typeof options.cache.authorizationPartition !== "function") {
        throw new RuntimeError(
          "CONFIG_INVALID",
          "Runtime cache requires an authorizationPartition function",
        );
      }
    }
    if (options.tokenizer !== undefined) {
      const tokenizer = options.tokenizer;
      if (!isNonEmptyTrimmedString(tokenizer.id)) {
        throw new RuntimeError(
          "CONFIG_INVALID",
          "Runtime tokenizer requires a non-empty id",
        );
      }
      if (
        tokenizer.measurement !== "exact" &&
        tokenizer.measurement !== "estimate"
      ) {
        throw new RuntimeError(
          "CONFIG_INVALID",
          "Runtime tokenizer measurement must be 'exact' or 'estimate'",
        );
      }
      if (typeof tokenizer.count !== "function") {
        throw new RuntimeError(
          "CONFIG_INVALID",
          "Runtime tokenizer requires a count function",
        );
      }
    }
    if (
      options.projector !== undefined &&
      typeof options.projector.project !== "function"
    ) {
      throw new RuntimeError(
        "CONFIG_INVALID",
        "Runtime projector requires a project function",
      );
    }
  }

  register(tool: ToolDefinition): void {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(tool.name)) {
      throw new TypeError(
        "Tool name must be 1-64 letters, numbers, underscores, or hyphens",
      );
    }
    const tenantId = this.resolveOwnerTenantId(tool);
    if (this.tenantMode === "single-tenant" && this.names.has(tool.name)) {
      throw new RuntimeError(
        "TOOL_ALREADY_REGISTERED",
        `Tool '${tool.name}' is already registered`,
      );
    }
    if (this.tenantTools.get(tenantId)?.has(tool.name)) {
      throw new RuntimeError(
        "TOOL_ALREADY_REGISTERED",
        `Tool '${tool.name}' is already registered`,
      );
    }
    assertSupportedInputSchema(tool.inputSchema);
    assertCacheMetadata(tool);
    assertOutputMetadata(tool, this.options);
    const bucket = this.tenantTools.get(tenantId);
    if (bucket) {
      bucket.set(tool.name, tool);
    } else {
      this.tenantTools.set(tenantId, new Map([[tool.name, tool]]));
    }
    if (this.tenantMode === "single-tenant") {
      this.names.set(tool.name, tool);
    }
  }

  async registerSource(source: ToolSource): Promise<void> {
    if (typeof source?.getTools !== "function") {
      throw new RuntimeError(
        "CONFIG_INVALID",
        "Tool source must provide a getTools() function",
      );
    }
    const tools = await source.getTools();
    if (!Array.isArray(tools)) {
      throw new RuntimeError(
        "CONFIG_INVALID",
        "Tool source getTools() must return an array of tools",
      );
    }
    for (const tool of tools) {
      this.register(tool);
    }
  }

  /**
   * Resolves the tenant a tool binds to at registration time and enforces the
   * mode's binding rules. In multi-tenant mode a binding is mandatory; in
   * single-tenant mode an unstamped tool binds to the pinned tenant or to no
   * tenant, preserving Milestone 2 behavior.
   */
  private resolveOwnerTenantId(tool: ToolDefinition): string {
    if (this.tenantMode === "multi-tenant") {
      if (!isNonEmptyTenantId(tool.ownerTenantId)) {
        throw new RuntimeError(
          "CONFIG_INVALID",
          `Tool '${tool.name}' must declare a non-empty ownerTenantId in multi-tenant mode`,
        );
      }
      return tool.ownerTenantId;
    }
    if (tool.ownerTenantId !== undefined) {
      if (!isNonEmptyTenantId(tool.ownerTenantId)) {
        throw new RuntimeError(
          "CONFIG_INVALID",
          `Tool '${tool.name}' declares an empty ownerTenantId`,
        );
      }
      if (
        this.pinnedTenantId !== undefined &&
        tool.ownerTenantId !== this.pinnedTenantId
      ) {
        throw new RuntimeError(
          "CONFIG_INVALID",
          `Tool '${tool.name}' is bound to tenant '${tool.ownerTenantId}', but this runtime pins tenant '${this.pinnedTenantId}'`,
        );
      }
      return tool.ownerTenantId;
    }
    return this.pinnedTenantId ?? "";
  }

  listTools(context?: ToolContext): ReadonlyArray<{
    name: string;
    description: string;
    inputSchema: JsonSchema;
  }> {
    const summarize = ({ name, description, inputSchema }: ToolDefinition) => ({
      name,
      description,
      inputSchema,
    });
    if (this.tenantMode === "single-tenant") {
      // Single-tenant listings stay unfiltered: every registered tool belongs
      // to the one deployment tenant.
      return [...this.names.values()].map(summarize);
    }
    // Multi-tenant listings are identity-scoped and computed per call; there
    // is no pre-filtered snapshot (ADR 0008). Without an identity the listing
    // fails closed instead of enumerating tools.
    if (context === undefined) {
      throw new RuntimeError(
        "AUTH_REQUIRED",
        "Listing tools requires a caller context",
      );
    }
    if (
      !context.tenantId ||
      typeof context.tenantId !== "string" ||
      context.tenantId.trim().length === 0
    ) {
      throw new RuntimeError(
        "TENANT_REQUIRED",
        "A non-empty tenantId is required to list tools in multi-tenant mode",
      );
    }
    const bucket = this.tenantTools.get(context.tenantId);
    if (!bucket) return [];
    return [...bucket.values()].map(summarize);
  }

  async callTool(
    name: string,
    input: unknown,
    contextOrFactory: ToolContext | ToolContextFactory,
  ): Promise<unknown> {
    // Single-tenant behavior stays Milestone 2-exact: unknown tools reject
    // before a context factory runs and emit no metrics event.
    if (this.tenantMode === "single-tenant" && !this.names.has(name)) {
      throw new RuntimeError("TOOL_NOT_FOUND", `Tool '${name}' was not found`);
    }
    const startedAt = this.monotonicNow();
    let outcome: RuntimeEvent["outcome"] = "success";
    let errorCode: RuntimeErrorCode | undefined;
    let cacheOutcome: RuntimeEvent["cacheOutcome"];
    let tokenUsage: RuntimeEvent["tokenUsage"];
    let context: ToolContext | undefined;
    let stage: InvocationStage = "context";
    let rateLimitDenied = false;
    let rateLimitAcquired = false;
    let toolRevision: string | undefined;
    let caughtError: unknown;
    let span: unknown;
    // Unknown and cross-tenant tools are the same observable miss in
    // multi-tenant mode and emit no metrics event, so metrics timing cannot
    // be used to enumerate another tenant's tools.
    let unresolved = false;
    try {
      context =
        typeof contextOrFactory === "function"
          ? await contextOrFactory()
          : contextOrFactory;
      const activeContext = context;
      stage = "authorization";
      const tool = this.resolveTool(name, activeContext, () => {
        unresolved = true;
      });
      toolRevision = tool.contractRevision;
      if (this.options.tracer && !unresolved && activeContext) {
        try {
          span = this.options.tracer.startToolSpan(
            name,
            activeContext,
            toolRevision,
          );
        } catch {
          // Tracer failures must not alter tool execution
        }
      }

      const runStages = async () => {
        if (
          this.tenantMode === "single-tenant" &&
          this.pinnedTenantId !== undefined &&
          activeContext.tenantId !== this.pinnedTenantId
        ) {
          // A pinned single-tenant deployment serves exactly one tenant; any
          // other caller identity is a policy denial, not a lookup miss.
          throw new RuntimeError("AUTH_FORBIDDEN", "Access denied");
        }
        // Authorization must precede validation: validation errors reveal the
        // tool's schema, which unauthorized callers must not be able to probe.
        await this.options.authorizer?.authorize(tool, activeContext);
        stage = "validation";
        const maxInputBytes = this.options.maxToolInputBytes ?? 1_048_576;
        if (input !== undefined && input !== null) {
          assertInputSize(tool.name, input, maxInputBytes);
        }
        validateInput(tool.inputSchema, input);
        stage = "rate_limit";
        const decision = this.options.rateLimiter
          ? await this.options.rateLimiter.check(activeContext, name)
          : undefined;
        if (this.options.rateLimiter) {
          if (
            decision === undefined ||
            decision === null ||
            typeof decision.allowed !== "boolean"
          ) {
            throw new RuntimeError(
              "UPSTREAM_FAILURE",
              `Rate limiter for tool '${name}' returned an invalid decision`,
            );
          }
          if (!decision.allowed) {
            rateLimitDenied = true;
            const retryAfterSeconds =
              typeof decision.retryAfterSeconds === "number" &&
              Number.isFinite(decision.retryAfterSeconds) &&
              decision.retryAfterSeconds >= 0
                ? Math.ceil(decision.retryAfterSeconds)
                : undefined;
            throw new RuntimeError("RATE_LIMITED", "Rate limit exceeded", {
              ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
            });
          }
          rateLimitAcquired = true;
        }
        stage = "cache";
        const cache = this.options.cache;
        let cacheKey: string | undefined;
        if (cache !== undefined && tool.cache !== undefined) {
          cacheKey =
            tool.contractRevision !== undefined
              ? tryCreateCacheKey(
                  cache,
                  tool,
                  tool.contractRevision,
                  input,
                  activeContext,
                )
              : undefined;
          if (cacheKey === undefined) {
            cacheOutcome = "bypass";
          } else {
            let cacheSpan: unknown;
            try {
              cacheSpan = this.options.tracer?.startChildSpan?.("cache.read", {
                "tool.name": name,
                "tenant.id": activeContext.tenantId,
              });
            } catch {
              // ignore
            }
            try {
              const lookup = await readCached(cache.store, cacheKey);
              if (lookup.status === "hit") {
                cacheOutcome = "hit";
                if (activeContext.signal?.aborted) {
                  throw new RuntimeError(
                    "CANCELLED",
                    `Tool '${name}' was cancelled`,
                    { cause: activeContext.signal.reason },
                  );
                }
                tokenUsage = this.measureTokens(lookup.value);
                return lookup.value;
              }
              cacheOutcome = lookup.status;
            } finally {
              if (cacheSpan) {
                try {
                  this.options.tracer?.endSpan?.(cacheSpan);
                } catch {
                  // ignore
                }
              }
            }
          }
        }
        stage = "execution";
        let execSpan: unknown;
        try {
          execSpan = this.options.tracer?.startChildSpan?.("upstream.call", {
            "tool.name": name,
            "tenant.id": activeContext.tenantId,
          });
        } catch {
          // ignore
        }
        let result: unknown;
        try {
          result = await executeWithTimeout(
            tool,
            input,
            activeContext,
            this.options.defaultTimeoutMs ?? 15_000,
          );
        } catch (err) {
          if (execSpan) {
            try {
              this.options.tracer?.endSpan?.(execSpan, { error: err });
            } catch {
              // ignore
            }
          }
          throw err;
        }
        if (execSpan) {
          try {
            this.options.tracer?.endSpan?.(execSpan);
          } catch {
            // ignore
          }
        }
        // Output policy runs before the cache write and before measurement so
        // that neither a cached entry nor telemetry ever contains a result that
        // failed projection or exceeded its budget.
        stage = "projection";
        let projSpan: unknown;
        try {
          projSpan = this.options.tracer?.startChildSpan?.("projection", {
            "tool.name": name,
            "tenant.id": activeContext.tenantId,
          });
        } catch {
          // ignore
        }
        let output: ReturnType<typeof this.applyOutputPolicy>;
        try {
          output = this.applyOutputPolicy(tool, result, activeContext);
        } finally {
          if (projSpan) {
            try {
              this.options.tracer?.endSpan?.(projSpan);
            } catch {
              // ignore
            }
          }
        }
        if (
          cache !== undefined &&
          cacheKey !== undefined &&
          tool.cache !== undefined &&
          output.result !== undefined
        ) {
          let cacheWriteSpan: unknown;
          try {
            cacheWriteSpan = this.options.tracer?.startChildSpan?.(
              "cache.write",
              {
                "tool.name": name,
                "tenant.id": activeContext.tenantId,
              },
            );
          } catch {
            // ignore
          }
          try {
            await writeCached(
              cache.store,
              cacheKey,
              output.result,
              tool.cache.ttlSeconds,
            );
          } finally {
            if (cacheWriteSpan) {
              try {
                this.options.tracer?.endSpan?.(cacheWriteSpan);
              } catch {
                // ignore
              }
            }
          }
        }
        // A budgeted tool already counted its projected result for enforcement;
        // reuse that count. Otherwise measurement is best-effort and runs after
        // the write, matching the non-projected path.
        tokenUsage =
          tool.output !== undefined && tool.output.maxTokens !== undefined
            ? output.tokenUsage
            : this.measureTokens(output.result);
        return output.result;
      };

      if (this.options.tracer?.withSpan && span) {
        return await this.options.tracer.withSpan(span, runStages);
      }
      return await runStages();
    } catch (error) {
      caughtError = error;
      const failure = classifyFailure(name, stage, error, rateLimitDenied);
      outcome = failure.outcome;
      errorCode = failure.error.code;
      throw failure.error;
    } finally {
      if (rateLimitAcquired && context && this.options.rateLimiter?.release) {
        try {
          await this.options.rateLimiter.release(context, name);
        } catch {
          // Release failures must not alter tool results.
        }
      }
      if (this.options.logger && !unresolved) {
        const durationMs = Math.max(0, this.monotonicNow() - startedAt);
        const logContext: LogCorrelationContext = {
          requestId: context?.requestId,
          tenantId: context?.tenantId ?? "unknown",
          principalId: context?.principal?.id,
          toolName: name,
          ...(toolRevision ? { contractRevision: toolRevision } : {}),
          durationMs,
          outcome,
          ...(errorCode ? { errorCode } : {}),
          ...(cacheOutcome ? { cacheOutcome } : {}),
        };
        try {
          if (outcome === "success") {
            this.options.logger.info(
              `Tool '${name}' completed successfully`,
              logContext,
            );
          } else if (outcome === "rate_limited") {
            this.options.logger.warn(
              `Tool '${name}' was rate limited`,
              logContext,
            );
            if (typeof this.options.logger.audit === "function") {
              this.options.logger.audit(
                `Rate limit exceeded for tool '${name}'`,
                logContext,
              );
            }
          } else {
            this.options.logger.error(
              `Tool '${name}' failed with error ${errorCode ?? "UNKNOWN"}`,
              logContext,
            );
            if (
              (errorCode === "AUTH_FORBIDDEN" ||
                errorCode === "AUTH_REQUIRED") &&
              typeof this.options.logger.audit === "function"
            ) {
              this.options.logger.audit(
                `Authorization denied for tool '${name}'`,
                logContext,
              );
            } else if (
              errorCode === "TENANT_REQUIRED" &&
              typeof this.options.logger.audit === "function"
            ) {
              this.options.logger.audit(
                `Tenant resolution failed for tool '${name}'`,
                logContext,
              );
            }
          }
        } catch {
          // Logger failures must never change the tool result or surface to the caller.
        }
      }
      if (this.options.metrics && !unresolved) {
        const event: RuntimeEvent = {
          name: "tool_invocation",
          timestamp: this.now(),
          durationMs: Math.max(0, this.monotonicNow() - startedAt),
          tenantId: context?.tenantId ?? "unknown",
          toolName: name,
          outcome,
          ...(errorCode ? { errorCode } : {}),
          ...(cacheOutcome ? { cacheOutcome } : {}),
          ...(tokenUsage ? { tokenUsage } : {}),
        };
        try {
          void Promise.resolve(this.options.metrics.record(event)).catch(
            () => {},
          );
        } catch {
          // Telemetry failures must not change the tool result.
        }
      }
      if (this.options.tracer && span) {
        const durationMs = Math.max(0, this.monotonicNow() - startedAt);
        const traceOutcome: "success" | "error" | "cancelled" =
          errorCode === "CANCELLED" || context?.signal?.aborted
            ? "cancelled"
            : outcome === "success"
              ? "success"
              : "error";
        try {
          this.options.tracer.endToolSpan(span, {
            error: caughtError,
            outcome: traceOutcome,
            durationMs,
            cacheOutcome,
            cached: cacheOutcome === "hit",
          });
        } catch {
          // Tracing failures must not alter tool results.
        }
      }
    }
  }

  /**
   * Deletes the cached result for one exact invocation. This does not run the
   * authorizer: it is a trusted process-local control surface, not a tool call.
   * Hashed keys cannot be enumerated by prefix, so callers must supply the
   * same tool, arguments, and caller context that produced the entry. A store
   * deletion failure is propagated so the operator sees that invalidation did
   * not succeed.
   */
  async invalidateCachedResult(
    name: string,
    input: unknown,
    context: ToolContext,
  ): Promise<void> {
    const tool = this.resolveTool(name, context, () => {});
    if (
      this.tenantMode === "single-tenant" &&
      this.pinnedTenantId !== undefined &&
      context.tenantId !== this.pinnedTenantId
    ) {
      throw new RuntimeError("AUTH_FORBIDDEN", "Access denied");
    }
    const cache = this.options.cache;
    if (
      cache === undefined ||
      tool.cache === undefined ||
      tool.contractRevision === undefined
    ) {
      return;
    }
    const cacheKey = tryCreateCacheKey(
      cache,
      tool,
      tool.contractRevision,
      input,
      context,
    );
    if (cacheKey === undefined) return;
    await cache.store.delete(cacheKey);
    if (this.options.logger) {
      try {
        if (typeof this.options.logger.audit === "function") {
          this.options.logger.audit(
            `Cache invalidation succeeded for tool '${name}'`,
            {
              toolName: name,
              tenantId: context.tenantId,
              principalId: context.principal?.id,
              requestId: context.requestId,
            },
          );
        }
      } catch {
        // Logging failure must never block or alter invalidation.
      }
    }
  }

  /**
   * Applies the deployment's output policy to a tool that opted in. Projection
   * must return a JSON-serializable value; when the tool declares a budget, an
   * unverifiable count or an over-budget result fails closed. A projected value
   * never falls back to the raw result.
   */
  private applyOutputPolicy(
    tool: ToolDefinition,
    result: unknown,
    context: ToolContext,
  ): { result: unknown; tokenUsage?: RuntimeEvent["tokenUsage"] } {
    const policy = tool.output;
    if (policy === undefined) return { result };
    const projector = this.options.projector;
    if (projector === undefined) {
      // Registration rejects this combination; keep the call path fail-closed
      // rather than silently returning unprojected output.
      throw new RuntimeError(
        "OUTPUT_POLICY_VIOLATION",
        `Tool '${tool.name}' requires output projection but no projector is configured`,
      );
    }
    let projected: unknown;
    try {
      projected = projector.project({ tool, context, result });
    } catch (error) {
      if (error instanceof RuntimeError) throw error;
      throw new RuntimeError(
        "OUTPUT_POLICY_VIOLATION",
        `Output policy for tool '${tool.name}' failed`,
        { cause: error },
      );
    }
    // An async projector is a likely deployment mistake: JSON.stringify would
    // turn its Promise into `{}` and silently return the wrong value. The
    // adapter contract is synchronous, so fail closed rather than serialize it.
    if (isThenable(projected)) {
      throw new RuntimeError(
        "OUTPUT_POLICY_VIOLATION",
        `Output policy for tool '${tool.name}' must return synchronously`,
      );
    }
    const text = serializeOutput(
      tool.name,
      projected,
      this.options.maxResponseBytes,
    );
    const tokenizer = this.options.tokenizer;
    if (policy.maxTokens === undefined) {
      // Without a budget, projection is still mandatory. Measurement remains
      // best-effort telemetry and runs after the cache write, like a tool that
      // does not opt into projection.
      return { result: projected };
    }
    if (tokenizer === undefined) {
      // Registration rejects this combination; fail closed on the call path.
      throw new RuntimeError(
        "OUTPUT_POLICY_VIOLATION",
        `Tool '${tool.name}' declares a token budget but no tokenizer is configured`,
      );
    }
    let count: number;
    try {
      count = tokenizer.count(text);
    } catch (error) {
      throw new RuntimeError(
        "OUTPUT_POLICY_VIOLATION",
        `Token counting for tool '${tool.name}' failed`,
        { cause: error },
      );
    }
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new RuntimeError(
        "OUTPUT_POLICY_VIOLATION",
        `Token counting for tool '${tool.name}' returned an invalid count`,
      );
    }
    if (count > policy.maxTokens) {
      throw new RuntimeError(
        "OUTPUT_LIMIT_EXCEEDED",
        `Tool '${tool.name}' output exceeds the token budget`,
      );
    }
    return {
      result: projected,
      tokenUsage: {
        count,
        measurement: tokenizer.measurement,
        tokenizer: tokenizer.id,
        payloadBytes: Buffer.byteLength(text, "utf8"),
      },
    };
  }

  /**
   * Measures the serialized result the MCP adapter will present to the model.
   * Returns `undefined` when no tokenizer is configured, the value has no JSON
   * representation, the adapter throws, or the adapter returns a count that is
   * not a non-negative safe integer. Measurement never changes the result.
   */
  private measureTokens(value: unknown): RuntimeEvent["tokenUsage"] {
    const tokenizer = this.options.tokenizer;
    if (tokenizer === undefined) return undefined;
    try {
      const maxBytes = this.options.maxResponseBytes;
      const text =
        maxBytes !== undefined
          ? stringifyBounded(value, { maxBytes })
          : JSON.stringify(value);
      if (text === undefined) return undefined;
      return tryMeasureSerialized(tokenizer, text);
    } catch {
      return undefined;
    }
  }

  /**
   * Resolves a tool against the caller identity (ADR 0008). Tenant binding
   * runs in the authorization stage before any adapter, so a cross-tenant
   * call can neither probe input schemas nor reach an executor. In
   * multi-tenant mode an unauthorized tool does not resolve at all, which
   * keeps a cross-tenant call indistinguishable from an unknown tool. The
   * `markUnresolved` callback lets `callTool` suppress the invocation metric
   * for that miss, matching the established unknown-tool behavior.
   */
  private resolveTool(
    name: string,
    context: ToolContext,
    markUnresolved: () => void,
  ): ToolDefinition {
    if (this.tenantMode === "single-tenant") {
      const tool = this.names.get(name);
      if (tool) return tool;
      markUnresolved();
      throw new RuntimeError("TOOL_NOT_FOUND", `Tool '${name}' was not found`);
    }
    const tenantId = context?.tenantId;
    if (typeof tenantId !== "string" || tenantId.trim().length === 0) {
      throw new RuntimeError(
        "TENANT_REQUIRED",
        "Tenant context required to invoke tools in multi-tenant mode",
      );
    }
    const tool = this.tenantTools.get(tenantId)?.get(name);
    if (tool) return tool;
    markUnresolved();
    throw new RuntimeError("TOOL_NOT_FOUND", `Tool '${name}' was not found`);
  }
}

type InvocationStage =
  | "context"
  | "authorization"
  | "validation"
  | "rate_limit"
  | "cache"
  | "execution"
  | "projection";

function tryCreateCacheKey(
  cache: RuntimeCacheOptions,
  tool: ToolDefinition,
  contractRevision: string,
  input: unknown,
  context: ToolContext,
): string | undefined {
  try {
    // A missing or ambiguous partition disables caching for this call rather
    // than sharing an entry across authorization contexts (ADR 0003).
    const partition = cache.authorizationPartition(context, tool);
    if (!isNonEmptyTrimmedString(partition)) return undefined;
    return createCacheKey({
      tenantId: context.tenantId,
      principalId: context.principal.id,
      authorizationPartition: partition,
      contractRevision,
      toolName: tool.name,
      arguments: input,
    });
  } catch {
    // Input that cannot be canonicalized, or a partition adapter failure,
    // degrades to a miss. It must not fail the tool call or bypass the stages
    // that already ran.
    return undefined;
  }
}

type CacheLookup =
  { status: "hit"; value: unknown } | { status: "miss" } | { status: "bypass" };

async function readCached(
  store: CacheStore,
  key: string,
): Promise<CacheLookup> {
  try {
    const value = await store.get<unknown>(key);
    return value === undefined ? { status: "miss" } : { status: "hit", value };
  } catch {
    // A store outage cannot produce a hit, so report it as a bypass rather
    // than a miss; neither case changes the tool result.
    return { status: "bypass" };
  }
}

async function writeCached(
  store: CacheStore,
  key: string,
  value: unknown,
  ttlSeconds: number,
): Promise<void> {
  try {
    await store.set(key, value, ttlSeconds);
  } catch {
    // A failed write must not fail the invocation or alter its result.
  }
}

function classifyFailure(
  toolName: string,
  stage: InvocationStage,
  error: unknown,
  rateLimitDenied: boolean,
): { error: RuntimeError; outcome: RuntimeEvent["outcome"] } {
  if (rateLimitDenied) {
    return {
      error:
        error instanceof RuntimeError
          ? error
          : new RuntimeError("RATE_LIMITED", "Rate limit exceeded", {
              cause: error,
            }),
      outcome: "rate_limited",
    };
  }
  if (stage === "rate_limit") {
    // Denial is expressed by a decision, not by an exception. A thrown
    // RATE_LIMITED would make the metric depend on adapter error-code
    // conventions, so treat every thrown error from the limiter as a failure.
    if (error instanceof RuntimeError && error.code !== "RATE_LIMITED") {
      return { error, outcome: "error" };
    }
    return {
      error: new RuntimeError(
        "UPSTREAM_FAILURE",
        `Rate limiter for tool '${toolName}' failed`,
        { cause: error },
      ),
      outcome: "error",
    };
  }
  if (error instanceof RuntimeError) {
    // Typed adapter failures keep their code in every stage, including
    // identity resolution: an identity-provider outage must not be reported
    // as a policy denial (ADR 0006, ADR 0008).
    return { error, outcome: "error" };
  }
  if (stage === "authorization" || stage === "context") {
    // An adapter that throws anything other than a typed RuntimeError is
    // treated as a denial: fail closed, keep the cause for diagnostics, and do
    // not expose adapter details to the caller.
    return {
      error: new RuntimeError("AUTH_FORBIDDEN", "Access denied", {
        cause: error,
      }),
      outcome: "error",
    };
  }
  return {
    error: new RuntimeError("UPSTREAM_FAILURE", `Tool '${toolName}' failed`, {
      cause: error,
    }),
    outcome: "error",
  };
}

function assertSupportedInputSchema(schema: unknown): void {
  const [diagnostic] = auditInputSchema(schema).diagnostics;
  if (diagnostic) {
    throw new RuntimeError("CONTRACT_INVALID", diagnostic.message);
  }
}

function assertCacheMetadata(tool: ToolDefinition): void {
  if (
    tool.contractRevision !== undefined &&
    !isNonEmptyTrimmedString(tool.contractRevision)
  ) {
    throw new RuntimeError(
      "CONTRACT_INVALID",
      `Tool '${tool.name}' must declare a non-empty contractRevision`,
    );
  }
  if (tool.cache === undefined) return;
  if (
    typeof tool.cache !== "object" ||
    tool.cache === null ||
    !Number.isFinite(tool.cache.ttlSeconds) ||
    tool.cache.ttlSeconds <= 0
  ) {
    throw new RuntimeError(
      "CONTRACT_INVALID",
      `Tool '${tool.name}' must declare a positive finite cache ttlSeconds`,
    );
  }
  if (!isNonEmptyTrimmedString(tool.contractRevision)) {
    throw new RuntimeError(
      "CONTRACT_INVALID",
      `Cacheable tool '${tool.name}' must declare a non-empty contractRevision`,
    );
  }
}

/**
 * Output policy is opt-in per tool, but an opt-in that the runtime cannot
 * enforce is a configuration error, not a silent no-op. Registration therefore
 * requires a projector for any declared policy and a tokenizer for any budget.
 */
function assertOutputMetadata(
  tool: ToolDefinition,
  options: RuntimeOptions,
): void {
  if (tool.output === undefined) return;
  if (typeof tool.output !== "object" || tool.output === null) {
    throw new RuntimeError(
      "CONTRACT_INVALID",
      `Tool '${tool.name}' must declare an output policy object`,
    );
  }
  const maxTokens = tool.output.maxTokens;
  if (
    maxTokens !== undefined &&
    (!Number.isSafeInteger(maxTokens) || maxTokens <= 0)
  ) {
    throw new RuntimeError(
      "CONTRACT_INVALID",
      `Tool '${tool.name}' must declare a positive integer output maxTokens`,
    );
  }
  if (tool.output.fields !== undefined) {
    try {
      assertFieldSelection(tool.output.fields);
    } catch (error) {
      throw new RuntimeError(
        "CONTRACT_INVALID",
        `Tool '${tool.name}' has an invalid field selection: ${
          error instanceof Error ? error.message : "invalid selection"
        }`,
        { cause: error },
      );
    }
  }
  if (options.projector === undefined) {
    throw new RuntimeError(
      "CONTRACT_INVALID",
      `Tool '${tool.name}' declares an output policy but the runtime has no projector`,
    );
  }
  if (maxTokens !== undefined && options.tokenizer === undefined) {
    throw new RuntimeError(
      "CONTRACT_INVALID",
      `Tool '${tool.name}' declares an output token budget but the runtime has no tokenizer`,
    );
  }
}

/**
 * The projected value is what the caller and model may receive, so it must
 * have a JSON representation. `undefined` and cyclic values fail closed instead
 * of being cached or silently converted by a transport.
 */
function isThenable(value: unknown): boolean {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function")
  ) {
    return false;
  }
  try {
    return typeof (value as { then?: unknown }).then === "function";
  } catch {
    // An unreadable `then` would also make serialization unpredictable.
    return true;
  }
}

function serializeOutput(
  toolName: string,
  value: unknown,
  maxBytes?: number,
): string {
  let text: string | undefined;
  try {
    text =
      maxBytes !== undefined
        ? stringifyBounded(value, { maxBytes })
        : JSON.stringify(value);
  } catch (error) {
    if (error instanceof SerializationLimitError) {
      throw new RuntimeError(
        "OUTPUT_LIMIT_EXCEEDED",
        `Tool '${toolName}' output exceeded the limit of ${maxBytes} bytes (observed at least ${error.observedBytes} bytes)`,
        { cause: error },
      );
    }
    throw new RuntimeError(
      "OUTPUT_POLICY_VIOLATION",
      `Output policy for tool '${toolName}' returned an unserializable result`,
      { cause: error },
    );
  }
  if (text === undefined) {
    throw new RuntimeError(
      "OUTPUT_POLICY_VIOLATION",
      `Output policy for tool '${toolName}' returned a result without a JSON representation`,
    );
  }
  return text;
}

function assertInputSize(
  toolName: string,
  input: unknown,
  maxBytes: number,
): void {
  try {
    stringifyBounded(input, { maxBytes });
  } catch (error) {
    if (error instanceof SerializationLimitError) {
      throw new RuntimeError(
        "INPUT_TOO_LARGE",
        `Tool '${toolName}' input exceeds the limit of ${maxBytes} bytes (observed at least ${error.observedBytes} bytes)`,
        { cause: error },
      );
    }
    throw new RuntimeError(
      "INPUT_INVALID",
      `Tool '${toolName}' input could not be serialized for size validation`,
      { cause: error },
    );
  }
}

function tryMeasureSerialized(
  tokenizer: Tokenizer,
  text: string,
): RuntimeEvent["tokenUsage"] {
  try {
    const count = tokenizer.count(text);
    if (!Number.isSafeInteger(count) || count < 0) return undefined;
    return {
      count,
      measurement: tokenizer.measurement,
      tokenizer: tokenizer.id,
      payloadBytes: Buffer.byteLength(text, "utf8"),
    };
  } catch {
    return undefined;
  }
}

/** Tenant identifiers are trusted adapter data and must at least be non-empty. */
function isNonEmptyTenantId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNonEmptyTrimmedString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Upper bound on the number of issues collected for one call. Without a bound,
 * an adversarial input such as a large invalid array produces one message per
 * element, which is then serialized into the client-facing error message.
 */
const MAX_VALIDATION_ISSUES = 20;

interface ValidationState {
  readonly issues: string[];
  readonly maxIssues: number;
  truncated: boolean;
}

export interface SchemaValidationResult {
  readonly valid: boolean;
  readonly issues: readonly string[];
}

export function validateJsonSchema(
  schema: JsonSchema,
  value: unknown,
  maxIssues = MAX_VALIDATION_ISSUES,
): SchemaValidationResult {
  const state: ValidationState = {
    issues: [],
    maxIssues,
    truncated: false,
  };
  validateValue(schema, value, "$", state, 0);
  const issues = state.truncated
    ? [...state.issues, `further issues omitted after ${state.maxIssues}`]
    : state.issues;
  return {
    valid: issues.length === 0,
    issues,
  };
}

function validateInput(schema: JsonSchema, input: unknown): void {
  const result = validateJsonSchema(schema, input);
  if (result.valid) return;
  throw new RuntimeError(
    "INPUT_INVALID",
    `Input does not match schema: ${result.issues.join("; ")}`,
  );
}

function addIssue(state: ValidationState, message: string): void {
  if (state.issues.length < state.maxIssues) state.issues.push(message);
  else state.truncated = true;
}

function validateValue(
  schema: JsonSchema,
  value: unknown,
  path: string,
  state: ValidationState,
  depth: number,
): void {
  if (depth > MAX_SCHEMA_DEPTH) {
    addIssue(
      state,
      `${path} exceeds the maximum validation depth of ${MAX_SCHEMA_DEPTH}`,
    );
    return;
  }
  const type = schema.type;
  if (!matchesTypeDeclaration(type, value)) {
    addIssue(state, `${path} must be ${describeTypeDeclaration(type)}`);
    return;
  }
  if (
    Array.isArray(schema.enum) &&
    !schema.enum.some((item) => Object.is(item, value))
  ) {
    addIssue(state, `${path} must be one of the allowed values`);
  }
  if (typeof value === "string") {
    validateStringConstraints(schema, value, path, state);
  }
  if (typeof value === "number") {
    validateNumberConstraints(schema, value, path, state);
  }
  if (isJsonObject(value)) {
    const properties = isJsonObject(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    const propertyCount = Object.keys(value).length;
    if (
      typeof schema.minProperties === "number" &&
      propertyCount < schema.minProperties
    ) {
      addIssue(
        state,
        `${path} must have at least ${schema.minProperties} properties`,
      );
    }
    if (
      typeof schema.maxProperties === "number" &&
      propertyCount > schema.maxProperties
    ) {
      addIssue(
        state,
        `${path} must have at most ${schema.maxProperties} properties`,
      );
    }
    for (const key of required) {
      // Own-property checks only. An `in` test would accept inherited names
      // such as 'toString', so a caller could satisfy `required` with nothing.
      if (typeof key === "string" && !Object.hasOwn(value, key)) {
        addIssue(state, `${path}.${key} is required`);
      }
    }
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (Object.hasOwn(value, key) && isJsonObject(propertySchema)) {
        validateValue(
          propertySchema,
          value[key],
          `${path}.${key}`,
          state,
          depth + 1,
        );
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        // `in` would treat inherited Object.prototype names as declared
        // properties and let undeclared keys such as 'toString' through.
        if (!Object.hasOwn(properties, key)) {
          addIssue(state, `${path}.${key} is not allowed`);
        }
      }
    }
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      addIssue(state, `${path} must have at least ${schema.minItems} items`);
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      addIssue(state, `${path} must have at most ${schema.maxItems} items`);
    }
    if (schema.uniqueItems === true) {
      const seen = new Set<string>();
      for (const item of value) {
        const key = stableValueKey(item);
        if (key === undefined) {
          addIssue(
            state,
            `${path} contains a value that is too complex to compare for uniqueness`,
          );
          break;
        }
        if (seen.has(key)) {
          addIssue(state, `${path} must contain unique items`);
          break;
        }
        seen.add(key);
      }
    }
    if (isJsonObject(schema.items)) {
      value.forEach((item, index) =>
        validateValue(
          schema.items as JsonSchema,
          item,
          `${path}[${index}]`,
          state,
          depth + 1,
        ),
      );
    }
  }
}

function validateStringConstraints(
  schema: JsonSchema,
  value: string,
  path: string,
  state: ValidationState,
): void {
  const length = codePointLength(value);
  if (typeof schema.minLength === "number" && length < schema.minLength) {
    addIssue(state, `${path} must be at least ${schema.minLength} characters`);
  }
  if (typeof schema.maxLength === "number" && length > schema.maxLength) {
    addIssue(state, `${path} must be at most ${schema.maxLength} characters`);
  }
  if (
    typeof schema.pattern === "string" &&
    !patternMatches(schema.pattern, value)
  ) {
    addIssue(state, `${path} must match pattern '${schema.pattern}'`);
  }
  if (
    typeof schema.format === "string" &&
    isAssertedFormat(schema.format) &&
    !matchesFormat(schema.format, value)
  ) {
    addIssue(state, `${path} must match format '${schema.format}'`);
  }
}

function validateNumberConstraints(
  schema: JsonSchema,
  value: number,
  path: string,
  state: ValidationState,
): void {
  if (typeof schema.minimum === "number" && value < schema.minimum) {
    addIssue(
      state,
      `${path} must be greater than or equal to ${schema.minimum}`,
    );
  }
  if (typeof schema.maximum === "number" && value > schema.maximum) {
    addIssue(state, `${path} must be less than or equal to ${schema.maximum}`);
  }
  if (
    typeof schema.exclusiveMinimum === "number" &&
    value <= schema.exclusiveMinimum
  ) {
    addIssue(state, `${path} must be greater than ${schema.exclusiveMinimum}`);
  }
  if (
    typeof schema.exclusiveMaximum === "number" &&
    value >= schema.exclusiveMaximum
  ) {
    addIssue(state, `${path} must be less than ${schema.exclusiveMaximum}`);
  }
  if (
    typeof schema.multipleOf === "number" &&
    !isMultipleOf(value, schema.multipleOf)
  ) {
    addIssue(state, `${path} must be a multiple of ${schema.multipleOf}`);
  }
}

function codePointLength(value: string): number {
  let length = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.codePointAt(index);
    if (codePoint !== undefined && codePoint > 0xffff) index += 1;
    length += 1;
  }
  return length;
}

function isMultipleOf(value: number, multiple: number): boolean {
  if (!Number.isFinite(value) || !Number.isFinite(multiple) || multiple <= 0) {
    return false;
  }
  const quotient = value / multiple;
  if (!Number.isFinite(quotient)) return false;
  const nearest = Math.round(quotient);
  const tolerance = Math.min(
    1e-9,
    Number.EPSILON * Math.max(1, Math.abs(quotient)) * 8,
  );
  return Math.abs(quotient - nearest) <= tolerance;
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
  /** Stable, non-secret partition for effective grants and policy state. */
  authorizationPartition: string;
  contractRevision: string;
  toolName: string;
  arguments: unknown;
}): string {
  for (const [field, value] of Object.entries({
    tenantId: parts.tenantId,
    principalId: parts.principalId,
    authorizationPartition: parts.authorizationPartition,
    contractRevision: parts.contractRevision,
    toolName: parts.toolName,
  })) {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new TypeError(`A non-empty ${field} is required`);
    }
  }
  const payload = JSON.stringify([
    parts.tenantId,
    parts.principalId,
    parts.authorizationPartition,
    parts.contractRevision,
    parts.toolName,
    canonicalize(parts.arguments, new Set()),
  ]);
  if (Buffer.byteLength(payload, "utf8") > MAX_CACHE_KEY_INPUT_BYTES) {
    throw new TypeError(
      `Cache key input exceeds the maximum of ${MAX_CACHE_KEY_INPUT_BYTES} bytes`,
    );
  }
  const digest = createHash("sha256")
    .update(cacheKeyHashDomain(), "utf8")
    .update(payload, "utf8")
    .digest("hex");
  return `${cacheKeyPrefix()}${digest}`;
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
        return Array.from(value, (item) => {
          if (item === undefined) {
            throw new TypeError(
              "Cache key arguments cannot contain undefined array items",
            );
          }
          return canonicalize(item, ancestors);
        });
      }
      if (
        !isJsonObject(value) ||
        Object.getOwnPropertySymbols(value).length > 0
      ) {
        throw new TypeError(
          "Cache key arguments must be plain JSON-compatible data",
        );
      }
      const canonical: Array<[string, unknown]> = [];
      for (const key of Object.keys(value).sort()) {
        const property = value[key];
        if (property === undefined) continue;
        canonical.push([key, canonicalize(property, ancestors)]);
      }
      return Object.fromEntries(canonical);
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

export {
  assertJsonCacheValue,
  DEFAULT_CACHE_MAX_ENTRY_BYTES,
  DEFAULT_CACHE_MAX_TTL_SECONDS,
  InMemoryCacheStore,
} from "./cache.js";
export type { InMemoryCacheStoreOptions } from "./cache.js";
export { isCurrentCacheKey } from "./cache-key.js";
export {
  assertFieldSelection,
  createFieldProjector,
  FieldSelectionError,
  MAX_FIELD_PATHS,
  MAX_FIELD_PATH_DEPTH,
  MAX_FIELD_PATH_LENGTH,
  MAX_FIELD_PROJECTION_DEPTH,
  MAX_FIELD_PROJECTION_NODES,
} from "./field-projection.js";
export type { FieldSelection } from "./field-projection.js";

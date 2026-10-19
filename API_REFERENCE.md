# API Reference

This document defines the intended public package contracts. Implementations must update it whenever exported behavior changes.

## `@chainmcp/core`

### Principal

```ts
export interface Principal {
  id: string;
  scopes: readonly string[];
  attributes?: Readonly<Record<string, string>>;
}
```

`id` must be a stable, non-secret identifier within the applicable identity provider or tenant context. The current core package treats contexts as trusted adapter input.

### Tool context

```ts
export interface ToolContext {
  requestId: string;
  tenantId: string;
  principal: Principal;
  signal?: AbortSignal;
}
```

Context is established by trusted runtime adapters, not accepted wholesale from tool arguments.

#### Timeout and cancellation semantics

The runtime creates a per-call `AbortController`. It aborts that controller when `context.signal` aborts or the per-tool/default timeout elapses, and rejects the call with `CANCELLED` or `UPSTREAM_TIMEOUT` respectively. This is cooperative: aborting the signal stops the runtime waiting, but it does not forcibly terminate `execute`, cancel work inside the tool, or release resources the tool has acquired.

`execute` implementations and upstream executor adapters are responsible for:

- Observing `context.signal` and binding it to abortable operations, such as `fetch` or an HTTP client.
- Cancelling timers, streams, database work, and other resources in `finally`.
- Tolerating late settlement after the runtime has already rejected the call.

A tool that ignores the signal may continue running after the caller has been rejected. Callers must not treat `CANCELLED` or `UPSTREAM_TIMEOUT` as proof that upstream work has stopped or resources have been released.

### Tool definition

```ts
export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  operation: OperationPolicy;
  execute(input: TInput, context: ToolContext): Promise<TOutput>;
}
```

`@chainmcp/core` currently provides `InMemoryToolRuntime`, which validates a documented JSON Schema subset, invokes an optional `Authorizer`, then an optional `RateLimiter`, and executes the tool. `RateLimiter.check` returns an explicit decision; only a denial is counted as rate limiting. Cancellation is cooperative: the runtime aborts a per-call signal and stops waiting on caller cancellation or timeout, but executors must bind that signal to their own abortable I/O and release resources. Calls have a 15-second default timeout, configurable through `RuntimeOptions.defaultTimeoutMs` or per tool. Cache interfaces are defined, but cache reads/writes are not integrated into invocation. Metrics failures are ignored so they do not change tool results.

The validator supports `type` (a string or non-empty array of strings), primitive `enum`, `required`, `properties`, boolean `additionalProperties`, and object-form `items`. Object keywords (`required`, `properties`, `additionalProperties`) and array `items` are enforced whenever the value has the corresponding JSON kind, including schemas that omit `type`. `additionalProperties` defaults to `true`, so unknown object keys are passed to `execute` untouched; tool implementations must treat them as untrusted input.

Unsupported validation constructs are rejected at registration with `CONTRACT_INVALID` rather than silently ignored. This includes `$ref`, `anyOf`/`oneOf`/`allOf`, `const`, `not`, numeric/length/array bounds, `pattern`, `format`, `patternProperties`, `propertyNames`, boolean schemas, and tuple or boolean `items`. Schemas are limited to 32 levels of nesting and may not contain cycles. Annotation keywords (`title`, `description`, `default`, `examples`, `deprecated`, `readOnly`, `writeOnly`, `$comment`) are accepted and ignored. Other JSON Schema keywords are not enforced and must not be relied on.

### Schema audit

The audit used at registration is exported so the compiler can reject the same constructs before generating tools:

```ts
export type SchemaDiagnosticCode =
  | "SCHEMA_NOT_OBJECT"
  | "SCHEMA_UNSUPPORTED_KEYWORD"
  | "SCHEMA_INVALID_TYPE"
  | "SCHEMA_INVALID_ENUM"
  | "SCHEMA_INVALID_REQUIRED"
  | "SCHEMA_INVALID_PROPERTIES"
  | "SCHEMA_INVALID_ADDITIONAL_PROPERTIES"
  | "SCHEMA_INVALID_ITEMS"
  | "SCHEMA_CYCLE"
  | "SCHEMA_TOO_DEEP";

export interface SchemaDiagnostic {
  code: SchemaDiagnosticCode;
  path: string;
  message: string;
}

export interface SchemaAuditResult {
  supported: boolean;
  diagnostics: readonly SchemaDiagnostic[];
}

export const MAX_SCHEMA_DEPTH = 32;

export function auditInputSchema(schema: unknown): SchemaAuditResult;
```

`auditInputSchema` does not throw for schema content; it collects every finding with a stable code, JSON-path-like `path`, and message. `InMemoryToolRuntime.register` throws `RuntimeError("CONTRACT_INVALID", diagnostics[0].message)` when the result is unsupported, so runtime and compiler diagnostics share the same messages.

Compilers must map each diagnostic to a compile diagnostic and refuse to emit tools when any error-level diagnostic remains:

```ts
const audit = auditInputSchema(schema);
const diagnostics = audit.diagnostics.map((diagnostic) => ({
  severity: "error" as const,
  code: diagnostic.code,
  message: diagnostic.message,
  location: diagnostic.path,
}));
```

### Tool runtime

```ts
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
```

Duplicate names must fail explicitly. Unknown tool calls must return a stable error code.

`RuntimeError` currently includes `TOOL_NOT_FOUND`, `TOOL_ALREADY_REGISTERED`, `CONTRACT_INVALID` (registration-time schema rejection), `INPUT_INVALID`, `AUTH_FORBIDDEN`, `RATE_LIMITED`, `CANCELLED`, `UPSTREAM_TIMEOUT`, and `UPSTREAM_FAILURE`. The runtime does not implement a concrete authorization or rate-limit policy.

Failures are classified by invocation stage:

| Stage         | Adapter outcome                            | Runtime result                                                          |
| ------------- | ------------------------------------------ | ----------------------------------------------------------------------- |
| Authorization | throws `RuntimeError`                      | Preserved, including its code and safe message.                         |
| Authorization | throws anything else                       | `AUTH_FORBIDDEN` with the safe message `Access denied`; cause retained. |
| Validation    | schema mismatch                            | `INPUT_INVALID`.                                                        |
| Rate limiting | returns `{ allowed: false }`               | `RATE_LIMITED`.                                                         |
| Rate limiting | returns no decision or a malformed one     | `UPSTREAM_FAILURE`; the call is not allowed.                            |
| Rate limiting | throws `RuntimeError` (not `RATE_LIMITED`) | Preserved.                                                              |
| Rate limiting | throws `RATE_LIMITED` or anything else     | `UPSTREAM_FAILURE` with a limiter-failure message; cause retained.      |
| Execution     | throws `RuntimeError`                      | Preserved.                                                              |
| Execution     | throws anything else                       | `UPSTREAM_FAILURE` with `Tool '<name>' failed`; cause retained.         |

Causes are retained for protected diagnostics and are never included in the client message or in `RuntimeEvent`. Authorization runs before validation so an unauthorized caller cannot probe the tool schema.

### Authorization and rate limiting

```ts
export interface Authorizer {
  authorize(tool: ToolDefinition, context: ToolContext): void | Promise<void>;
}

export interface RateLimitDecision {
  allowed: boolean;
}

export interface RateLimiter {
  check(
    context: ToolContext,
    toolName: string,
  ): RateLimitDecision | Promise<RateLimitDecision>;
}
```

`authorize` returns normally to allow the call. Throw `RuntimeError("AUTH_FORBIDDEN", ...)` for a policy denial. Throw another `RuntimeError` to report an authorization-stage failure with a distinct code, for example `UPSTREAM_FAILURE` when an identity provider is unavailable. Any other thrown value is treated as a denial and fails closed; this covers adapters that naturally throw a plain `Error` to reject a call.

`check` must return a decision. `{ allowed: false }` denies the call. A missing or malformed decision fails closed as `UPSTREAM_FAILURE`; it does not silently allow the call. Throwing is reserved for limiter failures, not denials. A thrown `RuntimeError` other than `RATE_LIMITED` is preserved; any other throw, including `RATE_LIMITED`, becomes `UPSTREAM_FAILURE`. This keeps the `rate_limited` metrics outcome independent of adapter error-code conventions: only an explicit denial can produce it.

`createCacheKey` returns an opaque, fixed-length key of the form `chainmcp:cache:v1:<64 lowercase hex characters>`. It canonicalizes plain JSON-compatible argument values and hashes the tenant, principal, contract revision, tool identity, and arguments with SHA-256 under a versioned domain separator. Object properties whose value is `undefined` are omitted; `undefined` at the root or in arrays, sparse arrays, cycles, non-finite numbers, and non-JSON values are rejected. Canonical input is limited to `MAX_CACHE_KEY_INPUT_BYTES` (64 KiB); larger inputs throw `TypeError`. Changing canonicalization, hashed fields, or digest semantics requires incrementing `CACHE_KEY_VERSION`, which changes the key prefix and deliberately invalidates the existing key space. Hashing reduces accidental disclosure but is not encryption; protect the cache store and do not treat keys as secrets.

```ts
export const CACHE_KEY_VERSION = "v1";
export const MAX_CACHE_KEY_INPUT_BYTES = 64 * 1024;

export function createCacheKey(parts: {
  tenantId: string;
  principalId: string;
  contractRevision: string;
  toolName: string;
  arguments: unknown;
}): string;
```

## Cache interface

```ts
export interface CacheStore {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T, ttlSeconds: number): Promise<void>;
  delete(key: string): Promise<void>;
}
```

Adapters must enforce bounded TTLs and entry sizes. Shared caches must partition data by tenant and authorization context.

## Metrics interface

The implemented Milestone 1 event is:

```ts
export type RuntimeEvent = {
  name: "tool_invocation";
  timestamp: number;
  durationMs: number;
  tenantId: string;
  toolName: string;
  outcome: "success" | "error" | "rate_limited";
  errorCode?: RuntimeErrorCode;
};

export interface MetricsSink {
  record(event: RuntimeEvent): void | Promise<void>;
}
```

The runtime emits one event for every `callTool` that finds a registered tool, regardless of success or failure. Calls rejected with `TOOL_NOT_FOUND` are thrown before the event is created and do not emit one. `timestamp` and `durationMs` use the injected clock.

`outcome` is `success` when execution resolves, `rate_limited` only when the configured `RateLimiter` returns `{ allowed: false }`, and `error` for every other failure, including authorization failures, validation failures, limiter failures, timeouts, cancellations, and upstream errors. `errorCode` is present on failures and is the final `RuntimeErrorCode`. A `RATE_LIMITED` error reported by an executor is preserved as `errorCode` but has outcome `error`, because the runtime rate limiter did not deny the call.

The earlier target shape included `outcome: "cache_hit"` and optional `durationMs`, `tenantId`, `toolName`, `tokenCount`, and `attributes`. Those fields are not implemented in Milestone 1. `cache_hit` depends on cache integration (Milestone 4), `tokenCount` depends on token accounting (Milestone 4), and `attributes` plus the optional-field relaxation depend on analytics and redaction work (Milestone 6). Adapters must not assume they exist.

`MetricsSink.record` is invoked after the call settles. Synchronous throws and rejected promises are ignored so telemetry cannot change the tool result. Events must not contain secrets, raw authorization data, or unrestricted request and response bodies.

## Compiler interface

The planned compiler API is:

```ts
export interface CompileOptions {
  strict?: boolean;
  includeDeprecated?: boolean;
}

export interface CompileDiagnostic {
  severity: "error" | "warning";
  code: string;
  message: string;
  location?: string;
}

export interface CompileResult {
  tools: ToolDefinition[];
  diagnostics: CompileDiagnostic[];
  sourceHash: string;
}

export interface ContractCompiler {
  compile(source: string, options?: CompileOptions): Promise<CompileResult>;
}
```

The final compiler contract must be validated against the actual parser and schema support.

## Error codes

Public-facing errors use stable codes such as:

- `CONFIG_INVALID`
- `CONTRACT_INVALID`
- `TOOL_NOT_FOUND`
- `INPUT_INVALID`
- `AUTH_REQUIRED`
- `AUTH_FORBIDDEN`
- `RATE_LIMITED`
- `UPSTREAM_TIMEOUT`
- `UPSTREAM_FAILURE`
- `RESPONSE_TOO_LARGE`
- `POLICY_DENIED`

Never expose stack traces or credential values to MCP clients.

## Compatibility

Public APIs are subject to Semantic Versioning once stable. Before version 1.0, breaking changes must be documented in `CHANGELOG.md`.

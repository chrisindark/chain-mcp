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

`@chainmcp/core` currently provides `InMemoryToolRuntime`, which validates a documented JSON Schema subset, invokes an optional `Authorizer`, then an optional `RateLimiter`, and executes the tool. Cancellation is cooperative: the runtime aborts a per-call signal and stops waiting on caller cancellation or timeout, but executors must bind that signal to their own abortable I/O and release resources. Calls have a 15-second default timeout, configurable through `RuntimeOptions.defaultTimeoutMs` or per tool. Cache and metrics interfaces are defined, but cache reads/writes are not integrated into invocation. Metrics failures are ignored so they do not change tool results.

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

`RuntimeError` currently includes `TOOL_NOT_FOUND`, `TOOL_ALREADY_REGISTERED`, `CONTRACT_INVALID` (registration-time schema rejection), `INPUT_INVALID`, `AUTH_FORBIDDEN`, `RATE_LIMITED`, `CANCELLED`, `UPSTREAM_TIMEOUT`, and `UPSTREAM_FAILURE`. Authorization and rate-limit adapters should throw `RuntimeError` for stable errors. The runtime does not implement a concrete authorization or rate-limit policy. Unrecognized failures are wrapped in a generic `UPSTREAM_FAILURE`; their cause is retained for protected diagnostics, not included in the client message.

`createCacheKey` canonicalizes plain JSON-compatible argument values and includes tenant, principal, contract revision, and tool identity. It rejects cycles, non-finite numbers, and non-JSON values. It does not hash or encrypt the result; callers must treat the key as potentially revealing its encoded components and use an appropriate store.

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

```ts
export interface RuntimeEvent {
  name: string;
  timestamp: number;
  durationMs?: number;
  tenantId?: string;
  toolName?: string;
  outcome: "success" | "error" | "rate_limited" | "cache_hit";
  tokenCount?: number;
  attributes?: Record<string, string | number | boolean>;
}

export interface MetricsSink {
  record(event: RuntimeEvent): void | Promise<void>;
}
```

Attributes must not contain secrets, raw authorization data, or unrestricted request and response bodies.

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

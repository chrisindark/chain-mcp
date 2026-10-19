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

`@chainmcp/core` currently provides `InMemoryToolRuntime`, which validates a documented JSON Schema subset, invokes an optional `Authorizer`, then an optional `RateLimiter`, and executes the tool. Cancellation is passed through an `AbortSignal`; calls have a 15-second default timeout, configurable through `RuntimeOptions.defaultTimeoutMs` or per tool. Cache and metrics interfaces are defined, but cache reads/writes are not integrated into invocation. Metrics failures are ignored so they do not change tool results.

The validator currently supports `type`, primitive `enum`, required properties, nested object properties, `additionalProperties: false`, and array items. Other JSON Schema keywords are not enforced and must not be relied on. Unknown schema types reject all nonmatching values; use only the listed subset.

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

`RuntimeError` currently includes `TOOL_NOT_FOUND`, `TOOL_ALREADY_REGISTERED`, `INPUT_INVALID`, `AUTH_FORBIDDEN`, `RATE_LIMITED`, `CANCELLED`, `UPSTREAM_TIMEOUT`, and `UPSTREAM_FAILURE`. Authorization and rate-limit adapters should throw `RuntimeError` for stable errors. The runtime does not implement a concrete authorization or rate-limit policy. Unrecognized failures are wrapped in a generic `UPSTREAM_FAILURE`; their cause is retained for protected diagnostics, not included in the client message.

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

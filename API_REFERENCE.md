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

export type ToolContextFactory = () => ToolContext | Promise<ToolContext>;
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
export interface ToolCachePolicy {
  ttlSeconds: number;
}

export interface ToolOutputPolicy {
  maxTokens?: number;
}

export interface ResultProjectionRequest {
  tool: ToolDefinition;
  context: ToolContext;
  result: unknown;
}

export interface ResultProjector {
  project(request: ResultProjectionRequest): unknown;
}

export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  operation: OperationPolicy;
  contractRevision?: string;
  cache?: ToolCachePolicy;
  output?: ToolOutputPolicy;
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
```

`ownerTenantId` binds the tool to a tenant at registration time (ADR 0008). In
multi-tenant mode the binding is required; in single-tenant mode an omitted
value is stamped with the deployment's pinned tenant (`RuntimeOptions.tenantId`),
and an explicit value must match that pin.

`cache` opts an idempotent read operation into result caching. It is absent by
default, so mutations are never cached implicitly. A cacheable tool must also
declare a non-empty `contractRevision`; registration rejects a missing,
blank, or non-finite TTL with `CONTRACT_INVALID`. Declaring `cache` does not
enable caching by itself: the runtime must also be constructed with
`RuntimeOptions.cache` (ADR 0010).

`output` opts a tool into output projection (built-in field rules or a
deployment-supplied projector) and an optional token budget. Presence of
`output` is the opt-in; `maxTokens` and `fields` are optional.
Registration requires the runtime to have a `ResultProjector` for any declared
output policy, and a `Tokenizer` when `maxTokens` is set. A missing projector,
missing tokenizer, or non-positive/non-integer `maxTokens` is
`CONTRACT_INVALID`, not a silent no-op (ADR 0012).

`@chainmcp/core` currently provides `InMemoryToolRuntime`, which validates a documented JSON Schema subset, invokes an optional `Authorizer`, then an optional `RateLimiter`, reads the cache for eligible tools, executes the tool, applies opt-in output projection and its token budget, writes the projected result to the cache, and measures it. `RateLimiter.check` returns an explicit decision; only a denial is counted as rate limiting. Cancellation is cooperative: the runtime aborts a per-call signal and stops waiting on caller cancellation or timeout, but executors must bind that signal to their own abortable I/O and release resources. Calls have a 15-second default timeout, configurable through `RuntimeOptions.defaultTimeoutMs` or per tool. `InMemoryCacheStore` is available as a bounded standalone adapter and can be supplied as the runtime cache store; caching still requires per-tool opt-in. Metrics failures are ignored so they do not change tool results.

The validator supports `type` (a string or non-empty array of strings), primitive `enum` (string, boolean, null, and finite number values), `required`, `properties`, boolean `additionalProperties`, object-form `items`, `minLength`/`maxLength`, `pattern`, `format`, `minimum`/`maximum`, `exclusiveMinimum`/`exclusiveMaximum`, `multipleOf`, `minItems`/`maxItems`, `uniqueItems`, `minProperties`, and `maxProperties`. Object keywords (`required`, `properties`, `additionalProperties`, `minProperties`, `maxProperties`) and array `items` are enforced whenever the value has the corresponding JSON kind, including schemas that omit `type`. `additionalProperties` defaults to `true`, so unknown object keys are passed to `execute` untouched; tool implementations must treat them as untrusted input. Keys are compared as own properties, so a key named after an `Object.prototype` member (for example `toString`, `constructor`, or `__proto__`) is treated as undeclared and cannot satisfy `required`. At most 20 issues are reported per call; the message ends with a truncation marker when more were found.

String lengths count Unicode code points. `pattern` is compiled with the linear-time `re2js` engine, not the backtracking JavaScript `RegExp` engine, so a contract pattern cannot trigger catastrophic backtracking. Patterns longer than 4,096 characters and patterns that RE2 cannot compile are rejected at registration. `uniqueItems` uses a deterministic structural comparison with a bounded depth and node budget; a value that exceeds the budget fails validation closed. Asserted formats are `date-time`, `date`, `time`, `email`, `hostname`, `ipv4`, `ipv6`, `uri`, and `uuid`; other format strings remain annotations and are not asserted.

Unsupported validation constructs are rejected at registration with `CONTRACT_INVALID` rather than silently ignored. This includes `$ref`, `anyOf`/`oneOf`/`allOf`, `const`, `not`, `patternProperties`, `propertyNames`, boolean schemas, and tuple or boolean `items`. Schemas are limited to 32 levels of nesting and may not contain cycles. Annotation keywords (`title`, `description`, `default`, `examples`, `deprecated`, `readOnly`, `writeOnly`, `$comment`) are accepted and ignored. Other JSON Schema keywords are not enforced and must not be relied on.

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
  | "SCHEMA_INVALID_CONSTRAINT"
  | "SCHEMA_INVALID_PATTERN"
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

export interface SchemaValidationResult {
  readonly valid: boolean;
  readonly issues: readonly string[];
}

export function validateJsonSchema(
  schema: JsonSchema,
  value: unknown,
  maxIssues?: number,
): SchemaValidationResult;

export interface BoundedStringifyOptions {
  maxBytes: number;
  maxDepth?: number;
  maxNodes?: number;
}

export class SerializationLimitError extends Error {
  readonly limitBytes: number;
  readonly observedBytes: number;
}

export function stringifyBounded(
  value: unknown,
  options: BoundedStringifyOptions,
): string;
```

`auditInputSchema` does not throw for schema content; it collects every finding with a stable code, JSON-path-like `path`, and message. `InMemoryToolRuntime.register` throws `RuntimeError("CONTRACT_INVALID", diagnostics[0].message)` when the result is unsupported, so runtime and compiler diagnostics share the same messages.

`validateJsonSchema` validates untrusted JSON values against a JSON Schema, returning a list of descriptive structural issues bounded to `maxIssues` (default 20).

`stringifyBounded` streams JSON serialization with depth, node count, and byte limit checks, aborting mid-traversal before full memory allocation if `maxBytes` is reached and rejecting circular references safely.

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
  readonly tenantMode: "single-tenant" | "multi-tenant";

  register(tool: ToolDefinition): void;
  registerSource(source: ToolSource): Promise<void>;

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

  invalidateCachedResult?(
    name: string,
    input: unknown,
    context: ToolContext,
  ): Promise<void>;
}
```

Duplicate names must fail explicitly. Unknown tool calls must return a stable error code.

The runtime is constructed in one of two tenancy modes (`RuntimeOptions.tenantMode`, defaulting to `single-tenant`):

- **Single-tenant** (generated servers and local stdio). Resolution and listing are name-keyed and unfiltered, matching Milestone 2 behavior. An optional `RuntimeOptions.tenantId` pins the deployment tenant: tools without `ownerTenantId` are stamped with it, tools bound to another tenant fail registration with `CONFIG_INVALID`, and calls whose `ToolContext.tenantId` differs from the pin are denied with `AUTH_FORBIDDEN` before adapters run and emit an invocation metric with that outcome. Without a pinned tenant, tenant identity is trusted adapter input with no per-call verification.
- **Multi-tenant** (dynamic gateway). The runtime must be constructed with an `Authorizer`; constructing it without one fails with `CONFIG_INVALID`. Every tool must declare a non-empty `ownerTenantId` or registration fails with `CONFIG_INVALID`. Tool names may repeat across tenants; a duplicate within one tenant is `TOOL_ALREADY_REGISTERED`. Tool resolution and listing are scoped to the caller's tenant: a cross-tenant call is indistinguishable from an unknown tool and rejected with `TOOL_NOT_FOUND`, so a caller cannot enumerate or probe another tenant's tools. `listTools` without a caller context fails with `AUTH_REQUIRED`; in multi-tenant mode, an empty or missing `tenantId` fails with `TENANT_REQUIRED`. The tenant value that enforces authorization is the same value tools resolve against, so authorization and cache partitioning cannot disagree. Per-call authorization still runs for every resolved invocation because listing is not authorization. See ADR 0008.

The runtime invokes a supplied context factory inside the invocation boundary.
Untyped factory failures fail closed as `AUTH_FORBIDDEN`. A typed
`RuntimeError` keeps its code, so an identity-provider outage surfaces as
`UPSTREAM_FAILURE` rather than a policy denial. Every factory failure emits the
normal invocation metric; when tenant resolution did not complete, that event
uses `tenantId: "unknown"`.

`RuntimeError` currently includes `TOOL_NOT_FOUND`, `TOOL_ALREADY_REGISTERED`, `CONFIG_INVALID` (tenant mode, tenant pinning, tenant-binding violations, or malformed runtime cache/tokenizer/projector options), `CONTRACT_INVALID` (registration-time schema, cache-metadata, or output-policy rejection), `INPUT_INVALID`, `INPUT_TOO_LARGE`, `AUTH_REQUIRED` (identity missing where it is required, such as a multi-tenant listing), `AUTH_FORBIDDEN`, `TENANT_REQUIRED` (missing tenant context in multi-tenant mode or unresolvable tenant), `RATE_LIMITED`, `OUTPUT_POLICY_VIOLATION`, `OUTPUT_LIMIT_EXCEEDED`, `CANCELLED`, `UPSTREAM_TIMEOUT`, and `UPSTREAM_FAILURE`. The runtime does not implement a concrete authorization or rate-limit policy, so `OperationPolicy.requiredScopes` remains policy data for adapters to enforce.

Failures are classified by invocation stage:

| Stage               | Adapter outcome                              | Runtime result                                                                  |
| ------------------- | -------------------------------------------- | ------------------------------------------------------------------------------- |
| Identity resolution | throws `RuntimeError`                        | Preserved, including its code and safe message.                                 |
| Identity resolution | throws anything else                         | `AUTH_FORBIDDEN` with the safe message `Access denied`; cause retained.         |
| Authorization       | throws `RuntimeError`                        | Preserved, including its code and safe message.                                 |
| Authorization       | throws anything else                         | `AUTH_FORBIDDEN` with the safe message `Access denied`; cause retained.         |
| Validation          | input size exceeds `maxToolInputBytes`       | `INPUT_TOO_LARGE` (evaluated before schema validation).                         |
| Validation          | schema mismatch                              | `INPUT_INVALID`.                                                                |
| Rate limiting       | returns `{ allowed: false }`                 | `RATE_LIMITED`.                                                                 |
| Rate limiting       | returns no decision or a malformed one       | `UPSTREAM_FAILURE`; the call is not allowed.                                    |
| Rate limiting       | throws `RuntimeError` (not `RATE_LIMITED`)   | Preserved.                                                                      |
| Rate limiting       | throws `RATE_LIMITED` or anything else       | `UPSTREAM_FAILURE` with a limiter-failure message; cause retained.              |
| Execution           | throws `RuntimeError`                        | Preserved.                                                                      |
| Execution           | throws anything else                         | `UPSTREAM_FAILURE` with `Tool '<name>' failed`; cause retained.                 |
| Projection          | returns a non-JSON value or projector throws | `OUTPUT_POLICY_VIOLATION`; cause retained. A typed `RuntimeError` is preserved. |
| Projection          | token count fails or is invalid              | `OUTPUT_POLICY_VIOLATION` when a budget is enforced.                            |
| Projection          | count exceeds `maxTokens`                    | `OUTPUT_LIMIT_EXCEEDED`; the result is not returned or cached.                  |

Causes are retained for protected diagnostics and are never included in the client message or in `RuntimeEvent`. Authorization runs before validation so an unauthorized caller cannot probe the tool schema.

Cache key derivation and cache store failures are not invocation failures. They bypass caching (or degrade a read to a miss) and the call proceeds; they never expose a cached value across a partition and never fail the tool call. A caller cancellation observed on a cache hit is still reported as `CANCELLED`.

### Authorization and rate limiting

```ts
export interface Authorizer {
  authorize(tool: ToolDefinition, context: ToolContext): void | Promise<void>;
}

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSeconds?: number;
}

export interface RateLimiter {
  check(
    context: ToolContext,
    toolName: string,
  ): RateLimitDecision | Promise<RateLimitDecision>;
  release?(context: ToolContext, toolName: string): void | Promise<void>;
}
```

`authorize` returns normally to allow the call. Throw `RuntimeError("AUTH_FORBIDDEN", ...)` for a policy denial. Throw another `RuntimeError` to report an authorization-stage failure with a distinct code, for example `UPSTREAM_FAILURE` when an identity provider is unavailable. Any other thrown value is treated as a denial and fails closed; this covers adapters that naturally throw a plain `Error` to reject a call.

`check` must return a decision. `{ allowed: false }` denies the call. A missing or malformed decision fails closed as `UPSTREAM_FAILURE`; it does not silently allow the call. Throwing is reserved for limiter failures, not denials. A thrown `RuntimeError` other than `RATE_LIMITED` is preserved; any other throw, including `RATE_LIMITED`, becomes `UPSTREAM_FAILURE`. This keeps the `rate_limited` metrics outcome independent of adapter error-code conventions: only an explicit denial can produce it.

### Cache keys

`createCacheKey` returns an opaque, fixed-length key of the form `chainmcp:cache:v2:<64 lowercase hex characters>`. It requires a stable, non-secret `authorizationPartition` and hashes the tenant, principal, authorization partition, contract revision, tool identity, and canonicalized arguments with SHA-256 under a versioned domain separator. The partition should represent effective grants or policy state; never pass a bearer token. Identity fields must be non-empty after trimming, so a blank partition is rejected instead of silently merging authorization contexts. Object properties whose value is `undefined` are omitted; `undefined` at the root or in arrays, sparse arrays, cycles, non-finite numbers, and non-JSON values are rejected. Canonical input is limited to `MAX_CACHE_KEY_INPUT_BYTES` (64 KiB); larger inputs throw `TypeError`. Changing canonicalization, hashed fields, or digest semantics requires incrementing `CACHE_KEY_VERSION`, which changes the key prefix and deliberately invalidates the existing key space. Hashing reduces accidental disclosure but is not encryption; protect the cache store and do not treat keys as secrets.

```ts
export const CACHE_KEY_VERSION = "v2";
export const MAX_CACHE_KEY_INPUT_BYTES = 64 * 1024;

export function createCacheKey(parts: {
  tenantId: string;
  principalId: string;
  authorizationPartition: string;
  contractRevision: string;
  toolName: string;
  arguments: unknown;
}): string;
```

### Invocation caching

```ts
export interface RuntimeCacheOptions {
  store: CacheStore;
  authorizationPartition(
    context: ToolContext,
    tool: ToolDefinition,
  ): string | undefined;
}
```

`RuntimeOptions.cache` enables caching for tools that declare `cache`. The
runtime reads the cache after identity resolution, authorization, input
validation, and rate limiting, so a hit never bypasses an access decision or a
quota check. On a miss it executes the tool and writes successful, non-
`undefined` results with the tool's TTL. Failures are not cached.

The cache key is built with `createCacheKey` from the caller's tenant and
principal, the derived authorization partition, the tool's contract revision,
the tool name, and the validated arguments. `authorizationPartition` must
return a stable, non-secret value representing effective grants or policy
state; it must not return a bearer token or other credential. Returning
`undefined`, returning a blank value, throwing, or producing arguments that
cannot be canonicalized (for example a function-valued extra property) bypasses
the cache for that call only. The callback is synchronous.

Cache failures never change a result: a rejected read becomes a cache bypass, and
a rejected write (including a TTL above the store's cap) is ignored. Cached
values are returned without re-running validation or `execute`, so adapters
must return isolated values from `get`; `InMemoryCacheStore` satisfies this by
parsing a fresh JSON copy per hit. There is no request coalescing, so concurrent
misses may execute the same call more than once. Cache hits still count as
`success` in `RuntimeEvent`; cache outcomes are reported separately (see below).
Cache reads and writes are not covered by the tool execution timeout or
cancellation signal, so a distributed store must enforce its own timeouts.

Each invocation event for an eligible tool includes
`cacheOutcome: "hit" | "miss" | "bypass"`. A read failure and a partition or key
derivation failure report `bypass`, because no usable lookup occurred; a
successful lookup with no entry reports `miss`, even if execution later fails or
the write is rejected. Tools that do not declare `cache` omit the field, as do
runtimes without a cache. The hit ratio is
`hit / (hit + miss)`; exclude `bypass` from the denominator and alert on it
separately.

### Cache invalidation

`invalidateCachedResult(name, input, context)` deletes the entry for one exact
invocation, using the same tool, arguments, tenant, principal, partition, and
contract revision that produced it. It is optional on `ToolRuntime`; runtimes
without caching support may omit it. Hashed keys cannot be enumerated by prefix,
tenant, or predicate, so there is no bulk invalidation: deployments that need
tenant-wide cleanup must use separate store namespaces or external metadata
(ADR 0005). The call is a trusted operator surface, not an MCP request; it does
not run the authorizer and does not validate `input` against the tool schema. It
resolves the tool with the same tenant scoping as `callTool`, so a multi-tenant
caller cannot invalidate another tenant's entry and learns nothing beyond
`TOOL_NOT_FOUND`. It is a no-op when the runtime has no cache, the tool is not
cache-eligible, or the partition/key cannot be derived. Store deletion failures
propagate so an operator can see that invalidation did not succeed.

### Output projection and token budgets

```ts
export interface ResultProjectionRequest {
  tool: ToolDefinition;
  context: ToolContext;
  result: unknown;
}

export interface ResultProjector {
  project(request: ResultProjectionRequest): unknown;
}

export interface FieldSelection {
  include?: readonly string[];
  exclude?: readonly string[];
}

export interface ToolOutputPolicy {
  maxTokens?: number;
  fields?: FieldSelection;
}

export function createFieldProjector(): ResultProjector;
export function assertFieldSelection(
  fields: unknown,
): asserts fields is FieldSelection;
export class FieldSelectionError extends Error {}

export const MAX_FIELD_PATHS = 64;
export const MAX_FIELD_PATH_DEPTH = 16;
export const MAX_FIELD_PATH_LENGTH = 256;
export const MAX_FIELD_PROJECTION_DEPTH = 64;
export const MAX_FIELD_PROJECTION_NODES = 50_000;
```

`RuntimeOptions.projector` supplies the deployment's output policy. It runs only
for tools that declare `output`, after `execute` and before any cache write,
token measurement, or return. The projector receives the resolved tool, caller
context, and raw result, and returns the value the caller and model may see —
typically after removing fields the caller is not authorized to receive. The
runtime enforces the process; it does not decide which fields are safe.

A projected result must have a JSON representation. `undefined`, cyclic values,
`BigInt`, a thenable (an `async` projector), and a projector that throws fail
closed with `OUTPUT_POLICY_VIOLATION`; a thrown `RuntimeError` is preserved. A
thenable is rejected rather than serialized as `{}`. The raw result is never
returned as a fallback, and a failed projection is never cached.

When `maxTokens` is present, the runtime counts tokens in the serialized
projected result with `RuntimeOptions.tokenizer` and rejects a count above the
budget with `OUTPUT_LIMIT_EXCEEDED`. A tokenizer that throws or returns a
negative, fractional, non-finite, or unsafe count also fails closed with
`OUTPUT_POLICY_VIOLATION`, because the budget cannot be verified. The count is
recorded as `tokenUsage` with the adapter's exact/estimate label. Budgets are
integers in the adapter's token units; with an `estimate` adapter the limit is
only as accurate as the estimate.

`output.fields` selects the built-in field projector:

```ts
runtime = new InMemoryToolRuntime({
  projector: createFieldProjector(),
});

runtime.register({
  // ...
  output: { fields: { include: ["id", "profile.email"] } },
});
```

`include` keeps only named paths; `exclude` removes named paths and retains
everything else. Exactly one must be provided, with 1-64 unique paths. A path is
one or more dot-separated object keys (maximum 16 segments and 256 characters);
arrays encountered along a path are traversed element-wise, so `items.id`
applies to each element and `id` applies to a root array. No array indices,
wildcards, escapes, or keys containing dots are supported. `__proto__`,
`prototype`, and `constructor` segments are rejected.

`include` builds a new object from plain JSON objects and arrays. Array elements
that do not match the remaining path, and non-plain objects, become `null`;
missing fields are omitted. `exclude` clones only modified branches, leaves
unmatched values as-is, and fails with `OUTPUT_POLICY_VIOLATION` if a selected
path reaches a non-plain object. Neither mode mutates the original result.
Projection is bounded to 64 levels and 50,000 visited nodes; exceeding either
fails the call rather than truncating silently. Path validation is enforced at
registration with `CONTRACT_INVALID` and re-checked at projection time.

`createFieldProjector` passes through tools without `output.fields`, so it can be
installed runtime-wide. A custom projector can also read `output.fields`, but
the runtime cannot enforce that a custom projector honors them; use the built-in
one for declarative policy. See `docs/field-projection.md`.

On a cache hit, the stored value is already projected and budget-checked, so the
projector and budget are not re-run. Cached entries therefore contain only
projected output. Changing a projector, a budget, or a tool's `output` policy
does not change cache keys: invalidate the namespace or bump `contractRevision`
when deploying a policy change, or a shared cache may serve entries produced
under the previous policy. A projector and tokenizer run synchronously and
in-process; see `docs/adr/0012-output-projection-and-token-budgets.md`.

## Cache interface

```ts
export interface CacheStore {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T, ttlSeconds: number): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface InMemoryCacheStoreOptions {
  maxEntries?: number;
  maxBytes?: number;
  maxEntryBytes?: number;
  maxTtlSeconds?: number;
  monotonicNow?: () => number;
}

export class InMemoryCacheStore implements CacheStore {
  constructor(options?: InMemoryCacheStoreOptions);
}

export function isCurrentCacheKey(key: unknown): key is string;
export function assertJsonCacheValue(root: unknown): void;

export const DEFAULT_CACHE_MAX_ENTRY_BYTES = 256 * 1024;
export const DEFAULT_CACHE_MAX_TTL_SECONDS = 3_600;
```

Adapters must enforce bounded TTLs and entry sizes. Shared caches must partition data by tenant and authorization context. `get` must return a value the caller may mutate without affecting stored state, and must return `undefined` for a miss.

Adapter authors can use `isCurrentCacheKey` to reject non-current hashed keys
and `assertJsonCacheValue` to apply the same JSON, depth, node, accessor, and
callable-`toJSON` validation as the in-memory and Redis stores.

`InMemoryCacheStore` is a process-local LRU implementation for development and
tests. Its options default to 1,000 entries, 16 MiB retained key/value bytes,
256 KiB per entry, and a 3,600-second maximum TTL. It accepts only versioned
SHA-256 cache keys, clones values through JSON serialization, and rejects
non-JSON values, accessors, callable `toJSON` methods (own or inherited),
values deeper than 64 levels, and values with more than 50,000 nodes. It
rejects a `toJSON` method because `JSON.stringify` invokes one even when it is
inherited or non-enumerable, which would escape those bounds. Expired entries
are reclaimed lazily on read or write; the entry and byte caps still bound
retention. Its byte limit bounds retained serialized data; serialization can
still allocate a temporary string before rejecting an oversized value.
`InMemoryToolRuntime` uses it only when it is supplied through
`RuntimeOptions.cache`; no tool result is cached unless the tool opts in and the
runtime has a store.

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
  cacheOutcome?: "hit" | "miss" | "bypass";
  tokenUsage?: {
    count: number;
    measurement: "exact" | "estimate";
    tokenizer: string;
    payloadBytes: number;
  };
};

export interface MetricsSink {
  record(event: RuntimeEvent): void | Promise<void>;
}

export interface Tokenizer {
  id: string;
  measurement: "exact" | "estimate";
  count(text: string): number;
}
```

`tokenUsage` is present on successful invocations when `RuntimeOptions.tokenizer`
is configured. `count` is the adapter's count over `JSON.stringify(result)`, the
same text the MCP adapter presents to the model; `payloadBytes` is that text's
UTF-8 size. The runtime requires both a non-empty `id` and a `measurement` of
`exact` or `estimate`, validates the returned count as a non-negative safe
integer, and records the adapter's declaration without relabeling it. An
adapter may claim `exact` only when it matches the tokenizer the target model
uses; a heuristic must declare `estimate`. No tokenizer is bundled.

Measurement runs on every successful call, including cache hits, and never on
failures. It is skipped when the result has no JSON representation (for example
`undefined` or a cycle), when the adapter throws, or when it returns an unusable
count; the invocation still succeeds and `tokenUsage` is omitted. Tools that
opt into `output` are stricter: an unserializable projection fails closed, and a
budgeted tool's unverifiable count fails closed instead of being omitted.
Tokenizers run in-process and synchronously in this milestone, so a remote
counter must be fronted by a local adapter. Counts are telemetry for tools
without a budget. For a tool with `output.maxTokens`, the same count enforces the
budget before the result is cached or returned. Projection is applied before
measurement, so `tokenUsage` describes the value the model would receive, not the
raw upstream result.

The runtime emits one event for every `callTool` that finds a callable tool, regardless of success or failure. Calls rejected with `TOOL_NOT_FOUND` do not emit an event: single-tenant runtimes reject unknown tools before the event is created, and in multi-tenant mode unresolved tools (unknown or outside the caller's tenant) are the same observable miss, so metrics timing cannot be used to enumerate another tenant's tools. Pinned single-tenant cross-tenant denials do emit an event with `AUTH_FORBIDDEN`. `timestamp` (epoch milliseconds) is read from `RuntimeOptions.now`, which defaults to `Date.now`. `durationMs` is measured with the monotonic `RuntimeOptions.monotonicNow`, which defaults to `performance.now`, so wall-clock adjustments cannot distort or invert a duration. Both clocks are injectable for deterministic tests. See `docs/adr/0007-wall-clock-and-monotonic-duration.md`.

`outcome` is `success` when execution resolves, `rate_limited` only when the configured `RateLimiter` returns `{ allowed: false }`, and `error` for every other failure, including authorization failures, validation failures, limiter failures, timeouts, cancellations, and upstream errors. `errorCode` is present on failures and is the final `RuntimeErrorCode`. A `RATE_LIMITED` error reported by an executor is preserved as `errorCode` but has outcome `error`, because the runtime rate limiter did not deny the call.

`cacheOutcome` is present only for a tool that declares `cache` on a runtime configured with a cache. Values are `hit` (served from the store), `miss` (lookup succeeded with no entry, including when execution or the write later fails), and `bypass` (no usable lookup: partition/key derivation failed or the store read failed). The hit ratio is `hit / (hit + miss)`; `bypass` is excluded from that ratio and should be monitored separately. Cache outcomes do not change `outcome` or `errorCode`.

The earlier target shape included `outcome: "cache_hit"` and optional `durationMs`, `tenantId`, `toolName`, `tokenCount`, and `attributes`. Cache hits are represented by `cacheOutcome: "hit"` with `outcome: "success"` rather than a distinct outcome, so existing consumers of `outcome` keep working. `tokenCount` is represented by `tokenUsage.count`, with `tokenUsage.measurement` preventing an estimate from being read as exact; `attributes` and the optional-field relaxation depend on analytics and redaction work (Milestone 6). Adapters must not assume they exist.

`MetricsSink.record` is invoked after the call settles. Synchronous throws and rejected promises are ignored so telemetry cannot change the tool result. Events must not contain secrets, raw authorization data, or unrestricted request and response bodies.

## Logging interface

`@chainmcp/core` provides injectable structured logging contracts:

```ts
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
```

The runtime injects `RuntimeOptions.logger` and emits correlated lifecycle events:

- Successful completions emit `info` with `durationMs` and outcome.
- Rate-limiting denials emit `warn` and call `audit` with `RATE_LIMITED`.
- Authorization denials emit `error` and call `audit` with `AUTH_FORBIDDEN` / `AUTH_REQUIRED`.
- Administrative cache invalidations call `audit`.
- All logger calls are completely isolated: throwing loggers and rejected promises never alter the tool result or surface to clients.

### Tracing Interfaces (`@chainmcp/core`)

```ts
export interface ToolSpan {
  readonly spanContext: () => {
    readonly traceId: string;
    readonly spanId: string;
    readonly traceFlags?: number | undefined;
  };
  setAttribute?(key: string, value: string | number | boolean): this;
  setAttributes?(attributes: Record<string, string | number | boolean>): this;
  recordException?(exception: unknown): this;
  end(): void;
}

export interface ToolTracer {
  startToolSpan(
    toolName: string,
    context: ToolContext,
    contractRevision?: string | undefined,
  ): ToolSpan;
  endToolSpan(
    span: ToolSpan,
    details?: {
      readonly error?: unknown;
      readonly outcome?: "success" | "error" | "cancelled" | undefined;
      readonly durationMs?: number | undefined;
      readonly cacheOutcome?: "hit" | "miss" | "bypass" | undefined;
      readonly cached?: boolean | undefined;
    },
  ): void;
  startChildSpan?(
    name: string,
    attributes?: Record<string, string | number | boolean> | undefined,
  ): ToolSpan;
  endSpan?(
    span: ToolSpan,
    details?: {
      readonly error?: unknown;
      readonly outcome?: "success" | "error" | "cancelled" | undefined;
      readonly durationMs?: number | undefined;
    },
  ): void;
  withSpan?<T>(span: ToolSpan, fn: () => T): T;
}
```

When configured with `RuntimeOptions.tracer`, the runtime automatically instruments tool execution:

- Creates a root span `tool.<name>` for every resolved tool invocation.
- Propagates span context via `withSpan` to child operations (`cache.read`, `upstream.call`, `projection`, `cache.write`).
- Concludes the span on success, failure (with scrubbed error message), or cancellation (`outcome: "cancelled"`).
- Guarantees zero payload, argument, or header leaks into span attributes.

## `@chainmcp/compiler`

`@chainmcp/compiler` parses and validates OpenAPI 3.0 and 3.1 documents and emits deterministic operation metadata, including parameter bindings, request-body metadata, response schemas, and authentication policies. The compiler itself does not execute anything. `@chainmcp/executor` turns an emitted `CompiledOperation` into a runnable `ToolDefinition` with bounded upstream I/O and an explicit destination policy. Credential injection, response validation, and generated-server/CLI wiring remain unimplemented.

```ts
export type OpenApiVersion = "3.0" | "3.1";

export interface CompileOptions {
  strict?: boolean;
  includeDeprecated?: boolean;
  maxSourceBytes?: number;
  maxRefDepth?: number;
  maxOperations?: number;
}

export type CompileDiagnosticCode =
  | "SOURCE_TOO_LARGE"
  | "SOURCE_PARSE_FAILED"
  | "DOCUMENT_INVALID"
  | "OPENAPI_VERSION_UNSUPPORTED"
  | "PATH_INVALID"
  | "OPERATION_INVALID"
  | "OPERATION_LIMIT_EXCEEDED"
  | "OPERATION_ID_INVALID"
  | "DEPRECATED_OPERATION"
  | "TOOL_NAME_NORMALIZED"
  | "TOOL_NAME_COLLISION"
  | "DESCRIPTION_TRUNCATED"
  | "PARAMETER_INVALID"
  | "PARAMETER_DUPLICATE"
  | "PARAMETER_UNSUPPORTED"
  | "REQUEST_BODY_INVALID"
  | "REQUEST_BODY_UNSUPPORTED"
  | "RESPONSE_INVALID"
  | "RESPONSE_UNSUPPORTED"
  | "REF_INVALID"
  | "REF_REMOTE_UNSUPPORTED"
  | "REF_CYCLE"
  | "REF_DEPTH_EXCEEDED"
  | "REF_SIBLINGS_UNSUPPORTED"
  | "SCHEMA_INVALID"
  | "SCHEMA_COMPOSITION_UNSUPPORTED"
  | "SCHEMA_UNSUPPORTED"
  | "SCHEMA_NULLABLE_INVALID"
  | "SECURITY_INVALID"
  | "SECURITY_REQUIREMENT_INVALID"
  | "SECURITY_SCHEME_INVALID"
  | "UNSUPPORTED_SECURITY_SCHEME"
  | "UNSUPPORTED_SERVERS"
  | "UNSUPPORTED_CALLBACKS"
  | "CONFIG_DEPRECATED"
  | "INTERNAL_ERROR";

export interface CompileDiagnostic {
  severity: "error" | "warning";
  code: CompileDiagnosticCode;
  message: string;
  location?: string;
}

export type SecurityRequirement = Readonly<Record<string, readonly string[]>>;

export interface CompiledSecurityScheme {
  name: string;
  type: "apiKey" | "http" | "oauth2" | "openIdConnect" | "mutualTLS";
  description?: string;
  parameterName?: string;
  parameterLocation?: "query" | "header" | "cookie";
  scheme?: string;
  bearerFormat?: string;
  openIdConnectUrl?: string;
  flows?: Readonly<Record<string, unknown>>;
}

export interface CompiledAuthenticationScheme {
  name: string;
  type: "apiKey" | "http" | "oauth2" | "openIdConnect" | "mutualTLS";
  scopes: readonly string[];
  parameterName?: string;
  parameterLocation?: "query" | "header" | "cookie";
  httpScheme?: string;
  bearerFormat?: string;
  openIdConnectUrl?: string;
  flows?: Readonly<Record<string, unknown>>;
}

export interface CompiledAuthenticationAlternative {
  /** Schemes that must all be satisfied together (AND). */
  schemes: readonly CompiledAuthenticationScheme[];
}

export interface CompiledAuthenticationPolicy {
  /** OR alternatives; empty means no authentication is declared. */
  alternatives: readonly CompiledAuthenticationAlternative[];
  /** True when at least one alternative requires no scheme. */
  allowsAnonymous: boolean;
}

export interface CompiledParameter {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  required: boolean;
  style?: string;
  explode?: boolean;
}

export type RequestBodyKind = "json" | "form-urlencoded" | "multipart";

export interface CompiledEncoding {
  contentType?: string;
  style?: string;
  explode?: boolean;
}

export interface CompiledRequestBody {
  mediaType: string;
  required: boolean;
  kind?: RequestBodyKind;
  encodings?: Readonly<Record<string, CompiledEncoding>>;
}

export interface CompiledResponse {
  status: string;
  description: string;
  mediaType?: string;
  schema?: JsonSchema;
}

export interface CompiledOperation {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  operation: OperationPolicy;
  method: HttpMethod;
  path: string;
  operationId?: string;
  readOnly: boolean;
  deprecated: boolean;
  parameters: readonly CompiledParameter[];
  requestBody?: CompiledRequestBody;
  responses: readonly CompiledResponse[];
  security: readonly SecurityRequirement[];
  authentication: CompiledAuthenticationPolicy;
  sourceLocation: string;
  warnings?: readonly CompileDiagnostic[];
}

export interface CompileManifest {
  manifestVersion: 1;
  compilerVersion: string;
  openapiVersion: OpenApiVersion | "unknown";
  sourceHash: string;
  contractRevision: string;
  toolsetHash: string;
  toolCount: number;
  tools: readonly { name: string; hash: string }[];
  warnings?: readonly CompileDiagnostic[];
}

export interface CompileResult {
  ok: boolean;
  tools: readonly CompiledOperation[];
  diagnostics: readonly CompileDiagnostic[];
  securitySchemes: Readonly<Record<string, CompiledSecurityScheme>>;
  sourceHash: string;
  contractRevision: string;
  manifest: CompileManifest;
}

export interface ContractCompiler {
  compile(source: string, options?: CompileOptions): Promise<CompileResult>;
}

export class OpenApiCompiler implements ContractCompiler {}

export function compileOpenApi(
  source: string,
  options?: CompileOptions,
): CompileResult;

export function diffManifests(
  previous: CompileManifest,
  next: CompileManifest,
): {
  added: readonly string[];
  removed: readonly string[];
  changed: readonly string[];
  unchanged: readonly string[];
};

export function diffContracts(
  previous: ContractDiffInput,
  next: ContractDiffInput,
): ContractDiffResult;
```

`compile`/`compileOpenApi` accept one YAML or JSON document (YAML 1.2 core schema, duplicate keys rejected). Compilation is offline and asynchronous only to match the interface: it performs no filesystem or network I/O. Defaults are `strict: true`, `includeDeprecated: false`, `maxSourceBytes: 5 MiB` (hard maximum 25 MiB), `maxRefDepth: 32` (maximum 128), and `maxOperations: 1,000` (maximum 10,000). Invalid option types and exceeded hard maxima throw `TypeError`; document and contract problems are returned as diagnostics.

`ok` is false when any diagnostic has severity `error`. The compiler keeps compiling independent operations after a failure, but never emits an operation with an error. Deprecated operations are excluded with a warning by default. In strict mode, an unsupported schema annotation is an error and the operation is omitted; in permissive mode (`strict: false`) annotations that can be dropped without changing the supported subset are dropped with a warning. The runtime-supported constraints (`minLength`, `maxLength`, `pattern`, `format`, `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `multipleOf`, `minItems`, `maxItems`, `uniqueItems`, `minProperties`, and `maxProperties`) are preserved and audited. OpenAPI 3.0 boolean `exclusiveMinimum`/`exclusiveMaximum` values are normalized to the JSON Schema numeric form. An `allOf` of object schemas is flattened into one object schema when merging properties, `required`, and `additionalProperties` preserves the intersection; incompatible or non-object members, sibling validation keywords, and `oneOf`/`anyOf`/`not`/conditional/dependent/pattern composition on inputs are always errors because dropping or approximating them would weaken validation. Schema-valued `additionalProperties`, tuple or boolean `items`, remote references, and unknown schema keywords are also errors.

Supported input construction:

- Path, query, and header parameters from path-item and operation levels; operation-level declarations override path-level ones by `(name, in)`. Cookie parameters, content-encoded parameters, credential/transport headers such as `Authorization` and `Cookie`, duplicate names across locations, and path parameters without `required: true` are rejected.
- JSON request bodies (`application/json` or an `application/*+json` media type) become one `body` input property, required when `requestBody.required` is true. A parameter named `body` collides and is rejected.
- The root input schema is always `type: "object"` with `additionalProperties: false`; property and `required` ordering is sorted for determinism.
- `readOnly` properties are omitted from inputs and from `required`.
- Each operation records `parameters` (name, `path`/`query`/`header` location, and required flag) sorted by input name. When a JSON request body exists, `requestBody` records the selected media type and required flag. These bindings are metadata for an executor; the input schema remains the validation boundary.

Response mapping:

- Each declared response is emitted in code-unit order of its status key as a `CompiledResponse`: `default`, an exact `100`-`599` code, and, for OpenAPI 3.1 only, ranges such as `2XX`. A 3.0 range key is rejected.
- `description` is required. Unknown response fields and malformed `content` objects are `RESPONSE_INVALID` errors.
- The selected media type prefers `application/json`, then the first `application/*+json` type in code-unit order. Non-JSON-only content is recorded with its first media type and a `RESPONSE_UNSUPPORTED` warning, without a schema. `headers` and `links` are not mapped.
- Response schemas are descriptive metadata, not runtime validation. They are translated with local `$ref` resolution, 3.0 nullability, `writeOnly` output filtering, and preserved composition (`allOf`, `oneOf`, `anyOf`, `not`, conditionals, pattern/dependent schemas). Keywords outside the input-validator subset are retained rather than rejected. No validator is generated or applied to upstream payloads yet.

Schema translation resolves local `$ref`s only (`#/...`) with cycle and depth detection and never fetches a remote reference. OpenAPI 3.0 `nullable: true` becomes a union with `"null"` and adds `null` to `enum`; it requires a sibling `type`, and using `nullable` in 3.1 is an error. OpenAPI 3.1 null unions are preserved. The resulting input schema is audited with `auditInputSchema`; an operation is not emitted when the runtime cannot enforce its schema. `allOf` flattening merges nested object intersections deterministically, including intersections reached through `$ref`; a property declared with incompatible schemas in different members, a non-object member, or a sibling validation keyword produces `SCHEMA_COMPOSITION_UNSUPPORTED`.

Security schemes and raw requirements are preserved, and each operation also receives an explicit `authentication` policy:

- `authentication.alternatives` mirrors the OR list; each alternative's `schemes` is the AND list.
- Each scheme entry copies the credential-relevant definition (API key parameter name/location, HTTP scheme and bearer format, OpenID Connect URL, OAuth2 flows) plus the required scopes. Scopes are deduplicated and sorted by code unit; scheme entries are sorted by name. Alternative order follows the contract.
- An empty requirement object (`{}`) is preserved as an alternative with no schemes and sets `allowsAnonymous: true`; it is not dropped. An empty or absent `security` list also means no authentication, with `alternatives: []` and `allowsAnonymous: true`.
- A non-OAuth/OIDC scheme that declares scopes is rejected with `SECURITY_REQUIREMENT_INVALID`. OAuth2 scopes must appear in at least one declared flow in strict mode (error) or produce a warning in permissive mode. OpenID Connect scopes cannot be checked offline and are preserved.
- If the document-level `security` list is invalid, no operations are emitted. Every operation inherits it, so emitting tools would silently drop authentication.

The policy is compiler metadata, not enforcement. `operation.requiredScopes` remains empty because flattening OR alternatives or AND scopes into one list would misrepresent the contract; auth adapters must interpret `authentication`. The current executor does not resolve credentials or enforce this policy.

`sourceHash` hashes the exact source text. `contractRevision` hashes the canonical parsed document plus `COMPILER_VERSION`; semantically equivalent key ordering therefore produces the same revision, while compiler changes produce a new revision. `manifest.tools` records a hash per emitted operation (including parameter bindings, request-body metadata, response metadata, and authentication), `toolsetHash` hashes the compiler version, contract revision, and all tool hashes, and `diffManifests` reports added, removed, changed, and unchanged names between two manifests. No timestamps are included, so the same source and compiler version produce the same manifest.

### Contract Diffing & Breaking Change Taxonomy (`diffContracts`)

`diffContracts(previous, next)` walks compiled operations and JSON schemas recursively, classifying every detected contract difference:

- **Breaking (`"breaking"`):**
  - Tool removed (`TOOL_REMOVED`).
  - Tool renamed based on method and path matching (`TOOL_RENAMED`).
  - New required input property added (`INPUT_REQUIRED_ADDED`).
  - Input property removed (`INPUT_PROPERTY_REMOVED`).
  - Input type narrowed (`INPUT_TYPE_NARROWED`).
  - Input enum values removed or restricted (`INPUT_ENUM_VALUE_REMOVED`).
  - Input constraints tightened: `minimum` increased, `maximum` decreased, `minLength` increased, `maxLength` decreased, or `pattern` added/changed (`INPUT_CONSTRAINT_TIGHTENED`).
  - Required response field removed (`RESPONSE_FIELD_REMOVED`).
  - Response field type changed incompatibly (`RESPONSE_TYPE_CHANGED`).
  - Authentication requirement added to previously unauthenticated tool (`AUTH_REQUIREMENT_ADDED`).
  - Base URL origin changed (`BASE_URL_CHANGED`).
- **Potentially Breaking (`"potentially-breaking"`):**
  - Existing optional input property became required (`INPUT_BECAME_REQUIRED`).
  - Input property default value changed (`INPUT_DEFAULT_CHANGED`).
  - New enum value added to response payload (`RESPONSE_ENUM_VALUE_ADDED`).
  - Base URL pathname changed (`BASE_URL_PATH_CHANGED`).
- **Non-Breaking (`"non-breaking"`):**
  - New tool added (`TOOL_ADDED`).
  - New optional input property added (`INPUT_OPTIONAL_ADDED`).
  - Existing required input property became optional (`INPUT_BECAME_OPTIONAL`).
  - Input type widened (`INPUT_TYPE_WIDENED`).
  - New enum value added to input property (`INPUT_ENUM_VALUE_ADDED`).
  - Tool or field description changed (`DESCRIPTION_CHANGED`).
  - Authentication requirement relaxed to allow anonymous access (`AUTH_REQUIREMENT_RELAXED`).

The output is typed as `ContractDiffResult` (`schemaVersion: 1`), providing `summary: { breaking, potentiallyBreaking, nonBreaking }`, tool list sets (`addedTools`, `removedTools`, `changedTools`, `unchangedTools`), and categorized arrays (`changes`, `breaking`, `potentiallyBreaking`, `nonBreaking`).

Known limitations: response schemas are unvalidated metadata and no output validator is generated; authentication policies are not enforced and no credentials are injected; no remote references; input `oneOf`, `anyOf`, `not`, conditional, dependent, and pattern composition is rejected; `allOf` supports object intersections only; only the listed runtime formats are asserted; `const` is not supported; no YAML merge-key support; and no regeneration command that reads/writes a manifest. The compiler is not wired into the CLI or generated-server flow yet. See `@chainmcp/executor` for the implemented upstream HTTP slice and `docs/getting-started.md` for the runnable example.

## `@chainmcp/executor`

`@chainmcp/executor` turns a compiled operation into a runnable `ToolDefinition` with bounded Node HTTP/HTTPS I/O. Outbound requests are protected by SSRF-guarding destination policies, DNS pinning, header/body caps, and response schema validation.

```ts
export interface UpstreamExecutorOptions {
  baseUrl: string;
  allowedHosts: readonly string[];
  allowInsecureHttp?: boolean;
  maxResponseBytes?: number;
  maxRequestBytes?: number;
  maxMultipartPartBytes?: number;
  maxRedirects?: number;
  timeoutMs?: number;
  contractRevision?: string;
  ownerTenantId?: string;
  resolveHost?: HostResolver;
  transport?: UpstreamTransport;
  credentialProvider?: UpstreamCredentialProvider;
  cache?: UpstreamCachePolicy;
  defaultReadCacheTtlSeconds?: number;
  validateResponses?: "off" | "warn" | "enforce";
  logger?: Logger;
}

export type HostResolver = (hostname: string) => Promise<readonly string[]>;

export interface ResolvedDestination {
  url: URL;
  hostname: string;
  address: string;
  family: 4 | 6;
}

export interface UpstreamTransportRequest {
  url: URL;
  hostname: string;
  address: string;
  family: 4 | 6;
  method: string;
  headers: Readonly<Record<string, string>>;
  body?: Uint8Array;
  maxResponseBytes: number;
  signal: AbortSignal;
}

export interface UpstreamTransportResponse {
  status: number;
  headers: Readonly<Record<string, string | string[] | undefined>>;
  body: Uint8Array;
}

export interface UpstreamTransport {
  request(
    request: UpstreamTransportRequest,
  ): Promise<UpstreamTransportResponse>;
}

export interface UpstreamExecutor {
  createTool(operation: CompiledOperation): ToolDefinition;
  createTools(
    operations: readonly CompiledOperation[],
  ): readonly ToolDefinition[];
}

export function createUpstreamExecutor(
  options: UpstreamExecutorOptions,
): UpstreamExecutor;

export function createNodeUpstreamTransport(): UpstreamTransport;

export const EXECUTOR_VERSION: "0.1.0";
export const DEFAULT_MAX_RESPONSE_BYTES: 1_000_000;
export const MAX_RESPONSE_BYTES_LIMIT: 10_000_000;
export const DEFAULT_MAX_REQUEST_BYTES: 1_000_000;
export const MAX_REQUEST_BYTES_LIMIT: 10_000_000;
export const DEFAULT_MAX_MULTIPART_PART_BYTES: 1_000_000;
export const DEFAULT_MAX_REDIRECTS: 3;
export const MAX_REDIRECTS_LIMIT: 5;
export const DEFAULT_TIMEOUT_MS: 15_000;
export const MAX_TIMEOUT_MS: 120_000;
export const MAX_REQUEST_HEADER_BYTES: 16_384;
export const MAX_RESPONSE_HEADER_BYTES: 16_384;

export function serializeFormUrlEncoded(
  body: unknown,
  encodings?: Readonly<Record<string, CompiledEncoding>>,
  maxRequestBytes?: number,
): Uint8Array;

export interface SerializedMultipartBody {
  body: Uint8Array;
  contentType: string;
}

export function serializeMultipartFormData(
  body: unknown,
  encodings?: Readonly<Record<string, CompiledEncoding>>,
  maxMultipartPartBytes?: number,
  maxRequestBytes?: number,
  boundaryOverride?: string,
): SerializedMultipartBody;
```

Typical use:

```ts
const result = compileOpenApi(source);
if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));

const executor = createUpstreamExecutor({
  baseUrl: "https://api.example.com/v1",
  allowedHosts: ["api.example.com"],
  contractRevision: result.contractRevision,
});
const runtime = new InMemoryToolRuntime();
for (const tool of executor.createTools(result.tools)) runtime.register(tool);
```

#### Request mapping

- The base URL's path prefix is prepended to the compiled path. `baseUrl` must be absolute, must not contain a query, fragment, or credentials, and its host must be allowlisted.
- Path parameters are substituted and percent-encoded. Missing path values, undeclared placeholders, unfilled braces, and literal or percent-encoded `.`/`..` segments are request-construction failures, so a value cannot walk out of the declared path.
- Query parameters are appended by name. Arrays are sent as repeated keys. Scalars may be strings, finite numbers, or booleans; objects, arrays of objects, and `null` are rejected because OpenAPI serialization styles are not retained.
- Header parameters are sent as declared. Array values are comma-joined. Control characters, invalid header names, and reserved transport/credential headers are rejected. Compiler `parameters` metadata never includes cookie parameters or the forbidden headers listed for the compiler.
- A JSON `body` input is serialized as UTF-8 with the selected request media type. The body is required only when `requestBody.required` is true.
- Requests set `accept: application/json`, `accept-encoding: identity`, and a package user agent. No inbound identity, token, cookie, or authorization header is forwarded from tool arguments or context.
- When `credentialProvider` is configured, it resolves upstream credentials for operations declaring `CompiledAuthenticationPolicy`. Provider output is validated with `@chainmcp/auth`'s `normalizeUpstreamCredential`; valid credentials (`apiKey`, `http` bearer/basic, `oauth2`) are injected into headers, query parameters, or cookies, and invalid material counts as unresolved. If authentication fails and anonymous access is not allowed, the call rejects with `RuntimeError("AUTH_REQUIRED")`.
- OAuth token acquisition reuses the outbound policy. With a credential provider configured, the executor passes a token endpoint fetcher built from its resolver and transport, so the token request is allowlisted (the provider's `allowedTokenHosts`, otherwise the token URL host), classified, DNS-pinned, peer-verified, and capped exactly like an API request. Token endpoint redirects are refused and non-JSON token responses are rejected.
- URL length is capped at 8 KiB and request headers at 16 KiB. The request body defaults to a 1 MiB cap.

#### Response and redirect behavior

- Only 2xx responses are returned. An empty body returns `null`; otherwise the body must be UTF-8 JSON (`application/json` or `application/*+json`) and is parsed. Non-2xx statuses become `RuntimeError("UPSTREAM_FAILURE", "Upstream request failed with status <code>")`; the response body is never included.
- A streamed body is capped while reading. Declared oversized `content-length` and compressed (`content-encoding` other than `identity`) responses are rejected before use. Response headers are capped at 16 KiB.
- Redirects 301, 302, 303, 307, and 308 are followed only within the same host, protocol, and port. Every hop is re-resolved, revalidated against `allowedHosts`, and classified again. Cross-host redirects are rejected even when both hosts are allowlisted. 303, and 301/302 on POST, switch to GET and drop the body and content headers; 307/308 preserve them. The default limit is three redirects.
- The total call budget defaults to 15 seconds and covers DNS, connect, redirects, and reading. `context.signal` and the executor timeout abort the transport; `UPSTREAM_TIMEOUT` and `CANCELLED` are preserved.
- Failures use safe `RuntimeError` messages: destination denial, request construction, upstream status, oversized response, unsupported media type, invalid JSON, timeout, cancellation, or a generic upstream failure. Causes stay local for diagnostics.

#### Outbound security

- `allowedHosts` is an exact, normalized hostname allowlist. Wildcards, schemes, ports, paths, credentials, and whitespace are rejected. One trailing dot and IDN spelling are normalized; matching is case-insensitive.
- HTTPS is required by default. `allowInsecureHttp: true` permits plain HTTP but does not permit private destinations.
- Every DNS answer is classified. If any IPv4 or IPv6 address is loopback, private, shared (CGNAT), link-local, multicast, metadata, documentation, unspecified, or reserved, the whole resolution is rejected. IPv4-mapped IPv6 forms are classified as their IPv4 address.
- The selected address is pinned in the Node DNS lookup; the transport verifies `socket.remoteAddress` against it, disables connection reuse, and does not honor proxy environment variables. TLS certificate validation is left at Node's secure default.
- Redirects are origin-locked and re-resolved, so a hostname cannot change network location mid-chain. The transport never decompresses responses.

#### Limitations

- Upstream credential injection supports static, env, secretStore, and OAuth client credentials.
- Response schema validation validates upstream responses against compiled schemas (modes: `off`, `warn`, `enforce`), redacting response bodies in logs and error diagnostics.
- No retries, no multipart/binary bodies, no OpenAPI `style`/`explode` serialization, no cookie parameters, and no per-operation `servers` resolution.
- A custom `UpstreamTransport` is trusted adapter code. The executor rechecks response size and JSON shape, but cannot verify that an injected transport connected to the pinned address.
- DNS resolution is not cancellable at the OS level; an aborted call stops waiting and aborts the HTTP request, but the resolver promise may settle later.

### `OpenApiToolSource`

```ts
export interface OpenApiToolSourceOptions {
  executor: UpstreamExecutor;
  operations: readonly CompiledOperation[];
}

export class OpenApiToolSource implements ToolSource {
  constructor(options: OpenApiToolSourceOptions);
  getTools(): readonly ToolDefinition[];
}

export function createOpenApiToolSource(
  options: OpenApiToolSourceOptions,
): OpenApiToolSource;
```

Adapts compiled OpenAPI operations and an `UpstreamExecutor` into a portable `ToolSource` instance ready to be registered via `ToolRuntime.registerSource(source)`.

## `@chainmcp/cache-redis`

Optional Redis-backed `CacheStore` for shared caches:

```ts
export interface RedisCacheClient {
  get(key: string): Promise<string | null | undefined>;
  set(key: string, value: string, ttlMilliseconds: number): Promise<unknown>;
  delete(key: string): Promise<unknown>;
}

export interface RedisCacheStoreOptions {
  client: RedisCacheClient;
  keyPrefix?: string;
  maxEntryBytes?: number;
  maxTtlSeconds?: number;
  commandTimeoutMs?: number;
}

export interface SimpleRedisTlsOptions {
  ca?: string | Buffer | undefined;
  cert?: string | Buffer | undefined;
  key?: string | Buffer | undefined;
  rejectUnauthorized?: boolean | undefined;
  servername?: string | undefined;
}

export interface SimpleRedisOptions {
  url?: string | undefined;
  host?: string | undefined;
  port?: number | undefined;
  username?: string | undefined;
  password?: string | undefined;
  database?: number | undefined;
  timeoutMs?: number | undefined;
  tls?: boolean | SimpleRedisTlsOptions | undefined;
  ca?: string | Buffer | undefined;
  cert?: string | Buffer | undefined;
  key?: string | Buffer | undefined;
  rejectUnauthorized?: boolean | undefined;
  minConnections?: number | undefined;
  maxConnections?: number | undefined;
  maxRetries?: number | undefined;
  retryBaseMs?: number | undefined;
  retryCapMs?: number | undefined;
  healthCheckOnCheckout?: boolean | undefined;
}

export interface SimpleRedisClientStatus {
  totalConnections: number;
  idleConnections: number;
  activeConnections: number;
  waitQueueLength: number;
  isClosed: boolean;
}

export interface SimpleRedisClient extends RedisCacheClient {
  eval(script: string, keys: string[], args: string[]): Promise<unknown>;
  close(): Promise<void>;
  disconnect(): Promise<void>;
  getStatus(): SimpleRedisClientStatus;
}

export function createSimpleRedisClient(
  urlOrOptions: string | SimpleRedisOptions,
): SimpleRedisClient;

export const createSimpleRedisCacheClient = createSimpleRedisClient;

export function redactRedisUrl(urlString: string): string;

export class RedisCacheStore implements CacheStore {
  constructor(options: RedisCacheStoreOptions);
  readonly client: RedisCacheClient;
}

export const DEFAULT_REDIS_COMMAND_TIMEOUT_MS = 1_000;
```

The client is a narrow command wrapper, not a connection manager. It must
implement `get`, `set`, and `delete`, with `set` receiving a TTL in milliseconds.
For `node-redis`:

```ts
const store = new RedisCacheStore({
  client: {
    get: (key) => client.get(key),
    set: (key, value, ttlMs) => client.set(key, value, { PX: ttlMs }),
    delete: (key) => client.del(key),
  },
});
```

The adapter accepts only current-version hashed keys from `createCacheKey`,
serializes and validates values with `assertJsonCacheValue`, and enforces entry
size (default 256 KiB) and TTL (default 3,600 seconds). `get` returns `undefined`
for a Redis `null`/`undefined` and parses each value into an isolated object; a
corrupt, oversized, or non-JSON value rejects, and the runtime treats that as a
cache bypass. `delete` removes one exact entry.

`keyPrefix` is an optional literal namespace of 1-128 printable ASCII
characters, prepended to every storage key. Changing it makes old entries
unreachable, so rotate it deliberately. Each Redis command is bounded by
`commandTimeoutMs` (default 1,000 ms). The timeout rejects the adapter promise
but does not cancel the underlying client command; configure socket and command
timeouts in the client as well. The adapter does not manage connections,
credentials, TLS, retries, eviction policy, or cluster topology. See
`docs/caching.md` and ADR 0014.

## `@chainmcp/auth`

The auth package holds identity, authorization, secret storage, and credential abstractions:

```ts
export class OperationScopeAuthorizer implements Authorizer {
  authorize(tool: ToolDefinition, context: ToolContext): void;
}

export interface SecretStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export class InMemorySecretStore implements SecretStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): void;
}

export interface EncryptedSecretStoreOptions {
  store: SecretStore;
  activeKeyId: string;
  keys: KeyRing;
}

export class EncryptedSecretStore implements SecretStore {
  constructor(options: EncryptedSecretStoreOptions);
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  rotate(key: string, targetKeyId?: string): Promise<boolean>;
}

export interface UpstreamCredentialProvider {
  resolveCredential(
    context: CredentialResolutionContext,
  ): Promise<UpstreamCredential | undefined>;
}

export class StaticCredentialProvider implements UpstreamCredentialProvider {
  constructor(options: StaticCredentialProviderOptions);
  resolveCredential(
    context: CredentialResolutionContext,
  ): Promise<UpstreamCredential | undefined>;
}

export class EnvCredentialProvider implements UpstreamCredentialProvider {
  constructor(options?: EnvCredentialProviderOptions);
  resolveCredential(
    context: CredentialResolutionContext,
  ): Promise<UpstreamCredential | undefined>;
}

export class SecretStoreCredentialProvider implements UpstreamCredentialProvider {
  constructor(options: SecretStoreCredentialProviderOptions);
  resolveCredential(
    context: CredentialResolutionContext,
  ): Promise<UpstreamCredential | undefined>;
}

export class CompositeCredentialProvider implements UpstreamCredentialProvider {
  constructor(providers: readonly UpstreamCredentialProvider[]);
  resolveCredential(
    context: CredentialResolutionContext,
  ): Promise<UpstreamCredential | undefined>;
}

export interface SecretStoreCredentialProviderOptions {
  store: SecretStore;
  allowGlobalFallback?: boolean;
  deriveStoreKey?: (
    context: CredentialResolutionContext,
  ) => string | readonly string[];
}

export const MAX_SECRET_KEY_LENGTH = 256;
export function encodeSecretKeySegment(value: string): string;
export function buildCredentialStoreKey(options: {
  tenantId?: string;
  schemeName: string;
}): string;
export function buildOAuthTokenStoreKey(options: {
  tenantId: string;
  principalId?: string;
  schemeName: string;
  normalizedScopes: string;
}): string;

export function normalizeUpstreamCredential(
  value: unknown,
): UpstreamCredential | undefined;

export interface OAuthTokenFetcherOptions {
  signal?: AbortSignal;
  allowedHosts?: readonly string[];
  allowAnyTokenHost?: boolean;
  allowInsecureHttp?: boolean;
  maxResponseBytes?: number;
}

export type OAuthTokenFetcher = (
  url: string,
  body: URLSearchParams,
  headers: Readonly<Record<string, string>>,
  options?: OAuthTokenFetcherOptions,
) => Promise<OAuthTokenResponse>;

export const DEFAULT_TOKEN_TIMEOUT_MS = 10_000;
export const MAX_TOKEN_RESPONSE_BYTES = 65_536;
export const MAX_TOKEN_URL_LENGTH = 8_192;
export function defaultTokenFetcher(
  url: string,
  body: URLSearchParams,
  headers: Readonly<Record<string, string>>,
  options?: OAuthTokenFetcherOptions,
): Promise<OAuthTokenResponse>;

export interface OAuthClientCredentialsConfig {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scopes?: readonly string[];
  schemeNames?: readonly string[];
  expirySkewSeconds?: number;
  allowedTokenHosts?: readonly string[];
  allowAnyTokenHost?: boolean;
  allowInsecureHttp?: boolean;
  fetchToken?: OAuthTokenFetcher;
  tokenStore?: SecretStore;
  now?: () => number;
}

export class OAuthClientCredentialsProvider implements UpstreamCredentialProvider {
  constructor(config: OAuthClientCredentialsConfig);
  resolveCredential(
    context: CredentialResolutionContext,
  ): Promise<UpstreamCredential | undefined>;
  invalidate(
    tenantId?: string,
    schemeName?: string,
    principalId?: string,
  ): Promise<void>;
}
```

`OperationScopeAuthorizer` enforces `tool.operation.requiredScopes` as a subset of
`context.principal.scopes`:

- Matching is plain set membership: exact, case-sensitive scope tokens, with
  no wildcard, pattern, or hierarchical semantics.
- Duplicates in either list do not affect the decision.
- A missing or empty `requiredScopes` list imposes no requirement, so tools
  that must be restricted by scope must declare their requirements.
- Tenancy is not evaluated here. The multi-tenant tenant match and the
  pinned single-tenant match are enforced structurally by tenant-scoped
  resolution (ADR 0008), so this authorizer cannot weaken them and may be
  composed with additional custom authorizers for stronger rules.
- Denial follows the authorization-stage contract (ADR 0006): the authorizer
  throws `RuntimeError("AUTH_FORBIDDEN")` with the safe `Access denied`
  message; the ungranted requirements are retained only as a protected
  diagnostic `cause`, never in the client-facing message or metrics event.
  Any `requiredScopes` entry that is not a string, or a principal with no
  scope list, denies the call rather than failing open.

`EncryptedSecretStore` protects secrets at rest using authenticated AES-256-GCM encryption with 96-bit random IVs, 128-bit authentication tags, and key-name AAD binding. Missing keys, tampered ciphertext, or swapped records fail closed.

`buildCredentialStoreKey` and `buildOAuthTokenStoreKey` derive valid store keys from tenant, principal, scheme, and scope values. Each segment is base64url-encoded, so identifiers that contain characters outside the key grammar cannot break lookup or collide with another identifier, and keys longer than `MAX_SECRET_KEY_LENGTH` are replaced by a stable SHA-256 digest. `encodeSecretKeySegment` exposes the segment encoding.

`normalizeUpstreamCredential` validates untrusted credential material and returns a normalized credential or `undefined`. Providers are deployment code, so a value with an unknown `type`, a missing secret, an invalid `location`, or a malformed optional field is treated as unresolved instead of being passed to request construction.

`SecretStoreCredentialProvider` reads `buildCredentialStoreKey({ tenantId, schemeName })` only. A tenant without its own entry does not inherit a deployment-wide credential; set `allowGlobalFallback: true` to fall back to `buildCredentialStoreKey({ schemeName })`, or pass `deriveStoreKey` for a custom layout.

`OAuthClientCredentialsProvider` handles upstream OAuth 2.0 client credentials grants, automatic token caching, expiry detection with safety margin, and automatic refresh. A client credentials token has no refresh token, so expiry means re-acquiring it. Token cache entries are partitioned by tenant, principal, scheme, and normalized scopes under `buildOAuthTokenStoreKey`, and a token-store read or write failure bypasses the cache instead of failing the call. `invalidate(tenantId?, schemeName?, principalId?)` drops matching in-memory entries and deletes their persistent copies; with no arguments it clears every token the instance knows about. Because `SecretStore` has no scan operation, entries written by another process that this instance never loaded cannot be enumerated; delete `buildOAuthTokenStoreKey(...)` from the shared store or rely on token expiry for cross-process revocation.

The token endpoint is subject to an explicit policy. `OAuthClientCredentialsProvider` requires `allowedTokenHosts` (exact hostnames, no wildcards) or the explicit `allowAnyTokenHost: true` opt-out, forwards them through `OAuthTokenFetcherOptions`, and requires HTTPS unless `allowInsecureHttp` is set. `defaultTokenFetcher` refuses URL credentials, refuses redirects instead of following them, enforces `MAX_TOKEN_URL_LENGTH`, caps the response at `MAX_TOKEN_RESPONSE_BYTES`, and applies `DEFAULT_TOKEN_TIMEOUT_MS`. It uses the platform fetch, so it cannot pin the resolved address; when the provider runs inside `@chainmcp/executor`, the executor supplies `CredentialResolutionContext.tokenEndpointFetch`, which resolves and pins the token endpoint through the same destination policy and transport as upstream requests.

## `@chainmcp/rate-limit`

The rate-limit package provides quota and concurrency control for single-process and distributed deployments:

```ts
export interface QuotaPolicy {
  maxRequests: number;
  windowMs: number;
}

export interface ConcurrencyPolicy {
  maxConcurrent: number;
  ttlSeconds?: number;
}

export interface InMemoryRateLimiterOptions extends RateLimitRules {
  now?: () => number;
  maxTrackedWindows?: number; // default 10,000
}

export class InMemoryRateLimiter implements RateLimiter {
  constructor(options?: InMemoryRateLimiterOptions);
  check(context: ToolContext, toolName: string): Promise<RateLimitDecision>;
  release(context: ToolContext, toolName: string): Promise<void>;
  reset(): void;
  readonly trackedWindowCount: number;
}

export interface RedisRateLimitClient {
  eval(script: string, keys: string[], args: string[]): Promise<unknown>;
}

export class DistributedRateLimiter implements RateLimiter {
  constructor(options: DistributedRateLimiterOptions);
  readonly client: RedisRateLimitClient;
  readonly failurePolicy: "fail-closed" | "fail-open";
  check(context: ToolContext, toolName: string): Promise<RateLimitDecision>;
  release(context: ToolContext, toolName: string): Promise<void>;
}
```

Quotas and concurrency can be partitioned globally, by tenant, by principal, or by tool. Denied calls produce `{ allowed: false, retryAfterSeconds }`. Quota denials report when the oldest request leaves the window; concurrency denials report a conservative lower bound of one second.

`InMemoryRateLimiter` retains at most `maxTrackedWindows` sliding windows (default 10,000) and evicts the least recently used one first, which bounds memory when callers keep presenting new identities. Eviction forgets that identity's history, so it can make one extra request before its window is rebuilt; use `DistributedRateLimiter` when strict counting across many identities matters more than local memory. Expired windows are dropped immediately and `trackedWindowCount` reports the current size.

In distributed deployments, atomic Redis Lua scripts ensure quota and concurrency limits are enforced across server processes without race conditions. Every matching scope is evaluated for each call and the scopes recorded before a denial are rolled back, so a rejected call never consumes another scope's budget; rollback failures are isolated and can only over-count. Concurrency slots are acquired before tool execution and released in a `finally` block upon completion, with a safety TTL (default 60 seconds) for crashed holders. The Lua scripts are proven against a real Redis by the opt-in integration suite described in `DEVELOPMENT.md`.

## `@chainmcp/json-navigation`

Safe, resource-bounded JSON exploration and schema inspection:

```ts
export function inspectShape(
  data: unknown,
  options?: InspectShapeOptions,
): ShapeSummary;

export function selectPath(
  data: unknown,
  path: string | CompiledPath,
  options?: NavigationLimits,
): unknown;

export function parseJsonPath(path: string): CompiledPath;

export function paginate<T = unknown>(
  data: unknown,
  options?: PaginationOptions,
): PaginatedResult<T>;

export function filterData<T = unknown>(
  data: unknown,
  filter: FilterExpression,
  options?: NavigationLimits,
): T[];

export function createJsonNavigationTools(
  limits?: NavigationLimits,
): ToolDefinition[];
```

### Invariants and Limits

- `NavigationBudget` enforces `maxDepth` (default 16, hard maximum 64), `maxVisitedNodes` (default 50,000), `maxArrayItems` (default 1,000), `maxResultBytes` (default 50,000 bytes), and `timeoutMs` (default 5,000ms).
- Circular references in shapes throw `JsonNavigationError`.
- Prototype pollution targets (`__proto__`, `prototype`, `constructor`) are strictly rejected across all selectors and filters.
- Never evaluates dynamic code (`eval`, `new Function`); all selectors are linear-time AST-evaluated.
- Navigation tools never bypass upstream authorization or projection policies.

## `@chainmcp/analytics`

Structured logging, multi-sink routing, secret redaction, and OpenTelemetry integration:

```ts
export function createLogger(options?: LoggerOptions): StructuredLogger;

export class OpenTelemetryMetricsSink implements MetricsSink {
  constructor(options?: OpenTelemetryMetricsSinkOptions);
  record(event: RuntimeEvent): void;
}

export class ToolTracer implements CoreToolTracer {
  constructor(options?: ToolTracerOptions);
  startToolSpan(
    toolName: string,
    context: ToolContext,
    contractRevision?: string | undefined,
  ): Span;
  endToolSpan(
    span: Span,
    details?: {
      readonly error?: unknown;
      readonly outcome?: "success" | "error" | "cancelled" | undefined;
      readonly durationMs?: number | undefined;
      readonly cacheOutcome?: "hit" | "miss" | "bypass" | undefined;
      readonly cached?: boolean | undefined;
    },
  ): void;
  startChildSpan(
    name: string,
    attributes?: Record<string, string | number | boolean> | undefined,
  ): Span;
  endSpan(
    span: Span,
    details?: {
      readonly error?: unknown;
      readonly outcome?: "success" | "error" | "cancelled" | undefined;
      readonly durationMs?: number | undefined;
    },
  ): void;
  withSpan<T>(span: Span, fn: () => T): T;
}

export class RollingAnalyticsAggregator implements MetricsSink {
  constructor(options?: AggregatorOptions);
  record(event: RuntimeEvent): void;
  getSummary(filter?: {
    toolName?: string;
    tenantId?: string;
  }): AnalyticsSummary;
  clear(): void;
}

export function redactValue(value: unknown, options?: RedactionOptions): unknown;
export function redactString(input: string): string;

export class MemorySink implements LogSink { ... }
export class ConsoleSink implements LogSink { ... }
export class MultiSink implements LogSink { ... }
```

### Telemetry & Redaction Rules

- Key names matching tokens, passwords, keys, or credentials are case-insensitively scrubbed to `"[REDACTED]"`.
- Bearer, Basic, and JWT patterns in strings are sanitized.
- Request and response bodies are excluded by default (`"[EXCLUDED_BODY]"`).
- Security events (authorization denials, rate limit breaches, invalidations) are routed to `auditSink`.
- Logger and metrics delivery failures are fully isolated and never alter tool results.

## `@chainmcp/config`

Configuration schema, validation, and wiring helpers for ChainMcp servers:

```ts
export const ChainMcpConfigSchema: z.ZodType<ChainMcpConfig>;
export function parseConfig(input: unknown): ChainMcpConfig;
export function safeParseConfig(
  input: unknown,
): ReturnType<typeof ChainMcpConfigSchema.safeParse>;

export interface BuildExecutorOptionsOverrides extends Partial<UpstreamExecutorOptions> {
  baseUrl?: string;
}

export function buildExecutorOptions(
  config: ChainMcpConfig,
  overrides?: BuildExecutorOptionsOverrides,
  factoryOptions?: CredentialProviderFactoryOptions,
): UpstreamExecutorOptions;

export function buildRuntimeOptions(
  config: ChainMcpConfig,
  overrides?: Partial<RuntimeOptions>,
  factoryOptions?: {
    rateLimiterOptions?: RateLimiterFactoryOptions;
    env?: Record<string, string | undefined>;
    diagnosticSink?: LogSink;
    auditSink?: LogSink;
  },
): RuntimeOptions;

export function createRateLimiterFromConfig(
  config: RateLimitConfig,
  options?: RateLimiterFactoryOptions,
): RateLimiter | undefined;

export function logRateLimiterStartup(
  config: RateLimitConfig,
  options?: {
    logger?: Logger | undefined;
    client?: RedisRateLimitClient | undefined;
  },
): Promise<RateLimiterStartupHealth | undefined>;

export function createAuthorizerFromConfig(
  config: InboundAuthConfig,
): Authorizer | undefined;

export function createUpstreamCredentialProviderFromConfig(
  config: UpstreamAuthConfig,
  options?: CredentialProviderFactoryOptions,
): UpstreamCredentialProvider | undefined;

export function createLoggerFromConfig(
  config: LoggingConfig,
  options?: LoggerFromConfigOptions,
): Logger;

export function createNavigationLimitsFromConfig(
  config: JsonNavigationConfig,
): NavigationLimits;
```

### Configuration Sections

- **`server`:** Configures transport (`stdio` or `http`), host, port, `requestTimeoutMs` (default 15,000ms), `maxResponseBytes` (default 1,000,000 bytes; aborts JSON serialization mid-stream upon breach), `maxRequestBytes` (default 1,048,576 bytes), `maxToolInputBytes` (default 1,048,576 bytes; capped pre-validation), `validateResponses` (`off` | `warn` | `enforce`, default `warn`), `allowedHosts`, `allowedOrigins`, `enableDnsRebindingProtection`, and `cors`.
- **`security`:** Configures `requireInboundAuth`, `allowUnauthenticatedHttp`, `allowInsecureHttp`, `allowedUpstreamHosts`, and `redactHeaders`. Each host in `allowedUpstreamHosts` is strictly validated against schemes, ports, paths, queries, credentials, and wildcards, and normalized to canonical lowercase. `allowInsecureHttp` defaults to `false` and must be enabled to permit `http://` upstream traffic.
- **`rateLimit`:** Configures in-memory or Redis distributed rate limiting with shorthand (`requestsPerMinute`, `concurrency`) or explicit global, tenant, and tool quotas.
- **`auth`:** Configures inbound authorization (`authorizer: "scope"`) and upstream credential providers (`static`, `env`, `secretStore`, `oauth`).
- **`logging`:** Configures structured logger level, destination (`stdout`, `stderr`, `memory`), redaction keys, and body exclusion. Overridable via `CHAINMCP_LOG_LEVEL`.
- **`jsonNavigation`:** Configures bounds for JSON exploration tools (`maxDepth`, `maxArrayItems`, `maxResultBytes`, `maxVisitedNodes`, `timeoutMs`).
- **`analytics`:** Configures telemetry retention, arguments/body exclusion, and OpenTelemetry integration.
- **`contract`:** Configures OpenAPI contract specification file (`source`), strict validation mode (`strict`), and optional target upstream base URL (`baseUrl`). `contract.baseUrl` accepts absolute `http://` or `https://` URLs, preserves port and path prefix, normalizes trailing slashes, and auto-derives its host into `security.allowedUpstreamHosts`.

### Wiring Helpers

- `buildExecutorOptions(config, overrides)` maps `config.contract.baseUrl` (or fallback to `allowedUpstreamHosts[0]`) to `baseUrl`, `security.allowedUpstreamHosts` to `allowedHosts`, `security.allowInsecureHttp` to `allowInsecureHttp`, `server.requestTimeoutMs` to `timeoutMs`, `server.maxResponseBytes` to `maxResponseBytes`, `server.validateResponses` to `validateResponses`, `config.logging` to `logger`, and `auth.upstream` to `credentialProvider`. Fails closed if `allowedUpstreamHosts` is empty or no base URL can be resolved.
- `buildRuntimeOptions(config, overrides, factoryOptions)` maps `security.requireInboundAuth` / `auth.inbound` to `authorizer`, `config.rateLimit` to `rateLimiter`, `config.logging` to `logger`, `config.analytics` to `metrics`, `config.analytics.openTelemetry.tracing` to `tracer` (`ToolTracer`), `server.requestTimeoutMs` to `defaultTimeoutMs`, `server.maxToolInputBytes` to `maxToolInputBytes`, and `server.maxResponseBytes` to `maxResponseBytes`.

## Error codes

Public-facing errors use stable codes such as:

- `CONFIG_INVALID`
- `CONTRACT_INVALID`
- `TOOL_NOT_FOUND`
- `INPUT_INVALID`
- `INPUT_TOO_LARGE`
- `AUTH_REQUIRED`
- `AUTH_FORBIDDEN`
- `RATE_LIMITED`
- `OUTPUT_POLICY_VIOLATION`
- `OUTPUT_LIMIT_EXCEEDED`
- `UPSTREAM_TIMEOUT`
- `UPSTREAM_FAILURE`
- `RESPONSE_TOO_LARGE`
- `POLICY_DENIED`

Never expose stack traces or credential values to MCP clients.

## `@chainmcp/authoring`

The `@chainmcp/authoring` package provides code-first tool authoring capabilities, schema lowering, and manual tool sources. Tools defined in application code pass through the exact same registration audit, authorization, validation, rate limiting, caching, cancellation, output policy, and error masking pipeline as compiled tools.

### `defineTool`

```ts
export function defineTool<TInput = unknown, TOutput = unknown>(
  options: DefineToolOptions<TInput, TOutput>,
): ToolDefinition<TInput, TOutput>;
```

Defines an MCP tool with definition-time schema lowering and audit. Accepts either a Zod schema (`schema`) or raw JSON Schema (`inputSchema`), and rejects unsupported constructs (unions, recursive lazy schemas, functions) immediately at definition time.

```ts
export interface DefineToolOptions<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  schema?: z.ZodType<TInput>;
  inputSchema?: JsonSchema;
  operation?: OperationPolicy;
  cache?: ToolCachePolicy;
  output?: ToolOutputPolicy;
  contractRevision?: string;
  version?: string;
  ownerTenantId?: string;
  timeoutMs?: number;
  execute(input: TInput, context: ToolContext): Promise<TOutput>;
}
```

### `ManualToolSource`

```ts
export class ManualToolSource implements ToolSource {
  constructor(tools?: readonly ToolDefinition[]);
  addTool(tool: ToolDefinition): this;
  defineTool<TInput = unknown, TOutput = unknown>(
    options: DefineToolOptions<TInput, TOutput>,
  ): ToolDefinition<TInput, TOutput>;
  getTools(): readonly ToolDefinition[];
}

export function createManualToolSource(
  tools?: readonly ToolDefinition[],
): ManualToolSource;
```

Collects hand-written tool definitions and implements `ToolSource` so they can be registered via `runtime.registerSource(source)`.

### `zodToJsonSchema`

```ts
export function zodToJsonSchema(schema: z.ZodTypeAny): JsonSchema;
```

Lowers a Zod schema to the audited JSON Schema subset supported by ChainMcp. Asserts that the root is an object schema, strips metadata keywords (`$schema`, `$id`), and verifies compatibility using `auditInputSchema`.

### `AuthoringError`

```ts
export type AuthoringErrorCode =
  | "SCHEMA_NOT_OBJECT"
  | "SCHEMA_AUDIT_FAILED"
  | "SCHEMA_LOWERING_FAILED"
  | "INVALID_TOOL_DEFINITION";

export class AuthoringError extends Error {
  public readonly code: AuthoringErrorCode;
  public readonly diagnostics?: readonly SchemaDiagnostic[];
}
```

## `@chainmcp/server`

`createMcpServer(runtime, options)` adapts the shared `ToolRuntime` to the
official TypeScript MCP SDK. Runtime tool names, descriptions, and supported
input schemas are exposed through `tools/list`; calls go through
`ToolRuntime.callTool`, preserving runtime authorization, input validation,
rate limiting, cancellation, and telemetry behavior. Listing mode follows the
runtime's tenancy mode (ADR 0008):

- **Single-tenant runtimes** (any runtime declaring `tenantMode: "single-tenant"`) are snapshot-adapted: tools are
  enumerated once at `createMcpServer` and registered with the SDK as tool
  callbacks. New registrations after creation are not observed.
- **Multi-tenant runtimes** (any runtime declaring `tenantMode: "multi-tenant"`,
  including `InMemoryToolRuntime` in that mode) are adapted with low-level
  per-request `tools/list` and `tools/call` handlers. The adapter dispatches on
  the interface declaration rather than on the runtime's concrete class.
  The `tools` capability is declared with `listChanged: false`. Each
  `tools/list` request establishes the caller identity through `createContext`
  and lists only the caller's tenant's tools against the same tenant-scoped
  registry that `callTool` resolves against, so discovery and invocation
  cannot disagree and per-call authorization still runs on every invocation. A
  listing whose identity cannot be established fails closed with a safe
  protocol error and does not reveal tool names. Result serialization, byte
  caps, and safe error mapping are implemented once and shared by both modes.
  Protocol pagination is not implemented; each listing answers once with no
  `nextCursor`, matching the snapshot path.

MCP tools require a non-null object-root input schema (`type: "object"`).
`createMcpServer` rejects a runtime tool with a schema outside the
core-supported subset or without that exact root type instead of exposing a
schema the MCP protocol cannot represent.

`McpServerOptions` requires `name`, `version`, and `createContext`. Its
`createContext(request)` factory receives the SDK request ID, cancellation
signal, and optional HTTP `authInfo`. It is trusted adapter code and must
establish a tenant and principal; values are never accepted from MCP tool
arguments. The MCP request signal is combined with any signal supplied by the
factory. Factory failures fail closed: an untyped failure is classified as
`AUTH_FORBIDDEN`, a typed `RuntimeError` keeps its code, and both produce a
runtime metrics event with `tenantId: "unknown"` because tenant identity is
not yet available.
Tool results are serialized into a text content block using streaming bounded serialization (`stringifyBounded`) capped at a 1 MB UTF-8 byte limit by default (`maxResponseBytes`). Serialization aborts immediately upon exceeding `maxResponseBytes`, recursion depth, or node count limits without buffering the full string or evaluating subsequent properties. `maxResponseBytes` may be configured up to 100 MB; values outside that range are rejected at construction. `docs/getting-started.md` shows a
compiled stdio server, and `pnpm conformance:inspector` runs the Inspector CLI
against `tools/list` and `tools/call`. Runtime errors are returned as
`isError: true` results containing only the stable code and adapter-selected
generic message; executor-provided messages and causes are never returned.
`RATE_LIMITED` additionally renders `RuntimeError.retryAfterSeconds` when it is
a whole number of seconds between 1 and 86,400, as
`RATE_LIMITED: Rate limit exceeded. Retry after N seconds`; no other detail
from the limiter is exposed. Unexpected failures use a generic message. No
credentials or causes are returned to clients.

`connectMcpServer(runtime, transport, options)` connects a server to an SDK
transport and returns an idempotent `close()` handle plus a `closed` promise
that resolves when the transport closes. Concurrent `close()` callers await
the same shutdown. `McpServerOptions.onclose` is called when the SDK reports
transport closure; observer exceptions are isolated from teardown.

`serveStdio(runtime, options, stdioOptions)` uses local stdio and closes on
stdin EOF, an optional `AbortSignal`, SIGINT, or SIGTERM. Signal handlers are
removed at closure; SIGINT and SIGTERM set conventional exit codes 130 and 143.
For embedded use and tests, stdin and stdout streams can be injected and
process signal handling can be disabled.

`serveHttp(runtime, options, httpOptions)` starts an HTTP server supporting modern
Streamable HTTP and SSE transports for Model Context Protocol clients.

`HttpServeOptions`:

- `port` (`number`, optional; default `3333`): Port to listen on (use `0` for ephemeral port assignment).
- `host` (`string`, optional; default `"127.0.0.1"`): Host interface to bind to.
- `path` (`string`, optional; default `"/mcp"`): Base path for the MCP endpoint.
- `signal` (`AbortSignal`, optional): Cancellation signal to trigger graceful server shutdown.
- `verifier` (`InboundAuthVerifier`, optional): Inbound verifier to parse and validate caller identity.
- `requireAuth` / `requireInboundAuth` (`boolean`, optional; default `false`): Whether requests must present valid inbound credentials. If `true` and no verifier is provided, startup fails fast.
- `allowUnauthenticatedHttp` (`boolean`, optional; default `false`): Explicitly allows unauthenticated HTTP binding on non-loopback network interfaces. When `false` (the default), binding to a non-loopback host (e.g. `0.0.0.0`, external IPs) without an authenticated verifier fails fast at startup.
- `authorizer` / `authorizerType` (`Authorizer | "scope" | "none"`, optional): Declares the inbound authorizer. If set to `"scope"` without a configured inbound verifier, startup fails fast.
- `toolCount` (`number`, optional): Total count of registered tools reported in unauthenticated startup warnings.
- `warn` (`(message: string, meta?: Record<string, unknown>) => void`, optional): Custom warning handler invoked when starting unauthenticated.
- `info` (`(message: string, meta?: Record<string, unknown>) => void`, optional): Custom info handler invoked to log resolved security posture at startup.
- `cors` (`boolean | HttpCorsOptions`, optional): Whether to enable CORS headers and preflight handling, or explicit CORS options. Defaults to `true` (with wildcard origin warning) on loopback development binds, and defaults to `false` on non-loopback binds unless explicitly enabled or configured with allowed origins.
- `maxRequestBytes` (`number`, optional; default `1048576` = 1 MiB): Hard cap in bytes on incoming request bodies, enforced before buffering and during chunked streaming (rejects with 413 Payload Too Large).
- `allowedHosts` (`string[]`, optional): Allowed Host header hostnames for DNS rebinding protection. Malformed or missing Host headers are rejected with 400 Bad Request; unlisted hosts are rejected with 403 Forbidden.
- `allowedOrigins` (`string[]`, optional): Allowed Origin header hostnames for browser and DNS rebinding protection. Unlisted origins are rejected with 403 Forbidden when protection is enabled.
- `enableDnsRebindingProtection` (`boolean`, optional; default `false`): Enables strict Host and Origin allowlist validation.
- `requestTimeoutMs` (`number`, optional; default `15000`): Request timeout in milliseconds applied to the HTTP server and incoming body reads.
- `handleProcessSignals` (`boolean`, optional; default `true`): Installs SIGINT/SIGTERM handlers and sets standard process exit codes.

`HttpCorsOptions`:

- `enabled` (`boolean`, optional): Explicitly toggles CORS headers and preflight handling.
- `allowedOrigins` (`string[]`, optional): Exact origins permitted to make cross-origin requests. Wildcard `"*"` is supported for uncredentialed access, but rejected at startup if combined with `allowCredentials: true`. Sandboxed `"null"` origin is rejected unless explicitly listed in `allowedOrigins`.
- `allowedHeaders` (`string[]`, optional): Extra headers permitted in cross-origin requests, appended to standard defaults (`Content-Type`, `Authorization`, `X-API-Key`, `Accept`, `mcp-session-id`, `last-event-id`) and inbound verifier header names (`verifier.headerNames`).
- `allowCredentials` (`boolean`, optional; default `false`): Enables `Access-Control-Allow-Credentials: true` when origin matches. Never permitted with wildcard origin `"*"`.
- `maxAgeSeconds` (`number`, optional; default `600`): Preflight cache duration in seconds (`Access-Control-Max-Age`).

`InboundAuthVerifier`:

```typescript
export interface InboundAuthVerifier {
  readonly headerNames?: readonly string[] | undefined;
  verify(
    request: InboundAuthRequest,
  ): Promise<InboundAuthResult | undefined> | InboundAuthResult | undefined;
}
```

Built-in verifiers (`createBearerTokenVerifier`, `createApiKeyVerifier`, `createJwtVerifier`, `createCompositeVerifier`) expose their inspected header names (`headerNames`) so CORS `Access-Control-Allow-Headers` can be dynamically computed without drift.

## `@chainmcp/cli`

The `@chainmcp/cli` package implements developer commands and generated server scaffolding and export capabilities.

### CLI Binary

Exported as the `chainmcp` executable (`dist/bin.js`).

```bash
chainmcp init [--spec <path|url>] [--blank] [--output <dir>] [--name <name>] [--base-url <url>] [--allow-http] [--force]
chainmcp validate [--config <path>] [--spec <path|url>] [--strict] [--json] [--allow-http] [--require-contract]
chainmcp build [--config <path>] [--spec <path|url>] [--out-dir <dir>] [--allow-http] [--check] [--require-contract]
chainmcp diff [--config <path>] [--spec <path|url>] [--against <target>] [--fail-on <breaking|breaking+potential|none>] [--fail-on-breaking] [--json] [--allow-http]
chainmcp serve [--config <path>] [--spec <path|url>] [--transport <stdio|http>] [--port <number>] [--host <string>] [--path <string>] [--allow-unauthenticated-http] [--allow-http] [--base-url <url>] [--tenant <id>] [--require-contract]
chainmcp gateway serve [--config <path>] [--transport <stdio|http>] [--port <number>] [--host <string>] [--path <string>] [--allow-unauthenticated-http] [--tenant <id>]
chainmcp dev [--config <path>] [--spec <path|url>] [--base-url <url>] [--allow-http] [--tenant <id>]
chainmcp export [--config <path>] [--spec <path|url>] [--output <dir>] [--allow-http] [--force] [--check] [--require-contract]
```

### Programmatic API

```ts
export function runCli(args: string[], io?: CliIo): Promise<number>;

export function initCommand(options: InitOptions): Promise<InitResult>;
export function validateCommand(
  options: ValidateOptions,
): Promise<ValidateResult>;
export function buildCommand(options: BuildOptions): Promise<BuildResult>;
export function diffCommand(options: DiffOptions): Promise<DiffResult>;
export function serveCommand(options: ServeOptions): Promise<ServeResult>;
export function gatewayServeCommand(
  options: GatewayServeOptions,
): Promise<GatewayServeResult>;
export function devCommand(options: DevOptions): Promise<DevResult>;
export function exportCommand(options: ExportOptions): Promise<ExportResult>;

export function loadSpec(options: LoadSpecOptions): Promise<LoadedSpec>;

export interface LoadSpecOptions {
  source: string;
  allowHttp?: boolean | undefined;
  timeoutMs?: number | undefined;
  maxBytes?: number | undefined;
  maxRedirects?: number | undefined;
  allowPrivateHosts?: boolean | undefined;
  signal?: AbortSignal | undefined;
  cwd?: string | undefined;
  rejectUnauthorized?: boolean | undefined;
  resolver?: HostResolver | undefined;
}

export interface LoadedSpec {
  content: string;
  sourceKind: "file" | "url";
  resolvedSource: string;
  bytes: number;
  contentType?: string | undefined;
}

export function buildProjectManifest(
  projectName: string,
  compiled: CompileResult,
  options?: { generatedAt?: string },
): ProjectManifest;

export function buildCodeFirstManifest(
  projectName: string,
  tools: readonly ToolDefinition[],
  options?: { sourceHash?: string; generatedAt?: string },
): ProjectManifest;

export function verifyProjectManifest(
  existing: ProjectManifest,
  recompiled: ProjectManifest,
): ManifestVerificationResult;

export function loadCodeFirstTools(
  options: LoadCodeFirstToolsOptions,
): Promise<LoadedCodeFirstTools>;

export function discoverCodeFirstEntrypoint(
  cwd: string,
  explicitEntrypoint?: string,
): Promise<DiscoveredEntrypoint | undefined>;

export function extractToolNamesFromSource(source: string): string[];

export type DiffFailOn = "breaking" | "breaking+potential" | "none";

export interface DiffOptions {
  config?: string | undefined;
  spec?: string | undefined;
  against?: string | undefined;
  allowHttp?: boolean | undefined;
  failOn?: DiffFailOn | undefined;
  failOnBreaking?: boolean | undefined;
  json?: boolean | undefined;
  cwd?: string | undefined;
}

export interface DiffResult {
  schemaVersion: 1;
  ok: boolean;
  contractRevision: string;
  sourceHash: string;
  toolsetHash: string;
  hasChanges: boolean;
  hasBreakingChanges: boolean;
  hasPotentiallyBreakingChanges: boolean;
  summary: {
    breaking: number;
    potentiallyBreaking: number;
    nonBreaking: number;
  };
  addedTools: readonly string[];
  removedTools: readonly string[];
  changedTools: readonly string[];
  unchangedTools: readonly string[];
  changes: readonly ContractChange[];
  breaking: readonly ContractChange[];
  potentiallyBreaking: readonly ContractChange[];
  nonBreaking: readonly ContractChange[];
  error?: string | undefined;
}
```

### Manifest Schema (`chainmcp.manifest.json`)

```ts
export interface ProjectManifest {
  manifestVersion: 1;
  generatorVersion: string;
  compilerVersion: string;
  openapiVersion?: string | undefined;
  projectName: string;
  contractRevision?: string | undefined;
  sourceHash: string;
  toolsetHash: string;
  toolCount: number;
  tools: readonly {
    name: string;
    hash: string;
  }[];
  warnings?: readonly CompileDiagnostic[];
  generatedAt: string;
}
```

## `@chainmcp/gateway`

The `@chainmcp/gateway` package implements the multi-tenant dynamic gateway, versioned contract registry, atomic revision activation, and rollback capabilities.

### Interfaces and Types

```ts
export type ContractRevisionStatus =
  "candidate" | "active" | "disabled" | "superseded" | "rolled_back";

export interface ContractDestinationPolicy {
  readonly baseUrl: string;
  readonly allowedHosts: readonly string[];
  readonly allowInsecureHttp?: boolean | undefined;
}

export interface ContractAuthConfig {
  readonly requiredScopes?: readonly string[] | undefined;
  readonly credentialProvider?: UpstreamCredentialProvider | undefined;
}

export interface ContractLimits {
  readonly timeoutMs?: number | undefined;
  readonly maxResponseBytes?: number | undefined;
  readonly maxRequestBytes?: number | undefined;
  readonly maxRedirects?: number | undefined;
}

export interface ContractRevision {
  readonly revisionId: string;
  readonly contractName: string;
  readonly tenantId: string;
  readonly sourceHash: string;
  readonly createdAt: number;
  readonly status: ContractRevisionStatus;
  readonly tools: readonly ToolDefinition[];
  readonly destinationPolicy: ContractDestinationPolicy;
  readonly authConfig?: ContractAuthConfig | undefined;
  readonly limits?: ContractLimits | undefined;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
}

export interface PublishContractOptions {
  readonly tenantId: string;
  readonly contractName: string;
  readonly source?: string | undefined;
  readonly tools?: readonly ToolDefinition[] | undefined;
  readonly destinationPolicy: ContractDestinationPolicy;
  readonly authConfig?: ContractAuthConfig | undefined;
  readonly limits?: ContractLimits | undefined;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
  readonly autoActivate?: boolean | undefined;
}

export type GatewayAuditEventType =
  | "contract_published"
  | "contract_activated"
  | "contract_disabled"
  | "contract_rolled_back"
  | "tenant_resolution_failed";

export interface GatewayAuditEvent {
  readonly type: GatewayAuditEventType;
  readonly timestamp: number;
  readonly tenantId: string;
  readonly contractName: string;
  readonly revisionId: string;
  readonly previousRevisionId?: string | undefined;
  readonly toolCount: number;
  readonly details?: Readonly<Record<string, unknown>> | undefined;
}

export type GatewayAuditSink = (
  event: GatewayAuditEvent,
) => void | Promise<void>;

export interface DynamicGatewayOptions {
  readonly authorizer?: Authorizer | undefined;
  readonly rateLimiter?: RateLimiter | undefined;
  readonly cache?: RuntimeCacheOptions | undefined;
  readonly tokenizer?: Tokenizer | undefined;
  readonly projector?: ResultProjector | undefined;
  readonly metrics?: MetricsSink | undefined;
  readonly logger?: Logger | undefined;
  readonly auditSink?: GatewayAuditSink | undefined;
  readonly resolveHost?: HostResolver | undefined;
  readonly transport?: UpstreamTransport | undefined;
  readonly defaultTimeoutMs?: number | undefined;
  readonly now?: (() => number) | undefined;
  readonly monotonicNow?: (() => number) | undefined;
}
```

### Classes and Functions

```ts
export class ContractRegistry {
  createRevision(options: CreateRevisionOptions): ContractRevision;
  activateRevision(
    tenantId: string,
    contractName: string,
    revisionId: string,
  ): ActivationResult;
  disableRevision(
    tenantId: string,
    contractName: string,
    revisionId?: string,
  ): ContractRevision;
  rollbackRevision(
    tenantId: string,
    contractName: string,
    targetRevisionId: string,
  ): RollbackResult;
  getActiveRevision(
    tenantId: string,
    contractName: string,
  ): ContractRevision | undefined;
  getRevision(revisionId: string): ContractRevision | undefined;
  listRevisions(
    tenantId: string,
    contractName?: string,
  ): readonly ContractRevision[];
  listActiveRevisions(tenantId?: string): readonly ContractRevision[];
}

export class DynamicGateway implements ToolRuntime {
  readonly tenantMode: "multi-tenant";
  constructor(options?: DynamicGatewayOptions);
  getRegistry(): ContractRegistry;
  publishContract(options: PublishContractOptions): Promise<ContractRevision>;
  activateRevision(
    tenantId: string,
    contractName: string,
    revisionId: string,
  ): Promise<ContractRevision>;
  disableContract(
    tenantId: string,
    contractName: string,
  ): Promise<ContractRevision>;
  rollbackContract(
    tenantId: string,
    contractName: string,
    targetRevisionId: string,
  ): Promise<ContractRevision>;
  listTools(context?: ToolContext): ReadonlyArray<ToolSummary>;
  callTool(
    name: string,
    input: unknown,
    context: ToolContext | ToolContextFactory,
  ): Promise<unknown>;
  invalidateCachedResult?(
    name: string,
    input: unknown,
    context: ToolContext,
  ): Promise<void>;
  register(tool: ToolDefinition): void;
  registerSource(source: ToolSource): Promise<void>;
}

export function createGatewayServer(
  gateway: DynamicGateway,
  options: GatewayServerOptions,
): McpServer;

export function connectGatewayServer(
  gateway: DynamicGateway,
  transport: Transport,
  options: GatewayServerOptions,
): Promise<ConnectedMcpServer>;
```

## Compatibility

Public APIs are subject to Semantic Versioning once stable. Before version 1.0, breaking changes must be documented in `CHANGELOG.md`.

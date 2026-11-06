# API Reference: @chainmcp/core

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
`CONTRACT_INVALID`, not a silent no-op (ADR 0012). Exact token measurement
requires a configured tokenizer factory; `packages/config/src/index.ts:435` only
accepts `approximate` / `none`, so `maxTokens` enforcement is approximate in
every CLI deployment until a tokenizer factory is registered.

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

  /** Releases runtime-owned resources once; idempotent and concurrency-safe. */
  close?(): Promise<void>;
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

`createCacheKey` returns an opaque, fixed-length key of the form `chainmcp:cache:v2:<64 lowercase hex characters>`. It requires a stable, non-secret `authorizationPartition` and hashes the tenant, principal, authorization partition, contract revision, tool identity, and canonicalized arguments with SHA-256 under a versioned domain separator. The partition should represent effective grants or policy state; never pass a bearer token. Identity fields must be non-empty after trimming, so a blank partition is rejected instead of silently merging authorization contexts. Object properties whose value is `undefined` are omitted; `undefined` at the root or in arrays, sparse arrays, cycles, non-finite numbers, and non-JSON values are rejected. Canonical input is limited to `MAX_CACHE_KEY_INPUT_BYTES` (64 KiB) and arguments are capped at `MAX_CACHE_KEY_DEPTH` (64) levels of nesting; larger or deeper inputs throw `TypeError`. Changing canonicalization, hashed fields, or digest semantics requires incrementing `CACHE_KEY_VERSION`, which changes the key prefix and deliberately invalidates the existing key space. Hashing reduces accidental disclosure but is not encryption; protect the cache store and do not treat keys as secrets.

```ts
export const CACHE_KEY_VERSION = "v2";
export const MAX_CACHE_KEY_INPUT_BYTES = 64 * 1024;
export const MAX_CACHE_KEY_DEPTH = 64;

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
recorded as `tokenUsage` with the adapter's exact/estimate label.

Exact measurement requires an exact `Tokenizer`. `@chainmcp/config` loads one
from `tokenMetrics.tokenizer: exact` plus a module or registered factory, and
fails startup when no source is configured; `approximate` remains an estimate.
Budgets are integers in the adapter's token units; with an estimate adapter the
limit is only as accurate as the estimate.

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
  /** Optional: flushes buffered telemetry once during runtime teardown. */
  flush?(): void | Promise<void>;
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

`MetricsSink.record` is invoked after the call settles. Synchronous throws and rejected promises are ignored so telemetry cannot change the tool result. Events must not contain secrets, raw authorization data, or unrestricted request and response bodies. A sink may implement `flush()` for buffered exporters; `InMemoryToolRuntime.close()` calls it at most once, then invokes `RuntimeOptions.onShutdown()`. Both hooks are failure-isolated, concurrent `close()` callers share one promise, and the runtime never uses them to cancel in-flight calls (cancellation travels through `ToolContext.signal`).

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

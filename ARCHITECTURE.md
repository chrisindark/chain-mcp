# Architecture

## 1. Overview

The target architecture consists of a contract compiler, shared runtime, MCP adapters, optional infrastructure adapters, and two deployment modes. The current implementation contains `@chainmcp/core`, `@chainmcp/config`, `@chainmcp/auth`, `@chainmcp/cache-redis`, `@chainmcp/compiler`, and `@chainmcp/server`; remaining components shown below are planned.

```text
                    API contract
                         |
                  Contract compiler
                         |
                   Tool definitions
                         |
             +-----------+-----------+
             |                       |
       Generated server        Dynamic gateway
             |                       |
             +-----------+-----------+
                         |
                   Shared runtime
                         |
      +------------------+------------------+
      |          |          |        |      |
     Auth       Cache    Rate limit Metrics JSON
      |          |          |        |    navigation
      +------------------+------------------+
                         |
                  Upstream HTTP API
```

## 2. Design goals

- Keep policy logic independent of transport.
- Use one runtime for generated and dynamic execution.
- Make infrastructure dependencies optional and replaceable.
- Ensure contract compilation is deterministic.
- Isolate tenants, principals, credentials, and cached data.
- Make failures observable without exposing sensitive information.

## 3. Monorepo package boundaries

Currently implemented workspace packages are `@chainmcp/core`, `@chainmcp/config`, `@chainmcp/auth`, `@chainmcp/cache-redis`, `@chainmcp/compiler`, and `@chainmcp/server`. Remaining rows describe planned boundaries; no empty packages are created for them.

| Package                     | Responsibility                                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------------ |
| `@chainmcp/core`            | Runtime interfaces, registry, execution pipeline, errors                                               |
| `@chainmcp/compiler`        | OpenAPI parsing, validation, tool generation                                                           |
| `@chainmcp/server`          | Official MCP SDK tool adapter and local stdio transport                                                |
| `@chainmcp/cache-redis`     | Optional shared Redis cache adapter; cache interfaces remain in core                                   |
| `@chainmcp/auth`            | Identity, authorization, and credential abstractions, including the default operation-scope authorizer |
| `@chainmcp/rate-limit`      | Quotas and concurrency limits                                                                          |
| `@chainmcp/analytics`       | Events, metrics, tracing                                                                               |
| `@chainmcp/token-metrics`   | Token measurement and estimates                                                                        |
| `@chainmcp/json-navigation` | Bounded JSON exploration                                                                               |
| `@chainmcp/config`          | Configuration schema and loading                                                                       |
| `@chainmcp/cli`             | Developer commands                                                                                     |
| `apps/gateway`              | Dynamic multi-contract gateway                                                                         |

Use workspace dependencies. Core packages must not directly depend on concrete Redis, PostgreSQL, or cloud SDKs unless the package specifically implements that adapter.

## 4. Runtime execution sequence

Each tool invocation follows this logical sequence:

1. Resolve the contract revision and tool.
2. Authenticate the inbound MCP caller.
3. Resolve tenant and principal identity.
4. Authorize tool access and required scopes.
5. Validate arguments.
6. Enforce rate and concurrency limits.
7. Compute a safe cache key when caching is permitted.
8. Read from cache if eligible.
9. Execute the upstream operation on a miss.
10. Validate and bound the upstream response.
11. Apply approved response projection.
12. Cache only eligible, correctly partitioned results.
13. Measure token usage or a clearly labeled estimate.
14. Emit redacted metrics and trace events.
15. Return the result through the MCP adapter.

Implementations may optimize this sequence only if security and correctness guarantees remain intact.

The runtime supports two tenancy modes (ADR 0008). **Single-tenant** deployments (generated servers and local stdio) resolve by name exactly as before; a pinned tenant stamps unstamped tools at registration and denies callers carrying a different tenant. **Multi-tenant** deployments (the gateway) require an authorizer at construction, bind every tool to an owner tenant at registration, scope tool resolution and listing to the caller's tenant, and reject cross-tenant tools as unresolvable rather than revealing their existence. Tool listing is identity-scoped and computed per call; there is no pre-filtered static snapshot that could drift from invocation behavior.

Timeout and cancellation are cooperative. The runtime creates a per-call `AbortController`, aborts it when the caller cancels or the timeout elapses, and rejects the caller with `CANCELLED` or `UPSTREAM_TIMEOUT`. This does not forcibly terminate `execute` or release resources it has acquired. Tool and executor implementations must observe `context.signal`, bind it to abortable I/O, and release resources in `finally`. A tool that ignores the signal may continue running after the caller has been rejected.

## 5. OpenAPI compiler

`@chainmcp/compiler` converts one OpenAPI 3.0 or 3.1 document into deterministic
operation metadata, including parameter bindings, request-body metadata,
declared response schemas, and authentication policies. The compiler is offline
and emits `CompiledOperation` records. `@chainmcp/executor` is the separate
runtime slice that turns them into `ToolDefinition`s with bounded upstream HTTP
I/O. Credentials, response validation, and generated-server wiring remain
future work.

The pipeline is:

1. Parse one YAML 1.2 or JSON document with duplicate-key, alias, node, depth,
   and byte limits.
2. Validate the version, `info`, `paths`, path items, operations, parameters,
   JSON request bodies, response objects, and security structures.
3. Resolve local `#/...` references only, with cycle and depth limits. Remote
   references are rejected and never fetched.
4. Enumerate operations by sorted path and a fixed method order, so names,
   collisions, diagnostics, and hashes do not depend on source key order.
5. Build an object-root input schema from path, query, and header parameters
   plus a JSON body mapped to a `body` property. Operation-level parameters
   override path-level parameters by `(name, in)`. Record sorted parameter
   bindings and request-body media metadata for the executor. Flatten an `allOf`
   of object schemas into one object schema only when properties, `required`,
   and `additionalProperties` can be merged without changing the intersection.
6. Translate OpenAPI 3.0 `nullable` and `readOnly` input semantics, preserve
   3.1 null unions, and audit the result with `auditInputSchema`.
7. Map declared responses in status-key order with their selected media type and
   a descriptive response schema. Response schemas resolve local references,
   omit `writeOnly` properties, and preserve composition keywords; they are not
   used to validate upstream payloads yet.
8. Derive an explicit authentication policy: OR alternatives, AND scheme sets,
   copied credential metadata, required scopes, and preserved anonymous
   alternatives. It is metadata; authentication and credential injection remain
   unimplemented, while the executor added by ADR 0018 performs no credential
   lookup or scope enforcement.
9. Emit `sourceHash`, a canonical-document `contractRevision`, per-tool hashes,
   a `toolsetHash`, and `diffManifests()` output.

Strict mode is the default: unsupported input validation constraints are errors
and the operation is omitted. Permissive mode may drop constraints that cannot
weaken the supported subset, with a warning. Input `oneOf`, `anyOf`, `not`,
conditional, dependent, and pattern composition, remote references, unknown
schema keywords, and schema-valued `additionalProperties` are always errors
because dropping them would accept values the contract rejects. `allOf` is
flattened only for object intersections; incompatible members are errors. Name
collisions are errors in strict mode and are renamed deterministically with a
warning in permissive mode.

Compilation performs no filesystem or network I/O and runs on the normal
asynchronous request path without blocking APIs. The `chainmcp/no-blocking-io`
lint rule enforces that invariant for runtime source.

### Upstream executor

`@chainmcp/executor` binds compiled metadata to the runtime. For each
`CompiledOperation` it creates a `ToolDefinition` whose `execute`:

1. Builds a URL from the configured base URL and the compiled path, filling path
   parameters and appending query/header inputs according to the recorded
   bindings. Inputs that cannot be serialized deterministically are rejected
   rather than guessed at.
2. Applies an exact destination allowlist, fixed protocol/port, and URL and
   header size limits.
3. Resolves every hostname, rejects the resolution if any IPv4/IPv6 answer is
   non-public, pins one address in the HTTP lookup, and verifies the connected
   peer.
4. Sends a bounded request with no inbound credentials and no compression
   request.
5. Follows only same-host, same-protocol, same-port redirects, revalidating and
   re-resolving every hop.
6. Caps response headers and body bytes while streaming, requires UTF-8 JSON on
   2xx, and maps failures to safe runtime errors.
7. Binds `context.signal` and a total time budget to DNS waiting and HTTP I/O,
   releasing listeners and timers in `finally`.

The executor does not resolve upstream credentials, validate response schemas,
retry requests, or honor proxy environment variables. A custom transport is
trusted adapter code; the default Node transport is the component that pins DNS
and verifies the peer.

## 6. Generated server mode

The compiler produces a project containing:

- A contract snapshot or reference with an integrity hash.
- Generated tool definitions.
- Runtime configuration and examples.
- Dependencies pinned through a lockfile.
- A generation manifest containing compiler and contract versions.
- No embedded production credentials.

Generated servers use the shared runtime package. Generated source must be deterministic for the same contract and compiler version.

## 7. Dynamic gateway mode

The gateway serves multiple registered API contracts through a shared process.

Each contract revision has:

- An immutable identifier.
- A tenant or explicit owner.
- A validated tool registry.
- An upstream destination policy.
- An authorization policy.
- Cache and rate-limit settings.

Load new revisions into an isolated candidate registry. Validate completely, then atomically activate. Support rollback and disabling without mutating active registries in place.

## 8. Core interfaces

```ts
export interface ToolContext {
  requestId: string;
  tenantId: string;
  principal: Principal;
  signal?: AbortSignal;
}

export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  operation: OperationPolicy;
  ownerTenantId?: string;
  execute(input: TInput, context: ToolContext): Promise<TOutput>;
}

export interface CacheStore {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T, ttlSeconds: number): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface RuntimeCacheOptions {
  store: CacheStore;
  authorizationPartition(
    context: ToolContext,
    tool: ToolDefinition,
  ): string | undefined;
}

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

export interface MetricsSink {
  record(event: RuntimeEvent): void | Promise<void>;
}
```

The final public interfaces are governed by `API_REFERENCE.md`.

The M2 server adapter snapshots the runtime's tool definitions when
`createMcpServer` is called for single-tenant runtimes and does not observe
tools registered afterward. Multi-tenant runtimes are adapted through
low-level per-request `tools/list` and `tools/call` handlers instead: each
listing establishes the caller identity and enumerates only that caller's
tenant's tools against the shared tenant-scoped registry (ADR 0008), so
discovery and invocation resolve through one code path and a listing whose
identity cannot be established fails closed. The adapter selects this behavior
from the runtime's declared `tenantMode`, not from its concrete class. The
adapter runs trusted context construction inside the runtime invocation
boundary, so untyped failures fail closed as `AUTH_FORBIDDEN`, typed
`RuntimeError`s keep their code, and both are recorded in
metrics. Metrics use the tenant ID `unknown` when context construction fails
before tenant resolution. The context factory receives the MCP request ID,
cancellation signal, and optional HTTP auth info. Stdio closes on EOF,
application abort, SIGINT, or SIGTERM. A `closed` promise and `onclose`
callback expose transport lifecycle; repeated close calls await the same
shutdown. Remote serving and inbound authentication are not implemented.

## 9. Caching invariants

A cache key must incorporate:

- Contract revision.
- Tool identity.
- Canonicalized arguments.
- Tenant identity.
- Principal identity.
- A stable, non-secret authorization partition representing relevant grants or policy state.
- Relevant scopes and response-varying inputs.
- A key-format version.

The store key must be an opaque, fixed-length digest of the canonical key material. Do not place raw tenant, principal, tool, revision, or argument text in store keys. Bound the canonical input size before hashing. Increment the key-format version whenever canonicalization or hashed fields change so old entries become misses instead of colliding with entries written under different semantics.

Never use raw bearer tokens as keys. `createCacheKey` requires a non-empty
authorization partition, and callers must bypass shared caching if they cannot
compute one safely. `ToolDefinition.contractRevision` binds each cacheable tool
to the revision it was compiled from. The runtime invokes a deployment-supplied
`authorizationPartition(context, tool)` callback; returning a blank value,
returning `undefined`, throwing, or producing uncanonicalizable arguments
bypasses caching for that call only. The runtime never derives a partition from
a credential and never falls back to a shared partition.

Caching is opt-in per tool through `ToolDefinition.cache`, and no result is
cached unless the runtime also receives a store. Reads happen after
authorization, validation, and rate limiting, so a hit cannot bypass those
stages. Cache read, write, partition, and key-derivation failures degrade to a
miss or bypass; they never fail the invocation or serve data across partitions.
There is no request coalescing, and cache I/O is not covered by the per-call
execution timeout, so distributed adapters must bound their own latency. The
optional `@chainmcp/cache-redis` adapter bounds each Redis command with
`commandTimeoutMs`, but does not cancel the underlying client command; clients
must configure their own socket timeouts. Writes are not cached by default.
Cache failures must never result in serving data from another tenant or
authorization context.

Output projection and token-budget enforcement happen after execution and
before a cache write. A tool that opts into `output` must be projected; the
runtime rejects an unserializable projection and never falls back to the raw
result. `createFieldProjector()` supplies declarative `include`/`exclude` paths
with bounded depth and traversal; custom `ResultProjector` implementations
remain the extension point for computed policy. The entry written to the cache is the projected value, so a hit cannot
serve unprojected fields and does not re-run projection. Budgets are checked on
the serialized projected value; a count that cannot be verified fails closed.
Because projection policy is not part of the key, changing a projector, budget,
or `output` declaration requires a new cache namespace or contract revision.

Eligible invocations report `cacheOutcome` (`hit`, `miss`, or `bypass`) on the
`tool_invocation` event; the hit ratio is `hit / (hit + miss)` with bypass
reported separately. Invalidation is exact-match only:
`invalidateCachedResult(name, input, context)` recomputes the key from the same
tool, arguments, and caller context and deletes that entry. Hashed keys cannot
be enumerated, so tenant-wide or predicate invalidation requires separate store
namespaces or external metadata (ADR 0005). Invalidation is a trusted operator
surface, not an MCP request, and does not run authorization.

## 10. Token accounting

Token accounting measures the serialized result presented to the model, not merely the raw upstream response.

When a `Tokenizer` adapter is configured, every successful invocation emits
`tokenUsage` on the `tool_invocation` event with the measurement mode (`exact`
or `estimate`), the tokenizer identifier, the count, and the UTF-8 size of the
serialized payload. Cache hits are measured the same way as misses, and the same
event carries `cacheOutcome`, so token and cache metrics can be correlated
without duplicate events. Failed invocations, `undefined` results,
unserializable results, and adapter failures omit `tokenUsage` rather than
guessing.

Adapters declare their own exactness; the runtime never relabels an estimate as
exact. No tokenizer is bundled, because a generic heuristic is not a faithful
count for a specific model. Deployments that only have an approximation must
label it `estimate` and must not promise savings from it.

A tool that declares `output.maxTokens` gets a hard budget on the serialized
projected result. The runtime applies projection first, then counts, then
rejects over-budget or uncountable results with `OUTPUT_LIMIT_EXCEEDED` or
`OUTPUT_POLICY_VIOLATION` before caching or returning anything. A budget checked
with an `estimate` adapter is only as precise as that estimate; enforcement does
not upgrade the label. The same count is recorded as `tokenUsage`, so the
measured value is the value that passed the budget.

The following remain required before token accounting is complete:

- Per-content-block measurement if multimodal or multi-part results are added.
- Aggregated hit-ratio and token dashboards or exporters.
- A shared serialization path so measurement and the transport do not serialize
  the same result separately.

Token counts are metadata; adapters receive the serialized result, so they must
run in-process or in a trusted boundary and must not forward payload text.

## 11. JSON navigation

Navigation tools must operate on bounded JSON data and enforce limits for:

- Input and output bytes.
- Traversal depth.
- Array items.
- Execution time.
- Filter complexity.

Navigation must not bypass upstream authorization or grant access to fields the caller is not allowed to see.

## 12. Error model

Use stable internal error codes, including:

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

Expose safe messages to clients. Keep stack traces and sensitive diagnostics in protected logs.

The runtime classifies failures by invocation stage. Typed `RuntimeError` values from adapters are preserved. An authorization adapter that throws anything else fails closed as `AUTH_FORBIDDEN` with a safe `Access denied` message, and its cause is retained only for protected diagnostics. Rate limiting is expressed as an explicit `{ allowed: false }` decision; a thrown limiter error is an infrastructure failure and does not produce the `rate_limited` metrics outcome, even if the adapter throws a `RATE_LIMITED` code. See ADR 0006.

## 13. Architecture decision records

Changes to the runtime model, public API, transport strategy, or security boundaries require an ADR under `docs/adr/`.

Each ADR records context, decision, alternatives, consequences, and status.

# Logging and Analytics

## 1. Overview

Observability in ChainMcp is split into three primary capabilities:

1. **Structured Logging:** Correlated, level-filtered diagnostic and audit logs.
2. **OpenTelemetry Telemetry:** Metrics and distributed tracing spans adhering to OpenTelemetry standards.
3. **In-Memory Analytics Aggregation:** Sliding-window performance counters and cache hit-ratio accounting.

## 2. Invariants and Security Rules

1. **Secret and token redaction:** All logged metadata, context attributes, and telemetry spans are filtered through the redaction engine. Sensitive keys (passwords, tokens, credentials, API keys) and token formats (Bearer, Basic, JWTs) are replaced with `"[REDACTED]"`.
2. **Body exclusion by default:** Request and response bodies are excluded from logs and spans by default (`"[EXCLUDED_BODY]"`). Including them requires explicit configuration, and even then secrets are redacted.
3. **Failure isolation:** Logging, metrics, and tracing failures must **never** alter tool outcomes or surface errors to callers. All sink and SDK dispatches are wrapped in protective boundaries.
4. **Separation of diagnostic and audit logs:** Security-relevant events (authorization denials, rate limit breaches, administrative invalidations) are tagged as `category: "audit"` and can be routed to dedicated, tamper-evident audit sinks.

## 3. Structured Logging (`@chainmcp/analytics`)

### Logger Interface

`@chainmcp/core` defines the portable logger interface:

```ts
export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
  audit?(message: string, context?: Record<string, unknown>): void;
  child?(context: Record<string, unknown>): Logger;
}
```

### Context Correlation

Invocations automatically attach correlation fields to log records:

- `requestId`: Inbound MCP request identifier.
- `tenantId`: Tenant identity.
- `principalId`: Caller identity.
- `toolName`: Invoked tool name.
- `contractRevision`: Compiled contract version.
- `durationMs`: Monotonic execution time.
- `outcome`: `"success" | "error" | "rate_limited"`.
- `errorCode`: Runtime error code when a call fails.
- `cacheOutcome`: `"hit" | "miss" | "bypass"` for cache-eligible tools.

### Sinks and Routing

- `ConsoleSink`: Formats logs as structured NDJSON lines (or human-readable text), writing `info`/`debug` to stdout and `warn`/`error` to stderr without blocking the event loop.
- `MemorySink`: Retains records in a bounded in-memory buffer (default 1,000 records) with FIFO eviction for testing and local introspection.
- `MultiSink`: Broadcasts records across multiple independent sinks with isolated error handling.
- `auditSink`: Dedicated sink parameter for security and compliance audits.

## 4. OpenTelemetry Integration

OpenTelemetry support is partitioned into metrics aggregation and distributed tracing spans.

### Metrics vs Tracing

- **Metrics (`OpenTelemetryMetricsSink`):** Aggregates high-throughput quantitative indicators (counters, histograms) partitioned by safe low-cardinality labels without allocating per-request traces.
- **Distributed Tracing (`ToolTracer`):** Captures end-to-end execution timing and lifecycle status per tool call, propagating trace contexts to downstream stages and child operations.

### Metrics (`OpenTelemetryMetricsSink`)

Implements `MetricsSink` from `@chainmcp/core` using `@opentelemetry/api`:

- `chainmcp.tool.invocations` (Counter): Invocations partitioned by `{ tool.name, tenant.id, outcome, error.code, cache.outcome }`.
- `chainmcp.tool.duration` (Histogram): Execution duration in milliseconds.
- `chainmcp.tool.tokens` (Counter): Token counts partitioned by `{ measurement, tokenizer }`.
- `chainmcp.tool.payload_bytes` (Histogram): Serialized result size in bytes.

### Tracing (`ToolTracer`)

`ToolTracer` implements `ToolTracer` from `@chainmcp/core` using `@opentelemetry/api`:

#### Span Hierarchy & Context Propagation

- **Root Tool Span:** Named `tool.<name>` (e.g. `tool.getPets`).
- **Child Spans:** Executed inside `tracer.withSpan(toolSpan, ...)` context:
  - `cache.read`: Cache lookup attempt.
  - `upstream.call`: Tool adapter/upstream HTTP invocation.
  - `projection`: Output filtering and field selection.
  - `cache.write`: Cache storage operation.
- Because child spans run within the tool span context, they automatically inherit the parent span's `traceId` and establish proper parent-child distributed trace graphs.

#### Span Attributes

Spans contain safe correlation attributes:

- `tool.name`: Name of the executed tool.
- `mcp.tool_name`: Matching MCP tool name.
- `tenant.id`: Owning tenant ID.
- `principal.id`: Caller principal identifier.
- `mcp.request_id`: Unique request correlation ID.
- `contract.revision`: Contract revision hash/ID (when present).
- `outcome`: `"success" | "error" | "cancelled"`.
- `duration_ms`: Total execution duration in milliseconds.
- `cache.outcome`: `"hit" | "miss" | "bypass"` (for cache-eligible tools).
- `cached`: Boolean flag indicating whether the result was served from cache.

#### Strict Security and Redaction Guarantees

- **No Payload or Header Leakage:** Input arguments, request headers, and response bodies are **never** attached to span attributes or events.
- **Error Redaction:** When a tool fails or throws an exception, error messages recorded on the span status and exception events are scrubbed through `redactString()`, replacing API tokens, Bearer headers, Basic auth credentials, and JWTs with `[REDACTED]`.

#### Lifecycle and Cancellation

- Spans always end upon tool completion.
- When an execution is cancelled (e.g., via `context.signal.aborted` or timeout cancellation), the span is closed with `outcome: "cancelled"`.
- When an execution fails with an error, the span status is set to `SpanStatusCode.ERROR` with a redacted description.

#### Export and Fallback Semantics

- If an OpenTelemetry SDK `TracerProvider` with an exporter (such as an OTLP trace exporter directed to `endpoint`) is initialized in the environment, spans are exported upstream.
- If no SDK exporter is configured, spans are handled locally by `@opentelemetry/api` and dropped without crashing or affecting execution.

#### Sampling

- Tracing supports probabilistic sampling via `analytics.openTelemetry.tracing.sampleRatio` (from `0.0` to `1.0`, default `0.1`). When sampled out, a no-op span context is returned with zero overhead.

## 5. In-Memory Analytics Aggregator

For deployments without an external OpenTelemetry collector, `RollingAnalyticsAggregator` provides sliding-window performance metrics:

```ts
import { RollingAnalyticsAggregator } from "@chainmcp/analytics";

const aggregator = new RollingAnalyticsAggregator({
  retentionMs: 14 * 86_400_000, // 14 days
  maxEvents: 50_000,
});

// Retrieve aggregated summary
const summary = aggregator.getSummary({ tenantId: "tenant-1" });
// summary.cache.hitRatio = hits / (hits + misses)
// summary.latency.p50Ms, summary.latency.p95Ms, summary.latency.p99Ms
```

## 6. Configuration

In `chainmcp.yaml`:

```yaml
logging:
  level: info # debug | info | warn | error | silent
  destination: stdout # stdout | stderr | memory
  redactKeys:
    - custom_secret_key
  includeRequestBodies: false
  includeResponseBodies: false

analytics:
  enabled: true
  includeArguments: false
  includeResponseBodies: false
  retentionDays: 14
  openTelemetry:
    enabled: false
    serviceName: chainmcp
    endpoint: http://localhost:4318/v1/traces # optional OTLP HTTP endpoint
    tracing:
      enabled: false
      sampleRatio: 0.1 # sample ratio between 0.0 and 1.0
```

### Environment Variables

- `CHAINMCP_LOG_LEVEL`: Overrides `logging.level` (e.g. `CHAINMCP_LOG_LEVEL=debug`).

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

### Metrics (`OpenTelemetryMetricsSink`)

Implements `MetricsSink` from `@chainmcp/core` using `@opentelemetry/api`:

- `chainmcp.tool.invocations` (Counter): Invocations partitioned by `{ tool.name, tenant.id, outcome, error.code, cache.outcome }`.
- `chainmcp.tool.duration` (Histogram): Execution duration in milliseconds.
- `chainmcp.tool.tokens` (Counter): Token counts partitioned by `{ measurement, tokenizer }`.
- `chainmcp.tool.payload_bytes` (Histogram): Serialized result size in bytes.

### Tracing (`ToolTracer`)

Creates `chainmcp.tool_call` spans with tenant, principal, request ID, and tool attributes. Automatically marks span errors on failures and excludes payload bodies and credentials.

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
```

### Environment Variables

- `CHAINMCP_LOG_LEVEL`: Overrides `logging.level` (e.g. `CHAINMCP_LOG_LEVEL=debug`).

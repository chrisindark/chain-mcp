# ADR 0023: Bounded JSON Navigation, Structured Logging, and OpenTelemetry Analytics

- Status: proposed
- Date: 2026-10-26

## Context and problem

Milestone 6 requires bounded JSON navigation, structured logging, and analytics to be delivered for ChainMcp:

1. **Large and adversarial JSON responses:** Upstream APIs frequently return extensive or nested payloads (megabytes in size or deeply recursive). Presenting raw responses to LLMs consumes context windows, causes token budget exhaustion, and risks memory exhaustion. Callers need bounded path selection, filtering, pagination, and shape inspection without compromising security or bypassing upstream authorization and field projection.
2. **Observability and diagnostic logging:** Operations require structured logs with log level filtering, correlation with request, tool call, and contract revision identifiers, and complete isolation so logging failures cannot abort tool calls or modify tool outputs.
3. **Secret and body redaction:** Logs and analytics must never leak credentials (bearer tokens, API keys, passwords, Basic auth, JWTs) or expose raw request/response bodies by default.
4. **Audit vs. diagnostic separation:** Security-critical lifecycle events (authorization denials, rate limit breaches, administrative cache invalidations) must be separable from high-volume diagnostic logs and routed to dedicated sinks.
5. **OpenTelemetry and telemetry metrics:** Standardized metrics and distributed tracing spans must be emitted without adding heavy mandatory dependencies to core packages.

## Decision

### 1. Bounded JSON Navigation Package (`@chainmcp/json-navigation`)

We introduced `@chainmcp/json-navigation` with strict resource bounds:

- **Shape Inspection (`inspectShape`):** Traverses arbitrary data and produces a concise `ShapeSummary` containing types, object key listings, array lengths, depth, node counts, and byte estimates. Protects against circular references and deep structures (`throwOnDepthLimit: true` or `truncated: true`).
- **Path Selection (`selectPath`):** Deterministic recursive descent parser for dot-bracket paths (`$.store.books[0].title`, `items[*]`, `books[0:5]`, `users[?(@.age >= 21)]`). Rejects forbidden prototype properties (`__proto__`, `prototype`, `constructor`).
- **Array & Object Pagination (`paginate`):** Bounded slicing using `offset`/`limit` or `page`/`pageSize`. Returns total count, page metadata, and `hasMore`.
- **Predicate Filtering (`filterData`):** Declarative filtering on array elements supporting comparison operators (`eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `contains`, `in`, `exists`) and composite boolean logic (`and`, `or`, `not`).
- **Strict Limit Enforcement (`NavigationBudget`):**
  - Traversal depth capped by `maxDepth` (default 16, hard maximum 64).
  - Node budget capped by `maxVisitedNodes` (default 50,000).
  - Array output capped by `maxArrayItems` (default 1,000).
  - Serialized result capped by `maxResultBytes` (default 50,000 bytes).
  - Execution time capped by `timeoutMs` (default 5,000 ms).
  - Throws `JsonNavigationLimitError` if limits are exceeded.
- **MCP Tool Definitions (`createJsonNavigationTools`):** Exports runnable `ToolDefinition`s (`json_inspect_shape`, `json_select_path`, `json_paginate`, `json_filter`) that can be served over MCP transports.

### 2. Core Logging Interface & Runtime Integration (`@chainmcp/core`)

- Defined `Logger`, `LogLevel` (`debug`, `info`, `warn`, `error`, `silent`), `LogRecord`, and `LogCorrelationContext` in `@chainmcp/core`.
- Updated `InMemoryToolRuntime` to accept `RuntimeOptions.logger`:
  - Correlates execution events with `requestId`, `tenantId`, `principalId`, `toolName`, `contractRevision`, `durationMs`, and `outcome`.
  - Dispatches `info` on completion, `warn` and `audit` on rate limit denials, and `error` and `audit` on authorization failures.
  - Calls `audit` on administrative cache invalidation.
  - Enforces complete logger failure isolation (`try/catch` wrapping all logger invocations) so logger errors cannot alter tool results or bubble to callers.

### 3. Analytics, Sinks, Redaction, and OpenTelemetry (`@chainmcp/analytics`)

We introduced `@chainmcp/analytics`:

- **Redaction Engine (`redactValue`, `redactString`):**
  - Case-insensitive key scrubbing (`authorization`, `cookie`, `set-cookie`, `x-api-key`, `password`, `secret`, `token`, `apikey`, `private_key`, etc.) replaced with `"[REDACTED]"`.
  - Regex patterns for Bearer, Basic, and JWT credentials in string values.
  - Request and response bodies excluded by default (`"[EXCLUDED_BODY]"`).
  - Recursion depth and circular reference protection.
- **Multi-Sink Architecture (`sinks.ts`):**
  - `MemorySink`: bounded in-memory buffer (default 1,000 records) with FIFO eviction for tests and memory destinations.
  - `ConsoleSink`: non-blocking NDJSON or pretty-formatted output routing errors/warnings to stderr and info/debug to stdout.
  - `MultiSink`: fans out records to multiple sinks with per-sink error isolation.
- **Structured Logger (`createLogger`):** Configurable severity threshold, automatic redaction, and separate routing of diagnostic vs. audit records (`auditSink`). Supports `.child(...)` context inheritance.
- **OpenTelemetry Metrics (`OpenTelemetryMetricsSink`):** Implements `MetricsSink` from `@chainmcp/core` using `@opentelemetry/api`. Records `chainmcp.tool.invocations`, `chainmcp.tool.duration`, `chainmcp.tool.tokens`, and `chainmcp.tool.payload_bytes`.
- **OpenTelemetry Tracing (`ToolTracer`):** Creates `chainmcp.tool_call` spans with tenant, principal, tool, and request correlation attributes; redacts secrets and sets span status.
- **Rolling Analytics Aggregator (`RollingAnalyticsAggregator`):** In-memory sliding window metric aggregator computing total invocations, error counts, cache hit ratios (`hits / (hits + misses)`), token statistics, and latency percentiles (min, max, avg, p50, p95, p99).

### 4. Configuration Wiring (`@chainmcp/config`)

- Added `LoggingConfigSchema`, `JsonNavigationConfigSchema`, and `AnalyticsConfigSchema` to `ChainMcpConfigSchema`.
- Mapped environment variable `CHAINMCP_LOG_LEVEL` with priority over config.
- Factory helpers: `createLoggerFromConfig` and `createNavigationLimitsFromConfig`.
- `buildRuntimeOptions` automatically wires `logger` and `metrics` from config.

## Alternatives considered

- **Evaluate arbitrary JavaScript expressions for JSON navigation (e.g. `eval` or `Function`):** Rejected. Running arbitrary code introduces code injection and arbitrary execution vulnerabilities. We implemented a dedicated, deterministic AST-based recursive descent parser.
- **Bundle full OpenTelemetry SDK in `@chainmcp/core`:** Rejected. `@chainmcp/core` must remain zero-dependency. Core defines pure interfaces (`MetricsSink`, `Logger`); `@chainmcp/analytics` implements adapters using `@opentelemetry/api`.
- **Include raw request and response payloads in telemetry by default:** Rejected. Logging raw bodies risks data leakage and excessive memory overhead. Request and response bodies are excluded by default and scrubbed when opted in.

## Consequences and trade-offs

- Two new workspace packages: `@chainmcp/json-navigation` and `@chainmcp/analytics`.
- Bounded JSON exploration is available directly to MCP clients and internal runtime components.
- Logging and metrics failures are guaranteed never to disrupt tool execution.

## Security implications

- Prototype pollution is prevented across path parsing, shape inspection, and redaction.
- Secrets (tokens, headers, passwords) are scrubbed before reaching log sinks or telemetry spans.
- Audit logs provide an immutable record of security-sensitive denials.

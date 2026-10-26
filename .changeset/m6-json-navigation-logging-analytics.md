---
"@chainmcp/analytics": minor
"@chainmcp/config": minor
"@chainmcp/core": minor
"@chainmcp/json-navigation": minor
---

Implement Milestone 6: JSON navigation, structured logging, and analytics.

- Add `@chainmcp/json-navigation` with bounded JSON path selection, shape inspection, pagination, declarative filtering, and MCP tool definitions.
- Add portable `Logger`, `LogLevel`, `LogRecord`, and `LogCorrelationContext` interfaces to `@chainmcp/core` and integrate correlated lifecycle logging in `InMemoryToolRuntime`.
- Add `@chainmcp/analytics` with `createLogger`, multi-sink routing (`ConsoleSink`, `MemorySink`, `MultiSink`), case-insensitive secret scrubbing, token pattern redaction, default request/response body exclusion, dedicated security `auditSink`, OpenTelemetry metrics (`OpenTelemetryMetricsSink`) and tracing (`ToolTracer`), and `RollingAnalyticsAggregator`.
- Add `logging`, `jsonNavigation`, and `analytics` schemas and wiring helpers to `@chainmcp/config`.

# ADR 0032 — Universal MCP telemetry, OTLP ingestion sink, and span-to-metric derivation

- **Status:** accepted
- **Date:** 2026-11-10
- **Supersedes:** none
- **Related:** ADR 0002 (shared runtime), ADR 0023 (JSON navigation & analytics), ADR 0031 (storage package and persistence)

## Context

ChainMcp servers and dynamic gateways provide rich internal metrics, structured logging, and OpenTelemetry instrumentation (`@chainmcp/analytics`). However, in production agent architectures, MCP tool servers rarely run in isolation:

1. External MCP servers implemented in Python (e.g. FastMCP), Go, Rust, or other runtimes emit OpenTelemetry traces and metrics but cannot natively feed ChainMcp's metrics sinks or persistence storage.
2. Coding agents (such as Claude Code, Cursor, or custom Gemini agents) invoke LLMs and external MCP tools, producing GenAI and MCP telemetry that operators want to collect in one unified local or gateway sink.
3. In Milestone 11, ChainMcp introduced `@chainmcp/storage` with `TelemetryRingBuffer` (both Memory and SQLite WAL drivers). Persisting telemetry locally requires an ingestion sink that can accept industry-standard OTLP/HTTP payloads without forcing external servers to install proprietary SDKs.
4. Telemetry collection must never compromise performance: synchronous policy enforcement and HTTP responses must remain sub-5ms, with database writes offloaded asynchronously.

## Decision

1. **Lightweight OTLP/HTTP Ingestion Sink:**
   - Implement an OpenTelemetry protocol over HTTP (OTLP/HTTP) ingestion sink in `@chainmcp/analytics` handling standard OTLP/JSON payloads at `POST /v1/traces` and `POST /v1/metrics`.
   - Implement standalone handler `OtlpIngestionSink` and `createOtlpHttpHandler` that can run independently or be mounted into `@chainmcp/server` (`HttpServeOptions.otlpHandler`).
   - Support standard OTLP JSON encoding with strict request body limits (default 5 MiB), safe attribute parsing, and prototype pollution defenses.

2. **GenAI & MCP Span-to-Metric Derivation:**
   - Map OpenTelemetry GenAI Semantic Conventions (`gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.usage.total_tokens`, `gen_ai.request.model`) and MCP conventions (`tool.name`, `mcp.tool_name`, `mcp.method`, `tenant.id`, `principal.id`, `cache.outcome`, `outcome`).
   - Automatically derive runtime events and metrics from incoming spans:
     - `chainmcp.tool.invocations` counter (by tool, tenant, outcome, error code).
     - `chainmcp.tool.duration` histogram (computed from span nanosecond timestamps).
     - `chainmcp.tool.tokens` counter (derived from GenAI token usage attributes).
   - Feed derived events into the configured `MetricsSink` (e.g., `OpenTelemetryMetricsSink` or `RollingAnalyticsAggregator`).

3. **Asynchronous Non-Blocking Persistence to `@chainmcp/storage`:**
   - Transform ingested spans into `TelemetryEvent`s and buffer them into `TelemetryRingBuffer` (`storageDriver.getTelemetryRingBuffer()`).
   - Telemetry persistence is strictly asynchronous: incoming OTLP HTTP requests return `200 OK` (`{}`) immediately without awaiting database I/O, maintaining sub-5ms latency.
   - Storage write errors are caught and logged; failures in telemetry never disrupt execution or fail client requests.

4. **Security & Boundary Invariants:**
   - Payloads are bounded by `maxRequestBytes` (default 5 MiB) to prevent memory exhaustion.
   - Attribute keys and values are sanitized to protect against prototype pollution (`__proto__`, `constructor`).
   - Optional authenticator hook permits token/API key verification on ingestion endpoints when exposed beyond loopback.

## Alternatives considered

- **Require full OpenTelemetry Collector daemon.** Rejected: forces users and local developers to configure and run an external Docker container or binary just to capture local MCP metrics. A lightweight in-process OTLP/HTTP sink eliminates external runtime dependencies.
- **Support Protobuf wire format only.** Rejected: JSON over HTTP (`application/json`) is universally supported by all OTel SDKs (Python, Node.js, Go) without requiring heavy protobuf compilation dependencies.
- **Block HTTP requests until SQLite commit.** Rejected: SQLite disk writes introduce latency spikes (5–50ms). Telemetry persistence must be fire-and-forget / non-blocking.

## Consequences

- External Python FastMCP, Go, and native ChainMcp servers can export OTLP traces directly to ChainMcp.
- GenAI and MCP metrics are unified across heterogenous multi-server environments.
- Telemetry events survive server restarts when backed by SQLite WAL storage in `@chainmcp/storage`.
- In-memory execution remains sub-5ms while providing full observability.

# @chainmcp/analytics

Structured logging, secret-redacting audit sinks, metrics, and OpenTelemetry tracing for ChainMcp.

## Overview

`@chainmcp/analytics` provides observability tailored for MCP agents and tool execution:

- **Secret Redaction:** Scrubbing of API keys, bearer tokens, and sensitive headers across all log records.
- **Universal OTLP/HTTP Ingestion Sink:** Ingests standard OpenTelemetry JSON traces (`/v1/traces`) and metrics (`/v1/metrics`) with GenAI and MCP span-to-metric derivation and asynchronous `@chainmcp/storage` persistence.
- **Multi-Sink Architecture:** Routes operational diagnostics and security audit logs to separate sinks (Console, Memory, MultiSink).
- **OpenTelemetry:** Instruments tool execution and internal pipeline spans with OpenTelemetry tracing and metrics.
- **Rolling Aggregators:** Sliding-window analytics for request volume, cache hit ratios, and latency distributions.

## Installation

```bash
npm install @chainmcp/analytics
# or
pnpm add @chainmcp/analytics
```

## Documentation

Full documentation and API reference are available in the [ChainMcp repository](https://github.com/chrisindark/chain-mcp#readme) and [API Reference](https://github.com/chrisindark/chain-mcp/blob/master/packages/analytics/API.md).

## License

Apache-2.0

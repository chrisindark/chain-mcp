export {
  DEFAULT_SENSITIVE_KEYS,
  DEFAULT_BODY_KEYS,
  REDACTED_MARKER,
  EXCLUDED_BODY_MARKER,
  redactString,
  redactValue,
  type RedactionOptions,
} from "./redaction.js";

export {
  type LogSink,
  MemorySink,
  ConsoleSink,
  MultiSink,
  type ConsoleSinkOptions,
} from "./sinks.js";

export {
  StructuredLogger,
  createLogger,
  type LoggerOptions,
} from "./logger.js";

export {
  OpenTelemetryMetricsSink,
  type OpenTelemetryMetricsSinkOptions,
} from "./otel-metrics.js";

export { ToolTracer, type ToolTracerOptions } from "./otel-tracing.js";

export {
  RollingAnalyticsAggregator,
  type AnalyticsSummary,
  type AggregatorOptions,
} from "./aggregator.js";

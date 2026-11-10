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

export {
  OtlpSpanKind,
  OtlpStatusCode,
  type OtlpAnyValue,
  type OtlpKeyValue,
  type OtlpSpan,
  type OtlpScopeSpans,
  type OtlpResourceSpans,
  type ExportTraceServiceRequest,
  type ExportTraceServiceResponse,
  type ExportTracePartialSuccess,
  type OtlpMetric,
  type OtlpScopeMetrics,
  type OtlpResourceMetrics,
  type ExportMetricsServiceRequest,
  type ExportMetricsServiceResponse,
  extractOtlpValue,
  otlpAttributesToRecord,
  otlpNanoToMs,
} from "./otlp-types.js";

export {
  deriveMetricsFromSpans,
  type SpanDerivationOptions,
  type DerivedSpanTelemetry,
} from "./span-derivation.js";

export {
  OtlpIngestionSink,
  createOtlpHttpHandler,
  type OtlpIngestionSinkOptions,
  type OtlpAuthContext,
  DEFAULT_MAX_OTLP_REQUEST_BYTES,
} from "./otlp-sink.js";

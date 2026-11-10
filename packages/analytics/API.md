# API Reference: @chainmcp/analytics

## `@chainmcp/analytics`

Structured logging, multi-sink routing, secret redaction, and OpenTelemetry integration:

```ts
export function createLogger(options?: LoggerOptions): StructuredLogger;

export class OpenTelemetryMetricsSink implements MetricsSink {
  constructor(options?: OpenTelemetryMetricsSinkOptions);
  record(event: RuntimeEvent): void;
}

export class ToolTracer implements CoreToolTracer {
  constructor(options?: ToolTracerOptions);
  startToolSpan(
    toolName: string,
    context: ToolContext,
    contractRevision?: string | undefined,
  ): Span;
  endToolSpan(
    span: Span,
    details?: {
      readonly error?: unknown;
      readonly outcome?: "success" | "error" | "cancelled" | undefined;
      readonly durationMs?: number | undefined;
      readonly cacheOutcome?: "hit" | "miss" | "bypass" | undefined;
      readonly cached?: boolean | undefined;
    },
  ): void;
  startChildSpan(
    name: string,
    attributes?: Record<string, string | number | boolean> | undefined,
  ): Span;
  endSpan(
    span: Span,
    details?: {
      readonly error?: unknown;
      readonly outcome?: "success" | "error" | "cancelled" | undefined;
      readonly durationMs?: number | undefined;
    },
  ): void;
  withSpan<T>(span: Span, fn: () => T): T;
}

export class RollingAnalyticsAggregator implements MetricsSink {
  constructor(options?: AggregatorOptions);
  record(event: RuntimeEvent): void;
  getSummary(filter?: {
    toolName?: string;
    tenantId?: string;
  }): AnalyticsSummary;
  clear(): void;
}

export class OtlpIngestionSink {
  constructor(options?: OtlpIngestionSinkOptions);
  ingestTraces(
    payload: ExportTraceServiceRequest | string,
    overrideTenantId?: string,
  ): Promise<ExportTraceServiceResponse>;
  ingestMetrics(
    payload: ExportMetricsServiceRequest | string,
    overrideTenantId?: string,
  ): Promise<ExportMetricsServiceResponse>;
  createHttpHandler(): (
    req: IncomingMessage,
    res: ServerResponse,
  ) => Promise<boolean>;
}

export function createOtlpHttpHandler(
  options?: OtlpIngestionSinkOptions,
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

export function deriveMetricsFromSpans(
  request: ExportTraceServiceRequest,
  options?: SpanDerivationOptions,
): DerivedSpanTelemetry;

export function extractOtlpValue(value?: OtlpAnyValue | unknown): unknown;
export function otlpAttributesToRecord(
  attributes?: OtlpKeyValue[] | undefined,
): Record<string, unknown>;
export function otlpNanoToMs(
  nano?: string | number | bigint | undefined,
): number;

export function redactValue(value: unknown, options?: RedactionOptions): unknown;
export function redactString(input: string): string;

export class MemorySink implements LogSink { ... }
export class ConsoleSink implements LogSink { ... }
export class MultiSink implements LogSink { ... }
```

### Telemetry & Redaction Rules

- Key names matching tokens, passwords, keys, or credentials are case-insensitively scrubbed to `"[REDACTED]"`.
- Bearer, Basic, and JWT patterns in strings are sanitized.
- Request and response bodies are excluded by default (`"[EXCLUDED_BODY]"`).
- Security events (authorization denials, rate limit breaches, invalidations) are routed to `auditSink`.
- Logger and metrics delivery failures are fully isolated and never alter tool results.

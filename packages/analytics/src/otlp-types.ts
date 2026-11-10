/**
 * OpenTelemetry Protocol (OTLP/JSON) v1 specification types and helpers.
 */

export enum OtlpSpanKind {
  SPAN_KIND_UNSPECIFIED = 0,
  SPAN_KIND_INTERNAL = 1,
  SPAN_KIND_SERVER = 2,
  SPAN_KIND_CLIENT = 3,
  SPAN_KIND_PRODUCER = 4,
  SPAN_KIND_CONSUMER = 5,
}

export enum OtlpStatusCode {
  STATUS_CODE_UNSET = 0,
  STATUS_CODE_OK = 1,
  STATUS_CODE_ERROR = 2,
}

export interface OtlpAnyValue {
  stringValue?: string | undefined;
  boolValue?: boolean | undefined;
  intValue?: string | number | bigint | undefined;
  doubleValue?: number | undefined;
  arrayValue?: { values?: OtlpAnyValue[] | undefined } | undefined;
  kvlistValue?: { values?: OtlpKeyValue[] | undefined } | undefined;
  bytesValue?: string | undefined;
}

export interface OtlpKeyValue {
  key: string;
  value?: OtlpAnyValue | unknown;
}

export interface OtlpStatus {
  message?: string | undefined;
  code?: OtlpStatusCode | number | undefined;
}

export interface OtlpEvent {
  timeUnixNano?: string | number | bigint | undefined;
  name: string;
  attributes?: OtlpKeyValue[] | undefined;
  droppedAttributesCount?: number | undefined;
}

export interface OtlpLink {
  traceId?: string | undefined;
  spanId?: string | undefined;
  traceState?: string | undefined;
  attributes?: OtlpKeyValue[] | undefined;
  droppedAttributesCount?: number | undefined;
}

export interface OtlpSpan {
  traceId: string;
  spanId: string;
  traceState?: string | undefined;
  parentSpanId?: string | undefined;
  flags?: number | undefined;
  name: string;
  kind?: OtlpSpanKind | number | undefined;
  startTimeUnixNano?: string | number | bigint | undefined;
  endTimeUnixNano?: string | number | bigint | undefined;
  attributes?: OtlpKeyValue[] | undefined;
  droppedAttributesCount?: number | undefined;
  events?: OtlpEvent[] | undefined;
  droppedEventsCount?: number | undefined;
  links?: OtlpLink[] | undefined;
  droppedLinksCount?: number | undefined;
  status?: OtlpStatus | undefined;
}

export interface OtlpInstrumentationScope {
  name: string;
  version?: string | undefined;
  attributes?: OtlpKeyValue[] | undefined;
  droppedAttributesCount?: number | undefined;
}

export interface OtlpResource {
  attributes?: OtlpKeyValue[] | undefined;
  droppedAttributesCount?: number | undefined;
}

export interface OtlpScopeSpans {
  scope?: OtlpInstrumentationScope | undefined;
  spans?: OtlpSpan[] | undefined;
  schemaUrl?: string | undefined;
}

export interface OtlpResourceSpans {
  resource?: OtlpResource | undefined;
  scopeSpans?: OtlpScopeSpans[] | undefined;
  schemaUrl?: string | undefined;
}

export interface ExportTraceServiceRequest {
  resourceSpans?: OtlpResourceSpans[] | undefined;
}

export interface ExportTracePartialSuccess {
  rejectedSpans?: number | undefined;
  errorMessage?: string | undefined;
}

export interface ExportTraceServiceResponse {
  partialSuccess?: ExportTracePartialSuccess | undefined;
}

export interface OtlpMetricDataPoint {
  attributes?: OtlpKeyValue[] | undefined;
  startTimeUnixNano?: string | number | bigint | undefined;
  timeUnixNano?: string | number | bigint | undefined;
  asDouble?: number | undefined;
  asInt?: string | number | bigint | undefined;
  exemplars?: unknown[] | undefined;
  flags?: number | undefined;
}

export interface OtlpHistogramDataPoint {
  attributes?: OtlpKeyValue[] | undefined;
  startTimeUnixNano?: string | number | bigint | undefined;
  timeUnixNano?: string | number | bigint | undefined;
  count?: string | number | bigint | undefined;
  sum?: number | undefined;
  bucketCounts?: Array<string | number | bigint> | undefined;
  explicitBounds?: number[] | undefined;
  min?: number | undefined;
  max?: number | undefined;
}

export interface OtlpMetric {
  name: string;
  description?: string | undefined;
  unit?: string | undefined;
  gauge?: { dataPoints?: OtlpMetricDataPoint[] | undefined } | undefined;
  sum?:
    | {
        dataPoints?: OtlpMetricDataPoint[] | undefined;
        aggregationTemporality?: number | undefined;
        isMonotonic?: boolean | undefined;
      }
    | undefined;
  histogram?:
    | {
        dataPoints?: OtlpHistogramDataPoint[] | undefined;
        aggregationTemporality?: number | undefined;
      }
    | undefined;
}

export interface OtlpScopeMetrics {
  scope?: OtlpInstrumentationScope | undefined;
  metrics?: OtlpMetric[] | undefined;
  schemaUrl?: string | undefined;
}

export interface OtlpResourceMetrics {
  resource?: OtlpResource | undefined;
  scopeMetrics?: OtlpScopeMetrics[] | undefined;
  schemaUrl?: string | undefined;
}

export interface ExportMetricsServiceRequest {
  resourceMetrics?: OtlpResourceMetrics[] | undefined;
}

export interface ExportMetricsPartialSuccess {
  rejectedDataPoints?: number | undefined;
  errorMessage?: string | undefined;
}

export interface ExportMetricsServiceResponse {
  partialSuccess?: ExportMetricsPartialSuccess | undefined;
}

const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

/**
 * Extracts a JavaScript primitive or composite value from an OtlpAnyValue representation,
 * guarding against prototype pollution.
 */
export function extractOtlpValue(value?: OtlpAnyValue | unknown): unknown {
  if (value === undefined || value === null) {
    return undefined;
  }

  // Handle direct primitives passed by non-strictly compliant clients
  if (typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }

  if (typeof value === "object") {
    const valObj = value as OtlpAnyValue;
    if (valObj.stringValue !== undefined) {
      return valObj.stringValue;
    }
    if (valObj.boolValue !== undefined) {
      return valObj.boolValue;
    }
    if (valObj.intValue !== undefined) {
      const num = Number(valObj.intValue);
      return Number.isNaN(num) ? String(valObj.intValue) : num;
    }
    if (valObj.doubleValue !== undefined) {
      return valObj.doubleValue;
    }
    if (valObj.bytesValue !== undefined) {
      return valObj.bytesValue;
    }
    if (valObj.arrayValue && Array.isArray(valObj.arrayValue.values)) {
      return valObj.arrayValue.values.map(extractOtlpValue);
    }
    if (valObj.kvlistValue && Array.isArray(valObj.kvlistValue.values)) {
      return otlpAttributesToRecord(valObj.kvlistValue.values);
    }
  }

  return undefined;
}

/**
 * Converts a list of OtlpKeyValue pairs into a clean Record, ignoring prototype pollution keys.
 */
export function otlpAttributesToRecord(
  attributes?: OtlpKeyValue[] | undefined,
): Record<string, unknown> {
  const result: Record<string, unknown> = Object.create(null);
  if (!attributes || !Array.isArray(attributes)) {
    return result;
  }

  for (const item of attributes) {
    if (!item || typeof item.key !== "string") {
      continue;
    }
    if (FORBIDDEN_KEYS.has(item.key)) {
      continue;
    }
    result[item.key] = extractOtlpValue(item.value);
  }

  return result;
}

/**
 * Helper to convert nanoseconds timestamp string/number/bigint to milliseconds epoch number.
 */
export function otlpNanoToMs(
  nano?: string | number | bigint | undefined,
): number {
  if (nano === undefined || nano === null) {
    return Date.now();
  }
  if (typeof nano === "bigint") {
    return Number(nano / 1_000_000n);
  }
  if (typeof nano === "number") {
    return Math.round(nano / 1_000_000);
  }
  if (typeof nano === "string") {
    try {
      const b = BigInt(nano);
      return Number(b / 1_000_000n);
    } catch {
      const n = Number(nano);
      return Number.isNaN(n) ? Date.now() : Math.round(n / 1_000_000);
    }
  }
  return Date.now();
}

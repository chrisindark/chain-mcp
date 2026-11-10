import type { RuntimeErrorCode, RuntimeEvent } from "@chainmcp/core";
import type { TelemetryEvent } from "@chainmcp/storage";
import {
  type ExportTraceServiceRequest,
  type OtlpSpan,
  otlpAttributesToRecord,
  otlpNanoToMs,
  OtlpStatusCode,
} from "./otlp-types.js";

export interface SpanDerivationOptions {
  readonly defaultTenantId?: string | undefined;
  readonly defaultTokenizer?: string | undefined;
}

export interface DerivedSpanTelemetry {
  readonly runtimeEvents: RuntimeEvent[];
  readonly telemetryEvents: TelemetryEvent[];
  readonly totalSpans: number;
  readonly toolSpansCount: number;
  readonly genAiSpansCount: number;
}

/**
 * Derives ChainMcp RuntimeEvents (for MetricsSink) and TelemetryEvents (for TelemetryRingBuffer)
 * from OpenTelemetry GenAI and MCP trace spans.
 */
export function deriveMetricsFromSpans(
  request: ExportTraceServiceRequest,
  options?: SpanDerivationOptions,
): DerivedSpanTelemetry {
  const runtimeEvents: RuntimeEvent[] = [];
  const telemetryEvents: TelemetryEvent[] = [];

  let totalSpans = 0;
  let toolSpansCount = 0;
  let genAiSpansCount = 0;

  const defaultTenantId = options?.defaultTenantId ?? "default";
  const defaultTokenizer = options?.defaultTokenizer ?? "otlp-genai";

  const resourceSpansList = request.resourceSpans;
  if (!Array.isArray(resourceSpansList)) {
    return {
      runtimeEvents,
      telemetryEvents,
      totalSpans: 0,
      toolSpansCount: 0,
      genAiSpansCount: 0,
    };
  }

  for (const resourceSpans of resourceSpansList) {
    const resourceAttrs = otlpAttributesToRecord(
      resourceSpans.resource?.attributes,
    );
    const serviceName =
      typeof resourceAttrs["service.name"] === "string"
        ? resourceAttrs["service.name"]
        : "mcp-service";

    const resourceTenantId =
      typeof resourceAttrs["tenant.id"] === "string"
        ? resourceAttrs["tenant.id"]
        : typeof resourceAttrs["tenant_id"] === "string"
          ? resourceAttrs["tenant_id"]
          : undefined;

    const scopeSpansList = resourceSpans.scopeSpans;
    if (!Array.isArray(scopeSpansList)) {
      continue;
    }

    for (const scopeSpans of scopeSpansList) {
      const spans = scopeSpans.spans;
      if (!Array.isArray(spans)) {
        continue;
      }

      for (const span of spans) {
        totalSpans++;
        const derived = processSpan(
          span,
          serviceName,
          resourceTenantId ?? defaultTenantId,
          defaultTokenizer,
        );

        if (derived.isToolOrGenAi) {
          if (derived.runtimeEvent) {
            runtimeEvents.push(derived.runtimeEvent);
          }
          if (derived.telemetryEvent) {
            telemetryEvents.push(derived.telemetryEvent);
          }
          if (derived.isTool) {
            toolSpansCount++;
          }
          if (derived.isGenAi) {
            genAiSpansCount++;
          }
        }
      }
    }
  }

  return {
    runtimeEvents,
    telemetryEvents,
    totalSpans,
    toolSpansCount,
    genAiSpansCount,
  };
}

interface ProcessedSpanResult {
  isToolOrGenAi: boolean;
  isTool: boolean;
  isGenAi: boolean;
  runtimeEvent?: RuntimeEvent | undefined;
  telemetryEvent?: TelemetryEvent | undefined;
}

function processSpan(
  span: OtlpSpan,
  serviceName: string,
  inheritedTenantId: string,
  defaultTokenizer: string,
): ProcessedSpanResult {
  const spanAttrs = otlpAttributesToRecord(span.attributes);

  // 1. Determine Tenant ID
  const tenantId =
    typeof spanAttrs["tenant.id"] === "string"
      ? spanAttrs["tenant.id"]
      : typeof spanAttrs["tenant_id"] === "string"
        ? spanAttrs["tenant_id"]
        : inheritedTenantId;

  // 2. Determine Principal ID
  const principalId =
    typeof spanAttrs["principal.id"] === "string"
      ? spanAttrs["principal.id"]
      : typeof spanAttrs["user.id"] === "string"
        ? spanAttrs["user.id"]
        : typeof spanAttrs["enduser.id"] === "string"
          ? spanAttrs["enduser.id"]
          : undefined;

  // 3. Determine Tool / Operation Name
  let toolName: string | undefined;
  let isTool = false;
  let isGenAi = false;

  if (typeof spanAttrs["tool.name"] === "string") {
    toolName = spanAttrs["tool.name"];
    isTool = true;
  } else if (typeof spanAttrs["mcp.tool_name"] === "string") {
    toolName = spanAttrs["mcp.tool_name"];
    isTool = true;
  } else if (typeof spanAttrs["gen_ai.tool.name"] === "string") {
    toolName = spanAttrs["gen_ai.tool.name"];
    isTool = true;
  } else if (typeof spanAttrs["mcp.method"] === "string") {
    const method = spanAttrs["mcp.method"];
    if (
      method === "tools/call" &&
      typeof spanAttrs["params.name"] === "string"
    ) {
      toolName = spanAttrs["params.name"];
      isTool = true;
    } else {
      toolName = `mcp.${method}`;
      isTool = true;
    }
  } else if (typeof span.name === "string" && span.name.startsWith("tool.")) {
    toolName = span.name.slice(5);
    isTool = true;
  } else if (typeof spanAttrs["gen_ai.operation.name"] === "string") {
    toolName = `gen_ai.${spanAttrs["gen_ai.operation.name"]}`;
    isGenAi = true;
  } else if (typeof spanAttrs["gen_ai.system"] === "string") {
    toolName = `gen_ai.${spanAttrs["gen_ai.system"]}`;
    isGenAi = true;
  } else if (
    span.name.includes("generate_content") ||
    span.name.includes("chat") ||
    span.name.includes("completions") ||
    span.name.includes("embeddings")
  ) {
    toolName = `gen_ai.${span.name}`;
    isGenAi = true;
  }

  // Check for GenAI token attributes regardless
  const hasGenAiTokens =
    spanAttrs["gen_ai.usage.input_tokens"] !== undefined ||
    spanAttrs["gen_ai.usage.output_tokens"] !== undefined ||
    spanAttrs["gen_ai.usage.total_tokens"] !== undefined ||
    spanAttrs["llm.usage.total_tokens"] !== undefined;

  if (hasGenAiTokens) {
    isGenAi = true;
  }

  if (!toolName) {
    // If not identifiable as tool or GenAI span, skip deriving tool metrics
    return { isToolOrGenAi: false, isTool: false, isGenAi: false };
  }

  // 4. Calculate Timestamps and Duration
  const startMs = otlpNanoToMs(span.startTimeUnixNano);
  const endMs = otlpNanoToMs(span.endTimeUnixNano);
  let durationMs =
    typeof spanAttrs["duration_ms"] === "number"
      ? spanAttrs["duration_ms"]
      : Math.max(0, endMs - startMs);

  if (durationMs === 0 && endMs > startMs) {
    durationMs = endMs - startMs;
  }

  // 5. Determine Outcome
  let outcome: "success" | "error" | "rate_limited" = "success";
  let isError = false;

  const rawOutcome = spanAttrs["outcome"];
  if (
    rawOutcome === "success" ||
    rawOutcome === "error" ||
    rawOutcome === "rate_limited"
  ) {
    outcome = rawOutcome;
    isError = outcome === "error" || outcome === "rate_limited";
  } else if (
    span.status?.code === OtlpStatusCode.STATUS_CODE_ERROR ||
    spanAttrs["error"] === true ||
    spanAttrs["mcp.is_error"] === true
  ) {
    outcome = "error";
    isError = true;
  }

  // 6. Error Code & Details
  let rawErrorCode: string | undefined;
  if (typeof spanAttrs["error.code"] === "string") {
    rawErrorCode = spanAttrs["error.code"];
  } else if (typeof spanAttrs["error.type"] === "string") {
    rawErrorCode = spanAttrs["error.type"];
  } else if (typeof spanAttrs["exception.type"] === "string") {
    rawErrorCode = spanAttrs["exception.type"];
  } else if (isError && span.status?.message) {
    rawErrorCode = span.status.message;
  }

  let mappedErrorCode: RuntimeErrorCode | undefined;
  if (rawErrorCode) {
    if (
      rawErrorCode.includes("RATE_LIMIT") ||
      rawErrorCode.includes("429") ||
      rawErrorCode.includes("THROTTLED")
    ) {
      outcome = "rate_limited";
      mappedErrorCode = "RATE_LIMITED";
    } else if (
      rawErrorCode.includes("TIMEOUT") ||
      rawErrorCode.includes("504") ||
      rawErrorCode.includes("DEADLINE")
    ) {
      mappedErrorCode = "UPSTREAM_TIMEOUT";
    } else if (
      rawErrorCode.includes("AUTH") ||
      rawErrorCode.includes("401") ||
      rawErrorCode.includes("403")
    ) {
      mappedErrorCode = "AUTH_FORBIDDEN";
    } else if (
      rawErrorCode.includes("NOT_FOUND") ||
      rawErrorCode.includes("404")
    ) {
      mappedErrorCode = "TOOL_NOT_FOUND";
    } else if (
      rawErrorCode.includes("INVALID") ||
      rawErrorCode.includes("400")
    ) {
      mappedErrorCode = "INPUT_INVALID";
    } else {
      mappedErrorCode = "UPSTREAM_FAILURE";
    }
  } else if (isError) {
    mappedErrorCode = "UPSTREAM_FAILURE";
  }

  // 7. Cache Outcome
  let cacheOutcome: "hit" | "miss" | "bypass" | undefined;
  let isCached = false;
  const rawCache = spanAttrs["cache.outcome"];
  if (rawCache === "hit" || rawCache === "miss" || rawCache === "bypass") {
    cacheOutcome = rawCache;
    isCached = cacheOutcome === "hit";
  } else if (spanAttrs["cached"] === true) {
    cacheOutcome = "hit";
    isCached = true;
  }

  // 8. Token Accounting (GenAI Semantic Conventions)
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let hasTokens = false;

  const rawInput =
    spanAttrs["gen_ai.usage.input_tokens"] ??
    spanAttrs["gen_ai.usage.prompt_tokens"];
  if (typeof rawInput === "number") {
    inputTokens = rawInput;
    hasTokens = true;
  }

  const rawOutput =
    spanAttrs["gen_ai.usage.output_tokens"] ??
    spanAttrs["gen_ai.usage.completion_tokens"];
  if (typeof rawOutput === "number") {
    outputTokens = rawOutput;
    hasTokens = true;
  }

  const rawTotal =
    spanAttrs["gen_ai.usage.total_tokens"] ??
    spanAttrs["llm.usage.total_tokens"] ??
    spanAttrs["tokens.total"];
  if (typeof rawTotal === "number") {
    totalTokens = rawTotal;
    hasTokens = true;
  } else if (hasTokens) {
    totalTokens = inputTokens + outputTokens;
  }

  const model =
    typeof spanAttrs["gen_ai.request.model"] === "string"
      ? spanAttrs["gen_ai.request.model"]
      : typeof spanAttrs["gen_ai.response.model"] === "string"
        ? spanAttrs["gen_ai.response.model"]
        : defaultTokenizer;

  const payloadBytes =
    typeof spanAttrs["payload_bytes"] === "number"
      ? spanAttrs["payload_bytes"]
      : typeof spanAttrs["response_bytes"] === "number"
        ? spanAttrs["response_bytes"]
        : 0;

  // Build RuntimeEvent
  const runtimeEvent: RuntimeEvent = {
    name: "tool_invocation",
    timestamp: startMs,
    toolName,
    tenantId,
    durationMs,
    outcome,
    ...(mappedErrorCode ? { errorCode: mappedErrorCode } : {}),
    ...(cacheOutcome ? { cacheOutcome } : {}),
    ...(hasTokens
      ? {
          tokenUsage: {
            count: totalTokens,
            measurement: "exact",
            tokenizer: model,
            payloadBytes,
          },
        }
      : {}),
  };

  // Build TelemetryEvent
  const telemetryEvent: TelemetryEvent = {
    id: span.spanId,
    timestamp: startMs,
    tenantId,
    toolName,
    durationMs,
    isError,
    ...(rawErrorCode ? { errorCode: rawErrorCode } : {}),
    cached: isCached,
    ...(hasTokens ? { tokenCount: totalTokens } : {}),
    metadata: {
      traceId: span.traceId,
      spanId: span.spanId,
      ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
      serviceName,
      ...(principalId ? { principalId } : {}),
      ...(model ? { model } : {}),
      ...(inputTokens ? { inputTokens } : {}),
      ...(outputTokens ? { outputTokens } : {}),
    },
  };

  return {
    isToolOrGenAi: true,
    isTool,
    isGenAi,
    runtimeEvent,
    telemetryEvent,
  };
}

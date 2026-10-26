import {
  trace,
  type Tracer,
  type Span,
  SpanStatusCode,
} from "@opentelemetry/api";
import type { ToolContext } from "@chainmcp/core";

export interface ToolTracerOptions {
  tracer?: Tracer;
  tracerName?: string;
  tracerVersion?: string;
}

export class ToolTracer {
  private readonly tracer: Tracer;

  constructor(options?: ToolTracerOptions) {
    this.tracer =
      options?.tracer ??
      trace.getTracer(
        options?.tracerName ?? "chainmcp",
        options?.tracerVersion ?? "0.1.0",
      );
  }

  startToolSpan(
    toolName: string,
    context: ToolContext,
    contractRevision?: string,
  ): Span {
    try {
      const span = this.tracer.startSpan(`chainmcp.tool_call:${toolName}`, {
        attributes: {
          "mcp.tool_name": toolName,
          "tenant.id": context.tenantId,
          "principal.id": context.principal?.id ?? "unknown",
          "mcp.request_id": context.requestId,
          ...(contractRevision
            ? { "contract.revision": contractRevision }
            : {}),
        },
      });
      return span;
    } catch {
      // Fallback no-op span if tracer fails
      return trace.wrapSpanContext({
        traceId: "00000000000000000000000000000000",
        spanId: "0000000000000000",
        traceFlags: 0,
      });
    }
  }

  endToolSpan(
    span: Span,
    details?: {
      error?: unknown;
      cacheOutcome?: string;
    },
  ): void {
    try {
      if (details?.cacheOutcome) {
        span.setAttribute("cache.outcome", details.cacheOutcome);
      }

      if (details?.error) {
        const err =
          details.error instanceof Error
            ? details.error
            : new Error(String(details.error));
        span.recordException(err);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: err.message,
        });
      } else {
        span.setStatus({ code: SpanStatusCode.OK });
      }
    } catch {
      // Tracing failure isolation
    } finally {
      try {
        span.end();
      } catch {
        // Ignore span.end failures
      }
    }
  }
}

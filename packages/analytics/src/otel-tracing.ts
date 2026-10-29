import {
  context as otelContext,
  trace,
  type Tracer,
  type Span,
  SpanStatusCode,
} from "@opentelemetry/api";
import type { ToolContext, ToolTracer as CoreToolTracer } from "@chainmcp/core";
import { redactString } from "./redaction.js";

export interface ToolTracerOptions {
  tracer?: Tracer;
  tracerName?: string;
  tracerVersion?: string;
  sampleRatio?: number;
  endpoint?: string;
}

export class ToolTracer implements CoreToolTracer {
  private readonly tracer: Tracer;
  private readonly sampleRatio: number;
  public readonly endpoint?: string | undefined;

  constructor(options?: ToolTracerOptions) {
    this.tracer =
      options?.tracer ??
      trace.getTracer(
        options?.tracerName ?? "chainmcp",
        options?.tracerVersion ?? "0.1.0",
      );
    this.sampleRatio =
      typeof options?.sampleRatio === "number" &&
      options.sampleRatio >= 0 &&
      options.sampleRatio <= 1
        ? options.sampleRatio
        : 1.0;
    this.endpoint = options?.endpoint;
  }

  startToolSpan(
    toolName: string,
    context: ToolContext,
    contractRevision?: string | undefined,
  ): Span {
    try {
      if (this.sampleRatio < 1.0 && Math.random() >= this.sampleRatio) {
        return trace.wrapSpanContext({
          traceId: "00000000000000000000000000000000",
          spanId: "0000000000000000",
          traceFlags: 0,
        });
      }

      const span = this.tracer.startSpan(`tool.${toolName}`, {
        attributes: {
          "tool.name": toolName,
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
      cacheOutcome?: string | undefined;
      outcome?: "success" | "error" | "rate_limited" | undefined;
      durationMs?: number | undefined;
      cached?: boolean | undefined;
    },
  ): void {
    try {
      if (details?.outcome !== undefined) {
        span.setAttribute("outcome", details.outcome);
      } else if (details?.error) {
        span.setAttribute("outcome", "error");
      } else {
        span.setAttribute("outcome", "success");
      }

      if (details?.durationMs !== undefined) {
        span.setAttribute("duration_ms", details.durationMs);
      }

      if (details?.cacheOutcome !== undefined) {
        span.setAttribute("cache.outcome", details.cacheOutcome);
      }

      if (details?.cached !== undefined) {
        span.setAttribute("cached", details.cached);
      } else if (details?.cacheOutcome !== undefined) {
        span.setAttribute("cached", details.cacheOutcome === "hit");
      }

      if (details?.error) {
        const err =
          details.error instanceof Error
            ? details.error
            : new Error(String(details.error));
        span.recordException(err);
        const safeMsg = redactString(err.message);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: safeMsg,
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

  startChildSpan(
    name: string,
    attributes?: Record<string, string | number | boolean> | undefined,
  ): Span {
    try {
      return attributes !== undefined
        ? this.tracer.startSpan(name, { attributes })
        : this.tracer.startSpan(name);
    } catch {
      return trace.wrapSpanContext({
        traceId: "00000000000000000000000000000000",
        spanId: "0000000000000000",
        traceFlags: 0,
      });
    }
  }

  endSpan(
    span: Span,
    details?: {
      error?: unknown;
      outcome?: "success" | "error" | "rate_limited" | "cancelled" | undefined;
      durationMs?: number | undefined;
    },
  ): void {
    try {
      if (details?.outcome !== undefined) {
        span.setAttribute("outcome", details.outcome);
      }
      if (details?.durationMs !== undefined) {
        span.setAttribute("duration_ms", details.durationMs);
      }
      if (details?.error) {
        const err =
          details.error instanceof Error
            ? details.error
            : new Error(String(details.error));
        span.recordException(err);
        const safeMsg = redactString(err.message);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: safeMsg,
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

  withSpan<T>(span: Span, fn: () => Promise<T> | T): Promise<T> {
    try {
      return otelContext.with(
        trace.setSpan(otelContext.active(), span),
        async () => {
          return await fn();
        },
      );
    } catch {
      return Promise.resolve().then(fn);
    }
  }
}

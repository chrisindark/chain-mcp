import {
  metrics,
  type Meter,
  type Counter,
  type Histogram,
} from "@opentelemetry/api";
import type { MetricsSink, RuntimeEvent } from "@chainmcp/core";

export interface OpenTelemetryMetricsSinkOptions {
  meter?: Meter;
  meterName?: string;
  meterVersion?: string;
}

export class OpenTelemetryMetricsSink implements MetricsSink {
  private readonly invocationsCounter: Counter;
  private readonly durationHistogram: Histogram;
  private readonly tokensCounter: Counter;
  private readonly payloadBytesHistogram: Histogram;

  constructor(options?: OpenTelemetryMetricsSinkOptions) {
    const meter =
      options?.meter ??
      metrics.getMeter(
        options?.meterName ?? "chainmcp",
        options?.meterVersion ?? "0.1.0",
      );

    this.invocationsCounter = meter.createCounter("chainmcp.tool.invocations", {
      description: "Counts total tool invocations by outcome and tool",
      unit: "{invocation}",
    });

    this.durationHistogram = meter.createHistogram("chainmcp.tool.duration", {
      description: "Measures tool execution duration in milliseconds",
      unit: "ms",
    });

    this.tokensCounter = meter.createCounter("chainmcp.tool.tokens", {
      description: "Counts tokens measured or estimated for tool results",
      unit: "{token}",
    });

    this.payloadBytesHistogram = meter.createHistogram(
      "chainmcp.tool.payload_bytes",
      {
        description: "Measures serialized result byte sizes",
        unit: "By",
      },
    );
  }

  record(event: RuntimeEvent): void {
    try {
      const attributes: Record<string, string> = {
        "tool.name": event.toolName,
        "tenant.id": event.tenantId,
        outcome: event.outcome,
        ...(event.errorCode ? { "error.code": event.errorCode } : {}),
        ...(event.cacheOutcome ? { "cache.outcome": event.cacheOutcome } : {}),
      };

      this.invocationsCounter.add(1, attributes);
      this.durationHistogram.record(event.durationMs, {
        "tool.name": event.toolName,
        "tenant.id": event.tenantId,
        outcome: event.outcome,
      });

      if (event.tokenUsage) {
        this.tokensCounter.add(event.tokenUsage.count, {
          "tool.name": event.toolName,
          "tenant.id": event.tenantId,
          measurement: event.tokenUsage.measurement,
          tokenizer: event.tokenUsage.tokenizer,
        });

        this.payloadBytesHistogram.record(event.tokenUsage.payloadBytes, {
          "tool.name": event.toolName,
          "tenant.id": event.tenantId,
        });
      }
    } catch {
      // Telemetry failures must never disrupt execution.
    }
  }
}

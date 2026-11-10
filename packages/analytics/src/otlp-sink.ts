import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  Logger,
  MetricsSink,
  RuntimeErrorCode,
  RuntimeEvent,
} from "@chainmcp/core";
import type { TelemetryEvent, TelemetryRingBuffer } from "@chainmcp/storage";
import {
  type ExportMetricsServiceRequest,
  type ExportMetricsServiceResponse,
  type ExportTraceServiceRequest,
  type ExportTraceServiceResponse,
  type OtlpMetric,
  otlpAttributesToRecord,
  otlpNanoToMs,
} from "./otlp-types.js";
import { deriveMetricsFromSpans } from "./span-derivation.js";

export const DEFAULT_MAX_OTLP_REQUEST_BYTES = 5 * 1024 * 1024; // 5 MiB

export interface OtlpAuthContext {
  readonly headers: Record<string, string | string[] | undefined>;
  readonly path: string;
  readonly method: string;
}

export interface OtlpIngestionSinkOptions {
  readonly metricsSink?: MetricsSink | undefined;
  readonly telemetryRingBuffer?: TelemetryRingBuffer | undefined;
  readonly logger?: Logger | undefined;
  readonly defaultTenantId?: string | undefined;
  readonly maxRequestBytes?: number | undefined;
  readonly authenticator?:
    ((context: OtlpAuthContext) => boolean | Promise<boolean>) | undefined;
  readonly onDerivedEvents?:
    | ((events: {
        runtimeEvents: RuntimeEvent[];
        telemetryEvents: TelemetryEvent[];
      }) => void | Promise<void>)
    | undefined;
}

export class OtlpIngestionSink {
  private readonly metricsSink?: MetricsSink | undefined;
  private readonly telemetryRingBuffer?: TelemetryRingBuffer | undefined;
  private readonly logger?: Logger | undefined;
  private readonly defaultTenantId: string;
  private readonly maxRequestBytes: number;
  private readonly authenticator?:
    ((context: OtlpAuthContext) => boolean | Promise<boolean>) | undefined;
  private readonly onDerivedEvents?:
    | ((events: {
        runtimeEvents: RuntimeEvent[];
        telemetryEvents: TelemetryEvent[];
      }) => void | Promise<void>)
    | undefined;

  constructor(options?: OtlpIngestionSinkOptions) {
    this.metricsSink = options?.metricsSink;
    this.telemetryRingBuffer = options?.telemetryRingBuffer;
    this.logger = options?.logger;
    this.defaultTenantId = options?.defaultTenantId ?? "default";
    this.maxRequestBytes =
      options?.maxRequestBytes ?? DEFAULT_MAX_OTLP_REQUEST_BYTES;
    this.authenticator = options?.authenticator;
    this.onDerivedEvents = options?.onDerivedEvents;
  }

  /**
   * Ingests OTLP traces (`POST /v1/traces`), derives GenAI and MCP metrics,
   * delivers runtime events to MetricsSink, and offloads TelemetryEvents
   * asynchronously to TelemetryRingBuffer.
   */
  async ingestTraces(
    payload: ExportTraceServiceRequest | string,
    overrideTenantId?: string,
  ): Promise<ExportTraceServiceResponse> {
    const request = (
      typeof payload === "string" ? JSON.parse(payload) : payload
    ) as ExportTraceServiceRequest;

    const { runtimeEvents, telemetryEvents } = deriveMetricsFromSpans(request, {
      defaultTenantId: overrideTenantId ?? this.defaultTenantId,
    });

    // 1. Synchronous in-memory delivery to MetricsSink (sub-5ms)
    if (this.metricsSink && runtimeEvents.length > 0) {
      for (const event of runtimeEvents) {
        try {
          this.metricsSink.record(event);
        } catch (err) {
          this.logger?.warn?.("Failed to record derived runtime event", {
            error: err instanceof Error ? err.message : String(err),
            toolName: event.toolName,
          });
        }
      }
    }

    // 2. Asynchronous non-blocking persistence to TelemetryRingBuffer
    if (this.telemetryRingBuffer && telemetryEvents.length > 0) {
      void this.telemetryRingBuffer.pushBatch(telemetryEvents).catch((err) => {
        this.logger?.warn?.(
          "Failed to asynchronously persist telemetry events to ring buffer",
          {
            error: err instanceof Error ? err.message : String(err),
            eventCount: telemetryEvents.length,
          },
        );
      });
    }

    // 3. Optional notification hook
    if (
      this.onDerivedEvents &&
      (runtimeEvents.length > 0 || telemetryEvents.length > 0)
    ) {
      void Promise.resolve()
        .then(() => this.onDerivedEvents!({ runtimeEvents, telemetryEvents }))
        .catch((err) => {
          this.logger?.warn?.("Error in onDerivedEvents hook", {
            error: err instanceof Error ? err.message : String(err),
          });
        });
    }

    return {
      partialSuccess: {},
    };
  }

  /**
   * Ingests direct OTLP metrics (`POST /v1/metrics`).
   */
  async ingestMetrics(
    payload: ExportMetricsServiceRequest | string,
    overrideTenantId?: string,
  ): Promise<ExportMetricsServiceResponse> {
    const request = (
      typeof payload === "string" ? JSON.parse(payload) : payload
    ) as ExportMetricsServiceRequest;

    const tenantId = overrideTenantId ?? this.defaultTenantId;
    const resourceMetricsList = request.resourceMetrics;

    if (this.metricsSink && Array.isArray(resourceMetricsList)) {
      for (const resourceMetrics of resourceMetricsList) {
        const scopeMetricsList = resourceMetrics.scopeMetrics;
        if (!Array.isArray(scopeMetricsList)) continue;

        for (const scopeMetrics of scopeMetricsList) {
          const metrics = scopeMetrics.metrics;
          if (!Array.isArray(metrics)) continue;

          for (const metric of metrics) {
            this.processDirectMetric(metric, tenantId);
          }
        }
      }
    }

    return {
      partialSuccess: {},
    };
  }

  private processDirectMetric(metric: OtlpMetric, defaultTenant: string): void {
    if (!this.metricsSink) return;

    if (metric.name === "chainmcp.tool.invocations" && metric.sum?.dataPoints) {
      for (const dp of metric.sum.dataPoints) {
        const attrs = otlpAttributesToRecord(dp.attributes);
        const toolName =
          typeof attrs["tool.name"] === "string"
            ? attrs["tool.name"]
            : "unknown";
        const tenantId =
          typeof attrs["tenant.id"] === "string"
            ? attrs["tenant.id"]
            : defaultTenant;
        const outcome =
          attrs["outcome"] === "error" || attrs["outcome"] === "rate_limited"
            ? attrs["outcome"]
            : "success";

        let errorCode: RuntimeErrorCode | undefined;
        if (typeof attrs["error.code"] === "string") {
          const raw = attrs["error.code"];
          if (raw.includes("RATE_LIMIT") || raw.includes("429")) {
            errorCode = "RATE_LIMITED";
          } else {
            errorCode = "UPSTREAM_FAILURE";
          }
        }

        let cacheOutcome: "hit" | "miss" | "bypass" | undefined;
        if (
          attrs["cache.outcome"] === "hit" ||
          attrs["cache.outcome"] === "miss" ||
          attrs["cache.outcome"] === "bypass"
        ) {
          cacheOutcome = attrs["cache.outcome"];
        }

        const durationMs =
          dp.timeUnixNano && dp.startTimeUnixNano
            ? Math.max(
                0,
                otlpNanoToMs(dp.timeUnixNano) -
                  otlpNanoToMs(dp.startTimeUnixNano),
              )
            : 0;

        const timestamp = dp.timeUnixNano
          ? otlpNanoToMs(dp.timeUnixNano)
          : Date.now();

        try {
          this.metricsSink.record({
            name: "tool_invocation",
            timestamp,
            toolName,
            tenantId,
            durationMs,
            outcome,
            ...(errorCode ? { errorCode } : {}),
            ...(cacheOutcome ? { cacheOutcome } : {}),
          });
        } catch {
          // ignore metrics sink failures
        }
      }
    }
  }

  /**
   * Returns a Node.js HTTP request handler suitable for mounting in an HTTP server.
   * Returns a Promise resolving to `true` if the request was an OTLP endpoint and handled,
   * or `false` if the request was not for an OTLP endpoint.
   */
  createHttpHandler(): (
    req: IncomingMessage,
    res: ServerResponse,
  ) => Promise<boolean> {
    return async (
      req: IncomingMessage,
      res: ServerResponse,
    ): Promise<boolean> => {
      const url = req.url ?? "/";
      const pathname = url.split("?")[0] ?? "/";

      const isTraces = pathname === "/v1/traces";
      const isMetrics = pathname === "/v1/metrics";

      if (!isTraces && !isMetrics) {
        return false;
      }

      // Check HTTP Method
      if (req.method !== "POST") {
        res.statusCode = 405;
        res.setHeader("Allow", "POST");
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            error: "Method Not Allowed",
            message: "OTLP endpoints only support POST",
          }),
        );
        return true;
      }

      // Check Content-Type
      const contentType = req.headers["content-type"] ?? "";
      if (
        !contentType.includes("application/json") &&
        !contentType.includes("text/plain")
      ) {
        res.statusCode = 415;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            error: "Unsupported Media Type",
            message: "OTLP/HTTP sink requires Content-Type: application/json",
          }),
        );
        return true;
      }

      // Check Authentication if configured
      if (this.authenticator) {
        try {
          const authorized = await this.authenticator({
            headers: req.headers,
            path: pathname,
            method: req.method,
          });
          if (!authorized) {
            res.statusCode = 401;
            res.setHeader("Content-Type", "application/json");
            res.end(
              JSON.stringify({
                error: "Unauthorized",
                message: "Invalid or missing credentials for OTLP ingestion",
              }),
            );
            return true;
          }
        } catch {
          res.statusCode = 401;
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({
              error: "Unauthorized",
              message: "Authentication failure during OTLP ingestion",
            }),
          );
          return true;
        }
      }

      // Read Body with strict byte limit
      let body: string;
      try {
        body = await readRequestBody(req, this.maxRequestBytes);
      } catch (err) {
        if (err instanceof Error && err.message === "PAYLOAD_TOO_LARGE") {
          res.statusCode = 413;
          res.setHeader("Connection", "close");
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({
              error: "Payload Too Large",
              message: `OTLP payload exceeds maximum allowed size of ${this.maxRequestBytes} bytes`,
            }),
          );
          return true;
        }
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            error: "Bad Request",
            message: "Failed to read request body",
          }),
        );
        return true;
      }

      if (!body.trim()) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            error: "Bad Request",
            message: "Request body cannot be empty",
          }),
        );
        return true;
      }

      // Parse JSON and ingest
      try {
        let responsePayload: unknown;
        if (isTraces) {
          responsePayload = await this.ingestTraces(body);
        } else {
          responsePayload = await this.ingestMetrics(body);
        }

        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(responsePayload ?? {}));
        return true;
      } catch {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            error: "Bad Request",
            message: "Malformed JSON payload in OTLP request",
          }),
        );
        return true;
      }
    };
  }
}

/**
 * Creates an OTLP HTTP handler function for use with standard Node HTTP servers.
 */
export function createOtlpHttpHandler(
  options?: OtlpIngestionSinkOptions,
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const sink = new OtlpIngestionSink(options);
  return sink.createHttpHandler();
}

function readRequestBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    let exceeded = false;

    req.on("data", (chunk: Buffer) => {
      if (exceeded) return;
      size += chunk.length;
      if (size > maxBytes) {
        exceeded = true;
        req.pause();
        req.resume();
        reject(new Error("PAYLOAD_TOO_LARGE"));
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (!exceeded) {
        resolve(Buffer.concat(chunks).toString("utf-8"));
      }
    });

    req.on("error", (err) => {
      reject(err);
    });
  });
}

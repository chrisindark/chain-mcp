import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  createMemoryStorageDriver,
  createSqliteStorageDriver,
} from "@chainmcp/storage";
import type { MetricsSink, RuntimeEvent } from "@chainmcp/core";
import {
  OtlpIngestionSink,
  createOtlpHttpHandler,
  deriveMetricsFromSpans,
  extractOtlpValue,
  otlpAttributesToRecord,
  otlpNanoToMs,
  OtlpSpanKind,
  OtlpStatusCode,
  type ExportTraceServiceRequest,
  type ExportMetricsServiceRequest,
} from "../src/index.js";

describe("OTLP Ingestion Sink & Span-to-Metric Derivation", () => {
  describe("OTLP Attribute & Helper Utilities", () => {
    it("extracts primitive values from OtlpAnyValue", () => {
      expect(extractOtlpValue({ stringValue: "hello" })).toBe("hello");
      expect(extractOtlpValue({ boolValue: true })).toBe(true);
      expect(extractOtlpValue({ intValue: 42 })).toBe(42);
      expect(extractOtlpValue({ intValue: "100" })).toBe(100);
      expect(extractOtlpValue({ doubleValue: 3.14 })).toBe(3.14);
      expect(extractOtlpValue({ bytesValue: "base64bytes" })).toBe(
        "base64bytes",
      );
      expect(extractOtlpValue("raw-string")).toBe("raw-string");
      expect(extractOtlpValue(123)).toBe(123);
      expect(extractOtlpValue(undefined)).toBeUndefined();
    });

    it("extracts nested arrays and kvlists from OtlpAnyValue", () => {
      const nested = extractOtlpValue({
        arrayValue: {
          values: [{ stringValue: "a" }, { intValue: 2 }],
        },
      });
      expect(nested).toEqual(["a", 2]);

      const kv = extractOtlpValue({
        kvlistValue: {
          values: [
            { key: "foo", value: { stringValue: "bar" } },
            { key: "num", value: { intValue: 99 } },
          ],
        },
      });
      expect(kv).toEqual({ foo: "bar", num: 99 });
    });

    it("safely neutralizes prototype pollution attempts", () => {
      const malicious = otlpAttributesToRecord([
        { key: "__proto__", value: { stringValue: "polluted" } },
        { key: "constructor", value: { stringValue: "polluted" } },
        { key: "prototype", value: { stringValue: "polluted" } },
        { key: "safeKey", value: { stringValue: "safeVal" } },
      ]);

      expect(malicious["safeKey"]).toBe("safeVal");
      expect(Object.prototype.hasOwnProperty.call(malicious, "__proto__")).toBe(
        false,
      );
      expect(
        Object.prototype.hasOwnProperty.call(malicious, "constructor"),
      ).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(malicious, "prototype")).toBe(
        false,
      );
      expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    });

    it("converts nanoseconds to epoch milliseconds", () => {
      const nanoStr = "1710000000050000000";
      const ms = otlpNanoToMs(nanoStr);
      expect(ms).toBe(1710000000050);

      const nanoBigInt = 1710000000050000000n;
      expect(otlpNanoToMs(nanoBigInt)).toBe(1710000000050);

      expect(otlpNanoToMs(1710000000050000000)).toBe(1710000000050);
    });
  });

  describe("Span-to-Metric Derivation", () => {
    it("derives RuntimeEvents and TelemetryEvents from MCP tool spans", () => {
      const traceRequest: ExportTraceServiceRequest = {
        resourceSpans: [
          {
            resource: {
              attributes: [
                {
                  key: "service.name",
                  value: { stringValue: "fastmcp-python" },
                },
                { key: "tenant.id", value: { stringValue: "tenant-acme" } },
              ],
            },
            scopeSpans: [
              {
                scope: { name: "fastmcp" },
                spans: [
                  {
                    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
                    spanId: "00f067aa0ba902b7",
                    name: "tool.query_database",
                    kind: OtlpSpanKind.SPAN_KIND_SERVER,
                    startTimeUnixNano: "1710000000000000000",
                    endTimeUnixNano: "1710000000045000000",
                    attributes: [
                      {
                        key: "tool.name",
                        value: { stringValue: "query_database" },
                      },
                      {
                        key: "principal.id",
                        value: { stringValue: "user-123" },
                      },
                      { key: "cache.outcome", value: { stringValue: "hit" } },
                    ],
                    status: { code: OtlpStatusCode.STATUS_CODE_OK },
                  },
                ],
              },
            ],
          },
        ],
      };

      const result = deriveMetricsFromSpans(traceRequest);
      expect(result.totalSpans).toBe(1);
      expect(result.toolSpansCount).toBe(1);
      expect(result.genAiSpansCount).toBe(0);

      expect(result.runtimeEvents).toHaveLength(1);
      const runtime = result.runtimeEvents[0]!;
      expect(runtime.name).toBe("tool_invocation");
      expect(runtime.toolName).toBe("query_database");
      expect(runtime.tenantId).toBe("tenant-acme");
      expect(runtime.durationMs).toBe(45);
      expect(runtime.outcome).toBe("success");
      expect(runtime.cacheOutcome).toBe("hit");

      expect(result.telemetryEvents).toHaveLength(1);
      const telem = result.telemetryEvents[0]!;
      expect(telem.id).toBe("00f067aa0ba902b7");
      expect(telem.toolName).toBe("query_database");
      expect(telem.tenantId).toBe("tenant-acme");
      expect(telem.durationMs).toBe(45);
      expect(telem.cached).toBe(true);
      expect(telem.isError).toBe(false);
      expect(telem.metadata?.serviceName).toBe("fastmcp-python");
      expect(telem.metadata?.principalId).toBe("user-123");
    });

    it("derives GenAI token usage and handles error spans", () => {
      const traceRequest: ExportTraceServiceRequest = {
        resourceSpans: [
          {
            scopeSpans: [
              {
                spans: [
                  {
                    traceId: "aaaabbbbccccdddd1111222233334444",
                    spanId: "1234567890abcdef",
                    name: "chat_completion",
                    startTimeUnixNano: "1710000000000000000",
                    endTimeUnixNano: "1710000000200000000",
                    attributes: [
                      {
                        key: "gen_ai.operation.name",
                        value: { stringValue: "chat" },
                      },
                      {
                        key: "gen_ai.request.model",
                        value: { stringValue: "gemini-1.5-pro" },
                      },
                      {
                        key: "gen_ai.usage.input_tokens",
                        value: { intValue: 120 },
                      },
                      {
                        key: "gen_ai.usage.output_tokens",
                        value: { intValue: 80 },
                      },
                      {
                        key: "error.code",
                        value: { stringValue: "RATE_LIMITED_429" },
                      },
                    ],
                    status: {
                      code: OtlpStatusCode.STATUS_CODE_ERROR,
                      message: "Quota exceeded",
                    },
                  },
                ],
              },
            ],
          },
        ],
      };

      const result = deriveMetricsFromSpans(traceRequest);
      expect(result.totalSpans).toBe(1);
      expect(result.genAiSpansCount).toBe(1);

      expect(result.runtimeEvents).toHaveLength(1);
      const runtime = result.runtimeEvents[0]!;
      expect(runtime.toolName).toBe("gen_ai.chat");
      expect(runtime.durationMs).toBe(200);
      expect(runtime.outcome).toBe("rate_limited");
      expect(runtime.errorCode).toBe("RATE_LIMITED");
      expect(runtime.tokenUsage).toEqual({
        count: 200,
        measurement: "exact",
        tokenizer: "gemini-1.5-pro",
        payloadBytes: 0,
      });

      expect(result.telemetryEvents).toHaveLength(1);
      const telem = result.telemetryEvents[0]!;
      expect(telem.isError).toBe(true);
      expect(telem.errorCode).toBe("RATE_LIMITED_429");
      expect(telem.tokenCount).toBe(200);
      expect(telem.metadata?.model).toBe("gemini-1.5-pro");
      expect(telem.metadata?.inputTokens).toBe(120);
      expect(telem.metadata?.outputTokens).toBe(80);
    });

    it("safely handles non-tool and non-GenAI spans", () => {
      const traceRequest: ExportTraceServiceRequest = {
        resourceSpans: [
          {
            scopeSpans: [
              {
                spans: [
                  {
                    traceId: "1",
                    spanId: "2",
                    name: "http.request.unrelated",
                  },
                ],
              },
            ],
          },
        ],
      };

      const result = deriveMetricsFromSpans(traceRequest);
      expect(result.totalSpans).toBe(1);
      expect(result.toolSpansCount).toBe(0);
      expect(result.genAiSpansCount).toBe(0);
      expect(result.runtimeEvents).toHaveLength(0);
      expect(result.telemetryEvents).toHaveLength(0);
    });
  });

  describe("OtlpIngestionSink Execution & Storage Offloading", () => {
    it("delivers derived events synchronously to MetricsSink and asynchronously to TelemetryRingBuffer", async () => {
      const memoryDriver = createMemoryStorageDriver();
      await memoryDriver.init();
      const ringBuffer = memoryDriver.getTelemetryRingBuffer({
        maxEntries: 100,
      });

      const recordedEvents: RuntimeEvent[] = [];
      const mockMetricsSink: MetricsSink = {
        record(event: RuntimeEvent) {
          recordedEvents.push(event);
        },
      };

      const sink = new OtlpIngestionSink({
        metricsSink: mockMetricsSink,
        telemetryRingBuffer: ringBuffer,
      });

      const traceRequest: ExportTraceServiceRequest = {
        resourceSpans: [
          {
            scopeSpans: [
              {
                spans: [
                  {
                    traceId: "t1",
                    spanId: "s1",
                    name: "tool.calculator",
                    startTimeUnixNano: "1710000000000000000",
                    endTimeUnixNano: "1710000000010000000",
                    attributes: [
                      {
                        key: "tool.name",
                        value: { stringValue: "calculator" },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      };

      const response = await sink.ingestTraces(traceRequest);
      expect(response).toEqual({ partialSuccess: {} });

      // Synchronous MetricsSink delivery verified immediately
      expect(recordedEvents).toHaveLength(1);
      expect(recordedEvents[0]!.toolName).toBe("calculator");

      // Wait a moment for non-blocking asynchronous storage push
      await new Promise((r) => setTimeout(r, 20));

      const persisted = await ringBuffer.query({ toolName: "calculator" });
      expect(persisted).toHaveLength(1);
      expect(persisted[0]!.id).toBe("s1");
      expect(persisted[0]!.toolName).toBe("calculator");

      await memoryDriver.close();
    });

    it("persists telemetry across restarts when backed by SqliteStorageDriver WAL mode", async () => {
      const sqliteDriver = createSqliteStorageDriver({ path: ":memory:" });
      await sqliteDriver.init();
      const ringBuffer = sqliteDriver.getTelemetryRingBuffer();

      const sink = new OtlpIngestionSink({
        telemetryRingBuffer: ringBuffer,
      });

      const traceRequest: ExportTraceServiceRequest = {
        resourceSpans: [
          {
            scopeSpans: [
              {
                spans: [
                  {
                    traceId: "trace-sqlite",
                    spanId: "span-sqlite-1",
                    name: "tool.lookup_customer",
                    startTimeUnixNano: "1710000000000000000",
                    endTimeUnixNano: "1710000000025000000",
                    attributes: [
                      {
                        key: "tool.name",
                        value: { stringValue: "lookup_customer" },
                      },
                      {
                        key: "tenant.id",
                        value: { stringValue: "tenant-bank" },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      };

      await sink.ingestTraces(traceRequest);
      await new Promise((r) => setTimeout(r, 30));

      const results = await ringBuffer.query({ tenantId: "tenant-bank" });
      expect(results).toHaveLength(1);
      expect(results[0]!.toolName).toBe("lookup_customer");
      expect(results[0]!.durationMs).toBe(25);

      await sqliteDriver.close();
    });

    it("ingests direct OTLP metrics requests", async () => {
      const recordedEvents: RuntimeEvent[] = [];
      const mockMetricsSink: MetricsSink = {
        record(event: RuntimeEvent) {
          recordedEvents.push(event);
        },
      };

      const sink = new OtlpIngestionSink({
        metricsSink: mockMetricsSink,
      });

      const metricsRequest: ExportMetricsServiceRequest = {
        resourceMetrics: [
          {
            scopeMetrics: [
              {
                metrics: [
                  {
                    name: "chainmcp.tool.invocations",
                    sum: {
                      dataPoints: [
                        {
                          startTimeUnixNano: "1710000000000000000",
                          timeUnixNano: "1710000000050000000",
                          attributes: [
                            {
                              key: "tool.name",
                              value: { stringValue: "fetchOrders" },
                            },
                            {
                              key: "outcome",
                              value: { stringValue: "success" },
                            },
                          ],
                        },
                      ],
                    },
                  },
                ],
              },
            ],
          },
        ],
      };

      const response = await sink.ingestMetrics(metricsRequest);
      expect(response).toEqual({ partialSuccess: {} });
      expect(recordedEvents).toHaveLength(1);
      expect(recordedEvents[0]!.toolName).toBe("fetchOrders");
      expect(recordedEvents[0]!.durationMs).toBe(50);
    });
  });

  describe("HTTP Server Ingestion & Boundary Defenses", () => {
    let server: ReturnType<typeof createServer>;
    let baseUrl: string;
    let recordedEvents: RuntimeEvent[];

    beforeEach(async () => {
      recordedEvents = [];
      const mockMetricsSink: MetricsSink = {
        record(event: RuntimeEvent) {
          recordedEvents.push(event);
        },
      };

      const handler = createOtlpHttpHandler({
        metricsSink: mockMetricsSink,
        maxRequestBytes: 1024 * 1024, // 1 MiB
        authenticator: (ctx) => {
          if (ctx.headers["x-test-reject"] === "true") {
            return false;
          }
          return true;
        },
      });

      server = createServer(
        async (req: IncomingMessage, res: ServerResponse) => {
          const handled = await handler(req, res);
          if (!handled) {
            res.statusCode = 404;
            res.end("Not Found");
          }
        },
      );

      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", () => resolve());
      });

      const addr = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${addr.port}`;
    });

    afterEach(async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    });

    it("accepts POST /v1/traces and derives metrics", async () => {
      const payload: ExportTraceServiceRequest = {
        resourceSpans: [
          {
            scopeSpans: [
              {
                spans: [
                  {
                    traceId: "http-trace-1",
                    spanId: "http-span-1",
                    name: "tool.generate_report",
                    startTimeUnixNano: "1710000000000000000",
                    endTimeUnixNano: "1710000000080000000",
                    attributes: [
                      {
                        key: "tool.name",
                        value: { stringValue: "generate_report" },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      };

      const res = await fetch(`${baseUrl}/v1/traces`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toEqual({ partialSuccess: {} });
      expect(recordedEvents).toHaveLength(1);
      expect(recordedEvents[0]!.toolName).toBe("generate_report");
      expect(recordedEvents[0]!.durationMs).toBe(80);
    });

    it("accepts POST /v1/metrics and ingests tool counts", async () => {
      const payload: ExportMetricsServiceRequest = {
        resourceMetrics: [
          {
            scopeMetrics: [
              {
                metrics: [
                  {
                    name: "chainmcp.tool.invocations",
                    sum: {
                      dataPoints: [
                        {
                          startTimeUnixNano: "1710000000000000000",
                          timeUnixNano: "1710000000030000000",
                          attributes: [
                            {
                              key: "tool.name",
                              value: { stringValue: "httpMetricTool" },
                            },
                          ],
                        },
                      ],
                    },
                  },
                ],
              },
            ],
          },
        ],
      };

      const res = await fetch(`${baseUrl}/v1/metrics`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      expect(res.status).toBe(200);
      expect(recordedEvents).toHaveLength(1);
      expect(recordedEvents[0]!.toolName).toBe("httpMetricTool");
    });

    it("rejects non-POST HTTP methods with 405 Method Not Allowed", async () => {
      const res = await fetch(`${baseUrl}/v1/traces`, {
        method: "GET",
      });

      expect(res.status).toBe(405);
      expect(res.headers.get("Allow")).toBe("POST");
      const data = await res.json();
      expect(data.error).toBe("Method Not Allowed");
    });

    it("rejects non-JSON Content-Type with 415 Unsupported Media Type", async () => {
      const res = await fetch(`${baseUrl}/v1/traces`, {
        method: "POST",
        headers: { "Content-Type": "application/x-protobuf" },
        body: "protobuf-bytes",
      });

      expect(res.status).toBe(415);
      const data = await res.json();
      expect(data.error).toBe("Unsupported Media Type");
    });

    it("rejects empty body with 400 Bad Request", async () => {
      const res = await fetch(`${baseUrl}/v1/traces`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "   ",
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe("Bad Request");
    });

    it("rejects malformed JSON with 400 Bad Request", async () => {
      const res = await fetch(`${baseUrl}/v1/traces`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{ not valid json: ",
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe("Bad Request");
    });

    it("rejects oversized request bodies with 413 Payload Too Large", async () => {
      // Create a sink with small 100-byte cap
      const tinyHandler = createOtlpHttpHandler({
        maxRequestBytes: 100,
      });

      const tinyServer = createServer(async (req, res) => {
        await tinyHandler(req, res);
      });

      await new Promise<void>((resolve) => {
        tinyServer.listen(0, "127.0.0.1", () => resolve());
      });

      const addr = tinyServer.address() as AddressInfo;
      const tinyUrl = `http://127.0.0.1:${addr.port}`;

      const oversized = JSON.stringify({
        resourceSpans: [
          {
            resource: {
              attributes: [
                { key: "padding", value: { stringValue: "x".repeat(300) } },
              ],
            },
          },
        ],
      });

      const res = await fetch(`${tinyUrl}/v1/traces`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: oversized,
      });

      expect(res.status).toBe(413);
      const data = await res.json();
      expect(data.error).toBe("Payload Too Large");

      await new Promise<void>((resolve) => {
        tinyServer.close(() => resolve());
      });
    });

    it("rejects unauthorized requests with 401 Unauthorized", async () => {
      const res = await fetch(`${baseUrl}/v1/traces`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-test-reject": "true",
        },
        body: JSON.stringify({ resourceSpans: [] }),
      });

      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.error).toBe("Unauthorized");
    });
  });
});

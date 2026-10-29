import { describe, it, expect, vi } from "vitest";
import { SpanStatusCode, type Span, type Tracer } from "@opentelemetry/api";
import type { RuntimeEvent, ToolContext } from "@chainmcp/core";
import {
  redactString,
  redactValue,
  MemorySink,
  ConsoleSink,
  MultiSink,
  createLogger,
  OpenTelemetryMetricsSink,
  ToolTracer,
  RollingAnalyticsAggregator,
  REDACTED_MARKER,
  EXCLUDED_BODY_MARKER,
} from "../src/index.js";

describe("Analytics & Logging", () => {
  describe("Redaction", () => {
    it("redacts bearer, basic, and JWT tokens from strings", () => {
      const bearerStr = "Header: Bearer eyJhbGciOi.secret.token-12345";
      expect(redactString(bearerStr)).toContain(REDACTED_MARKER);

      const basicStr = "Authorization: Basic dXNlcjpwYXNz";
      expect(redactString(basicStr)).toBe(
        `Authorization: Basic ${REDACTED_MARKER}`,
      );

      const jwtStr =
        "Token is eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
      expect(redactString(jwtStr)).toBe(`Token is ${REDACTED_MARKER}`);
    });

    it("redacts sensitive keys in objects", () => {
      const input = {
        userId: "user-1",
        authorization: "Bearer secret-token",
        password: "my-password",
        cookie: "session_id=secret-cookie-val; secret=val",
        "set-cookie": "session_id=new-val",
        nested: {
          apiKey: "key-xyz",
          regularField: "safe value",
        },
      };

      const result = redactValue(input) as Record<string, unknown>;
      const nested = result["nested"] as Record<string, unknown>;
      expect(result["userId"]).toBe("user-1");
      expect(result["authorization"]).toBe(REDACTED_MARKER);
      expect(result["password"]).toBe(REDACTED_MARKER);
      expect(result["cookie"]).toBe(REDACTED_MARKER);
      expect(result["set-cookie"]).toBe(REDACTED_MARKER);
      expect(nested["apiKey"]).toBe(REDACTED_MARKER);
      expect(nested["regularField"]).toBe("safe value");
    });

    it("excludes request and response bodies by default", () => {
      const input = {
        requestId: "req-1",
        requestBody: { query: "select * from users" },
        responseBody: { items: [1, 2, 3] },
        status: 200,
      };

      const defaultRedacted = redactValue(input) as Record<string, unknown>;
      expect(defaultRedacted["requestBody"]).toBe(EXCLUDED_BODY_MARKER);
      expect(defaultRedacted["responseBody"]).toBe(EXCLUDED_BODY_MARKER);
      expect(defaultRedacted["status"]).toBe(200);

      const withBodies = redactValue(input, { includeBodies: true }) as Record<
        string,
        unknown
      >;
      expect(withBodies["requestBody"]).toEqual({
        query: "select * from users",
      });
      expect(withBodies["responseBody"]).toEqual({ items: [1, 2, 3] });
    });

    it("protects against circular references and deep structures", () => {
      const circular: Record<string, unknown> = { a: 1 };
      circular.self = circular;

      const result = redactValue(circular) as Record<string, unknown>;
      expect(result["a"]).toBe(1);
      expect(result["self"]).toBe("[CIRCULAR]");
    });

    it("strips prototype pollution keys", () => {
      const input = {
        normal: "ok",
        __proto__: { polluted: true },
        constructor: "bad",
      };

      const result = redactValue(input) as Record<string, unknown>;
      expect(result["normal"]).toBe("ok");
      expect(Object.prototype.hasOwnProperty.call(result, "__proto__")).toBe(
        false,
      );
      expect(result["constructor"]).not.toBe("bad");
    });
  });

  describe("Sinks", () => {
    it("MemorySink captures records and enforces max capacity", () => {
      const sink = new MemorySink({ maxRecords: 3 });
      sink.emit({ level: "info", message: "1", timestamp: 1 });
      sink.emit({ level: "info", message: "2", timestamp: 2 });
      sink.emit({ level: "info", message: "3", timestamp: 3 });
      sink.emit({ level: "info", message: "4", timestamp: 4 });

      const records = sink.getRecords();
      expect(records).toHaveLength(3);
      expect(records[0]?.message).toBe("2");
      expect(records[2]?.message).toBe("4");
    });

    it("ConsoleSink writes JSON and routes errors to stderr", () => {
      const stdout = vi.fn();
      const stderr = vi.fn();
      const sink = new ConsoleSink({ stdout, stderr, format: "json" });

      sink.emit({ level: "info", message: "hello", timestamp: 100 });
      expect(stdout).toHaveBeenCalledOnce();
      expect(JSON.parse(stdout.mock.calls[0]![0])).toMatchObject({
        level: "info",
        message: "hello",
      });

      sink.emit({ level: "error", message: "fail", timestamp: 101 });
      expect(stderr).toHaveBeenCalledOnce();
      expect(JSON.parse(stderr.mock.calls[0]![0])).toMatchObject({
        level: "error",
        message: "fail",
      });
    });

    it("MultiSink broadcasts records and isolates errors", () => {
      const s1 = { emit: vi.fn() };
      const s2 = {
        emit: vi.fn().mockImplementation(() => {
          throw new Error("s2 failed");
        }),
      };
      const s3 = { emit: vi.fn() };

      const multi = new MultiSink([s1, s2, s3]);
      multi.emit({ level: "warn", message: "test", timestamp: 1 });

      expect(s1.emit).toHaveBeenCalledOnce();
      expect(s2.emit).toHaveBeenCalledOnce();
      expect(s3.emit).toHaveBeenCalledOnce();
    });
  });

  describe("StructuredLogger", () => {
    it("filters records according to configured level", () => {
      const sink = new MemorySink();
      const logger = createLogger({ level: "warn", diagnosticSink: sink });

      logger.debug("debug message");
      logger.info("info message");
      logger.warn("warn message");
      logger.error("error message");

      const records = sink.getRecords();
      expect(records).toHaveLength(2);
      expect(records[0]?.message).toBe("warn message");
      expect(records[1]?.message).toBe("error message");
    });

    it("redacts sensitive fields in logged context", () => {
      const sink = new MemorySink();
      const logger = createLogger({ level: "info", diagnosticSink: sink });

      logger.info("user login", {
        userId: "123",
        password: "supersecretpassword",
        token: "Bearer secret-token",
      });

      const record = sink.getRecords()[0]!;
      expect(record.context?.userId).toBe("123");
      expect(record.context?.password).toBe(REDACTED_MARKER);
      expect(record.context?.token).toBe(REDACTED_MARKER);
    });

    it("routes audit logs to dedicated auditSink", () => {
      const diagSink = new MemorySink();
      const auditSink = new MemorySink();
      const logger = createLogger({
        level: "info",
        diagnosticSink: diagSink,
        auditSink,
      });

      logger.info("regular log");
      logger.audit("security auth failure", { reason: "bad token" });

      expect(diagSink.getRecords()).toHaveLength(2);
      expect(auditSink.getRecords()).toHaveLength(1);
      expect(auditSink.getRecords()[0]?.category).toBe("audit");
      expect(auditSink.getRecords()[0]?.message).toBe("security auth failure");
    });

    it("creates child loggers with inherited and merged correlation context", () => {
      const sink = new MemorySink();
      const rootLogger = createLogger({
        level: "info",
        diagnosticSink: sink,
        defaultContext: { service: "api-gateway" },
      });

      const child = rootLogger.child({
        tenantId: "tenant-99",
        requestId: "req-abc",
      });

      child.info("operation executed", { toolName: "get_user" });

      const record = sink.getRecords()[0]!;
      expect(record.context).toMatchObject({
        service: "api-gateway",
        tenantId: "tenant-99",
        requestId: "req-abc",
        toolName: "get_user",
      });
    });

    it("isolates sink throwing errors completely", () => {
      const throwingSink = {
        emit: vi.fn().mockImplementation(() => {
          throw new Error("Sink explosion!");
        }),
      };
      const logger = createLogger({ diagnosticSink: throwingSink });

      expect(() => logger.info("safe message")).not.toThrow();
    });
  });

  describe("OpenTelemetryMetricsSink", () => {
    it("records tool invocation metrics safely", () => {
      const otelSink = new OpenTelemetryMetricsSink();
      const event: RuntimeEvent = {
        name: "tool_invocation",
        timestamp: Date.now(),
        durationMs: 125,
        tenantId: "t-1",
        toolName: "search_items",
        outcome: "success",
        cacheOutcome: "hit",
        tokenUsage: {
          count: 42,
          measurement: "exact",
          tokenizer: "cl100k_base",
          payloadBytes: 150,
        },
      };

      expect(() => otelSink.record(event)).not.toThrow();
    });
  });

  describe("ToolTracer", () => {
    it("creates, populates, and ends tool spans with expected attributes", () => {
      const recorded: Array<{
        name: string;
        attributes: Record<string, unknown>;
        ended: boolean;
        status?: { code: number; message?: string } | undefined;
        exceptions: unknown[];
      }> = [];

      const mockSpan = (
        name: string,
        initialAttrs: Record<string, unknown> = {},
      ): Span => {
        const item = {
          name,
          attributes: { ...initialAttrs },
          ended: false,
          status: undefined as { code: number; message?: string } | undefined,
          exceptions: [] as unknown[],
        };
        recorded.push(item);
        const span: Span = {
          spanContext: () => ({
            traceId: "trace-abc-123",
            spanId: "span-xyz-789",
            traceFlags: 1,
          }),
          setAttribute(k, v) {
            item.attributes[k] = v;
            return this;
          },
          setAttributes(attrs) {
            Object.assign(item.attributes, attrs);
            return this;
          },
          setStatus(status) {
            item.status = status;
            return this;
          },
          recordException(err) {
            item.exceptions.push(err);
            return this;
          },
          end() {
            item.ended = true;
          },
          isRecording: () => true,
          addEvent: () => span,
          addLink: () => span,
          addLinks: () => span,
          updateName: () => span,
        };
        return span;
      };

      const mockTracer: Tracer = {
        startSpan(name, options) {
          return mockSpan(
            name,
            (options?.attributes as Record<string, unknown>) ?? {},
          );
        },
        startActiveSpan: vi.fn(),
      };

      const tracer = new ToolTracer({ tracer: mockTracer });
      const ctx: ToolContext = {
        requestId: "r-1",
        tenantId: "t-1",
        principal: { id: "p-1", scopes: ["read"] },
      };

      const span = tracer.startToolSpan("my_tool", ctx, "rev-1");
      expect(span).toBeDefined();
      expect(recorded).toHaveLength(1);
      expect(recorded[0]?.name).toBe("tool.my_tool");
      expect(recorded[0]?.attributes).toEqual({
        "tool.name": "my_tool",
        "mcp.tool_name": "my_tool",
        "tenant.id": "t-1",
        "principal.id": "p-1",
        "mcp.request_id": "r-1",
        "contract.revision": "rev-1",
      });

      // Assert no input arguments or headers leaked into span attributes
      expect(recorded[0]?.attributes).not.toHaveProperty("arguments");
      expect(recorded[0]?.attributes).not.toHaveProperty("headers");
      expect(recorded[0]?.attributes).not.toHaveProperty("body");

      tracer.endToolSpan(span, {
        outcome: "success",
        durationMs: 42,
        cacheOutcome: "hit",
        cached: true,
      });

      expect(recorded[0]?.ended).toBe(true);
      expect(recorded[0]?.attributes["outcome"]).toBe("success");
      expect(recorded[0]?.attributes["duration_ms"]).toBe(42);
      expect(recorded[0]?.attributes["cache.outcome"]).toBe("hit");
      expect(recorded[0]?.attributes["cached"]).toBe(true);
    });

    it("handles error spans gracefully and redacts sensitive error messages", () => {
      const recorded: Array<{
        name: string;
        attributes: Record<string, unknown>;
        ended: boolean;
        status?: { code: number; message?: string } | undefined;
        exceptions: unknown[];
      }> = [];

      const mockSpan = (
        name: string,
        initialAttrs: Record<string, unknown> = {},
      ): Span => {
        const item = {
          name,
          attributes: { ...initialAttrs },
          ended: false,
          status: undefined as { code: number; message?: string } | undefined,
          exceptions: [] as unknown[],
        };
        recorded.push(item);
        const span: Span = {
          spanContext: () => ({
            traceId: "trace-err-123",
            spanId: "span-err-789",
            traceFlags: 1,
          }),
          setAttribute(k, v) {
            item.attributes[k] = v;
            return this;
          },
          setAttributes(attrs) {
            Object.assign(item.attributes, attrs);
            return this;
          },
          setStatus(status) {
            item.status = status;
            return this;
          },
          recordException(err) {
            item.exceptions.push(err);
            return this;
          },
          end() {
            item.ended = true;
          },
          isRecording: () => true,
          addEvent: () => span,
          addLink: () => span,
          addLinks: () => span,
          updateName: () => span,
        };
        return span;
      };

      const mockTracer: Tracer = {
        startSpan(name, options) {
          return mockSpan(
            name,
            (options?.attributes as Record<string, unknown>) ?? {},
          );
        },
        startActiveSpan: vi.fn(),
      };

      const tracer = new ToolTracer({ tracer: mockTracer });
      const ctx: ToolContext = {
        requestId: "r-2",
        tenantId: "t-2",
        principal: { id: "p-2", scopes: [] },
      };

      const span = tracer.startToolSpan("failing_tool", ctx);
      tracer.endToolSpan(span, {
        error: new Error(
          "Failed to authenticate with Bearer secret-token-abcdef123456",
        ),
        outcome: "error",
        durationMs: 15,
      });

      expect(recorded[0]?.ended).toBe(true);
      expect(recorded[0]?.status?.code).toBe(SpanStatusCode.ERROR);
      // Status message must NOT contain raw Bearer token
      expect(recorded[0]?.status?.message).not.toContain(
        "secret-token-abcdef123456",
      );
      expect(recorded[0]?.status?.message).toContain("[REDACTED]");
    });

    it("supports child spans and context propagation", () => {
      const tracer = new ToolTracer();
      const ctx: ToolContext = {
        requestId: "r-3",
        tenantId: "t-3",
        principal: { id: "p-3", scopes: [] },
      };

      const parentSpan = tracer.startToolSpan("parent_tool", ctx);
      expect(parentSpan).toBeDefined();

      let childTraceId: string | undefined;
      tracer.withSpan(parentSpan, () => {
        const childSpan = tracer.startChildSpan("upstream.call", {
          "upstream.service": "petstore",
        });
        childTraceId = childSpan.spanContext().traceId;
        tracer.endSpan(childSpan, { outcome: "success", durationMs: 12 });
      });

      // Child span in withSpan inherits the parent's traceId
      expect(childTraceId).toBe(parentSpan.spanContext().traceId);
      tracer.endToolSpan(parentSpan, { outcome: "success", durationMs: 25 });
    });

    it("respects sampleRatio", () => {
      // sampleRatio: 0 drops all spans
      const neverTracer = new ToolTracer({ sampleRatio: 0 });
      const ctx: ToolContext = {
        requestId: "r-4",
        tenantId: "t-4",
        principal: { id: "p-4", scopes: [] },
      };

      const sampledOut = neverTracer.startToolSpan("sampled_tool", ctx);
      // TraceId of dropped/wrapped context is all zeros
      expect(sampledOut.spanContext().traceId).toBe(
        "00000000000000000000000000000000",
      );
    });
  });

  describe("RollingAnalyticsAggregator", () => {
    it("computes accurate aggregate metrics and hit ratios", () => {
      const aggregator = new RollingAnalyticsAggregator();

      aggregator.record({
        name: "tool_invocation",
        timestamp: Date.now(),
        durationMs: 50,
        tenantId: "t-1",
        toolName: "tool-a",
        outcome: "success",
        cacheOutcome: "hit",
        tokenUsage: {
          count: 100,
          measurement: "exact",
          tokenizer: "test",
          payloadBytes: 400,
        },
      });

      aggregator.record({
        name: "tool_invocation",
        timestamp: Date.now(),
        durationMs: 100,
        tenantId: "t-1",
        toolName: "tool-a",
        outcome: "success",
        cacheOutcome: "miss",
        tokenUsage: {
          count: 50,
          measurement: "estimate",
          tokenizer: "test",
          payloadBytes: 200,
        },
      });

      aggregator.record({
        name: "tool_invocation",
        timestamp: Date.now(),
        durationMs: 200,
        tenantId: "t-2",
        toolName: "tool-b",
        outcome: "error",
        errorCode: "UPSTREAM_FAILURE",
      });

      const summary = aggregator.getSummary();
      expect(summary.totalInvocations).toBe(3);
      expect(summary.successCount).toBe(2);
      expect(summary.errorCount).toBe(1);

      // Cache hit ratio: 1 hit out of 2 eligible = 0.5
      expect(summary.cache.hits).toBe(1);
      expect(summary.cache.misses).toBe(1);
      expect(summary.cache.hitRatio).toBe(0.5);

      // Tokens
      expect(summary.tokens.totalTokens).toBe(150);
      expect(summary.tokens.exactTokens).toBe(100);
      expect(summary.tokens.estimatedTokens).toBe(50);
      expect(summary.tokens.totalPayloadBytes).toBe(600);

      // Latency percentiles
      expect(summary.latency.minMs).toBe(50);
      expect(summary.latency.maxMs).toBe(200);
      expect(summary.latency.avgMs).toBeCloseTo(116.67, 1);
    });

    it("filters summary by tool or tenant", () => {
      const aggregator = new RollingAnalyticsAggregator();
      aggregator.record({
        name: "tool_invocation",
        timestamp: Date.now(),
        durationMs: 10,
        tenantId: "t-1",
        toolName: "tool-a",
        outcome: "success",
      });
      aggregator.record({
        name: "tool_invocation",
        timestamp: Date.now(),
        durationMs: 20,
        tenantId: "t-2",
        toolName: "tool-b",
        outcome: "success",
      });

      const t1Summary = aggregator.getSummary({ tenantId: "t-1" });
      expect(t1Summary.totalInvocations).toBe(1);

      const toolBSummary = aggregator.getSummary({ toolName: "tool-b" });
      expect(toolBSummary.totalInvocations).toBe(1);
    });
  });
});

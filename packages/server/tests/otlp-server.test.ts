import { describe, it, expect } from "vitest";
import { InMemoryToolRuntime, type ToolDefinition } from "@chainmcp/core";
import { serveHttp } from "../src/http.js";
import type { IncomingMessage, ServerResponse } from "node:http";

const testTool: ToolDefinition = {
  name: "testTool",
  description: "A test tool",
  inputSchema: {
    type: "object",
    properties: {
      msg: { type: "string" },
    },
    additionalProperties: false,
  },
  operation: {},
  async execute() {
    return { ok: true };
  },
};

describe("serveHttp with OTLP handler", () => {
  it("mounts and routes /v1/traces and /v1/metrics through otlpHandler", async () => {
    const runtime = new InMemoryToolRuntime();
    runtime.register(testTool);

    const receivedPaths: string[] = [];
    const otlpHandler = async (
      req: IncomingMessage,
      res: ServerResponse,
    ): Promise<boolean> => {
      const pathname = req.url?.split("?")[0];
      if (pathname === "/v1/traces" || pathname === "/v1/metrics") {
        receivedPaths.push(pathname);
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ partialSuccess: {} }));
        return true;
      }
      return false;
    };

    const connected = await serveHttp(
      runtime,
      {
        name: "otlp-test-server",
        version: "1.0.0",
        createContext: () => ({
          tenantId: "test-tenant",
          requestId: "req-1",
          principal: { id: "test-user", scopes: [] },
        }),
      },
      {
        port: 0,
        host: "127.0.0.1",
        path: "/mcp",
        requireAuth: false,
        otlpHandler,
      },
    );

    try {
      const baseUrl = connected.url.origin;

      // 1. POST /v1/traces
      const tracesRes = await fetch(`${baseUrl}/v1/traces`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resourceSpans: [] }),
      });
      expect(tracesRes.status).toBe(200);
      const tracesData = await tracesRes.json();
      expect(tracesData).toEqual({ partialSuccess: {} });

      // 2. POST /v1/metrics
      const metricsRes = await fetch(`${baseUrl}/v1/metrics`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resourceMetrics: [] }),
      });
      expect(metricsRes.status).toBe(200);
      const metricsData = await metricsRes.json();
      expect(metricsData).toEqual({ partialSuccess: {} });

      // Verify that OTLP paths were dispatched
      expect(receivedPaths).toEqual(["/v1/traces", "/v1/metrics"]);
    } finally {
      await connected.close();
    }
  });
});

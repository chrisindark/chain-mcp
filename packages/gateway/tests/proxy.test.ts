import { describe, expect, it, vi } from "vitest";
import {
  Server,
  InMemoryTransport,
  type Tool,
} from "@modelcontextprotocol/server";
import { trace, type Span } from "@opentelemetry/api";
import {
  InMemoryCacheStore,
  type RateLimiter,
  type ToolContext,
} from "@chainmcp/core";
import { OperationScopeAuthorizer } from "@chainmcp/auth";
import { DynamicGateway } from "../src/gateway.js";
import { generateTraceparent, unwrapCallToolResult } from "../src/proxy.js";
import type { GatewayAuditEvent } from "../src/types.js";

interface MockUpstreamServer {
  server: Server;
  receivedCalls: Array<{
    name: string;
    arguments: Record<string, unknown> | undefined;
    meta: Record<string, unknown> | undefined;
  }>;
  close: () => Promise<void>;
}

async function createMockUpstream(
  tools: Array<{
    name: string;
    description?: string;
    inputSchema?: Tool["inputSchema"];
    handler?: (
      args: Record<string, unknown> | undefined,
      meta: Record<string, unknown> | undefined,
    ) => unknown;
  }>,
): Promise<[InMemoryTransport, MockUpstreamServer]> {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = new Server(
    { name: "mock-upstream", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  const receivedCalls: MockUpstreamServer["receivedCalls"] = [];

  server.setRequestHandler("tools/list", async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description ?? `Description for ${t.name}`,
      inputSchema: (t.inputSchema ?? {
        type: "object" as const,
        properties: { text: { type: "string" } },
      }) as Tool["inputSchema"],
    })),
  }));

  server.setRequestHandler("tools/call", async (request) => {
    const params = request.params as {
      name: string;
      arguments?: Record<string, unknown>;
      _meta?: Record<string, unknown>;
    };
    const { name, arguments: args, _meta } = params;
    receivedCalls.push({ name, arguments: args, meta: _meta });

    const targetTool = tools.find((t) => t.name === name);
    if (!targetTool) {
      return {
        isError: true,
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
      };
    }

    if (name === "failing_tool") {
      return {
        isError: true,
        content: [
          { type: "text", text: "Upstream tool crashed intentionally" },
        ],
      };
    }

    const payload = targetTool.handler
      ? targetTool.handler(args, _meta)
      : { received: args, tool: name };

    return {
      content: [
        {
          type: "text",
          text: typeof payload === "string" ? payload : JSON.stringify(payload),
        },
      ],
    };
  });

  await server.connect(serverTransport);

  return [
    clientTransport,
    {
      server,
      receivedCalls,
      close: async () => {
        await server.close();
      },
    },
  ];
}

describe("Active MCP-to-MCP Proxy Mode", () => {
  describe("Helper unit tests", () => {
    it("generateTraceparent produces valid W3C format from context.requestId", () => {
      const tp = generateTraceparent({
        requestId: "req-abc-123",
      } as ToolContext);
      expect(tp).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);

      // Verify deterministic traceId derived from requestId
      const tp2 = generateTraceparent({
        requestId: "req-abc-123",
      } as ToolContext);
      const traceId1 = tp.split("-")[1];
      const traceId2 = tp2.split("-")[1];
      expect(traceId1).toBe(traceId2);
    });

    it("generateTraceparent produces valid W3C format without context", () => {
      const tp = generateTraceparent();
      expect(tp).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    });

    it("generateTraceparent propagates active OpenTelemetry span context", () => {
      const mockSpan: Partial<Span> = {
        spanContext: () => ({
          traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
          spanId: "00f067aa0ba902b7",
          traceFlags: 1,
        }),
      };

      const spy = vi
        .spyOn(trace, "getActiveSpan")
        .mockReturnValue(mockSpan as Span);
      try {
        const tp = generateTraceparent();
        expect(tp).toBe(
          "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
        );
      } finally {
        spy.mockRestore();
      }
    });

    it("unwrapCallToolResult handles empty, JSON text, raw text, and multiple content items", () => {
      // Empty content
      expect(unwrapCallToolResult({ content: [] })).toEqual({ ok: true });

      // JSON text
      expect(
        unwrapCallToolResult({
          content: [{ type: "text", text: JSON.stringify({ score: 100 }) }],
        }),
      ).toEqual({ score: 100 });

      // Non-JSON plain text
      expect(
        unwrapCallToolResult({
          content: [{ type: "text", text: "Simple raw message" }],
        }),
      ).toBe("Simple raw message");

      // Multiple blocks
      const multi = [
        { type: "text" as const, text: "header" },
        { type: "text" as const, text: "footer" },
      ];
      expect(unwrapCallToolResult({ content: multi })).toEqual({
        content: multi,
      });
    });
  });

  describe("DynamicGateway.publishProxyContract", () => {
    it("discovers external tools and executes with W3C traceparent and correlation meta", async () => {
      const [clientTransport, upstream] = await createMockUpstream([
        {
          name: "weather_lookup",
          description: "Get city weather",
          inputSchema: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
          handler: (args) => ({ temperature: 22, city: args?.city }),
        },
      ]);

      const gateway = new DynamicGateway();
      try {
        const revision = await gateway.publishProxyContract({
          tenantId: "tenant-acme",
          contractName: "weather-service",
          proxy: {
            transport: "custom",
            customTransport: clientTransport,
          },
        });

        expect(revision.status).toBe("active");
        expect(revision.tools.length).toBe(1);
        expect(revision.tools[0]?.name).toBe("weather_lookup");
        expect(revision.tools[0]?.ownerTenantId).toBe("tenant-acme");

        // List tools
        const listed = gateway.listTools({
          requestId: "req-list-1",
          tenantId: "tenant-acme",
          principal: { id: "user", scopes: [] },
        });
        expect(listed.map((t) => t.name)).toEqual(["weather_lookup"]);

        // Execute tool
        const result = await gateway.callTool(
          "weather_lookup",
          { city: "Paris" },
          () => ({
            tenantId: "tenant-acme",
            requestId: "req-trace-001",
            principal: { id: "agent-007", scopes: [] },
          }),
        );

        expect(result).toEqual({ temperature: 22, city: "Paris" });

        // Verify upstream received call with W3C traceparent & metadata
        expect(upstream.receivedCalls.length).toBe(1);
        const call = upstream.receivedCalls[0]!;
        expect(call.name).toBe("weather_lookup");
        expect(call.arguments).toEqual({ city: "Paris" });
        expect(call.meta?.["traceparent"]).toMatch(
          /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/,
        );
        expect(call.meta?.["tenant.id"]).toBe("tenant-acme");
        expect(call.meta?.["principal.id"]).toBe("agent-007");
        expect(call.meta?.["request.id"]).toBe("req-trace-001");
      } finally {
        await gateway.close();
        await upstream.close();
      }
    });

    it("applies toolPrefix correctly to discovered tools", async () => {
      const [clientTransport, upstream] = await createMockUpstream([
        { name: "search" },
        { name: "lookup" },
      ]);

      const gateway = new DynamicGateway();
      try {
        await gateway.publishProxyContract({
          tenantId: "tenant-beta",
          contractName: "external-tools",
          proxy: {
            transport: "custom",
            customTransport: clientTransport,
            toolPrefix: "ext_",
          },
        });

        const tools = gateway.listTools({
          requestId: "req-list-2",
          tenantId: "tenant-beta",
          principal: { id: "user", scopes: [] },
        });
        expect(tools.map((t) => t.name)).toEqual(["ext_search", "ext_lookup"]);

        // Invoke through prefixed name
        const res = await gateway.callTool(
          "ext_search",
          { query: "test" },
          () => ({
            requestId: "req-prefix-1",
            tenantId: "tenant-beta",
            principal: { id: "user", scopes: [] },
          }),
        );

        expect(res).toEqual({ received: { query: "test" }, tool: "search" });
        // Upstream was called with original name 'search'
        expect(upstream.receivedCalls[0]?.name).toBe("search");
      } finally {
        await gateway.close();
        await upstream.close();
      }
    });

    it("enforces inbound scope authorization on proxied tools", async () => {
      const [clientTransport, upstream] = await createMockUpstream([
        { name: "secret_data" },
      ]);

      const authorizer = new OperationScopeAuthorizer();
      const gateway = new DynamicGateway({ authorizer });

      try {
        await gateway.publishProxyContract({
          tenantId: "tenant-corp",
          contractName: "secure-proxy",
          proxy: {
            transport: "custom",
            customTransport: clientTransport,
          },
          authConfig: {
            requiredScopes: ["data:read"],
          },
        });

        // 1. Caller lacking required scope fails with AUTH_FORBIDDEN
        await expect(
          gateway.callTool("secret_data", {}, () => ({
            requestId: "req-auth-1",
            tenantId: "tenant-corp",
            principal: { id: "unprivileged", scopes: ["other:scope"] },
          })),
        ).rejects.toThrowError(/Access denied/);

        expect(upstream.receivedCalls.length).toBe(0);

        // 2. Caller with required scope succeeds
        const result = await gateway.callTool("secret_data", {}, () => ({
          requestId: "req-auth-2",
          tenantId: "tenant-corp",
          principal: { id: "privileged", scopes: ["data:read"] },
        }));

        expect(result).toBeDefined();
        expect(upstream.receivedCalls.length).toBe(1);
      } finally {
        await gateway.close();
        await upstream.close();
      }
    });

    it("enforces rate limits before calling external upstream", async () => {
      const [clientTransport, upstream] = await createMockUpstream([
        { name: "compute_heavy" },
      ]);

      let callCount = 0;
      const rateLimiter: RateLimiter = {
        check() {
          callCount++;
          if (callCount > 2) {
            return {
              allowed: false,
              retryAfterSeconds: 60,
            };
          }
          return { allowed: true };
        },
      };

      const gateway = new DynamicGateway({ rateLimiter });
      try {
        await gateway.publishProxyContract({
          tenantId: "tenant-rate",
          contractName: "compute-proxy",
          proxy: {
            transport: "custom",
            customTransport: clientTransport,
          },
        });

        const ctxFactory = () => ({
          requestId: "req-rate-1",
          tenantId: "tenant-rate",
          principal: { id: "caller-rate", scopes: [] },
        });

        // First 2 succeed
        await gateway.callTool("compute_heavy", {}, ctxFactory);
        await gateway.callTool("compute_heavy", {}, ctxFactory);
        expect(upstream.receivedCalls.length).toBe(2);

        // Third fails with RATE_LIMIT_EXCEEDED
        await expect(
          gateway.callTool("compute_heavy", {}, ctxFactory),
        ).rejects.toThrowError(/Rate limit exceeded/);

        // Upstream was not called for the 3rd rejected request
        expect(upstream.receivedCalls.length).toBe(2);
      } finally {
        await gateway.close();
        await upstream.close();
      }
    });

    it("supports smart caching for cacheEligible tools and never caches mutations", async () => {
      let callCount = 0;
      const [clientTransport, upstream] = await createMockUpstream([
        {
          name: "cached_query",
          handler: () => {
            callCount++;
            return { count: callCount };
          },
        },
        {
          name: "uncached_mutation",
          handler: () => {
            callCount++;
            return { count: callCount };
          },
        },
      ]);

      const memoryStore = new InMemoryCacheStore({
        maxBytes: 100_000,
        maxEntryBytes: 10_000,
        maxEntries: 100,
      });

      const gateway = new DynamicGateway({
        cache: {
          store: memoryStore,
          authorizationPartition: (ctx) => `part-${ctx.tenantId}`,
        },
      });

      try {
        await gateway.publishProxyContract({
          tenantId: "tenant-cache",
          contractName: "cache-proxy",
          proxy: {
            transport: "custom",
            customTransport: clientTransport,
            cacheEligible: ["cached_query"],
          },
        });

        const ctxFactory = () => ({
          requestId: "req-cache-1",
          tenantId: "tenant-cache",
          principal: { id: "caller-c", scopes: [] },
        });

        // 1. First call to cached_query -> reaches upstream
        const res1 = await gateway.callTool(
          "cached_query",
          { param: "v1" },
          ctxFactory,
        );
        expect(res1).toEqual({ count: 1 });
        expect(callCount).toBe(1);

        // 2. Second call with same param -> cache HIT, upstream not called
        const res2 = await gateway.callTool(
          "cached_query",
          { param: "v1" },
          ctxFactory,
        );
        expect(res2).toEqual({ count: 1 });
        expect(callCount).toBe(1);

        // 3. Different param -> cache MISS, upstream called
        const res3 = await gateway.callTool(
          "cached_query",
          { param: "v2" },
          ctxFactory,
        );
        expect(res3).toEqual({ count: 2 });
        expect(callCount).toBe(2);

        // 4. uncached_mutation is NOT cache eligible -> every call reaches upstream
        const m1 = await gateway.callTool(
          "uncached_mutation",
          { op: "write" },
          ctxFactory,
        );
        expect(m1).toEqual({ count: 3 });
        const m2 = await gateway.callTool(
          "uncached_mutation",
          { op: "write" },
          ctxFactory,
        );
        expect(m2).toEqual({ count: 4 });
      } finally {
        await gateway.close();
        await upstream.close();
      }
    });

    it("propagates upstream failure as RuntimeError with UPSTREAM_FAILURE code", async () => {
      const [clientTransport, upstream] = await createMockUpstream([
        { name: "failing_tool" },
      ]);

      const gateway = new DynamicGateway();
      try {
        await gateway.publishProxyContract({
          tenantId: "tenant-err",
          contractName: "failing-proxy",
          proxy: {
            transport: "custom",
            customTransport: clientTransport,
          },
        });

        await expect(
          gateway.callTool("failing_tool", {}, () => ({
            requestId: "req-fail-1",
            tenantId: "tenant-err",
            principal: { id: "user", scopes: [] },
          })),
        ).rejects.toThrowError(/Upstream tool crashed intentionally/);
      } finally {
        await gateway.close();
        await upstream.close();
      }
    });

    it("rejects publication when external server exposes zero tools", async () => {
      const [clientTransport, upstream] = await createMockUpstream([]);

      const gateway = new DynamicGateway();
      try {
        await expect(
          gateway.publishProxyContract({
            tenantId: "tenant-empty",
            contractName: "empty-proxy",
            proxy: {
              transport: "custom",
              customTransport: clientTransport,
            },
          }),
        ).rejects.toThrowError(/External MCP server did not expose any tools/);
      } finally {
        await gateway.close();
        await upstream.close();
      }
    });

    it("rejects HTTP proxy URL that violates destination policy allowlist (SSRF)", async () => {
      const gateway = new DynamicGateway();
      await expect(
        gateway.publishProxyContract({
          tenantId: "tenant-ssrf",
          contractName: "ssrf-proxy",
          proxy: {
            transport: "http",
            url: "https://evil.attacker.com/mcp",
          },
          destinationPolicy: {
            baseUrl: "https://trusted.internal.corp",
            allowedHosts: ["trusted.internal.corp"],
          },
        }),
      ).rejects.toThrowError(/is not in allowedHosts/);
    });

    it("rejects HTTP proxy with invalid URL", async () => {
      const gateway = new DynamicGateway();
      await expect(
        gateway.publishProxyContract({
          tenantId: "tenant-bad",
          contractName: "bad-url-proxy",
          proxy: {
            transport: "http",
            url: "not-a-valid-url",
          },
        }),
      ).rejects.toThrowError(/Invalid proxy HTTP URL/);
    });

    it("emits proxy_connected and contract_published audit events", async () => {
      const [clientTransport, upstream] = await createMockUpstream([
        { name: "echo" },
      ]);

      const auditEvents: GatewayAuditEvent[] = [];
      const gateway = new DynamicGateway({
        auditSink: (event) => {
          auditEvents.push(event);
        },
      });

      try {
        await gateway.publishProxyContract({
          tenantId: "tenant-audit",
          contractName: "audited-proxy",
          proxy: {
            transport: "custom",
            customTransport: clientTransport,
          },
        });

        const types = auditEvents.map((e) => e.type);
        expect(types).toContain("proxy_connected");
        expect(types).toContain("contract_published");
        expect(types).toContain("contract_activated");

        const proxyEvent = auditEvents.find(
          (e) => e.type === "proxy_connected",
        );
        expect(proxyEvent?.details?.transport).toBe("custom");
      } finally {
        await gateway.close();
        await upstream.close();
      }
    });

    it("gateway.close cleanly shuts down all managed proxy client transports", async () => {
      const [clientTransport, upstream] = await createMockUpstream([
        { name: "ping" },
      ]);

      const gateway = new DynamicGateway();
      await gateway.publishProxyContract({
        tenantId: "tenant-close",
        contractName: "close-proxy",
        proxy: {
          transport: "custom",
          customTransport: clientTransport,
        },
      });

      // Verify operational before close
      const res = await gateway.callTool("ping", {}, () => ({
        requestId: "req-close-1",
        tenantId: "tenant-close",
        principal: { id: "user", scopes: [] },
      }));
      expect(res).toBeDefined();

      // Close gateway
      await gateway.close();

      // Subsequent tool invocation fails because runtime is emptied
      await expect(
        gateway.callTool("ping", {}, () => ({
          requestId: "req-close-2",
          tenantId: "tenant-close",
          principal: { id: "user", scopes: [] },
        })),
      ).rejects.toThrowError(/Tool 'ping' was not found/);

      await upstream.close();
    });
  });
});

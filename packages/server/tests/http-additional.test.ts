import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryToolRuntime, type ToolDefinition } from "@chainmcp/core";

import {
  computeAllowedHeaders,
  isLoopbackHost,
  matchAllowedOrigin,
  serveHttp,
  type ConnectedHttpServer,
} from "../src/index.js";

const dummyTool: ToolDefinition = {
  name: "echo",
  description: "echo tool",
  inputSchema: { type: "object" },
  operation: {},
  async execute() {
    return { ok: true };
  },
};

function createRuntime(): InMemoryToolRuntime {
  const runtime = new InMemoryToolRuntime();
  runtime.register(dummyTool);
  return runtime;
}

const serverInfo = {
  name: "test-server",
  version: "1.0.0",
  createContext: () => ({
    tenantId: "tenant-1",
    requestId: "req-1",
    principal: { id: "user-1", scopes: [] },
  }),
};

describe("server/http additional coverage", () => {
  describe("utility functions", () => {
    it("isLoopbackHost accurately detects loopback addresses", () => {
      expect(isLoopbackHost("127.0.0.1")).toBe(true);
      expect(isLoopbackHost("localhost")).toBe(true);
      expect(isLoopbackHost("[::1]")).toBe(true);
      expect(isLoopbackHost("127.0.0.2")).toBe(true);
      expect(isLoopbackHost("127.255.255.254")).toBe(true);

      expect(isLoopbackHost("192.168.1.1")).toBe(false);
      expect(isLoopbackHost("example.com")).toBe(false);
      expect(isLoopbackHost("0.0.0.0")).toBe(false);
      expect(isLoopbackHost("::")).toBe(false);
    });

    it("computeAllowedHeaders merges and deduplicates headers case-insensitively", () => {
      const result = computeAllowedHeaders(
        ["X-Custom-Auth", "Authorization"],
        ["x-api-key", "X-Trace-Id"],
      );
      expect(result).toContain("Content-Type");
      expect(result).toContain("Authorization");
      expect(result).toContain("X-Custom-Auth");
      expect(result).toContain("X-Trace-Id");
      expect(
        result
          .toLowerCase()
          .split(", ")
          .filter((h) => h === "authorization").length,
      ).toBe(1);
    });

    it("matchAllowedOrigin handles wildcard, null, and case matching", () => {
      expect(matchAllowedOrigin("http://foo.com", ["*"])).toBe("*");
      expect(matchAllowedOrigin(undefined, ["http://foo.com"])).toBeUndefined();
      expect(matchAllowedOrigin("null", ["null"])).toBe("null");
      expect(matchAllowedOrigin("null", ["http://foo.com"])).toBeUndefined();
      expect(matchAllowedOrigin("HTTP://FOO.COM", ["http://foo.com"])).toBe(
        "HTTP://FOO.COM",
      );
      expect(
        matchAllowedOrigin("http://bar.com", ["http://foo.com"]),
      ).toBeUndefined();
    });
  });

  describe("serveHttp configuration validation", () => {
    it("throws when requireAuth is true but no verifier is provided", async () => {
      const runtime = createRuntime();
      await expect(
        serveHttp(runtime, serverInfo, {
          port: 0,
          requireAuth: true,
        }),
      ).rejects.toThrowError(/HTTP inbound authentication is required/);
    });

    it("throws when scope authorizer is configured but no verifier exists", async () => {
      const runtime = createRuntime();
      await expect(
        serveHttp(runtime, serverInfo, {
          port: 0,
          authorizerType: "scope",
        }),
      ).rejects.toThrowError(/Inbound authorizer is configured as "scope"/);
    });

    it("throws when bound to non-loopback host without auth or allowUnauthenticatedHttp", async () => {
      const runtime = createRuntime();
      await expect(
        serveHttp(runtime, serverInfo, {
          port: 0,
          host: "192.168.1.100",
        }),
      ).rejects.toThrowError(
        /Refusing to bind HTTP server to non-loopback host/,
      );
    });

    it("throws when CORS wildcard origin is combined with allowCredentials", async () => {
      const runtime = createRuntime();
      await expect(
        serveHttp(runtime, serverInfo, {
          port: 0,
          cors: {
            enabled: true,
            allowedOrigins: ["*"],
            allowCredentials: true,
          },
        }),
      ).rejects.toThrowError(
        /Wildcard origin \('\*'\) cannot be used when allowCredentials is true/,
      );
    });

    it("warns when CORS wildcard origin is enabled", async () => {
      const runtime = createRuntime();
      const warnMock = vi.fn();
      const server = await serveHttp(runtime, serverInfo, {
        port: 0,
        cors: {
          enabled: true,
          allowedOrigins: ["*"],
        },
        warn: warnMock,
      });

      expect(warnMock).toHaveBeenCalled();
      await server.close();
    });
  });

  describe("HTTP request guards and protocol endpoints", () => {
    let server: ConnectedHttpServer;

    afterEach(async () => {
      if (server) {
        await server.close();
      }
    });

    it("rejects request with missing or malformed Host header", async () => {
      const runtime = createRuntime();
      server = await serveHttp(runtime, serverInfo, {
        port: 0,
      });

      const url = server.url;

      // Malformed Host header
      const malformedStatus = await new Promise<number>((resolve, reject) => {
        const req = http.request(
          {
            hostname: url.hostname,
            port: url.port,
            path: "/mcp",
            method: "POST",
            headers: { host: "invalid::host" },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(malformedStatus).toBe(400);
    });

    it("serves RFC 9728 OAuth protected resource metadata", async () => {
      const runtime = createRuntime();
      server = await serveHttp(runtime, serverInfo, {
        port: 0,
        protectedResourceMetadata: {
          resource: "https://api.example.com/mcp",
          authorizationServers: ["https://auth.example.com"],
          scopesSupported: ["read", "write"],
          resourceName: "Test MCP Service",
        },
      });

      const res = await fetch(
        new URL("/.well-known/oauth-protected-resource", server.url).toString(),
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.resource).toBe("https://api.example.com/mcp");
      expect(json.authorization_servers).toContain("https://auth.example.com");
      expect(json.scopes_supported).toEqual(["read", "write"]);
      expect(json.resource_name).toBe("Test MCP Service");
    });

    it("handles CORS OPTIONS preflight requests for allowed and disallowed origins", async () => {
      const runtime = createRuntime();
      server = await serveHttp(runtime, serverInfo, {
        port: 0,
        cors: {
          enabled: true,
          allowedOrigins: ["http://allowed.example.com"],
          allowCredentials: true,
          maxAgeSeconds: 300,
        },
      });

      // Allowed origin preflight
      const allowedRes = await fetch(server.url.toString(), {
        method: "OPTIONS",
        headers: {
          origin: "http://allowed.example.com",
        },
      });
      expect(allowedRes.status).toBe(204);
      expect(allowedRes.headers.get("access-control-allow-origin")).toBe(
        "http://allowed.example.com",
      );
      expect(allowedRes.headers.get("access-control-allow-credentials")).toBe(
        "true",
      );

      // Disallowed origin preflight
      const disallowedRes = await fetch(server.url.toString(), {
        method: "OPTIONS",
        headers: {
          origin: "http://disallowed.example.com",
        },
      });
      expect(disallowedRes.status).toBe(403);
    });

    it("rejects origin DNS rebinding attacks on non-OPTIONS requests", async () => {
      const runtime = createRuntime();
      server = await serveHttp(runtime, serverInfo, {
        port: 0,
        allowedOrigins: ["localhost", "127.0.0.1"],
      });

      const res = await fetch(server.url.toString(), {
        method: "POST",
        headers: {
          origin: "http://evil-site.com",
          "content-type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
      });
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error.message).toContain("Origin not allowed");
    });

    it("enforces maxRequestBytes limit on declared Content-Length and streaming body", async () => {
      const runtime = createRuntime();
      server = await serveHttp(runtime, serverInfo, {
        port: 0,
        maxRequestBytes: 100,
      });

      // Fast path: declared content-length > maxRequestBytes
      const clRes = await fetch(server.url.toString(), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": "500",
        },
        body: "x".repeat(500),
      });
      expect(clRes.status).toBe(413);
      const clJson = await clRes.json();
      expect(clJson.error.message).toContain("Payload Too Large");
    });

    it("reports degraded readiness on /readyz when degradedReady check fails", async () => {
      const runtime = createRuntime();
      server = await serveHttp(runtime, serverInfo, {
        port: 0,
        readiness: {
          deps: [
            { name: "db", check: () => true },
            { name: "cache", check: () => false, degradedReady: true },
          ],
        },
      });

      const res = await fetch(new URL("/readyz", server.url).toString());
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.status).toBe("degraded");
      expect(json.deps).toHaveLength(2);
      expect(
        json.deps.find(
          (d: { name: string; degraded?: boolean }) => d.name === "cache",
        )?.degraded,
      ).toBe(true);
    });
  });
});

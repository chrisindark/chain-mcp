import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import http from "node:http";
import net from "node:net";
import { InMemoryToolRuntime, type ToolDefinition } from "@chainmcp/core";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
  createApiKeyVerifier,
  createBearerTokenVerifier,
  createJwtVerifier,
  serveHttp,
  type McpServerOptions,
} from "../src/index.js";

const demoTool: ToolDefinition = {
  name: "getGreeting",
  description: "Greets the caller and returns identity context",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string" },
    },
    required: ["name"],
    additionalProperties: false,
  },
  operation: {},
  async execute(input, context) {
    const { name } = input as { name: string };
    return {
      message: `Hello, ${name}!`,
      tenantId: context.tenantId,
      principalId: context.principal.id,
      scopes: context.principal.scopes,
    };
  },
};

function createTestRuntime(
  tools: ToolDefinition[] = [demoTool],
): InMemoryToolRuntime {
  const runtime = new InMemoryToolRuntime();
  for (const t of tools) {
    runtime.register(t);
  }
  return runtime;
}

describe("serveHttp transport and inbound auth", () => {
  it("connects over Streamable HTTP and executes tools without auth when not required", async () => {
    const runtime = createTestRuntime();
    const serverHandle = await serveHttp(
      runtime,
      {
        name: "test-server",
        version: "1.0.0",
        createContext: () => ({
          requestId: "req-1",
          tenantId: "default",
          principal: { id: "anonymous", scopes: [] },
        }),
      },
      {
        port: 0,
        requireAuth: false,
      },
    );

    try {
      const client = new Client({ name: "test-client", version: "1.0.0" });
      const transport = new StreamableHTTPClientTransport(serverHandle.url);
      await client.connect(transport);

      const listing = await client.listTools();
      expect(listing.tools).toHaveLength(1);
      expect(listing.tools[0]?.name).toBe("getGreeting");

      const callResult = await client.callTool({
        name: "getGreeting",
        arguments: { name: "Alice" },
      });

      expect(callResult.isError).toBeFalsy();
      const content = callResult.content as Array<{
        type: string;
        text: string;
      }>;
      const parsed = JSON.parse(content[0]!.text);
      expect(parsed.message).toBe("Hello, Alice!");
      expect(parsed.tenantId).toBe("default");
      expect(parsed.principalId).toBe("anonymous");

      await client.close();
    } finally {
      await serverHandle.close();
    }
  });

  it("authenticates inbound requests via Bearer token and propagates ToolContext", async () => {
    const runtime = createTestRuntime();
    const verifier = createBearerTokenVerifier({
      tokens: {
        "valid-secret-token": {
          tenantId: "tenant-acme",
          principalId: "user-bob",
          scopes: ["read:data", "write:data"],
        },
      },
    });

    const serverHandle = await serveHttp(
      runtime,
      {
        name: "auth-server",
        version: "1.0.0",
        createContext: (request) => {
          const auth = request.authInfo;
          return {
            requestId: "req-auth",
            tenantId: (auth?.extra?.tenantId as string) ?? "default",
            principal: {
              id: auth?.clientId ?? "anon",
              scopes: auth?.scopes ?? [],
            },
          };
        },
      },
      {
        port: 0,
        verifier,
        requireAuth: true,
      },
    );

    try {
      const client = new Client({ name: "auth-client", version: "1.0.0" });
      const transport = new StreamableHTTPClientTransport(serverHandle.url, {
        requestInit: {
          headers: {
            Authorization: "Bearer valid-secret-token",
          },
        },
      });
      await client.connect(transport);

      const callResult = await client.callTool({
        name: "getGreeting",
        arguments: { name: "Bob" },
      });

      expect(callResult.isError).toBeFalsy();
      const content = callResult.content as Array<{
        type: string;
        text: string;
      }>;
      const parsed = JSON.parse(content[0]!.text);
      expect(parsed.tenantId).toBe("tenant-acme");
      expect(parsed.principalId).toBe("user-bob");
      expect(parsed.scopes).toEqual(["read:data", "write:data"]);

      await client.close();
    } finally {
      await serverHandle.close();
    }
  });

  it("rejects unauthorized requests with 401 when requireAuth is enabled", async () => {
    const runtime = createTestRuntime();
    const verifier = createBearerTokenVerifier({
      tokens: {
        "good-token": {
          tenantId: "tenant-1",
          principalId: "user-1",
        },
      },
    });

    const serverHandle = await serveHttp(
      runtime,
      {
        name: "strict-server",
        version: "1.0.0",
        createContext: () => ({
          requestId: "req",
          tenantId: "t1",
          principal: { id: "p1", scopes: [] },
        }),
      },
      {
        port: 0,
        verifier,
        requireAuth: true,
      },
    );

    try {
      // Direct HTTP fetch without credentials
      const res = await fetch(serverHandle.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
        }),
      });

      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toContain("Bearer");

      const body = (await res.json()) as { error?: { message: string } };
      expect(body.error?.message).toContain("Unauthorized");
    } finally {
      await serverHandle.close();
    }
  });

  it("rejects prototype-chain bearer token ('Bearer constructor') with 401 without executing unscoped tools", async () => {
    let toolExecuted = false;
    const unscopedTool: ToolDefinition = {
      name: "sensitiveOperation",
      description: "An unscoped sensitive tool",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      operation: {
        requiredScopes: [], // unscoped tool
      },
      async execute() {
        toolExecuted = true;
        return { success: true };
      },
    };

    const runtime = createTestRuntime([unscopedTool]);
    const verifier = createBearerTokenVerifier({
      tokens: {
        "legit-token": {
          tenantId: "tenant-acme",
          principalId: "user-1",
          scopes: [],
        },
      },
    });

    const serverHandle = await serveHttp(
      runtime,
      {
        name: "proto-bypass-test-server",
        version: "1.0.0",
        createContext: (request) => ({
          requestId: "req-1",
          tenantId: (request.authInfo?.extra?.tenantId as string) ?? "default",
          principal: {
            id: request.authInfo?.clientId ?? "anon",
            scopes: request.authInfo?.scopes ?? [],
          },
        }),
      },
      {
        port: 0,
        verifier,
        requireInboundAuth: true,
      },
    );

    try {
      // Send an HTTP POST with Bearer constructor
      const res = await fetch(serverHandle.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: "Bearer constructor",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "sensitiveOperation",
            arguments: {},
          },
        }),
      });

      expect(res.status).toBe(401);
      expect(toolExecuted).toBe(false);
      const body = (await res.json()) as { error?: { message: string } };
      expect(body.error?.message).toContain("Unauthorized");

      // Verify legitimate token still works
      const legitRes = await fetch(serverHandle.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: "Bearer legit-token",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "sensitiveOperation",
            arguments: {},
          },
        }),
      });

      expect(legitRes.status).toBe(200);
      expect(toolExecuted).toBe(true);
    } finally {
      await serverHandle.close();
    }
  });

  it("authenticates inbound requests via API Key header", async () => {
    const runtime = createTestRuntime();
    const verifier = createApiKeyVerifier({
      headerName: "x-api-key",
      keys: {
        "ak-live-9999": {
          tenantId: "tenant-api-key",
          principalId: "api-service",
          scopes: ["admin"],
        },
      },
    });

    const serverHandle = await serveHttp(
      runtime,
      {
        name: "apikey-server",
        version: "1.0.0",
        createContext: (request) => {
          const auth = request.authInfo;
          return {
            requestId: "req-key",
            tenantId: (auth?.extra?.tenantId as string) ?? "default",
            principal: {
              id: auth?.clientId ?? "anon",
              scopes: auth?.scopes ?? [],
            },
          };
        },
      },
      {
        port: 0,
        verifier,
        requireAuth: true,
      },
    );

    try {
      const client = new Client({ name: "key-client", version: "1.0.0" });
      const transport = new StreamableHTTPClientTransport(serverHandle.url, {
        requestInit: {
          headers: {
            "x-api-key": "ak-live-9999",
          },
        },
      });
      await client.connect(transport);

      const result = await client.callTool({
        name: "getGreeting",
        arguments: { name: "KeyUser" },
      });
      const parsed = JSON.parse(
        (result.content as Array<{ type: string; text: string }>)[0]!.text,
      );
      expect(parsed.tenantId).toBe("tenant-api-key");
      expect(parsed.principalId).toBe("api-service");
      expect(parsed.scopes).toEqual(["admin"]);

      await client.close();
    } finally {
      await serverHandle.close();
    }
  });

  it("authenticates inbound requests via signed JWT", async () => {
    const runtime = createTestRuntime();
    const jwtSecret = "super-secret-hmac-key-at-least-32-chars-long";
    const verifier = createJwtVerifier({
      secret: jwtSecret,
      issuer: "https://auth.example.com",
    });

    const serverHandle = await serveHttp(
      runtime,
      {
        name: "jwt-server",
        version: "1.0.0",
        createContext: (request) => {
          const auth = request.authInfo;
          return {
            requestId: "req-jwt",
            tenantId: (auth?.extra?.tenantId as string) ?? "default",
            principal: {
              id: auth?.clientId ?? "anon",
              scopes: auth?.scopes ?? [],
            },
          };
        },
      },
      {
        port: 0,
        verifier,
        requireAuth: true,
      },
    );

    // Create a valid JWT
    const header = Buffer.from(
      JSON.stringify({ alg: "HS256", typ: "JWT" }),
    ).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        iss: "https://auth.example.com",
        sub: "jwt-user-42",
        tenantId: "tenant-jwt",
        scopes: ["read:data"],
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    ).toString("base64url");
    const sig = createHmac("sha256", jwtSecret)
      .update(`${header}.${payload}`)
      .digest("base64url");
    const jwt = `${header}.${payload}.${sig}`;

    try {
      const client = new Client({ name: "jwt-client", version: "1.0.0" });
      const transport = new StreamableHTTPClientTransport(serverHandle.url, {
        requestInit: {
          headers: {
            Authorization: `Bearer ${jwt}`,
          },
        },
      });
      await client.connect(transport);

      const result = await client.callTool({
        name: "getGreeting",
        arguments: { name: "JwtUser" },
      });
      const parsed = JSON.parse(
        (result.content as Array<{ type: string; text: string }>)[0]!.text,
      );
      expect(parsed.tenantId).toBe("tenant-jwt");
      expect(parsed.principalId).toBe("jwt-user-42");
      expect(parsed.scopes).toEqual(["read:data"]);

      await client.close();
    } finally {
      await serverHandle.close();
    }
  });

  it("serves CORS preflight and health checks", async () => {
    const runtime = createTestRuntime();
    const serverHandle = await serveHttp(
      runtime,
      {
        name: "probe-server",
        version: "1.0.0",
        createContext: () => ({
          requestId: "probe",
          tenantId: "default",
          principal: { id: "p", scopes: [] },
        }),
      },
      {
        port: 0,
        cors: {
          allowedOrigins: ["http://example.com"],
        },
      },
    );

    try {
      // OPTIONS preflight
      const optionsRes = await fetch(serverHandle.url, {
        method: "OPTIONS",
        headers: {
          Origin: "http://example.com",
          "Access-Control-Request-Method": "POST",
        },
      });
      expect(optionsRes.status).toBe(204);
      expect(optionsRes.headers.get("access-control-allow-origin")).toBe(
        "http://example.com",
      );
      expect(optionsRes.headers.get("vary")).toBe("Origin");

      // GET /health
      const healthUrl = new URL("/health", serverHandle.url);
      const healthRes = await fetch(healthUrl);
      expect(healthRes.status).toBe(200);
      const healthBody = (await healthRes.json()) as {
        status: string;
        name: string;
      };
      expect(healthBody.status).toBe("ok");
      expect(healthBody.name).toBe("probe-server");
    } finally {
      await serverHandle.close();
    }
  });

  it("gracefully shuts down when AbortSignal fires", async () => {
    const runtime = createTestRuntime();
    const controller = new AbortController();
    let oncloseCalled = false;

    const serverHandle = await serveHttp(
      runtime,
      {
        name: "shutdown-server",
        version: "1.0.0",
        createContext: () => ({
          requestId: "sd",
          tenantId: "default",
          principal: { id: "p", scopes: [] },
        }),
        onclose: () => {
          oncloseCalled = true;
        },
      },
      {
        port: 0,
        signal: controller.signal,
      },
    );

    expect(serverHandle.httpServer.listening).toBe(true);
    controller.abort();
    await serverHandle.closed;
    expect(serverHandle.httpServer.listening).toBe(false);
    expect(oncloseCalled).toBe(true);
  });

  describe("HTTP Request Limits, Host, Origin, and DNS-Rebinding Protections (RM-02)", () => {
    it("accepts a request body exactly at the configured cap (maxRequestBytes)", async () => {
      const runtime = createTestRuntime();
      const CAP = 512;
      const serverHandle = await serveHttp(
        runtime,
        {
          name: "cap-server",
          version: "1.0.0",
          createContext: () => ({
            requestId: "req-cap",
            tenantId: "default",
            principal: { id: "p", scopes: [] },
          }),
        },
        {
          port: 0,
          maxRequestBytes: CAP,
        },
      );

      try {
        const template = JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "getGreeting",
            arguments: { name: "" },
          },
        });
        const padding = "x".repeat(CAP - Buffer.byteLength(template, "utf8"));
        const bodyObj = {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "getGreeting",
            arguments: { name: padding },
          },
        };
        const exactBody = JSON.stringify(bodyObj);
        expect(Buffer.byteLength(exactBody, "utf8")).toBe(CAP);

        const res = await fetch(serverHandle.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
          },
          body: exactBody,
        });

        expect(res.status).toBe(200);
        const text = await res.text();
        expect(text).toContain(padding);
      } finally {
        await serverHandle.close();
      }
    });

    it("rejects request with 413 Payload Too Large when Content-Length exceeds the cap and remains healthy afterwards", async () => {
      const runtime = createTestRuntime();
      const CAP = 500;
      const serverHandle = await serveHttp(
        runtime,
        {
          name: "cap-server",
          version: "1.0.0",
          createContext: () => ({
            requestId: "req-cap",
            tenantId: "default",
            principal: { id: "p", scopes: [] },
          }),
        },
        {
          port: 0,
          maxRequestBytes: CAP,
        },
      );

      try {
        const oversizedPayload = "a".repeat(CAP + 1);
        const res = await fetch(serverHandle.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": String(CAP + 1),
            Accept: "application/json, text/event-stream",
          },
          body: oversizedPayload,
        });

        expect(res.status).toBe(413);
        const data = (await res.json()) as { error?: { message: string } };
        expect(data.error?.message).toContain("Payload Too Large");
        expect(JSON.stringify(data)).not.toContain("aaaa");

        // Verify server remains responsive with a valid request
        const followUp = await fetch(serverHandle.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name: "getGreeting", arguments: { name: "Alice" } },
          }),
        });
        expect(followUp.status).toBe(200);
      } finally {
        await serverHandle.close();
      }
    });

    it("rejects chunked request with 413 without Content-Length when stream exceeds cap, aborting early without unbounded buffering", async () => {
      const runtime = createTestRuntime();
      const CAP = 400;
      const serverHandle = await serveHttp(
        runtime,
        {
          name: "chunked-server",
          version: "1.0.0",
          createContext: () => ({
            requestId: "req-chunked",
            tenantId: "default",
            principal: { id: "p", scopes: [] },
          }),
        },
        {
          port: 0,
          maxRequestBytes: CAP,
        },
      );

      try {
        const responseData = await new Promise<{
          status?: number | undefined;
          body: string;
        }>((resolve) => {
          const req = http.request(
            {
              hostname: serverHandle.url.hostname,
              port: Number(serverHandle.url.port),
              path: serverHandle.url.pathname,
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Transfer-Encoding": "chunked",
                Accept: "application/json, text/event-stream",
              },
            },
            (res) => {
              let body = "";
              res.on("data", (chunk: Buffer) => {
                body += chunk.toString("utf8");
              });
              res.on("end", () => {
                resolve({ status: res.statusCode, body });
              });
            },
          );

          req.on("error", () => {
            // Early connection destruction by 413 response is expected
          });

          // Write first chunk (within cap)
          req.write(Buffer.alloc(250, 0x61)); // 250 bytes of 'a'
          // Write second chunk (pushes total to 500 > 400 cap)
          req.write(Buffer.alloc(250, 0x62)); // 250 bytes of 'b'
          req.end();
        });

        expect(responseData.status).toBe(413);
        expect(responseData.body).toContain("Payload Too Large");

        // Verify server remains responsive with a valid request
        const followUp = await fetch(serverHandle.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 3,
            method: "tools/call",
            params: { name: "getGreeting", arguments: { name: "Bob" } },
          }),
        });
        expect(followUp.status).toBe(200);
      } finally {
        await serverHandle.close();
      }
    });

    it("rejects request missing Host header with 400 Bad Request", async () => {
      const runtime = createTestRuntime();
      const serverHandle = await serveHttp(
        runtime,
        {
          name: "host-server",
          version: "1.0.0",
          createContext: () => ({
            requestId: "req-host",
            tenantId: "default",
            principal: { id: "p", scopes: [] },
          }),
        },
        { port: 0 },
      );

      try {
        const client = net.connect(
          Number(serverHandle.url.port),
          serverHandle.url.hostname,
        );
        await new Promise<void>((resolve) => client.on("connect", resolve));
        client.write("GET /health HTTP/1.1\r\nConnection: close\r\n\r\n");

        let rawResponse = "";
        for await (const chunk of client) {
          rawResponse += (chunk as Buffer).toString("utf8");
        }

        expect(rawResponse).toContain("400 Bad Request");

        // Follow-up valid request succeeds
        const followUp = await fetch(serverHandle.url, {
          method: "GET",
        });
        expect(followUp.status).toBe(405); // GET on /mcp is 405 in stateless McpHandler
      } finally {
        await serverHandle.close();
      }
    });

    it("rejects request with malformed Host header with 400 Bad Request", async () => {
      const runtime = createTestRuntime();
      const serverHandle = await serveHttp(
        runtime,
        {
          name: "malformed-host-server",
          version: "1.0.0",
          createContext: () => ({
            requestId: "req-host",
            tenantId: "default",
            principal: { id: "p", scopes: [] },
          }),
        },
        { port: 0 },
      );

      try {
        const client = net.connect(
          Number(serverHandle.url.port),
          serverHandle.url.hostname,
        );
        await new Promise<void>((resolve) => client.on("connect", resolve));
        client.write(
          "GET /health HTTP/1.1\r\nHost: bad host name with spaces\r\nConnection: close\r\n\r\n",
        );

        let rawResponse = "";
        for await (const chunk of client) {
          rawResponse += (chunk as Buffer).toString("utf8");
        }

        expect(rawResponse).toContain("HTTP/1.1 400");
        expect(rawResponse).toContain("Malformed Host header");
      } finally {
        await serverHandle.close();
      }
    });

    it("rejects request when Host is not in allowlist with 403 Forbidden without echoing host in response", async () => {
      const runtime = createTestRuntime();
      const serverHandle = await serveHttp(
        runtime,
        {
          name: "allowlist-server",
          version: "1.0.0",
          createContext: () => ({
            requestId: "req-al",
            tenantId: "default",
            principal: { id: "p", scopes: [] },
          }),
        },
        {
          port: 0,
          allowedHosts: ["allowed.example.com"],
        },
      );

      try {
        const makeRawRequest = (hostHeader: string) =>
          new Promise<{ status?: number | undefined; body: string }>(
            (resolve, reject) => {
              const req = http.request(
                {
                  hostname: serverHandle.url.hostname,
                  port: Number(serverHandle.url.port),
                  path: serverHandle.url.pathname,
                  method: "POST",
                  headers: {
                    Host: hostHeader,
                    "Content-Type": "application/json",
                    Accept: "application/json, text/event-stream",
                  },
                },
                (res) => {
                  let data = "";
                  res.on("data", (c: Buffer) => {
                    data += c.toString("utf8");
                  });
                  res.on("end", () => {
                    resolve({ status: res.statusCode, body: data });
                  });
                },
              );
              req.on("error", reject);
              req.write(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: 1,
                  method: "tools/call",
                  params: {
                    name: "getGreeting",
                    arguments: { name: "Test" },
                  },
                }),
              );
              req.end();
            },
          );

        // Disallowed Host -> 403
        const deniedRes = await makeRawRequest("attacker.evil.com");
        expect(deniedRes.status).toBe(403);
        expect(deniedRes.body).toContain("Host not allowed");
        expect(deniedRes.body).not.toContain("attacker.evil.com");

        // Allowed Host -> 200
        const allowedRes = await makeRawRequest("allowed.example.com");
        expect(allowedRes.status).toBe(200);
      } finally {
        await serverHandle.close();
      }
    });

    it("rejects request when Origin is not in allowlist with 403 Forbidden when protection enabled", async () => {
      const runtime = createTestRuntime();
      const serverHandle = await serveHttp(
        runtime,
        {
          name: "origin-server",
          version: "1.0.0",
          createContext: () => ({
            requestId: "req-orig",
            tenantId: "default",
            principal: { id: "p", scopes: [] },
          }),
        },
        {
          port: 0,
          allowedOrigins: ["https://trusted.example.com"],
          enableDnsRebindingProtection: true,
        },
      );

      try {
        // Untrusted origin -> 403
        const untrustedRes = await fetch(serverHandle.url, {
          method: "POST",
          headers: {
            Origin: "https://evil.attacker.com",
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "getGreeting", arguments: { name: "Test" } },
          }),
        });
        expect(untrustedRes.status).toBe(403);
        const data = (await untrustedRes.json()) as {
          error?: { message: string };
        };
        expect(data.error?.message).toContain("Origin not allowed");
        expect(JSON.stringify(data)).not.toContain("evil.attacker.com");

        // Trusted origin -> 200
        const trustedRes = await fetch(serverHandle.url, {
          method: "POST",
          headers: {
            Origin: "https://trusted.example.com",
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name: "getGreeting", arguments: { name: "Trusted" } },
          }),
        });
        expect(trustedRes.status).toBe(200);

        // Missing origin (CLI / non-browser) -> 200
        const noOriginRes = await fetch(serverHandle.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 3,
            method: "tools/call",
            params: { name: "getGreeting", arguments: { name: "NonBrowser" } },
          }),
        });
        expect(noOriginRes.status).toBe(200);
      } finally {
        await serverHandle.close();
      }
    });

    it("terminates connection on slow-body client exceeding requestTimeoutMs and remains responsive for follow-up requests", async () => {
      const runtime = createTestRuntime();
      const serverHandle = await serveHttp(
        runtime,
        {
          name: "slow-body-server",
          version: "1.0.0",
          createContext: () => ({
            requestId: "req-slow",
            tenantId: "default",
            principal: { id: "p", scopes: [] },
          }),
        },
        {
          port: 0,
          requestTimeoutMs: 150,
        },
      );

      try {
        const client = net.connect(
          Number(serverHandle.url.port),
          serverHandle.url.hostname,
        );
        await new Promise<void>((resolve) => client.on("connect", resolve));
        // Write partial body with Content-Length declaring more data
        client.write(
          "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{",
        );

        const clientOutcome = await new Promise<string>((resolve) => {
          let incoming = "";
          client.on("data", (chunk: Buffer) => {
            incoming += chunk.toString("utf8");
          });
          client.on("close", () => resolve(incoming));
          client.on("error", () => resolve(incoming));
        });

        // Socket closed or returned 408 Request Timeout
        expect(
          clientOutcome.length === 0 ||
            clientOutcome.includes("408") ||
            clientOutcome.includes("Timeout"),
        ).toBe(true);

        // Follow-up valid request succeeds immediately
        const followUp = await fetch(serverHandle.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: {
              name: "getGreeting",
              arguments: { name: "AfterTimeout" },
            },
          }),
        });
        expect(followUp.status).toBe(200);
      } finally {
        await serverHandle.close();
      }
    });
  });

  describe("HTTP Inbound Auth Fail-Closed & Secure Defaults (RM-03)", () => {
    const testServerOptions: McpServerOptions = {
      name: "test-server",
      version: "1.0.0",
      createContext: () => ({
        requestId: "req-1",
        tenantId: "default",
        principal: { id: "anonymous", scopes: [] },
      }),
    };

    it("refuses to bind to non-loopback host without authentication when override is false", async () => {
      const runtime = createTestRuntime();
      await expect(
        serveHttp(runtime, testServerOptions, { host: "0.0.0.0", port: 0 }),
      ).rejects.toThrow(
        /Refusing to bind HTTP server to non-loopback host "0\.0\.0\.0" without authentication\. Set "security\.requireInboundAuth: true" with a configured verifier, or set "security\.allowUnauthenticatedHttp: true"/,
      );
    });

    it("allows non-loopback host when allowUnauthenticatedHttp is true and emits warning", async () => {
      const runtime = createTestRuntime();
      const warnings: Array<{
        message: string;
        meta?: Record<string, unknown> | undefined;
      }> = [];
      const serverHandle = await serveHttp(runtime, testServerOptions, {
        host: "0.0.0.0",
        port: 0,
        allowUnauthenticatedHttp: true,
        warn: (message, meta) => warnings.push({ message, meta }),
      });
      try {
        expect(warnings.length).toBe(1);
        expect(warnings[0]?.message).toContain("[SECURITY WARNING]");
        expect(warnings[0]?.message).toContain("0.0.0.0");
        expect(warnings[0]?.message).toContain("security.requireInboundAuth");
        expect(warnings[0]?.meta?.event).toBe("unauthenticated_http_startup");
        expect(warnings[0]?.meta?.host).toBe("0.0.0.0");
        expect(warnings[0]?.meta?.configKey).toBe(
          "security.requireInboundAuth",
        );
      } finally {
        await serverHandle.close();
      }
    });

    it("starts on loopback host without auth and emits warning", async () => {
      const runtime = createTestRuntime();
      const warnings: Array<{
        message: string;
        meta?: Record<string, unknown> | undefined;
      }> = [];
      const serverHandle = await serveHttp(runtime, testServerOptions, {
        host: "127.0.0.1",
        port: 0,
        warn: (message, meta) => warnings.push({ message, meta }),
      });
      try {
        expect(warnings.length).toBe(2);
        const unauth = warnings.find(
          (w) => w.meta?.event === "unauthenticated_http_startup",
        );
        expect(unauth).toBeDefined();
        expect(unauth?.message).toContain("[SECURITY WARNING]");
        expect(unauth?.message).toContain("127.0.0.1");
        expect(unauth?.message).toContain("1 tool(s) exposed");

        const corsWarn = warnings.find(
          (w) => w.meta?.event === "cors_wildcard_warning",
        );
        expect(corsWarn).toBeDefined();
        expect(corsWarn?.message).toContain("[SECURITY WARNING]");
        expect(corsWarn?.message).toContain(
          "CORS is enabled with wildcard origin",
        );
      } finally {
        await serverHandle.close();
      }
    });

    it("fails fast at startup when requireInboundAuth is true but no verifier is provided", async () => {
      const runtime = createTestRuntime();
      await expect(
        serveHttp(runtime, testServerOptions, {
          port: 0,
          requireInboundAuth: true,
          authorizerType: "none",
        }),
      ).rejects.toThrow(
        /HTTP inbound authentication is required \("security\.requireInboundAuth: true"\), but no inbound verifier is configured/,
      );
    });

    it("fails fast at startup when authorizer is scope but no verifier is provided", async () => {
      const runtime = createTestRuntime();
      await expect(
        serveHttp(runtime, testServerOptions, {
          port: 0,
          authorizerType: "scope",
        }),
      ).rejects.toThrow(
        /Inbound authorizer is configured as "scope", but no inbound verifier is configured\. Scope authorization requires an authenticated principal/,
      );
    });

    it("logs resolved security posture at startup", async () => {
      const runtime = createTestRuntime();
      const infoLogs: Array<{
        message: string;
        meta?: Record<string, unknown> | undefined;
      }> = [];
      const serverHandle = await serveHttp(runtime, testServerOptions, {
        host: "127.0.0.1",
        port: 0,
        info: (message, meta) => infoLogs.push({ message, meta }),
      });
      try {
        expect(infoLogs.length).toBe(1);
        expect(infoLogs[0]?.message).toContain(
          "[SECURITY] HTTP security posture",
        );
        expect(infoLogs[0]?.meta?.event).toBe("security_posture");
        expect(infoLogs[0]?.meta?.inboundAuth).toBe(false);
        expect(infoLogs[0]?.meta?.tenantMode).toBe("single-tenant");
        expect(infoLogs[0]?.meta?.allowedHosts).toContain("localhost");
      } finally {
        await serverHandle.close();
      }
    });
  });

  describe("Configurable CORS Allowlist and Dynamic Headers (RM-04)", () => {
    const testServerOptions: McpServerOptions = {
      name: "cors-test-server",
      version: "1.0.0",
      createContext: () => ({
        requestId: `req-${Date.now()}`,
        tenantId: "default",
        principal: { id: "test-user", scopes: [] },
      }),
    };

    it("reflects allowed origin with Vary: Origin and credentials on preflight and request", async () => {
      const runtime = createTestRuntime();
      const serverHandle = await serveHttp(runtime, testServerOptions, {
        port: 0,
        cors: {
          enabled: true,
          allowedOrigins: ["https://app.example.com"],
          allowCredentials: true,
          maxAgeSeconds: 1800,
        },
      });

      try {
        // 1. Preflight OPTIONS
        const preflightRes = await fetch(serverHandle.url, {
          method: "OPTIONS",
          headers: {
            Origin: "https://app.example.com",
            "Access-Control-Request-Method": "POST",
          },
        });
        expect(preflightRes.status).toBe(204);
        expect(preflightRes.headers.get("access-control-allow-origin")).toBe(
          "https://app.example.com",
        );
        expect(
          preflightRes.headers.get("access-control-allow-credentials"),
        ).toBe("true");
        expect(preflightRes.headers.get("access-control-max-age")).toBe("1800");
        expect(preflightRes.headers.get("vary")).toBe("Origin");

        // 2. Normal POST request
        const postRes = await fetch(serverHandle.url, {
          method: "POST",
          headers: {
            Origin: "https://app.example.com",
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "getGreeting", arguments: { name: "Allowed" } },
          }),
        });
        expect(postRes.status).toBe(200);
        expect(postRes.headers.get("access-control-allow-origin")).toBe(
          "https://app.example.com",
        );
        expect(postRes.headers.get("access-control-allow-credentials")).toBe(
          "true",
        );
        expect(postRes.headers.get("vary")).toBe("Origin");
      } finally {
        await serverHandle.close();
      }
    });

    it("rejects disallowed origin on preflight with 403 and omits allow-origin header on normal requests", async () => {
      const runtime = createTestRuntime();
      const serverHandle = await serveHttp(runtime, testServerOptions, {
        port: 0,
        cors: {
          enabled: true,
          allowedOrigins: ["https://app.example.com"],
        },
      });

      try {
        // 1. Preflight from untrusted origin -> 403 Forbidden
        const preflightRes = await fetch(serverHandle.url, {
          method: "OPTIONS",
          headers: {
            Origin: "https://evil.attacker.com",
            "Access-Control-Request-Method": "POST",
          },
        });
        expect(preflightRes.status).toBe(403);
        expect(
          preflightRes.headers.get("access-control-allow-origin"),
        ).toBeNull();
        expect(preflightRes.headers.get("vary")).toBe("Origin");
        const preflightData = (await preflightRes.json()) as {
          error?: { message: string };
        };
        expect(preflightData.error?.message).toContain(
          "CORS origin not allowed",
        );

        // 2. Normal POST request from untrusted origin -> succeeds or proceeds, but NO Access-Control-Allow-Origin
        const postRes = await fetch(serverHandle.url, {
          method: "POST",
          headers: {
            Origin: "https://evil.attacker.com",
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name: "getGreeting", arguments: { name: "Evil" } },
          }),
        });
        expect(postRes.status).toBe(200);
        expect(postRes.headers.get("access-control-allow-origin")).toBeNull();
        expect(postRes.headers.get("vary")).toBe("Origin");
      } finally {
        await serverHandle.close();
      }
    });

    it("rejects null origin unless explicitly declared in allowedOrigins", async () => {
      const runtime = createTestRuntime();

      // Server A: "null" NOT in allowedOrigins
      const serverHandleA = await serveHttp(runtime, testServerOptions, {
        port: 0,
        cors: {
          enabled: true,
          allowedOrigins: ["https://app.example.com"],
        },
      });

      try {
        const preflightA = await fetch(serverHandleA.url, {
          method: "OPTIONS",
          headers: {
            Origin: "null",
            "Access-Control-Request-Method": "POST",
          },
        });
        expect(preflightA.status).toBe(403);
        expect(
          preflightA.headers.get("access-control-allow-origin"),
        ).toBeNull();
      } finally {
        await serverHandleA.close();
      }

      // Server B: "null" explicitly in allowedOrigins
      const serverHandleB = await serveHttp(runtime, testServerOptions, {
        port: 0,
        cors: {
          enabled: true,
          allowedOrigins: ["https://app.example.com", "null"],
        },
      });

      try {
        const preflightB = await fetch(serverHandleB.url, {
          method: "OPTIONS",
          headers: {
            Origin: "null",
            "Access-Control-Request-Method": "POST",
          },
        });
        expect(preflightB.status).toBe(204);
        expect(preflightB.headers.get("access-control-allow-origin")).toBe(
          "null",
        );
        expect(preflightB.headers.get("vary")).toBe("Origin");

        const postB = await fetch(serverHandleB.url, {
          method: "POST",
          headers: {
            Origin: "null",
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 3,
            method: "tools/call",
            params: { name: "getGreeting", arguments: { name: "Sandboxed" } },
          }),
        });
        expect(postB.status).toBe(200);
        expect(postB.headers.get("access-control-allow-origin")).toBe("null");
      } finally {
        await serverHandleB.close();
      }
    });

    it("rejects allowedOrigins: ['*'] with allowCredentials: true at server startup", async () => {
      const runtime = createTestRuntime();
      await expect(
        serveHttp(runtime, testServerOptions, {
          port: 0,
          cors: {
            allowedOrigins: ["*"],
            allowCredentials: true,
          },
        }),
      ).rejects.toThrow(
        "Wildcard origin ('*') cannot be used when allowCredentials is true",
      );
    });

    it("computes Access-Control-Allow-Headers dynamically from configured verifier and extra headers", async () => {
      const runtime = createTestRuntime();
      const apiKeyVerifier = createApiKeyVerifier({
        headerName: "X-Tenant-Key",
        keys: {
          "tenant-secret-key": {
            tenantId: "tenant-custom",
            principalId: "p-custom",
          },
        },
      });

      const serverHandle = await serveHttp(runtime, testServerOptions, {
        port: 0,
        verifier: apiKeyVerifier,
        cors: {
          enabled: true,
          allowedOrigins: ["https://app.example.com"],
          allowedHeaders: ["X-Client-Trace-Id", "X-Custom-Env"],
        },
      });

      try {
        const preflightRes = await fetch(serverHandle.url, {
          method: "OPTIONS",
          headers: {
            Origin: "https://app.example.com",
            "Access-Control-Request-Method": "POST",
          },
        });
        expect(preflightRes.status).toBe(204);
        const allowHeaders =
          preflightRes.headers.get("access-control-allow-headers") ?? "";
        // Verifier custom header present
        expect(allowHeaders).toContain("X-Tenant-Key");
        // Extra configured headers present
        expect(allowHeaders).toContain("X-Client-Trace-Id");
        expect(allowHeaders).toContain("X-Custom-Env");
        // Standard defaults present
        expect(allowHeaders).toContain("Content-Type");
        expect(allowHeaders).toContain("Authorization");
        expect(allowHeaders).toContain("X-API-Key");
        expect(allowHeaders).toContain("Accept");
        expect(allowHeaders).toContain("mcp-session-id");
        expect(allowHeaders).toContain("last-event-id");
      } finally {
        await serverHandle.close();
      }
    });

    it("omits all CORS headers and skips preflight interception when cors.enabled is false", async () => {
      const runtime = createTestRuntime();
      const serverHandle = await serveHttp(runtime, testServerOptions, {
        port: 0,
        cors: false,
      });

      try {
        const optionsRes = await fetch(serverHandle.url, {
          method: "OPTIONS",
          headers: {
            Origin: "https://app.example.com",
            "Access-Control-Request-Method": "POST",
          },
        });
        // With CORS disabled, options is not intercepted as CORS preflight (no 204 or 403)
        expect(
          optionsRes.headers.get("access-control-allow-origin"),
        ).toBeNull();
        expect(optionsRes.headers.get("vary")).toBeNull();

        const postRes = await fetch(serverHandle.url, {
          method: "POST",
          headers: {
            Origin: "https://app.example.com",
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 4,
            method: "tools/call",
            params: { name: "getGreeting", arguments: { name: "NoCors" } },
          }),
        });
        expect(postRes.status).toBe(200);
        expect(postRes.headers.get("access-control-allow-origin")).toBeNull();
        expect(postRes.headers.get("vary")).toBeNull();
      } finally {
        await serverHandle.close();
      }
    });

    it("defaults to CORS disabled for non-loopback bindings when unspecified", async () => {
      const runtime = createTestRuntime();
      const serverHandle = await serveHttp(runtime, testServerOptions, {
        host: "0.0.0.0",
        port: 0,
        allowUnauthenticatedHttp: true,
      });

      try {
        const preflightRes = await fetch(serverHandle.url, {
          method: "OPTIONS",
          headers: {
            Origin: "https://app.example.com",
            "Access-Control-Request-Method": "POST",
          },
        });
        expect(
          preflightRes.headers.get("access-control-allow-origin"),
        ).toBeNull();
        expect(preflightRes.headers.get("vary")).toBeNull();
      } finally {
        await serverHandle.close();
      }
    });
  });
});

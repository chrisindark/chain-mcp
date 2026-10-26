import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
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
      { port: 0 },
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
});

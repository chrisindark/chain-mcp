import {
  createFieldProjector,
  InMemoryCacheStore,
  type Logger,
  type MetricsSink,
  type RuntimeEvent,
  type ToolContext,
} from "@chainmcp/core";
import type {
  HostResolver,
  UpstreamTransport,
  UpstreamTransportRequest,
  UpstreamTransportResponse,
} from "@chainmcp/executor";
import { type GatewayAuditEvent, DynamicGateway } from "@chainmcp/gateway";
import { describe, expect, it } from "vitest";

import {
  DeclarativeAdmin,
  evaluateDescriptorSet,
  type DeclarativeAdminAuditEvent,
} from "../src/index.js";
import {
  CONTRACT_PATH,
  adminRequest,
  authSchemes,
  makeBinding,
  makeDescriptor,
} from "./fixtures.js";

const UPSTREAM_SECRET = "upstream-api-key-secret-value-0123456789";
const UPSTREAM_RESPONSE = {
  id: "u1",
  name: "Ada",
  email: "ada@example.com",
  secret: "private-field-value",
};

function jsonResponse(body: unknown): UpstreamTransportResponse {
  return {
    status: 200,
    headers: { "content-type": "application/json" },
    body: new TextEncoder().encode(JSON.stringify(body)),
  };
}

class FakeTransport implements UpstreamTransport {
  readonly requests: UpstreamTransportRequest[] = [];
  responder: (
    request: UpstreamTransportRequest,
  ) => UpstreamTransportResponse | Promise<UpstreamTransportResponse> = () =>
    jsonResponse(UPSTREAM_RESPONSE);

  async request(
    request: UpstreamTransportRequest,
  ): Promise<UpstreamTransportResponse> {
    this.requests.push(request);
    return await this.responder(request);
  }
}

const resolveHost: HostResolver = async () => ["8.8.8.8"];

function callerContext(scopes: readonly string[]): ToolContext {
  return {
    requestId: `req-${scopes.join("-") || "anon"}`,
    tenantId: "tenant-a",
    principal: { id: "user-1", scopes },
  };
}

interface CapturedLog {
  readonly level: string;
  readonly message: string;
  readonly context?: Record<string, unknown>;
}

function capturingLogger(): { logger: Logger; entries: CapturedLog[] } {
  const entries: CapturedLog[] = [];
  const push =
    (level: string) =>
    (message: string, context?: Record<string, unknown>): void => {
      entries.push({
        level,
        message,
        ...(context === undefined ? {} : { context }),
      });
    };
  return {
    entries,
    logger: {
      debug: push("debug"),
      info: push("info"),
      warn: push("warn"),
      error: push("error"),
    },
  };
}

const credentialProvider = {
  resolveCredential: async () => ({
    type: "apiKey" as const,
    name: "X-API-Key",
    location: "header" as const,
    value: UPSTREAM_SECRET,
  }),
};

interface PipelineFixture {
  readonly gateway: DynamicGateway;
  readonly transport: FakeTransport;
  readonly admin: DeclarativeAdmin;
  readonly gatewayAudit: GatewayAuditEvent[];
  readonly adminAudit: DeclarativeAdminAuditEvent[];
  readonly events: RuntimeEvent[];
  readonly logs: CapturedLog[];
}

async function publishDescriptor(
  descriptors: readonly Record<string, unknown>[],
  overrides: {
    readonly policy?: Record<string, unknown>;
    readonly limits?: { timeoutMs?: number };
  } = {},
): Promise<PipelineFixture> {
  const transport = new FakeTransport();
  const gatewayAudit: GatewayAuditEvent[] = [];
  const adminAudit: DeclarativeAdminAuditEvent[] = [];
  const events: RuntimeEvent[] = [];
  const { logger, entries } = capturingLogger();
  const metrics: MetricsSink = {
    record: (event) => {
      events.push(event);
    },
  };

  const gateway = new DynamicGateway({
    transport,
    resolveHost,
    projector: createFieldProjector(),
    cache: {
      store: new InMemoryCacheStore(),
      authorizationPartition: (context) =>
        `${context.tenantId}:${context.principal.id}`,
    },
    metrics,
    logger,
    auditSink: (event) => {
      gatewayAudit.push(event);
    },
  });

  const admin = new DeclarativeAdmin({
    gateway,
    transport,
    resolveHost,
    tokens: [{ id: "operator", token: "admin-token-0123456789", tenants: "*" }],
    contracts: [
      makeBinding({
        credentialProvider,
        ...(overrides.limits === undefined ? {} : { limits: overrides.limits }),
      }),
    ],
    auditSink: (event) => {
      adminAudit.push(event);
    },
  });

  const response = await admin.handle(
    adminRequest(`${CONTRACT_PATH}/publish`, "POST", {
      body: { descriptors },
    }),
  );
  expect(response.status).toBe(201);

  return {
    gateway,
    transport,
    admin,
    gatewayAudit,
    adminAudit,
    events,
    logs: entries,
  };
}

function auditedDescriptor(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return makeDescriptor({
    policy: {
      requiredScopes: ["users:read"],
      cacheTtlSeconds: 30,
      outputFields: { include: ["id", "name"] },
      timeoutMs: 10_000,
      ...overrides,
    },
    ...overrides,
  });
}

describe("descriptor-backed tools share compiled-tool control paths", () => {
  it("enforces scopes, injects credentials, projects output, and audits", async () => {
    const { gateway, transport, adminAudit, gatewayAudit, events } =
      await publishDescriptor([auditedDescriptor()]);

    // Authorization runs before execution: no scope means no upstream request.
    await expect(
      gateway.callTool(
        "get_user",
        { userId: "42", limit: 5 },
        callerContext([]),
      ),
    ).rejects.toMatchObject({ code: "AUTH_FORBIDDEN" });
    expect(transport.requests).toHaveLength(0);

    const result = await gateway.callTool(
      "get_user",
      { userId: "42", limit: 5 },
      callerContext(["users:read"]),
    );
    expect(result).toEqual({ id: "u1", name: "Ada" });

    // Executor mapping and destination policy: relative path only, exact host.
    const request = transport.requests[0];
    expect(request).toBeDefined();
    expect(request?.method).toBe("GET");
    expect(request?.url.origin).toBe("https://api.example.com");
    expect(request?.url.pathname).toBe("/users/42");
    expect(request?.url.searchParams.get("limit")).toBe("5");
    expect(request?.hostname).toBe("api.example.com");

    // The deployment credential was injected by the executor, not by input.
    const apiKeyHeader = Object.entries(request?.headers ?? {}).find(
      ([name]) => name.toLowerCase() === "x-api-key",
    );
    expect(apiKeyHeader?.[1]).toBe(UPSTREAM_SECRET);

    // Audit: gateway publication plus admin publication, and a runtime event.
    expect(gatewayAudit.map((event) => event.type)).toEqual(
      expect.arrayContaining(["contract_published", "contract_activated"]),
    );
    expect(
      adminAudit.some(
        (event) => event.type === "admin_publish" && event.toolCount === 1,
      ),
    ).toBe(true);
    // Denials are metered too: the scope-less call is recorded as an error
    // before the successful call that follows it.
    expect(events).toEqual([
      expect.objectContaining({
        name: "tool_invocation",
        tenantId: "tenant-a",
        toolName: "get_user",
        outcome: "error",
        errorCode: "AUTH_FORBIDDEN",
      }),
      expect.objectContaining({
        name: "tool_invocation",
        tenantId: "tenant-a",
        toolName: "get_user",
        outcome: "success",
        cacheOutcome: "miss",
      }),
    ]);

    // Redaction: no credential, response secret, or descriptor argument leaks
    // into logs, audit records, or metrics.
    const serialized = JSON.stringify({
      adminAudit,
      gatewayAudit,
      events,
    });
    expect(serialized).not.toContain(UPSTREAM_SECRET);
    expect(serialized).not.toContain("private-field-value");
    expect(serialized).not.toContain("ada@example.com");
  });

  it("caches eligible reads through the shared cache stage", async () => {
    const { gateway, transport, events } = await publishDescriptor([
      auditedDescriptor(),
    ]);

    const first = await gateway.callTool(
      "get_user",
      { userId: "42" },
      callerContext(["users:read"]),
    );
    const second = await gateway.callTool(
      "get_user",
      { userId: "42" },
      callerContext(["users:read"]),
    );

    expect(second).toEqual(first);
    expect(transport.requests).toHaveLength(1);
    expect(events.map((event) => event.cacheOutcome)).toEqual(["miss", "hit"]);
  });

  it("enforces the declared timeout through the shared timeout stage", async () => {
    const transport = new FakeTransport();
    const gatewayAudit: GatewayAuditEvent[] = [];
    const gateway = new DynamicGateway({
      transport,
      resolveHost,
      projector: createFieldProjector(),
      auditSink: (event) => {
        gatewayAudit.push(event);
      },
    });
    const admin = new DeclarativeAdmin({
      gateway,
      transport,
      resolveHost,
      tokens: [
        { id: "operator", token: "admin-token-0123456789", tenants: "*" },
      ],
      contracts: [makeBinding({ credentialProvider })],
    });

    const descriptor = makeDescriptor({
      policy: { requiredScopes: ["users:read"], timeoutMs: 100 },
    });
    const response = await admin.handle(
      adminRequest(`${CONTRACT_PATH}/publish`, "POST", {
        body: { descriptors: [descriptor] },
      }),
    );
    expect(response.status).toBe(201);

    // The transport only fails when the runtime aborts the shared signal.
    transport.responder = (request) =>
      new Promise((_resolve, reject) => {
        request.signal.addEventListener(
          "abort",
          () => reject(new Error("aborted by runtime timeout")),
          { once: true },
        );
      });

    await expect(
      gateway.callTool(
        "get_user",
        { userId: "42" },
        callerContext(["users:read"]),
      ),
    ).rejects.toMatchObject({ code: "UPSTREAM_TIMEOUT" });
    expect(transport.requests).toHaveLength(1);
    expect(
      gatewayAudit.some((event) => event.type === "contract_published"),
    ).toBe(true);
  });
});

describe("per-contract transport and resolver overrides", () => {
  it("uses the binding's transport and resolver instead of the admin-wide ones", async () => {
    const adminWideTransport = new FakeTransport();
    adminWideTransport.responder = () => {
      throw new Error("admin-wide transport must not be used");
    };
    const contractTransport = new FakeTransport();
    const gateway = new DynamicGateway({
      transport: adminWideTransport,
      resolveHost,
      projector: createFieldProjector(),
    });
    const admin = new DeclarativeAdmin({
      gateway,
      transport: adminWideTransport,
      // The binding overrides this, so it must never be called.
      resolveHost: async () => {
        throw new Error("admin-wide resolver must not be used");
      },
      tokens: [
        { id: "operator", token: "admin-token-0123456789", tenants: "*" },
      ],
      contracts: [
        makeBinding({
          credentialProvider,
          transport: contractTransport,
          resolveHost,
        }),
      ],
    });

    const response = await admin.handle(
      adminRequest(`${CONTRACT_PATH}/publish`, "POST", {
        body: { descriptors: [auditedDescriptor()] },
      }),
    );
    expect(response.status).toBe(201);

    const result = await gateway.callTool(
      "get_user",
      { userId: "42" },
      callerContext(["users:read"]),
    );
    expect(result).toEqual({ id: "u1", name: "Ada" });
    expect(contractTransport.requests).toHaveLength(1);
    expect(adminWideTransport.requests).toHaveLength(0);
  });

  it("falls back to the admin-wide transport when a binding sets none", async () => {
    const adminWideTransport = new FakeTransport();
    const gateway = new DynamicGateway({
      transport: adminWideTransport,
      resolveHost,
      projector: createFieldProjector(),
    });
    const admin = new DeclarativeAdmin({
      gateway,
      transport: adminWideTransport,
      resolveHost,
      tokens: [
        { id: "operator", token: "admin-token-0123456789", tenants: "*" },
      ],
      contracts: [makeBinding({ credentialProvider })],
    });

    const response = await admin.handle(
      adminRequest(`${CONTRACT_PATH}/publish`, "POST", {
        body: { descriptors: [auditedDescriptor()] },
      }),
    );
    expect(response.status).toBe(201);

    await gateway.callTool(
      "get_user",
      { userId: "42" },
      callerContext(["users:read"]),
    );
    expect(adminWideTransport.requests).toHaveLength(1);
  });
});

describe("descriptor input can never carry executable code", () => {
  it("rejects code-bearing fields on the descriptor root", () => {
    const { evaluation } = evaluateDescriptorSet({
      descriptors: [
        {
          ...makeDescriptor(),
          code: "process.exit(1)",
        },
      ],
      authSchemes,
    });

    expect(evaluation.valid).toBe(false);
    expect(evaluation.diagnostics[0]?.code).toBe("DESCRIPTOR_INVALID");
  });

  it("rejects code-bearing fields inside the request and policy objects", () => {
    const { evaluation } = evaluateDescriptorSet({
      descriptors: [
        {
          ...makeDescriptor(),
          request: {
            ...(makeDescriptor().request as Record<string, unknown>),
            script: "fetch('https://evil.example')",
          },
        },
      ],
      authSchemes,
    });

    expect(evaluation.valid).toBe(false);
    expect(evaluation.diagnostics[0]?.code).toBe("DESCRIPTOR_INVALID");
  });

  it("has no route that accepts executable input", async () => {
    const { admin } = await publishDescriptor([auditedDescriptor()]);

    const metadata = await admin.handle(adminRequest("/api/v1"));
    const body = (await metadata.json()) as { endpoints: string[] };
    for (const endpoint of body.endpoints) {
      expect(endpoint).not.toMatch(/code|eval|exec|upload|script/i);
    }

    // A body that is not a descriptor collection is refused before parsing.
    const response = await admin.handle(
      adminRequest(`${CONTRACT_PATH}/validate`, "POST", {
        body: { code: "process.exit(1)" },
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "ADMIN_REQUEST_INVALID" },
    });
  });
});

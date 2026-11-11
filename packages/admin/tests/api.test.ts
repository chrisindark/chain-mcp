import { describe, expect, it } from "vitest";

import { DynamicGateway } from "@chainmcp/gateway";
import { MemoryStorageDriver } from "@chainmcp/storage";

import { DeclarativeAdmin, extractBearerToken } from "../src/index.js";
import {
  ADMIN_TOKEN,
  CONTRACT_PATH,
  SCOPED_TOKEN,
  adminRequest,
  makeAdmin,
  makeBinding,
  makeDescriptor,
} from "./fixtures.js";

describe("admin authentication", () => {
  it("requires a bearer token and rejects unknown tokens", async () => {
    const { admin, audit } = makeAdmin();

    const missing = await admin.handle(
      adminRequest(`${CONTRACT_PATH}/validate`, "POST", {
        token: null,
        body: { descriptors: [makeDescriptor()] },
      }),
    );
    expect(missing.status).toBe(401);
    expect(await missing.json()).toMatchObject({
      error: { code: "ADMIN_AUTH_REQUIRED" },
    });

    const basic = await admin.handle(
      new Request(`http://127.0.0.1:3341${CONTRACT_PATH}/validate`, {
        method: "POST",
        headers: {
          authorization: `Basic ${ADMIN_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ descriptors: [makeDescriptor()] }),
      }),
    );
    expect(basic.status).toBe(401);
    expect(await basic.json()).toMatchObject({
      error: { code: "ADMIN_AUTH_INVALID" },
    });

    const unknown = await admin.handle(
      adminRequest(`${CONTRACT_PATH}/validate`, "POST", {
        token: "wrong-token-0123456789",
        body: { descriptors: [makeDescriptor()] },
      }),
    );
    expect(unknown.status).toBe(401);

    expect(
      audit.filter((event) => event.type === "admin_auth_failed"),
    ).toHaveLength(3);
    for (const event of audit) {
      expect(JSON.stringify(event)).not.toContain(ADMIN_TOKEN);
    }
  });

  it("scopes tokens to their tenants before resolving a contract", async () => {
    const { admin } = makeAdmin();

    const forbidden = await admin.handle(
      adminRequest(`${CONTRACT_PATH}/validate`, "POST", {
        token: SCOPED_TOKEN,
        body: { descriptors: [makeDescriptor()] },
      }),
    );
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toMatchObject({
      error: { code: "ADMIN_TENANT_FORBIDDEN" },
    });

    const unbound = await admin.handle(
      adminRequest(
        "/api/v1/tenants/tenant-z/contracts/users/validate",
        "POST",
        { token: SCOPED_TOKEN, body: { descriptors: [makeDescriptor()] } },
      ),
    );
    // Scope is enforced before binding lookup, so existence cannot be probed.
    expect(unbound.status).toBe(403);

    const contracts = await admin.handle(
      adminRequest("/api/v1/contracts", "GET", { token: SCOPED_TOKEN }),
    );
    expect(await contracts.json()).toEqual({ contracts: [] });
  });

  it("parses only single Bearer credentials", () => {
    expect(extractBearerToken(`Bearer ${ADMIN_TOKEN}`)).toBe(ADMIN_TOKEN);
    expect(extractBearerToken(`bearer ${ADMIN_TOKEN}`)).toBe(ADMIN_TOKEN);
    expect(extractBearerToken(`Bearer ${ADMIN_TOKEN} extra`)).toBeUndefined();
    expect(extractBearerToken("Bearer a, Bearer b")).toBeUndefined();
    expect(extractBearerToken(null)).toBeUndefined();
  });
});

describe("admin validate and preview", () => {
  it("validates descriptors and returns stable diagnostics", async () => {
    const { admin, gateway } = makeAdmin();

    const ok = await admin.handle(
      adminRequest(`${CONTRACT_PATH}/validate`, "POST", {
        body: { descriptors: [makeDescriptor()] },
      }),
    );
    expect(ok.status).toBe(200);
    const validBody = (await ok.json()) as {
      valid: boolean;
      tools: { name: string; revision: string }[];
      diagnostics: unknown[];
    };
    expect(validBody.valid).toBe(true);
    expect(validBody.diagnostics).toEqual([]);
    expect(validBody.tools[0]?.revision).toMatch(/^sha256:/);

    const invalid = await admin.handle(
      adminRequest(`${CONTRACT_PATH}/validate`, "POST", {
        body: {
          descriptors: [
            makeDescriptor({
              request: { method: "GET", path: "https://evil.example/x" },
            }),
          ],
        },
      }),
    );
    expect(invalid.status).toBe(422);
    expect(await invalid.json()).toMatchObject({
      valid: false,
      diagnostics: [
        {
          index: 0,
          code: "PATH_INVALID",
          issues: [
            expect.objectContaining({ path: expect.stringContaining("path") }),
          ],
        },
      ],
    });

    // Validation is side-effect free.
    expect(gateway.getRegistry().listRevisions("tenant-a")).toEqual([]);
  });

  it("previews lowered requests without publishing", async () => {
    const { admin, gateway } = makeAdmin();

    const response = await admin.handle(
      adminRequest(`${CONTRACT_PATH}/preview`, "POST", {
        body: { descriptors: [makeDescriptor()] },
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      valid: boolean;
      tools: {
        method: string;
        path: string;
        parameters: unknown[];
        policy: { requiredScopes: string[] };
      }[];
    };
    expect(body.valid).toBe(true);
    expect(body.tools[0]).toMatchObject({
      method: "GET",
      path: "/users/{userId}",
      policy: { requiredScopes: ["users:read"] },
    });
    expect(body.tools[0]?.parameters).toHaveLength(2);
    expect(gateway.getRegistry().listActiveRevisions()).toEqual([]);
  });

  it("rejects malformed JSON, wrong media types, and oversized bodies", async () => {
    const { admin } = makeAdmin({ maxRequestBytes: 1_024 });

    const invalidJson = await admin.handle(
      adminRequest(`${CONTRACT_PATH}/validate`, "POST", { rawBody: "{" }),
    );
    expect(invalidJson.status).toBe(400);
    expect(await invalidJson.json()).toMatchObject({
      error: { code: "ADMIN_REQUEST_INVALID" },
    });

    const wrongType = await admin.handle(
      adminRequest(`${CONTRACT_PATH}/validate`, "POST", {
        body: { descriptors: [makeDescriptor()] },
        contentType: "text/plain",
      }),
    );
    expect(wrongType.status).toBe(415);
    expect(await wrongType.json()).toMatchObject({
      error: { code: "ADMIN_MEDIA_TYPE_UNSUPPORTED" },
    });

    const oversized = await admin.handle(
      adminRequest(`${CONTRACT_PATH}/validate`, "POST", {
        body: { descriptors: [makeDescriptor()], pad: "x".repeat(2_048) },
      }),
    );
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toMatchObject({
      error: { code: "ADMIN_REQUEST_TOO_LARGE" },
    });

    const missingBody = await admin.handle(
      adminRequest(`${CONTRACT_PATH}/validate`, "POST", { contentType: null }),
    );
    expect(missingBody.status).toBe(415);
  });

  it("rejects unsupported methods with an Allow header", async () => {
    const { admin } = makeAdmin();

    const response = await admin.handle(
      adminRequest(`${CONTRACT_PATH}/publish`, "GET"),
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    expect(await response.json()).toMatchObject({
      error: { code: "ADMIN_METHOD_NOT_ALLOWED" },
    });
  });

  it("returns 404 for unknown contracts and routes", async () => {
    const { admin } = makeAdmin();

    const unknownContract = await admin.handle(
      adminRequest(
        "/api/v1/tenants/tenant-a/contracts/missing/validate",
        "POST",
        {
          body: { descriptors: [makeDescriptor()] },
        },
      ),
    );
    expect(unknownContract.status).toBe(404);
    expect(await unknownContract.json()).toMatchObject({
      error: { code: "ADMIN_CONTRACT_UNKNOWN" },
    });

    const unknownRoute = await admin.handle(adminRequest("/api/v1/nope"));
    expect(unknownRoute.status).toBe(404);
    expect(await unknownRoute.json()).toMatchObject({
      error: { code: "ADMIN_ROUTE_NOT_FOUND" },
    });
  });

  it("serves the console with a strict CSP and no inline script", async () => {
    const { admin } = makeAdmin();

    const page = await admin.handle(adminRequest("/"));
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(page.headers.get("content-security-policy")).toContain(
      "script-src 'self'",
    );
    const html = await page.text();
    expect(html).toContain('src="/ui/app.js"');
    expect(html).not.toMatch(/<script(?![^>]*src=)/);

    const script = await admin.handle(adminRequest("/ui/app.js"));
    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toContain("text/javascript");
  });
});

describe("admin publish", () => {
  it("publishes through the gateway with tenant ownership and revisions", async () => {
    const { admin, gateway, audit } = makeAdmin();

    const response = await admin.handle(
      adminRequest(`${CONTRACT_PATH}/publish`, "POST", {
        body: { descriptors: [makeDescriptor()] },
      }),
    );
    expect(response.status).toBe(201);
    const published = (await response.json()) as {
      revisionId: string;
      gatewayRevisionId: string;
      status: string;
      tenantId: string;
      contractName: string;
      toolCount: number;
      descriptors: { name: string; revision: string }[];
      baseUrl: string;
    };
    expect(published).toMatchObject({
      status: "active",
      tenantId: "tenant-a",
      contractName: "users",
      toolCount: 1,
      baseUrl: "https://api.example.com",
    });
    expect(published.revisionId).toMatch(/^dset_[0-9a-f]{16}$/);
    expect(published.gatewayRevisionId).toMatch(/^rev_/);
    expect(published.descriptors).toEqual([
      { name: "get_user", revision: expect.stringMatching(/^sha256:/) },
    ]);

    const active = gateway.getRegistry().getActiveRevision("tenant-a", "users");
    expect(active?.revisionId).toBe(published.gatewayRevisionId);
    expect(active?.tools[0]).toMatchObject({
      name: "get_user",
      ownerTenantId: "tenant-a",
      contractRevision: published.gatewayRevisionId,
    });
    expect(active?.tools[0]?.operation.requiredScopes).toEqual(["users:read"]);

    const revisions = await admin.handle(
      adminRequest(`${CONTRACT_PATH}/revisions`),
    );
    expect(revisions.status).toBe(200);
    expect(await revisions.json()).toMatchObject({
      revisions: [
        {
          revisionId: published.revisionId,
          gatewayRevisionId: published.gatewayRevisionId,
          status: "active",
          toolNames: ["get_user"],
          descriptors: [{ name: "get_user" }],
        },
      ],
    });

    const tools = await admin.handle(adminRequest(`${CONTRACT_PATH}/tools`));
    expect(await tools.json()).toMatchObject({
      revisionId: published.gatewayRevisionId,
      tools: [
        {
          name: "get_user",
          contractRevision: published.gatewayRevisionId,
          requiredScopes: ["users:read"],
        },
      ],
    });

    const publishAudit = audit.find((event) => event.type === "admin_publish");
    expect(publishAudit).toMatchObject({
      tokenId: "operator",
      tenantId: "tenant-a",
      contractName: "users",
      revisionId: published.revisionId,
      toolCount: 1,
    });
    expect(JSON.stringify(publishAudit)).not.toContain(ADMIN_TOKEN);
  });

  it("does not publish invalid descriptor sets", async () => {
    const { admin, gateway } = makeAdmin();

    const response = await admin.handle(
      adminRequest(`${CONTRACT_PATH}/publish`, "POST", {
        body: {
          descriptors: [
            makeDescriptor(),
            makeDescriptor(),
            makeDescriptor({
              name: "bad",
              authentication: {
                alternatives: [{ schemes: [{ name: "nope" }] }],
              },
            }),
          ],
        },
      }),
    );
    expect(response.status).toBe(422);
    const body = (await response.json()) as { diagnostics: { code: string }[] };
    expect(body.diagnostics.map((d) => d.code)).toEqual([
      "NAME_DUPLICATE",
      "AUTH_SCHEME_UNKNOWN",
    ]);
    expect(gateway.getRegistry().listRevisions("tenant-a")).toEqual([]);
  });

  it("reports tool-name collisions with another active contract as a conflict", async () => {
    const { admin, gateway } = makeAdmin();
    await gateway.publishContract({
      tenantId: "tenant-a",
      contractName: "other",
      tools: [
        {
          name: "get_user",
          description: "conflicting",
          inputSchema: { type: "object", properties: {} },
          operation: {},
          ownerTenantId: "tenant-a",
          execute: async () => ({}),
        },
      ],
      destinationPolicy: {
        baseUrl: "https://api.example.com",
        allowedHosts: ["api.example.com"],
      },
    });

    const response = await admin.handle(
      adminRequest(`${CONTRACT_PATH}/publish`, "POST", {
        body: { descriptors: [makeDescriptor()] },
      }),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: "ADMIN_PUBLISH_CONFLICT" },
    });
  });

  it("returns 404 for revisions that belong to another contract", async () => {
    const { admin } = makeAdmin();
    const published = await admin.handle(
      adminRequest(`${CONTRACT_PATH}/publish`, "POST", {
        body: { descriptors: [makeDescriptor()] },
      }),
    );
    const { revisionId } = (await published.json()) as { revisionId: string };

    const otherContract = await admin.handle(
      adminRequest(
        `/api/v1/tenants/tenant-a/contracts/other/revisions/${revisionId}`,
      ),
    );
    expect(otherContract.status).toBe(404);
  });

  it("refuses to construct without tokens or with ambiguous bindings", () => {
    const gateway = new DynamicGateway();

    expect(() => new DeclarativeAdmin({ gateway, tokens: [] })).toThrowError(
      /at least one/,
    );
    expect(
      () =>
        new DeclarativeAdmin({
          gateway,
          tokens: [{ id: "a", token: "too-short", tenants: "*" }],
        }),
    ).toThrowError(/16/);
    expect(
      () =>
        new DeclarativeAdmin({
          gateway,
          tokens: [{ id: "a", token: "admin-token-0123456789", tenants: "*" }],
          contracts: [makeBinding(), makeBinding()],
        }),
    ).toThrowError(/duplicated/);
  });
});

describe("studio status and telemetry endpoints", () => {
  it("serves GET /api/v1/status with storage driver information", async () => {
    const storageDriver = new MemoryStorageDriver();
    await storageDriver.init();
    const { admin } = makeAdmin({ storageDriver });

    const response = await admin.handle(
      new Request("http://127.0.0.1:3341/api/v1/status", { method: "GET" }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      status: "ok",
      service: "chainmcp-studio",
      apiVersion: 1,
      storeKind: expect.any(String),
      storage: {
        connected: true,
        driver: "memory",
      },
      contractsCount: expect.any(Number),
    });
  });

  it("serves GET /api/v1/telemetry and filters by tenant and tool", async () => {
    const storageDriver = new MemoryStorageDriver();
    await storageDriver.init();
    const ringBuffer = storageDriver.getTelemetryRingBuffer();
    await ringBuffer.push({
      id: "evt-1",
      timestamp: Date.now(),
      tenantId: "tenant-a",
      toolName: "get_user",
      durationMs: 15,
      isError: false,
    });
    await ringBuffer.push({
      id: "evt-2",
      timestamp: Date.now(),
      tenantId: "tenant-b",
      toolName: "list_orders",
      durationMs: 30,
      isError: false,
    });

    const { admin } = makeAdmin({ storageDriver });

    // Authenticated query across all tenants
    const resAll = await admin.handle(
      adminRequest("/api/v1/telemetry", "GET", { token: ADMIN_TOKEN }),
    );
    expect(resAll.status).toBe(200);
    const bodyAll = await resAll.json();
    expect(bodyAll.events).toHaveLength(2);

    // Tenant-scoped query
    const resA = await admin.handle(
      adminRequest("/api/v1/telemetry?tenant=tenant-a", "GET", {
        token: ADMIN_TOKEN,
      }),
    );
    expect(resA.status).toBe(200);
    const bodyA = await resA.json();
    expect(bodyA.events).toHaveLength(1);
    expect(bodyA.events[0].toolName).toBe("get_user");

    // Path variant: /api/v1/tenants/tenant-a/telemetry
    const resPath = await admin.handle(
      adminRequest("/api/v1/tenants/tenant-a/telemetry", "GET", {
        token: ADMIN_TOKEN,
      }),
    );
    expect(resPath.status).toBe(200);
    const bodyPath = await resPath.json();
    expect(bodyPath.events).toHaveLength(1);

    // Scoped token (tenant-b) forbidden for tenant-a
    const resForbidden = await admin.handle(
      adminRequest("/api/v1/telemetry?tenant=tenant-a", "GET", {
        token: SCOPED_TOKEN, // scoped to tenant-b only
      }),
    );
    expect(resForbidden.status).toBe(403);
  });
});

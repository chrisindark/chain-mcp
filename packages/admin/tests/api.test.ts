import { describe, expect, it } from "vitest";

import { DynamicGateway } from "@chainmcp/gateway";
import { MemoryStorageDriver } from "@chainmcp/storage";

import { DeclarativeAdmin, extractBearerToken } from "../src/index.js";
import {
  ADMIN_TOKEN,
  CONTRACT_PATH,
  FakeTransport,
  SCOPED_TOKEN,
  adminRequest,
  jsonResponse,
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

describe("tool curation and endpoint filtering", () => {
  it("inspects tools, toggles active status, and propagates to gateway revision", async () => {
    let syncedUpdate: {
      tenantId: string;
      contractName: string;
      toolName: string;
      enabled: boolean;
    } | null = null;

    const { admin, gateway, audit } = makeAdmin({
      onConfigSync: async (update) => {
        syncedUpdate = update;
      },
    });

    // 1. Publish contract with two tools
    const desc1 = makeDescriptor({ name: "get_user" });
    const desc2 = makeDescriptor({
      name: "list_users",
      request: {
        method: "GET",
        path: "/users",
        parameters: [{ name: "limit", in: "query" }],
      },
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 100 },
        },
      },
    });
    const pubRes = await admin.handle(
      adminRequest(`${CONTRACT_PATH}/publish`, "POST", {
        body: { descriptors: [desc1, desc2] },
      }),
    );
    expect(pubRes.status).toBe(201);

    const testCtx = {
      tenantId: "tenant-a",
      requestId: "req-curate",
      principal: { id: "c1", scopes: ["users:read"] },
    };

    // Initial gateway verification: both tools callable
    const toolsInitial = await gateway.listTools(testCtx);
    expect(toolsInitial.map((t) => t.name).sort()).toEqual([
      "get_user",
      "list_users",
    ]);

    // 2. GET tools list returns inputSchema and enabled: true
    const listRes = await admin.handle(
      adminRequest(`${CONTRACT_PATH}/tools`, "GET"),
    );
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json();
    expect(listBody.tools).toHaveLength(2);
    expect(listBody.tools[0]).toMatchObject({
      name: "get_user",
      enabled: true,
      inputSchema: expect.any(Object),
    });

    // 3. GET single tool
    const singleRes = await admin.handle(
      adminRequest(`${CONTRACT_PATH}/tools/get_user`, "GET"),
    );
    expect(singleRes.status).toBe(200);
    const singleBody = await singleRes.json();
    expect(singleBody.tool.name).toBe("get_user");
    expect(singleBody.tool.enabled).toBe(true);

    // 4. PATCH disable tool
    const patchRes = await admin.handle(
      adminRequest(`${CONTRACT_PATH}/tools/get_user`, "PATCH", {
        body: { enabled: false },
      }),
    );
    expect(patchRes.status).toBe(200);
    const patchBody = await patchRes.json();
    expect(patchBody.ok).toBe(true);
    expect(patchBody.toolName).toBe("get_user");
    expect(patchBody.enabled).toBe(false);

    // Verify onConfigSync was called
    expect(syncedUpdate).toEqual({
      tenantId: "tenant-a",
      contractName: "users",
      toolName: "get_user",
      enabled: false,
    });

    // Verify audit event
    const curateEvents = audit.filter((e) => e.type === "admin_curate");
    expect(curateEvents.length).toBeGreaterThan(0);
    expect(curateEvents[curateEvents.length - 1]).toMatchObject({
      toolName: "get_user",
      enabled: false,
    });

    // 5. Verify gateway tools list: get_user is EXCLUDED
    const toolsAfterDisable = await gateway.listTools(testCtx);
    expect(toolsAfterDisable.map((t) => t.name)).toEqual(["list_users"]);

    // Calling the disabled tool directly fails with TOOL_NOT_FOUND
    await expect(
      gateway.callTool("get_user", { userId: "u1" }, testCtx),
    ).rejects.toThrowError(/not found/i);

    // 6. PATCH re-enable tool
    const reEnableRes = await admin.handle(
      adminRequest(`${CONTRACT_PATH}/tools/get_user`, "PATCH", {
        body: { enabled: true },
      }),
    );
    expect(reEnableRes.status).toBe(200);

    const toolsAfterReEnable = await gateway.listTools(testCtx);
    expect(toolsAfterReEnable.map((t) => t.name).sort()).toEqual([
      "get_user",
      "list_users",
    ]);

    // 7. Batch curate via POST .../curate
    const batchRes = await admin.handle(
      adminRequest(`${CONTRACT_PATH}/curate`, "POST", {
        body: { tools: { list_users: false } },
      }),
    );
    expect(batchRes.status).toBe(200);
    const toolsAfterBatch = await gateway.listTools(testCtx);
    expect(toolsAfterBatch.map((t) => t.name)).toEqual(["get_user"]);
  });

  it("handles negative curation cases and security boundaries", async () => {
    const { admin } = makeAdmin();
    const desc = makeDescriptor({ name: "get_user" });
    await admin.handle(
      adminRequest(`${CONTRACT_PATH}/publish`, "POST", {
        body: { descriptors: [desc] },
      }),
    );

    // 1. Unknown tool 404
    const unknownRes = await admin.handle(
      adminRequest(`${CONTRACT_PATH}/tools/non_existent_tool`, "PATCH", {
        body: { enabled: false },
      }),
    );
    expect(unknownRes.status).toBe(404);
    expect(await unknownRes.json()).toMatchObject({
      error: { code: "ADMIN_TOOL_NOT_FOUND" },
    });

    // 2. Invalid body 400
    const invalidBodyRes = await admin.handle(
      adminRequest(`${CONTRACT_PATH}/tools/get_user`, "PATCH", {
        body: { enabled: "not-a-boolean" },
      }),
    );
    expect(invalidBodyRes.status).toBe(400);
    expect(await invalidBodyRes.json()).toMatchObject({
      error: { code: "ADMIN_REQUEST_INVALID" },
    });

    // 3. Disabling all tools 400
    const disableAllRes = await admin.handle(
      adminRequest(`${CONTRACT_PATH}/tools/get_user`, "PATCH", {
        body: { enabled: false },
      }),
    );
    expect(disableAllRes.status).toBe(400);
    expect(await disableAllRes.json()).toMatchObject({
      error: {
        code: "ADMIN_REQUEST_INVALID",
        message: expect.stringContaining("Cannot disable all tools"),
      },
    });

    // 4. Tenant forbidden 403
    const forbiddenRes = await admin.handle(
      adminRequest(`${CONTRACT_PATH}/tools/get_user`, "PATCH", {
        token: SCOPED_TOKEN, // authorized for tenant-b, contract is tenant-a
        body: { enabled: false },
      }),
    );
    expect(forbiddenRes.status).toBe(403);
    expect(await forbiddenRes.json()).toMatchObject({
      error: { code: "ADMIN_TENANT_FORBIDDEN" },
    });
  });

  describe("M13-3: interactive projection playground and test-firing", () => {
    const mockCredentialProvider = {
      resolveCredential: async () => ({
        type: "apiKey" as const,
        name: "X-API-Key",
        location: "header" as const,
        value: "test-secret-key",
      }),
    };

    it("test-fires a tool, applies projection, and calculates token savings", async () => {
      const transport = new FakeTransport();
      const rawData = {
        id: "u123",
        username: "alice",
        email: "alice@example.com",
        secretHash: "sensitive-password-hash-never-send-to-llm",
        preferences: {
          theme: "dark",
          notifications: { email: true, sms: false, push: true },
        },
        roles: ["admin", "editor"],
      };
      transport.responder = () => jsonResponse(rawData);

      const binding = makeBinding({
        credentialProvider: mockCredentialProvider,
      });
      const { admin, audit } = makeAdmin({ transport, contracts: [binding] });

      const desc = makeDescriptor({
        name: "get_user",
        request: {
          method: "GET",
          path: "/users/{userId}",
          parameters: [{ name: "userId", in: "path", required: true }],
        },
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["userId"],
          properties: {
            userId: { type: "string" },
          },
        },
      });

      const pubRes = await admin.handle(
        adminRequest(`${CONTRACT_PATH}/publish`, "POST", {
          body: { descriptors: [desc] },
        }),
      );
      expect(pubRes.status).toBe(201);

      // 1. Test fire without projection: returns full raw response as projected, zero saved tokens
      const testResNoProj = await admin.handle(
        adminRequest(`${CONTRACT_PATH}/tools/get_user/test`, "POST", {
          body: {
            arguments: { userId: "u123" },
          },
        }),
      );
      expect(testResNoProj.status).toBe(200);
      const jsonNoProj = await testResNoProj.json();
      expect(jsonNoProj.ok).toBe(true);
      expect(jsonNoProj.toolName).toBe("get_user");
      expect(jsonNoProj.executionTimeMs).toBeGreaterThanOrEqual(0);
      expect(jsonNoProj.raw).toEqual(rawData);
      expect(jsonNoProj.projected).toEqual(rawData);
      expect(jsonNoProj.metrics.rawTokens).toBeGreaterThan(0);
      expect(jsonNoProj.metrics.projectedTokens).toBe(
        jsonNoProj.metrics.rawTokens,
      );
      expect(jsonNoProj.metrics.savedTokens).toBe(0);
      expect(jsonNoProj.metrics.percentSavings).toBe(0);

      // 2. Test fire with `include` projection: prunes unselected properties and saves tokens
      const testResInclude = await admin.handle(
        adminRequest(`${CONTRACT_PATH}/tools/get_user/test`, "POST", {
          body: {
            arguments: { userId: "u123" },
            projection: { include: ["id", "username"] },
          },
        }),
      );
      expect(testResInclude.status).toBe(200);
      const jsonInclude = await testResInclude.json();
      expect(jsonInclude.ok).toBe(true);
      expect(jsonInclude.raw).toEqual(rawData);
      expect(jsonInclude.projected).toEqual({ id: "u123", username: "alice" });
      expect(jsonInclude.metrics.rawTokens).toBeGreaterThan(0);
      expect(jsonInclude.metrics.projectedTokens).toBeLessThan(
        jsonInclude.metrics.rawTokens,
      );
      expect(jsonInclude.metrics.savedTokens).toBe(
        jsonInclude.metrics.rawTokens - jsonInclude.metrics.projectedTokens,
      );
      expect(jsonInclude.metrics.savedTokens).toBeGreaterThan(0);
      expect(jsonInclude.metrics.percentSavings).toBeGreaterThan(0);

      // 3. Test fire with `exclude` projection: removes secretHash
      const testResExclude = await admin.handle(
        adminRequest(`${CONTRACT_PATH}/tools/get_user/test`, "POST", {
          body: {
            arguments: { userId: "u123" },
            projection: { exclude: ["secretHash"] },
          },
        }),
      );
      expect(testResExclude.status).toBe(200);
      const jsonExclude = await testResExclude.json();
      expect(jsonExclude.ok).toBe(true);
      expect(jsonExclude.projected.secretHash).toBeUndefined();
      expect(jsonExclude.projected.id).toBe("u123");
      expect(jsonExclude.metrics.savedTokens).toBeGreaterThan(0);

      // 4. Verify audit event was logged without credentials
      const testEvents = audit.filter((e) => e.type === "admin_test_tool");
      expect(testEvents.length).toBeGreaterThanOrEqual(3);
      for (const ev of testEvents) {
        expect(ev.contractName).toBe("users");
        expect(ev.toolName).toBe("get_user");
        expect(JSON.stringify(ev)).not.toContain("sensitive-password-hash");
      }
    });

    it("applies descriptor policy outputFields when request projection is omitted", async () => {
      const transport = new FakeTransport();
      const rawData = {
        id: "u99",
        name: "Bob",
        extraDetails: "large text string...",
      };
      transport.responder = () => jsonResponse(rawData);

      const binding = makeBinding({
        credentialProvider: mockCredentialProvider,
      });
      const { admin } = makeAdmin({ transport, contracts: [binding] });

      const desc = makeDescriptor({
        name: "get_user",
        policy: {
          outputFields: { include: ["id", "name"] },
        },
      });

      await admin.handle(
        adminRequest(`${CONTRACT_PATH}/publish`, "POST", {
          body: { descriptors: [desc] },
        }),
      );

      const testRes = await admin.handle(
        adminRequest(`${CONTRACT_PATH}/tools/get_user/test`, "POST", {
          body: { arguments: { userId: "u99" } },
        }),
      );
      expect(testRes.status).toBe(200);
      const json = await testRes.json();
      expect(json.ok).toBe(true);
      expect(json.raw).toEqual(rawData);
      expect(json.projected).toEqual({ id: "u99", name: "Bob" });
      expect(json.metrics.savedTokens).toBeGreaterThan(0);
    });

    it("handles negative cases: unknown tool, forbidden tenant, invalid projection, and upstream failure", async () => {
      const transport = new FakeTransport();
      const binding = makeBinding({
        credentialProvider: mockCredentialProvider,
      });
      const { admin } = makeAdmin({ transport, contracts: [binding] });
      const desc = makeDescriptor({ name: "get_user" });

      await admin.handle(
        adminRequest(`${CONTRACT_PATH}/publish`, "POST", {
          body: { descriptors: [desc] },
        }),
      );

      // 1. Unknown tool -> 404
      const unknownRes = await admin.handle(
        adminRequest(`${CONTRACT_PATH}/tools/ghost_tool/test`, "POST", {
          body: {},
        }),
      );
      expect(unknownRes.status).toBe(404);
      expect(await unknownRes.json()).toMatchObject({
        error: { code: "ADMIN_TOOL_NOT_FOUND" },
      });

      // 2. Forbidden tenant -> 403
      const forbiddenRes = await admin.handle(
        adminRequest(`${CONTRACT_PATH}/tools/get_user/test`, "POST", {
          token: SCOPED_TOKEN, // for tenant-b, contract is tenant-a
          body: {},
        }),
      );
      expect(forbiddenRes.status).toBe(403);
      expect(await forbiddenRes.json()).toMatchObject({
        error: { code: "ADMIN_TENANT_FORBIDDEN" },
      });

      // 3. Invalid projection syntax -> 400
      const invalidProjRes = await admin.handle(
        adminRequest(`${CONTRACT_PATH}/tools/get_user/test`, "POST", {
          body: {
            projection: { include: "not-an-array" },
          },
        }),
      );
      expect(invalidProjRes.status).toBe(400);
      expect(await invalidProjRes.json()).toMatchObject({
        error: { code: "ADMIN_REQUEST_INVALID" },
      });

      // 4. Upstream failure -> 400 ok: false
      transport.responder = () => {
        throw new Error("Connection refused by upstream host");
      };
      const failRes = await admin.handle(
        adminRequest(`${CONTRACT_PATH}/tools/get_user/test`, "POST", {
          body: { arguments: { userId: "u1" } },
        }),
      );
      expect(failRes.status).toBe(400);
      const failJson = await failRes.json();
      expect(failJson.ok).toBe(false);
      expect(failJson.toolName).toBe("get_user");
      expect(failJson.error.message).toContain("Upstream request failed");
    });
  });
});

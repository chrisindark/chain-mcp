import { randomUUID } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { createFieldProjector, type ToolContext } from "@chainmcp/core";
import { parseDeclarativeToolDescriptor } from "@chainmcp/declarative";
import type {
  HostResolver,
  UpstreamTransport,
  UpstreamTransportRequest,
  UpstreamTransportResponse,
} from "@chainmcp/executor";
import { DynamicGateway } from "@chainmcp/gateway";
import { afterEach, describe, expect, it } from "vitest";

import {
  DeclarativeAdmin,
  DescriptorStoreError,
  FileDescriptorRevisionStore,
  InMemoryDescriptorRevisionStore,
  type DeclarativeAdminAuditEvent,
  type DeclarativeAdminContractBinding,
  type DescriptorRevisionStore,
  type StoredDescriptorRevision,
} from "../src/index.js";
import {
  ADMIN_TOKEN,
  CONTRACT_PATH,
  adminRequest,
  authSchemes,
  makeAdmin,
  makeBinding,
  makeDescriptor,
} from "./fixtures.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const UPSTREAM_SECRET = "upstream-api-key-secret-value-0123456789";
const resolveHost: HostResolver = async () => ["8.8.8.8"];

class FakeTransport implements UpstreamTransport {
  readonly requests: UpstreamTransportRequest[] = [];

  async request(
    request: UpstreamTransportRequest,
  ): Promise<UpstreamTransportResponse> {
    this.requests.push(request);
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: new TextEncoder().encode(
        JSON.stringify({ id: "u1", name: "Ada", email: "ada@example.com" }),
      ),
    };
  }
}

const credentialProvider = {
  resolveCredential: async () => ({
    type: "apiKey" as const,
    name: "X-API-Key",
    location: "header" as const,
    value: UPSTREAM_SECRET,
  }),
};

function callerContext(scopes: readonly string[]): ToolContext {
  return {
    requestId: `req-${scopes.join("-") || "anon"}`,
    tenantId: "tenant-a",
    principal: { id: "user-1", scopes },
  };
}

function adminFor(
  gateway: DynamicGateway,
  store: DescriptorRevisionStore,
  transport: UpstreamTransport,
): DeclarativeAdmin {
  return new DeclarativeAdmin({
    gateway,
    transport,
    resolveHost,
    tokens: [{ id: "operator", token: ADMIN_TOKEN, tenants: "*" }],
    contracts: [makeBinding({ credentialProvider })],
    repository: store,
  });
}

function gatewayFor(transport: UpstreamTransport): DynamicGateway {
  return new DynamicGateway({
    transport,
    resolveHost,
    projector: createFieldProjector(),
  });
}

async function temporaryStorePath(): Promise<string> {
  const directory = join(tmpdir(), `chainmcp-admin-${randomUUID()}`);
  temporaryDirectories.push(directory);
  await mkdir(directory, { recursive: true });
  return join(directory, "revisions.json");
}

interface PublishedBody {
  revisionId: string;
  gatewayRevisionId: string;
  status: string;
  rollbackOf?: string;
  toolCount: number;
}

async function publish(
  admin: DeclarativeAdmin,
  descriptor: Record<string, unknown>,
): Promise<{ status: number; body: PublishedBody }> {
  const response = await admin.handle(
    adminRequest(`${CONTRACT_PATH}/publish`, "POST", {
      body: { descriptors: [descriptor] },
    }),
  );
  return {
    status: response.status,
    body: (await response.json()) as PublishedBody,
  };
}

async function revisionStatuses(
  admin: DeclarativeAdmin,
): Promise<{ revisionId: string; status: string; rollbackOf?: string }[]> {
  const response = await admin.handle(
    adminRequest(`${CONTRACT_PATH}/revisions`),
  );
  const body = (await response.json()) as {
    revisions: { revisionId: string; status: string; rollbackOf?: string }[];
  };
  return body.revisions;
}

describe("descriptor revision history and rollback", () => {
  it("supersedes previous revisions and rolls back by republishing", async () => {
    const { admin, gateway } = makeAdmin();

    const first = await publish(
      admin,
      makeDescriptor({ description: "first" }),
    );
    const second = await publish(
      admin,
      makeDescriptor({ description: "second" }),
    );
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.revisionId).not.toBe(first.body.revisionId);

    expect(
      (await revisionStatuses(admin)).map((entry) => entry.status),
    ).toEqual(["superseded", "active"]);
    expect(
      gateway.getRegistry().getActiveRevision("tenant-a", "users")?.tools[0]
        ?.description,
    ).toBe("second");

    const rollback = await admin.handle(
      adminRequest(`${CONTRACT_PATH}/rollback`, "POST", {
        body: { revisionId: first.body.revisionId },
      }),
    );
    expect(rollback.status).toBe(201);
    const rollbackBody = (await rollback.json()) as PublishedBody;
    expect(rollbackBody.rollbackOf).toBe(first.body.revisionId);
    expect(rollbackBody.revisionId).not.toBe(first.body.revisionId);
    expect(
      gateway.getRegistry().getActiveRevision("tenant-a", "users")?.tools[0]
        ?.description,
    ).toBe("first");

    const history = await revisionStatuses(admin);
    expect(history).toHaveLength(3);
    expect(history.map((entry) => entry.status)).toEqual([
      "superseded",
      "superseded",
      "active",
    ]);
    expect(history[2]?.rollbackOf).toBe(first.body.revisionId);
  });

  it("rejects rollback of active, missing, and malformed revisions", async () => {
    const { admin } = makeAdmin();
    const published = await publish(admin, makeDescriptor());

    const active = await admin.handle(
      adminRequest(`${CONTRACT_PATH}/rollback`, "POST", {
        body: { revisionId: published.body.revisionId },
      }),
    );
    expect(active.status).toBe(409);
    expect(await active.json()).toMatchObject({
      error: { code: "ADMIN_REVISION_CONFLICT" },
    });

    const missing = await admin.handle(
      adminRequest(`${CONTRACT_PATH}/rollback`, "POST", {
        body: { revisionId: `dset_${"0".repeat(16)}` },
      }),
    );
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({
      error: { code: "ADMIN_REVISION_UNKNOWN" },
    });

    const malformed = await admin.handle(
      adminRequest(`${CONTRACT_PATH}/rollback`, "POST", { body: {} }),
    );
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({
      error: { code: "ADMIN_REQUEST_INVALID" },
    });
  });

  it("marks a candidate failed when the gateway rejects publication", async () => {
    const { admin, gateway } = makeAdmin();
    await publish(admin, makeDescriptor());

    await gateway.publishContract({
      tenantId: "tenant-a",
      contractName: "other",
      tools: [
        {
          name: "list_users",
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

    const conflictResponse = await admin.handle(
      adminRequest(`${CONTRACT_PATH}/publish`, "POST", {
        body: {
          descriptors: [
            makeDescriptor({ description: "v2" }),
            makeDescriptor({
              name: "list_users",
              description: "collides with the other contract",
              request: { method: "GET", path: "/users", parameters: [] },
              inputSchema: {
                type: "object",
                additionalProperties: false,
                properties: {},
              },
            }),
          ],
        },
      }),
    );
    const conflict = {
      status: conflictResponse.status,
      body: (await conflictResponse.json()) as PublishedBody,
    };
    expect(conflict.status).toBe(409);

    expect(
      (await revisionStatuses(admin)).map((entry) => entry.status),
    ).toEqual(["active", "failed"]);
  });

  it("keeps tenants isolated inside the store", async () => {
    const store = new InMemoryDescriptorRevisionStore();
    const { admin } = makeAdmin({ repository: store });
    const published = await publish(admin, makeDescriptor());

    expect(
      await store.getRevision("tenant-b", "users", published.body.revisionId),
    ).toBeUndefined();
    expect(await store.listRevisions("tenant-b", "users")).toEqual([]);
    await expect(
      store.activateRevision(
        "tenant-b",
        "users",
        published.body.revisionId,
        "rev_other",
      ),
    ).rejects.toMatchObject({ code: "STORE_NOT_FOUND" });
  });

  it("does not touch the gateway when the store rejects the candidate", async () => {
    const memory = new InMemoryDescriptorRevisionStore();
    const failing: DescriptorRevisionStore = {
      kind: "failing",
      listRevisions: (tenantId, contractName) =>
        memory.listRevisions(tenantId, contractName),
      getRevision: (tenantId, contractName, revisionId) =>
        memory.getRevision(tenantId, contractName, revisionId),
      getActive: (tenantId, contractName) =>
        memory.getActive(tenantId, contractName),
      createRevision: async () => {
        throw new DescriptorStoreError("STORE_LIMIT_EXCEEDED", "limit");
      },
      activateRevision: (tenantId, contractName, revisionId, gatewayId) =>
        memory.activateRevision(tenantId, contractName, revisionId, gatewayId),
      recordGatewayRevision: (tenantId, contractName, revisionId, gatewayId) =>
        memory.recordGatewayRevision(
          tenantId,
          contractName,
          revisionId,
          gatewayId,
        ),
      failRevision: (tenantId, contractName, revisionId) =>
        memory.failRevision(tenantId, contractName, revisionId),
    };

    const { admin, gateway } = makeAdmin({ repository: failing });
    const response = await publish(admin, makeDescriptor());

    expect(response.status).toBe(409);
    expect(
      gateway.getRegistry().getActiveRevision("tenant-a", "users"),
    ).toBeUndefined();
  });
});

describe("file-backed descriptor store", () => {
  it("persists revisions and restores them after a restart", async () => {
    const path = await temporaryStorePath();
    const first = await FileDescriptorRevisionStore.open({ path });
    const firstAdmin = makeAdmin({ repository: first });
    await publish(firstAdmin.admin, makeDescriptor({ description: "first" }));
    const secondPublish = await publish(
      firstAdmin.admin,
      makeDescriptor({ description: "second" }),
    );

    const info = await stat(path);
    expect(info.mode & 0o777).toBe(0o600);

    const reopened = await FileDescriptorRevisionStore.open({ path });
    const gateway = new DynamicGateway();
    const audit: DeclarativeAdminAuditEvent[] = [];
    const contracts: DeclarativeAdminContractBinding[] = [makeBinding()];
    const admin = new DeclarativeAdmin({
      gateway,
      tokens: [{ id: "operator", token: ADMIN_TOKEN, tenants: "*" }],
      contracts,
      repository: reopened,
      auditSink: (event) => {
        audit.push(event);
      },
    });

    expect(
      gateway.getRegistry().getActiveRevision("tenant-a", "users"),
    ).toBeUndefined();

    const restore = await admin.restore();
    expect(restore).toMatchObject({
      restored: [
        {
          tenantId: "tenant-a",
          contractName: "users",
          revisionId: secondPublish.body.revisionId,
          gatewayRevisionId: expect.stringMatching(/^rev_/),
        },
      ],
      skipped: [],
      failures: [],
    });
    expect(
      gateway.getRegistry().getActiveRevision("tenant-a", "users")?.tools,
    ).toHaveLength(1);
    expect(
      audit.filter((event) => event.type === "admin_restore"),
    ).toHaveLength(1);

    const secondRestore = await admin.restore();
    expect(secondRestore.restored).toEqual([]);
    expect(secondRestore.skipped).toEqual([
      {
        tenantId: "tenant-a",
        contractName: "users",
        revisionId: secondPublish.body.revisionId,
        reason: "already_active",
      },
    ]);
  });

  it("writes human-readable, versioned snapshots", async () => {
    const path = await temporaryStorePath();
    const store = await FileDescriptorRevisionStore.open({ path });
    const { admin } = makeAdmin({ repository: store });
    await publish(admin, makeDescriptor());

    const snapshot = JSON.parse(await readFile(path, "utf8")) as {
      storeVersion: number;
      revisions: StoredDescriptorRevision[];
    };
    expect(snapshot.storeVersion).toBe(1);
    expect(snapshot.revisions).toHaveLength(1);
    expect(snapshot.revisions[0]).toMatchObject({
      tenantId: "tenant-a",
      contractName: "users",
      status: "active",
    });
  });

  it("rejects corrupt and oversized snapshots", async () => {
    const corruptPath = await temporaryStorePath();
    await writeFile(corruptPath, "{ not json", "utf8");
    await expect(
      FileDescriptorRevisionStore.open({ path: corruptPath }),
    ).rejects.toMatchObject({ code: "STORE_CORRUPT" });

    const wrongShapePath = await temporaryStorePath();
    await writeFile(wrongShapePath, JSON.stringify({ revisions: [] }), "utf8");
    await expect(
      FileDescriptorRevisionStore.open({ path: wrongShapePath }),
    ).rejects.toMatchObject({ code: "STORE_CORRUPT" });

    const oversizedPath = await temporaryStorePath();
    await writeFile(oversizedPath, "x".repeat(2_048), "utf8");
    await expect(
      FileDescriptorRevisionStore.open({
        path: oversizedPath,
        maxBytes: 1_024,
      }),
    ).rejects.toMatchObject({ code: "STORE_TOO_LARGE" });
  });

  it("keeps the previous snapshot intact when a write fails", async () => {
    const path = await temporaryStorePath();
    const first = await FileDescriptorRevisionStore.open({ path });
    const firstAdmin = makeAdmin({ repository: first });
    const firstPublish = await publish(
      firstAdmin.admin,
      makeDescriptor({ description: "pad ".repeat(512) }),
    );
    expect(firstPublish.status).toBe(201);

    const before = await readFile(path, "utf8");
    const sizeBefore = Buffer.byteLength(before, "utf8");
    expect(sizeBefore).toBeGreaterThanOrEqual(1_024);

    // Reopen with the exact current size as the cap: any growth fails to
    // write, before the gateway is ever called.
    const capped = await FileDescriptorRevisionStore.open({
      path,
      maxBytes: sizeBefore,
    });
    const cappedAdmin = makeAdmin({ repository: capped });
    const rejected = await publish(
      cappedAdmin.admin,
      makeDescriptor({ description: "second" }),
    );
    expect(rejected.status).toBe(413);
    expect(rejected.body).toMatchObject({
      error: { code: "ADMIN_STORE_FAILURE" },
    });

    // Disk and memory both stay at the previous consistent snapshot, the
    // gateway is untouched, and no temporary file is left behind.
    expect(await readFile(path, "utf8")).toBe(before);
    expect(
      (await revisionStatuses(cappedAdmin.admin)).map((entry) => entry.status),
    ).toEqual(["active"]);
    expect(
      cappedAdmin.gateway.getRegistry().getActiveRevision("tenant-a", "users"),
    ).toBeUndefined();
    expect(await readdir(dirname(path))).toEqual(["revisions.json"]);

    // The store remains usable: a fresh open with a normal cap publishes.
    const reopened = await FileDescriptorRevisionStore.open({ path });
    const recoveredAdmin = makeAdmin({ repository: reopened });
    const recovered = await publish(
      recoveredAdmin.admin,
      makeDescriptor({ description: "after failure" }),
    );
    expect(recovered.status).toBe(201);
    expect(
      (await revisionStatuses(recoveredAdmin.admin)).map(
        (entry) => entry.status,
      ),
    ).toEqual(["superseded", "active"]);
  });

  it("serializes concurrent writes into one complete snapshot", async () => {
    const path = await temporaryStorePath();
    const store = await FileDescriptorRevisionStore.open({ path });
    const records: StoredDescriptorRevision[] = [1, 2, 3, 4, 5].map(
      (index) => ({
        revisionId: `dset_${index.toString(16).padStart(16, "0")}`,
        tenantId: "tenant-a",
        contractName: "users",
        createdAt: 1_700_000_000_000 + index,
        status: "candidate",
        toolsetHash: "a".repeat(64),
        descriptors: [
          parseDeclarativeToolDescriptor(
            makeDescriptor({ name: `tool_${index}` }),
            { authSchemes },
          ).descriptor,
        ],
        toolRevisions: [{ name: `tool_${index}`, revision: `sha256:${index}` }],
      }),
    );

    await Promise.all(records.map((record) => store.createRevision(record)));

    // The file holds exactly one complete snapshot: no torn JSON, no
    // leftover temporary files from the interleaved writes.
    const snapshot = JSON.parse(await readFile(path, "utf8")) as {
      storeVersion: number;
      revisions: StoredDescriptorRevision[];
    };
    expect(snapshot.storeVersion).toBe(1);
    expect(snapshot.revisions).toHaveLength(5);
    expect(await readdir(dirname(path))).toEqual(["revisions.json"]);

    const reopened = await FileDescriptorRevisionStore.open({ path });
    const restored = await reopened.listRevisions("tenant-a", "users");
    expect(restored).toHaveLength(5);
    expect(new Set(restored.map((record) => record.status))).toEqual(
      new Set(["candidate"]),
    );
  });
});

describe("restore across a gateway rebuild", () => {
  it("serves the rolled-back revision end to end after restart", async () => {
    const path = await temporaryStorePath();

    // --- Process 1: publish twice, then roll back to the first revision.
    const publishTransport = new FakeTransport();
    const publishAdmin = adminFor(
      gatewayFor(publishTransport),
      await FileDescriptorRevisionStore.open({ path }),
      publishTransport,
    );
    const first = await publish(
      publishAdmin,
      makeDescriptor({ description: "first" }),
    );
    const second = await publish(
      publishAdmin,
      makeDescriptor({ description: "second" }),
    );
    const rollback = await publishAdmin.handle(
      adminRequest(`${CONTRACT_PATH}/rollback`, "POST", {
        body: { revisionId: first.body.revisionId },
      }),
    );
    expect(rollback.status).toBe(201);
    const rollbackBody = (await rollback.json()) as PublishedBody;
    expect(rollbackBody.rollbackOf).toBe(first.body.revisionId);

    // --- Process 2: new gateway, new admin, same file store.
    const restartedTransport = new FakeTransport();
    const gateway = gatewayFor(restartedTransport);
    const admin = adminFor(
      gateway,
      await FileDescriptorRevisionStore.open({ path }),
      restartedTransport,
    );
    expect(
      gateway.getRegistry().getActiveRevision("tenant-a", "users"),
    ).toBeUndefined();

    const restore = await admin.restore();
    expect(restore.failures).toEqual([]);
    expect(restore.skipped).toEqual([]);
    expect(restore.restored).toHaveLength(1);
    expect(restore.restored[0]?.revisionId).not.toBe(second.body.revisionId);
    expect(restore.restored[0]).toMatchObject({
      tenantId: "tenant-a",
      contractName: "users",
      revisionId: rollbackBody.revisionId,
      gatewayRevisionId: expect.stringMatching(/^rev_/),
    });

    // The restored contract is fully functional, not merely registered:
    // authorization still runs first, then the request is built, the
    // credential injected, and the response served.
    await expect(
      gateway.callTool("get_user", { userId: "42" }, callerContext([])),
    ).rejects.toMatchObject({ code: "AUTH_FORBIDDEN" });
    expect(restartedTransport.requests).toHaveLength(0);

    // Restored descriptors are the rollback target's, not the superseded one.
    expect(
      gateway.getRegistry().getActiveRevision("tenant-a", "users")?.tools[0]
        ?.description,
    ).toBe("first");

    const result = await gateway.callTool(
      "get_user",
      { userId: "42", limit: 5 },
      callerContext(["users:read"]),
    );
    expect(result).toEqual({
      id: "u1",
      name: "Ada",
      email: "ada@example.com",
    });

    const request = restartedTransport.requests[0];
    expect(request?.url.origin).toBe("https://api.example.com");
    expect(request?.url.pathname).toBe("/users/42");
    expect(request?.url.searchParams.get("limit")).toBe("5");
    const apiKey = Object.entries(request?.headers ?? {}).find(
      ([name]) => name.toLowerCase() === "x-api-key",
    );
    expect(apiKey?.[1]).toBe(UPSTREAM_SECRET);

    // The gateway revision id was written back to the active store record, so
    // a second restart can detect that the contract is already active.
    const reopened = await FileDescriptorRevisionStore.open({ path });
    expect(await reopened.getActive("tenant-a", "users")).toMatchObject({
      revisionId: rollbackBody.revisionId,
      status: "active",
      gatewayRevisionId: restore.restored[0]?.gatewayRevisionId,
    });
  });

  it("reports nothing to restore when the store holds no active revision", async () => {
    const path = await temporaryStorePath();
    const transport = new FakeTransport();
    const gateway = gatewayFor(transport);
    const admin = adminFor(
      gateway,
      await FileDescriptorRevisionStore.open({ path }),
      transport,
    );

    expect(await admin.restore()).toEqual({
      restored: [],
      skipped: [],
      failures: [],
    });
    expect(
      gateway.getRegistry().getActiveRevision("tenant-a", "users"),
    ).toBeUndefined();
  });
});

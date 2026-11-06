import type { DeclarativeToolDescriptor } from "@chainmcp/declarative";
import { describe, expect, it } from "vitest";

import {
  createDeclarativeAdmin,
  DeclarativeAdmin,
  DescriptorStoreError,
  handleDeclarativeAdminRequest,
  InMemoryDescriptorRevisionStore,
  type DescriptorRevisionStore,
  type StoredDescriptorRevision,
  type StoredDescriptorRevisionStatus,
} from "../src/index.js";
import {
  adminRequest,
  ADMIN_TOKEN,
  CONTRACT_PATH,
  makeAdmin,
  makeBinding,
  makeDescriptor,
} from "./fixtures.js";

function descriptor(
  overrides: Record<string, unknown> = {},
): DeclarativeToolDescriptor {
  return makeDescriptor(overrides) as unknown as DeclarativeToolDescriptor;
}

function validRecord(
  overrides: Partial<StoredDescriptorRevision> = {},
): StoredDescriptorRevision {
  return {
    revisionId: "dset_0123456789abcdef",
    tenantId: "tenant-a",
    contractName: "users",
    status: "candidate",
    createdAt: Date.now(),
    toolsetHash: "a".repeat(64),
    descriptors: [descriptor()],
    toolRevisions: [{ name: "get_user", revision: "sha256:" + "0".repeat(64) }],
    gatewayRevisionId: "gw-1",
    publishedBy: "operator",
    ...overrides,
  };
}

describe("InMemoryDescriptorRevisionStore validation and edge cases", () => {
  it("validates constructor options", () => {
    expect(
      () =>
        new InMemoryDescriptorRevisionStore([], {
          maxRevisionsPerContract: 0,
        }),
    ).toThrow(TypeError);

    expect(
      () =>
        new InMemoryDescriptorRevisionStore([], {
          maxRevisionsPerContract: 10_001,
        }),
    ).toThrow(TypeError);

    expect(
      () =>
        new InMemoryDescriptorRevisionStore([], {
          maxRevisionsPerContract: 2.5,
        }),
    ).toThrow(TypeError);
  });

  it("detects corrupt initial state records", () => {
    // Duplicate revision ID
    expect(
      () => new InMemoryDescriptorRevisionStore([validRecord(), validRecord()]),
    ).toThrow(
      new DescriptorStoreError(
        "STORE_CORRUPT",
        "Descriptor store contains duplicate revision 'dset_0123456789abcdef'",
      ),
    );

    // Multiple active revisions for same contract
    expect(
      () =>
        new InMemoryDescriptorRevisionStore([
          validRecord({
            revisionId: "dset_0123456789abcdef",
            status: "active",
          }),
          validRecord({
            revisionId: "dset_fedcba9876543210",
            status: "active",
          }),
        ]),
    ).toThrow("Multiple active descriptor revisions");

    // Corrupt record fields
    const invalidRecords = [
      null,
      validRecord({ revisionId: "" }),
      validRecord({ createdAt: -1 }),
      validRecord({ status: "invalid" as StoredDescriptorRevisionStatus }),
      validRecord({ toolsetHash: "invalid-hash" }),
      validRecord({
        descriptors:
          "not an array" as unknown as StoredDescriptorRevision["descriptors"],
      }),
      validRecord({
        descriptors: ["not an object" as unknown as DeclarativeToolDescriptor],
      }),
      validRecord({
        toolRevisions:
          "not an array" as unknown as StoredDescriptorRevision["toolRevisions"],
      }),
      validRecord({ toolRevisions: [] }), // length mismatch with descriptors
      validRecord({
        descriptors: [descriptor({ name: "t1" }), descriptor({ name: "t2" })],
        toolRevisions: [
          { name: "t1", revision: "sha256:" + "0".repeat(64) },
          { name: "t1", revision: "sha256:" + "0".repeat(64) },
        ], // repeats tool name
      }),
      validRecord({ gatewayRevisionId: "" }),
      validRecord({ publishedBy: "" }),
      validRecord({ rollbackOf: "" }),
      validRecord({ tenantId: "" }),
      validRecord({ contractName: "" }),
    ];

    for (const record of invalidRecords) {
      expect(
        () =>
          new InMemoryDescriptorRevisionStore([
            record as StoredDescriptorRevision,
          ]),
      ).toThrow(DescriptorStoreError);
    }
  });

  it("enforces state machine and bounds during store operations", async () => {
    const store = new InMemoryDescriptorRevisionStore([], {
      maxRevisionsPerContract: 2,
    });

    const rev1 = "dset_0000000000000001";
    const rev2 = "dset_0000000000000002";
    const rev3 = "dset_0000000000000003";

    // Create candidate
    const r1 = validRecord({ revisionId: rev1 });
    await store.createRevision(r1);

    // Create with status other than candidate fails
    await expect(
      store.createRevision(validRecord({ revisionId: rev2, status: "active" })),
    ).rejects.toMatchObject({ code: "STORE_STATE_INVALID" });

    // Create duplicate fails
    await expect(store.createRevision(r1)).rejects.toMatchObject({
      code: "STORE_DUPLICATE",
    });

    // Second valid candidate
    const r2 = validRecord({ revisionId: rev2 });
    await store.createRevision(r2);

    // Third candidate exceeds limit
    await expect(
      store.createRevision(validRecord({ revisionId: rev3 })),
    ).rejects.toMatchObject({ code: "STORE_LIMIT_EXCEEDED" });

    // Activating unknown revision fails
    await expect(
      store.activateRevision(
        "tenant-a",
        "users",
        "dset_9999999999999999",
        "gw-rev",
      ),
    ).rejects.toMatchObject({ code: "STORE_NOT_FOUND" });

    // Activate with empty gateway revision fails
    await expect(
      store.activateRevision("tenant-a", "users", rev1, ""),
    ).rejects.toMatchObject({ code: "STORE_STATE_INVALID" });

    // Activate valid candidate
    await store.activateRevision("tenant-a", "users", rev1, "gw-rev-1");

    // Activating already active revision fails
    await expect(
      store.activateRevision("tenant-a", "users", rev1, "gw-rev-2"),
    ).rejects.toMatchObject({ code: "STORE_STATE_INVALID" });

    // Recording gateway revision for unknown revision fails
    await expect(
      store.recordGatewayRevision(
        "tenant-a",
        "users",
        "dset_9999999999999999",
        "gw-rev",
      ),
    ).rejects.toMatchObject({ code: "STORE_NOT_FOUND" });

    // Recording gateway revision on non-active revision fails
    await expect(
      store.recordGatewayRevision("tenant-a", "users", rev2, "gw-rev"),
    ).rejects.toMatchObject({ code: "STORE_STATE_INVALID" });

    // Recording gateway revision on active revision succeeds
    await expect(
      store.recordGatewayRevision("tenant-a", "users", rev1, "gw-rev-updated"),
    ).resolves.toBeUndefined();

    // Failing unknown revision fails
    await expect(
      store.failRevision("tenant-a", "users", "dset_9999999999999999"),
    ).rejects.toMatchObject({ code: "STORE_NOT_FOUND" });

    // Failing active revision fails
    await expect(
      store.failRevision("tenant-a", "users", rev1),
    ).rejects.toMatchObject({ code: "STORE_STATE_INVALID" });

    // Failing candidate revision succeeds
    await expect(
      store.failRevision("tenant-a", "users", rev2),
    ).resolves.toBeUndefined();

    // Failing already failed revision is a no-op
    await expect(
      store.failRevision("tenant-a", "users", rev2),
    ).resolves.toBeUndefined();
  });
});

describe("DeclarativeAdmin API edge cases", () => {
  it("validates constructor options and bindings", () => {
    const { gateway } = makeAdmin();

    expect(() => new DeclarativeAdmin(null as unknown as never)).toThrow(
      "DeclarativeAdmin requires an options object",
    );

    expect(
      () =>
        new DeclarativeAdmin({
          gateway: {} as never,
          tokens: [{ id: "op", token: ADMIN_TOKEN, tenants: "*" }],
          contracts: [],
        }),
    ).toThrow("DeclarativeAdmin requires a DynamicGateway");

    expect(
      () =>
        new DeclarativeAdmin({
          gateway,
          tokens: [{ id: "op", token: ADMIN_TOKEN, tenants: "*" }],
          contracts: [],
          maxRequestBytes: 10,
        }),
    ).toThrow("maxRequestBytes must be an integer");

    expect(
      () =>
        new DeclarativeAdmin({
          gateway,
          tokens: [{ id: "op", token: ADMIN_TOKEN, tenants: "*" }],
          contracts: "not an array" as unknown as [],
        }),
    ).toThrow("DeclarativeAdmin contracts must be an array");

    expect(
      () =>
        new DeclarativeAdmin({
          gateway,
          tokens: [{ id: "op", token: ADMIN_TOKEN, tenants: "*" }],
          contracts: [makeBinding({ tenantId: "tenant\x00bad" })],
        }),
    ).toThrow("Each admin contract binding requires a non-empty tenantId");

    expect(
      () =>
        new DeclarativeAdmin({
          gateway,
          tokens: [{ id: "op", token: ADMIN_TOKEN, tenants: "*" }],
          contracts: [makeBinding({ contractName: "bad name with space" })],
        }),
    ).toThrow("Admin contract name 'bad name with space' is invalid");

    expect(
      () =>
        new DeclarativeAdmin({
          gateway,
          tokens: [{ id: "op", token: ADMIN_TOKEN, tenants: "*" }],
          contracts: [
            makeBinding({
              destinationPolicy: {
                baseUrl: "",
                allowedHosts: [],
              },
            }),
          ],
        }),
    ).toThrow(
      "requires a destination policy with a baseUrl and non-empty allowedHosts",
    );

    expect(
      () =>
        new DeclarativeAdmin({
          gateway,
          tokens: [{ id: "op", token: ADMIN_TOKEN, tenants: "*" }],
          contracts: [makeBinding()],
          repository: {} as unknown as DescriptorRevisionStore,
        }),
    ).toThrow(
      "DeclarativeAdmin repository must implement the DescriptorRevisionStore interface",
    );
  });

  it("exposes storeKind and handles healthz endpoint", async () => {
    const { admin } = makeAdmin();
    expect(admin.storeKind).toBe("memory");

    const response = await admin.handle(
      new Request("http://127.0.0.1:3341/api/v1/healthz"),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string };
    expect(body.status).toBe("ok");
  });

  it("serves static UI assets and returns 404 for unknown asset", async () => {
    const { admin } = makeAdmin();

    const jsRes = await admin.handle(
      new Request("http://127.0.0.1:3341/ui/app.js"),
    );
    expect(jsRes.status).toBe(200);
    expect(jsRes.headers.get("content-type")).toContain("text/javascript");

    const cssRes = await admin.handle(
      new Request("http://127.0.0.1:3341/ui/app.css"),
    );
    expect(cssRes.status).toBe(200);
    expect(cssRes.headers.get("content-type")).toContain("text/css");

    const unknownRes = await admin.handle(
      new Request("http://127.0.0.1:3341/ui/unknown.file"),
    );
    expect(unknownRes.status).toBe(404);
  });

  it("rejects invalid percent-encoding in request path", async () => {
    const { admin } = makeAdmin();
    const res = await admin.handle(
      new Request("http://127.0.0.1:3341/api/v1/%ZZ"),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ADMIN_REQUEST_INVALID");
  });

  it("validates request content length and body parsing", async () => {
    const { admin } = makeAdmin();

    // Invalid Content-Length header
    const badLengthRes = await admin.handle(
      new Request(`http://127.0.0.1:3341${CONTRACT_PATH}/validate`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${ADMIN_TOKEN}`,
          "content-type": "application/json",
          "content-length": "not-a-number",
        },
        body: JSON.stringify({ descriptors: [makeDescriptor()] }),
      }),
    );
    expect(badLengthRes.status).toBe(400);

    // Non-JSON body
    const badJsonRes = await admin.handle(
      new Request(`http://127.0.0.1:3341${CONTRACT_PATH}/validate`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${ADMIN_TOKEN}`,
          "content-type": "application/json",
        },
        body: "{ bad json",
      }),
    );
    expect(badJsonRes.status).toBe(400);

    // Non-object body
    const nonObjectRes = await admin.handle(
      new Request(`http://127.0.0.1:3341${CONTRACT_PATH}/validate`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${ADMIN_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify("string-not-object"),
      }),
    );
    expect(nonObjectRes.status).toBe(400);
  });

  it("returns 404 when querying unknown revision", async () => {
    const { admin } = makeAdmin();
    const res = await admin.handle(
      adminRequest(`${CONTRACT_PATH}/revisions/unknown-rev-id`),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ADMIN_REVISION_UNKNOWN");
  });

  it("provides createDeclarativeAdmin and handleDeclarativeAdminRequest helpers", async () => {
    const { gateway } = makeAdmin();
    const admin = createDeclarativeAdmin({
      gateway,
      tokens: [{ id: "op", token: ADMIN_TOKEN, tenants: "*" }],
      contracts: [makeBinding()],
    });
    const res = await handleDeclarativeAdminRequest(
      admin,
      new Request("http://127.0.0.1:3341/api/v1/healthz"),
    );
    expect(res.status).toBe(200);
  });
});

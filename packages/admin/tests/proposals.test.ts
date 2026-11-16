import type { DeclarativeToolDescriptor } from "@chainmcp/declarative";
import { describe, expect, it } from "vitest";

import {
  computeProposalDiffAndSavings,
  InMemoryDescriptorRevisionStore,
} from "../src/index.js";
import {
  ADMIN_TOKEN,
  adminRequest,
  makeAdmin,
  makeDescriptor,
  SCOPED_TOKEN,
} from "./fixtures.js";

const standardParams = [
  { name: "userId", in: "path", required: true },
  { name: "limit", in: "query" },
];

describe("Proposal Diff and Token Savings Computation (computeProposalDiffAndSavings)", () => {
  const baseTool: DeclarativeToolDescriptor = {
    descriptorVersion: 1,
    name: "list_users",
    description: "List users",
    request: { method: "GET", path: "/users", parameters: [] },
    inputSchema: { type: "object", additionalProperties: false },
  };

  it("identifies added and removed tools", () => {
    const active: DeclarativeToolDescriptor[] = [baseTool];
    const proposed: DeclarativeToolDescriptor[] = [
      {
        descriptorVersion: 1,
        name: "create_user",
        description: "Create user",
        request: { method: "POST", path: "/users", parameters: [] },
        inputSchema: { type: "object", additionalProperties: false },
      },
    ];

    const diff = computeProposalDiffAndSavings(active, proposed, {
      tenantId: "tenant-a",
      contractName: "users",
    });

    expect(diff.changedToolsCount).toBe(2);
    expect(diff.totalTools).toBe(2);

    const added = diff.toolDiffs.find((d) => d.toolName === "create_user");
    expect(added?.changeType).toBe("added");

    const removed = diff.toolDiffs.find((d) => d.toolName === "list_users");
    expect(removed?.changeType).toBe("removed");
    expect(removed?.estimatedTokensSavedPerCall).toBe(1000); // default per-tool tokens
  });

  it("calculates token savings when projection is added or modified", () => {
    const active: DeclarativeToolDescriptor[] = [baseTool];
    const proposed: DeclarativeToolDescriptor[] = [
      {
        ...baseTool,
        policy: {
          outputFields: { exclude: ["debugLogs", "traceId", "internalMeta"] },
        },
      },
    ];

    const diff = computeProposalDiffAndSavings(active, proposed, {
      tenantId: "tenant-a",
      contractName: "users",
    });

    expect(diff.changedToolsCount).toBe(1);
    const mod = diff.toolDiffs.find((d) => d.toolName === "list_users");
    expect(mod?.changeType).toBe("modified");
    expect(mod?.changes.projection?.after).toEqual({
      exclude: ["debugLogs", "traceId", "internalMeta"],
    });
    expect(mod?.estimatedTokensSavedPerCall).toBe(900); // 3 excluded fields * 300 tokens
    expect(diff.estimatedTotalTokensSavedPerCall).toBe(900);
  });

  it("detects caching and enablement changes", () => {
    const active: DeclarativeToolDescriptor[] = [baseTool];
    const proposed: DeclarativeToolDescriptor[] = [
      {
        ...baseTool,
        enabled: false,
        policy: {
          cacheTtlSeconds: 60,
        },
      },
    ];

    const diff = computeProposalDiffAndSavings(active, proposed, {
      tenantId: "tenant-a",
      contractName: "users",
    });

    const mod = diff.toolDiffs.find((d) => d.toolName === "list_users");
    expect(mod?.changeType).toBe("modified");
    expect(mod?.changes.enabled).toEqual({ before: true, after: false });
    expect(mod?.changes.cache?.after).toEqual({ ttlSeconds: 60 });
  });
});

describe("DescriptorRevisionStore Proposals Lifecycle", () => {
  it("stores, lists, approves, and rejects proposals cleanly", async () => {
    const store = new InMemoryDescriptorRevisionStore();
    const hash0 = "0".repeat(64);
    const hash1 = "1".repeat(64);
    const hash2 = "2".repeat(64);

    // Create candidate revision and activate it
    await store.createRevision({
      revisionId: "dset_0000000000000001",
      tenantId: "tenant-a",
      contractName: "users",
      createdAt: 1000,
      status: "candidate",
      toolsetHash: hash0,
      descriptors: [
        makeDescriptor({
          name: "tool1",
        }) as unknown as DeclarativeToolDescriptor,
      ],
      toolRevisions: [{ name: "tool1", revision: `sha256:${hash0}` }],
    });
    await store.activateRevision(
      "tenant-a",
      "users",
      "dset_0000000000000001",
      "gw-1",
    );
    const activeRev = await store.getActive("tenant-a", "users");
    expect(activeRev?.status).toBe("active");

    // Create a proposal
    await store.createRevision({
      revisionId: "dset_0000000000000002",
      tenantId: "tenant-a",
      contractName: "users",
      createdAt: 2000,
      status: "proposal",
      toolsetHash: hash1,
      descriptors: [
        makeDescriptor({
          name: "tool1",
          enabled: false,
        }) as unknown as DeclarativeToolDescriptor,
      ],
      toolRevisions: [{ name: "tool1", revision: `sha256:${hash1}` }],
      proposedBy: "agent-optimizer",
      proposalReason: "Disable slow tool1",
      estimatedTokenSavings: 300,
    });
    const prop1 = await store.getRevision(
      "tenant-a",
      "users",
      "dset_0000000000000002",
    );
    expect(prop1?.status).toBe("proposal");

    // List proposals
    const pending = await store.listProposals("tenant-a", "users");
    expect(pending).toHaveLength(1);
    expect(pending[0]?.revisionId).toBe("dset_0000000000000002");

    // Reject proposal
    const rejected = await store.rejectProposal(
      "tenant-a",
      "users",
      "dset_0000000000000002",
      "human-reviewer",
      "Not ready yet",
    );
    expect(rejected.status).toBe("rejected");
    expect(rejected.reviewedBy).toBe("human-reviewer");
    expect(rejected.reviewComment).toBe("Not ready yet");

    // Active remains active
    const curActive = await store.getActive("tenant-a", "users");
    expect(curActive?.revisionId).toBe("dset_0000000000000001");

    // Create second proposal and approve it
    await store.createRevision({
      revisionId: "dset_0000000000000003",
      tenantId: "tenant-a",
      contractName: "users",
      createdAt: 3000,
      status: "proposal",
      toolsetHash: hash2,
      descriptors: [
        makeDescriptor({
          name: "tool1",
          policy: { cacheTtlSeconds: 120 },
        }) as unknown as DeclarativeToolDescriptor,
      ],
      toolRevisions: [{ name: "tool1", revision: `sha256:${hash2}` }],
      proposedBy: "agent-optimizer",
      proposalReason: "Enable caching",
    });

    const approved = await store.approveProposal(
      "tenant-a",
      "users",
      "dset_0000000000000003",
      "gw-2",
      "senior-admin",
      "Approved for production",
    );
    expect(approved.status).toBe("active");
    expect(approved.gatewayRevisionId).toBe("gw-2");
    expect(approved.reviewedBy).toBe("senior-admin");

    // Former active revision is now superseded
    const oldActive = await store.getRevision(
      "tenant-a",
      "users",
      "dset_0000000000000001",
    );
    expect(oldActive?.status).toBe("superseded");

    // Current active is prop-2
    const nowActive = await store.getActive("tenant-a", "users");
    expect(nowActive?.revisionId).toBe("dset_0000000000000003");
  });
});

describe("DeclarativeAdmin Proposals Endpoints & Audit", () => {
  it("submits, inspects, approves proposals via REST API and verifies audit trail", async () => {
    const { admin, audit } = makeAdmin();

    // Establish active contract revision first via REST publish
    const publishRes = await admin.handle(
      adminRequest("/api/v1/tenants/tenant-a/contracts/users/publish", "POST", {
        token: ADMIN_TOKEN,
        body: {
          descriptors: [
            makeDescriptor({
              name: "get_user",
              request: {
                method: "GET",
                path: "/users/{userId}",
                parameters: standardParams,
              },
            }),
          ],
        },
      }),
    );
    expect(publishRes.status).toBe(201);

    // 1. Submit proposal via POST /api/v1/tenants/:tenant/contracts/:contract/proposals
    const propRes = await admin.handle(
      adminRequest(
        "/api/v1/tenants/tenant-a/contracts/users/proposals",
        "POST",
        {
          token: ADMIN_TOKEN,
          body: {
            proposalReason: "Add projection filter to remove debug info",
            descriptors: [
              makeDescriptor({
                name: "get_user",
                request: {
                  method: "GET",
                  path: "/users/{userId}",
                  parameters: standardParams,
                },
                policy: {
                  outputFields: { exclude: ["debug", "stackTrace"] },
                },
              }),
            ],
          },
        },
      ),
    );
    expect(propRes.status).toBe(201);
    const propBody = (await propRes.json()) as {
      summary: {
        revisionId: string;
        status: string;
        estimatedTokenSavings: number;
      };
      diff: { changedToolsCount: number };
    };
    expect(propBody.summary.status).toBe("proposal");
    expect(propBody.summary.estimatedTokenSavings).toBe(600);
    expect(propBody.diff.changedToolsCount).toBe(1);
    const revisionId = propBody.summary.revisionId;

    // Check audit event for proposal creation
    const createdEvent = audit.find((e) => e.type === "admin_proposal_created");
    expect(createdEvent).toBeDefined();
    expect(createdEvent?.revisionId).toBe(revisionId);

    // 2. List proposals via GET /api/v1/proposals
    const listRes = await admin.handle(
      adminRequest("/api/v1/proposals", "GET", { token: ADMIN_TOKEN }),
    );
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as {
      proposals: Array<{ revisionId: string; status: string }>;
    };
    expect(listBody.proposals.some((p) => p.revisionId === revisionId)).toBe(
      true,
    );

    // 3. Inspect proposal diff via GET /api/v1/tenants/:tenant/contracts/:contract/proposals/:revisionId
    const diffRes = await admin.handle(
      adminRequest(
        `/api/v1/tenants/tenant-a/contracts/users/proposals/${revisionId}`,
        "GET",
        { token: ADMIN_TOKEN },
      ),
    );
    expect(diffRes.status).toBe(200);
    const diffBody = (await diffRes.json()) as {
      proposal: { revisionId: string };
      diff: { toolDiffs: Array<{ toolName: string; changeType: string }> };
    };
    expect(diffBody.proposal.revisionId).toBe(revisionId);
    expect(diffBody.diff.toolDiffs[0]?.toolName).toBe("get_user");
    expect(diffBody.diff.toolDiffs[0]?.changeType).toBe("modified");

    // 4. Approve proposal via POST /api/v1/tenants/:tenant/contracts/:contract/proposals/:revisionId/approve
    const approveRes = await admin.handle(
      adminRequest(
        `/api/v1/tenants/tenant-a/contracts/users/proposals/${revisionId}/approve`,
        "POST",
        {
          token: ADMIN_TOKEN,
          body: { comment: "Looks great, approved!" },
        },
      ),
    );
    expect(approveRes.status).toBe(200);
    const approveBody = (await approveRes.json()) as {
      ok: boolean;
      revisionId: string;
      status: string;
      reviewedBy: string;
    };
    expect(approveBody.ok).toBe(true);
    expect(approveBody.revisionId).toBe(revisionId);
    expect(approveBody.status).toBe("active");

    // Check audit event for proposal approval
    const approvedEvent = audit.find(
      (e) => e.type === "admin_proposal_approved",
    );
    expect(approvedEvent).toBeDefined();
    expect(approvedEvent?.revisionId).toBe(revisionId);

    // 5. Tenant boundary isolation: scoped token for tenant-b cannot access tenant-a proposals
    const forbiddenRes = await admin.handle(
      adminRequest(
        `/api/v1/tenants/tenant-a/contracts/users/proposals`,
        "GET",
        { token: SCOPED_TOKEN },
      ),
    );
    expect(forbiddenRes.status).toBe(403);
  });

  it("rejects a proposal via POST .../reject and leaves active state untouched", async () => {
    const { admin, audit, gateway } = makeAdmin();

    // Baseline publish
    await admin.handle(
      adminRequest("/api/v1/tenants/tenant-a/contracts/users/publish", "POST", {
        token: ADMIN_TOKEN,
        body: {
          descriptors: [
            makeDescriptor({
              name: "get_user",
              request: {
                method: "GET",
                path: "/users/{userId}",
                parameters: standardParams,
              },
            }),
          ],
        },
      }),
    );

    const activeBefore = gateway
      .getRegistry()
      .getActiveRevision("tenant-a", "users");

    // Create proposal
    const propRes = await admin.handle(
      adminRequest(
        "/api/v1/tenants/tenant-a/contracts/users/proposals",
        "POST",
        {
          token: ADMIN_TOKEN,
          body: {
            proposalReason: "Disable get_user",
            descriptors: [
              makeDescriptor({
                name: "get_user",
                enabled: false,
                request: {
                  method: "GET",
                  path: "/users/{userId}",
                  parameters: standardParams,
                },
              }),
            ],
          },
        },
      ),
    );
    const propBody = (await propRes.json()) as {
      summary: { revisionId: string };
    };
    const revisionId = propBody.summary.revisionId;

    // Reject proposal
    const rejectRes = await admin.handle(
      adminRequest(
        `/api/v1/tenants/tenant-a/contracts/users/proposals/${revisionId}/reject`,
        "POST",
        {
          token: ADMIN_TOKEN,
          body: { reason: "Do not disable this critical endpoint" },
        },
      ),
    );
    expect(rejectRes.status).toBe(200);

    // Gateway active revision remains completely untouched
    const activeAfter = gateway
      .getRegistry()
      .getActiveRevision("tenant-a", "users");
    expect(activeAfter?.revisionId).toBe(activeBefore?.revisionId);

    // Audit check
    const rejectedEvent = audit.find(
      (e) => e.type === "admin_proposal_rejected",
    );
    expect(rejectedEvent).toBeDefined();
    expect(rejectedEvent?.revisionId).toBe(revisionId);
  });
});

import { describe, expect, it } from "vitest";
import type { ToolDefinition } from "@chainmcp/core";
import { ContractRegistry } from "../src/registry.js";
import { GatewayError } from "../src/types.js";

function dummyTool(name: string, tenantId: string): ToolDefinition {
  return {
    name,
    description: `Tool ${name}`,
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
      },
    },
    ownerTenantId: tenantId,
    operation: {},
    execute: async (input) => ({ echo: input }),
  };
}

describe("ContractRegistry", () => {
  it("creates an immutable candidate revision with validated properties", () => {
    const registry = new ContractRegistry();
    const tool = dummyTool("getPet", "tenant-1");

    const revision = registry.createRevision({
      tenantId: "tenant-1",
      contractName: "petstore",
      sourceHash: "abc123hash",
      tools: [tool],
      destinationPolicy: {
        baseUrl: "https://api.petstore.com/v1",
        allowedHosts: ["api.petstore.com"],
      },
      metadata: { env: "prod" },
    });

    expect(revision.revisionId).toMatch(/^rev_[a-f0-9]{16}$/);
    expect(revision.status).toBe("candidate");
    expect(revision.tenantId).toBe("tenant-1");
    expect(revision.contractName).toBe("petstore");
    expect(revision.sourceHash).toBe("abc123hash");
    expect(revision.tools).toHaveLength(1);
    expect(revision.tools[0]?.contractRevision).toBe(revision.revisionId);
    expect(revision.metadata?.env).toBe("prod");
  });

  it("rejects invalid tenantId and contractName", () => {
    const registry = new ContractRegistry();
    const tool = dummyTool("getPet", "tenant-1");

    expect(() =>
      registry.createRevision({
        tenantId: "",
        contractName: "petstore",
        sourceHash: "hash",
        tools: [tool],
        destinationPolicy: {
          baseUrl: "https://api.example.com",
          allowedHosts: ["api.example.com"],
        },
      }),
    ).toThrowError(GatewayError);

    expect(() =>
      registry.createRevision({
        tenantId: "tenant-1",
        contractName: "invalid name with spaces!",
        sourceHash: "hash",
        tools: [tool],
        destinationPolicy: {
          baseUrl: "https://api.example.com",
          allowedHosts: ["api.example.com"],
        },
      }),
    ).toThrowError(GatewayError);
  });

  it("rejects destination policy if baseUrl host is not allowlisted or scheme is insecure", () => {
    const registry = new ContractRegistry();
    const tool = dummyTool("getPet", "tenant-1");

    // Insecure HTTP without allowInsecureHttp flag
    expect(() =>
      registry.createRevision({
        tenantId: "tenant-1",
        contractName: "petstore",
        sourceHash: "hash",
        tools: [tool],
        destinationPolicy: {
          baseUrl: "http://api.example.com",
          allowedHosts: ["api.example.com"],
        },
      }),
    ).toThrowError(/scheme must be 'https:'/);

    // Host not in allowedHosts
    expect(() =>
      registry.createRevision({
        tenantId: "tenant-1",
        contractName: "petstore",
        sourceHash: "hash",
        tools: [tool],
        destinationPolicy: {
          baseUrl: "https://api.example.com",
          allowedHosts: ["other.example.com"],
        },
      }),
    ).toThrowError(/is not in allowedHosts/);

    // Secure HTTPS with matching allowedHosts succeeds
    expect(() =>
      registry.createRevision({
        tenantId: "tenant-1",
        contractName: "petstore",
        sourceHash: "hash",
        tools: [tool],
        destinationPolicy: {
          baseUrl: "https://api.example.com",
          allowedHosts: ["api.example.com"],
        },
      }),
    ).not.toThrow();

    // Insecure HTTP with explicit allowInsecureHttp: true succeeds
    expect(() =>
      registry.createRevision({
        tenantId: "tenant-1",
        contractName: "petstore",
        sourceHash: "hash",
        tools: [tool],
        destinationPolicy: {
          baseUrl: "http://api.example.com",
          allowedHosts: ["api.example.com"],
          allowInsecureHttp: true,
        },
      }),
    ).not.toThrow();
  });

  it("enforces tool tenant ownership and rejects tenant mismatch", () => {
    const registry = new ContractRegistry();
    const tool = dummyTool("getPet", "tenant-other");

    expect(() =>
      registry.createRevision({
        tenantId: "tenant-1",
        contractName: "petstore",
        sourceHash: "hash",
        tools: [tool],
        destinationPolicy: {
          baseUrl: "https://api.example.com",
          allowedHosts: ["api.example.com"],
        },
      }),
    ).toThrowError(/does not match contract tenant/);
  });

  it("rejects duplicate tool names within the same candidate revision", () => {
    const registry = new ContractRegistry();
    const tool1 = dummyTool("getPet", "tenant-1");
    const tool2 = dummyTool("getPet", "tenant-1");

    expect(() =>
      registry.createRevision({
        tenantId: "tenant-1",
        contractName: "petstore",
        sourceHash: "hash",
        tools: [tool1, tool2],
        destinationPolicy: {
          baseUrl: "https://api.example.com",
          allowedHosts: ["api.example.com"],
        },
      }),
    ).toThrowError(/Duplicate tool name 'getPet'/);
  });

  it("activates revision and marks previous active revision as superseded", () => {
    const registry = new ContractRegistry();
    const tool1 = dummyTool("getPet", "tenant-1");
    const tool2 = dummyTool("getPetUpdated", "tenant-1");

    const rev1 = registry.createRevision({
      tenantId: "tenant-1",
      contractName: "petstore",
      sourceHash: "hash1",
      tools: [tool1],
      destinationPolicy: {
        baseUrl: "https://api.example.com",
        allowedHosts: ["api.example.com"],
      },
    });

    const act1 = registry.activateRevision(
      "tenant-1",
      "petstore",
      rev1.revisionId,
    );
    expect(act1.activatedRevision.status).toBe("active");
    expect(act1.previousRevision).toBeUndefined();
    expect(registry.getActiveRevision("tenant-1", "petstore")?.revisionId).toBe(
      rev1.revisionId,
    );

    const rev2 = registry.createRevision({
      tenantId: "tenant-1",
      contractName: "petstore",
      sourceHash: "hash2",
      tools: [tool2],
      destinationPolicy: {
        baseUrl: "https://api.example.com",
        allowedHosts: ["api.example.com"],
      },
    });

    const act2 = registry.activateRevision(
      "tenant-1",
      "petstore",
      rev2.revisionId,
    );
    expect(act2.activatedRevision.status).toBe("active");
    expect(act2.previousRevision?.revisionId).toBe(rev1.revisionId);
    expect(act2.previousRevision?.status).toBe("superseded");
    expect(registry.getActiveRevision("tenant-1", "petstore")?.revisionId).toBe(
      rev2.revisionId,
    );

    // Verify rev1 in registry is updated to superseded
    expect(registry.getRevision(rev1.revisionId)?.status).toBe("superseded");
  });

  it("rejects activating a revision whose tool names collide with another active contract of the same tenant", () => {
    const registry = new ContractRegistry();
    const petTool = dummyTool("sharedName", "tenant-1");
    const storeTool = dummyTool("sharedName", "tenant-1");

    const petRev = registry.createRevision({
      tenantId: "tenant-1",
      contractName: "petstore",
      sourceHash: "hash1",
      tools: [petTool],
      destinationPolicy: {
        baseUrl: "https://api.example.com",
        allowedHosts: ["api.example.com"],
      },
    });
    registry.activateRevision("tenant-1", "petstore", petRev.revisionId);

    const storeRev = registry.createRevision({
      tenantId: "tenant-1",
      contractName: "store",
      sourceHash: "hash2",
      tools: [storeTool],
      destinationPolicy: {
        baseUrl: "https://api.example.com",
        allowedHosts: ["api.example.com"],
      },
    });

    // Activating store contract should fail due to collision on 'sharedName' with active 'petstore' contract
    expect(() =>
      registry.activateRevision("tenant-1", "store", storeRev.revisionId),
    ).toThrowError(/conflicts with active tool from contract 'petstore'/);
  });

  it("allows same tool name across different tenants", () => {
    const registry = new ContractRegistry();
    const t1Tool = dummyTool("sharedName", "tenant-1");
    const t2Tool = dummyTool("sharedName", "tenant-2");

    const rev1 = registry.createRevision({
      tenantId: "tenant-1",
      contractName: "contract-1",
      sourceHash: "hash1",
      tools: [t1Tool],
      destinationPolicy: {
        baseUrl: "https://api.example.com",
        allowedHosts: ["api.example.com"],
      },
    });
    const rev2 = registry.createRevision({
      tenantId: "tenant-2",
      contractName: "contract-2",
      sourceHash: "hash2",
      tools: [t2Tool],
      destinationPolicy: {
        baseUrl: "https://api.example.com",
        allowedHosts: ["api.example.com"],
      },
    });

    expect(() =>
      registry.activateRevision("tenant-1", "contract-1", rev1.revisionId),
    ).not.toThrow();
    expect(() =>
      registry.activateRevision("tenant-2", "contract-2", rev2.revisionId),
    ).not.toThrow();

    expect(
      registry.getActiveRevision("tenant-1", "contract-1")?.revisionId,
    ).toBe(rev1.revisionId);
    expect(
      registry.getActiveRevision("tenant-2", "contract-2")?.revisionId,
    ).toBe(rev2.revisionId);
  });

  it("disables an active revision and removes it from active list", () => {
    const registry = new ContractRegistry();
    const tool = dummyTool("getPet", "tenant-1");

    const rev = registry.createRevision({
      tenantId: "tenant-1",
      contractName: "petstore",
      sourceHash: "hash",
      tools: [tool],
      destinationPolicy: {
        baseUrl: "https://api.example.com",
        allowedHosts: ["api.example.com"],
      },
    });
    registry.activateRevision("tenant-1", "petstore", rev.revisionId);

    const disabled = registry.disableRevision("tenant-1", "petstore");
    expect(disabled.status).toBe("disabled");
    expect(registry.getActiveRevision("tenant-1", "petstore")).toBeUndefined();
    expect(registry.listActiveRevisions("tenant-1")).toHaveLength(0);
  });

  it("rolls back to a previous revision", () => {
    const registry = new ContractRegistry();
    const toolV1 = dummyTool("getPetV1", "tenant-1");
    const toolV2 = dummyTool("getPetV2", "tenant-1");

    const rev1 = registry.createRevision({
      tenantId: "tenant-1",
      contractName: "petstore",
      sourceHash: "hash1",
      tools: [toolV1],
      destinationPolicy: {
        baseUrl: "https://api.example.com",
        allowedHosts: ["api.example.com"],
      },
    });
    registry.activateRevision("tenant-1", "petstore", rev1.revisionId);

    const rev2 = registry.createRevision({
      tenantId: "tenant-1",
      contractName: "petstore",
      sourceHash: "hash2",
      tools: [toolV2],
      destinationPolicy: {
        baseUrl: "https://api.example.com",
        allowedHosts: ["api.example.com"],
      },
    });
    registry.activateRevision("tenant-1", "petstore", rev2.revisionId);

    const rollback = registry.rollbackRevision(
      "tenant-1",
      "petstore",
      rev1.revisionId,
    );
    expect(rollback.reactivatedRevision.revisionId).toBe(rev1.revisionId);
    expect(rollback.reactivatedRevision.status).toBe("active");
    expect(rollback.rolledBackRevision?.revisionId).toBe(rev2.revisionId);
    expect(rollback.rolledBackRevision?.status).toBe("rolled_back");

    expect(registry.getActiveRevision("tenant-1", "petstore")?.revisionId).toBe(
      rev1.revisionId,
    );
  });
});

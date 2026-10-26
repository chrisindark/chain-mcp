import { createHash } from "node:crypto";
import { auditInputSchema, type ToolDefinition } from "@chainmcp/core";
import { normalizeAllowedHost } from "@chainmcp/executor";
import {
  type ContractDestinationPolicy,
  type ContractRevision,
  GatewayError,
} from "./types.js";

export interface CreateRevisionOptions {
  readonly tenantId: string;
  readonly contractName: string;
  readonly sourceHash: string;
  readonly tools: readonly ToolDefinition[];
  readonly destinationPolicy: ContractDestinationPolicy;
  readonly authConfig?: ContractRevision["authConfig"] | undefined;
  readonly limits?: ContractRevision["limits"] | undefined;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
  readonly now?: (() => number) | undefined;
}

export interface ActivationResult {
  readonly activatedRevision: ContractRevision;
  readonly previousRevision?: ContractRevision | undefined;
}

export interface RollbackResult {
  readonly reactivatedRevision: ContractRevision;
  readonly rolledBackRevision?: ContractRevision | undefined;
}

const NAME_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;

export class ContractRegistry {
  private readonly revisionsById = new Map<string, ContractRevision>();
  private readonly revisionsByContract = new Map<string, string[]>();
  private readonly activeByContract = new Map<string, string>();
  private revisionCounter = 0;

  /**
   * Creates an immutable candidate revision. Validates destination policy,
   * tool definitions, tenant ownership, and intra-tenant tool name uniqueness.
   */
  createRevision(options: CreateRevisionOptions): ContractRevision {
    this.assertTenantId(options.tenantId);
    this.assertContractName(options.contractName);
    this.assertDestinationPolicy(options.destinationPolicy);

    if (!Array.isArray(options.tools) || options.tools.length === 0) {
      throw new GatewayError(
        "POLICY_VIOLATION",
        `Contract '${options.contractName}' must have at least one tool`,
      );
    }

    // Validate tools and detect intra-revision name collisions
    const toolNames = new Set<string>();
    for (const tool of options.tools) {
      if (!NAME_REGEX.test(tool.name)) {
        throw new GatewayError(
          "POLICY_VIOLATION",
          `Tool name '${tool.name}' is invalid. Must be 1-64 alphanumeric characters, hyphens, or underscores`,
        );
      }
      if (toolNames.has(tool.name)) {
        throw new GatewayError(
          "REVISION_CONFLICT",
          `Duplicate tool name '${tool.name}' within revision for contract '${options.contractName}'`,
        );
      }
      toolNames.add(tool.name);

      if (tool.ownerTenantId !== options.tenantId) {
        throw new GatewayError(
          "TENANT_MISMATCH",
          `Tool '${tool.name}' has ownerTenantId '${tool.ownerTenantId ?? ""}' which does not match contract tenant '${options.tenantId}'`,
        );
      }

      try {
        auditInputSchema(tool.inputSchema);
      } catch (err) {
        throw new GatewayError(
          "POLICY_VIOLATION",
          `Tool '${tool.name}' has an unsupported input schema: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }
    }

    this.revisionCounter++;
    const timestamp = options.now ? options.now() : Date.now();
    const hashBasis = `${options.tenantId}:${options.contractName}:${options.sourceHash}:${timestamp}:${this.revisionCounter}:${[...toolNames].sort().join(",")}`;
    const revisionDigest = createHash("sha256")
      .update(hashBasis)
      .digest("hex")
      .slice(0, 16);
    const revisionId = `rev_${revisionDigest}`;

    // Stamp tools with the revisionId if not already stamped
    const stampedTools: readonly ToolDefinition[] = options.tools.map(
      (tool) => ({
        ...tool,
        contractRevision: revisionId,
        ownerTenantId: options.tenantId,
      }),
    );

    const revision: ContractRevision = Object.freeze({
      revisionId,
      contractName: options.contractName,
      tenantId: options.tenantId,
      sourceHash: options.sourceHash,
      createdAt: timestamp,
      status: "candidate",
      tools: Object.freeze([...stampedTools]),
      destinationPolicy: Object.freeze({
        baseUrl: options.destinationPolicy.baseUrl,
        allowedHosts: Object.freeze([
          ...options.destinationPolicy.allowedHosts,
        ]),
        ...(options.destinationPolicy.allowInsecureHttp !== undefined
          ? { allowInsecureHttp: options.destinationPolicy.allowInsecureHttp }
          : {}),
      }),
      ...(options.authConfig !== undefined
        ? { authConfig: Object.freeze(options.authConfig) }
        : {}),
      ...(options.limits !== undefined
        ? { limits: Object.freeze(options.limits) }
        : {}),
      ...(options.metadata !== undefined
        ? { metadata: Object.freeze(options.metadata) }
        : {}),
    });

    this.revisionsById.set(revisionId, revision);
    const contractKey = this.contractKey(
      options.tenantId,
      options.contractName,
    );
    const history = this.revisionsByContract.get(contractKey) ?? [];
    history.push(revisionId);
    this.revisionsByContract.set(contractKey, history);

    return revision;
  }

  /**
   * Atomically activates a candidate or superseded revision.
   * Verifies no tool name collisions with other currently active contracts of the same tenant.
   */
  activateRevision(
    tenantId: string,
    contractName: string,
    revisionId: string,
  ): ActivationResult {
    this.assertTenantId(tenantId);
    this.assertContractName(contractName);

    const revision = this.revisionsById.get(revisionId);
    if (
      !revision ||
      revision.tenantId !== tenantId ||
      revision.contractName !== contractName
    ) {
      throw new GatewayError(
        "REVISION_NOT_FOUND",
        `Revision '${revisionId}' for tenant '${tenantId}' and contract '${contractName}' was not found`,
      );
    }

    if (revision.status === "active") {
      return { activatedRevision: revision };
    }

    // Check tool name collisions against ALL other active contracts for this tenant
    this.assertNoToolCollisionsWithOtherActiveContracts(
      tenantId,
      contractName,
      revision.tools,
    );

    const contractKey = this.contractKey(tenantId, contractName);
    const previousActiveId = this.activeByContract.get(contractKey);
    let previousRevision: ContractRevision | undefined;

    if (previousActiveId && previousActiveId !== revisionId) {
      const prev = this.revisionsById.get(previousActiveId);
      if (prev && prev.status === "active") {
        previousRevision = Object.freeze({
          ...prev,
          status: "superseded",
        });
        this.revisionsById.set(previousActiveId, previousRevision);
      }
    }

    const activatedRevision: ContractRevision = Object.freeze({
      ...revision,
      status: "active",
    });
    this.revisionsById.set(revisionId, activatedRevision);
    this.activeByContract.set(contractKey, revisionId);

    return {
      activatedRevision,
      ...(previousRevision ? { previousRevision } : {}),
    };
  }

  /**
   * Disables the active revision for a contract.
   * Once disabled, the contract's tools cannot be listed or invoked.
   */
  disableRevision(
    tenantId: string,
    contractName: string,
    revisionId?: string,
  ): ContractRevision {
    this.assertTenantId(tenantId);
    this.assertContractName(contractName);

    const contractKey = this.contractKey(tenantId, contractName);
    const activeId = this.activeByContract.get(contractKey);

    if (!activeId) {
      throw new GatewayError(
        "CONTRACT_NOT_FOUND",
        `No active revision found for tenant '${tenantId}' and contract '${contractName}' to disable`,
      );
    }

    if (revisionId && activeId !== revisionId) {
      throw new GatewayError(
        "REVISION_CONFLICT",
        `Active revision is '${activeId}', but '${revisionId}' was requested to disable`,
      );
    }

    const active = this.revisionsById.get(activeId);
    if (!active) {
      throw new GatewayError(
        "REVISION_NOT_FOUND",
        `Active revision '${activeId}' record not found`,
      );
    }

    const disabledRevision: ContractRevision = Object.freeze({
      ...active,
      status: "disabled",
    });

    this.revisionsById.set(activeId, disabledRevision);
    this.activeByContract.delete(contractKey);

    return disabledRevision;
  }

  /**
   * Atomically rolls back a contract to a previously compiled revision.
   */
  rollbackRevision(
    tenantId: string,
    contractName: string,
    targetRevisionId: string,
  ): RollbackResult {
    this.assertTenantId(tenantId);
    this.assertContractName(contractName);

    const target = this.revisionsById.get(targetRevisionId);
    if (
      !target ||
      target.tenantId !== tenantId ||
      target.contractName !== contractName
    ) {
      throw new GatewayError(
        "REVISION_NOT_FOUND",
        `Target rollback revision '${targetRevisionId}' for tenant '${tenantId}' and contract '${contractName}' was not found`,
      );
    }

    const contractKey = this.contractKey(tenantId, contractName);
    const currentActiveId = this.activeByContract.get(contractKey);

    if (currentActiveId === targetRevisionId && target.status === "active") {
      throw new GatewayError(
        "INVALID_REVISION_STATE",
        `Target revision '${targetRevisionId}' is already the active revision for contract '${contractName}'`,
      );
    }

    // Check collisions against other active contracts
    this.assertNoToolCollisionsWithOtherActiveContracts(
      tenantId,
      contractName,
      target.tools,
    );

    let rolledBackRevision: ContractRevision | undefined;
    if (currentActiveId) {
      const current = this.revisionsById.get(currentActiveId);
      if (current) {
        rolledBackRevision = Object.freeze({
          ...current,
          status: "rolled_back",
        });
        this.revisionsById.set(currentActiveId, rolledBackRevision);
      }
    }

    const reactivatedRevision: ContractRevision = Object.freeze({
      ...target,
      status: "active",
    });
    this.revisionsById.set(targetRevisionId, reactivatedRevision);
    this.activeByContract.set(contractKey, targetRevisionId);

    return {
      reactivatedRevision,
      ...(rolledBackRevision ? { rolledBackRevision } : {}),
    };
  }

  getActiveRevision(
    tenantId: string,
    contractName: string,
  ): ContractRevision | undefined {
    const key = this.contractKey(tenantId, contractName);
    const activeId = this.activeByContract.get(key);
    return activeId ? this.revisionsById.get(activeId) : undefined;
  }

  getRevision(revisionId: string): ContractRevision | undefined {
    return this.revisionsById.get(revisionId);
  }

  listRevisions(
    tenantId: string,
    contractName?: string,
  ): readonly ContractRevision[] {
    const results: ContractRevision[] = [];
    if (contractName !== undefined) {
      const key = this.contractKey(tenantId, contractName);
      const ids = this.revisionsByContract.get(key) ?? [];
      for (const id of ids) {
        const rev = this.revisionsById.get(id);
        if (rev) results.push(rev);
      }
      return results;
    }

    for (const rev of this.revisionsById.values()) {
      if (rev.tenantId === tenantId) {
        results.push(rev);
      }
    }
    return results;
  }

  listActiveRevisions(tenantId?: string): readonly ContractRevision[] {
    const results: ContractRevision[] = [];
    for (const activeId of this.activeByContract.values()) {
      const rev = this.revisionsById.get(activeId);
      if (rev && (tenantId === undefined || rev.tenantId === tenantId)) {
        results.push(rev);
      }
    }
    return results;
  }

  private assertNoToolCollisionsWithOtherActiveContracts(
    tenantId: string,
    contractName: string,
    incomingTools: readonly ToolDefinition[],
  ): void {
    const existingActiveToolNames = new Map<string, string>(); // toolName -> contractName
    for (const [key, revId] of this.activeByContract.entries()) {
      if (!key.startsWith(`${tenantId}::`)) continue;
      const otherContract = key.slice(tenantId.length + 2);
      if (otherContract === contractName) continue; // skip the contract being updated
      const activeRev = this.revisionsById.get(revId);
      if (!activeRev) continue;
      for (const t of activeRev.tools) {
        existingActiveToolNames.set(t.name, otherContract);
      }
    }

    for (const t of incomingTools) {
      const conflictingContract = existingActiveToolNames.get(t.name);
      if (conflictingContract) {
        throw new GatewayError(
          "REVISION_CONFLICT",
          `Tool name '${t.name}' conflicts with active tool from contract '${conflictingContract}' for tenant '${tenantId}'`,
        );
      }
    }
  }

  private contractKey(tenantId: string, contractName: string): string {
    return `${tenantId}::${contractName}`;
  }

  private assertTenantId(tenantId: unknown): asserts tenantId is string {
    if (typeof tenantId !== "string" || tenantId.trim().length === 0) {
      throw new GatewayError(
        "POLICY_VIOLATION",
        "tenantId must be a non-empty string",
      );
    }
  }

  private assertContractName(name: unknown): asserts name is string {
    if (typeof name !== "string" || !NAME_REGEX.test(name)) {
      throw new GatewayError(
        "POLICY_VIOLATION",
        `Contract name '${String(name)}' is invalid. Must be 1-64 alphanumeric characters, hyphens, or underscores`,
      );
    }
  }

  private assertDestinationPolicy(policy: ContractDestinationPolicy): void {
    if (!policy || typeof policy !== "object") {
      throw new GatewayError(
        "DESTINATION_INVALID",
        "Destination policy must be an object",
      );
    }
    if (typeof policy.baseUrl !== "string" || policy.baseUrl.length === 0) {
      throw new GatewayError(
        "DESTINATION_INVALID",
        "Destination policy baseUrl must be a non-empty string",
      );
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(policy.baseUrl);
    } catch {
      throw new GatewayError(
        "DESTINATION_INVALID",
        `Destination policy baseUrl '${policy.baseUrl}' is not a valid absolute URL`,
      );
    }

    if (
      parsedUrl.protocol !== "https:" &&
      !(policy.allowInsecureHttp && parsedUrl.protocol === "http:")
    ) {
      throw new GatewayError(
        "DESTINATION_INVALID",
        `Destination policy baseUrl scheme must be 'https:' (got '${parsedUrl.protocol}')`,
      );
    }

    if (
      !Array.isArray(policy.allowedHosts) ||
      policy.allowedHosts.length === 0
    ) {
      throw new GatewayError(
        "DESTINATION_INVALID",
        "Destination policy allowedHosts must be a non-empty array of hostnames",
      );
    }

    const normalizedHosts: string[] = [];
    for (const host of policy.allowedHosts) {
      try {
        normalizedHosts.push(normalizeAllowedHost(host));
      } catch (err) {
        throw new GatewayError(
          "DESTINATION_INVALID",
          `Invalid allowedHost '${host}': ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }
    }

    const baseHost = parsedUrl.hostname.toLowerCase();
    if (!normalizedHosts.includes(baseHost)) {
      throw new GatewayError(
        "DESTINATION_INVALID",
        `Destination policy baseUrl hostname '${baseHost}' is not in allowedHosts [${normalizedHosts.join(", ")}]`,
      );
    }
  }
}

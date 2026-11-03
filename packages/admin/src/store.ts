import { createHash, randomBytes } from "node:crypto";

import {
  DescriptorStoreError,
  MAX_DECLARATIVE_ADMIN_DESCRIPTORS,
  MAX_STORED_DESCRIPTOR_REVISIONS,
  type DeclarativeAdminDescriptorRevision,
  type DeclarativeAdminStoredRevisionSummary,
  type DescriptorRevisionStore,
  type StoredDescriptorRevision,
  type StoredDescriptorRevisionStatus,
} from "./types.js";

const REVISION_ID = /^dset_[0-9a-f]{16}$/;
const CONTRACT_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const HASH = /^[0-9a-f]{64}$/;
const GATEWAY_REVISION = /^[A-Za-z0-9_-]{1,128}$/;

export interface DescriptorStoreOptions {
  readonly maxRevisionsPerContract?: number;
}

/**
 * In-memory descriptor revision store. It is the default for tests and for
 * deployments that explicitly accept that revisions do not survive a restart.
 *
 * Mutations are serialized, validated before any state change, and committed
 * through `commit()` so subclasses can persist the exact next snapshot.
 */
export class InMemoryDescriptorRevisionStore implements DescriptorRevisionStore {
  readonly kind: string = "memory";

  readonly #records: Map<string, StoredDescriptorRevision>;
  readonly #maxRevisionsPerContract: number;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(
    records: readonly StoredDescriptorRevision[] = [],
    options: DescriptorStoreOptions = {},
  ) {
    const maxRevisions =
      options.maxRevisionsPerContract ?? MAX_STORED_DESCRIPTOR_REVISIONS;
    if (
      !Number.isInteger(maxRevisions) ||
      maxRevisions < 1 ||
      maxRevisions > 10_000
    ) {
      throw new TypeError(
        "maxRevisionsPerContract must be an integer between 1 and 10000",
      );
    }
    this.#maxRevisionsPerContract = maxRevisions;
    this.#records = new Map();
    for (const record of records) {
      validateStoredRevision(record);
      const key = recordKey(
        record.tenantId,
        record.contractName,
        record.revisionId,
      );
      if (this.#records.has(key)) {
        throw new DescriptorStoreError(
          "STORE_CORRUPT",
          `Descriptor store contains duplicate revision '${record.revisionId}'`,
        );
      }
      this.#records.set(key, cloneRevision(record));
    }
    assertSingleActivePerContract(this.#records);
  }

  async listRevisions(
    tenantId: string,
    contractName: string,
  ): Promise<readonly StoredDescriptorRevision[]> {
    assertPair(tenantId, contractName);
    const results: StoredDescriptorRevision[] = [];
    for (const record of this.#records.values()) {
      if (
        record.tenantId === tenantId &&
        record.contractName === contractName
      ) {
        results.push(cloneRevision(record));
      }
    }
    return results;
  }

  async getRevision(
    tenantId: string,
    contractName: string,
    revisionId: string,
  ): Promise<StoredDescriptorRevision | undefined> {
    assertPair(tenantId, contractName);
    const record = this.#records.get(
      recordKey(tenantId, contractName, revisionId),
    );
    return record === undefined ? undefined : cloneRevision(record);
  }

  async getActive(
    tenantId: string,
    contractName: string,
  ): Promise<StoredDescriptorRevision | undefined> {
    const active = this.#findActive(tenantId, contractName);
    return active === undefined ? undefined : cloneRevision(active);
  }

  async createRevision(record: StoredDescriptorRevision): Promise<void> {
    await this.#mutate(async () => {
      validateStoredRevision(record);
      if (record.status !== "candidate") {
        throw new DescriptorStoreError(
          "STORE_STATE_INVALID",
          "New descriptor revisions must start in the candidate state",
        );
      }
      const key = recordKey(
        record.tenantId,
        record.contractName,
        record.revisionId,
      );
      if (this.#records.has(key)) {
        throw new DescriptorStoreError(
          "STORE_DUPLICATE",
          `Descriptor revision '${record.revisionId}' already exists`,
        );
      }
      const history = this.#history(record.tenantId, record.contractName);
      if (history.length >= this.#maxRevisionsPerContract) {
        throw new DescriptorStoreError(
          "STORE_LIMIT_EXCEEDED",
          `Descriptor revision limit (${this.#maxRevisionsPerContract}) reached for this contract`,
        );
      }
      const next = new Map(this.#records);
      next.set(key, cloneRevision(record));
      await this.commit(next);
      this.#replace(next);
    });
  }

  async activateRevision(
    tenantId: string,
    contractName: string,
    revisionId: string,
    gatewayRevisionId: string,
  ): Promise<void> {
    assertPair(tenantId, contractName);
    assertGatewayRevisionId(gatewayRevisionId);

    await this.#mutate(async () => {
      const key = recordKey(tenantId, contractName, revisionId);
      const target = this.#records.get(key);
      if (target === undefined) {
        throw new DescriptorStoreError(
          "STORE_NOT_FOUND",
          `Descriptor revision '${revisionId}' was not found`,
        );
      }
      if (target.status !== "candidate") {
        throw new DescriptorStoreError(
          "STORE_STATE_INVALID",
          `Descriptor revision '${revisionId}' is ${target.status}, not candidate`,
        );
      }

      const next = new Map(this.#records);
      const active = this.#findActiveIn(next, tenantId, contractName);
      if (active !== undefined) {
        next.set(
          recordKey(tenantId, contractName, active.revisionId),
          freezeRevision({ ...active, status: "superseded" }),
        );
      }
      next.set(
        key,
        freezeRevision({
          ...target,
          status: "active",
          gatewayRevisionId,
        }),
      );

      await this.commit(next);
      this.#replace(next);
    });
  }

  async recordGatewayRevision(
    tenantId: string,
    contractName: string,
    revisionId: string,
    gatewayRevisionId: string,
  ): Promise<void> {
    assertPair(tenantId, contractName);
    assertGatewayRevisionId(gatewayRevisionId);

    await this.#mutate(async () => {
      const key = recordKey(tenantId, contractName, revisionId);
      const target = this.#records.get(key);
      if (target === undefined) {
        throw new DescriptorStoreError(
          "STORE_NOT_FOUND",
          `Descriptor revision '${revisionId}' was not found`,
        );
      }
      if (target.status !== "active") {
        throw new DescriptorStoreError(
          "STORE_STATE_INVALID",
          `Descriptor revision '${revisionId}' is ${target.status}, not active`,
        );
      }
      const next = new Map(this.#records);
      next.set(key, freezeRevision({ ...target, gatewayRevisionId }));
      await this.commit(next);
      this.#replace(next);
    });
  }

  async failRevision(
    tenantId: string,
    contractName: string,
    revisionId: string,
  ): Promise<void> {
    assertPair(tenantId, contractName);

    await this.#mutate(async () => {
      const key = recordKey(tenantId, contractName, revisionId);
      const target = this.#records.get(key);
      if (target === undefined) {
        throw new DescriptorStoreError(
          "STORE_NOT_FOUND",
          `Descriptor revision '${revisionId}' was not found`,
        );
      }
      if (target.status === "failed") return;
      if (target.status !== "candidate") {
        throw new DescriptorStoreError(
          "STORE_STATE_INVALID",
          `Descriptor revision '${revisionId}' is ${target.status}, not candidate`,
        );
      }
      const next = new Map(this.#records);
      next.set(key, freezeRevision({ ...target, status: "failed" }));
      await this.commit(next);
      this.#replace(next);
    });
  }

  /** Persists the exact next snapshot. Subclasses must be atomic. */
  protected async commit(
    next: ReadonlyMap<string, StoredDescriptorRevision>,
  ): Promise<void> {
    // In-memory stores have nothing to persist; the hook exists so subclasses
    // can write the exact snapshot before it becomes visible.
    void next;
  }

  #replace(next: ReadonlyMap<string, StoredDescriptorRevision>): void {
    this.#records.clear();
    for (const [key, record] of next) {
      this.#records.set(key, record);
    }
  }

  #mutate<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(operation, operation);
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  #history(
    tenantId: string,
    contractName: string,
  ): readonly StoredDescriptorRevision[] {
    return [...this.#records.values()].filter(
      (record) =>
        record.tenantId === tenantId && record.contractName === contractName,
    );
  }

  #findActive(
    tenantId: string,
    contractName: string,
  ): StoredDescriptorRevision | undefined {
    return this.#findActiveIn(this.#records, tenantId, contractName);
  }

  #findActiveIn(
    records: ReadonlyMap<string, StoredDescriptorRevision>,
    tenantId: string,
    contractName: string,
  ): StoredDescriptorRevision | undefined {
    for (const record of records.values()) {
      if (
        record.tenantId === tenantId &&
        record.contractName === contractName &&
        record.status === "active"
      ) {
        return record;
      }
    }
    return undefined;
  }
}

/** Creates a new admin revision id distinct from the gateway revision id. */
export function createDescriptorRevisionId(
  tenantId: string,
  contractName: string,
  toolsetHash: string,
  createdAt: number,
): string {
  const digest = createHash("sha256")
    .update(
      `${tenantId}\u0000${contractName}\u0000${toolsetHash}\u0000${createdAt}\u0000${randomBytes(8).toString("hex")}`,
    )
    .digest("hex");
  return `dset_${digest.slice(0, 16)}`;
}

/** Public projection of a stored record. */
export function toStoredRevisionSummary(
  record: StoredDescriptorRevision,
): DeclarativeAdminStoredRevisionSummary {
  return {
    revisionId: record.revisionId,
    tenantId: record.tenantId,
    contractName: record.contractName,
    createdAt: record.createdAt,
    status: record.status,
    toolsetHash: record.toolsetHash,
    toolCount: record.descriptors.length,
    toolNames: record.toolRevisions.map((tool) => tool.name),
    descriptors: record.toolRevisions.map((tool) => ({ ...tool })),
    ...(record.gatewayRevisionId === undefined
      ? {}
      : { gatewayRevisionId: record.gatewayRevisionId }),
    ...(record.publishedBy === undefined
      ? {}
      : { publishedBy: record.publishedBy }),
    ...(record.rollbackOf === undefined
      ? {}
      : { rollbackOf: record.rollbackOf }),
  };
}

/** Validates store-level structure; descriptor semantics are re-checked on use. */
export function validateStoredRevision(record: StoredDescriptorRevision): void {
  if (typeof record !== "object" || record === null) {
    throw new DescriptorStoreError(
      "STORE_CORRUPT",
      "Descriptor revision must be an object",
    );
  }
  if (
    typeof record.revisionId !== "string" ||
    !REVISION_ID.test(record.revisionId)
  ) {
    throw new DescriptorStoreError(
      "STORE_CORRUPT",
      "Descriptor revision id is invalid",
    );
  }
  assertPair(record.tenantId, record.contractName);
  if (!Number.isSafeInteger(record.createdAt) || record.createdAt < 0) {
    throw new DescriptorStoreError(
      "STORE_CORRUPT",
      `Descriptor revision '${record.revisionId}' has an invalid timestamp`,
    );
  }
  if (!isStatus(record.status)) {
    throw new DescriptorStoreError(
      "STORE_CORRUPT",
      `Descriptor revision '${record.revisionId}' has an invalid status`,
    );
  }
  if (
    typeof record.toolsetHash !== "string" ||
    !HASH.test(record.toolsetHash)
  ) {
    throw new DescriptorStoreError(
      "STORE_CORRUPT",
      `Descriptor revision '${record.revisionId}' has an invalid toolset hash`,
    );
  }
  if (
    !Array.isArray(record.descriptors) ||
    record.descriptors.length === 0 ||
    record.descriptors.length > MAX_DECLARATIVE_ADMIN_DESCRIPTORS
  ) {
    throw new DescriptorStoreError(
      "STORE_CORRUPT",
      `Descriptor revision '${record.revisionId}' has an invalid descriptor list`,
    );
  }
  for (const descriptor of record.descriptors) {
    if (
      typeof descriptor !== "object" ||
      descriptor === null ||
      Array.isArray(descriptor)
    ) {
      throw new DescriptorStoreError(
        "STORE_CORRUPT",
        `Descriptor revision '${record.revisionId}' contains an invalid descriptor`,
      );
    }
  }
  if (!Array.isArray(record.toolRevisions)) {
    throw new DescriptorStoreError(
      "STORE_CORRUPT",
      `Descriptor revision '${record.revisionId}' has no tool revisions`,
    );
  }
  if (record.toolRevisions.length !== record.descriptors.length) {
    throw new DescriptorStoreError(
      "STORE_CORRUPT",
      `Descriptor revision '${record.revisionId}' has inconsistent tool revisions`,
    );
  }
  const names = new Set<string>();
  for (const tool of record.toolRevisions) {
    if (
      typeof tool !== "object" ||
      tool === null ||
      typeof tool.name !== "string" ||
      tool.name.length === 0 ||
      typeof tool.revision !== "string" ||
      !tool.revision.startsWith("sha256:")
    ) {
      throw new DescriptorStoreError(
        "STORE_CORRUPT",
        `Descriptor revision '${record.revisionId}' has an invalid tool revision`,
      );
    }
    if (names.has(tool.name)) {
      throw new DescriptorStoreError(
        "STORE_CORRUPT",
        `Descriptor revision '${record.revisionId}' repeats tool '${tool.name}'`,
      );
    }
    names.add(tool.name);
  }
  if (
    record.gatewayRevisionId !== undefined &&
    (typeof record.gatewayRevisionId !== "string" ||
      !GATEWAY_REVISION.test(record.gatewayRevisionId))
  ) {
    throw new DescriptorStoreError(
      "STORE_CORRUPT",
      `Descriptor revision '${record.revisionId}' has an invalid gateway revision`,
    );
  }
  if (
    record.publishedBy !== undefined &&
    (typeof record.publishedBy !== "string" || record.publishedBy.length === 0)
  ) {
    throw new DescriptorStoreError(
      "STORE_CORRUPT",
      `Descriptor revision '${record.revisionId}' has an invalid publisher`,
    );
  }
  if (
    record.rollbackOf !== undefined &&
    (typeof record.rollbackOf !== "string" ||
      !REVISION_ID.test(record.rollbackOf))
  ) {
    throw new DescriptorStoreError(
      "STORE_CORRUPT",
      `Descriptor revision '${record.revisionId}' has an invalid rollback target`,
    );
  }
}

/** Builds the toolset hash the admin surface records for a descriptor set. */
export function descriptorToolsetHash(
  tools: readonly DeclarativeAdminDescriptorRevision[],
): string {
  return createHash("sha256")
    .update(tools.map(({ name, revision }) => `${name}:${revision}`).join("\n"))
    .digest("hex");
}

function recordKey(
  tenantId: string,
  contractName: string,
  revisionId: string,
): string {
  return `${tenantId}\u0000${contractName}\u0000${revisionId}`;
}

function assertPair(tenantId: string, contractName: string): void {
  if (
    typeof tenantId !== "string" ||
    tenantId.trim().length === 0 ||
    hasControlCharacters(tenantId)
  ) {
    throw new DescriptorStoreError(
      "STORE_CORRUPT",
      "Descriptor revision tenant id is invalid",
    );
  }
  if (typeof contractName !== "string" || !CONTRACT_NAME.test(contractName)) {
    throw new DescriptorStoreError(
      "STORE_CORRUPT",
      "Descriptor revision contract name is invalid",
    );
  }
}

function assertGatewayRevisionId(value: string): void {
  if (typeof value !== "string" || !GATEWAY_REVISION.test(value)) {
    throw new DescriptorStoreError(
      "STORE_STATE_INVALID",
      "A non-empty gateway revision id is required",
    );
  }
}

function assertSingleActivePerContract(
  records: ReadonlyMap<string, StoredDescriptorRevision>,
): void {
  const active = new Set<string>();
  for (const record of records.values()) {
    if (record.status !== "active") continue;
    const pair = `${record.tenantId}\u0000${record.contractName}`;
    if (active.has(pair)) {
      throw new DescriptorStoreError(
        "STORE_CORRUPT",
        `Multiple active descriptor revisions for tenant '${record.tenantId}' and contract '${record.contractName}'`,
      );
    }
    active.add(pair);
  }
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) <= 0x1f) return true;
  }
  return false;
}

function isStatus(value: unknown): value is StoredDescriptorRevisionStatus {
  return (
    value === "candidate" ||
    value === "active" ||
    value === "superseded" ||
    value === "failed"
  );
}

function cloneRevision(
  record: StoredDescriptorRevision,
): StoredDescriptorRevision {
  return freezeRevision(structuredClone(record));
}

function freezeRevision(
  record: StoredDescriptorRevision,
): StoredDescriptorRevision {
  return Object.freeze({
    ...record,
    descriptors: Object.freeze([...record.descriptors]),
    toolRevisions: Object.freeze(
      record.toolRevisions.map((tool) => Object.freeze({ ...tool })),
    ),
  });
}

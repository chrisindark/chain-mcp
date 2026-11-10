import type { KeyValueStore, StorageDriver } from "@chainmcp/storage";

import {
  InMemoryDescriptorRevisionStore,
  type DescriptorStoreOptions,
} from "./store.js";
import {
  DescriptorStoreError,
  type StoredDescriptorRevision,
} from "./types.js";

export interface StorageDescriptorRevisionStoreOptions extends DescriptorStoreOptions {
  /** Storage driver from @chainmcp/storage (e.g. MemoryStorageDriver or SqliteStorageDriver). */
  readonly driver?: StorageDriver | undefined;
  /** Explicit KeyValueStore to use. If omitted, driver.getKeyValueStore(namespace) is used. */
  readonly kvStore?:
    KeyValueStore<readonly StoredDescriptorRevision[]> | undefined;
  /** Namespace for revision keys in storage. Defaults to "chainmcp_revisions". */
  readonly namespace?: string | undefined;
}

const DEFAULT_REVISIONS_NAMESPACE = "chainmcp_revisions";
const CONTRACTS_INDEX_KEY = "contracts_index";

/**
 * Durable descriptor revision store backed by @chainmcp/storage KeyValueStore.
 *
 * Revisions are persisted per contract partition (`contract:${tenantId}:${contractName}`)
 * and indexed via `contracts_index` so rollbacks and active configurations survive process
 * restarts across both Memory and SQLite WAL drivers.
 */
export class StorageDescriptorRevisionStore extends InMemoryDescriptorRevisionStore {
  override readonly kind = "storage";
  readonly #kvStore: KeyValueStore<readonly StoredDescriptorRevision[]>;
  readonly #driver: StorageDriver | undefined;
  #knownContractKeys: Set<string>;

  private constructor(
    records: readonly StoredDescriptorRevision[],
    kvStore: KeyValueStore<readonly StoredDescriptorRevision[]>,
    driver: StorageDriver | undefined,
    knownContractKeys: Set<string>,
    options: DescriptorStoreOptions,
  ) {
    super(records, options);
    this.#kvStore = kvStore;
    this.#driver = driver;
    this.#knownContractKeys = knownContractKeys;
  }

  static async open(
    driverOrStoreOrOptions:
      | StorageDriver
      | KeyValueStore<readonly StoredDescriptorRevision[]>
      | StorageDescriptorRevisionStoreOptions,
    options?: DescriptorStoreOptions,
  ): Promise<StorageDescriptorRevisionStore> {
    let driver: StorageDriver | undefined;
    let kvStore: KeyValueStore<readonly StoredDescriptorRevision[]> | undefined;
    let baseOptions: DescriptorStoreOptions = options ?? {};
    let namespace = DEFAULT_REVISIONS_NAMESPACE;

    if (
      typeof driverOrStoreOrOptions === "object" &&
      driverOrStoreOrOptions !== null
    ) {
      if (
        "getKeyValueStore" in driverOrStoreOrOptions &&
        typeof driverOrStoreOrOptions.getKeyValueStore === "function"
      ) {
        driver = driverOrStoreOrOptions as StorageDriver;
      } else if (
        "namespace" in driverOrStoreOrOptions &&
        "get" in driverOrStoreOrOptions &&
        typeof driverOrStoreOrOptions.get === "function"
      ) {
        kvStore = driverOrStoreOrOptions as KeyValueStore<
          readonly StoredDescriptorRevision[]
        >;
      } else {
        const opt =
          driverOrStoreOrOptions as StorageDescriptorRevisionStoreOptions;
        driver = opt.driver;
        kvStore = opt.kvStore;
        if (opt.namespace) {
          namespace = opt.namespace;
        }
        baseOptions = { ...opt, ...options };
      }
    } else {
      throw new TypeError(
        "StorageDescriptorRevisionStore requires a driver, kvStore, or options object",
      );
    }

    if (!kvStore) {
      if (!driver) {
        throw new TypeError(
          "StorageDescriptorRevisionStore requires a driver or kvStore",
        );
      }
      kvStore =
        driver.getKeyValueStore<readonly StoredDescriptorRevision[]>(namespace);
    }

    const records: StoredDescriptorRevision[] = [];
    const knownContractKeys = new Set<string>();

    try {
      const rawIndex = await kvStore.get(CONTRACTS_INDEX_KEY);
      if (Array.isArray(rawIndex)) {
        for (const key of rawIndex) {
          if (typeof key === "string") {
            knownContractKeys.add(key);
            const contractRevs = await kvStore.get(key);
            if (Array.isArray(contractRevs)) {
              records.push(...contractRevs);
            }
          }
        }
      } else {
        const items = await kvStore.list({
          prefix: "contract:",
          limit: 100_000,
        });
        for (const item of items) {
          knownContractKeys.add(item.key);
          if (Array.isArray(item.value)) {
            records.push(...item.value);
          }
        }
      }
    } catch (error) {
      throw new DescriptorStoreError(
        "STORE_IO",
        "Failed to read descriptor revisions from storage driver",
        { cause: error },
      );
    }

    return new StorageDescriptorRevisionStore(
      records,
      kvStore,
      driver,
      knownContractKeys,
      baseOptions,
    );
  }

  public get driver(): StorageDriver | undefined {
    return this.#driver;
  }

  public get kvStore(): KeyValueStore<readonly StoredDescriptorRevision[]> {
    return this.#kvStore;
  }

  public async close(): Promise<void> {
    if (this.#driver) {
      await this.#driver.close();
    }
  }

  protected override async commit(
    next: ReadonlyMap<string, StoredDescriptorRevision>,
  ): Promise<void> {
    const grouped = new Map<string, StoredDescriptorRevision[]>();
    for (const record of next.values()) {
      const contractKey = `contract:${record.tenantId}:${record.contractName}`;
      let list = grouped.get(contractKey);
      if (!list) {
        list = [];
        grouped.set(contractKey, list);
      }
      list.push(record);
    }

    try {
      // Save each contract's revisions
      for (const [key, revisions] of grouped.entries()) {
        await this.#kvStore.set(key, revisions);
      }

      // Delete any contract keys that no longer exist
      for (const oldKey of this.#knownContractKeys) {
        if (!grouped.has(oldKey)) {
          await this.#kvStore.delete(oldKey);
        }
      }

      const currentKeys = Array.from(grouped.keys());
      await this.#kvStore.set(
        CONTRACTS_INDEX_KEY,
        currentKeys as unknown as readonly StoredDescriptorRevision[],
      );
      this.#knownContractKeys = new Set(currentKeys);
    } catch (error) {
      throw new DescriptorStoreError(
        "STORE_IO",
        "Failed to persist descriptor revisions to storage driver",
        { cause: error },
      );
    }
  }
}

import { randomUUID } from "node:crypto";
import {
  mkdir,
  open as openFile,
  readFile,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { z } from "zod";

import {
  InMemoryDescriptorRevisionStore,
  validateStoredRevision,
  type DescriptorStoreOptions,
} from "./store.js";
import {
  DESCRIPTOR_STORE_VERSION,
  DescriptorStoreError,
  MAX_DESCRIPTOR_STORE_BYTES,
  type StoredDescriptorRevision,
} from "./types.js";

const storeFileSchema = z
  .object({
    storeVersion: z.literal(DESCRIPTOR_STORE_VERSION),
    revisions: z
      .array(
        z
          .object({
            revisionId: z.string().min(1).max(64),
            tenantId: z.string().min(1).max(256),
            contractName: z.string().min(1).max(64),
            createdAt: z.number().int().nonnegative(),
            status: z.enum(["candidate", "active", "superseded", "failed"]),
            toolsetHash: z.string().min(1).max(128),
            descriptors: z.array(z.unknown()).min(1).max(1_000),
            toolRevisions: z
              .array(
                z
                  .object({
                    name: z.string().min(1).max(128),
                    revision: z.string().min(1).max(128),
                  })
                  .strict(),
              )
              .min(1)
              .max(1_000),
            gatewayRevisionId: z.string().min(1).max(128).optional(),
            publishedBy: z.string().min(1).max(128).optional(),
            rollbackOf: z.string().min(1).max(128).optional(),
          })
          .strict(),
      )
      .max(100_000),
  })
  .strict();

export interface FileDescriptorRevisionStoreOptions extends DescriptorStoreOptions {
  /** Path to a JSON store file. Created on first write with mode 0600. */
  readonly path: string;
  /** Serialized byte ceiling. Default 10 MiB; maximum 100 MiB. */
  readonly maxBytes?: number;
}

/**
 * Durable descriptor revision store backed by one JSON file.
 *
 * Writes serialize the whole snapshot to a sibling temporary file, `fsync` it,
 * and atomically rename it over the store path, so a crash leaves either the
 * old complete snapshot or the new one. The store is single-writer: two
 * processes must not open the same path concurrently. Use a database adapter
 * for multi-writer deployments.
 */
export class FileDescriptorRevisionStore extends InMemoryDescriptorRevisionStore {
  override readonly kind = "file";
  readonly path: string;
  readonly #maxBytes: number;

  private constructor(
    records: readonly StoredDescriptorRevision[],
    path: string,
    maxBytes: number,
    options: DescriptorStoreOptions,
  ) {
    super(records, options);
    this.path = path;
    this.#maxBytes = maxBytes;
  }

  static async open(
    options: FileDescriptorRevisionStoreOptions,
  ): Promise<FileDescriptorRevisionStore> {
    if (
      typeof options !== "object" ||
      options === null ||
      typeof options.path !== "string" ||
      options.path.trim().length === 0
    ) {
      throw new TypeError(
        "FileDescriptorRevisionStore requires a non-empty store path",
      );
    }

    const path = resolve(options.path);
    const maxBytes = options.maxBytes ?? MAX_DESCRIPTOR_STORE_BYTES;
    if (
      !Number.isInteger(maxBytes) ||
      maxBytes < 1_024 ||
      maxBytes > 100 * 1_048_576
    ) {
      throw new TypeError(
        "FileDescriptorRevisionStore maxBytes must be an integer between 1024 and 104857600",
      );
    }

    try {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    } catch (error) {
      throw new DescriptorStoreError(
        "STORE_IO",
        "Descriptor store directory could not be created",
        { cause: error },
      );
    }

    const records = await loadRecords(path, maxBytes);
    return new FileDescriptorRevisionStore(records, path, maxBytes, options);
  }

  protected override async commit(
    next: ReadonlyMap<string, StoredDescriptorRevision>,
  ): Promise<void> {
    const payload = `${JSON.stringify(
      {
        storeVersion: DESCRIPTOR_STORE_VERSION,
        revisions: [...next.values()],
      },
      null,
      2,
    )}\n`;

    if (Buffer.byteLength(payload, "utf8") > this.#maxBytes) {
      throw new DescriptorStoreError(
        "STORE_TOO_LARGE",
        `Descriptor store would exceed the ${this.#maxBytes} byte limit`,
      );
    }

    const temporaryPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const handle = await openFile(temporaryPath, "wx", 0o600);
      try {
        await handle.writeFile(payload, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporaryPath, this.path);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      if (error instanceof DescriptorStoreError) throw error;
      throw new DescriptorStoreError(
        "STORE_IO",
        "Descriptor store could not be written",
        { cause: error },
      );
    }

    await syncDirectory(dirname(this.path));
  }
}

async function loadRecords(
  path: string,
  maxBytes: number,
): Promise<readonly StoredDescriptorRevision[]> {
  let info;
  try {
    info = await stat(path);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return [];
    throw new DescriptorStoreError(
      "STORE_IO",
      "Descriptor store could not be read",
      { cause: error },
    );
  }

  if (!info.isFile()) {
    throw new DescriptorStoreError(
      "STORE_IO",
      "Descriptor store path is not a regular file",
    );
  }
  if (info.size > maxBytes) {
    throw new DescriptorStoreError(
      "STORE_TOO_LARGE",
      `Descriptor store exceeds the ${maxBytes} byte limit`,
    );
  }

  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    throw new DescriptorStoreError(
      "STORE_IO",
      "Descriptor store could not be read",
      { cause: error },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new DescriptorStoreError(
      "STORE_CORRUPT",
      "Descriptor store is not valid JSON",
      { cause: error },
    );
  }

  const result = storeFileSchema.safeParse(parsed);
  if (!result.success) {
    throw new DescriptorStoreError(
      "STORE_CORRUPT",
      "Descriptor store does not match the expected schema",
    );
  }

  const records = result.data
    .revisions as unknown as StoredDescriptorRevision[];
  for (const record of records) validateStoredRevision(record);
  return records;
}

async function syncDirectory(directory: string): Promise<void> {
  try {
    const handle = await openFile(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Directory fsync is unsupported on some platforms; the rename is still atomic.
  }
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

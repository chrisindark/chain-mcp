import { createHmac, randomBytes } from "node:crypto";
import { JsonNavigationError } from "./limits.js";

/**
 * Result handles for JSON navigation (P1-2).
 *
 * Large upstream documents are stored once, server-side, and handed to the
 * caller as an opaque, unguessable ID. The model then navigates the stored
 * document by handle instead of pasting the whole payload back inline.
 *
 * Invariants:
 * - Handles are tenant-scoped and principal-scoped. A handle created by
 *   principal `alice` cannot be navigated by principal `bob` even in the
 *   same tenant.
 * - `RESULT_HANDLE_EXPIRED` is the stable error for handles that never
 *   existed, were evicted, or have expired. Cross-tenant or
 *   cross-principal lookups use the same code so handles do not leak
 *   existence across scopes.
 * - Bounded: per-principal LRU, absolute entry cap, and a byte cap; the
 *   oldest entries are evicted (expired by the LRU rule, also reported as
 *   `RESULT_HANDLE_EXPIRED`). Total bytes across all stored documents are
 *   also capped.
 * - A handle is only minted when the caller opts in via `store` or
 *   `storeIfLarge`: `store` always mints (subject to the byte cap),
 *   `storeIfLarge` returns `null` below the `minBytes` threshold so the
 *   caller falls back to the inline path.
 *
 * Handle format: `rhv1.<counter>.<tag>` where `tag` is an HMAC-SHA256 of
 * `tenantId|principalId|counter` under a per-registry secret. The tenant
 * and principal ids are never embedded in plain text, and a tampered
 * handle fails HMAC verification — a counterparty cannot guess, rebind, or
 * forge a handle for another tenant by editing the body.
 */

export const RESULT_HANDLE_EXPIRED = "RESULT_HANDLE_EXPIRED";

export class ResultHandleExpiredError extends JsonNavigationError {
  readonly code = RESULT_HANDLE_EXPIRED;
  constructor() {
    super(
      `${RESULT_HANDLE_EXPIRED}: The result handle is unknown, expired, or not visible to this tenant and principal`,
    );
    this.name = "ResultHandleExpiredError";
  }
}

/** Returned when a document is too large to mint a handle. */
export class ResultHandleTooLargeError extends JsonNavigationError {
  readonly code = "RESULT_HANDLE_TOO_LARGE" as const;
  constructor(bytes: number, maxBytes: number) {
    super(
      `Result document (${bytes} bytes) exceeds the handle byte cap of ${maxBytes} bytes`,
    );
    this.name = "ResultHandleTooLargeError";
  }
}

export interface HandleRegistryOptions {
  /** Per-principal LRU capacity (handles). Defaults to 50. */
  maxPerPrincipal?: number | undefined;
  /** Per-tenant entry capacity (handles). Defaults to 250. */
  maxPerTenant?: number | undefined;
  /** Absolute handle capacity across all tenants. Defaults to 1,000. */
  maxTotal?: number | undefined;
  /** Byte cap per stored document. Defaults to 1,000,000 bytes. */
  maxBytes?: number | undefined;
  /** Total byte cap across all stored documents. Defaults to 8,000,000. */
  maxTotalBytes?: number | undefined;
  /** Handle TTL in ms. Defaults to 10 minutes. */
  ttlMs?: number | undefined;
  /** Minimum document byte size before a handle is minted. Defaults to 0 (always mint). */
  minBytes?: number | undefined;
  /** Seed for HMAC — when omitted a per-registry random secret is generated. */
  secret?: string | undefined;
  /** Clock, injectable for tests. Defaults to `Date.now`. */
  now?: (() => number) | undefined;
}

export interface PrincipalScope {
  tenantId: string;
  principalId: string;
}

interface StoredEntry {
  document: unknown;
  bytes: number;
  createdAt: number;
  expiresAt: number;
  lastUsedAt: number;
}

const DEFAULT_MAX_PER_PRINCIPAL = 50;
const DEFAULT_MAX_PER_TENANT = 250;
const DEFAULT_MAX_TOTAL = 1_000;
const DEFAULT_MAX_BYTES = 1_000_000;
const DEFAULT_MAX_TOTAL_BYTES = 8_000_000;
const DEFAULT_TTL_MS = 10 * 60_000;

export class ResultHandleRegistry {
  readonly maxPerPrincipal: number;
  readonly maxPerTenant: number;
  readonly maxTotal: number;
  readonly maxBytes: number;
  readonly maxTotalBytes: number;
  readonly ttlMs: number;
  readonly minBytes: number;
  private readonly secret: string;
  private readonly nowFn: () => number;
  // Map iteration order is insertion order; LRU is maintained by
  // delete+set on each access.
  private readonly entries = new Map<string, StoredEntry & PrincipalScope>();
  private readonly principalCounts = new Map<string, number>();
  private readonly tenantCounts = new Map<string, number>();
  private totalBytes = 0;
  private counter = 0;

  constructor(options?: HandleRegistryOptions) {
    this.maxPerPrincipal = Math.max(
      1,
      options?.maxPerPrincipal ?? DEFAULT_MAX_PER_PRINCIPAL,
    );
    this.maxPerTenant = Math.max(
      1,
      options?.maxPerTenant ?? DEFAULT_MAX_PER_TENANT,
    );
    this.maxTotal = Math.max(1, options?.maxTotal ?? DEFAULT_MAX_TOTAL);
    this.maxBytes = Math.max(1, options?.maxBytes ?? DEFAULT_MAX_BYTES);
    this.maxTotalBytes = Math.max(
      1,
      options?.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES,
    );
    this.ttlMs = Math.max(1, options?.ttlMs ?? DEFAULT_TTL_MS);
    this.minBytes = Math.max(0, options?.minBytes ?? 0);
    this.secret = options?.secret ?? randomBytes(32).toString("base64url");
    this.nowFn = options?.now ?? (() => Date.now());
  }

  /** Total stored handles. */
  get size(): number {
    return this.entries.size;
  }

  get totalBytesUsed(): number {
    return this.totalBytes;
  }

  /**
   * Serialize a document to bytes and return its size in UTF-8 bytes.
   * Throws on non-JSON values (circular refs, functions).
   */
  measureBytes(document: unknown): number {
    const serialized = JSON.stringify(document);
    if (serialized === undefined) {
      throw new JsonNavigationError("Result document is not JSON-serializable");
    }
    return Buffer.byteLength(serialized, "utf8");
  }

  /**
   * Store a document and return its handle. Throws
   * `ResultHandleTooLargeError` when the document exceeds the byte cap —
   * callers must not silently truncate or fall back to inline.
   */
  store(document: unknown, key: PrincipalScope): string {
    const bytes = this.measureBytes(document);
    if (bytes > this.maxBytes) {
      throw new ResultHandleTooLargeError(bytes, this.maxBytes);
    }
    return this.put(document, bytes, key);
  }

  /**
   * Store a document only when it is at least `minBytes`; returns `null`
   * below the threshold so the caller can use the inline path.
   */
  storeIfLarge(document: unknown, key: PrincipalScope): string | null {
    const bytes = this.measureBytes(document);
    if (bytes < this.minBytes) return null;
    if (bytes > this.maxBytes) {
      throw new ResultHandleTooLargeError(bytes, this.maxBytes);
    }
    return this.put(document, bytes, key);
  }

  /**
   * Resolve a handle to its document and refresh LRU recency.
   * Throws `ResultHandleExpiredError` for unknown, expired, tampered,
   * cross-tenant, or cross-principal handles.
   */
  resolve(handle: string, key: PrincipalScope): unknown {
    const entry = this.entries.get(handle);
    if (
      !entry ||
      entry.tenantId !== key.tenantId ||
      entry.principalId !== key.principalId ||
      !this.verifyTag(handle, entry)
    ) {
      throw new ResultHandleExpiredError();
    }
    const now = this.nowFn();
    if (now > entry.expiresAt) {
      this.delete(handle);
      throw new ResultHandleExpiredError();
    }
    // LRU refresh: move to the most-recently-used end.
    this.entries.delete(handle);
    this.entries.set(handle, { ...entry, lastUsedAt: now });
    return entry.document;
  }

  private put(document: unknown, bytes: number, key: PrincipalScope): string {
    const handle = this.mintHandle(key);
    const now = this.nowFn();
    this.entries.set(handle, {
      document,
      bytes,
      createdAt: now,
      expiresAt: now + this.ttlMs,
      lastUsedAt: now,
      tenantId: key.tenantId,
      principalId: key.principalId,
    });
    this.totalBytes += bytes;
    const pKey = this.scopedPrincipal(key);
    this.principalCounts.set(pKey, (this.principalCounts.get(pKey) ?? 0) + 1);
    this.tenantCounts.set(
      key.tenantId,
      (this.tenantCounts.get(key.tenantId) ?? 0) + 1,
    );
    this.evict(key, now);
    return handle;
  }

  private evict(key: PrincipalScope, now: number): void {
    // Expired entries first.
    for (const [handle, entry] of this.entries) {
      if (now > entry.expiresAt) this.delete(handle);
    }
    const pKey = this.scopedPrincipal(key);
    // Per-principal LRU cap.
    while ((this.principalCounts.get(pKey) ?? 0) > this.maxPerPrincipal) {
      const victim = this.oldestFor(
        (entry) =>
          entry.principalId === key.principalId &&
          entry.tenantId === key.tenantId,
      );
      if (!victim) break;
      this.delete(victim);
    }
    // Per-tenant cap.
    while ((this.tenantCounts.get(key.tenantId) ?? 0) > this.maxPerTenant) {
      const victim = this.oldestFor((entry) => entry.tenantId === key.tenantId);
      if (!victim) break;
      this.delete(victim);
    }
    // Total cap + total bytes cap.
    while (
      this.entries.size > this.maxTotal ||
      this.totalBytes > this.maxTotalBytes
    ) {
      const victim = this.oldestFor(() => true);
      if (!victim) break;
      this.delete(victim);
    }
  }

  private delete(handle: string): void {
    const entry = this.entries.get(handle);
    if (!entry) return;
    this.entries.delete(handle);
    this.totalBytes -= entry.bytes;
    const pKey = `${entry.tenantId}\0${entry.principalId}`;
    this.principalCounts.set(
      pKey,
      Math.max(0, (this.principalCounts.get(pKey) ?? 1) - 1),
    );
    this.tenantCounts.set(
      entry.tenantId,
      Math.max(0, (this.tenantCounts.get(entry.tenantId) ?? 1) - 1),
    );
  }

  /** Oldest (LRU-first) handle matching a predicate. */
  private oldestFor(
    predicate: (entry: StoredEntry & PrincipalScope) => boolean,
  ): string | undefined {
    for (const [handle, entry] of this.entries) {
      if (predicate(entry)) return handle;
    }
    return undefined;
  }

  private scopedPrincipal(key: PrincipalScope): string {
    return `${key.tenantId}\0${key.principalId}`;
  }

  private mintHandle(key: PrincipalScope): string {
    const counter = ++this.counter;
    const tag = this.tagFor(key.tenantId, key.principalId, counter);
    return `rhv1.${counter.toString(36)}.${tag}`;
  }

  private tagFor(
    tenantId: string,
    principalId: string,
    counter: number,
  ): string {
    return createHmac("sha256", this.secret)
      .update(`${tenantId}|${principalId}|${counter}`)
      .digest("base64url")
      .slice(0, 22);
  }

  /**
   * Verify the HMAC tag of a handle against the scope stored in its entry.
   * Scope is recovered from the entry, never parsed from the handle body,
   * and the tag is recomputed with the stored scope + counter so a
   * tampered handle fails verification even if the counter was edited.
   */
  private verifyTag(
    handle: string,
    entry: { tenantId: string; principalId: string },
  ): boolean {
    const parts = handle.split(".");
    if (parts.length !== 3 || parts[0] !== "rhv1") return false;
    const counter = parseInt(parts[1] ?? "", 36);
    if (!Number.isSafeInteger(counter) || counter < 1) return false;
    const expected = this.tagFor(entry.tenantId, entry.principalId, counter);
    return timingSafeEqual(expected, parts[2] ?? "");
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

import { performance } from "node:perf_hooks";

import { isCurrentCacheKey } from "./cache-key.js";
import type { CacheStore } from "./index.js";

export const DEFAULT_CACHE_MAX_ENTRIES = 1_000;
export const DEFAULT_CACHE_MAX_BYTES = 16 * 1024 * 1024;
export const DEFAULT_CACHE_MAX_ENTRY_BYTES = 256 * 1024;
export const DEFAULT_CACHE_MAX_TTL_SECONDS = 3_600;

const MAX_CACHE_VALUE_DEPTH = 64;
const MAX_CACHE_VALUE_NODES = 50_000;

export interface InMemoryCacheStoreOptions {
  /** Maximum number of retained entries. Defaults to 1,000. */
  maxEntries?: number;
  /** Maximum retained key plus serialized-value bytes. Defaults to 16 MiB. */
  maxBytes?: number;
  /** Maximum retained bytes for one key and serialized value. Defaults to 256 KiB. */
  maxEntryBytes?: number;
  /** Maximum accepted TTL. Defaults to 3,600 seconds. */
  maxTtlSeconds?: number;
  /** Monotonic clock in milliseconds; injectable for deterministic tests. */
  monotonicNow?: () => number;
}

interface CacheEntry {
  readonly serializedValue: string;
  readonly expiresAt: number;
  readonly bytes: number;
}

/**
 * A process-local LRU cache for development and tests. Entries are JSON-cloned
 * on write and read, and retained key/value bytes and entry count are bounded.
 */
export class InMemoryCacheStore implements CacheStore {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly maxEntryBytes: number;
  private readonly maxTtlSeconds: number;
  private readonly monotonicNow: () => number;
  private retainedBytes = 0;

  constructor(options: InMemoryCacheStoreOptions = {}) {
    this.maxEntries = positiveSafeInteger(
      options.maxEntries ?? DEFAULT_CACHE_MAX_ENTRIES,
      "maxEntries",
    );
    this.maxBytes = positiveSafeInteger(
      options.maxBytes ?? DEFAULT_CACHE_MAX_BYTES,
      "maxBytes",
    );
    this.maxEntryBytes = positiveSafeInteger(
      options.maxEntryBytes ?? DEFAULT_CACHE_MAX_ENTRY_BYTES,
      "maxEntryBytes",
    );
    this.maxTtlSeconds = positiveSafeInteger(
      options.maxTtlSeconds ?? DEFAULT_CACHE_MAX_TTL_SECONDS,
      "maxTtlSeconds",
    );
    if (this.maxEntryBytes > this.maxBytes) {
      throw new TypeError("maxEntryBytes must not exceed maxBytes");
    }
    if (
      options.monotonicNow !== undefined &&
      typeof options.monotonicNow !== "function"
    ) {
      throw new TypeError("monotonicNow must be a function");
    }
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
  }

  async get<T>(key: string): Promise<T | undefined> {
    assertHashedCacheKey(key);
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.monotonicNow()) {
      this.remove(key, entry);
      return undefined;
    }
    // Map insertion order tracks LRU-to-MRU, and parsing gives each caller an
    // independent value so mutations cannot poison a later cache hit.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return JSON.parse(entry.serializedValue) as T;
  }

  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    assertHashedCacheKey(key);
    if (
      !Number.isFinite(ttlSeconds) ||
      ttlSeconds <= 0 ||
      ttlSeconds > this.maxTtlSeconds
    ) {
      throw new TypeError(
        `ttlSeconds must be greater than 0 and at most ${this.maxTtlSeconds}`,
      );
    }

    assertJsonValue(value);
    let serializedValue: string | undefined;
    try {
      serializedValue = JSON.stringify(value);
    } catch {
      throw new TypeError("Cache values must be JSON-serializable");
    }
    if (serializedValue === undefined) {
      throw new TypeError("Cache values must be JSON-serializable");
    }
    const bytes =
      Buffer.byteLength(key, "utf8") +
      Buffer.byteLength(serializedValue, "utf8");
    if (bytes > this.maxEntryBytes) {
      throw new TypeError(
        `Cache entry exceeds the maximum of ${this.maxEntryBytes} bytes`,
      );
    }
    const expiresAt = this.monotonicNow() + ttlSeconds * 1_000;
    if (!Number.isFinite(expiresAt)) {
      throw new TypeError("Cache expiry must be a finite timestamp");
    }

    this.removeExpired();
    const previous = this.entries.get(key);
    if (previous) this.remove(key, previous);
    while (
      this.entries.size >= this.maxEntries ||
      this.retainedBytes + bytes > this.maxBytes
    ) {
      const oldest = this.entries.entries().next().value as
        [string, CacheEntry] | undefined;
      if (!oldest) break;
      this.remove(oldest[0], oldest[1]);
    }
    this.entries.set(key, { serializedValue, expiresAt, bytes });
    this.retainedBytes += bytes;
  }

  async delete(key: string): Promise<void> {
    assertHashedCacheKey(key);
    const entry = this.entries.get(key);
    if (entry) this.remove(key, entry);
  }

  private removeExpired(): void {
    const now = this.monotonicNow();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.remove(key, entry);
    }
  }

  private remove(key: string, entry: CacheEntry): void {
    this.entries.delete(key);
    this.retainedBytes -= entry.bytes;
  }
}

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function assertHashedCacheKey(key: string): void {
  if (!isCurrentCacheKey(key)) {
    throw new TypeError(
      "Cache keys must be current-version SHA-256 digests from createCacheKey",
    );
  }
}

function assertJsonValue(root: unknown): void {
  const ancestors = new Set<object>();
  const stack: Array<{ value: unknown; depth: number } | { exit: object }> = [
    { value: root, depth: 0 },
  ];
  let visitedNodes = 0;

  while (stack.length > 0) {
    const frame = stack.pop();
    if (!frame) continue;
    if ("exit" in frame) {
      ancestors.delete(frame.exit);
      continue;
    }
    visitedNodes += 1;
    if (visitedNodes > MAX_CACHE_VALUE_NODES) {
      throw new TypeError(
        `Cache values exceed the maximum of ${MAX_CACHE_VALUE_NODES} nodes`,
      );
    }
    const { value, depth } = frame;
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean"
    ) {
      continue;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        throw new TypeError("Cache values must contain only finite numbers");
      }
      continue;
    }
    if (typeof value !== "object" || value === null) {
      throw new TypeError("Cache values must be JSON-serializable");
    }
    if (depth >= MAX_CACHE_VALUE_DEPTH) {
      throw new TypeError(
        `Cache values exceed the maximum depth of ${MAX_CACHE_VALUE_DEPTH}`,
      );
    }
    if (ancestors.has(value)) {
      throw new TypeError("Cache values cannot contain cycles");
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new TypeError("Cache values cannot contain symbol properties");
    }

    ancestors.add(value);
    stack.push({ exit: value });
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        throw new TypeError("Cache arrays must be plain arrays");
      }
      assertNoCallableToJSON(value);
      if (value.length + visitedNodes > MAX_CACHE_VALUE_NODES) {
        throw new TypeError(
          `Cache values exceed the maximum of ${MAX_CACHE_VALUE_NODES} nodes`,
        );
      }
      const keys = Object.keys(value);
      if (
        keys.length !== value.length ||
        keys.some((key) => !isArrayIndex(key, value.length))
      ) {
        throw new TypeError(
          "Cache arrays cannot be sparse or have custom properties",
        );
      }
      for (let index = value.length - 1; index >= 0; index -= 1) {
        const descriptor = Object.getOwnPropertyDescriptor(
          value,
          String(index),
        );
        if (!descriptor || !("value" in descriptor)) {
          throw new TypeError("Cache values cannot contain accessors");
        }
        stack.push({ value: descriptor.value, depth: depth + 1 });
      }
      continue;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Cache objects must be plain objects");
    }
    assertNoCallableToJSON(value);
    const keys = Object.keys(value);
    if (keys.length + visitedNodes > MAX_CACHE_VALUE_NODES) {
      throw new TypeError(
        `Cache values exceed the maximum of ${MAX_CACHE_VALUE_NODES} nodes`,
      );
    }
    for (const key of keys.reverse()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) {
        throw new TypeError("Cache values cannot contain accessors");
      }
      stack.push({ value: descriptor.value, depth: depth + 1 });
    }
  }
}

function hasCallableToJSON(value: object): boolean {
  let current: object | null = value;
  while (current !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(current, "toJSON");
    if (descriptor) {
      if ("get" in descriptor) return descriptor.get !== undefined;
      return typeof descriptor.value === "function";
    }
    current = Object.getPrototypeOf(current) as object | null;
  }
  return false;
}

function assertNoCallableToJSON(value: object): void {
  // JSON.stringify invokes a callable toJSON even when it is inherited or
  // non-enumerable, which would escape the depth, node, and value checks.
  if (hasCallableToJSON(value)) {
    throw new TypeError("Cache values cannot define toJSON");
  }
}

function isArrayIndex(key: string, length: number): boolean {
  const index = Number(key);
  return (
    Number.isInteger(index) &&
    index >= 0 &&
    index < length &&
    String(index) === key
  );
}

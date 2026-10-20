export const CACHE_KEY_VERSION = "v2";
export const MAX_CACHE_KEY_INPUT_BYTES = 64 * 1024;

const CACHE_KEY_PREFIX = `chainmcp:cache:${CACHE_KEY_VERSION}:`;
const CACHE_KEY_HASH_DOMAIN = `chainmcp:cache-key:${CACHE_KEY_VERSION}\u0000`;
const CURRENT_CACHE_KEY_PATTERN = new RegExp(
  `^${CACHE_KEY_PREFIX}[a-f0-9]{64}$`,
);

export function cacheKeyPrefix(): string {
  return CACHE_KEY_PREFIX;
}

export function cacheKeyHashDomain(): string {
  return CACHE_KEY_HASH_DOMAIN;
}

export function isCurrentCacheKey(key: unknown): key is string {
  return typeof key === "string" && CURRENT_CACHE_KEY_PATTERN.test(key);
}

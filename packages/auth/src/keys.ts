import { createHash } from "node:crypto";

import {
  encodeSecretKeySegment,
  MAX_SECRET_KEY_LENGTH,
} from "./secret-store.js";

/**
 * Deterministic `SecretStore` keys for stored credential material.
 *
 * These keys are part of the public contract: an operator writes a secret once
 * (for example during deployment) and the matching provider must later derive
 * the same key. Values are base64url-encoded through `encodeSecretKeySegment`,
 * so tenant and principal identifiers that contain characters outside the
 * secret-store key grammar cannot break lookup or collide with another
 * identifier.
 *
 * Keys that would exceed the secret-store key length limit are replaced by a
 * SHA-256 digest of the readable form. The digest is stable for a given input,
 * so lookups, invalidation, and rotation stay consistent.
 */
function finalizeKey(prefix: string, readable: string): string {
  if (readable.length <= MAX_SECRET_KEY_LENGTH) return readable;
  return `${prefix}:h:${createHash("sha256").update(readable, "utf8").digest("hex")}`;
}

/**
 * Store key for an upstream credential.
 *
 * Passing `tenantId` derives the tenant-scoped key
 * `cred:v1:tenant:<tenant>:scheme:<scheme>`. Omitting it derives the
 * deployment-wide key `cred:v1:global:scheme:<scheme>` used for
 * single-tenant deployments and explicit shared credentials.
 */
export function buildCredentialStoreKey(options: {
  tenantId?: string;
  schemeName: string;
}): string {
  if (typeof options?.schemeName !== "string") {
    throw new TypeError("buildCredentialStoreKey requires a schemeName");
  }
  if (options.tenantId === undefined) {
    return finalizeKey(
      "cred:v1:global",
      `cred:v1:global:scheme:${encodeSecretKeySegment(options.schemeName)}`,
    );
  }
  return finalizeKey(
    "cred:v1:tenant",
    `cred:v1:tenant:tenant:${encodeSecretKeySegment(options.tenantId)}:scheme:${encodeSecretKeySegment(options.schemeName)}`,
  );
}

/**
 * Store key for a cached OAuth access token.
 *
 * `normalizedScopes` is the sorted, space-joined scope string produced by the
 * token provider, not a raw caller-supplied list, so an unordered or
 * duplicated scope list maps to the same key.
 */
export function buildOAuthTokenStoreKey(options: {
  tenantId: string;
  principalId?: string;
  schemeName: string;
  normalizedScopes: string;
}): string {
  const prefix = "oauth:token:v2";
  const segments = [
    options.tenantId,
    options.principalId ?? "",
    options.schemeName,
    options.normalizedScopes,
  ].map(encodeSecretKeySegment);
  return finalizeKey(prefix, [prefix, ...segments].join(":"));
}

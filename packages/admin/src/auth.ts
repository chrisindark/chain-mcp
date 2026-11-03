import { createHash, timingSafeEqual } from "node:crypto";

import {
  DeclarativeAdminError,
  MIN_DECLARATIVE_ADMIN_TOKEN_LENGTH,
  type DeclarativeAdminToken,
} from "./types.js";

const TOKEN_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_TOKEN_LENGTH = 4_096;

/** Authenticated caller, derived only from a matching configured token. */
export interface DeclarativeAdminPrincipal {
  readonly tokenId: string;
  readonly tenants: readonly string[] | "*";
}

/**
 * Validates static admin token configuration. Misconfiguration is a
 * programming/deployment error, so it throws a plain `TypeError` at
 * construction instead of producing per-request failures.
 */
export function validateAdminTokens(
  tokens: readonly DeclarativeAdminToken[],
): void {
  if (!Array.isArray(tokens) || tokens.length === 0) {
    throw new TypeError(
      "Declarative admin requires at least one configured bearer token",
    );
  }

  const ids = new Set<string>();
  const seen = new Set<string>();

  for (const token of tokens) {
    if (typeof token !== "object" || token === null) {
      throw new TypeError("Declarative admin tokens must be objects");
    }
    if (typeof token.id !== "string" || !TOKEN_ID.test(token.id)) {
      throw new TypeError(
        `Admin token id '${String(token.id)}' is invalid. Must be 1-64 alphanumeric characters, hyphens, or underscores`,
      );
    }
    if (ids.has(token.id)) {
      throw new TypeError(`Admin token id '${token.id}' is duplicated`);
    }
    ids.add(token.id);

    if (
      typeof token.token !== "string" ||
      token.token.length < MIN_DECLARATIVE_ADMIN_TOKEN_LENGTH ||
      token.token.length > MAX_TOKEN_LENGTH
    ) {
      throw new TypeError(
        `Admin token '${token.id}' must be a string between ${MIN_DECLARATIVE_ADMIN_TOKEN_LENGTH} and ${MAX_TOKEN_LENGTH} characters`,
      );
    }
    if (seen.has(token.token)) {
      throw new TypeError(`Admin token '${token.id}' duplicates another value`);
    }
    seen.add(token.token);

    assertTenantScope(token.id, token.tenants);
  }
}

function assertTenantScope(
  tokenId: string,
  tenants: readonly string[] | "*",
): void {
  if (tenants === "*") return;
  if (!Array.isArray(tenants) || tenants.length === 0) {
    throw new TypeError(
      `Admin token '${tokenId}' must declare a non-empty tenant list or "*"`,
    );
  }
  const unique = new Set<string>();
  for (const tenant of tenants) {
    if (typeof tenant !== "string" || tenant.trim().length === 0) {
      throw new TypeError(
        `Admin token '${tokenId}' has an empty or non-string tenant scope`,
      );
    }
    if (unique.has(tenant)) {
      throw new TypeError(
        `Admin token '${tokenId}' lists tenant '${tenant}' more than once`,
      );
    }
    unique.add(tenant);
  }
}

/** Parses the `Authorization` header into a candidate bearer value. */
export function extractBearerToken(header: string | null): string | undefined {
  if (header === null) return undefined;
  const match = /^Bearer[ \t]+([^ \t]+)$/i.exec(header.trim());
  return match?.[1];
}

/**
 * Verifies a presented bearer token against the configured set. Every
 * candidate is compared in constant time over fixed-length digests, and a
 * non-matching token never reveals which candidate was close.
 */
export function authenticateAdminToken(
  tokens: readonly DeclarativeAdminToken[],
  header: string | null,
): DeclarativeAdminPrincipal {
  if (header === null) {
    throw new DeclarativeAdminError(
      "ADMIN_AUTH_REQUIRED",
      401,
      "An admin bearer token is required",
    );
  }

  const presented = extractBearerToken(header);
  if (presented === undefined) {
    throw new DeclarativeAdminError(
      "ADMIN_AUTH_INVALID",
      401,
      "Authorization header must use the Bearer scheme",
    );
  }

  const presentedDigest = createHash("sha256").update(presented).digest();
  let matched: DeclarativeAdminToken | undefined;

  for (const candidate of tokens) {
    const candidateDigest = createHash("sha256")
      .update(candidate.token)
      .digest();
    if (timingSafeEqual(candidateDigest, presentedDigest) && !matched) {
      matched = candidate;
    }
  }

  if (matched === undefined) {
    throw new DeclarativeAdminError(
      "ADMIN_AUTH_INVALID",
      401,
      "Admin bearer token is not recognized",
    );
  }

  return { tokenId: matched.id, tenants: matched.tenants };
}

/**
 * Enforces tenant scope before any contract lookup, so a token cannot probe
 * which tenant/contract pairs exist outside its scope.
 */
export function assertTenantAllowed(
  principal: DeclarativeAdminPrincipal,
  tenantId: string,
): void {
  if (principal.tenants === "*") return;
  if (!principal.tenants.includes(tenantId)) {
    throw new DeclarativeAdminError(
      "ADMIN_TENANT_FORBIDDEN",
      403,
      "This admin token is not scoped to the requested tenant",
    );
  }
}

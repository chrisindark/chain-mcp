import { buildOAuthTokenStoreKey } from "./keys.js";
import type {
  CredentialResolutionContext,
  TokenEndpointFetcher,
  TokenEndpointFetchOptions,
  TokenEndpointResponse,
  UpstreamCredential,
  UpstreamCredentialProvider,
} from "./credentials.js";
import type { SecretStore } from "./secret-store.js";

export type OAuthTokenResponse = TokenEndpointResponse;
export type OAuthTokenFetcher = TokenEndpointFetcher;
export type OAuthTokenFetcherOptions = TokenEndpointFetchOptions;

/**
 * Configuration for the OAuth 2.0 client credentials provider.
 *
 * The token endpoint is a network destination like any upstream host, so it
 * must be allowlisted. When the provider runs inside `@chainmcp/executor`, the
 * executor supplies a pinned fetcher via `context.tokenEndpointFetch` and the
 * endpoint is resolved, classified, and pinned by the outbound policy. Used
 * standalone, the built-in fetcher requires `allowedTokenHosts` (or the
 * explicit `allowAnyTokenHost` opt-out), refuses redirects, and enforces HTTPS.
 */
export interface OAuthClientCredentialsConfig {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scopes?: readonly string[];
  /** Allowed scheme names this provider handles. Defaults to all oauth2 schemes. */
  schemeNames?: readonly string[];
  /** Expiry safety margin in seconds. Defaults to 30s. */
  expirySkewSeconds?: number;
  /** Exact hostnames permitted for the token endpoint. */
  allowedTokenHosts?: readonly string[];
  /** Explicit opt-out from token host allowlisting for the built-in fetcher. */
  allowAnyTokenHost?: boolean;
  /** Permit a plain-HTTP token endpoint. Disabled by default. */
  allowInsecureHttp?: boolean;
  /** Injectable token fetcher. Defaults to the built-in hardened fetcher. */
  fetchToken?: OAuthTokenFetcher;
  /** Optional persistent store for cached tokens. */
  tokenStore?: SecretStore;
  /** Wall clock provider for testing. Defaults to `Date.now`. */
  now?: () => number;
}

interface CachedToken {
  accessToken: string;
  tokenType: string;
  expiresAt?: number;
  scopes?: readonly string[];
}

interface TokenCacheIdentity {
  /** Secret-store-safe cache key, also used as the in-memory key. */
  storeKey: string;
  tenantId: string;
  schemeName: string;
  principalId: string;
  normalizedScopes: string;
}

interface TokenCacheEntry extends TokenCacheIdentity {
  token: CachedToken;
}

export class OAuthClientCredentialsProvider implements UpstreamCredentialProvider {
  private readonly tokenUrl: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly scopes: readonly string[];
  private readonly schemeNames: Set<string> | undefined;
  private readonly expirySkewSeconds: number;
  private readonly fetchToken: OAuthTokenFetcher;
  private readonly tokenStore: SecretStore | undefined;
  private readonly now: () => number;
  private readonly allowedTokenHosts: readonly string[];
  private readonly allowAnyTokenHost: boolean;
  private readonly allowInsecureHttp: boolean;

  private readonly memoryCache = new Map<string, TokenCacheEntry>();

  constructor(config: OAuthClientCredentialsConfig) {
    if (!config || typeof config !== "object") {
      throw new TypeError("OAuthClientCredentialsProvider requires config");
    }
    if (
      typeof config.tokenUrl !== "string" ||
      config.tokenUrl.trim().length === 0
    ) {
      throw new TypeError("tokenUrl must be a non-empty string");
    }
    if (
      typeof config.clientId !== "string" ||
      config.clientId.trim().length === 0
    ) {
      throw new TypeError("clientId must be a non-empty string");
    }
    if (
      typeof config.clientSecret !== "string" ||
      config.clientSecret.length === 0
    ) {
      throw new TypeError("clientSecret must be a non-empty string");
    }

    this.tokenUrl = config.tokenUrl.trim();
    this.clientId = config.clientId.trim();
    this.clientSecret = config.clientSecret;
    this.scopes = [...(config.scopes ?? [])];
    this.schemeNames = config.schemeNames
      ? new Set(config.schemeNames)
      : undefined;
    this.expirySkewSeconds = Math.max(0, config.expirySkewSeconds ?? 30);
    this.fetchToken = config.fetchToken ?? defaultTokenFetcher;
    this.tokenStore = config.tokenStore;
    this.now = config.now ?? (() => Date.now());
    this.allowedTokenHosts = normalizeAllowedTokenHosts(
      config.allowedTokenHosts,
    );
    this.allowAnyTokenHost = config.allowAnyTokenHost === true;
    this.allowInsecureHttp = config.allowInsecureHttp === true;
  }

  async resolveCredential(
    context: CredentialResolutionContext,
  ): Promise<UpstreamCredential | undefined> {
    if (
      context.schemeType !== "oauth2" &&
      context.schemeType !== "openIdConnect"
    ) {
      return undefined;
    }
    if (this.schemeNames && !this.schemeNames.has(context.schemeName)) {
      return undefined;
    }

    const scopesToRequest =
      context.requiredScopes && context.requiredScopes.length > 0
        ? context.requiredScopes
        : this.scopes;
    const normalizedScopes = normalizeScopes(scopesToRequest);
    const identity: TokenCacheIdentity = {
      storeKey: buildOAuthTokenStoreKey({
        tenantId: context.tenantId,
        principalId: context.principalId ?? "",
        schemeName: context.schemeName,
        normalizedScopes,
      }),
      tenantId: context.tenantId,
      schemeName: context.schemeName,
      principalId: context.principalId ?? "",
      normalizedScopes,
    };
    const cached = await this.loadToken(identity);

    const currentTime = this.now();
    const isExpired =
      cached !== undefined &&
      cached.expiresAt !== undefined &&
      currentTime >= cached.expiresAt - this.expirySkewSeconds * 1000;

    if (cached !== undefined && !isExpired) {
      return toOAuthCredential(cached);
    }

    // Acquire a new token via the client credentials grant. A client
    // credentials grant has no refresh token: expiry means re-acquire.
    const token = await this.fetchNewToken(context, scopesToRequest);
    await this.storeToken(identity, token);
    return toOAuthCredential(token);
  }

  /**
   * Revokes cached tokens for the given partition and removes the matching
   * entries from the configured `tokenStore`.
   *
   * With no arguments, every token this instance knows about is removed,
   * including its persistent copy. Entries written by another process that this
   * instance never loaded cannot be enumerated, because `SecretStore` has no
   * scan operation; for cross-process revocation delete
   * `buildOAuthTokenStoreKey(...)` from the shared store, or rely on token
   * expiry.
   */
  async invalidate(
    tenantId?: string,
    schemeName?: string,
    principalId?: string,
  ): Promise<void> {
    const removed: TokenCacheEntry[] = [];
    for (const entry of this.memoryCache.values()) {
      if (tenantId !== undefined && entry.tenantId !== tenantId) continue;
      if (schemeName !== undefined && entry.schemeName !== schemeName) continue;
      if (principalId !== undefined && entry.principalId !== principalId) {
        continue;
      }
      removed.push(entry);
    }
    for (const entry of removed) {
      this.memoryCache.delete(entry.storeKey);
      if (this.tokenStore !== undefined) {
        try {
          await this.tokenStore.delete(entry.storeKey);
        } catch {
          // Revocation of the persistent copy is best effort; the in-memory
          // entry is already gone.
        }
      }
    }
  }

  private async loadToken(
    identity: TokenCacheIdentity,
  ): Promise<CachedToken | undefined> {
    const memory = this.memoryCache.get(identity.storeKey);
    if (memory !== undefined) return memory.token;

    if (this.tokenStore === undefined) return undefined;

    let raw: string | undefined;
    try {
      raw = await this.tokenStore.get(identity.storeKey);
    } catch {
      // The token store is a cache: a read failure bypasses the cache instead
      // of failing credential resolution.
      return undefined;
    }
    if (raw === undefined || raw === null) return undefined;

    const token = parseCachedToken(raw);
    if (token === undefined) return undefined;
    this.memoryCache.set(identity.storeKey, { ...identity, token });
    return token;
  }

  private async storeToken(
    identity: TokenCacheIdentity,
    token: CachedToken,
  ): Promise<void> {
    this.memoryCache.set(identity.storeKey, { ...identity, token });
    if (this.tokenStore === undefined) return;
    try {
      await this.tokenStore.set(identity.storeKey, JSON.stringify(token));
    } catch {
      // Token cache persistence failure must not fail token resolution.
    }
  }

  private async fetchNewToken(
    context: CredentialResolutionContext,
    scopesToRequest: readonly string[],
  ): Promise<CachedToken> {
    const body = new URLSearchParams();
    body.set("grant_type", "client_credentials");

    if (scopesToRequest.length > 0) {
      body.set("scope", scopesToRequest.join(" "));
    }

    const basicAuth = Buffer.from(
      `${this.clientId}:${this.clientSecret}`,
      "utf8",
    ).toString("base64");

    const headers: Record<string, string> = {
      authorization: `Basic ${basicAuth}`,
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    };

    // An executor-supplied fetcher owns the outbound policy for the token
    // endpoint and takes precedence over the locally configured fetcher.
    const fetchToken = context.tokenEndpointFetch ?? this.fetchToken;
    const fetchOptions: TokenEndpointFetchOptions = {
      ...(context.signal !== undefined ? { signal: context.signal } : {}),
      ...(this.allowedTokenHosts.length > 0
        ? { allowedHosts: this.allowedTokenHosts }
        : {}),
      ...(this.allowAnyTokenHost ? { allowAnyTokenHost: true } : {}),
      ...(this.allowInsecureHttp ? { allowInsecureHttp: true } : {}),
    };

    const response = await fetchToken(
      this.tokenUrl,
      body,
      headers,
      fetchOptions,
    );

    if (
      !response ||
      typeof response.access_token !== "string" ||
      response.access_token.length === 0
    ) {
      throw new Error("OAuth token endpoint did not return an access_token");
    }

    const expiresAt =
      typeof response.expires_in === "number" &&
      Number.isFinite(response.expires_in) &&
      response.expires_in > 0
        ? this.now() + response.expires_in * 1000
        : undefined;

    const returnedScopes =
      typeof response.scope === "string"
        ? response.scope.split(/\s+/).filter(Boolean)
        : scopesToRequest.length > 0
          ? scopesToRequest
          : undefined;

    return {
      accessToken: response.access_token,
      tokenType:
        typeof response.token_type === "string" &&
        response.token_type.length > 0
          ? response.token_type
          : "Bearer",
      ...(expiresAt !== undefined ? { expiresAt } : {}),
      ...(returnedScopes !== undefined ? { scopes: returnedScopes } : {}),
    };
  }
}

function toOAuthCredential(token: CachedToken): UpstreamCredential {
  return {
    type: "oauth2",
    token: token.accessToken,
    tokenType: token.tokenType,
    ...(token.expiresAt !== undefined ? { expiresAt: token.expiresAt } : {}),
    ...(token.scopes !== undefined ? { scopes: token.scopes } : {}),
  };
}

/** Validates a persisted token entry, discarding anything malformed. */
function parseCachedToken(raw: string): CachedToken | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const candidate = parsed as Record<string, unknown>;
  if (
    typeof candidate.accessToken !== "string" ||
    candidate.accessToken.length === 0
  ) {
    return undefined;
  }
  const expiresAt =
    typeof candidate.expiresAt === "number" &&
    Number.isFinite(candidate.expiresAt)
      ? candidate.expiresAt
      : undefined;
  const scopes =
    Array.isArray(candidate.scopes) &&
    candidate.scopes.every((scope) => typeof scope === "string")
      ? (candidate.scopes as string[])
      : undefined;
  return {
    accessToken: candidate.accessToken,
    tokenType:
      typeof candidate.tokenType === "string" && candidate.tokenType.length > 0
        ? candidate.tokenType
        : "Bearer",
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(scopes !== undefined ? { scopes } : {}),
  };
}

export const DEFAULT_TOKEN_TIMEOUT_MS = 10_000;
export const MAX_TOKEN_RESPONSE_BYTES = 64 * 1024; // 64 KiB
export const MAX_TOKEN_URL_LENGTH = 8_192;

function normalizeScopes(scopes: readonly string[]): string {
  if (scopes.length === 0) return "";
  const unique = Array.from(
    new Set(scopes.map((s) => s.trim()).filter((s) => s.length > 0)),
  );
  unique.sort();
  return unique.join(" ");
}

/** Normalizes an allowlisted token host for exact comparison. */
function normalizeTokenEndpointHost(raw: string): string {
  let host = raw.trim().toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) return host;
  try {
    const parsed = new URL(`https://${host}`);
    if (
      parsed.username.length > 0 ||
      parsed.password.length > 0 ||
      parsed.port.length > 0 ||
      parsed.pathname !== "/" ||
      parsed.search.length > 0 ||
      parsed.hash.length > 0
    ) {
      throw new TypeError("invalid");
    }
    host = parsed.hostname.toLowerCase();
  } catch {
    throw new TypeError(`Allowed token host '${raw}' is not a valid hostname`);
  }
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (host.length === 0 || host.length > 253) {
    throw new TypeError(`Allowed token host '${raw}' is not a valid hostname`);
  }
  return host;
}

function normalizeAllowedTokenHosts(raw: unknown): readonly string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new TypeError("allowedTokenHosts must be an array of hostnames");
  }
  const hosts = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== "string" || entry.includes("*")) {
      throw new TypeError(
        "Allowed token hosts must be exact hostnames without wildcards",
      );
    }
    hosts.add(normalizeTokenEndpointHost(entry));
  }
  return [...hosts];
}

/**
 * Applies the token endpoint policy: declared protocol, no embedded
 * credentials, explicit host allowlist, and a length cap. Redirects are
 * refused by the fetcher instead of being followed to a new origin.
 */
function assertTokenEndpoint(
  rawUrl: string,
  options?: TokenEndpointFetchOptions,
): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new TypeError("OAuth token URL is not a valid URL");
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new TypeError("OAuth token URL must not contain credentials");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new TypeError("OAuth token URL must use HTTP or HTTPS");
  }
  if (url.protocol === "http:" && options?.allowInsecureHttp !== true) {
    throw new Error(
      "Plain HTTP OAuth token URLs are disabled; set allowInsecureHttp to opt in",
    );
  }
  const allowedHosts = normalizeAllowedTokenHosts(options?.allowedHosts);
  if (allowedHosts.length > 0) {
    if (!allowedHosts.includes(normalizeTokenEndpointHost(url.hostname))) {
      throw new Error("OAuth token endpoint host is not allowlisted");
    }
  } else if (options?.allowAnyTokenHost !== true) {
    throw new Error(
      "OAuth token endpoint host must be allowlisted: configure allowedTokenHosts, or opt out explicitly with allowAnyTokenHost",
    );
  }
  url.hash = "";
  if (url.href.length > MAX_TOKEN_URL_LENGTH) {
    throw new Error("OAuth token URL is too long");
  }
  return url;
}

/**
 * Built-in token fetcher for standalone use.
 *
 * Guarantees: HTTPS unless explicitly allowed, no URL credentials, an explicit
 * host allowlist (or an explicit opt-out), no redirects, a total timeout, and a
 * bounded response body. It uses the platform fetch, so the validated address
 * is not pinned; deployments that need DNS pinning and private-range
 * classification should run the provider through `@chainmcp/executor`, which
 * supplies a pinned fetcher.
 */
export async function defaultTokenFetcher(
  url: string,
  body: URLSearchParams,
  headers: Readonly<Record<string, string>>,
  options?: TokenEndpointFetchOptions,
): Promise<OAuthTokenResponse> {
  const endpoint = assertTokenEndpoint(url, options);
  const maxResponseBytes =
    typeof options?.maxResponseBytes === "number" &&
    Number.isFinite(options.maxResponseBytes) &&
    options.maxResponseBytes > 0
      ? options.maxResponseBytes
      : MAX_TOKEN_RESPONSE_BYTES;

  const controller = new AbortController();
  const callerSignal = options?.signal;

  if (callerSignal?.aborted) {
    throw callerSignal.reason ?? new Error("Aborted");
  }

  const onCallerAbort = () => {
    controller.abort(callerSignal?.reason);
  };

  if (callerSignal) {
    callerSignal.addEventListener("abort", onCallerAbort, { once: true });
  }

  const timeoutId = setTimeout(() => {
    controller.abort(
      new Error(
        `OAuth token fetch timed out after ${DEFAULT_TOKEN_TIMEOUT_MS}ms`,
      ),
    );
  }, DEFAULT_TOKEN_TIMEOUT_MS);

  try {
    const response = await fetch(endpoint.href, {
      method: "POST",
      headers,
      body: body.toString(),
      redirect: "manual",
      signal: controller.signal,
    });

    if (response.status >= 300 && response.status < 400) {
      throw new Error("OAuth token endpoint redirects are not followed");
    }

    if (!response.ok) {
      throw new Error(`OAuth token endpoint returned HTTP ${response.status}`);
    }

    const contentType = response.headers.get("content-type") ?? "";
    const lowerCt = contentType.toLowerCase();
    if (!lowerCt.includes("application/json") && !lowerCt.includes("+json")) {
      throw new Error(
        `OAuth token endpoint returned non-JSON content-type: ${contentType}`,
      );
    }

    let rawText: string;
    if (response.body && typeof response.body.getReader === "function") {
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let totalBytes = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            totalBytes += value.byteLength;
            if (totalBytes > maxResponseBytes) {
              throw new Error(
                `OAuth token response exceeded maximum size of ${maxResponseBytes} bytes`,
              );
            }
            chunks.push(value);
          }
        }
      } finally {
        reader.releaseLock();
      }
      rawText = Buffer.concat(chunks).toString("utf8");
    } else {
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > maxResponseBytes) {
        throw new Error(
          `OAuth token response exceeded maximum size of ${maxResponseBytes} bytes`,
        );
      }
      rawText = Buffer.from(buffer).toString("utf8");
    }

    const data = JSON.parse(rawText) as OAuthTokenResponse;
    return data;
  } finally {
    clearTimeout(timeoutId);
    if (callerSignal) {
      callerSignal.removeEventListener("abort", onCallerAbort);
    }
  }
}

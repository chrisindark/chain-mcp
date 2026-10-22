import type {
  CredentialResolutionContext,
  UpstreamCredential,
  UpstreamCredentialProvider,
} from "./credentials.js";
import type { SecretStore } from "./secret-store.js";

export interface OAuthTokenResponse {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
  refresh_token?: string;
}

export interface OAuthTokenFetcherOptions {
  signal?: AbortSignal;
}

export type OAuthTokenFetcher = (
  url: string,
  body: URLSearchParams,
  headers: Readonly<Record<string, string>>,
  options?: OAuthTokenFetcherOptions,
) => Promise<OAuthTokenResponse>;

export interface OAuthClientCredentialsConfig {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scopes?: readonly string[];
  /** Allowed scheme names this provider handles. Defaults to all oauth2 schemes. */
  schemeNames?: readonly string[];
  /** Expiry safety margin in seconds. Defaults to 30s. */
  expirySkewSeconds?: number;
  /** Injectable token fetcher. Defaults to global `fetch`. */
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

  private memoryCache = new Map<string, CachedToken>();

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
    const principalKey = context.principalId ?? "";
    const cacheKey = `oauth:token:${context.tenantId}:${principalKey}:${context.schemeName}:${normalizedScopes}`;
    const cached = await this.getCachedToken(cacheKey);

    const currentTime = this.now();
    const isExpired =
      cached &&
      cached.expiresAt !== undefined &&
      currentTime >= cached.expiresAt - this.expirySkewSeconds * 1000;

    if (cached && !isExpired) {
      return {
        type: "oauth2",
        token: cached.accessToken,
        tokenType: cached.tokenType,
        ...(cached.expiresAt !== undefined
          ? { expiresAt: cached.expiresAt }
          : {}),
        ...(cached.scopes ? { scopes: cached.scopes } : {}),
      };
    }

    // Acquire new token via Client Credentials grant
    const token = await this.fetchNewToken(context, scopesToRequest);
    await this.setCachedToken(cacheKey, token);

    return {
      type: "oauth2",
      token: token.accessToken,
      tokenType: token.tokenType,
      ...(token.expiresAt !== undefined ? { expiresAt: token.expiresAt } : {}),
      ...(token.scopes ? { scopes: token.scopes } : {}),
    };
  }

  /**
   * Invalidates any cached token for the given tenant, scheme, and optional principal (or all tokens if omitted).
   */
  async invalidate(
    tenantId?: string,
    schemeName?: string,
    principalId?: string,
  ): Promise<void> {
    if (!tenantId) {
      this.memoryCache.clear();
      return;
    }
    const prefix = `oauth:token:${tenantId}:`;
    const toDelete: string[] = [];
    for (const key of this.memoryCache.keys()) {
      if (!key.startsWith(prefix)) continue;
      const parts = key.split(":");
      const keyPrincipal = parts[3];
      const keyScheme = parts[4];
      if (principalId !== undefined && keyPrincipal !== principalId) {
        continue;
      }
      if (schemeName !== undefined && keyScheme !== schemeName) {
        continue;
      }
      toDelete.push(key);
    }
    for (const key of toDelete) {
      this.memoryCache.delete(key);
      if (this.tokenStore) {
        await this.tokenStore.delete(key).catch(() => {});
      }
    }
  }

  private async getCachedToken(key: string): Promise<CachedToken | undefined> {
    const memory = this.memoryCache.get(key);
    if (memory) return memory;

    if (this.tokenStore) {
      const raw = await this.tokenStore.get(key);
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as CachedToken;
          if (parsed && typeof parsed.accessToken === "string") {
            this.memoryCache.set(key, parsed);
            return parsed;
          }
        } catch {
          // Bad stored token, ignore
        }
      }
    }
    return undefined;
  }

  private async setCachedToken(key: string, token: CachedToken): Promise<void> {
    this.memoryCache.set(key, token);
    if (this.tokenStore) {
      try {
        await this.tokenStore.set(key, JSON.stringify(token));
      } catch {
        // Token cache persistence failure must not fail token resolution
      }
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

    const fetchOptions =
      context.signal !== undefined ? { signal: context.signal } : undefined;
    const response = await this.fetchToken(
      this.tokenUrl,
      body,
      headers,
      fetchOptions,
    );

    if (!response || typeof response.access_token !== "string") {
      throw new Error("OAuth token endpoint did not return an access_token");
    }

    const expiresAt =
      typeof response.expires_in === "number" && response.expires_in > 0
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
      tokenType: response.token_type ?? "Bearer",
      ...(expiresAt !== undefined ? { expiresAt } : {}),
      ...(returnedScopes ? { scopes: returnedScopes } : {}),
    };
  }
}

export const DEFAULT_TOKEN_TIMEOUT_MS = 10_000;
export const MAX_TOKEN_RESPONSE_BYTES = 64 * 1024; // 64 KiB

function normalizeScopes(scopes: readonly string[]): string {
  if (scopes.length === 0) return "";
  const unique = Array.from(
    new Set(scopes.map((s) => s.trim()).filter((s) => s.length > 0)),
  );
  unique.sort();
  return unique.join(" ");
}

export async function defaultTokenFetcher(
  url: string,
  body: URLSearchParams,
  headers: Readonly<Record<string, string>>,
  options?: OAuthTokenFetcherOptions,
): Promise<OAuthTokenResponse> {
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
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: body.toString(),
      signal: controller.signal,
    });

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
            if (totalBytes > MAX_TOKEN_RESPONSE_BYTES) {
              throw new Error(
                `OAuth token response exceeded maximum size of ${MAX_TOKEN_RESPONSE_BYTES} bytes`,
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
      if (buffer.byteLength > MAX_TOKEN_RESPONSE_BYTES) {
        throw new Error(
          `OAuth token response exceeded maximum size of ${MAX_TOKEN_RESPONSE_BYTES} bytes`,
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

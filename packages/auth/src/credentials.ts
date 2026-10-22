import { buildCredentialStoreKey } from "./keys.js";
import type { SecretStore } from "./secret-store.js";

export type UpstreamCredential =
  | {
      type: "apiKey";
      name: string;
      location: "header" | "query" | "cookie";
      value: string;
    }
  | {
      type: "http";
      scheme: "bearer";
      token: string;
    }
  | {
      type: "http";
      scheme: "basic";
      username: string;
      password: string;
    }
  | {
      type: "oauth2";
      token: string;
      tokenType?: string;
      expiresAt?: number;
      scopes?: readonly string[];
    };

export interface CredentialResolutionContext {
  tenantId: string;
  principalId?: string;
  toolName: string;
  schemeName: string;
  schemeType: string;
  parameterName?: string;
  parameterLocation?: "header" | "query" | "cookie";
  httpScheme?: string;
  requiredScopes?: readonly string[];
  signal?: AbortSignal;
  /**
   * Egress fetcher for OAuth token endpoints, supplied by the caller that owns
   * the outbound request policy (`@chainmcp/executor`). When present, OAuth
   * providers use it instead of the built-in platform fetch, so token requests
   * inherit allowlisting, address classification, pinning, and caps.
   */
  tokenEndpointFetch?: TokenEndpointFetcher;
}

/** Signature of an injectable OAuth token endpoint fetcher. */
export type TokenEndpointFetcher = (
  url: string,
  body: URLSearchParams,
  headers: Readonly<Record<string, string>>,
  options?: TokenEndpointFetchOptions,
) => Promise<TokenEndpointResponse>;

export interface TokenEndpointFetchOptions {
  signal?: AbortSignal;
  /** Exact hostnames permitted for the token endpoint. */
  allowedHosts?: readonly string[];
  /**
   * Explicit opt-out from host allowlisting for the built-in fetcher. Do not
   * enable this in deployments that reach untrusted networks.
   */
  allowAnyTokenHost?: boolean;
  /** Permit plain-HTTP token endpoints. Disabled by default. */
  allowInsecureHttp?: boolean;
  /** Maximum accepted token response size in bytes. */
  maxResponseBytes?: number;
}

/** Minimal response shape an injected token fetcher must return. */
export interface TokenEndpointResponse {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
  refresh_token?: string;
}

export interface UpstreamCredentialProvider {
  resolveCredential(
    context: CredentialResolutionContext,
  ): Promise<UpstreamCredential | undefined>;
}

export type StaticCredentialValue =
  UpstreamCredential | string | { username: string; password: string };

export type StaticCredentialResolver = (
  context: CredentialResolutionContext,
) =>
  | StaticCredentialValue
  | undefined
  | Promise<StaticCredentialValue | undefined>;

export interface StaticCredentialProviderOptions {
  /**
   * Static credentials mapped by scheme name, or resolver functions.
   */
  credentials: Record<
    string,
    StaticCredentialValue | StaticCredentialResolver | undefined
  >;
}

export class StaticCredentialProvider implements UpstreamCredentialProvider {
  private readonly credentials: Record<
    string,
    StaticCredentialValue | StaticCredentialResolver | undefined
  >;

  constructor(options: StaticCredentialProviderOptions) {
    if (
      !options ||
      typeof options.credentials !== "object" ||
      options.credentials === null
    ) {
      throw new TypeError(
        "StaticCredentialProvider requires credentials object",
      );
    }
    this.credentials = { ...options.credentials };
  }

  async resolveCredential(
    context: CredentialResolutionContext,
  ): Promise<UpstreamCredential | undefined> {
    const entry = this.credentials[context.schemeName];
    if (entry === undefined) return undefined;

    const value = typeof entry === "function" ? await entry(context) : entry;
    if (value === undefined) return undefined;

    return normalizeCredentialValue(value, context);
  }
}

export interface EnvCredentialProviderOptions {
  /** Prefix for environment variables. Defaults to `CHAINMCP_AUTH_`. */
  prefix?: string;
  /** Explicit map from scheme name to environment variable name. */
  mappings?: Record<string, string>;
  /** Optional custom environment dictionary. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
}

export class EnvCredentialProvider implements UpstreamCredentialProvider {
  private readonly prefix: string;
  private readonly mappings: Record<string, string>;
  private readonly env: Record<string, string | undefined>;

  constructor(options: EnvCredentialProviderOptions = {}) {
    this.prefix = options.prefix ?? "CHAINMCP_AUTH_";
    this.mappings = { ...(options.mappings ?? {}) };
    this.env = options.env ?? process.env;
  }

  async resolveCredential(
    context: CredentialResolutionContext,
  ): Promise<UpstreamCredential | undefined> {
    let envVarName = this.mappings[context.schemeName];
    if (!envVarName) {
      const sanitizedScheme = context.schemeName
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "_");
      envVarName = `${this.prefix}${sanitizedScheme}`;
    }

    const rawValue = this.env[envVarName];
    if (rawValue === undefined || rawValue.trim().length === 0) {
      return undefined;
    }

    return normalizeCredentialValue(rawValue.trim(), context);
  }
}

export interface SecretStoreCredentialProviderOptions {
  store: SecretStore;
  /**
   * Opt in to the deployment-wide fallback key when no tenant-scoped secret
   * exists. Disabled by default so a missing per-tenant secret fails closed
   * instead of silently authenticating with a shared credential.
   */
  allowGlobalFallback?: boolean;
  /**
   * Custom key derivation function. The default derives the tenant-scoped key
   * `buildCredentialStoreKey({ tenantId, schemeName })`, and falls back to
   * `buildCredentialStoreKey({ schemeName })` when `allowGlobalFallback` is on.
   */
  deriveStoreKey?: (
    context: CredentialResolutionContext,
  ) => string | readonly string[];
}

export class SecretStoreCredentialProvider implements UpstreamCredentialProvider {
  private readonly store: SecretStore;
  private readonly deriveStoreKey: (
    context: CredentialResolutionContext,
  ) => string | readonly string[];

  constructor(options: SecretStoreCredentialProviderOptions) {
    if (!options || !options.store || typeof options.store.get !== "function") {
      throw new TypeError(
        "SecretStoreCredentialProvider requires a valid SecretStore",
      );
    }
    this.store = options.store;
    this.deriveStoreKey =
      options.deriveStoreKey ??
      (options.allowGlobalFallback === true
        ? (ctx) => [
            buildCredentialStoreKey({
              tenantId: ctx.tenantId,
              schemeName: ctx.schemeName,
            }),
            buildCredentialStoreKey({ schemeName: ctx.schemeName }),
          ]
        : (ctx) =>
            buildCredentialStoreKey({
              tenantId: ctx.tenantId,
              schemeName: ctx.schemeName,
            }));
  }

  async resolveCredential(
    context: CredentialResolutionContext,
  ): Promise<UpstreamCredential | undefined> {
    const candidateKeys = this.deriveStoreKey(context);
    const keys = Array.isArray(candidateKeys) ? candidateKeys : [candidateKeys];

    for (const key of keys) {
      if (typeof key !== "string" || key.trim().length === 0) continue;
      const raw = await this.store.get(key);
      if (raw !== undefined && raw.trim().length > 0) {
        return normalizeCredentialValue(raw.trim(), context);
      }
    }

    return undefined;
  }
}

export class CompositeCredentialProvider implements UpstreamCredentialProvider {
  private readonly providers: readonly UpstreamCredentialProvider[];

  constructor(providers: readonly UpstreamCredentialProvider[]) {
    if (!Array.isArray(providers)) {
      throw new TypeError(
        "CompositeCredentialProvider requires an array of providers",
      );
    }
    this.providers = [...providers];
  }

  async resolveCredential(
    context: CredentialResolutionContext,
  ): Promise<UpstreamCredential | undefined> {
    for (const provider of this.providers) {
      const resolved = await provider.resolveCredential(context);
      if (resolved !== undefined) {
        return resolved;
      }
    }
    return undefined;
  }
}

const CREDENTIAL_LOCATIONS = new Set<string>(["header", "query", "cookie"]);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Validates credential material and returns a usable credential, or
 * `undefined` when the value is not a valid credential.
 *
 * Credential values are an untrusted boundary: they come from environment
 * variables, secret stores, and third-party provider implementations, so the
 * runtime checks the shape before the value reaches request construction.
 * Invalid material is treated as unresolved, which fails closed. Messages
 * never echo a credential value.
 */
export function normalizeUpstreamCredential(
  value: unknown,
): UpstreamCredential | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Record<string, unknown>;

  switch (candidate.type) {
    case "apiKey": {
      if (!isNonEmptyString(candidate.name)) return undefined;
      if (
        typeof candidate.location !== "string" ||
        !CREDENTIAL_LOCATIONS.has(candidate.location)
      ) {
        return undefined;
      }
      if (!isNonEmptyString(candidate.value)) return undefined;
      return {
        type: "apiKey",
        name: candidate.name,
        location: candidate.location as "header" | "query" | "cookie",
        value: candidate.value,
      };
    }
    case "http": {
      if (candidate.scheme === "bearer") {
        if (!isNonEmptyString(candidate.token)) return undefined;
        return { type: "http", scheme: "bearer", token: candidate.token };
      }
      if (candidate.scheme === "basic") {
        if (
          typeof candidate.username !== "string" ||
          typeof candidate.password !== "string"
        ) {
          return undefined;
        }
        if (
          candidate.username.length === 0 &&
          candidate.password.length === 0
        ) {
          return undefined;
        }
        return {
          type: "http",
          scheme: "basic",
          username: candidate.username,
          password: candidate.password,
        };
      }
      return undefined;
    }
    case "oauth2": {
      if (!isNonEmptyString(candidate.token)) return undefined;
      // Optional fields are either valid or absent. Silently dropping a
      // malformed value would let invalid credential material pass as valid.
      if (
        candidate.tokenType !== undefined &&
        !isNonEmptyString(candidate.tokenType)
      ) {
        return undefined;
      }
      if (
        candidate.expiresAt !== undefined &&
        !(
          typeof candidate.expiresAt === "number" &&
          Number.isFinite(candidate.expiresAt)
        )
      ) {
        return undefined;
      }
      if (
        candidate.scopes !== undefined &&
        !(
          Array.isArray(candidate.scopes) &&
          candidate.scopes.every((scope) => typeof scope === "string")
        )
      ) {
        return undefined;
      }
      return {
        type: "oauth2",
        token: candidate.token,
        ...(candidate.tokenType !== undefined
          ? { tokenType: candidate.tokenType as string }
          : {}),
        ...(candidate.expiresAt !== undefined
          ? { expiresAt: candidate.expiresAt as number }
          : {}),
        ...(candidate.scopes !== undefined
          ? { scopes: candidate.scopes as readonly string[] }
          : {}),
      };
    }
    default:
      return undefined;
  }
}

/** Parses a JSON credential object, returning undefined for any other text. */
function parseJsonCredentialObject(
  value: string,
): Record<string, unknown> | undefined {
  if (!value.startsWith("{") || !value.endsWith("}")) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return undefined;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/**
 * Interprets a bare secret string using the scheme declared by the contract.
 * A declared `basic` scheme without a `user:password` separator is malformed
 * and resolves to no credential rather than being sent as a bearer token.
 */
function credentialFromSecret(
  secret: string,
  context: CredentialResolutionContext,
  extra: {
    tokenType?: string;
    scopes?: readonly string[];
    expiresAt?: number;
  } = {},
): UpstreamCredential | undefined {
  if (context.schemeType === "apiKey") {
    return normalizeUpstreamCredential({
      type: "apiKey",
      name: context.parameterName ?? context.schemeName,
      location: context.parameterLocation ?? "header",
      value: secret,
    });
  }

  if (context.schemeType === "http") {
    if (context.httpScheme?.toLowerCase() === "basic") {
      const colonIndex = secret.indexOf(":");
      if (colonIndex <= 0) return undefined;
      return normalizeUpstreamCredential({
        type: "http",
        scheme: "basic",
        username: secret.slice(0, colonIndex),
        password: secret.slice(colonIndex + 1),
      });
    }
    return normalizeUpstreamCredential({
      type: "http",
      scheme: "bearer",
      token: secret,
    });
  }

  if (
    context.schemeType === "oauth2" ||
    context.schemeType === "openIdConnect"
  ) {
    return normalizeUpstreamCredential({
      type: "oauth2",
      token: secret,
      ...extra,
    });
  }

  return undefined;
}

function normalizeCredentialValue(
  value: unknown,
  context: CredentialResolutionContext,
): UpstreamCredential | undefined {
  if (typeof value === "string") {
    const parsed = parseJsonCredentialObject(value);
    if (parsed !== undefined) {
      // A fully specified credential object is validated as-is.
      const direct = normalizeUpstreamCredential(parsed);
      if (direct !== undefined) return direct;
      // Otherwise a JSON envelope may carry a bare token for the declared
      // scheme, for example `{"token": "..."}` from an external secret.
      const token = isNonEmptyString(parsed.token)
        ? parsed.token
        : isNonEmptyString(parsed.value)
          ? parsed.value
          : undefined;
      if (token === undefined) return undefined;
      return credentialFromSecret(token, context, {
        ...(isNonEmptyString(parsed.tokenType)
          ? { tokenType: parsed.tokenType }
          : {}),
        ...(typeof parsed.expiresAt === "number" &&
        Number.isFinite(parsed.expiresAt)
          ? { expiresAt: parsed.expiresAt }
          : {}),
        ...(Array.isArray(parsed.scopes) &&
        parsed.scopes.every((scope) => typeof scope === "string")
          ? { scopes: parsed.scopes as string[] }
          : {}),
      });
    }
    return credentialFromSecret(value, context);
  }

  if (typeof value === "object" && value !== null) {
    const candidate = value as Record<string, unknown>;
    if (
      !("type" in candidate) &&
      "username" in candidate &&
      "password" in candidate
    ) {
      return normalizeUpstreamCredential({
        type: "http",
        scheme: "basic",
        username: candidate.username,
        password: candidate.password,
      });
    }
    return normalizeUpstreamCredential(value);
  }

  return undefined;
}

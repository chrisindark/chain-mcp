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
   * Custom key derivation function. Default derives:
   * `tenant:<tenantId>:scheme:<schemeName>`, falling back to `scheme:<schemeName>`.
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
      ((ctx) => [
        `tenant:${ctx.tenantId}:scheme:${ctx.schemeName}`,
        `scheme:${ctx.schemeName}`,
      ]);
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

function normalizeCredentialValue(
  value: StaticCredentialValue,
  context: CredentialResolutionContext,
): UpstreamCredential | undefined {
  if (typeof value === "object" && "type" in value) {
    return value;
  }

  if (typeof value === "object" && "username" in value && "password" in value) {
    return {
      type: "http",
      scheme: "basic",
      username: value.username,
      password: value.password,
    };
  }

  if (typeof value === "string") {
    // Try parsing as JSON credential object first
    if (value.startsWith("{") && value.endsWith("}")) {
      try {
        const parsed = JSON.parse(value) as Record<string, unknown>;
        if (typeof parsed === "object" && parsed !== null) {
          if (parsed.type === "apiKey" && typeof parsed.value === "string") {
            return {
              type: "apiKey",
              name:
                (parsed.name as string) ??
                context.parameterName ??
                context.schemeName,
              location:
                (parsed.location as "header" | "query" | "cookie") ??
                context.parameterLocation ??
                "header",
              value: parsed.value,
            };
          }
          if (
            parsed.type === "http" &&
            parsed.scheme === "basic" &&
            typeof parsed.username === "string" &&
            typeof parsed.password === "string"
          ) {
            return {
              type: "http",
              scheme: "basic",
              username: parsed.username,
              password: parsed.password,
            };
          }
          if (
            (parsed.type === "http" && parsed.scheme === "bearer") ||
            typeof parsed.token === "string"
          ) {
            const token = (parsed.token as string) ?? (parsed.value as string);
            if (typeof token === "string") {
              if (context.schemeType === "oauth2") {
                return {
                  type: "oauth2",
                  token,
                  tokenType: (parsed.tokenType as string) ?? "Bearer",
                  ...(typeof parsed.expiresAt === "number"
                    ? { expiresAt: parsed.expiresAt }
                    : {}),
                  ...(Array.isArray(parsed.scopes)
                    ? { scopes: parsed.scopes as string[] }
                    : {}),
                };
              }
              return {
                type: "http",
                scheme: "bearer",
                token,
              };
            }
          }
        }
      } catch {
        // Fall back to plain string interpretation below
      }
    }

    // Direct string secret
    if (context.schemeType === "apiKey") {
      return {
        type: "apiKey",
        name: context.parameterName ?? context.schemeName,
        location: context.parameterLocation ?? "header",
        value,
      };
    }

    if (context.schemeType === "http") {
      const httpScheme = context.httpScheme?.toLowerCase();
      if (httpScheme === "basic") {
        const colonIndex = value.indexOf(":");
        if (colonIndex > 0) {
          return {
            type: "http",
            scheme: "basic",
            username: value.slice(0, colonIndex),
            password: value.slice(colonIndex + 1),
          };
        }
      }
      return {
        type: "http",
        scheme: "bearer",
        token: value,
      };
    }

    if (
      context.schemeType === "oauth2" ||
      context.schemeType === "openIdConnect"
    ) {
      return {
        type: "oauth2",
        token: value,
        tokenType: "Bearer",
      };
    }
  }

  return undefined;
}

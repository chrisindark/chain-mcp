import type {
  FieldSelection,
  JsonSchema,
  ToolCachePolicy,
  ToolOutputPolicy,
} from "@chainmcp/core";

/** Only descriptor version 1 is understood by this package. */
export const DECLARATIVE_DESCRIPTOR_VERSION = 1 as const;

/** Maximum UTF-8 size accepted by `parseDeclarativeToolDescriptorJson`. */
export const MAX_DESCRIPTOR_BYTES = 262_144;
export const MAX_DECLARATIVE_DESCRIPTORS = 1_000;
export const MAX_DECLARATIVE_PARAMETERS = 64;
export const MAX_DECLARATIVE_PROPERTIES = 64;
export const MAX_DECLARATIVE_AUTH_ALTERNATIVES = 8;
export const MAX_DECLARATIVE_AUTH_SCHEMES = 8;
export const MAX_DECLARATIVE_PATH_LENGTH = 2_048;
export const MAX_DECLARATIVE_DESCRIPTION_LENGTH = 4_096;
export const MAX_DECLARATIVE_SCOPES = 32;
export const MAX_DECLARATIVE_CACHE_TTL_SECONDS = 604_800;
export const MAX_DECLARATIVE_TIMEOUT_MS = 120_000;

export type DeclarativeHttpMethod =
  "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";

export type DeclarativeParameterLocation =
  "path" | "query" | "header" | "cookie";

/**
 * Binds one input property to a request location. `required` must be true for
 * path parameters and must agree with the schema's `required` list.
 */
export interface DeclarativeParameterDescriptor {
  name: string;
  in: DeclarativeParameterLocation;
  required?: boolean;
}

/**
 * Declares a JSON request body bound to the `body` input property. Version 1
 * supports JSON media types only.
 */
export interface DeclarativeRequestBodyDescriptor {
  /** Defaults to `application/json`. */
  mediaType?: string;
  /** Defaults to false. A required body must appear in the schema required list. */
  required?: boolean;
}

export interface DeclarativeRequestDescriptor {
  method: DeclarativeHttpMethod;
  /** Same-origin path template such as `/users/{userId}`. */
  path: string;
  parameters?: readonly DeclarativeParameterDescriptor[];
  body?: DeclarativeRequestBodyDescriptor;
}

/**
 * A named reference to a deployment-configured credential scheme. The
 * descriptor never contains secret material.
 */
export interface DeclarativeSecuritySchemeReference {
  name: string;
  /** Required OAuth 2.0 scopes. Rejected for non-OAuth schemes. */
  scopes?: readonly string[];
}

/** An AND set of scheme references. An empty set allows anonymous access. */
export interface DeclarativeSecurityAlternative {
  schemes: readonly DeclarativeSecuritySchemeReference[];
}

/** An OR list of authentication alternatives. */
export interface DeclarativeAuthenticationDescriptor {
  alternatives: readonly DeclarativeSecurityAlternative[];
}

export interface DeclarativePolicyDescriptor {
  /** Inbound scopes enforced by the runtime authorizer, not upstream scopes. */
  requiredScopes?: readonly string[];
  /** Opt-in cache TTL; read methods only. */
  cacheTtlSeconds?: number;
  /** Output token budget applied by the runtime projector. */
  maxOutputTokens?: number;
  /** Declarative include/exclude field projection. */
  outputFields?: FieldSelection;
  /** Cooperative execution timeout in milliseconds. */
  timeoutMs?: number;
}

/**
 * A versioned, declarative HTTP tool. Everything is data: no code, template
 * expression, URL, secret, or header name owned by the transport is accepted.
 */
export interface DeclarativeToolDescriptor {
  descriptorVersion: typeof DECLARATIVE_DESCRIPTOR_VERSION;
  name: string;
  description: string;
  enabled?: boolean;
  request: DeclarativeRequestDescriptor;
  inputSchema: JsonSchema;
  authentication?: DeclarativeAuthenticationDescriptor;
  policy?: DeclarativePolicyDescriptor;
}

/**
 * Credential shape for one named scheme. Secrets stay in the executor's
 * `UpstreamCredentialProvider`; this map only says how a resolved credential is
 * injected.
 */
export type DeclarativeAuthScheme =
  | {
      type: "apiKey";
      parameterName: string;
      parameterLocation: "query" | "header" | "cookie";
    }
  | {
      type: "http";
      httpScheme: "basic" | "bearer";
      bearerFormat?: string;
    }
  | { type: "oauth2" };

export type DeclarativeAuthSchemeMap = Readonly<
  Record<string, DeclarativeAuthScheme>
>;

export type DeclarativeDescriptorErrorCode =
  | "DESCRIPTOR_INVALID"
  | "DESCRIPTOR_TOO_LARGE"
  | "DESCRIPTOR_VERSION_UNSUPPORTED"
  | "NAME_INVALID"
  | "NAME_DUPLICATE"
  | "DESCRIPTION_INVALID"
  | "METHOD_UNSUPPORTED"
  | "PATH_INVALID"
  | "PARAMETER_INVALID"
  | "BODY_INVALID"
  | "SCHEMA_INVALID"
  | "BINDING_INVALID"
  | "AUTH_SCHEME_UNKNOWN"
  | "AUTH_SCHEME_INVALID"
  | "POLICY_INVALID"
  | "EXECUTOR_INVALID";

export interface DeclarativeDescriptorIssue {
  /** Location such as `request.parameters[0].name`. */
  path: string;
  message: string;
}

/**
 * Typed descriptor failure. `code` is stable for callers such as an admin API;
 * `issues` carries actionable locations and never contains descriptor secrets
 * (descriptors cannot contain secrets).
 */
export class DeclarativeDescriptorError extends Error {
  readonly issues: readonly DeclarativeDescriptorIssue[];

  constructor(
    readonly code: DeclarativeDescriptorErrorCode,
    message: string,
    issues: readonly DeclarativeDescriptorIssue[] = [],
  ) {
    super(message);
    this.name = "DeclarativeDescriptorError";
    this.issues = issues;
  }
}

/** Normalized policy values applied to the generated `ToolDefinition`. */
export interface NormalizedDeclarativePolicy {
  requiredScopes?: readonly string[];
  cache?: ToolCachePolicy;
  output?: ToolOutputPolicy;
  timeoutMs?: number;
}

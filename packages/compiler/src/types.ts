import type { JsonSchema, OperationPolicy } from "@chainmcp/core";

/** Supported OpenAPI major/minor families. Patch versions are informational. */
export type OpenApiVersion = "3.0" | "3.1";

export type HttpMethod =
  "get" | "put" | "post" | "delete" | "options" | "head" | "patch" | "trace";

export type DiagnosticSeverity = "error" | "warning";

export type CompileDiagnosticCode =
  | "SOURCE_TOO_LARGE"
  | "SOURCE_PARSE_FAILED"
  | "DOCUMENT_INVALID"
  | "OPENAPI_VERSION_UNSUPPORTED"
  | "PATH_INVALID"
  | "OPERATION_INVALID"
  | "OPERATION_LIMIT_EXCEEDED"
  | "OPERATION_ID_INVALID"
  | "DEPRECATED_OPERATION"
  | "TOOL_NAME_NORMALIZED"
  | "TOOL_NAME_COLLISION"
  | "DESCRIPTION_TRUNCATED"
  | "PARAMETER_INVALID"
  | "PARAMETER_DUPLICATE"
  | "PARAMETER_UNSUPPORTED"
  | "REQUEST_BODY_INVALID"
  | "REQUEST_BODY_UNSUPPORTED"
  | "RESPONSE_INVALID"
  | "RESPONSE_UNSUPPORTED"
  | "REF_INVALID"
  | "REF_REMOTE_UNSUPPORTED"
  | "REF_CYCLE"
  | "REF_DEPTH_EXCEEDED"
  | "REF_SIBLINGS_UNSUPPORTED"
  | "SCHEMA_INVALID"
  | "SCHEMA_COMPOSITION_UNSUPPORTED"
  | "SCHEMA_UNSUPPORTED"
  | "SCHEMA_NULLABLE_INVALID"
  | "SECURITY_INVALID"
  | "SECURITY_REQUIREMENT_INVALID"
  | "SECURITY_SCHEME_INVALID"
  | "UNSUPPORTED_SERVERS"
  | "UNSUPPORTED_CALLBACKS"
  | "CONFIG_DEPRECATED"
  | "INTERNAL_ERROR";

export interface CompileDiagnostic {
  severity: DiagnosticSeverity;
  code: CompileDiagnosticCode;
  message: string;
  /** JSON pointer-like location, for example `#/paths/~1pets/get`. */
  location?: string;
}

export interface CompileOptions {
  /**
   * When true (default), unsupported validation constraints are errors and the
   * affected operation is not emitted. When false, constraints that can be
   * dropped without changing the supported schema subset are reported as
   * warnings; composition and unsafe constructs remain errors.
   */
  strict?: boolean;
  /** Include operations marked `deprecated: true`. Default false. */
  includeDeprecated?: boolean;
  /** Maximum UTF-8 source size. Default 5 MiB; maximum 25 MiB. */
  maxSourceBytes?: number;
  /** Maximum local `$ref` chain depth. Default 32; maximum 128. */
  maxRefDepth?: number;
  /** Maximum number of operations considered. Default 1,000; maximum 10,000. */
  maxOperations?: number;
}

/**
 * One alternative in an OpenAPI `security` array. Keys are scheme names and
 * values are required scopes. Keys inside one object are combined with AND;
 * entries in the array are alternatives combined with OR.
 */
export type SecurityRequirement = Readonly<Record<string, readonly string[]>>;

export type SecuritySchemeType =
  "apiKey" | "http" | "oauth2" | "openIdConnect" | "mutualTLS";

export interface CompiledSecurityScheme {
  name: string;
  type: SecuritySchemeType;
  description?: string;
  parameterName?: string;
  parameterLocation?: "query" | "header" | "cookie";
  scheme?: string;
  bearerFormat?: string;
  openIdConnectUrl?: string;
  flows?: Readonly<Record<string, unknown>>;
}

/**
 * Parameter binding metadata needed to build an upstream request. The schema
 * itself is represented in `inputSchema`; this record only says where an input
 * value belongs.
 */
export interface CompiledParameter {
  name: string;
  in: "path" | "query" | "header";
  required: boolean;
}

/** Request-body binding metadata for the `body` input property. */
export interface CompiledRequestBody {
  mediaType: string;
  required: boolean;
}

/**
 * Declared response metadata. Response schemas are descriptive: neither the
 * compiler nor the executor validates upstream payloads against them yet.
 */
export interface CompiledResponse {
  /** Exact status code, `default`, or a `1XX`-`5XX` range (OpenAPI 3.1). */
  status: string;
  description: string;
  /**
   * Selected response media type. JSON media types are preferred; when only
   * non-JSON content is declared, the first media type in code-unit order is
   * recorded without a schema.
   */
  mediaType?: string;
  /** Translated response schema metadata; not used for runtime validation. */
  schema?: JsonSchema;
}

/**
 * One scheme inside an authentication alternative. All schemes in an
 * alternative are required together (AND). The copied credential metadata
 * makes the policy actionable without re-reading the source document.
 */
export interface CompiledAuthenticationScheme {
  name: string;
  type: SecuritySchemeType;
  /** Required OAuth2/OpenID Connect scopes; empty for other scheme types. */
  scopes: readonly string[];
  /** API key parameter name and location. */
  parameterName?: string;
  parameterLocation?: "query" | "header" | "cookie";
  /** HTTP authentication scheme such as `basic` or `bearer`. */
  httpScheme?: string;
  bearerFormat?: string;
  openIdConnectUrl?: string;
  /** OAuth2 flow definitions from the contract. */
  flows?: Readonly<Record<string, unknown>>;
}

/**
 * One alternative in an OR list. Schemes inside `schemes` are ANDed. An
 * alternative with no schemes represents anonymous access.
 */
export interface CompiledAuthenticationAlternative {
  schemes: readonly CompiledAuthenticationScheme[];
}

/**
 * Explicit authentication policy derived from OpenAPI security requirements.
 * The array is an OR list; each alternative is an AND list. An empty
 * `alternatives` array means no authentication is declared.
 *
 * This is compiler metadata. Authentication and credential injection are not
 * enforced by the current runtime or executor.
 */
export interface CompiledAuthenticationPolicy {
  alternatives: readonly CompiledAuthenticationAlternative[];
  /** True when at least one alternative requires no scheme. */
  allowsAnonymous: boolean;
}

/**
 * Compiler output metadata for one operation. `@chainmcp/executor` can bind it
 * to a runtime `ToolDefinition`; credential injection and response validation
 * remain deferred.
 */
export interface CompiledOperation {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  operation: OperationPolicy;
  method: HttpMethod;
  path: string;
  operationId?: string;
  /** GET and HEAD are safe to consider for opt-in caching later. */
  readOnly: boolean;
  deprecated: boolean;
  /** Path, query, and header parameter bindings sorted by input name. */
  parameters: readonly CompiledParameter[];
  /** Present when the operation accepts a JSON request body. */
  requestBody?: CompiledRequestBody;
  /** Declared responses in deterministic status-key order. */
  responses: readonly CompiledResponse[];
  /** Resolved contract-level or operation-level security alternatives. */
  security: readonly SecurityRequirement[];
  /** Explicit OR/AND authentication policy derived from `security`. */
  authentication: CompiledAuthenticationPolicy;
  sourceLocation: string;
  warnings?: readonly CompileDiagnostic[];
}

export interface ManifestToolEntry {
  name: string;
  hash: string;
}

export interface CompileManifest {
  manifestVersion: 1;
  compilerVersion: string;
  openapiVersion: OpenApiVersion | "unknown";
  sourceHash: string;
  contractRevision: string;
  toolsetHash: string;
  toolCount: number;
  tools: readonly ManifestToolEntry[];
  warnings?: readonly CompileDiagnostic[];
}

export interface CompileResult {
  ok: boolean;
  tools: readonly CompiledOperation[];
  diagnostics: readonly CompileDiagnostic[];
  securitySchemes: Readonly<Record<string, CompiledSecurityScheme>>;
  sourceHash: string;
  contractRevision: string;
  manifest: CompileManifest;
}

export interface CompileDiff {
  added: readonly string[];
  removed: readonly string[];
  changed: readonly string[];
  unchanged: readonly string[];
}

export interface ContractCompiler {
  compile(source: string, options?: CompileOptions): Promise<CompileResult>;
}

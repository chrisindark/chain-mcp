# API Reference: @chainmcp/compiler

## `@chainmcp/compiler`

`@chainmcp/compiler` parses and validates OpenAPI 3.0 and 3.1 documents and emits deterministic operation metadata, including parameter bindings, request-body metadata, response schemas, and authentication policies. The compiler itself does not execute anything. `@chainmcp/executor` turns an emitted `CompiledOperation` into a runnable `ToolDefinition` with bounded upstream I/O and an explicit destination policy. Credential injection, response validation, and generated-server/CLI wiring remain unimplemented.

```ts
export type OpenApiVersion = "3.0" | "3.1";

export interface CompileOptions {
  strict?: boolean;
  includeDeprecated?: boolean;
  maxSourceBytes?: number;
  maxRefDepth?: number;
  maxOperations?: number;
}

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
  | "UNSUPPORTED_SECURITY_SCHEME"
  | "UNSUPPORTED_SERVERS"
  | "UNSUPPORTED_CALLBACKS"
  | "CONFIG_DEPRECATED"
  | "SECRET_UNRESOLVED"
  | "INTERNAL_ERROR";

export interface CompileDiagnostic {
  severity: "error" | "warning";
  code: CompileDiagnosticCode;
  message: string;
  location?: string;
}

export type SecurityRequirement = Readonly<Record<string, readonly string[]>>;

export interface CompiledSecurityScheme {
  name: string;
  type: "apiKey" | "http" | "oauth2" | "openIdConnect" | "mutualTLS";
  description?: string;
  parameterName?: string;
  parameterLocation?: "query" | "header" | "cookie";
  scheme?: string;
  bearerFormat?: string;
  openIdConnectUrl?: string;
  flows?: Readonly<Record<string, unknown>>;
}

export interface CompiledAuthenticationScheme {
  name: string;
  type: "apiKey" | "http" | "oauth2" | "openIdConnect" | "mutualTLS";
  scopes: readonly string[];
  parameterName?: string;
  parameterLocation?: "query" | "header" | "cookie";
  httpScheme?: string;
  bearerFormat?: string;
  openIdConnectUrl?: string;
  flows?: Readonly<Record<string, unknown>>;
}

export interface CompiledAuthenticationAlternative {
  /** Schemes that must all be satisfied together (AND). */
  schemes: readonly CompiledAuthenticationScheme[];
}

export interface CompiledAuthenticationPolicy {
  /** OR alternatives; empty means no authentication is declared. */
  alternatives: readonly CompiledAuthenticationAlternative[];
  /** True when at least one alternative requires no scheme. */
  allowsAnonymous: boolean;
}

export interface CompiledParameter {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  required: boolean;
  style?: string;
  explode?: boolean;
}

export type RequestBodyKind = "json" | "form-urlencoded" | "multipart";

export interface CompiledEncoding {
  contentType?: string;
  style?: string;
  explode?: boolean;
}

export interface CompiledRequestBody {
  mediaType: string;
  required: boolean;
  kind?: RequestBodyKind;
  encodings?: Readonly<Record<string, CompiledEncoding>>;
}

export interface CompiledResponse {
  status: string;
  description: string;
  mediaType?: string;
  schema?: JsonSchema;
}

export interface CompiledOperation {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  operation: OperationPolicy;
  method: HttpMethod;
  path: string;
  operationId?: string;
  readOnly: boolean;
  deprecated: boolean;
  parameters: readonly CompiledParameter[];
  requestBody?: CompiledRequestBody;
  responses: readonly CompiledResponse[];
  security: readonly SecurityRequirement[];
  authentication: CompiledAuthenticationPolicy;
  sourceLocation: string;
  warnings?: readonly CompileDiagnostic[];
}

export interface CompileManifest {
  manifestVersion: 1;
  compilerVersion: string;
  openapiVersion: OpenApiVersion | "unknown";
  sourceHash: string;
  contractRevision: string;
  toolsetHash: string;
  toolCount: number;
  tools: readonly { name: string; hash: string }[];
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

export interface ContractCompiler {
  compile(source: string, options?: CompileOptions): Promise<CompileResult>;
}

export class OpenApiCompiler implements ContractCompiler {}

export function compileOpenApi(
  source: string,
  options?: CompileOptions,
): CompileResult;

export function diffManifests(
  previous: CompileManifest,
  next: CompileManifest,
): {
  added: readonly string[];
  removed: readonly string[];
  changed: readonly string[];
  unchanged: readonly string[];
};

export function diffContracts(
  previous: ContractDiffInput,
  next: ContractDiffInput,
): ContractDiffResult;
```

`compile`/`compileOpenApi` accept one YAML or JSON document (YAML 1.2 core schema, duplicate keys rejected). Compilation is offline and asynchronous only to match the interface: it performs no filesystem or network I/O. Defaults are `strict: true`, `includeDeprecated: false`, `maxSourceBytes: 5 MiB` (hard maximum 25 MiB), `maxRefDepth: 32` (maximum 128), and `maxOperations: 1,000` (maximum 10,000). Invalid option types and exceeded hard maxima throw `TypeError`; document and contract problems are returned as diagnostics.

`ok` is false when any diagnostic has severity `error`. The compiler keeps compiling independent operations after a failure, but never emits an operation with an error. Deprecated operations are excluded with a warning by default. In strict mode, an unsupported schema annotation is an error and the operation is omitted; in permissive mode (`strict: false`) annotations that can be dropped without changing the supported subset are dropped with a warning. The runtime-supported constraints (`minLength`, `maxLength`, `pattern`, `format`, `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `multipleOf`, `minItems`, `maxItems`, `uniqueItems`, `minProperties`, and `maxProperties`) are preserved and audited. OpenAPI 3.0 boolean `exclusiveMinimum`/`exclusiveMaximum` values are normalized to the JSON Schema numeric form. An `allOf` of object schemas is flattened into one object schema when merging properties, `required`, and `additionalProperties` preserves the intersection; incompatible or non-object members, sibling validation keywords, and `oneOf`/`anyOf`/`not`/conditional/dependent/pattern composition on inputs are always errors because dropping or approximating them would weaken validation. Schema-valued `additionalProperties`, tuple or boolean `items`, remote references, and unknown schema keywords are also errors.

Supported input construction:

- Path, query, and header parameters from path-item and operation levels; operation-level declarations override path-level ones by `(name, in)`. Cookie parameters, content-encoded parameters, credential/transport headers such as `Authorization` and `Cookie`, duplicate names across locations, and path parameters without `required: true` are rejected.
- JSON request bodies (`application/json` or an `application/*+json` media type) become one `body` input property, required when `requestBody.required` is true. A parameter named `body` collides and is rejected.
- The root input schema is always `type: "object"` with `additionalProperties: false`; property and `required` ordering is sorted for determinism.
- `readOnly` properties are omitted from inputs and from `required`.
- Each operation records `parameters` (name, `path`/`query`/`header` location, and required flag) sorted by input name. When a JSON request body exists, `requestBody` records the selected media type and required flag. These bindings are metadata for an executor; the input schema remains the validation boundary.

Response mapping:

- Each declared response is emitted in code-unit order of its status key as a `CompiledResponse`: `default`, an exact `100`-`599` code, and, for OpenAPI 3.1 only, ranges such as `2XX`. A 3.0 range key is rejected.
- `description` is required. Unknown response fields and malformed `content` objects are `RESPONSE_INVALID` errors.
- The selected media type prefers `application/json`, then the first `application/*+json` type in code-unit order. Non-JSON-only content is recorded with its first media type and a `RESPONSE_UNSUPPORTED` warning, without a schema. `headers` and `links` are not mapped.
- Response schemas are descriptive metadata, not runtime validation. They are translated with local `$ref` resolution, 3.0 nullability, `writeOnly` output filtering, and preserved composition (`allOf`, `oneOf`, `anyOf`, `not`, conditionals, pattern/dependent schemas). Keywords outside the input-validator subset are retained rather than rejected. No validator is generated or applied to upstream payloads yet.

Schema translation resolves local `$ref`s only (`#/...`) with cycle and depth detection and never fetches a remote reference. OpenAPI 3.0 `nullable: true` becomes a union with `"null"` and adds `null` to `enum`; it requires a sibling `type`, and using `nullable` in 3.1 is an error. OpenAPI 3.1 null unions are preserved. The resulting input schema is audited with `auditInputSchema`; an operation is not emitted when the runtime cannot enforce its schema. `allOf` flattening merges nested object intersections deterministically, including intersections reached through `$ref`; a property declared with incompatible schemas in different members, a non-object member, or a sibling validation keyword produces `SCHEMA_COMPOSITION_UNSUPPORTED`.

Security schemes and raw requirements are preserved, and each operation also receives an explicit `authentication` policy:

- `authentication.alternatives` mirrors the OR list; each alternative's `schemes` is the AND list.
- Each scheme entry copies the credential-relevant definition (API key parameter name/location, HTTP scheme and bearer format, OpenID Connect URL, OAuth2 flows) plus the required scopes. Scopes are deduplicated and sorted by code unit; scheme entries are sorted by name. Alternative order follows the contract.
- An empty requirement object (`{}`) is preserved as an alternative with no schemes and sets `allowsAnonymous: true`; it is not dropped. An empty or absent `security` list also means no authentication, with `alternatives: []` and `allowsAnonymous: true`.
- A non-OAuth/OIDC scheme that declares scopes is rejected with `SECURITY_REQUIREMENT_INVALID`. OAuth2 scopes must appear in at least one declared flow in strict mode (error) or produce a warning in permissive mode. OpenID Connect scopes cannot be checked offline and are preserved.
- If the document-level `security` list is invalid, no operations are emitted. Every operation inherits it, so emitting tools would silently drop authentication.

The policy is compiler metadata, not enforcement. `operation.requiredScopes` remains empty because flattening OR alternatives or AND scopes into one list would misrepresent the contract; auth adapters must interpret `authentication`. The current executor does not resolve credentials or enforce this policy.

`sourceHash` hashes the exact source text. `contractRevision` hashes the canonical parsed document plus `COMPILER_VERSION`; semantically equivalent key ordering therefore produces the same revision, while compiler changes produce a new revision. `manifest.tools` records a hash per emitted operation (including parameter bindings, request-body metadata, response metadata, and authentication), `toolsetHash` hashes the compiler version, contract revision, and all tool hashes, and `diffManifests` reports added, removed, changed, and unchanged names between two manifests. No timestamps are included, so the same source and compiler version produce the same manifest.

### Contract Diffing & Breaking Change Taxonomy (`diffContracts`)

`diffContracts(previous, next)` walks compiled operations and JSON schemas recursively, classifying every detected contract difference:

- **Breaking (`"breaking"`):**
  - Tool removed (`TOOL_REMOVED`).
  - Tool renamed based on method and path matching (`TOOL_RENAMED`).
  - New required input property added (`INPUT_REQUIRED_ADDED`).
  - Input property removed (`INPUT_PROPERTY_REMOVED`).
  - Input type narrowed (`INPUT_TYPE_NARROWED`).
  - Input enum values removed or restricted (`INPUT_ENUM_VALUE_REMOVED`).
  - Input constraints tightened: `minimum` increased, `maximum` decreased, `minLength` increased, `maxLength` decreased, or `pattern` added/changed (`INPUT_CONSTRAINT_TIGHTENED`).
  - Required response field removed (`RESPONSE_FIELD_REMOVED`).
  - Response field type changed incompatibly (`RESPONSE_TYPE_CHANGED`).
  - Authentication requirement added to previously unauthenticated tool (`AUTH_REQUIREMENT_ADDED`).
  - Base URL origin changed (`BASE_URL_CHANGED`).
- **Potentially Breaking (`"potentially-breaking"`):**
  - Existing optional input property became required (`INPUT_BECAME_REQUIRED`).
  - Input property default value changed (`INPUT_DEFAULT_CHANGED`).
  - New enum value added to response payload (`RESPONSE_ENUM_VALUE_ADDED`).
  - Base URL pathname changed (`BASE_URL_PATH_CHANGED`).
- **Non-Breaking (`"non-breaking"`):**
  - New tool added (`TOOL_ADDED`).
  - New optional input property added (`INPUT_OPTIONAL_ADDED`).
  - Existing required input property became optional (`INPUT_BECAME_OPTIONAL`).
  - Input type widened (`INPUT_TYPE_WIDENED`).
  - New enum value added to input property (`INPUT_ENUM_VALUE_ADDED`).
  - Tool or field description changed (`DESCRIPTION_CHANGED`).
  - Authentication requirement relaxed to allow anonymous access (`AUTH_REQUIREMENT_RELAXED`).

The output is typed as `ContractDiffResult` (`schemaVersion: 1`), providing `summary: { breaking, potentiallyBreaking, nonBreaking }`, tool list sets (`addedTools`, `removedTools`, `changedTools`, `unchangedTools`), and categorized arrays (`changes`, `breaking`, `potentiallyBreaking`, `nonBreaking`).

Known limitations: the compiler maps response schemas but does not apply them — enforcement is performed by `@chainmcp/executor` when `validateResponses` is enabled (`warn` by default, `enforce` optional), and composition keywords the runtime validator does not support are preserved only as metadata; authentication policies are mapped but not enforced and no credentials are injected by the compiler (runtime enforcement and injection are executor concerns); no remote references; input `oneOf`, `anyOf`, `not`, conditional, dependent, and pattern composition is rejected; `allOf` supports object intersections only; only the listed runtime formats are asserted; `const` is not supported; no YAML merge-key support; and the compiler owns no regeneration command that reads/writes a manifest. Compilation is wired into the CLI `build`/`export` flow. See `@chainmcp/executor` for the implemented upstream HTTP slice and `docs/getting-started.md` for the runnable example.

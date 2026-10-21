import {
  auditInputSchema,
  type JsonSchema,
  type OperationPolicy,
} from "@chainmcp/core";

import {
  isPlainObject,
  parseOpenApiSource,
  pointer,
  stableStringify,
  hashWithPrefix,
  DEFAULT_MAX_SOURCE_BYTES,
  MAX_SOURCE_BYTES_LIMIT,
} from "./document.js";
import {
  MAX_TOOL_DESCRIPTION_LENGTH,
  createToolDescription,
  createToolName,
  type ToolNameState,
} from "./names.js";
import { resolveObjectReference } from "./refs.js";
import { translateInputSchema } from "./schema.js";
import { parseSecurityRequirements, parseSecuritySchemes } from "./security.js";
import type {
  CompileDiff,
  CompileDiagnostic,
  CompileManifest,
  CompileOptions,
  CompileResult,
  CompiledOperation,
  CompiledSecurityScheme,
  ContractCompiler,
  HttpMethod,
  ManifestToolEntry,
  OpenApiVersion,
  SecurityRequirement,
} from "./types.js";

export const COMPILER_VERSION = "0.1.0";
export const DEFAULT_MAX_REF_DEPTH = 32;
export const MAX_REF_DEPTH_LIMIT = 128;
export const DEFAULT_MAX_OPERATIONS = 1_000;
export const MAX_OPERATIONS_LIMIT = 10_000;

const HTTP_METHODS: readonly HttpMethod[] = [
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
];

const PATH_ITEM_KEYS = new Set<string>([
  ...HTTP_METHODS,
  "summary",
  "description",
  "servers",
  "parameters",
]);

const OPERATION_KEYS = new Set<string>([
  "operationId",
  "summary",
  "description",
  "parameters",
  "requestBody",
  "responses",
  "security",
  "deprecated",
  "tags",
  "externalDocs",
  "servers",
  "callbacks",
]);

const PARAMETER_LOCATIONS = new Set(["path", "query", "header"]);

/**
 * Header inputs that would let an MCP caller choose upstream transport
 * credentials or framing. Upstream credentials are separate from inbound
 * identity (Milestone 5), so these are never exposed as tool arguments.
 */
const FORBIDDEN_HEADER_PARAMETERS = new Set([
  "authorization",
  "connection",
  "content-length",
  "cookie",
  "host",
  "proxy-authorization",
  "set-cookie",
  "transfer-encoding",
]);

interface NormalizedOptions {
  strict: boolean;
  includeDeprecated: boolean;
  maxSourceBytes: number;
  maxRefDepth: number;
  maxOperations: number;
}

interface ParameterInfo {
  name: string;
  schema: JsonSchema;
  required: boolean;
  description?: string;
}

interface CompiledRequestBody {
  schema: JsonSchema;
  required: boolean;
  description?: string;
}

export class OpenApiCompiler implements ContractCompiler {
  async compile(
    source: string,
    options: CompileOptions = {},
  ): Promise<CompileResult> {
    return compileOpenApi(source, options);
  }
}

export function compileOpenApi(
  source: string,
  options: CompileOptions = {},
): CompileResult {
  if (typeof source !== "string") {
    throw new TypeError("OpenAPI source must be a string");
  }
  const settings = normalizeOptions(options);
  const parsed = parseOpenApiSource(source, settings.maxSourceBytes);
  const diagnostics: CompileDiagnostic[] = [...parsed.diagnostics];
  const sourceHash = parsed.sourceHash;

  if (parsed.document === undefined) {
    return buildResult({
      tools: [],
      diagnostics,
      securitySchemes: {},
      sourceHash,
      contractRevision: hashWithPrefix(
        `chainmcp:openapi:${COMPILER_VERSION}:unparsed:${sourceHash}`,
      ),
      openapiVersion: "unknown",
    });
  }

  const document = parsed.document;
  const contractRevision = hashWithPrefix(
    `chainmcp:openapi:${COMPILER_VERSION}\n${stableStringify(document)}`,
  );

  const version = readOpenApiVersion(document, diagnostics);
  validateInfo(document, diagnostics);
  const paths = document.paths;
  if (!isPlainObject(paths)) {
    diagnostics.push({
      severity: "error",
      code: "DOCUMENT_INVALID",
      message: "OpenAPI 'paths' must be an object",
      location: "#/paths",
    });
  }

  if (version === undefined || !isPlainObject(paths)) {
    return buildResult({
      tools: [],
      diagnostics,
      securitySchemes: {},
      sourceHash,
      contractRevision,
      openapiVersion: version ?? "unknown",
    });
  }

  const securitySchemes = parseSecuritySchemes(document, version, diagnostics);
  let globalSecurity: readonly SecurityRequirement[] = [];
  if (Object.hasOwn(document, "security")) {
    globalSecurity =
      parseSecurityRequirements(
        document.security,
        securitySchemes,
        diagnostics,
        "#/security",
      ) ?? [];
  }

  const tools: CompiledOperation[] = [];
  const nameState: ToolNameState = { used: new Set<string>() };
  const toolsByPath = Object.keys(paths).sort();
  let operationCount = 0;
  let limitReported = false;

  outer: for (const path of toolsByPath) {
    if (path.startsWith("x-")) continue;
    const pathLocation = pointer("paths", path);
    if (!path.startsWith("/")) {
      diagnostics.push({
        severity: "error",
        code: "PATH_INVALID",
        message: `Path '${path}' must start with '/'`,
        location: pathLocation,
      });
      continue;
    }
    const rawPathItem = paths[path];
    const pathItem = resolveObjectReference(
      rawPathItem,
      document,
      diagnostics,
      pathLocation,
    );
    if (pathItem === undefined) continue;

    let invalidPathItem = false;
    for (const key of Object.keys(pathItem)) {
      if (PATH_ITEM_KEYS.has(key) || key.startsWith("x-")) continue;
      diagnostics.push({
        severity: "error",
        code: "PATH_INVALID",
        message: `Unsupported path-item field '${key}'`,
        location: pathLocation,
      });
      invalidPathItem = true;
    }
    if (invalidPathItem) continue;

    const pathParameterStart = diagnostics.length;
    const pathParameters = collectParameters(
      pathItem.parameters,
      document,
      version,
      settings,
      diagnostics,
      pointer("paths", path, "parameters"),
    );
    const pathParametersValid = !hasError(diagnostics, pathParameterStart);

    for (const method of HTTP_METHODS) {
      if (!Object.hasOwn(pathItem, method)) continue;
      operationCount += 1;
      if (operationCount > settings.maxOperations) {
        if (!limitReported) {
          diagnostics.push({
            severity: "error",
            code: "OPERATION_LIMIT_EXCEEDED",
            message: `Document exceeds the maximum of ${settings.maxOperations} operations`,
            location: pathLocation,
          });
          limitReported = true;
        }
        break outer;
      }

      const operationLocation = pointer("paths", path, method);
      const compiled = compileOperation({
        rawOperation: pathItem[method],
        path,
        method,
        operationLocation,
        document,
        version,
        settings,
        diagnostics,
        nameState,
        pathParameters,
        pathParametersValid,
        securitySchemes,
        globalSecurity,
      });
      if (compiled !== undefined) tools.push(compiled);
    }
  }

  return buildResult({
    tools,
    diagnostics,
    securitySchemes,
    sourceHash,
    contractRevision,
    openapiVersion: version,
  });
}

export function diffManifests(
  previous: CompileManifest,
  next: CompileManifest,
): CompileDiff {
  if (
    !isPlainObject(previous) ||
    !isPlainObject(next) ||
    previous.manifestVersion !== 1 ||
    next.manifestVersion !== 1 ||
    !Array.isArray(previous.tools) ||
    !Array.isArray(next.tools)
  ) {
    throw new TypeError("Both manifests must be version 1 manifests");
  }
  const before = new Map(previous.tools.map((tool) => [tool.name, tool.hash]));
  const after = new Map(next.tools.map((tool) => [tool.name, tool.hash]));
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  const unchanged: string[] = [];

  for (const [name, hash] of after) {
    const previousHash = before.get(name);
    if (previousHash === undefined) added.push(name);
    else if (previousHash === hash) unchanged.push(name);
    else changed.push(name);
  }
  for (const name of before.keys()) {
    if (!after.has(name)) removed.push(name);
  }

  return {
    added: added.sort(),
    removed: removed.sort(),
    changed: changed.sort(),
    unchanged: unchanged.sort(),
  };
}

interface CompileOperationArguments {
  rawOperation: unknown;
  path: string;
  method: HttpMethod;
  operationLocation: string;
  document: Record<string, unknown>;
  version: OpenApiVersion;
  settings: NormalizedOptions;
  diagnostics: CompileDiagnostic[];
  nameState: ToolNameState;
  pathParameters: ReadonlyMap<string, ParameterInfo> | undefined;
  pathParametersValid: boolean;
  securitySchemes: Readonly<Record<string, CompiledSecurityScheme>>;
  globalSecurity: readonly SecurityRequirement[];
}

function compileOperation(
  arguments_: CompileOperationArguments,
): CompiledOperation | undefined {
  const {
    rawOperation,
    path,
    method,
    operationLocation,
    document,
    version,
    settings,
    diagnostics,
    nameState,
    pathParameters,
    pathParametersValid,
    securitySchemes,
    globalSecurity,
  } = arguments_;
  const operationStart = diagnostics.length;

  if (!isPlainObject(rawOperation)) {
    diagnostics.push({
      severity: "error",
      code: "OPERATION_INVALID",
      message: "Operation must be an object",
      location: operationLocation,
    });
    return undefined;
  }

  for (const key of Object.keys(rawOperation)) {
    if (OPERATION_KEYS.has(key) || key.startsWith("x-")) continue;
    diagnostics.push({
      severity: "error",
      code: "OPERATION_INVALID",
      message: `Unsupported operation field '${key}'`,
      location: operationLocation,
    });
  }

  let deprecated = false;
  if (Object.hasOwn(rawOperation, "deprecated")) {
    if (typeof rawOperation.deprecated !== "boolean") {
      diagnostics.push({
        severity: "error",
        code: "OPERATION_INVALID",
        message: "Operation 'deprecated' must be a boolean",
        location: operationLocation,
      });
    } else {
      deprecated = rawOperation.deprecated;
    }
  }
  if (deprecated && !settings.includeDeprecated) {
    diagnostics.push({
      severity: "warning",
      code: "DEPRECATED_OPERATION",
      message:
        "Deprecated operation was excluded; set includeDeprecated to compile it",
      location: operationLocation,
    });
    return undefined;
  }

  const responses = rawOperation.responses;
  if (!isPlainObject(responses) || Object.keys(responses).length === 0) {
    diagnostics.push({
      severity: "error",
      code: "OPERATION_INVALID",
      message: "Operation 'responses' must be a non-empty object",
      location: operationLocation,
    });
  }

  if (!pathParametersValid) return undefined;

  const operationParameterStart = diagnostics.length;
  const operationParameters = collectParameters(
    rawOperation.parameters,
    document,
    version,
    settings,
    diagnostics,
    pointer("paths", path, method, "parameters"),
  );
  if (
    operationParameters === undefined ||
    hasError(diagnostics, operationParameterStart)
  ) {
    return undefined;
  }

  const merged = new Map(pathParameters ?? []);
  for (const [key, value] of operationParameters) merged.set(key, value);

  const propertyEntries: Array<[string, JsonSchema]> = [];
  const propertyNames = new Set<string>();
  const required: string[] = [];
  for (const parameter of [...merged.values()].sort((left, right) =>
    compareCodeUnits(left.name, right.name),
  )) {
    if (propertyNames.has(parameter.name)) {
      diagnostics.push({
        severity: "error",
        code: "PARAMETER_DUPLICATE",
        message: `Parameters from different locations both map to input '${parameter.name}'`,
        location: operationLocation,
      });
      continue;
    }
    propertyNames.add(parameter.name);
    propertyEntries.push([
      parameter.name,
      withDescription(parameter.schema, parameter.description),
    ]);
    if (parameter.required) required.push(parameter.name);
  }

  const bodyStart = diagnostics.length;
  const body =
    rawOperation.requestBody === undefined
      ? undefined
      : compileRequestBody(
          rawOperation.requestBody,
          document,
          version,
          settings,
          diagnostics,
          pointer("paths", path, method, "requestBody"),
        );
  if (hasError(diagnostics, bodyStart)) return undefined;

  if (body !== undefined) {
    if (propertyNames.has("body")) {
      diagnostics.push({
        severity: "error",
        code: "PARAMETER_DUPLICATE",
        message:
          "Request body maps to input 'body', which collides with a parameter named 'body'",
        location: operationLocation,
      });
      return undefined;
    }
    propertyNames.add("body");
    propertyEntries.push([
      "body",
      withDescription(body.schema, body.description),
    ]);
    if (body.required) required.push("body");
  }

  const security = resolveOperationSecurity(
    rawOperation,
    securitySchemes,
    globalSecurity,
    diagnostics,
    operationLocation,
  );
  if (security === undefined) return undefined;

  const sortedProperties = Object.fromEntries(
    propertyEntries.sort(([left], [right]) => compareCodeUnits(left, right)),
  );
  const inputSchema: JsonSchema = {
    type: "object",
    properties: sortedProperties,
    required: [...new Set(required)].sort(),
    additionalProperties: false,
  };
  const audit = auditInputSchema(inputSchema);
  if (!audit.supported) {
    for (const diagnostic of audit.diagnostics) {
      diagnostics.push({
        severity: "error",
        code: "SCHEMA_UNSUPPORTED",
        message: diagnostic.message,
        location: `${operationLocation}${diagnostic.path.replace(/^\$/, "")}`,
      });
    }
    return undefined;
  }

  const name = createToolName(
    rawOperation.operationId,
    method,
    path,
    nameState,
    diagnostics,
    operationLocation,
    settings.strict,
  );
  const description = createToolDescription(
    rawOperation.summary,
    rawOperation.description,
    method,
    path,
    diagnostics,
    operationLocation,
  );

  const operation: OperationPolicy = {};
  if (hasError(diagnostics, operationStart)) return undefined;

  return {
    name,
    description,
    inputSchema,
    operation,
    method,
    path,
    ...(typeof rawOperation.operationId === "string"
      ? { operationId: rawOperation.operationId }
      : {}),
    readOnly: method === "get" || method === "head",
    deprecated,
    security,
    sourceLocation: operationLocation,
  };
}

function collectParameters(
  value: unknown,
  document: Record<string, unknown>,
  version: OpenApiVersion,
  settings: NormalizedOptions,
  diagnostics: CompileDiagnostic[],
  location: string,
): ReadonlyMap<string, ParameterInfo> | undefined {
  const parameters = new Map<string, ParameterInfo>();
  if (value === undefined) return parameters;
  if (!Array.isArray(value)) {
    diagnostics.push({
      severity: "error",
      code: "PARAMETER_INVALID",
      message: "Parameters must be an array",
      location,
    });
    return undefined;
  }

  for (const [index, raw] of value.entries()) {
    const parameterLocation = `${location}/${index}`;
    const parameter = resolveObjectReference(
      raw,
      document,
      diagnostics,
      parameterLocation,
    );
    if (parameter === undefined) return undefined;

    if (
      typeof parameter.name !== "string" ||
      parameter.name.trim().length === 0
    ) {
      diagnostics.push({
        severity: "error",
        code: "PARAMETER_INVALID",
        message: "Parameter 'name' must be a non-empty string",
        location: parameterLocation,
      });
      return undefined;
    }
    if (
      typeof parameter.in !== "string" ||
      !PARAMETER_LOCATIONS.has(parameter.in)
    ) {
      diagnostics.push({
        severity: "error",
        code:
          parameter.in === "cookie"
            ? "PARAMETER_UNSUPPORTED"
            : "PARAMETER_INVALID",
        message:
          parameter.in === "cookie"
            ? "Cookie parameters are not supported"
            : "Parameter 'in' must be path, query, or header",
        location: parameterLocation,
      });
      return undefined;
    }
    const parameterIn = parameter.in as "path" | "query" | "header";
    if (
      parameterIn === "header" &&
      FORBIDDEN_HEADER_PARAMETERS.has(parameter.name.toLowerCase())
    ) {
      diagnostics.push({
        severity: "error",
        code: "PARAMETER_UNSUPPORTED",
        message: `Header parameter '${parameter.name}' is transport- or credential-controlled and cannot be a tool input`,
        location: parameterLocation,
      });
      return undefined;
    }
    if (Object.hasOwn(parameter, "content")) {
      diagnostics.push({
        severity: "error",
        code: "PARAMETER_UNSUPPORTED",
        message: "Content-encoded parameters are not supported",
        location: parameterLocation,
      });
      return undefined;
    }
    if (!isPlainObject(parameter.schema)) {
      diagnostics.push({
        severity: "error",
        code: "PARAMETER_INVALID",
        message: "Parameter requires an object 'schema'",
        location: parameterLocation,
      });
      return undefined;
    }

    let required = false;
    if (Object.hasOwn(parameter, "required")) {
      if (typeof parameter.required !== "boolean") {
        diagnostics.push({
          severity: "error",
          code: "PARAMETER_INVALID",
          message: "Parameter 'required' must be a boolean",
          location: parameterLocation,
        });
        return undefined;
      }
      required = parameter.required;
    }
    if (parameterIn === "path" && !required) {
      diagnostics.push({
        severity: "error",
        code: "PARAMETER_INVALID",
        message: "Path parameters must declare required: true",
        location: parameterLocation,
      });
      return undefined;
    }

    if (
      Object.hasOwn(parameter, "description") &&
      typeof parameter.description !== "string"
    ) {
      diagnostics.push({
        severity: "error",
        code: "PARAMETER_INVALID",
        message: "Parameter 'description' must be a string",
        location: parameterLocation,
      });
      return undefined;
    }

    const schema = translateInputSchema(parameter.schema, {
      document,
      version,
      strict: settings.strict,
      maxRefDepth: settings.maxRefDepth,
      diagnostics,
    });
    if (schema === undefined) return undefined;

    const key = `${parameterIn}\u0000${parameter.name}`;
    if (parameters.has(key)) {
      diagnostics.push({
        severity: "error",
        code: "PARAMETER_DUPLICATE",
        message: `Parameter '${parameter.name}' in ${parameterIn} is declared more than once`,
        location: parameterLocation,
      });
      return undefined;
    }
    parameters.set(key, {
      name: parameter.name,
      schema,
      required,
      ...(typeof parameter.description === "string"
        ? { description: parameter.description }
        : {}),
    });
  }
  return parameters;
}

function compileRequestBody(
  value: unknown,
  document: Record<string, unknown>,
  version: OpenApiVersion,
  settings: NormalizedOptions,
  diagnostics: CompileDiagnostic[],
  location: string,
): CompiledRequestBody | undefined {
  const requestBody = resolveObjectReference(
    value,
    document,
    diagnostics,
    location,
  );
  if (requestBody === undefined) return undefined;

  let required = false;
  if (Object.hasOwn(requestBody, "required")) {
    if (typeof requestBody.required !== "boolean") {
      diagnostics.push({
        severity: "error",
        code: "REQUEST_BODY_INVALID",
        message: "Request body 'required' must be a boolean",
        location,
      });
      return undefined;
    }
    required = requestBody.required;
  }

  if (
    Object.hasOwn(requestBody, "description") &&
    typeof requestBody.description !== "string"
  ) {
    diagnostics.push({
      severity: "error",
      code: "REQUEST_BODY_INVALID",
      message: "Request body 'description' must be a string",
      location,
    });
    return undefined;
  }

  if (!isPlainObject(requestBody.content)) {
    diagnostics.push({
      severity: "error",
      code: "REQUEST_BODY_INVALID",
      message: "Request body 'content' must be an object",
      location,
    });
    return undefined;
  }
  const mediaType = selectJsonMediaType(Object.keys(requestBody.content));
  if (mediaType === undefined) {
    diagnostics.push({
      severity: "error",
      code: "REQUEST_BODY_UNSUPPORTED",
      message: "Request body must declare an application/json media type",
      location,
    });
    return undefined;
  }
  const media = requestBody.content[mediaType];
  if (!isPlainObject(media) || !isPlainObject(media.schema)) {
    diagnostics.push({
      severity: "error",
      code: "REQUEST_BODY_INVALID",
      message: `Request body media type '${mediaType}' requires an object schema`,
      location,
    });
    return undefined;
  }

  const schema = translateInputSchema(media.schema, {
    document,
    version,
    strict: settings.strict,
    maxRefDepth: settings.maxRefDepth,
    diagnostics,
  });
  if (schema === undefined) return undefined;

  return {
    schema,
    required,
    ...(typeof requestBody.description === "string"
      ? { description: requestBody.description }
      : {}),
  };
}

function selectJsonMediaType(
  mediaTypes: readonly string[],
): string | undefined {
  const normalized = mediaTypes
    .map((mediaType) => ({
      original: mediaType,
      base: mediaType.split(";")[0]?.trim().toLowerCase() ?? "",
    }))
    .sort((left, right) => compareCodeUnits(left.original, right.original));
  return (
    normalized.find((entry) => entry.base === "application/json")?.original ??
    normalized.find(
      (entry) =>
        entry.base.startsWith("application/") && entry.base.endsWith("+json"),
    )?.original
  );
}

function resolveOperationSecurity(
  operation: Record<string, unknown>,
  schemes: Readonly<Record<string, CompiledSecurityScheme>>,
  globalSecurity: readonly SecurityRequirement[],
  diagnostics: CompileDiagnostic[],
  location: string,
): readonly SecurityRequirement[] | undefined {
  if (!Object.hasOwn(operation, "security")) return globalSecurity;
  return parseSecurityRequirements(
    operation.security,
    schemes,
    diagnostics,
    `${location}/security`,
  );
}

function readOpenApiVersion(
  document: Record<string, unknown>,
  diagnostics: CompileDiagnostic[],
): OpenApiVersion | undefined {
  const raw = document.openapi;
  if (typeof raw !== "string") {
    diagnostics.push({
      severity: "error",
      code: "OPENAPI_VERSION_UNSUPPORTED",
      message: "OpenAPI document requires a string 'openapi' version",
      location: "#/openapi",
    });
    return undefined;
  }
  const match = /^3\.(0|1)(?:\.\d+)?(?:[-+].*)?$/.exec(raw);
  if (match === null) {
    diagnostics.push({
      severity: "error",
      code: "OPENAPI_VERSION_UNSUPPORTED",
      message: `OpenAPI version '${raw}' is not supported; expected 3.0.x or 3.1.x`,
      location: "#/openapi",
    });
    return undefined;
  }
  return `3.${match[1]}` as OpenApiVersion;
}

function validateInfo(
  document: Record<string, unknown>,
  diagnostics: CompileDiagnostic[],
): void {
  if (!isPlainObject(document.info)) {
    diagnostics.push({
      severity: "error",
      code: "DOCUMENT_INVALID",
      message: "OpenAPI 'info' must be an object",
      location: "#/info",
    });
    return;
  }
  for (const field of ["title", "version"]) {
    const value = document.info[field];
    if (typeof value !== "string" || value.trim().length === 0) {
      diagnostics.push({
        severity: "error",
        code: "DOCUMENT_INVALID",
        message: `OpenAPI 'info.${field}' must be a non-empty string`,
        location: `#/info/${field}`,
      });
    }
  }
}

function withDescription(
  schema: JsonSchema,
  description: string | undefined,
): JsonSchema {
  if (
    description === undefined ||
    description.length === 0 ||
    typeof schema.description === "string"
  ) {
    return schema;
  }
  return { ...schema, description };
}

function hasError(
  diagnostics: readonly CompileDiagnostic[],
  start: number,
): boolean {
  return diagnostics
    .slice(start)
    .some((diagnostic) => diagnostic.severity === "error");
}

/** Locale-independent ordering so output is identical on every host. */
function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

interface BuildResultArguments {
  tools: readonly CompiledOperation[];
  diagnostics: readonly CompileDiagnostic[];
  securitySchemes: Readonly<Record<string, CompiledSecurityScheme>>;
  sourceHash: string;
  contractRevision: string;
  openapiVersion: OpenApiVersion | "unknown";
}

function buildResult(arguments_: BuildResultArguments): CompileResult {
  const toolEntries: ManifestToolEntry[] = arguments_.tools.map((tool) => ({
    name: tool.name,
    hash: hashTool(tool),
  }));
  const toolsetHash = hashWithPrefix(
    stableStringify({
      manifestVersion: 1,
      compilerVersion: COMPILER_VERSION,
      contractRevision: arguments_.contractRevision,
      tools: toolEntries,
    }),
  );
  const manifest: CompileManifest = {
    manifestVersion: 1,
    compilerVersion: COMPILER_VERSION,
    openapiVersion: arguments_.openapiVersion,
    sourceHash: arguments_.sourceHash,
    contractRevision: arguments_.contractRevision,
    toolsetHash,
    toolCount: toolEntries.length,
    tools: toolEntries,
  };
  return {
    ok: !arguments_.diagnostics.some(
      (diagnostic) => diagnostic.severity === "error",
    ),
    tools: arguments_.tools,
    diagnostics: arguments_.diagnostics,
    securitySchemes: arguments_.securitySchemes,
    sourceHash: arguments_.sourceHash,
    contractRevision: arguments_.contractRevision,
    manifest,
  };
}

function hashTool(tool: CompiledOperation): string {
  return hashWithPrefix(
    stableStringify({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      operation: tool.operation,
      method: tool.method,
      path: tool.path,
      operationId: tool.operationId ?? null,
      readOnly: tool.readOnly,
      deprecated: tool.deprecated,
      security: tool.security,
    }),
  );
}

function normalizeOptions(options: CompileOptions): NormalizedOptions {
  if (
    typeof options !== "object" ||
    options === null ||
    Array.isArray(options)
  ) {
    throw new TypeError("Compile options must be an object");
  }
  if (options.strict !== undefined && typeof options.strict !== "boolean") {
    throw new TypeError("Compile option 'strict' must be a boolean");
  }
  if (
    options.includeDeprecated !== undefined &&
    typeof options.includeDeprecated !== "boolean"
  ) {
    throw new TypeError("Compile option 'includeDeprecated' must be a boolean");
  }
  return {
    strict: options.strict ?? true,
    includeDeprecated: options.includeDeprecated ?? false,
    maxSourceBytes: boundedInteger(
      "maxSourceBytes",
      options.maxSourceBytes,
      DEFAULT_MAX_SOURCE_BYTES,
      MAX_SOURCE_BYTES_LIMIT,
    ),
    maxRefDepth: boundedInteger(
      "maxRefDepth",
      options.maxRefDepth,
      DEFAULT_MAX_REF_DEPTH,
      MAX_REF_DEPTH_LIMIT,
    ),
    maxOperations: boundedInteger(
      "maxOperations",
      options.maxOperations,
      DEFAULT_MAX_OPERATIONS,
      MAX_OPERATIONS_LIMIT,
    ),
  };
}

function boundedInteger(
  name: string,
  value: unknown,
  fallback: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new TypeError(`Compile option '${name}' must be a positive integer`);
  }
  if ((value as number) > maximum) {
    throw new TypeError(`Compile option '${name}' must not exceed ${maximum}`);
  }
  return value as number;
}

// Keep the exported description limit visible to consumers that bound their
// own generated manifests.
export { MAX_TOOL_DESCRIPTION_LENGTH };

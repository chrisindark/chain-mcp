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
import { translateInputSchema, translateOutputSchema } from "./schema.js";
import {
  buildAuthenticationPolicy,
  parseSecurityRequirements,
  parseSecuritySchemes,
} from "./security.js";
import type {
  CompileDiff,
  CompileDiagnostic,
  CompileManifest,
  CompileOptions,
  CompileResult,
  CompiledOperation,
  CompiledResponse,
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

const RESPONSE_KEYS = new Set(["description", "headers", "links", "content"]);

/**
 * Header inputs that would let an MCP caller choose upstream transport
 * credentials or framing. Upstream credentials are separate from inbound
 * identity (Milestone 5), so these are never exposed as tool arguments.
 */
const FORBIDDEN_HEADER_PARAMETERS = new Set([
  "accept",
  "authorization",
  "connection",
  "content-encoding",
  "content-length",
  "content-type",
  "cookie",
  "expect",
  "host",
  "proxy-authorization",
  "proxy-connection",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "user-agent",
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
  in: "path" | "query" | "header";
  schema: JsonSchema;
  required: boolean;
  description?: string;
}

interface CompiledRequestBody {
  schema: JsonSchema;
  mediaType: string;
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
    const parsedGlobalSecurity = parseSecurityRequirements(
      document.security,
      securitySchemes,
      diagnostics,
      "#/security",
    );
    if (parsedGlobalSecurity === undefined) {
      // Every operation inherits global security. Emitting tools after a
      // global requirement failed to parse would silently drop authentication.
      return buildResult({
        tools: [],
        diagnostics,
        securitySchemes,
        sourceHash,
        contractRevision,
        openapiVersion: version,
      });
    }
    globalSecurity = parsedGlobalSecurity;
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
        globalSecurityLocation: "#/security",
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
  globalSecurityLocation: string;
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
    globalSecurityLocation,
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

  const responsesStart = diagnostics.length;
  const responses = compileResponses(
    rawOperation.responses,
    document,
    version,
    settings,
    diagnostics,
    pointer("paths", path, method, "responses"),
  );
  if (responses === undefined || hasError(diagnostics, responsesStart)) {
    return undefined;
  }

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

  const resolvedSecurity = resolveOperationSecurity(
    rawOperation,
    securitySchemes,
    globalSecurity,
    globalSecurityLocation,
    diagnostics,
    operationLocation,
  );
  if (resolvedSecurity === undefined) return undefined;
  const authentication = buildAuthenticationPolicy(
    resolvedSecurity.requirements,
    securitySchemes,
    settings.strict,
    diagnostics,
    resolvedSecurity.location,
  );
  if (authentication === undefined) return undefined;
  const security = resolvedSecurity.requirements;

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

  const parameters = [...merged.values()]
    .map((parameter) => ({
      name: parameter.name,
      in: parameter.in,
      required: parameter.required,
    }))
    .sort(
      (left, right) =>
        compareCodeUnits(left.name, right.name) ||
        compareCodeUnits(left.in, right.in),
    );

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
    parameters,
    ...(body === undefined
      ? {}
      : {
          requestBody: {
            mediaType: body.mediaType,
            required: body.required,
          },
        }),
    responses,
    security,
    authentication,
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
      in: parameterIn,
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
    mediaType,
    required,
    ...(typeof requestBody.description === "string"
      ? { description: requestBody.description }
      : {}),
  };
}

interface NormalizedMediaType {
  original: string;
  base: string;
}

function normalizeMediaTypes(
  mediaTypes: readonly string[],
): NormalizedMediaType[] {
  return mediaTypes
    .map((mediaType) => ({
      original: mediaType,
      base: mediaType.split(";")[0]?.trim().toLowerCase() ?? "",
    }))
    .sort((left, right) => compareCodeUnits(left.original, right.original));
}

function isJsonMediaType(base: string): boolean {
  return (
    base === "application/json" ||
    (base.startsWith("application/") && base.endsWith("+json"))
  );
}

function selectJsonMediaType(
  mediaTypes: readonly string[],
): string | undefined {
  const normalized = normalizeMediaTypes(mediaTypes);
  return (
    normalized.find((entry) => entry.base === "application/json")?.original ??
    normalized.find((entry) => isJsonMediaType(entry.base))?.original
  );
}

function selectResponseMediaType(mediaTypes: readonly string[]): {
  mediaType: string;
  json: boolean;
} {
  const normalized = normalizeMediaTypes(mediaTypes);
  const json =
    normalized.find((entry) => entry.base === "application/json") ??
    normalized.find((entry) => isJsonMediaType(entry.base));
  if (json !== undefined) return { mediaType: json.original, json: true };
  // A response may legitimately declare only non-JSON content. Record the
  // media type so it is visible in metadata, but do not pretend to have a
  // schema for it.
  return { mediaType: normalized[0]?.original ?? "", json: false };
}

function isResponseStatusKey(status: string, version: OpenApiVersion): boolean {
  if (status === "default") return true;
  if (/^[1-5]\d\d$/.test(status)) return true;
  return version === "3.1" && /^[1-5]XX$/.test(status);
}

function compileResponses(
  value: unknown,
  document: Record<string, unknown>,
  version: OpenApiVersion,
  settings: NormalizedOptions,
  diagnostics: CompileDiagnostic[],
  location: string,
): readonly CompiledResponse[] | undefined {
  if (!isPlainObject(value) || Object.keys(value).length === 0) {
    diagnostics.push({
      severity: "error",
      code: "OPERATION_INVALID",
      message: "Operation 'responses' must be a non-empty object",
      location,
    });
    return undefined;
  }

  const responses: CompiledResponse[] = [];
  for (const status of Object.keys(value).sort(compareCodeUnits)) {
    const responseLocation = `${location}/${status}`;
    if (!isResponseStatusKey(status, version)) {
      diagnostics.push({
        severity: "error",
        code: "RESPONSE_INVALID",
        message:
          version === "3.1"
            ? `Response key '${status}' must be 'default', an exact status code, or a range such as '2XX'`
            : `Response key '${status}' must be 'default' or an exact status code; ranges require OpenAPI 3.1`,
        location: responseLocation,
      });
      return undefined;
    }

    const response = resolveObjectReference(
      value[status],
      document,
      diagnostics,
      responseLocation,
    );
    if (response === undefined) return undefined;

    for (const key of Object.keys(response)) {
      if (RESPONSE_KEYS.has(key) || key.startsWith("x-")) continue;
      diagnostics.push({
        severity: "error",
        code: "RESPONSE_INVALID",
        message: `Unsupported response field '${key}'`,
        location: responseLocation,
      });
      return undefined;
    }

    if (
      typeof response.description !== "string" ||
      response.description.trim().length === 0
    ) {
      diagnostics.push({
        severity: "error",
        code: "RESPONSE_INVALID",
        message: "Response 'description' must be a non-empty string",
        location: responseLocation,
      });
      return undefined;
    }

    let mediaType: string | undefined;
    let schema: JsonSchema | undefined;
    if (Object.hasOwn(response, "content")) {
      if (!isPlainObject(response.content)) {
        diagnostics.push({
          severity: "error",
          code: "RESPONSE_INVALID",
          message: "Response 'content' must be an object",
          location: responseLocation,
        });
        return undefined;
      }
      const mediaTypes = Object.keys(response.content);
      if (mediaTypes.length > 0) {
        const selected = selectResponseMediaType(mediaTypes);
        mediaType = selected.mediaType;
        if (selected.json) {
          const media = response.content[selected.mediaType];
          if (!isPlainObject(media)) {
            diagnostics.push({
              severity: "error",
              code: "RESPONSE_INVALID",
              message: `Response media type '${selected.mediaType}' must be an object`,
              location: responseLocation,
            });
            return undefined;
          }
          if (Object.hasOwn(media, "schema")) {
            if (!isPlainObject(media.schema)) {
              diagnostics.push({
                severity: "error",
                code: "RESPONSE_INVALID",
                message: `Response media type '${selected.mediaType}' requires an object schema`,
                location: responseLocation,
              });
              return undefined;
            }
            schema = translateOutputSchema(media.schema, {
              document,
              version,
              strict: settings.strict,
              maxRefDepth: settings.maxRefDepth,
              diagnostics,
            });
            if (schema === undefined) return undefined;
          }
        } else {
          diagnostics.push({
            severity: "warning",
            code: "RESPONSE_UNSUPPORTED",
            message: `Response '${status}' declares only non-JSON content; the media type is recorded without a schema`,
            location: responseLocation,
          });
        }
      }
    }

    responses.push({
      status,
      description: response.description,
      ...(mediaType === undefined ? {} : { mediaType }),
      ...(schema === undefined ? {} : { schema }),
    });
  }
  return responses;
}

interface ResolvedSecurity {
  requirements: readonly SecurityRequirement[];
  location: string;
}

function resolveOperationSecurity(
  operation: Record<string, unknown>,
  schemes: Readonly<Record<string, CompiledSecurityScheme>>,
  globalSecurity: readonly SecurityRequirement[],
  globalLocation: string,
  diagnostics: CompileDiagnostic[],
  location: string,
): ResolvedSecurity | undefined {
  if (!Object.hasOwn(operation, "security")) {
    return { requirements: globalSecurity, location: globalLocation };
  }
  const requirements = parseSecurityRequirements(
    operation.security,
    schemes,
    diagnostics,
    `${location}/security`,
  );
  if (requirements === undefined) return undefined;
  return { requirements, location: `${location}/security` };
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
      parameters: tool.parameters,
      requestBody: tool.requestBody ?? null,
      responses: tool.responses,
      security: tool.security,
      authentication: tool.authentication,
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

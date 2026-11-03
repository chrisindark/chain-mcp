import { createHash } from "node:crypto";
import { z } from "zod";

import {
  auditInputSchema,
  assertFieldSelection,
  type FieldSelection,
  type JsonSchema,
} from "@chainmcp/core";
import type {
  CompiledAuthenticationPolicy,
  CompiledAuthenticationScheme,
  CompiledOperation,
  CompiledParameter,
  HttpMethod,
  SecurityRequirement,
} from "@chainmcp/compiler";
import {
  isReservedRequestHeader,
  isValidRequestHeaderName,
} from "@chainmcp/executor";

import { normalizeAuthSchemeMap } from "./auth-schemes.js";
import {
  DeclarativeDescriptorError,
  MAX_DECLARATIVE_AUTH_ALTERNATIVES,
  MAX_DECLARATIVE_AUTH_SCHEMES,
  MAX_DECLARATIVE_DESCRIPTION_LENGTH,
  MAX_DECLARATIVE_PARAMETERS,
  MAX_DECLARATIVE_PATH_LENGTH,
  MAX_DECLARATIVE_PROPERTIES,
  MAX_DECLARATIVE_SCOPES,
  MAX_DECLARATIVE_CACHE_TTL_SECONDS,
  MAX_DECLARATIVE_TIMEOUT_MS,
  MAX_DESCRIPTOR_BYTES,
  type DeclarativeAuthSchemeMap,
  type DeclarativeAuthenticationDescriptor,
  type DeclarativeHttpMethod,
  type DeclarativeParameterLocation,
  type DeclarativePolicyDescriptor,
  type DeclarativeSecurityAlternative,
  type DeclarativeSecuritySchemeReference,
  type DeclarativeToolDescriptor,
  type NormalizedDeclarativePolicy,
} from "./types.js";

const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const PARAMETER_NAME = /^[A-Za-z0-9_.-]{1,64}$/;
const SUPPORTED_METHODS = new Set<string>([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]);
const PRIMITIVE_TYPES = new Set(["string", "number", "integer", "boolean"]);
const RESERVED_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const MAX_CANONICAL_DEPTH = 32;
const MAX_CANONICAL_NODES = 10_000;
const MAX_OUTPUT_TOKENS = 10_000_000;

const ParameterSchema = z.strictObject({
  name: z.string(),
  in: z.enum(["path", "query", "header", "cookie"]),
  required: z.boolean().optional(),
});

const RequestBodySchema = z.strictObject({
  mediaType: z.string().optional(),
  required: z.boolean().optional(),
});

const RequestSchema = z.strictObject({
  method: z.string(),
  path: z.string(),
  parameters: z.array(ParameterSchema).optional(),
  body: RequestBodySchema.optional(),
});

const SchemeReferenceSchema = z.strictObject({
  name: z.string(),
  scopes: z.array(z.string()).optional(),
});

const AuthenticationAlternativeSchema = z.strictObject({
  schemes: z.array(SchemeReferenceSchema),
});

const AuthenticationSchema = z.strictObject({
  alternatives: z.array(AuthenticationAlternativeSchema),
});

const OutputFieldsSchema = z.strictObject({
  include: z.array(z.string()).optional(),
  exclude: z.array(z.string()).optional(),
});

const PolicySchema = z.strictObject({
  requiredScopes: z.array(z.string()).optional(),
  cacheTtlSeconds: z.number().optional(),
  maxOutputTokens: z.number().optional(),
  outputFields: OutputFieldsSchema.optional(),
  timeoutMs: z.number().optional(),
});

type RawParameterInput = z.infer<typeof ParameterSchema>;
type RawBodyInput = z.infer<typeof RequestBodySchema>;
type RawAuthenticationInput = z.infer<typeof AuthenticationSchema>;
type RawPolicyInput = z.infer<typeof PolicySchema>;
const RawDescriptorSchema = z.strictObject({
  descriptorVersion: z.number(),
  name: z.string(),
  description: z.string(),
  request: RequestSchema,
  inputSchema: z.unknown(),
  authentication: AuthenticationSchema.optional(),
  policy: PolicySchema.optional(),
});

export interface ParseDeclarativeDescriptorOptions {
  /**
   * Deployment credential shapes referenced by descriptor authentication.
   * Contains no secrets. When omitted, any authentication reference fails as
   * unknown rather than failing every call at runtime.
   */
  authSchemes?: DeclarativeAuthSchemeMap;
}

/** A validated descriptor and its executor operation metadata. */
export interface ParsedDeclarativeTool {
  readonly descriptor: DeclarativeToolDescriptor;
  readonly operation: CompiledOperation;
  /** Deterministic `sha256:` revision over the canonical descriptor. */
  readonly revision: string;
}

/**
 * Validates and lowers a versioned declarative HTTP tool descriptor into the
 * bounded executor's operation metadata. Everything is data: no code, URL,
 * secret, or transport-owned header is accepted.
 *
 * Throws `DeclarativeDescriptorError` with a stable code and issue locations.
 */
export function parseDeclarativeToolDescriptor(
  input: unknown,
  options: ParseDeclarativeDescriptorOptions = {},
): ParsedDeclarativeTool {
  const canonical = canonicalize(input);
  if (canonical.length > MAX_DESCRIPTOR_BYTES) {
    throw new DeclarativeDescriptorError(
      "DESCRIPTOR_TOO_LARGE",
      `Descriptor exceeds ${MAX_DESCRIPTOR_BYTES} bytes`,
    );
  }
  const plain: unknown = JSON.parse(canonical);

  if (!isPlainObject(plain)) {
    throw new DeclarativeDescriptorError(
      "DESCRIPTOR_INVALID",
      "Descriptor must be a JSON object",
    );
  }
  if (Object.hasOwn(plain, "descriptorVersion")) {
    const version = plain.descriptorVersion;
    if (version !== 1) {
      throw new DeclarativeDescriptorError(
        "DESCRIPTOR_VERSION_UNSUPPORTED",
        `Unsupported descriptorVersion '${String(version)}'; this build supports version 1`,
      );
    }
  }

  const parsed = RawDescriptorSchema.safeParse(plain);
  if (!parsed.success) {
    throw new DeclarativeDescriptorError(
      "DESCRIPTOR_INVALID",
      "Descriptor structure is invalid",
      parsed.error.issues.map((issue) => ({
        path: formatIssuePath(issue.path),
        message: issue.message,
      })),
    );
  }
  const raw = parsed.data;

  const name = validateName(raw.name);
  const description = validateDescription(raw.description);
  const method = validateMethod(raw.request.method);
  const path = validatePath(raw.request.path);
  const inputSchema = validateInputSchema(raw.inputSchema);
  const properties = inputSchema.properties as Readonly<
    Record<string, unknown>
  >;
  const requiredNames = new Set(
    Array.isArray(inputSchema.required)
      ? inputSchema.required.filter(
          (entry): entry is string => typeof entry === "string",
        )
      : [],
  );

  const parameters = validateParameters(raw.request.parameters ?? [], {
    path,
    properties,
    requiredNames,
  });
  const body = validateBody(raw.request.body, {
    method,
    properties,
    requiredNames,
  });

  const bound = new Set(parameters.map((parameter) => parameter.name));
  if (body !== undefined) bound.add("body");
  for (const property of Object.keys(properties)) {
    if (!bound.has(property)) {
      throw new DeclarativeDescriptorError(
        "BINDING_INVALID",
        `Input schema property '${property}' is not bound to a request parameter or body`,
      );
    }
  }

  const schemeMap = normalizeAuthSchemeMap(options.authSchemes);
  const authentication = validateAuthentication(raw.authentication, schemeMap);
  const policy = validatePolicy(raw.policy, method);

  const descriptor: DeclarativeToolDescriptor = {
    descriptorVersion: 1,
    name,
    description,
    request: {
      method,
      path,
      parameters: parameters.map((parameter) => ({
        name: parameter.name,
        in: parameter.in,
        required: parameter.required,
      })),
      ...(body === undefined ? {} : { body }),
    },
    inputSchema,
    ...(authentication === undefined
      ? {}
      : { authentication: authentication.descriptor }),
    ...(policy === undefined ? {} : { policy: policy.descriptor }),
  };

  const operation: CompiledOperation = {
    name,
    description,
    inputSchema,
    operation:
      policy?.requiredScopes === undefined
        ? {}
        : { requiredScopes: policy.requiredScopes },
    method: method.toLowerCase() as HttpMethod,
    path,
    readOnly: method === "GET" || method === "HEAD",
    deprecated: false,
    parameters: [...parameters].sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    ),
    ...(body === undefined
      ? {}
      : {
          requestBody: {
            mediaType: body.mediaType,
            required: body.required,
            kind: "json" as const,
          },
        }),
    responses: [],
    security: authentication?.security ?? [],
    authentication: authentication?.compiled ?? {
      alternatives: [],
      allowsAnonymous: false,
    },
    sourceLocation: `declarative:${name}`,
  };

  const revision = `sha256:${createHash("sha256")
    .update(`chainmcp:declarative:v1\n${canonicalize(descriptor)}`, "utf8")
    .digest("hex")}`;

  return Object.freeze({
    descriptor: Object.freeze(descriptor),
    operation,
    revision,
  });
}

/**
 * Parses a UTF-8 JSON descriptor. Rejects oversized or non-JSON input before
 * validation, which is the entry point a future admin API will use.
 */
export function parseDeclarativeToolDescriptorJson(
  text: string,
  options: ParseDeclarativeDescriptorOptions = {},
): ParsedDeclarativeTool {
  if (typeof text !== "string") {
    throw new DeclarativeDescriptorError(
      "DESCRIPTOR_INVALID",
      "Descriptor JSON must be a string",
    );
  }
  if (Buffer.byteLength(text, "utf8") > MAX_DESCRIPTOR_BYTES) {
    throw new DeclarativeDescriptorError(
      "DESCRIPTOR_TOO_LARGE",
      `Descriptor exceeds ${MAX_DESCRIPTOR_BYTES} bytes`,
    );
  }
  let input: unknown;
  try {
    input = JSON.parse(text) as unknown;
  } catch {
    throw new DeclarativeDescriptorError(
      "DESCRIPTOR_INVALID",
      "Descriptor is not valid JSON",
    );
  }
  return parseDeclarativeToolDescriptor(input, options);
}

/** Returns the normalized policy attached to the generated tool. */
export function declarativeToolPolicy(
  descriptor: DeclarativeToolDescriptor,
): NormalizedDeclarativePolicy {
  const policy = descriptor.policy;
  if (policy === undefined) return {};
  return {
    ...(policy.requiredScopes === undefined
      ? {}
      : { requiredScopes: policy.requiredScopes }),
    ...(policy.cacheTtlSeconds === undefined
      ? {}
      : { cache: { ttlSeconds: policy.cacheTtlSeconds } }),
    ...(policy.maxOutputTokens === undefined &&
    policy.outputFields === undefined
      ? {}
      : {
          output: {
            ...(policy.maxOutputTokens === undefined
              ? {}
              : { maxTokens: policy.maxOutputTokens }),
            ...(policy.outputFields === undefined
              ? {}
              : { fields: policy.outputFields }),
          },
        }),
    ...(policy.timeoutMs === undefined ? {} : { timeoutMs: policy.timeoutMs }),
  };
}

function validateName(value: string): string {
  if (!TOOL_NAME.test(value)) {
    throw new DeclarativeDescriptorError(
      "NAME_INVALID",
      "Tool name must be 1-64 letters, numbers, underscores, or hyphens",
      [{ path: "name", message: "Invalid tool name" }],
    );
  }
  return value;
}

function validateDescription(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new DeclarativeDescriptorError(
      "DESCRIPTION_INVALID",
      "Tool description must be a non-empty string",
      [{ path: "description", message: "Description is empty" }],
    );
  }
  if (value.length > MAX_DECLARATIVE_DESCRIPTION_LENGTH) {
    throw new DeclarativeDescriptorError(
      "DESCRIPTION_INVALID",
      `Tool description cannot exceed ${MAX_DECLARATIVE_DESCRIPTION_LENGTH} characters`,
    );
  }
  return value;
}

function validateMethod(value: string): DeclarativeHttpMethod {
  const method = value.toUpperCase();
  if (!SUPPORTED_METHODS.has(method)) {
    throw new DeclarativeDescriptorError(
      "METHOD_UNSUPPORTED",
      `HTTP method '${value}' is not supported; use GET, HEAD, POST, PUT, PATCH, or DELETE`,
      [{ path: "request.method", message: "Unsupported method" }],
    );
  }
  return method as DeclarativeHttpMethod;
}

function validatePath(value: string): string {
  const fail = (detail: string): never => {
    throw new DeclarativeDescriptorError("PATH_INVALID", detail, [
      { path: "request.path", message: detail },
    ]);
  };
  if (!value.startsWith("/")) {
    return fail(
      "request.path must be a relative path starting with '/'; absolute URLs are not allowed",
    );
  }
  if (value.startsWith("//")) {
    return fail("request.path must not start with '//'");
  }
  if (value.length > MAX_DECLARATIVE_PATH_LENGTH) {
    return fail(
      `request.path cannot exceed ${MAX_DECLARATIVE_PATH_LENGTH} characters`,
    );
  }
  if (
    value.includes("\\") ||
    value.includes("?") ||
    value.includes("#") ||
    hasControlCharacter(value)
  ) {
    return fail(
      "request.path must not contain a query, fragment, or control characters",
    );
  }
  const segments = value.split("/").slice(1);
  for (const segment of segments) {
    if (segment.length === 0) {
      return fail("request.path must not contain empty segments");
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return fail("request.path contains invalid percent-encoding");
    }
    if (decoded === "." || decoded === "..") {
      return fail("request.path must not contain dot segments");
    }
  }
  for (const placeholder of extractPlaceholders(value)) {
    if (!PARAMETER_NAME.test(placeholder)) {
      return fail(`Path placeholder '{${placeholder}}' is invalid`);
    }
  }
  if (value.replace(/\{[^{}]*\}/g, "").match(/[{}]/)) {
    return fail("request.path contains an unbalanced or nested placeholder");
  }
  return value;
}

function extractPlaceholders(path: string): string[] {
  const names: string[] = [];
  for (const match of path.matchAll(/\{([^{}]*)\}/g)) {
    names.push(match[1] ?? "");
  }
  return names;
}

function validateInputSchema(value: unknown): JsonSchema & {
  properties: Record<string, unknown>;
} {
  if (!isPlainObject(value)) {
    throw new DeclarativeDescriptorError(
      "SCHEMA_INVALID",
      "inputSchema must be a JSON Schema object",
      [{ path: "inputSchema", message: "Not an object" }],
    );
  }
  if (value.type !== "object") {
    throw new DeclarativeDescriptorError(
      "SCHEMA_INVALID",
      "inputSchema must declare type 'object'",
    );
  }
  const audit = auditInputSchema(value);
  if (!audit.supported || audit.diagnostics.length > 0) {
    const first = audit.diagnostics[0];
    throw new DeclarativeDescriptorError(
      "SCHEMA_INVALID",
      first === undefined
        ? "inputSchema is not supported"
        : `${first.code}: ${first.message}`,
      audit.diagnostics.map((diagnostic) => ({
        path: "inputSchema",
        message: `${diagnostic.code}: ${diagnostic.message}`,
      })),
    );
  }
  if (value.additionalProperties !== false) {
    throw new DeclarativeDescriptorError(
      "SCHEMA_INVALID",
      "inputSchema must set additionalProperties: false so unknown arguments are rejected",
    );
  }
  if (!isPlainObject(value.properties)) {
    throw new DeclarativeDescriptorError(
      "SCHEMA_INVALID",
      "inputSchema must declare a properties object",
    );
  }
  const propertyCount = Object.keys(value.properties).length;
  if (propertyCount > MAX_DECLARATIVE_PROPERTIES) {
    throw new DeclarativeDescriptorError(
      "SCHEMA_INVALID",
      `inputSchema cannot declare more than ${MAX_DECLARATIVE_PROPERTIES} properties`,
    );
  }
  for (const key of Object.keys(value.properties)) {
    if (RESERVED_KEYS.has(key)) {
      throw new DeclarativeDescriptorError(
        "SCHEMA_INVALID",
        `inputSchema property '${key}' is reserved`,
      );
    }
  }
  return value as JsonSchema & { properties: Record<string, unknown> };
}

interface ParameterContext {
  path: string;
  properties: Readonly<Record<string, unknown>>;
  requiredNames: ReadonlySet<string>;
}

function validateParameters(
  raw: readonly RawParameterInput[],
  context: ParameterContext,
): CompiledParameter[] {
  if (raw.length > MAX_DECLARATIVE_PARAMETERS) {
    throw new DeclarativeDescriptorError(
      "PARAMETER_INVALID",
      `A descriptor cannot declare more than ${MAX_DECLARATIVE_PARAMETERS} parameters`,
    );
  }
  const placeholders = extractPlaceholders(context.path);
  const pathParameters = new Set<string>();
  const seen = new Set<string>();
  const boundNames = new Set<string>();
  const parameters: CompiledParameter[] = [];

  raw.forEach((parameter, index) => {
    const location = `request.parameters[${index}]`;
    const fail = (detail: string): never => {
      throw new DeclarativeDescriptorError("PARAMETER_INVALID", detail, [
        { path: location, message: detail },
      ]);
    };
    if (
      !PARAMETER_NAME.test(parameter.name) ||
      RESERVED_KEYS.has(parameter.name)
    ) {
      fail(`Parameter name '${parameter.name}' is invalid`);
    }
    const locationName = parameter.in;
    if (!isParameterLocation(locationName)) {
      fail(`Parameter '${parameter.name}' has an unsupported location`);
    }
    const key = `${locationName}:${parameter.name}`;
    if (seen.has(key)) {
      fail(
        `Parameter '${parameter.name}' is declared twice in '${locationName}'`,
      );
    }
    seen.add(key);
    if (boundNames.has(parameter.name)) {
      fail(
        `Input property '${parameter.name}' is bound to more than one request location`,
      );
    }
    boundNames.add(parameter.name);

    const required = parameter.required ?? false;
    if (locationName === "path" && !required) {
      fail(`Path parameter '${parameter.name}' must be required`);
    }
    if (required && !context.requiredNames.has(parameter.name)) {
      fail(
        `Required parameter '${parameter.name}' must appear in inputSchema.required`,
      );
    }
    if (locationName === "header") {
      if (!isValidRequestHeaderName(parameter.name)) {
        fail(`Header parameter '${parameter.name}' is not a valid header name`);
      }
      if (isReservedRequestHeader(parameter.name)) {
        fail(`Header parameter '${parameter.name}' is reserved`);
      }
    }
    const property = context.properties[parameter.name];
    if (property === undefined) {
      fail(
        `Parameter '${parameter.name}' must have a matching inputSchema property`,
      );
    }
    assertParameterSchema(parameter.name, locationName, property);

    if (locationName === "path") {
      pathParameters.add(parameter.name);
    }
    parameters.push({
      name: parameter.name,
      in: locationName,
      required,
    });
  });

  for (const placeholder of placeholders) {
    if (!pathParameters.has(placeholder)) {
      throw new DeclarativeDescriptorError(
        "PATH_INVALID",
        `Path placeholder '{${placeholder}}' has no matching path parameter`,
      );
    }
  }
  for (const name of pathParameters) {
    if (
      placeholders.filter((placeholder) => placeholder === name).length !== 1
    ) {
      throw new DeclarativeDescriptorError(
        "PATH_INVALID",
        `Path parameter '${name}' must appear exactly once in request.path`,
      );
    }
  }
  return parameters;
}

function assertParameterSchema(
  name: string,
  location: DeclarativeParameterLocation,
  schema: unknown,
): void {
  if (!isPlainObject(schema)) {
    parameterBindingFail(
      name,
      "inputSchema property must be a JSON Schema object",
    );
  }
  const type = schema.type;
  if (type === "array") {
    if (location === "path") {
      parameterBindingFail(name, "path parameters cannot be arrays");
    }
    const items = schema.items;
    if (!isPlainObject(items)) {
      parameterBindingFail(name, "array parameters must declare object items");
    }
    assertPrimitiveType(
      items.type,
      (detail) => parameterBindingFail(name, detail),
      "array items",
    );
    return;
  }
  assertPrimitiveType(
    type,
    (detail) => parameterBindingFail(name, detail),
    "value",
  );
}

function parameterBindingFail(name: string, detail: string): never {
  throw new DeclarativeDescriptorError(
    "BINDING_INVALID",
    `Parameter '${name}': ${detail}`,
  );
}

function assertPrimitiveType(
  type: unknown,
  fail: (detail: string) => never,
  subject: string,
): void {
  if (typeof type === "string") {
    if (!PRIMITIVE_TYPES.has(type)) {
      fail(
        `${subject} type '${type}' is not supported; use string, number, integer, or boolean`,
      );
    }
    return;
  }
  if (Array.isArray(type) && type.length > 0) {
    for (const entry of type) {
      if (typeof entry !== "string" || !PRIMITIVE_TYPES.has(entry)) {
        fail(
          `${subject} type union may contain only string, number, integer, and boolean`,
        );
      }
    }
    return;
  }
  fail(
    `${subject} must declare a primitive type (string, number, integer, or boolean)`,
  );
}

interface BodyContext {
  method: DeclarativeHttpMethod;
  properties: Readonly<Record<string, unknown>>;
  requiredNames: ReadonlySet<string>;
}

interface NormalizedBody {
  mediaType: string;
  required: boolean;
}

function validateBody(
  raw: RawBodyInput | undefined,
  context: BodyContext,
): NormalizedBody | undefined {
  if (raw === undefined) return undefined;
  if (context.method === "GET" || context.method === "HEAD") {
    throw new DeclarativeDescriptorError(
      "BODY_INVALID",
      "GET and HEAD descriptors cannot declare a request body",
    );
  }
  const mediaType = raw.mediaType ?? "application/json";
  if (
    mediaType.length > 128 ||
    hasControlCharacter(mediaType) ||
    !isJsonMediaType(mediaType)
  ) {
    throw new DeclarativeDescriptorError(
      "BODY_INVALID",
      "Version 1 request bodies must use application/json or a +json media type",
    );
  }
  if (!Object.hasOwn(context.properties, "body")) {
    throw new DeclarativeDescriptorError(
      "BINDING_INVALID",
      "A request body requires an inputSchema property named 'body'",
    );
  }
  const required = raw.required ?? false;
  if (required && !context.requiredNames.has("body")) {
    throw new DeclarativeDescriptorError(
      "BODY_INVALID",
      "A required request body must appear in inputSchema.required",
    );
  }
  return { mediaType, required };
}

function isJsonMediaType(mediaType: string): boolean {
  const base = (mediaType.split(";")[0] ?? "").trim().toLowerCase();
  return (
    base === "application/json" ||
    (base.startsWith("application/") && base.endsWith("+json"))
  );
}

interface NormalizedAuthentication {
  descriptor: DeclarativeAuthenticationDescriptor;
  compiled: CompiledAuthenticationPolicy;
  security: readonly SecurityRequirement[];
}

function validateAuthentication(
  raw: RawAuthenticationInput | undefined,
  schemes: DeclarativeAuthSchemeMap,
): NormalizedAuthentication | undefined {
  if (raw === undefined) return undefined;
  if (raw.alternatives.length === 0) {
    throw new DeclarativeDescriptorError(
      "DESCRIPTOR_INVALID",
      "authentication.alternatives must contain at least one alternative",
    );
  }
  if (raw.alternatives.length > MAX_DECLARATIVE_AUTH_ALTERNATIVES) {
    throw new DeclarativeDescriptorError(
      "DESCRIPTOR_INVALID",
      `authentication cannot declare more than ${MAX_DECLARATIVE_AUTH_ALTERNATIVES} alternatives`,
    );
  }

  const descriptorAlternatives: DeclarativeSecurityAlternative[] = [];
  const compiledAlternatives: Array<{
    schemes: CompiledAuthenticationScheme[];
  }> = [];
  const security: SecurityRequirement[] = [];
  let allowsAnonymous = false;

  raw.alternatives.forEach((alternative, index) => {
    if (alternative.schemes.length > MAX_DECLARATIVE_AUTH_SCHEMES) {
      throw new DeclarativeDescriptorError(
        "DESCRIPTOR_INVALID",
        `An authentication alternative cannot declare more than ${MAX_DECLARATIVE_AUTH_SCHEMES} schemes`,
      );
    }
    if (alternative.schemes.length === 0) {
      allowsAnonymous = true;
      descriptorAlternatives.push({ schemes: [] });
      compiledAlternatives.push({ schemes: [] });
      security.push({});
      return;
    }
    const seen = new Set<string>();
    const descriptorSchemes: DeclarativeSecuritySchemeReference[] = [];
    const compiledSchemes: CompiledAuthenticationScheme[] = [];
    const requirement: Record<string, string[]> = Object.create(null);

    for (const reference of alternative.schemes) {
      const where = `authentication.alternatives[${index}]`;
      if (
        !PARAMETER_NAME.test(reference.name) ||
        RESERVED_KEYS.has(reference.name)
      ) {
        throw new DeclarativeDescriptorError(
          "AUTH_SCHEME_INVALID",
          `Authentication scheme name '${reference.name}' is invalid`,
          [{ path: where, message: "Invalid scheme name" }],
        );
      }
      if (seen.has(reference.name)) {
        throw new DeclarativeDescriptorError(
          "AUTH_SCHEME_INVALID",
          `Authentication alternative references scheme '${reference.name}' twice`,
          [{ path: where, message: "Duplicate scheme reference" }],
        );
      }
      seen.add(reference.name);
      const scheme = schemes[reference.name];
      if (scheme === undefined) {
        throw new DeclarativeDescriptorError(
          "AUTH_SCHEME_UNKNOWN",
          `Authentication scheme '${reference.name}' is not configured by the deployment`,
          [{ path: where, message: "Unknown scheme" }],
        );
      }
      const scopes = normalizeScopes(reference.scopes, where);
      if (scopes.length > 0 && scheme.type !== "oauth2") {
        throw new DeclarativeDescriptorError(
          "AUTH_SCHEME_INVALID",
          `Scheme '${reference.name}' cannot require scopes because it is not an OAuth 2.0 scheme`,
          [{ path: where, message: "Scopes on a non-OAuth scheme" }],
        );
      }
      descriptorSchemes.push({
        name: reference.name,
        ...(scopes.length === 0 ? {} : { scopes }),
      });
      requirement[reference.name] = scopes;
      compiledSchemes.push({
        name: reference.name,
        type: scheme.type,
        scopes,
        ...(scheme.type === "apiKey"
          ? {
              parameterName: scheme.parameterName,
              parameterLocation: scheme.parameterLocation,
            }
          : {}),
        ...(scheme.type === "http"
          ? {
              httpScheme: scheme.httpScheme,
              ...(scheme.bearerFormat === undefined
                ? {}
                : { bearerFormat: scheme.bearerFormat }),
            }
          : {}),
      });
    }
    descriptorAlternatives.push({ schemes: descriptorSchemes });
    compiledAlternatives.push({ schemes: compiledSchemes });
    security.push(requirement);
  });

  return {
    descriptor: { alternatives: descriptorAlternatives },
    compiled: { alternatives: compiledAlternatives, allowsAnonymous },
    security,
  };
}

function normalizeScopes(
  raw: readonly string[] | undefined,
  where: string,
): string[] {
  if (raw === undefined) return [];
  if (raw.length > MAX_DECLARATIVE_SCOPES) {
    throw new DeclarativeDescriptorError(
      "AUTH_SCHEME_INVALID",
      `An authentication alternative cannot require more than ${MAX_DECLARATIVE_SCOPES} scopes`,
      [{ path: where, message: "Too many scopes" }],
    );
  }
  const scopes = new Set<string>();
  for (const scope of raw) {
    if (
      typeof scope !== "string" ||
      scope.trim().length === 0 ||
      scope.length > 128 ||
      hasControlCharacter(scope)
    ) {
      throw new DeclarativeDescriptorError(
        "AUTH_SCHEME_INVALID",
        "Scope values must be short, non-empty strings without control characters",
        [{ path: where, message: "Invalid scope" }],
      );
    }
    scopes.add(scope);
  }
  return [...scopes].sort();
}

interface NormalizedPolicy extends NormalizedDeclarativePolicy {
  descriptor: DeclarativePolicyDescriptor;
}

function validatePolicy(
  raw: RawPolicyInput | undefined,
  method: DeclarativeHttpMethod,
): NormalizedPolicy | undefined {
  if (raw === undefined) return undefined;
  const requiredScopes =
    raw.requiredScopes === undefined
      ? undefined
      : normalizeRequiredScopes(raw.requiredScopes);

  if (raw.cacheTtlSeconds !== undefined) {
    if (method !== "GET" && method !== "HEAD") {
      throw new DeclarativeDescriptorError(
        "POLICY_INVALID",
        "cacheTtlSeconds is only allowed on read methods (GET or HEAD)",
      );
    }
    if (
      !Number.isSafeInteger(raw.cacheTtlSeconds) ||
      raw.cacheTtlSeconds <= 0 ||
      raw.cacheTtlSeconds > MAX_DECLARATIVE_CACHE_TTL_SECONDS
    ) {
      throw new DeclarativeDescriptorError(
        "POLICY_INVALID",
        `cacheTtlSeconds must be an integer between 1 and ${MAX_DECLARATIVE_CACHE_TTL_SECONDS}`,
      );
    }
  }
  if (raw.maxOutputTokens !== undefined) {
    if (
      !Number.isSafeInteger(raw.maxOutputTokens) ||
      raw.maxOutputTokens <= 0 ||
      raw.maxOutputTokens > MAX_OUTPUT_TOKENS
    ) {
      throw new DeclarativeDescriptorError(
        "POLICY_INVALID",
        `maxOutputTokens must be an integer between 1 and ${MAX_OUTPUT_TOKENS}`,
      );
    }
  }
  if (raw.outputFields !== undefined) {
    try {
      assertFieldSelection(raw.outputFields);
    } catch (error) {
      throw new DeclarativeDescriptorError(
        "POLICY_INVALID",
        `outputFields is invalid: ${
          error instanceof Error ? error.message : "invalid selection"
        }`,
      );
    }
  }
  if (raw.timeoutMs !== undefined) {
    if (
      !Number.isSafeInteger(raw.timeoutMs) ||
      raw.timeoutMs <= 0 ||
      raw.timeoutMs > MAX_DECLARATIVE_TIMEOUT_MS
    ) {
      throw new DeclarativeDescriptorError(
        "POLICY_INVALID",
        `timeoutMs must be an integer between 1 and ${MAX_DECLARATIVE_TIMEOUT_MS}`,
      );
    }
  }

  const outputFields: FieldSelection | undefined =
    raw.outputFields === undefined
      ? undefined
      : {
          ...(raw.outputFields.include === undefined
            ? {}
            : { include: [...raw.outputFields.include] }),
          ...(raw.outputFields.exclude === undefined
            ? {}
            : { exclude: [...raw.outputFields.exclude] }),
        };

  const descriptor: DeclarativePolicyDescriptor = {
    ...(requiredScopes === undefined ? {} : { requiredScopes }),
    ...(raw.cacheTtlSeconds === undefined
      ? {}
      : { cacheTtlSeconds: raw.cacheTtlSeconds }),
    ...(raw.maxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: raw.maxOutputTokens }),
    ...(outputFields === undefined ? {} : { outputFields }),
    ...(raw.timeoutMs === undefined ? {} : { timeoutMs: raw.timeoutMs }),
  };
  if (Object.keys(descriptor).length === 0) return undefined;

  return {
    descriptor,
    ...(requiredScopes === undefined ? {} : { requiredScopes }),
    ...(raw.cacheTtlSeconds === undefined
      ? {}
      : { cache: { ttlSeconds: raw.cacheTtlSeconds } }),
    ...(raw.maxOutputTokens === undefined && outputFields === undefined
      ? {}
      : {
          output: {
            ...(raw.maxOutputTokens === undefined
              ? {}
              : { maxTokens: raw.maxOutputTokens }),
            ...(outputFields === undefined ? {} : { fields: outputFields }),
          },
        }),
    ...(raw.timeoutMs === undefined ? {} : { timeoutMs: raw.timeoutMs }),
  };
}

function normalizeRequiredScopes(raw: readonly string[]): string[] {
  if (raw.length > MAX_DECLARATIVE_SCOPES) {
    throw new DeclarativeDescriptorError(
      "POLICY_INVALID",
      `requiredScopes cannot exceed ${MAX_DECLARATIVE_SCOPES} entries`,
    );
  }
  const scopes = new Set<string>();
  for (const scope of raw) {
    if (
      typeof scope !== "string" ||
      scope.trim().length === 0 ||
      scope.length > 128 ||
      hasControlCharacter(scope)
    ) {
      throw new DeclarativeDescriptorError(
        "POLICY_INVALID",
        "requiredScopes entries must be short, non-empty strings without control characters",
      );
    }
    scopes.add(scope);
  }
  return [...scopes].sort();
}

function formatIssuePath(path: readonly PropertyKey[]): string {
  if (path.length === 0) return "descriptor";
  let output = "";
  for (const segment of path) {
    if (typeof segment === "number") {
      output += `[${segment}]`;
    } else if (output.length === 0) {
      output = String(segment);
    } else {
      output += `.${String(segment)}`;
    }
  }
  return output;
}

interface CanonicalState {
  nodes: number;
}

/**
 * Canonical JSON with sorted object keys, a bounded depth and node count, and
 * no support for non-JSON values. Produces a plain-data copy that later stages
 * can treat as inert.
 */
function canonicalize(value: unknown): string {
  try {
    return canonicalValue(value, 0, { nodes: 0 });
  } catch (error) {
    if (error instanceof DeclarativeDescriptorError) throw error;
    throw new DeclarativeDescriptorError(
      "DESCRIPTOR_INVALID",
      "Descriptor could not be serialized as JSON",
    );
  }
}

function canonicalValue(
  value: unknown,
  depth: number,
  state: CanonicalState,
): string {
  if (depth > MAX_CANONICAL_DEPTH) {
    throw new DeclarativeDescriptorError(
      "DESCRIPTOR_INVALID",
      `Descriptor nesting cannot exceed ${MAX_CANONICAL_DEPTH} levels`,
    );
  }
  state.nodes += 1;
  if (state.nodes > MAX_CANONICAL_NODES) {
    throw new DeclarativeDescriptorError(
      "DESCRIPTOR_INVALID",
      `Descriptor cannot exceed ${MAX_CANONICAL_NODES} values`,
    );
  }
  if (Array.isArray(value)) {
    return `[${value
      .map((entry) => canonicalValue(entry, depth + 1, state))
      .join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    if (
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    ) {
      throw new DeclarativeDescriptorError(
        "DESCRIPTOR_INVALID",
        "Descriptor must contain only plain JSON objects",
      );
    }
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalValue(record[key], depth + 1, state)}`,
      );
    return `{${entries.join(",")}}`;
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return JSON.stringify(value);
  }
  throw new DeclarativeDescriptorError(
    "DESCRIPTOR_INVALID",
    "Descriptor must contain only JSON values",
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function isParameterLocation(
  value: string,
): value is DeclarativeParameterLocation {
  return (
    value === "path" ||
    value === "query" ||
    value === "header" ||
    value === "cookie"
  );
}

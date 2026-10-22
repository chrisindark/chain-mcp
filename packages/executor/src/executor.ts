import {
  RuntimeError,
  type ToolContext,
  type ToolDefinition,
} from "@chainmcp/core";
import type { CompiledOperation } from "@chainmcp/compiler";
import type {
  UpstreamCredential,
  UpstreamCredentialProvider,
} from "@chainmcp/auth";

import {
  DEFAULT_MAX_URL_LENGTH,
  effectivePort,
  normalizeAllowedHost,
  normalizeHostname,
  resolveDestination,
  systemHostResolver,
  type DestinationPolicy,
} from "./destination.js";
import {
  DestinationPolicyError,
  InvalidResponseError,
  RedirectLimitError,
  RequestBuildError,
  ResponseTooLargeError,
  UnsupportedResponseError,
  UpstreamStatusError,
} from "./errors.js";
import { createNodeUpstreamTransport } from "./transport.js";
import type {
  HostResolver,
  UpstreamExecutor,
  UpstreamExecutorOptions,
  UpstreamTransport,
  UpstreamTransportResponse,
} from "./types.js";

export const EXECUTOR_VERSION = "0.1.0";
export const DEFAULT_MAX_RESPONSE_BYTES = 1_000_000;
export const MAX_RESPONSE_BYTES_LIMIT = 10_000_000;
export const DEFAULT_MAX_REQUEST_BYTES = 1_000_000;
export const MAX_REQUEST_BYTES_LIMIT = 10_000_000;
export const DEFAULT_MAX_REDIRECTS = 3;
export const MAX_REDIRECTS_LIMIT = 5;
export const DEFAULT_TIMEOUT_MS = 15_000;
export const MAX_TIMEOUT_MS = 120_000;
export const MAX_REQUEST_HEADER_BYTES = 16_384;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const HTTP_METHODS = new Set([
  "GET",
  "PUT",
  "POST",
  "DELETE",
  "OPTIONS",
  "HEAD",
  "PATCH",
  "TRACE",
]);
const RESERVED_REQUEST_HEADERS = new Set([
  "__proto__",
  "accept",
  "accept-encoding",
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
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

interface NormalizedExecutorOptions {
  baseUrl: URL;
  policy: DestinationPolicy;
  resolver: HostResolver;
  transport: UpstreamTransport;
  credentialProvider?: UpstreamCredentialProvider;
  maxResponseBytes: number;
  maxRequestBytes: number;
  maxRedirects: number;
  timeoutMs: number;
  contractRevision?: string;
  ownerTenantId?: string;
}

interface BuiltRequest {
  url: URL;
  method: string;
  headers: Readonly<Record<string, string>>;
  body?: Uint8Array;
}

interface StopSignal {
  signal: AbortSignal;
  timedOut: () => boolean;
  dispose: () => void;
}

/**
 * Creates an executor that turns compiled operations into runtime tools.
 * `execute` maps declared path/query/header parameters and a JSON `body` into a
 * bounded upstream request, follows only same-host redirects, and returns
 * parsed JSON.
 *
 * Authentication policies are metadata only in this slice: no credentials are
 * resolved or injected.
 */
export function createUpstreamExecutor(
  options: UpstreamExecutorOptions,
): UpstreamExecutor {
  const settings = normalizeOptions(options);

  function createTool(operation: CompiledOperation): ToolDefinition {
    validateOperation(operation);
    const tool: ToolDefinition = {
      name: operation.name,
      description: operation.description,
      inputSchema: operation.inputSchema,
      operation: operation.operation,
      execute: (input: unknown, context: ToolContext) =>
        executeOperation(operation, input, context, settings),
      ...(settings.contractRevision === undefined
        ? {}
        : { contractRevision: settings.contractRevision }),
      ...(settings.ownerTenantId === undefined
        ? {}
        : { ownerTenantId: settings.ownerTenantId }),
    };
    return tool;
  }

  return {
    createTool,
    createTools: (operations) => operations.map(createTool),
  };
}

async function executeOperation(
  operation: CompiledOperation,
  input: unknown,
  context: ToolContext,
  settings: NormalizedExecutorOptions,
): Promise<unknown> {
  if (context.signal?.aborted) {
    throw new RuntimeError("CANCELLED", "Tool call was cancelled", {
      cause: context.signal.reason,
    });
  }
  const stop = createStopSignal(context.signal, settings.timeoutMs);
  try {
    const credentials = await abortable(
      resolveUpstreamCredentials(
        operation,
        context,
        settings.credentialProvider,
        stop.signal,
      ),
      stop.signal,
    );
    let current = buildInitialRequest(
      operation,
      input,
      settings.baseUrl,
      settings.maxRequestBytes,
      settings.policy.maxUrlLength,
      credentials,
    );
    for (let redirects = 0; ; redirects += 1) {
      const destination = await abortable(
        resolveDestination(current.url, settings.policy, settings.resolver),
        stop.signal,
      );
      const response = await abortable(
        settings.transport.request({
          url: destination.url,
          hostname: destination.hostname,
          address: destination.address,
          family: destination.family,
          method: current.method,
          headers: current.headers,
          ...(current.body === undefined ? {} : { body: current.body }),
          maxResponseBytes: settings.maxResponseBytes,
          signal: stop.signal,
        }),
        stop.signal,
      );
      if (response.body.byteLength > settings.maxResponseBytes) {
        throw new ResponseTooLargeError();
      }

      const location = headerValue(response.headers, "location");
      if (REDIRECT_STATUSES.has(response.status) && location !== undefined) {
        if (redirects >= settings.maxRedirects) {
          throw new RedirectLimitError();
        }
        if (location.trim().length === 0) {
          throw new InvalidResponseError("Upstream redirect had no location");
        }
        let nextUrl: URL;
        try {
          nextUrl = new URL(location, current.url);
        } catch {
          throw new InvalidResponseError(
            "Upstream redirect location is invalid",
          );
        }
        let nextHostname: string;
        try {
          nextHostname = normalizeHostname(nextUrl.hostname);
        } catch {
          throw new DestinationPolicyError(
            "Upstream redirect location is invalid",
          );
        }
        if (nextHostname !== destination.hostname) {
          // Cross-host redirects would forward caller-supplied header
          // parameters to a different host. Keep the chain same-origin.
          throw new DestinationPolicyError(
            "Upstream redirects must not change host",
          );
        }
        const redirect = redirectRequest(current.method, response.status);
        current = {
          url: nextUrl,
          method: redirect.method,
          headers: redirect.dropBody
            ? withoutHeaders(current.headers, [
                "content-type",
                "content-length",
              ])
            : current.headers,
          ...(redirect.dropBody || current.body === undefined
            ? {}
            : { body: current.body }),
        };
        continue;
      }

      if (response.status < 200 || response.status >= 300) {
        throw new UpstreamStatusError(response.status);
      }
      const result = parseJsonResponse(response);
      if (stop.signal.aborted) {
        throw stop.signal.reason ?? new Error("Upstream request was aborted");
      }
      return result;
    }
  } catch (error) {
    throw mapExecutionError(error, stop, context.signal);
  } finally {
    stop.dispose();
  }
}

function normalizeOptions(
  options: UpstreamExecutorOptions,
): NormalizedExecutorOptions {
  if (
    typeof options !== "object" ||
    options === null ||
    Array.isArray(options)
  ) {
    throw new TypeError("Executor options must be an object");
  }
  let baseUrl: URL;
  try {
    baseUrl = new URL(options.baseUrl);
  } catch {
    throw new TypeError("Executor baseUrl must be an absolute URL");
  }
  if (baseUrl.username.length > 0 || baseUrl.password.length > 0) {
    throw new TypeError("Executor baseUrl must not contain credentials");
  }
  if (baseUrl.protocol !== "https:" && baseUrl.protocol !== "http:") {
    throw new TypeError("Executor baseUrl must use HTTP or HTTPS");
  }
  if (baseUrl.search.length > 0 || baseUrl.hash.length > 0) {
    throw new TypeError(
      "Executor baseUrl must not contain a query or fragment",
    );
  }
  if (baseUrl.port.length > 0) {
    const port = Number(baseUrl.port);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new TypeError("Executor baseUrl port is invalid");
    }
  }
  const allowInsecureHttp = options.allowInsecureHttp ?? false;
  if (typeof allowInsecureHttp !== "boolean") {
    throw new TypeError(
      "Executor option 'allowInsecureHttp' must be a boolean",
    );
  }
  if (baseUrl.protocol === "http:" && !allowInsecureHttp) {
    throw new TypeError(
      "Executor baseUrl uses HTTP; set allowInsecureHttp to opt in",
    );
  }
  if (
    !Array.isArray(options.allowedHosts) ||
    options.allowedHosts.length === 0
  ) {
    throw new TypeError(
      "Executor option 'allowedHosts' must be a non-empty array",
    );
  }
  const allowedHosts = new Set(
    options.allowedHosts.map((host) => normalizeAllowedHost(host)),
  );
  const baseHostname = normalizeHostname(baseUrl.hostname);
  if (!allowedHosts.has(baseHostname)) {
    throw new TypeError("Executor baseUrl host must be allowlisted");
  }
  baseUrl.hostname = baseHostname.includes(":")
    ? `[${baseHostname}]`
    : baseHostname;

  const maxResponseBytes = boundedInteger(
    "maxResponseBytes",
    options.maxResponseBytes,
    DEFAULT_MAX_RESPONSE_BYTES,
    MAX_RESPONSE_BYTES_LIMIT,
  );
  const maxRequestBytes = boundedInteger(
    "maxRequestBytes",
    options.maxRequestBytes,
    DEFAULT_MAX_REQUEST_BYTES,
    MAX_REQUEST_BYTES_LIMIT,
  );
  const maxRedirects = boundedInteger(
    "maxRedirects",
    options.maxRedirects,
    DEFAULT_MAX_REDIRECTS,
    MAX_REDIRECTS_LIMIT,
    0,
  );
  const timeoutMs = boundedInteger(
    "timeoutMs",
    options.timeoutMs,
    DEFAULT_TIMEOUT_MS,
    MAX_TIMEOUT_MS,
  );
  if (
    options.contractRevision !== undefined &&
    (typeof options.contractRevision !== "string" ||
      options.contractRevision.trim().length === 0)
  ) {
    throw new TypeError(
      "Executor option 'contractRevision' must be a non-empty string",
    );
  }
  if (
    options.ownerTenantId !== undefined &&
    (typeof options.ownerTenantId !== "string" ||
      options.ownerTenantId.trim().length === 0)
  ) {
    throw new TypeError(
      "Executor option 'ownerTenantId' must be a non-empty string",
    );
  }

  if (
    options.credentialProvider !== undefined &&
    (typeof options.credentialProvider !== "object" ||
      options.credentialProvider === null ||
      typeof options.credentialProvider.resolveCredential !== "function")
  ) {
    throw new TypeError(
      "Executor option 'credentialProvider' must be an object with resolveCredential",
    );
  }

  return {
    baseUrl,
    policy: {
      allowedHosts,
      protocol: baseUrl.protocol as "http:" | "https:",
      port: effectivePort(baseUrl),
      allowInsecureHttp,
      maxUrlLength: DEFAULT_MAX_URL_LENGTH,
    },
    resolver: options.resolveHost ?? systemHostResolver,
    transport: options.transport ?? createNodeUpstreamTransport(),
    ...(options.credentialProvider === undefined
      ? {}
      : { credentialProvider: options.credentialProvider }),
    maxResponseBytes,
    maxRequestBytes,
    maxRedirects,
    timeoutMs,
    ...(options.contractRevision === undefined
      ? {}
      : { contractRevision: options.contractRevision }),
    ...(options.ownerTenantId === undefined
      ? {}
      : { ownerTenantId: options.ownerTenantId }),
  };
}

function validateOperation(operation: CompiledOperation): void {
  if (typeof operation !== "object" || operation === null) {
    throw new TypeError("Compiled operation must be an object");
  }
  if (typeof operation.name !== "string" || operation.name.length === 0) {
    throw new TypeError("Compiled operation requires a name");
  }
  if (typeof operation.method !== "string") {
    throw new TypeError("Compiled operation method must be a string");
  }
  if (typeof operation.path !== "string" || !operation.path.startsWith("/")) {
    throw new TypeError("Compiled operation path must start with '/'");
  }
  if (operation.path.includes("?") || operation.path.includes("#")) {
    throw new TypeError(
      "Compiled operation path must not contain a query or fragment",
    );
  }
  if (!HTTP_METHODS.has(operation.method.toUpperCase())) {
    throw new TypeError("Compiled operation method is not supported");
  }
  if (!Array.isArray(operation.parameters)) {
    throw new TypeError("Compiled operation requires parameter metadata");
  }
  for (const parameter of operation.parameters) {
    if (
      typeof parameter !== "object" ||
      parameter === null ||
      typeof parameter.name !== "string" ||
      parameter.name.length === 0 ||
      (parameter.in !== "path" &&
        parameter.in !== "query" &&
        parameter.in !== "header") ||
      typeof parameter.required !== "boolean"
    ) {
      throw new TypeError("Compiled operation has invalid parameter metadata");
    }
  }
  if (
    operation.requestBody !== undefined &&
    (typeof operation.requestBody !== "object" ||
      operation.requestBody === null ||
      typeof operation.requestBody.mediaType !== "string" ||
      typeof operation.requestBody.required !== "boolean")
  ) {
    throw new TypeError("Compiled operation has invalid request body metadata");
  }
}

async function resolveUpstreamCredentials(
  operation: CompiledOperation,
  context: ToolContext,
  provider?: UpstreamCredentialProvider,
  signal?: AbortSignal,
): Promise<readonly UpstreamCredential[] | undefined> {
  const policy = operation.authentication;
  if (!policy || policy.alternatives.length === 0) {
    return undefined;
  }

  for (const alternative of policy.alternatives) {
    if (alternative.schemes.length === 0) {
      return [];
    }

    if (!provider) {
      continue;
    }

    let allSchemesResolved = true;
    const resolvedSchemes: UpstreamCredential[] = [];

    for (const scheme of alternative.schemes) {
      let cred: UpstreamCredential | undefined;
      try {
        cred = await provider.resolveCredential({
          tenantId: context.tenantId,
          ...(context.principal?.id !== undefined
            ? { principalId: context.principal.id }
            : {}),
          toolName: operation.name,
          schemeName: scheme.name,
          schemeType: scheme.type,
          ...(scheme.parameterName !== undefined
            ? { parameterName: scheme.parameterName }
            : {}),
          ...(scheme.parameterLocation !== undefined
            ? { parameterLocation: scheme.parameterLocation }
            : {}),
          ...(scheme.httpScheme !== undefined
            ? { httpScheme: scheme.httpScheme }
            : {}),
          ...(scheme.scopes !== undefined && scheme.scopes.length > 0
            ? { requiredScopes: scheme.scopes }
            : {}),
          ...(signal !== undefined ? { signal } : {}),
        });
      } catch (error) {
        if (signal?.aborted) {
          throw error;
        }
        throw new RuntimeError("AUTH_REQUIRED", "Authentication required", {
          cause: error,
        });
      }

      if (!cred) {
        allSchemesResolved = false;
        break;
      }
      resolvedSchemes.push(cred);
    }

    if (allSchemesResolved) {
      return resolvedSchemes;
    }
  }

  if (policy.allowsAnonymous) {
    return [];
  }

  throw new RuntimeError("AUTH_REQUIRED", "Authentication required");
}

function buildInitialRequest(
  operation: CompiledOperation,
  input: unknown,
  baseUrl: URL,
  maxRequestBytes: number,
  maxUrlLength: number,
  credentials?: readonly UpstreamCredential[],
): BuiltRequest {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new RequestBuildError("Input must be an object");
  }
  const values = input as Readonly<Record<string, unknown>>;
  const path = buildPath(operation, values, maxUrlLength);
  const basePath =
    baseUrl.pathname === "/" ? "" : baseUrl.pathname.replace(/\/$/, "");
  let url: URL;
  try {
    url = new URL(`${baseUrl.origin}${basePath}${path}`);
  } catch {
    throw new RequestBuildError("Upstream URL could not be built");
  }

  for (const parameter of operation.parameters) {
    if (parameter.in !== "query") continue;
    if (!Object.hasOwn(values, parameter.name)) continue;
    appendQuery(url, parameter.name, values[parameter.name], maxUrlLength);
  }

  // A null prototype prevents a header named `__proto__` from mutating the
  // object's prototype; the name is also rejected below.
  const headers = Object.create(null) as Record<string, string>;
  headers.accept = "application/json";
  headers["accept-encoding"] = "identity";
  headers["user-agent"] = `chainmcp-executor/${EXECUTOR_VERSION}`;
  for (const parameter of operation.parameters) {
    if (parameter.in !== "header") continue;
    if (!Object.hasOwn(values, parameter.name)) continue;
    if (!HEADER_NAME.test(parameter.name)) {
      throw new RequestBuildError("Header parameter name is invalid");
    }
    if (RESERVED_REQUEST_HEADERS.has(parameter.name.toLowerCase())) {
      throw new RequestBuildError("Header parameter is reserved");
    }
    headers[parameter.name] = serializeHeader(valueOf(values, parameter.name));
  }

  if (credentials) {
    for (const cred of credentials) {
      if (cred.type === "apiKey") {
        if (cred.location === "header") {
          validateCredentialName(cred.name, "header");
          deleteHeaderCaseInsensitive(headers, cred.name);
          headers[cred.name.toLowerCase()] = assertHeaderValue(cred.value);
        } else if (cred.location === "query") {
          validateCredentialName(cred.name, "query");
          url.searchParams.delete(cred.name);
          appendQuery(url, cred.name, cred.value, maxUrlLength);
        } else if (cred.location === "cookie") {
          validateCredentialName(cred.name, "cookie");
          injectCookie(headers, cred.name, cred.value);
        }
      } else if (cred.type === "http") {
        deleteHeaderCaseInsensitive(headers, "authorization");
        if (cred.scheme === "bearer") {
          headers["authorization"] = assertHeaderValue(`Bearer ${cred.token}`);
        } else if (cred.scheme === "basic") {
          const auth = Buffer.from(
            `${cred.username}:${cred.password}`,
            "utf8",
          ).toString("base64");
          headers["authorization"] = assertHeaderValue(`Basic ${auth}`);
        }
      } else if (cred.type === "oauth2") {
        deleteHeaderCaseInsensitive(headers, "authorization");
        const tokenType = cred.tokenType ?? "Bearer";
        headers["authorization"] = assertHeaderValue(
          `${tokenType} ${cred.token}`,
        );
      }
    }
  }

  let body: Uint8Array | undefined;
  if (operation.requestBody !== undefined) {
    if (Object.hasOwn(values, "body") && values.body !== undefined) {
      let serialized: string | undefined;
      try {
        serialized = JSON.stringify(values.body);
      } catch {
        throw new RequestBuildError("Request body could not be serialized");
      }
      if (serialized === undefined) {
        throw new RequestBuildError("Request body could not be serialized");
      }
      body = new TextEncoder().encode(serialized);
      if (body.byteLength > maxRequestBytes) {
        throw new RequestBuildError("Request body exceeded the size limit");
      }
      const mediaType = operation.requestBody.mediaType;
      if (
        typeof mediaType !== "string" ||
        mediaType.length === 0 ||
        mediaType.length > MAX_REQUEST_HEADER_BYTES ||
        hasControlCharacter(mediaType)
      ) {
        throw new RequestBuildError("Request body media type is invalid");
      }
      headers["content-type"] = mediaType;
    } else if (operation.requestBody.required) {
      throw new RequestBuildError("Required request body is missing");
    }
  } else if (Object.hasOwn(values, "body") && values.body !== undefined) {
    throw new RequestBuildError("Operation does not accept a request body");
  }

  if (url.href.length > maxUrlLength) {
    throw new RequestBuildError("Upstream URL is too long");
  }
  const encoder = new TextEncoder();
  let headerBytes = 0;
  for (const [name, headerValue] of Object.entries(headers)) {
    headerBytes +=
      encoder.encode(name).byteLength +
      encoder.encode(headerValue).byteLength +
      4;
    if (headerBytes > MAX_REQUEST_HEADER_BYTES) {
      throw new RequestBuildError("Request headers exceeded the size limit");
    }
  }
  return {
    url,
    method: operation.method.toUpperCase(),
    headers,
    ...(body === undefined ? {} : { body }),
  };
}

function buildPath(
  operation: CompiledOperation,
  values: Readonly<Record<string, unknown>>,
  maxUrlLength: number,
): string {
  const pathParameters = new Map(
    operation.parameters
      .filter((parameter) => parameter.in === "path")
      .map((parameter) => [parameter.name, parameter]),
  );
  const path = operation.path.replace(
    /\{([^{}]+)\}/g,
    (_match, name: string) => {
      const parameter = pathParameters.get(name);
      if (parameter === undefined) {
        throw new RequestBuildError(
          "Operation path has an undeclared parameter",
        );
      }
      if (!Object.hasOwn(values, name) || values[name] === undefined) {
        throw new RequestBuildError("Path parameter is missing");
      }
      let serialized: string;
      let encoded: string;
      try {
        serialized = serializePrimitive(values[name], "path");
        if (serialized.length > maxUrlLength) {
          throw new RequestBuildError("Upstream URL is too long");
        }
        encoded = encodeURIComponent(serialized);
      } catch (error) {
        if (error instanceof RequestBuildError) throw error;
        throw new RequestBuildError("Path parameter could not be encoded", {
          cause: error,
        });
      }
      if (encoded.length > maxUrlLength) {
        throw new RequestBuildError("Upstream URL is too long");
      }
      return encoded;
    },
  );
  if (path.includes("{") || path.includes("}")) {
    throw new RequestBuildError("Operation path has an unfilled parameter");
  }
  if (path.includes("\\") || hasControlCharacter(path)) {
    throw new RequestBuildError("Operation path contains invalid characters");
  }
  // URL parsing normalizes literal or percent-encoded dot segments. Reject
  // them so a path parameter cannot walk out of the declared operation path.
  for (const segment of path.split("/")) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw new RequestBuildError("Operation path has invalid encoding");
    }
    if (decoded === "." || decoded === "..") {
      throw new RequestBuildError("Operation path contains a dot segment");
    }
  }
  return path;
}

function appendQuery(
  url: URL,
  name: string,
  value: unknown,
  maxUrlLength: number,
): void {
  if (name.length > maxUrlLength) {
    throw new RequestBuildError("Upstream URL is too long");
  }
  const append = (item: unknown): void => {
    const serialized = serializePrimitive(item, "query");
    if (serialized.length > maxUrlLength) {
      throw new RequestBuildError("Upstream URL is too long");
    }
    url.searchParams.append(name, serialized);
    if (url.href.length > maxUrlLength) {
      throw new RequestBuildError("Upstream URL is too long");
    }
  };
  if (Array.isArray(value)) {
    for (const item of value) append(item);
    return;
  }
  append(value);
}

function serializePrimitive(
  value: unknown,
  location: "path" | "query",
): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  throw new RequestBuildError(
    `${location === "path" ? "Path" : "Query"} parameter must be a string, number, or boolean`,
  );
}

function serializeHeader(value: unknown): string {
  if (Array.isArray(value)) {
    const parts: string[] = [];
    let length = 0;
    for (const item of value) {
      const part = serializePrimitive(item, "query");
      length += part.length + 1;
      if (length > MAX_REQUEST_HEADER_BYTES) {
        throw new RequestBuildError("Header value exceeded the size limit");
      }
      parts.push(part);
    }
    return assertHeaderValue(parts.join(","));
  }
  return assertHeaderValue(serializePrimitive(value, "query"));
}

function assertHeaderValue(value: string): string {
  if (value.length > MAX_REQUEST_HEADER_BYTES) {
    throw new RequestBuildError("Header value exceeded the size limit");
  }
  if (hasControlCharacter(value)) {
    throw new RequestBuildError("Header value contains control characters");
  }
  return value;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function validateCredentialName(
  name: string,
  location: "header" | "query" | "cookie",
): void {
  if (typeof name !== "string" || !HEADER_NAME.test(name)) {
    throw new RequestBuildError(
      `Credential ${location} name '${name}' is invalid`,
    );
  }
  const lower = name.toLowerCase();
  if (location === "header" && RESERVED_REQUEST_HEADERS.has(lower)) {
    throw new RequestBuildError(`Credential header name '${name}' is reserved`);
  }
  if (
    lower === "__proto__" ||
    lower === "prototype" ||
    lower === "constructor"
  ) {
    throw new RequestBuildError(
      `Credential ${location} name '${name}' is reserved`,
    );
  }
}

function deleteHeaderCaseInsensitive(
  headers: Record<string, string>,
  name: string,
): void {
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) {
      delete headers[key];
    }
  }
}

function injectCookie(
  headers: Record<string, string>,
  name: string,
  value: string,
): void {
  assertHeaderValue(value);
  const cookiePair = `${name}=${value}`;
  const prev = headers["cookie"];
  if (!prev) {
    headers["cookie"] = cookiePair;
    return;
  }
  const parts = prev
    .split(";")
    .map((p) => p.trim())
    .filter((p) => {
      const eqIdx = p.indexOf("=");
      const existingName = eqIdx === -1 ? p : p.slice(0, eqIdx);
      return existingName.toLowerCase() !== name.toLowerCase();
    });
  parts.push(cookiePair);
  headers["cookie"] = parts.join("; ");
}

function valueOf(
  values: Readonly<Record<string, unknown>>,
  name: string,
): unknown {
  return values[name];
}

function redirectRequest(
  method: string,
  status: number,
): { method: string; dropBody: boolean } {
  if (status === 303 && method !== "GET" && method !== "HEAD") {
    return { method: "GET", dropBody: true };
  }
  if ((status === 301 || status === 302) && method === "POST") {
    return { method: "GET", dropBody: true };
  }
  return { method, dropBody: false };
}

function withoutHeaders(
  headers: Readonly<Record<string, string>>,
  names: readonly string[],
): Record<string, string> {
  const blocked = new Set(names.map((name) => name.toLowerCase()));
  return Object.fromEntries(
    Object.entries(headers).filter(
      ([name]) => !blocked.has(name.toLowerCase()),
    ),
  );
}

function parseJsonResponse(response: UpstreamTransportResponse): unknown {
  if (response.body.byteLength === 0) return null;
  const contentType = headerValue(response.headers, "content-type");
  const base = contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
  const json =
    base === "application/json" ||
    (base.startsWith("application/") && base.endsWith("+json"));
  if (!json) {
    throw new UnsupportedResponseError(
      "Upstream response is not a JSON media type",
    );
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(response.body);
  } catch (error) {
    throw new InvalidResponseError("Upstream response is not valid UTF-8", {
      cause: error,
    });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new InvalidResponseError("Upstream response is not valid JSON", {
      cause: error,
    });
  }
}

function headerValue(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  name: string,
): string | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name) continue;
    return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
}

function createStopSignal(
  parent: AbortSignal | undefined,
  timeoutMs: number,
): StopSignal {
  const controller = new AbortController();
  let timedOut = false;
  const onParentAbort = (): void => controller.abort(parent?.reason);
  if (parent !== undefined) {
    if (parent.aborted) controller.abort(parent.reason);
    else parent.addEventListener("abort", onParentAbort, { once: true });
  }
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("Upstream timeout"));
  }, timeoutMs);
  timer.unref();
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onParentAbort);
    },
  };
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(signal.reason ?? new Error("Aborted"));
  }
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error("Aborted"));
      return;
    }
    const onAbort = (): void => {
      reject(signal.reason ?? new Error("Aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function mapExecutionError(
  error: unknown,
  stop: StopSignal,
  parent: AbortSignal | undefined,
): RuntimeError {
  if (error instanceof RuntimeError) return error;
  if (stop.timedOut()) {
    return new RuntimeError("UPSTREAM_TIMEOUT", "Upstream request timed out", {
      cause: error,
    });
  }
  if (parent?.aborted) {
    return new RuntimeError("CANCELLED", "Tool call was cancelled", {
      cause: error,
    });
  }
  if (error instanceof DestinationPolicyError) {
    return new RuntimeError(
      "UPSTREAM_FAILURE",
      "Upstream destination is not permitted",
      { cause: error },
    );
  }
  if (error instanceof UpstreamStatusError) {
    return new RuntimeError("UPSTREAM_FAILURE", error.message, {
      cause: error,
    });
  }
  if (error instanceof ResponseTooLargeError) {
    return new RuntimeError(
      "UPSTREAM_FAILURE",
      "Upstream response exceeded the size limit",
      { cause: error },
    );
  }
  if (error instanceof RedirectLimitError) {
    return new RuntimeError("UPSTREAM_FAILURE", error.message, {
      cause: error,
    });
  }
  if (error instanceof UnsupportedResponseError) {
    return new RuntimeError("UPSTREAM_FAILURE", error.message, {
      cause: error,
    });
  }
  if (error instanceof InvalidResponseError) {
    return new RuntimeError(
      "UPSTREAM_FAILURE",
      "Upstream response was invalid",
      {
        cause: error,
      },
    );
  }
  if (error instanceof RequestBuildError) {
    return new RuntimeError(
      "UPSTREAM_FAILURE",
      "Upstream request could not be constructed",
      { cause: error },
    );
  }
  return new RuntimeError("UPSTREAM_FAILURE", "Upstream request failed", {
    cause: error,
  });
}

function boundedInteger(
  name: string,
  value: number | undefined,
  fallback: number,
  maximum: number,
  minimum = 1,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(
      `Executor option '${name}' must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return value;
}

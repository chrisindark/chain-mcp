# API Reference: @chainmcp/executor

## `@chainmcp/executor`

`@chainmcp/executor` turns a compiled operation into a runnable `ToolDefinition` with bounded Node HTTP/HTTPS I/O. Outbound requests are protected by SSRF-guarding destination policies, DNS pinning, header/body caps, and response schema validation.

```ts
export interface UpstreamExecutorOptions {
  baseUrl: string;
  allowedHosts: readonly string[];
  allowInsecureHttp?: boolean;
  maxResponseBytes?: number;
  maxRequestBytes?: number;
  maxMultipartPartBytes?: number;
  maxRedirects?: number;
  timeoutMs?: number;
  contractRevision?: string;
  ownerTenantId?: string;
  resolveHost?: HostResolver;
  transport?: UpstreamTransport;
  credentialProvider?: UpstreamCredentialProvider;
  cache?: UpstreamCachePolicy;
  defaultReadCacheTtlSeconds?: number;
  validateResponses?: "off" | "warn" | "enforce";
  logger?: Logger;
}

export type HostResolver = (hostname: string) => Promise<readonly string[]>;

export interface ResolvedDestination {
  url: URL;
  hostname: string;
  address: string;
  family: 4 | 6;
}

export interface UpstreamTransportRequest {
  url: URL;
  hostname: string;
  address: string;
  family: 4 | 6;
  method: string;
  headers: Readonly<Record<string, string>>;
  body?: Uint8Array;
  maxResponseBytes: number;
  signal: AbortSignal;
}

export interface UpstreamTransportResponse {
  status: number;
  headers: Readonly<Record<string, string | string[] | undefined>>;
  body: Uint8Array;
}

export interface UpstreamTransport {
  request(
    request: UpstreamTransportRequest,
  ): Promise<UpstreamTransportResponse>;
}

export interface UpstreamExecutor {
  createTool(operation: CompiledOperation): ToolDefinition;
  createTools(
    operations: readonly CompiledOperation[],
  ): readonly ToolDefinition[];
}

export function createUpstreamExecutor(
  options: UpstreamExecutorOptions,
): UpstreamExecutor;

export function createNodeUpstreamTransport(): UpstreamTransport;

export const EXECUTOR_VERSION: "0.1.0";
export const DEFAULT_MAX_RESPONSE_BYTES: 1_000_000;
export const MAX_RESPONSE_BYTES_LIMIT: 10_000_000;
export const DEFAULT_MAX_REQUEST_BYTES: 1_000_000;
export const MAX_REQUEST_BYTES_LIMIT: 10_000_000;
export const DEFAULT_MAX_MULTIPART_PART_BYTES: 1_000_000;
export const DEFAULT_MAX_REDIRECTS: 3;
export const MAX_REDIRECTS_LIMIT: 5;
export const DEFAULT_TIMEOUT_MS: 15_000;
export const MAX_TIMEOUT_MS: 120_000;
export const MAX_REQUEST_HEADER_BYTES: 16_384;
export const MAX_RESPONSE_HEADER_BYTES: 16_384;

export function serializeFormUrlEncoded(
  body: unknown,
  encodings?: Readonly<Record<string, CompiledEncoding>>,
  maxRequestBytes?: number,
): Uint8Array;

export interface SerializedMultipartBody {
  body: Uint8Array;
  contentType: string;
}

export function serializeMultipartFormData(
  body: unknown,
  encodings?: Readonly<Record<string, CompiledEncoding>>,
  maxMultipartPartBytes?: number,
  maxRequestBytes?: number,
  boundaryOverride?: string,
): SerializedMultipartBody;
```

Typical use:

```ts
const result = compileOpenApi(source);
if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));

const executor = createUpstreamExecutor({
  baseUrl: "https://api.example.com/v1",
  allowedHosts: ["api.example.com"],
  contractRevision: result.contractRevision,
});
const runtime = new InMemoryToolRuntime();
for (const tool of executor.createTools(result.tools)) runtime.register(tool);
```

#### Request mapping

- The base URL's path prefix is prepended to the compiled path. `baseUrl` must be absolute, must not contain a query, fragment, or credentials, and its host must be allowlisted.
- Path parameters are substituted and percent-encoded. Missing path values, undeclared placeholders, unfilled braces, and literal or percent-encoded `.`/`..` segments are request-construction failures, so a value cannot walk out of the declared path.
- Query parameters are appended by name. Arrays are sent as repeated keys. Scalars may be strings, finite numbers, or booleans; objects, arrays of objects, and `null` are rejected because OpenAPI serialization styles are not retained.
- Header parameters are sent as declared. Array values are comma-joined. Control characters, invalid header names, and reserved transport/credential headers are rejected. Compiler `parameters` metadata never includes cookie parameters or the forbidden headers listed for the compiler.
- A JSON `body` input is serialized as UTF-8 with the selected request media type. The body is required only when `requestBody.required` is true.
- Requests set `accept: application/json`, `accept-encoding: identity`, and a package user agent. No inbound identity, token, cookie, or authorization header is forwarded from tool arguments or context.
- When `credentialProvider` is configured, it resolves upstream credentials for operations declaring `CompiledAuthenticationPolicy`. Provider output is validated with `@chainmcp/auth`'s `normalizeUpstreamCredential`; valid credentials (`apiKey`, `http` bearer/basic, `oauth2`) are injected into headers, query parameters, or cookies, and invalid material counts as unresolved. If authentication fails and anonymous access is not allowed, the call rejects with `RuntimeError("AUTH_REQUIRED")`.
- OAuth token acquisition reuses the outbound policy. With a credential provider configured, the executor passes a token endpoint fetcher built from its resolver and transport, so the token request is allowlisted (the provider's `allowedTokenHosts`, otherwise the token URL host), classified, DNS-pinned, peer-verified, and capped exactly like an API request. Token endpoint redirects are refused and non-JSON token responses are rejected.
- URL length is capped at 8 KiB and request headers at 16 KiB. The request body defaults to a 1 MiB cap.

#### Response and redirect behavior

- Only 2xx responses are returned. An empty body returns `null`; otherwise the body must be UTF-8 JSON (`application/json` or `application/*+json`) and is parsed. Non-2xx statuses become `RuntimeError("UPSTREAM_FAILURE", "Upstream request failed with status <code>")`; the response body is never included.
- A streamed body is capped while reading. Declared oversized `content-length` and compressed (`content-encoding` other than `identity`) responses are rejected before use. Response headers are capped at 16 KiB.
- Redirects 301, 302, 303, 307, and 308 are followed only within the same host, protocol, and port. Every hop is re-resolved, revalidated against `allowedHosts`, and classified again. Cross-host redirects are rejected even when both hosts are allowlisted. 303, and 301/302 on POST, switch to GET and drop the body and content headers; 307/308 preserve them. The default limit is three redirects.
- The total call budget defaults to 15 seconds and covers DNS, connect, redirects, and reading. `context.signal` and the executor timeout abort the transport; `UPSTREAM_TIMEOUT` and `CANCELLED` are preserved.
- Failures use safe `RuntimeError` messages: destination denial, request construction, upstream status, oversized response, unsupported media type, invalid JSON, timeout, cancellation, or a generic upstream failure. Causes stay local for diagnostics.

#### Outbound security

- `allowedHosts` is an exact, normalized hostname allowlist. Wildcards, schemes, ports, paths, credentials, and whitespace are rejected. One trailing dot and IDN spelling are normalized; matching is case-insensitive.
- HTTPS is required by default. `allowInsecureHttp: true` permits plain HTTP but does not permit private destinations.
- Every DNS answer is classified. If any IPv4 or IPv6 address is loopback, private, shared (CGNAT), link-local, multicast, metadata, documentation, unspecified, or reserved, the whole resolution is rejected. IPv4-mapped IPv6 forms are classified as their IPv4 address.
- The selected address is pinned in the Node DNS lookup; the transport verifies `socket.remoteAddress` against it, disables connection reuse, and does not honor proxy environment variables. TLS certificate validation is left at Node's secure default.
- Redirects are origin-locked and re-resolved, so a hostname cannot change network location mid-chain. The transport never decompresses responses.

#### Limitations

- Upstream credential injection supports static, env, secretStore, and OAuth client credentials.
- Response schema validation validates upstream responses against compiled schemas (modes: `off`, `warn`, `enforce`), redacting response bodies in logs and error diagnostics.
- No retries, no streaming or binary response bodies, and no response decompression. Request bodies support JSON, `application/x-www-form-urlencoded`, and `multipart/form-data`; parameter serialization supports query `style: form` with `explode: true` and path/header `style: simple` with `explode: false`, with other styles rejected. Cookie parameters are supported. There is no per-operation `servers` resolution.
- A custom `UpstreamTransport` is trusted adapter code. The executor rechecks response size and JSON shape, but cannot verify that an injected transport connected to the pinned address.
- DNS resolution is not cancellable at the OS level; an aborted call stops waiting and aborts the HTTP request, but the resolver promise may settle later.

### `OpenApiToolSource`

```ts
export interface OpenApiToolSourceOptions {
  executor: UpstreamExecutor;
  operations: readonly CompiledOperation[];
}

export class OpenApiToolSource implements ToolSource {
  constructor(options: OpenApiToolSourceOptions);
  getTools(): readonly ToolDefinition[];
}

export function createOpenApiToolSource(
  options: OpenApiToolSourceOptions,
): OpenApiToolSource;
```

Adapts compiled OpenAPI operations and an `UpstreamExecutor` into a portable `ToolSource` instance ready to be registered via `ToolRuntime.registerSource(source)`.

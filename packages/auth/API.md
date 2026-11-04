# API Reference: @chainmcp/auth

## `@chainmcp/auth`

The auth package holds identity, authorization, secret storage, and credential abstractions:

```ts
export class OperationScopeAuthorizer implements Authorizer {
  authorize(tool: ToolDefinition, context: ToolContext): void;
}

export interface SecretStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export class InMemorySecretStore implements SecretStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): void;
}

export interface EncryptedSecretStoreOptions {
  store: SecretStore;
  activeKeyId: string;
  keys: KeyRing;
}

export class EncryptedSecretStore implements SecretStore {
  constructor(options: EncryptedSecretStoreOptions);
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  rotate(key: string, targetKeyId?: string): Promise<boolean>;
}

export interface UpstreamCredentialProvider {
  resolveCredential(
    context: CredentialResolutionContext,
  ): Promise<UpstreamCredential | undefined>;
}

export class StaticCredentialProvider implements UpstreamCredentialProvider {
  constructor(options: StaticCredentialProviderOptions);
  resolveCredential(
    context: CredentialResolutionContext,
  ): Promise<UpstreamCredential | undefined>;
}

export class EnvCredentialProvider implements UpstreamCredentialProvider {
  constructor(options?: EnvCredentialProviderOptions);
  resolveCredential(
    context: CredentialResolutionContext,
  ): Promise<UpstreamCredential | undefined>;
}

export class SecretStoreCredentialProvider implements UpstreamCredentialProvider {
  constructor(options: SecretStoreCredentialProviderOptions);
  resolveCredential(
    context: CredentialResolutionContext,
  ): Promise<UpstreamCredential | undefined>;
}

export class CompositeCredentialProvider implements UpstreamCredentialProvider {
  constructor(providers: readonly UpstreamCredentialProvider[]);
  resolveCredential(
    context: CredentialResolutionContext,
  ): Promise<UpstreamCredential | undefined>;
}

export interface SecretStoreCredentialProviderOptions {
  store: SecretStore;
  allowGlobalFallback?: boolean;
  deriveStoreKey?: (
    context: CredentialResolutionContext,
  ) => string | readonly string[];
}

export const MAX_SECRET_KEY_LENGTH = 256;
export function encodeSecretKeySegment(value: string): string;
export function buildCredentialStoreKey(options: {
  tenantId?: string;
  schemeName: string;
}): string;
export function buildOAuthTokenStoreKey(options: {
  tenantId: string;
  principalId?: string;
  schemeName: string;
  normalizedScopes: string;
}): string;

export function normalizeUpstreamCredential(
  value: unknown,
): UpstreamCredential | undefined;

export interface OAuthTokenFetcherOptions {
  signal?: AbortSignal;
  allowedHosts?: readonly string[];
  allowAnyTokenHost?: boolean;
  allowInsecureHttp?: boolean;
  maxResponseBytes?: number;
}

export type OAuthTokenFetcher = (
  url: string,
  body: URLSearchParams,
  headers: Readonly<Record<string, string>>,
  options?: OAuthTokenFetcherOptions,
) => Promise<OAuthTokenResponse>;

export const DEFAULT_TOKEN_TIMEOUT_MS = 10_000;
export const MAX_TOKEN_RESPONSE_BYTES = 65_536;
export const MAX_TOKEN_URL_LENGTH = 8_192;
export function defaultTokenFetcher(
  url: string,
  body: URLSearchParams,
  headers: Readonly<Record<string, string>>,
  options?: OAuthTokenFetcherOptions,
): Promise<OAuthTokenResponse>;

export interface OAuthClientCredentialsConfig {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scopes?: readonly string[];
  schemeNames?: readonly string[];
  expirySkewSeconds?: number;
  allowedTokenHosts?: readonly string[];
  allowAnyTokenHost?: boolean;
  allowInsecureHttp?: boolean;
  fetchToken?: OAuthTokenFetcher;
  tokenStore?: SecretStore;
  now?: () => number;
}

export class OAuthClientCredentialsProvider implements UpstreamCredentialProvider {
  constructor(config: OAuthClientCredentialsConfig);
  resolveCredential(
    context: CredentialResolutionContext,
  ): Promise<UpstreamCredential | undefined>;
  invalidate(
    tenantId?: string,
    schemeName?: string,
    principalId?: string,
  ): Promise<void>;
}
```

`OperationScopeAuthorizer` enforces `tool.operation.requiredScopes` as a subset of
`context.principal.scopes`:

- Matching is plain set membership: exact, case-sensitive scope tokens, with
  no wildcard, pattern, or hierarchical semantics.
- Duplicates in either list do not affect the decision.
- A missing or empty `requiredScopes` list imposes no requirement, so tools
  that must be restricted by scope must declare their requirements.
- Tenancy is not evaluated here. The multi-tenant tenant match and the
  pinned single-tenant match are enforced structurally by tenant-scoped
  resolution (ADR 0008), so this authorizer cannot weaken them and may be
  composed with additional custom authorizers for stronger rules.
- Denial follows the authorization-stage contract (ADR 0006): the authorizer
  throws `RuntimeError("AUTH_FORBIDDEN")` with the safe `Access denied`
  message; the ungranted requirements are retained only as a protected
  diagnostic `cause`, never in the client-facing message or metrics event.
  Any `requiredScopes` entry that is not a string, or a principal with no
  scope list, denies the call rather than failing open.

`EncryptedSecretStore` protects secrets at rest using authenticated AES-256-GCM encryption with 96-bit random IVs, 128-bit authentication tags, and key-name AAD binding. Missing keys, tampered ciphertext, or swapped records fail closed.

`buildCredentialStoreKey` and `buildOAuthTokenStoreKey` derive valid store keys from tenant, principal, scheme, and scope values. Each segment is base64url-encoded, so identifiers that contain characters outside the key grammar cannot break lookup or collide with another identifier, and keys longer than `MAX_SECRET_KEY_LENGTH` are replaced by a stable SHA-256 digest. `encodeSecretKeySegment` exposes the segment encoding.

`normalizeUpstreamCredential` validates untrusted credential material and returns a normalized credential or `undefined`. Providers are deployment code, so a value with an unknown `type`, a missing secret, an invalid `location`, or a malformed optional field is treated as unresolved instead of being passed to request construction.

`SecretStoreCredentialProvider` reads `buildCredentialStoreKey({ tenantId, schemeName })` only. A tenant without its own entry does not inherit a deployment-wide credential; set `allowGlobalFallback: true` to fall back to `buildCredentialStoreKey({ schemeName })`, or pass `deriveStoreKey` for a custom layout.

`OAuthClientCredentialsProvider` handles upstream OAuth 2.0 client credentials grants, automatic token caching, expiry detection with safety margin, and automatic refresh. A client credentials token has no refresh token, so expiry means re-acquiring it. Token cache entries are partitioned by tenant, principal, scheme, and normalized scopes under `buildOAuthTokenStoreKey`, and a token-store read or write failure bypasses the cache instead of failing the call. `invalidate(tenantId?, schemeName?, principalId?)` drops matching in-memory entries and deletes their persistent copies; with no arguments it clears every token the instance knows about. Because `SecretStore` has no scan operation, entries written by another process that this instance never loaded cannot be enumerated; delete `buildOAuthTokenStoreKey(...)` from the shared store or rely on token expiry for cross-process revocation.

The token endpoint is subject to an explicit policy. `OAuthClientCredentialsProvider` requires `allowedTokenHosts` (exact hostnames, no wildcards) or the explicit `allowAnyTokenHost: true` opt-out, forwards them through `OAuthTokenFetcherOptions`, and requires HTTPS unless `allowInsecureHttp` is set. `defaultTokenFetcher` refuses URL credentials, refuses redirects instead of following them, enforces `MAX_TOKEN_URL_LENGTH`, caps the response at `MAX_TOKEN_RESPONSE_BYTES`, and applies `DEFAULT_TOKEN_TIMEOUT_MS`. It uses the platform fetch, so it cannot pin the resolved address; when the provider runs inside `@chainmcp/executor`, the executor supplies `CredentialResolutionContext.tokenEndpointFetch`, which resolves and pins the token endpoint through the same destination policy and transport as upstream requests.

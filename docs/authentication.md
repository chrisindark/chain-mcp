# Authentication and Credential Management

ChainMcp enforces strict separation between **inbound MCP client authorization** and **upstream API credentials**.

## 1. Principles

1. **Separation of Concerns:** Inbound caller identity (`ToolContext.principal`, `ToolContext.tenantId`) governs whether an MCP client is permitted to discover and invoke a tool. Upstream credentials (`apiKey`, `http` basic/bearer, `oauth2`) authenticate the server when communicating with upstream HTTP APIs.
2. **Untrusted Caller Input:** MCP tool arguments cannot supply or override authorization headers or cookies. Reserved headers (`authorization`, `cookie`, etc.) are prohibited in caller parameter inputs.
3. **Encrypted at Rest:** Upstream credentials stored persistently are encrypted with authenticated ciphers (AES-256-GCM) with random IVs and integrity tags.
4. **Fail Closed:** Missing, invalid, or expired credentials reject the invocation with `RuntimeError("AUTH_REQUIRED")` or `RuntimeError("AUTH_FORBIDDEN")` without exposing credential values or upstream details.
5. **No Credential Leaks:** Telemetry, metrics events, logs, and client errors never contain credentials, refresh tokens, or authorization headers.

## 2. Inbound Authorization

The inbound authorization stage runs immediately after tool resolution and before argument validation:

```ts
import { InMemoryToolRuntime } from "@chainmcp/core";
import { OperationScopeAuthorizer } from "@chainmcp/auth";

const runtime = new InMemoryToolRuntime({
  authorizer: new OperationScopeAuthorizer(),
});
```

`OperationScopeAuthorizer` verifies that every scope declared in `tool.operation.requiredScopes` is present in `context.principal.scopes`. In multi-tenant runtimes, tenancy boundaries are enforced structurally before the authorizer is called.

## 3. Encrypted Secret Storage

The `@chainmcp/auth` package provides an authenticated secret store abstraction:

```ts
import { EncryptedSecretStore, InMemorySecretStore } from "@chainmcp/auth";

const rawStore = new InMemorySecretStore();
const secretStore = new EncryptedSecretStore({
  store: rawStore,
  activeKeyId: "key-2026-v1",
  keys: {
    "key-2026-v1": process.env.CHAINMCP_ENCRYPTION_KEY!,
  },
});

await secretStore.set("tenant:tenant-1:scheme:api_key", "secret-upstream-key");
const plain = await secretStore.get("tenant:tenant-1:scheme:api_key");
```

### Encryption Properties

- **Cipher:** AES-256-GCM authenticated encryption.
- **Key Ring:** Supports multiple 256-bit keys indexed by ID.
- **Nonce/IV:** Unique 96-bit (12-byte) cryptographically random IV for each write.
- **Authentication Tag:** 128-bit (16-byte) GCM tag verified before returning plaintext.
- **AAD Binding:** The storage key name is bound as Additional Authenticated Data (AAD), preventing ciphertexts from being swapped across different keys.
- **Key Rotation:** Secrets can be decrypted by any key present in the ring, and re-encrypted with `rotate(key, targetKeyId)`.

## 4. Pluggable Upstream Credential Providers

Upstream credentials implement the `UpstreamCredential` union:

- `apiKey`: injected into headers, query parameters, or cookies.
- `http`: `bearer` or `basic` authentication headers.
- `oauth2`: bearer tokens with expiration timestamps and scopes.

### Available Providers

1. **`StaticCredentialProvider`:** Injects hardcoded or programmatically derived credentials.
2. **`EnvCredentialProvider`:** Resolves secrets from environment variables (e.g. `CHAINMCP_AUTH_<SCHEME>`).
3. **`SecretStoreCredentialProvider`:** Reads credentials securely from an `EncryptedSecretStore`.
4. **`CompositeCredentialProvider`:** Evaluates an ordered list of providers, returning the first matching credential.

```ts
import {
  CompositeCredentialProvider,
  EnvCredentialProvider,
  SecretStoreCredentialProvider,
} from "@chainmcp/auth";

const credentialProvider = new CompositeCredentialProvider([
  new SecretStoreCredentialProvider({ store: secretStore }),
  new EnvCredentialProvider(),
]);
```

## 5. OAuth 2.0 & Token Lifecycle

`OAuthClientCredentialsProvider` handles upstream APIs requiring OAuth 2.0:

```ts
import { OAuthClientCredentialsProvider } from "@chainmcp/auth";

const oauthProvider = new OAuthClientCredentialsProvider({
  tokenUrl: "https://auth.example.com/oauth/token",
  clientId: process.env.OAUTH_CLIENT_ID!,
  clientSecret: process.env.OAUTH_CLIENT_SECRET!,
  scopes: ["catalog:read"],
  expirySkewSeconds: 30, // Refresh 30s before actual expiration
  tokenStore: secretStore, // Persist token cache across restarts
});
```

- **Client Credentials Grant:** Obtains tokens directly from upstream token endpoints.
- **Expiry Management:** Uses `expires_in` to compute `expiresAt` and refreshes tokens before they expire.
- **Invalidation:** Tokens can be invalidated on demand via `invalidate(tenantId, schemeName)` to force rotation.

## 6. Upstream Executor Integration

`@chainmcp/executor` binds the `credentialProvider` to tool definitions:

```ts
import { createUpstreamExecutor } from "@chainmcp/executor";

const executor = createUpstreamExecutor({
  baseUrl: "https://api.example.com",
  allowedHosts: ["api.example.com"],
  credentialProvider,
});
```

For every operation:

- The executor evaluates the contract's `CompiledAuthenticationPolicy`.
- It processes OR alternatives in order, satisfying all ANDed schemes within an alternative.
- Upon successful resolution, headers or query parameters are attached and validated against size caps.
- If no alternative is met and the operation is not anonymous, it rejects with `RuntimeError("AUTH_REQUIRED")`.

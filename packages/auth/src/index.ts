export { OperationScopeAuthorizer } from "./authorizer.js";
export {
  EncryptedSecretStore,
  InMemorySecretStore,
  type EncryptedSecretStoreOptions,
  type KeyRing,
  type SecretStore,
} from "./secret-store.js";
export {
  CompositeCredentialProvider,
  EnvCredentialProvider,
  SecretStoreCredentialProvider,
  StaticCredentialProvider,
  type CredentialResolutionContext,
  type EnvCredentialProviderOptions,
  type SecretStoreCredentialProviderOptions,
  type StaticCredentialProviderOptions,
  type StaticCredentialResolver,
  type StaticCredentialValue,
  type UpstreamCredential,
  type UpstreamCredentialProvider,
} from "./credentials.js";
export {
  OAuthClientCredentialsProvider,
  DEFAULT_TOKEN_TIMEOUT_MS,
  MAX_TOKEN_RESPONSE_BYTES,
  defaultTokenFetcher,
  type OAuthClientCredentialsConfig,
  type OAuthTokenFetcher,
  type OAuthTokenFetcherOptions,
  type OAuthTokenResponse,
} from "./oauth.js";

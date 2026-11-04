# API Reference: @chainmcp/admin

## `@chainmcp/admin`

`@chainmcp/admin` is the self-hosted operator surface for declarative HTTP
tools. It authenticates operators with deployment-issued bearer tokens, scopes
them to tenants, validates and statically previews descriptor sets, persists
revision history, and publishes through `DynamicGateway.publishContract()`. It
performs no upstream request itself, evaluates no descriptor code, and never
receives or returns credential values. See `docs/declarative-admin.md`, ADR
0029, and ADR 0030.

### `DeclarativeAdmin`

```ts
export class DeclarativeAdmin {
  constructor(options: DeclarativeAdminOptions);
  /** Web-standard handler; never throws. */
  handle(request: Request): Promise<Response>;
  /** Republish persisted active revisions; reports failures instead of throwing. */
  restore(): Promise<DeclarativeAdminRestoreResult>;
  /** `memory`, `file`, or a custom adapter name. */
  readonly storeKind: string;
}

export function createDeclarativeAdmin(
  options: DeclarativeAdminOptions,
): DeclarativeAdmin;

export interface DeclarativeAdminOptions {
  gateway: DynamicGateway;
  tokens: readonly DeclarativeAdminToken[];
  contracts?: readonly DeclarativeAdminContractBinding[];
  repository?: DescriptorRevisionStore; // default in-memory
  maxRequestBytes?: number; // default 1 MiB, maximum 10 MiB
  transport?: UpstreamTransport; // default executor fetch transport
  resolveHost?: HostResolver; // default system DNS
  logger?: Logger;
  auditSink?: DeclarativeAdminAuditSink;
  now?: () => number;
}

export interface DeclarativeAdminToken {
  id: string; // non-secret, unique, used in audit records
  token: string; // minimum 16 characters; never logged or returned
  tenants: readonly string[] | "*";
}

export interface DeclarativeAdminContractBinding {
  tenantId: string;
  contractName: string;
  destinationPolicy: ContractDestinationPolicy;
  authSchemes?: DeclarativeAuthSchemeMap;
  credentialProvider?: UpstreamCredentialProvider;
  limits?: ContractLimits;
  transport?: UpstreamTransport; // overrides the admin-wide transport
  resolveHost?: HostResolver; // overrides the admin-wide resolver
}
```

`transport` and `resolveHost` are resolved independently: a binding that sets
only one uses the admin-wide value for the other. The constructor rejects an
empty token set, short or duplicate tokens, invalid tenant scopes, invalid or
duplicate bindings, and out-of-range body limits.
`handle()` maps failures to JSON `{ error: { code, message, issues? } }`
responses and audits rejected requests. Construction never validates the
destination policy against DNS; publication does.

### Error codes

Failures are returned as `{ "error": { "code", "message", "issues?" } }`.
`issues` appears only for descriptor validation and holds field locations, never
values. A `405` also carries an `Allow` header with the route's methods.

| Code                           | Status          | Raised when                                                                                                                                       |
| ------------------------------ | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ADMIN_AUTH_REQUIRED`          | 401             | No `Authorization` header.                                                                                                                        |
| `ADMIN_AUTH_INVALID`           | 401             | Header is not `Bearer <token>`, or the token matches no configured token.                                                                         |
| `ADMIN_TENANT_FORBIDDEN`       | 403             | The token is not scoped to the tenant in the path; checked before any binding lookup.                                                             |
| `ADMIN_ORIGIN_FORBIDDEN`       | 403             | The HTTP server rejected a disallowed `Host`, a cross-origin `Origin`, or a cross-site `Sec-Fetch-Site`.                                          |
| `ADMIN_ROUTE_NOT_FOUND`        | 404             | No route matches the method and path.                                                                                                             |
| `ADMIN_METHOD_NOT_ALLOWED`     | 405             | The route exists but not for this method.                                                                                                         |
| `ADMIN_CONTRACT_UNKNOWN`       | 404             | The token may see the tenant, but no binding exists for the tenant/contract pair.                                                                 |
| `ADMIN_REQUEST_INVALID`        | 400             | Malformed path encoding, non-integer `Content-Length`, empty body, invalid JSON, or a bad request shape.                                          |
| `ADMIN_REQUEST_TOO_LARGE`      | 413             | Declared or streamed body exceeds `maxRequestBytes`.                                                                                              |
| `ADMIN_MEDIA_TYPE_UNSUPPORTED` | 415             | Missing or non-JSON `Content-Type` on a body route.                                                                                               |
| `ADMIN_DESCRIPTOR_INVALID`     | 422             | Descriptors fail validation, or a stored revision no longer validates under the current binding.                                                  |
| `ADMIN_PUBLISH_CONFLICT`       | 409             | The gateway reports `REVISION_CONFLICT`, `POLICY_VIOLATION`, `TENANT_MISMATCH`, or `INVALID_REVISION_STATE`.                                      |
| `ADMIN_PUBLISH_FAILED`         | 400/404/422/500 | The gateway rejects `DESTINATION_INVALID` (400), reports any other not-found failure (404), fails compilation (422), or fails unexpectedly (500). |
| `ADMIN_REVISION_UNKNOWN`       | 404             | A revision id given to a route or to rollback is not in the store.                                                                                |
| `ADMIN_REVISION_CONFLICT`      | 409             | The revision is `active` or not `superseded`, so it cannot be rolled back to.                                                                     |
| `ADMIN_STORE_FAILURE`          | 500/413         | Storage I/O, corruption, or a failed write; `STORE_TOO_LARGE` surfaces as 413.                                                                    |
| `ADMIN_INTERNAL`               | 500             | An unexpected error outside the typed error set.                                                                                                  |

Store failures map from `DescriptorStoreError.code`: `STORE_NOT_FOUND` becomes
`ADMIN_REVISION_UNKNOWN`; `STORE_DUPLICATE`, `STORE_STATE_INVALID`, and
`STORE_LIMIT_EXCEEDED` become `ADMIN_REVISION_CONFLICT`; `STORE_IO`,
`STORE_CORRUPT`, and `STORE_TOO_LARGE` become `ADMIN_STORE_FAILURE`. Messages
are fixed per code and never include store paths or record contents.

### Routes

| Method | Path                                                                 | Purpose                                |
| ------ | -------------------------------------------------------------------- | -------------------------------------- |
| GET    | `/` and `/ui/app.js`, `/ui/app.css`                                  | Operator console                       |
| GET    | `/api/v1`                                                            | Service metadata                       |
| GET    | `/api/v1/healthz`                                                    | Liveness (unauthenticated)             |
| GET    | `/api/v1/contracts`                                                  | Contracts visible to the token         |
| GET    | `/api/v1/tenants/{tenant}/contracts/{contract}/tools`                | Active tools and revisions             |
| GET    | `/api/v1/tenants/{tenant}/contracts/{contract}/revisions`            | Revision history                       |
| GET    | `/api/v1/tenants/{tenant}/contracts/{contract}/revisions/{revision}` | One revision                           |
| POST   | `/api/v1/tenants/{tenant}/contracts/{contract}/validate`             | Validate descriptors                   |
| POST   | `/api/v1/tenants/{tenant}/contracts/{contract}/preview`              | Validate and lower statically          |     | POST | `/api/v1/tenants/{tenant}/contracts/{contract}/publish` | Publish and activate a new revision |
| POST   | `/api/v1/tenants/{tenant}/contracts/{contract}/rollback`             | Republish a stored superseded revision |

All tenant routes require `Authorization: Bearer <token>` and check the token's
tenant scope before resolving the contract binding. Bodies must be
`application/json` with a `{ "descriptors": [...] }` array. Validate and
preview return `200` or `422` with
`{ valid, tools, diagnostics: [{ index, code, message, issues }] }`. Publish
returns `201` with the revision summary, or `409` when a tool name collides
with another active contract of the same tenant.

### Persistence

```ts
export interface DeclarativeAdminOptions {
  repository?: DescriptorRevisionStore;
  transport?: UpstreamTransport;
  resolveHost?: HostResolver;
}

export interface StoredDescriptorRevision {
  revisionId: string; // dset_…
  tenantId: string;
  contractName: string;
  createdAt: number;
  status: "candidate" | "active" | "superseded" | "failed";
  toolsetHash: string;
  descriptors: readonly DeclarativeToolDescriptor[];
  toolRevisions: readonly { name: string; revision: string }[];
  gatewayRevisionId?: string;
  publishedBy?: string;
  rollbackOf?: string;
}

export interface DescriptorRevisionStore {
  readonly kind: string;
  listRevisions(
    tenantId: string,
    contractName: string,
  ): Promise<readonly StoredDescriptorRevision[]>;
  getRevision(
    tenantId: string,
    contractName: string,
    revisionId: string,
  ): Promise<StoredDescriptorRevision | undefined>;
  getActive(
    tenantId: string,
    contractName: string,
  ): Promise<StoredDescriptorRevision | undefined>;
  createRevision(record: StoredDescriptorRevision): Promise<void>;
  activateRevision(
    tenantId: string,
    contractName: string,
    revisionId: string,
    gatewayRevisionId: string,
  ): Promise<void>;
  recordGatewayRevision(
    tenantId: string,
    contractName: string,
    revisionId: string,
    gatewayRevisionId: string,
  ): Promise<void>;
  failRevision(
    tenantId: string,
    contractName: string,
    revisionId: string,
  ): Promise<void>;
}

export class InMemoryDescriptorRevisionStore implements DescriptorRevisionStore {
  constructor(
    records?: readonly StoredDescriptorRevision[],
    options?: { maxRevisionsPerContract?: number },
  );
}

export class FileDescriptorRevisionStore implements DescriptorRevisionStore {
  static open(options: {
    path: string;
    maxBytes?: number; // default 10 MiB, maximum 100 MiB
    maxRevisionsPerContract?: number; // default 100
  }): Promise<FileDescriptorRevisionStore>;
  readonly path: string;
}

export function createDescriptorRevisionId(
  tenantId: string,
  contractName: string,
  toolsetHash: string,
  createdAt: number,
): string;
export function descriptorToolsetHash(
  tools: readonly { name: string; revision: string }[],
): string;
export function toStoredRevisionSummary(
  record: StoredDescriptorRevision,
): DeclarativeAdminStoredRevisionSummary;
```

Stores serialize mutations and allow at most one `active` record per
tenant/contract. `createRevision` accepts only a `candidate` whose descriptor
count matches its tool revisions and whose ids and hashes are well formed.
`activateRevision` supersedes the previous active record. `failRevision`
marks a rejected candidate. `recordGatewayRevision` updates the binding when
`restore()` republishes an already-active record.

The file store writes one versioned JSON snapshot through a `0600` temporary
file, `fsync`, and atomic rename; it validates the schema on open and enforces
byte and revision caps. It is single-writer. Stores never receive credentials
and never contact the network.

`restore()` returns:

```ts
export interface DeclarativeAdminRestoreResult {
  restored: readonly {
    tenantId;
    contractName;
    revisionId;
    gatewayRevisionId;
  }[];
  skipped: readonly {
    tenantId;
    contractName;
    revisionId;
    reason: "already_active" | "descriptors_invalid";
  }[];
  failures: readonly { tenantId; contractName; revisionId; reason: string }[];
}
```

### Publish and rollback responses

```ts
export interface DeclarativeAdminPublishedRevision extends DeclarativeAdminStoredRevisionSummary {
  sourceHash: string;
  baseUrl: string;
  allowedHosts: readonly string[];
}
```

`revisionId` is the durable admin revision (`dset_…`); `gatewayRevisionId` is
the gateway revision that serves it. Rollback republishes a stored superseded
revision as a new admin revision with `rollbackOf` set, so it survives a
restart and append-only history is preserved.

### `startDeclarativeAdminServer`

```ts
export function startDeclarativeAdminServer(
  options: DeclarativeAdminServerOptions,
): Promise<RunningDeclarativeAdminServer>;

export interface DeclarativeAdminServerOptions {
  admin: DeclarativeAdmin | DeclarativeAdminOptions;
  host?: string; // default 127.0.0.1
  port?: number; // default 3341; 0 selects an ephemeral port
  allowRemote?: boolean; // required for a non-loopback bind
  maxRequestBytes?: number;
  signal?: AbortSignal;
  logger?: Logger;
}

export interface RunningDeclarativeAdminServer {
  url: string;
  host: string;
  port: number;
  close(): Promise<void>;
}
```

Before the handler runs, the transport requires a valid `Host` on the bound or
loopback hostnames, rejects an `Origin` that does not equal the request's
`Host`, and rejects `Sec-Fetch-Site` values other than `same-origin` or `none`.
All responses are `no-store`; the console adds a strict CSP and serves no
inline script.

### `evaluateDescriptorSet`

```ts
export function evaluateDescriptorSet(options: {
  descriptors: readonly unknown[];
  authSchemes?: DeclarativeAuthSchemeMap;
  maxDescriptors?: number;
}): {
  evaluation: { valid; tools; diagnostics };
  preview: { valid; tools; diagnostics };
  parsed: readonly ParsedDeclarativeTool[];
};
```

Validates a non-empty descriptor set (1,000 maximum) with the deployment's
credential scheme map, reports per-descriptor diagnostics with stable codes and
issue paths, and produces the static preview. It never touches the gateway or
the network.

### Authentication helpers

```ts
export function authenticateAdminToken(
  tokens: readonly DeclarativeAdminToken[],
  authorizationHeader: string | null,
): { tokenId: string; tenants: readonly string[] | "*" };

export function assertTenantAllowed(
  principal: { tenants: readonly string[] | "*" },
  tenantId: string,
): void;

export function extractBearerToken(header: string | null): string | undefined;
```

Token comparison hashes the presented value and every candidate with SHA-256
and compares fixed-length digests in constant time. Missing credentials raise
`ADMIN_AUTH_REQUIRED`; malformed or unknown credentials raise
`ADMIN_AUTH_INVALID`; out-of-scope tenants raise `ADMIN_TENANT_FORBIDDEN`.

### Errors

```ts
export type DeclarativeAdminErrorCode =
  | "ADMIN_AUTH_REQUIRED"
  | "ADMIN_AUTH_INVALID"
  | "ADMIN_TENANT_FORBIDDEN"
  | "ADMIN_ORIGIN_FORBIDDEN"
  | "ADMIN_ROUTE_NOT_FOUND"
  | "ADMIN_METHOD_NOT_ALLOWED"
  | "ADMIN_CONTRACT_UNKNOWN"
  | "ADMIN_REQUEST_INVALID"
  | "ADMIN_REQUEST_TOO_LARGE"
  | "ADMIN_MEDIA_TYPE_UNSUPPORTED"
  | "ADMIN_DESCRIPTOR_INVALID"
  | "ADMIN_PUBLISH_CONFLICT"
  | "ADMIN_PUBLISH_FAILED"
  | "ADMIN_REVISION_UNKNOWN"
  | "ADMIN_REVISION_CONFLICT"
  | "ADMIN_STORE_FAILURE"
  | "ADMIN_INTERNAL";

export class DeclarativeAdminError extends Error {
  readonly code: DeclarativeAdminErrorCode;
  readonly status: number;
  readonly issues: readonly { path: string; message: string }[];
  readonly allow: readonly string[];
}
```

# Declarative admin (self-hosted)

`@chainmcp/admin` is the operator surface for [declarative HTTP tools](./declarative-tools.md).
It validates descriptor sets against a bound contract, previews the request it
would build, and publishes the set into the running `@chainmcp/gateway`.
Publishing reuses the gateway's tenant ownership, revision history, activation,
collision checks, and audit events; descriptor-backed tools then execute through
the same bounded executor and runtime pipeline as compiled tools.

The surface is self-hosted and loopback-first. It is not a hosted control plane
and it does not accept code uploads. Descriptor revisions are stored behind a
`DescriptorRevisionStore`; the default is in-memory, and an atomic file-backed
store provides restart recovery and rollback.

## Wiring

```ts
import { DynamicGateway } from "@chainmcp/gateway";
import {
  DeclarativeAdmin,
  FileDescriptorRevisionStore,
  startDeclarativeAdminServer,
} from "@chainmcp/admin";

const gateway = new DynamicGateway({ auditSink: yourGatewayAuditSink });
const repository = await FileDescriptorRevisionStore.open({
  path: "/var/lib/chainmcp/descriptors.json",
});

const admin = new DeclarativeAdmin({
  gateway,
  repository,
    tokens: [
      {
        id: "operator",
        token: process.env.CHAINMCP_ADMIN_TOKEN,
        tenants: ["acme"],
      },
    ],
    contracts: [
      {
        tenantId: "acme",
        contractName: "directory",
        destinationPolicy: {
          baseUrl: "https://api.example.com/v1",
          allowedHosts: ["api.example.com"],
        },
        authSchemes: {
          api_key: {
            type: "apiKey",
            parameterName: "X-API-Key",
            parameterLocation: "header",
          },
        },
        credentialProvider,
        limits: { timeoutMs: 10_000, maxResponseBytes: 1_048_576 },
      },
    ],
  },
});

const restore = await admin.restore();
console.log(restore.restored.length, "descriptor contract(s) restored");

const server = await startDeclarativeAdminServer({ port: 3341, admin });
console.log(server.url); // http://127.0.0.1:3341
```

`restore()` republishes the active stored revision of every bound contract, so
descriptor-backed tools survive a restart even though the gateway registry
starts empty. It returns `restored`, `skipped`, and `failures` instead of
throwing; a conflict or invalid stored descriptor is reported, not fatal.
`startDeclarativeAdminServer` also accepts a plain options object when you do
not need to call `restore()` yourself.

`credentialProvider` comes from `@chainmcp/auth`; the admin surface never
receives the secret itself. Tokens must be at least 16 characters and are
rejected at construction if duplicate, too short, or missing a tenant scope.

The server binds `127.0.0.1` by default. A non-loopback bind throws unless
`allowRemote: true` is passed, and that mode should sit behind an
authenticating reverse proxy.

Use `new DeclarativeAdmin(options)` directly when mounting `handle(Request)`
on an existing HTTP framework instead of the bundled Node server.

Descriptor-backed tools run on an executor the admin builds from each
`contracts` binding. Pass `transport` and `resolveHost` at the top level to
replace the default fetch transport and system DNS — for example a stubbed
transport in tests, or a proxy-aware resolver in a locked-down network.
Without them the admin resolves upstream hosts with real DNS.

A contract binding may set its own `transport` and `resolveHost`, which take
precedence over the admin-wide values for that contract only. The two options
are resolved independently, so a binding that overrides just the transport
still inherits the admin-wide resolver. This lets one admin front upstreams on
different network paths, for example an internal fetcher alongside a
proxy-aware one.

## Routes

All API routes are under `/api/v1` and require
`Authorization: Bearer <token>`, except `GET /api/v1` and `GET /api/v1/healthz`.
Request bodies must be `application/json` and are capped at 1 MiB by default.

| Method | Route                                                                | Purpose                                                    |
| ------ | -------------------------------------------------------------------- | ---------------------------------------------------------- |
| GET    | `/`                                                                  | Operator console (static assets under `/ui/`)              |
| GET    | `/api/v1`                                                            | Service metadata and route list                            |
| GET    | `/api/v1/healthz`                                                    | Liveness check                                             |
| GET    | `/api/v1/contracts`                                                  | Bound contracts visible to the token                       |
| GET    | `/api/v1/tenants/{tenant}/contracts/{contract}/tools`                | Active tools with revisions and required scopes            |
| GET    | `/api/v1/tenants/{tenant}/contracts/{contract}/revisions`            | Revision history                                           |
| GET    | `/api/v1/tenants/{tenant}/contracts/{contract}/revisions/{revision}` | One stored revision with its descriptor documents          |
| POST   | `/api/v1/tenants/{tenant}/contracts/{contract}/validate`             | Validate descriptors and return diagnostics                |
| POST   | `/api/v1/tenants/{tenant}/contracts/{contract}/preview`              | Validate and return the lowered static request             |
| POST   | `/api/v1/tenants/{tenant}/contracts/{contract}/publish`              | Publish the descriptor set and activate the new revision   |
| POST   | `/api/v1/tenants/{tenant}/contracts/{contract}/rollback`             | Republish a stored revision (`{ "revisionId": "dset_…" }`) |

Descriptor submissions use one shape:

```json
{
  "descriptors": [{ "descriptorVersion": 1, "name": "get_user", "...": "..." }]
}
```

### Validate

`200` with `{ valid: true, tools: [{ index, name, revision }], diagnostics: [] }`,
or `422` with the same shape and `valid: false`. Diagnostics carry the
descriptor index, a stable `DeclarativeDescriptorError` code, the message, and
`issues` with field paths. Validation never contacts the upstream API and never
changes the gateway.

### Preview

Same body and status behavior as validate, but `tools[]` also contains the
static lowering: HTTP method, path template, parameter bindings, body media
type, authentication alternatives, and policy. Preview performs no upstream
call, so it cannot show a live response.

### Publish

`201` with the new admin revision and its gateway binding:

```json
{
  "revisionId": "dset_5c1a…",
  "gatewayRevisionId": "rev_7f3c…",
  "tenantId": "acme",
  "contractName": "directory",
  "status": "active",
  "createdAt": 1767225600000,
  "toolsetHash": "…",
  "sourceHash": "…",
  "toolCount": 1,
  "toolNames": ["get_user"],
  "descriptors": [{ "name": "get_user", "revision": "sha256:…" }],
  "publishedBy": "operator",
  "baseUrl": "https://api.example.com/v1",
  "allowedHosts": ["api.example.com"]
}
```

`revisionId` is the durable admin revision (`dset_…`); `gatewayRevisionId` is
the gateway revision (`rev_…`) that serves it. The gateway id changes on every
publication and restore, so use the admin id for rollback.

Errors: `400` for invalid submissions, `401`/`403` for authentication and
tenant scope, `404` for an unbound contract, `409` for a tool-name collision
with another active contract of the same tenant, `413` for oversized bodies,
`415` for non-JSON bodies, and `422` for invalid descriptors. Every response
carries a stable `error.code`; `API_REFERENCE.md` has the complete
code-to-status table, including the store-to-admin code mapping used by
rollback and restore.

Publishing **replaces** the contract's active toolset with the submitted set.
It re-validates every descriptor, lowers it through a fresh executor built from
the binding's destination policy and limits, and calls
`gateway.publishContract({ tools })`. The gateway stamps tenant ownership,
assigns the revision id, activates atomically, and emits its usual
`contract_published` and `contract_activated` audit events. The admin surface
adds `admin_publish` with the token id, tenant, contract, admin revision,
gateway revision, and tool count.

### Rollback

`POST .../rollback` with `{ "revisionId": "dset_…" }` restores a stored
superseded revision. It revalidates the stored descriptors against the current
binding, republishes them as a new gateway revision, and records a new admin
revision whose `rollbackOf` names the target. Rollback therefore works after a
restart and never rewrites history.

Errors: `404` for an unknown revision, `409` when the target is active, a
candidate, or failed, `422` when the stored descriptors no longer validate
under the binding (for example a removed credential scheme).

## Persistence and recovery

Descriptor revisions live behind `DescriptorRevisionStore`:

```ts
export interface DescriptorRevisionStore {
  readonly kind: string;
  listRevisions(
    tenantId,
    contractName,
  ): Promise<readonly StoredDescriptorRevision[]>;
  getRevision(
    tenantId,
    contractName,
    revisionId,
  ): Promise<StoredDescriptorRevision | undefined>;
  getActive(
    tenantId,
    contractName,
  ): Promise<StoredDescriptorRevision | undefined>;
  createRevision(record): Promise<void>; // candidate
  activateRevision(
    tenantId,
    contractName,
    revisionId,
    gatewayRevisionId,
  ): Promise<void>;
  recordGatewayRevision(
    tenantId,
    contractName,
    revisionId,
    gatewayRevisionId,
  ): Promise<void>;
  failRevision(tenantId, contractName, revisionId): Promise<void>;
}
```

A record holds `tenantId`, `contractName`, an admin `revisionId`, `createdAt`,
`status` (`candidate`, `active`, `superseded`, `failed`), `toolsetHash`, the
validated descriptor documents, per-tool `sha256` revisions, the gateway
revision id, the publishing token id, and an optional `rollbackOf`.

Publication is ordered so the store never claims a revision that is not
serving and the gateway never serves one the store rejected:

1. write a `candidate` record;
2. publish to the gateway;
3. mark the record `active` and the previous active record `superseded`.

A gateway rejection marks the candidate `failed`. A store rejection prevents
any gateway call. If step 3 fails after a successful publication, the admin
returns `500 ADMIN_STORE_FAILURE`; the tools are live but the record is still a
candidate until the operator republishes or restarts with restore.

`FileDescriptorRevisionStore` writes a versioned JSON snapshot
(`{ "storeVersion": 1, "revisions": [...] }`) to a sibling temporary file,
`fsync`s it, and atomically renames it into place with `0600` permissions. It
validates the schema on open, caps the file size (10 MiB default) and history
(100 revisions per contract), and is **single-writer**: do not open the same
path from two processes. Use a database adapter for multi-writer deployments.

A failed write (size cap or I/O error) rejects the mutation before it becomes
visible: the previous snapshot stays intact on disk, no temporary file is left
behind, and the store remains usable for subsequent operations.

The default `InMemoryDescriptorRevisionStore` keeps the previous ephemeral
behavior. With either store, call `admin.restore()` after constructing the
gateway: it republishes each bound contract's active revision and reports
`restored`, `skipped` (`already_active`, `descriptors_invalid`), and `failures`.

## Operator console

`GET /` serves a dependency-free console for the same routes:

- paste a bearer token (kept in page memory, never `localStorage` or cookies);
- load the contracts the token can administer;
- edit the descriptor array as JSON;
- validate, preview, publish (with confirmation), load revision history, or
  roll back by stored revision id.

The console runs under `default-src 'none'` with `script-src 'self'`; there is
no inline script, no remote asset, and every response is `no-store`.

## Security posture

- **Identity:** deployment-issued static bearer tokens with an explicit tenant
  scope. The surface never mints, stores, returns, or logs a token.
- **Authorization:** tenant scope is checked before the binding lookup. Scoped
  tokens receive `403` for other tenants even if the contract is not bound.
- **Cross-origin:** `Origin`, when present, must equal the request's `Host`;
  `Sec-Fetch-Site` must be `same-origin` or `none`. Rejections happen at the
  transport, before authentication.
- **DNS rebinding:** `Host` must be the bound hostname or a loopback name.
- **Destinations:** descriptors cannot add hosts or change the base URL; the
  executor enforces the binding's exact allowlist, HTTPS default, private-range
  blocks, DNS pinning, peer verification, redirect rules, and response caps.
- **Credentials:** descriptors reference scheme names only. Secrets stay in the
  deployment's `UpstreamCredentialProvider`.
- **Storage:** descriptor records carry validated descriptor documents, never
  credentials, inbound identities, or admin tokens. The file store is `0600`
  under an operator-controlled path, validates its schema on open, and
  revalidates descriptors on restore and rollback so a tampered file fails
  closed.
- **Audit:** `admin_validate`, `admin_preview`, `admin_publish`,
  `admin_rollback`, `admin_restore`, `admin_auth_failed`, and
  `admin_request_rejected` records carry token id, tenant, contract, admin and
  gateway revisions, tool count, and reason codes — never tokens, descriptor
  arguments, or credentials.
- **Limits:** 1 MiB request bodies (10 MiB ceiling), 1,000 descriptors per
  submission, 256 KiB per descriptor, 100 stored revisions per contract by
  default, and a 10 MiB store file by default. Publishing is not rate-limited
  by this package.

## Known limitations

- The built-in stores are single-process. The file store serializes its own
  mutations but does not lock across processes; use one writer or a database
  adapter.
- `restore()` must be called after the gateway is constructed. Deployments
  that skip it keep only whatever the gateway currently serves.
- A crash between gateway publication and record activation leaves live tools
  with a candidate record until the next publish or restart.
- Publishing replaces the contract's toolset rather than merging sources.
- Preview is static; there is no trial invocation, because that would require
  an admin-as-caller identity model.
- No CLI command or configuration schema yet; the surface is started
  programmatically.
- Response bodies are not validated against a schema.

See ADR 0029 and ADR 0030 for the decision records and the remaining post-1.0
items.

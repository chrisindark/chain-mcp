# Dynamic Gateway

## Purpose

Serve multiple API contracts through one shared MCP service with strict tenant isolation, immutable versioned revisions, atomic candidate activation, and per-contract authentication and network policies.

The implementation is provided by `@chainmcp/gateway`.

## Registry model

Each `ContractRevision` contains:

- **`revisionId`:** Immutable, deterministic digest-based identifier (e.g. `rev_<hash>`).
- **`contractName`:** Contract name (1-64 alphanumeric characters, underscores, or hyphens).
- **`tenantId`:** Tenant that owns and is authorized to access the revision.
- **`sourceHash`:** SHA-256 integrity hash of the raw contract source or tool definitions.
- **`createdAt`:** Creation timestamp.
- **`status`:** `"candidate"` | `"active"` | `"disabled"` | `"superseded"` | `"rolled_back"`.
- **`tools`:** Validated tool definitions stamped with `contractRevision` and `ownerTenantId`.
- **`destinationPolicy`:** Per-contract `baseUrl` and strict `allowedHosts` allowlist.
- **`authConfig`:** Optional contract-level `requiredScopes` and upstream `credentialProvider`.
- **`limits`:** Optional request/response byte caps, redirect limits, and execution timeouts.
- **`metadata`:** Optional arbitrary deployment metadata.

## Publication and reload workflow

1. **Candidate Compilation & Validation:**
   - Supply OpenAPI 3.0/3.1 YAML/JSON text or an array of code tool definitions.
   - OpenAPI specs are compiled in isolation with `@chainmcp/compiler` using strict mode.
   - Outbound tools are constructed via `@chainmcp/executor` bound specifically to the contract's `baseUrl`, `allowedHosts`, and `credentialProvider`.
   - Tool input schemas are audited against `auditInputSchema` to ensure linear-time validation bounds.
   - Tool name collisions are verified: duplicate tool names within the revision or against other active contracts for the same tenant are rejected before activation.
   - A candidate `ContractRevision` is stored in the `ContractRegistry`.
2. **Audit Event Emission:**
   - A redacted `contract_published` audit event is emitted to the configured `GatewayAuditSink`.
3. **Atomic Activation:**
   - When activated (default `autoActivate: true`), the revision status becomes `"active"`.
   - Any prior active revision for that contract becomes `"superseded"`.
   - The gateway constructs a new `InMemoryToolRuntime` snapshot with all currently active tools across all tenants, and atomically updates `this.activeRuntime = nextRuntime`.
   - An asynchronous mutex prevents race conditions during concurrent reloads.
   - In-flight requests on the prior runtime snapshot continue executing undisturbed; new requests immediately see the newly active revision.
   - A `contract_activated` audit event is emitted.

## Disabling and rollback

- **Disabling:** `gateway.disableContract(tenantId, contractName)` marks the active revision `"disabled"`. Its tools immediately become invisible to `listTools` and uncallable (`TOOL_NOT_FOUND`). A `contract_disabled` audit event is emitted.
- **Rollback:** `gateway.rollbackContract(tenantId, contractName, targetRevisionId)` reactivates a prior revision in the contract's history and marks the current active revision as `"rolled_back"`. A `contract_rolled_back` audit event is emitted.

## Tenant and network isolation

1. **Discovery Isolation:** `gateway.listTools(context)` strictly scopes results to `context.tenantId`. Calls without a caller context fail closed with `AUTH_REQUIRED`, and calls with an empty tenant ID in multi-tenant mode fail closed with `TENANT_REQUIRED`.
2. **Invocation Isolation:** `gateway.callTool(name, input, context)` resolves against `context.tenantId`. Attempting to call another tenant's tool fails closed with `TOOL_NOT_FOUND`, making cross-tenant inventory completely indistinguishable from nonexistent tools (ADR 0008). Invocations lacking a tenant ID fail closed with `TENANT_REQUIRED` and emit a `tenant_resolution_failed` audit event.
3. **No Implicit 'default' Fallback:** The dynamic gateway does not guess or fall back to an implicit `"default"` tenant. If no tenant can be resolved for a request requiring tenant context, it fails closed with error code `TENANT_REQUIRED`.
4. **Tenant Resolution Precedence:** When an inbound verifier is configured, the authenticated principal's tenant claim (`authTenant`) takes precedence over any CLI or configuration default: `authTenant ?? explicitTenant`.
5. **Gateway Boot Validation:** Running `chainmcp gateway serve` without an inbound verifier (`auth.inbound`) or an explicit tenant flag/option (`--tenant <id>` / `tenant: string`) refuses to start with an explicit error.
6. **Name Independence:** Two different tenants can safely register tools with identical names (e.g. `listUsers`) without collision or cross-talk.
7. **Network Destination Isolation:** Outbound HTTP tools use an executor bound to the specific contract revision's `allowedHosts`. Requests cannot connect to another tenant's or contract's upstream hosts.
8. **Credential Isolation:** Outbound requests use the revision's configured `credentialProvider`, preventing credential leakage across contracts.
9. **Cache Isolation:** Cache keys incorporate `tenantId` and `contractRevision`, guaranteeing cached results for one tenant or revision cannot be retrieved by another.

## CLI deployment (`chainmcp gateway serve`)

You can run the dynamic gateway directly using the CLI:

```bash
# Serve gateway using gateway.config.yaml over HTTP or stdio
chainmcp gateway serve --config gateway.config.yaml

# Override transport and port from command line
chainmcp gateway serve --config gateway.config.yaml --transport http --port 3333
```

### Example `gateway.config.yaml`

```yaml
version: 1
name: enterprise-dynamic-gateway
tenant: tenant-crm # Optional fallback default tenant for unauthenticated development
server:
  transport: http
  host: 0.0.0.0
  port: 3333
  path: /mcp
contracts:
  - name: customers
    tenantId: tenant-crm
    spec: contracts/customers.yaml
    destination:
      baseUrl: https://api.customers.internal
      allowedHosts:
        - api.customers.internal
    auth:
      requiredScopes:
        - crm:read
```

## Programmatic usage

```ts
import { DynamicGateway, createGatewayServer } from "@chainmcp/gateway";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

const gateway = new DynamicGateway();

// Publish and activate a contract
await gateway.publishContract({
  tenantId: "tenant-acme",
  contractName: "billing-api",
  source: openApiYamlSource,
  destinationPolicy: {
    baseUrl: "https://api.billing.acme.com",
    allowedHosts: ["api.billing.acme.com"],
  },
  authConfig: {
    requiredScopes: ["billing:read"],
  },
});

// Create MCP server
const server = createGatewayServer(gateway, {
  name: "acme-gateway",
  version: "0.1.0",
  createContext: async (req) => ({
    requestId: String(req.id),
    tenantId: resolveTenantFromAuth(req.authInfo),
    principal: resolvePrincipalFromAuth(req.authInfo),
  }),
});
```

## Scope boundary

The dynamic gateway is a deployment mode for the open-source runtime, not a requirement for using generated servers. Both modes share the identical core runtime execution pipeline (ADR 0002).

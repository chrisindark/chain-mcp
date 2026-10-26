# ADR 0026 — Dynamic gateway architecture: versioned contract registry, atomic reloads, tenant policy binding, and rollback

- Status: accepted
- Recorded: 2026-10-26

## Context and problem

Milestone 9 requires serving multiple API contracts safely through a single MCP service without cross-tenant access. Specifically:

1. API contracts must be versioned, immutable, and bound to tenant ownership.
2. Publication and compilation must happen in an isolated candidate state without mutating or blocking active registries in place.
3. Reloads and activations must be atomic, ensuring in-flight requests complete cleanly while subsequent requests observe the new revision.
4. Each contract revision must enforce its own upstream network destination policy (allowed hosts) and upstream authentication configuration (credentials).
5. Revision disabling and rollback must be supported, restoring prior active revisions atomically and retaining full audit history.
6. Multi-tenant isolation must fail closed: an unauthorized caller must never discover, enumerate, or call another tenant's tools, and cache keys must remain strictly partitioned.

## Decision

We introduce `@chainmcp/gateway` with the following architectural components:

1. **Immutable Versioned Revisions (`ContractRevision`):**
   - Each contract revision is an immutable record containing `revisionId` (digest-based deterministic identifier), `contractName`, `tenantId`, `sourceHash`, `createdAt`, `status` (`candidate`, `active`, `disabled`, `superseded`, `rolled_back`), `tools`, `destinationPolicy`, `authConfig`, and `limits`.
   - Candidate revisions are generated in isolation from either raw OpenAPI source strings (using `@chainmcp/compiler` and `@chainmcp/executor`) or code-defined tool arrays.
   - All tools in a revision are stamped with `ownerTenantId: tenantId` and `contractRevision: revisionId`.

2. **Isolated Validation and Collision Detection:**
   - Pre-activation validation audits every tool's input schema against `auditInputSchema` and validates destination allowlists against `normalizeAllowedHost`.
   - Tool name collisions within a revision or against any other active contract for the same tenant are rejected at candidate creation and activation.
   - Distinct tenants may publish identical tool names without conflict, as discovery and resolution are strictly tenant-scoped.

3. **Atomic State Swap and Concurrency Safety:**
   - An asynchronous mutex serializes lifecycle transitions (`publishContract`, `activateRevision`, `disableContract`, `rollbackContract`) to prevent race conditions.
   - The active toolset is instantiated as an isolated `InMemoryToolRuntime` configured with `tenantMode: "multi-tenant"`.
   - Revision activation atomically assigns `this.activeRuntime = nextRuntime`. In-flight invocations on the previous runtime instance complete without interference; new calls immediately resolve on the new runtime snapshot.

4. **Per-Contract Network and Credential Binding:**
   - Outbound HTTP tools are created with an `UpstreamExecutor` configured specifically with the contract's `baseUrl`, `allowedHosts`, and `credentialProvider`. Requests for Contract A cannot connect to Contract B's allowed hosts or use Contract B's credentials.

5. **Disabling and Rollback:**
   - `disableContract(tenantId, contractName)` transitions the active revision to `disabled`, removing all its tools from discovery and execution.
   - `rollbackContract(tenantId, contractName, targetRevisionId)` reactivates a prior revision, marks the current active revision as `rolled_back`, and atomically swaps the runtime.

6. **Redacted Audit Logging:**
   - Emits structured `GatewayAuditEvent`s (`contract_published`, `contract_activated`, `contract_disabled`, `contract_rolled_back`) carrying revision identifiers, tenant, contract, tool counts, and metadata while strictly excluding credentials or sensitive payloads. Audit sink failures are isolated and never disrupt gateway operations.

## Alternatives considered

- **Mutate active in-memory registries in place:** Rejected: in-flight requests could observe partial toolsets or broken references during reloads.
- **Separate gateway runtime distinct from generated servers:** Rejected: violates ADR 0002. `DynamicGateway` wraps the shared `InMemoryToolRuntime` with `tenantMode: "multi-tenant"`, preserving identical authorization, caching, rate-limiting, and validation behavior.
- **Global tool-name prefixing across tenants (e.g. `tenantA_tool`):** Rejected per ADR 0008; tool names are data and should remain natural to the contract. Tenant-scoped resolution natively allows each tenant to use clean names.

## Consequences and trade-offs

- Candidate revisions and reloads require rebuilding the active multi-tenant runtime instance. Because tool definitions and schemas are in-memory references, rebuilding is near-instantaneous (milliseconds) while ensuring atomic snapshot isolation.
- Shared infrastructure adapters (`RateLimiter`, `CacheStore`, `MetricsSink`, `Logger`) are preserved across reloads, ensuring continuous rate limit enforcement, cache partitioning, and metrics streams.

## Security implications

- Callers without context fail closed with `AUTH_REQUIRED`.
- Cross-tenant tool calls fail closed with `TOOL_NOT_FOUND`, making unauthorized tools indistinguishable from nonexistent tools (ADR 0008).
- Cache keys incorporate `contractRevision`, `tenantId`, and `principalId`, preventing cross-tenant or cross-revision cache collisions.
- Network policies are enforced per executor: an operation on Tenant A's contract cannot bypass its destination allowlist.

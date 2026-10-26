# ADR 0008 — MCP authorization mapping: tenant ownership and tool access

- Status: accepted
- Recorded: 2026-10-20 (accepted 2026-10-26 with Milestone 9 implementation and verification)

## Context and problem

The runtime already assumes a caller identity exists by the time validation and
caching run. `ToolContext` carries a `tenantId` and `principal` established by
trusted adapters, cache keys are partitioned by tenant and principal (ADR 0003,
ADR 0005), and an optional `Authorizer` runs before validation and fails closed
on untyped errors (ADR 0006).

What is not decided anywhere is the mapping itself: given a caller identity,
who may call which tenant's tools. Concretely, several questions are open and
they shape the compiler (Milestone 3), the auth package (Milestone 5), and the
gateway (Milestone 9), so they must be settled before those milestones generate
structure that would have to be retrofitted:

- **Where does a tool's tenant binding live?** `ToolDefinition` has no tenant
  metadata. The in-memory registry is a flat `Map` keyed by tool name, so
  tenant scoping exists only in the caller's context, never on the tool, and
  nothing structurally prevents calling tenant A's tool with tenant B's
  context.
- **Who evaluates the mapping?** `OperationPolicy.requiredScopes` is declared
  but never enforced by core; a transport adapter could also grow its own
  checks, recreating the drift ADR 0002 exists to prevent.
- **How do tool names stay unambiguous across tenants?** MCP exposes one flat
  tool-name namespace per server. A gateway serving multiple tenants'
  contracts needs a rule for when two revisions would emit the same name.
- **Discovery must match invocation.** `docs/dynamic-gateway.md` states that a
  caller must never enumerate or invoke tools of an unauthorized tenant, but
  `listTools()` is global and the current adapter snapshots tools at server
  creation. Bolted on later, this converges on the classic bug: a filtered
  listing paired with an unfiltered `callTool`, or a stale filtered snapshot.
- **How do deployment modes differ?** Generated servers are single-tenant by
  construction; the gateway is multi-tenant. The same runtime interface must
  express both without making one mode an accidental opt-out from the other.

The mapping from an inbound MCP session (token, API key) to a principal and
tenant is transport authentication and stays out of this ADR, per ADR 0004's
follow-up to define it in `CONFIGURATION.md` before remote transport exists.

## Decision

The mapping is structural, not incidental. The following rules bind
generated servers and the gateway to the same code path:

1. **Identity source is fixed.** Caller identity arrives only through
   `ToolContext`, established by trusted transport adapters. Tenant identity is
   never derived from tool input, arguments, or tool names.
2. **Tools carry an owner tenant.** A registered tool gains immutable tenant
   metadata bound at registration time. In single-tenant deployments the
   binding is the deployment's pinned tenant; in the gateway it is the contract
   revision's tenant owner.
3. **The mapping is evaluated in the shared runtime, in the authorization
   stage, by one code path.** The mapping requires that the caller `tenantId`
   equals the tool's owner tenant. The tenant match is enforced structurally
   by tenant-scoped resolution rather than by adapter policy: in multi-tenant
   mode an unauthorized tool does not resolve, and its observable behavior is
   identical to an unknown tool (`TOOL_NOT_FOUND`, no metrics event), so
   calls cannot reveal another tenant's inventory; a pinned single-tenant
   deployment denies a mismatched caller with `AUTH_FORBIDDEN` and an error
   metric. `operation.requiredScopes` must be enforced by the deployment's
   authorizer against `principal.scopes`; the default
   `OperationScopeAuthorizer` in `@chainmcp/auth` implements exactly this
   rule with exact token matching, so multi-tenant deployments get
   operation-scope enforcement without writing adapters. Concrete authorizers
   may add stronger attribute-based rules, but the tenant match is mandatory
   and cannot be waived per operation, consistent with
   `CONFIGURATION.md`'s rule that per-operation policy cannot weaken
   mandatory isolation. Identity resolution is its own stage before
   authorization: a typed `RuntimeError` from the context factory keeps its
   code, and any other failure fails closed as `AUTH_FORBIDDEN` with the cause
   retained, following ADR 0006's stage rules.
4. **Tenancy is explicit per deployment.** The runtime is constructed in
   single-tenant or multi-tenant mode. Multi-tenant mode requires an
   `Authorizer`: constructing the runtime without one fails startup. Pre-1.0
   single-tenant behavior (trusted local stdio, optional authorizer) is
   preserved only in single-tenant mode. The mode is declared on the public
   `ToolRuntime` interface, so adapters select listing behavior from the
   declaration instead of a concrete class.
5. **Name collisions fail closed.** In multi-tenant mode, publishing a
   contract revision whose compiled tool names collide with an active
   revision's tool names is rejected at publication. Silence is not resolved
   by automatic renaming; the revision stays inactive until the owner
   renames. Generated servers are single-tenant, so names remain as compiled.
6. **Discovery and invocation share one resolution path.** Tool listing is
   identity-filtered at call time against the same tenant-scoped registry that
   `callTool` resolves against. No pre-filtered static snapshot exists in
   multi-tenant mode; per-call authorization still runs for every invocation,
   including tools the listing may have shown, because listing is not
   authorization.
7. **Authorization and cache partition cannot disagree.** The tenant value
   used to authorize a call is the same value that enters the cache key. There
   is no second tenant-resolution function for caching.

The final public interface shapes are governed by `API_REFERENCE.md`; this ADR
records which behavior is mandatory, not the exact signatures.

## Alternatives considered

- **Do tenant mapping in each transport adapter.** Rejected: violates
  ADR 0004's separation of transport and policy; the stdio and HTTP paths
  would implement different rules, and generated code would interpolate
  mapping logic.
- **Global registry plus name-prefix conventions** (for example
  `tenantA_listInvoices`). Rejected: a tool name is data, not identity. A
  caller-supplied or convention-parsed name is exactly the input a prompt
  injection or a buggy client can control, and generated servers have no
  gateway to enforce prefixes.
- **Flat registry with the authorizer resolving ownership from tool names.**
  Rejected: same weakness as prefixes, but with the resolution hidden inside
  an adapter instead of in the registry, so listing and invocation can resolve
  differently.
- **Keep tenant binding only in generated server configuration.** Rejected:
  it matches generated deployments but leaves the gateway with no binding,
  which is the primary cross-tenant risk.
- **Make the authorizer optional as today and rely on it "usually" being
  configured.** Rejected: an optional mapping in a multi-tenant registry is
  an out that maps to silent cross-tenant access; multi-tenant mode must fail
  at construction instead.
- **Resolve collisions in the gateway by deterministic renaming.** Rejected
  for now: silently rewriting tool names changes what models were configured
  against and what generated documentation says; publication rejection keeps
  the failure at a reviewed boundary.
- **Snapshot-based listing with a post-registration filter.** Rejected: the
  mismatch between the snapshot's view and the live registry is the defect
  class this ADR exists to close.

## Consequences and trade-offs

- `ToolDefinition` and registry behavior change before 1.0. Generated config
  gains an explicit tenant identity, and the compiler must emit tenant
  metadata alongside tool definitions.
- The runtime needs a tenancy-mode declaration at construction; existing
  Milestone 2 behavior is retained only in single-tenant mode, which must be
  documented as trusted-local, not secure.
- A tenant-scoped registry is a new internal structure: resolution is keyed by
  tenant and name, listing is filtered per call, and concurrent revision
  activation must keep both operations consistent.
- Publication rejection punishes innocent tool-name collisions; contract
  owners must choose names that are globally unique across active revisions.
  This is a documented operational cost, accepted in exchange for structural
  isolation.
- Per-call authorization cost grows when listing is filtered dynamically;
  deployments that care can cache denials and outside of tenant-scoped
  registries, but correctness must not depend on that caching.
- Generated servers get a stricter failure mode: a caller context with a
  tenant other than the pinned tenant is a policy denial, not a silent
  success, even though a single-tenant deployment expects only its own
  context.

## Security implications

- Closes the class of defect where tools are visible to one tenant's
  principal but callable by another's, including any drift between listing
  and invocation resolution.
- Prevents authorization from passing silently in the gateway when an
  `Authorizer` is forgotten: multi-tenant mode cannot start without one.
- Keeps tenant identity out of untrusted surfaces: it comes from trusted
  context construction and tool registration metadata, never from model-
  generated arguments or names.
- Keeps the cache partition consistent with the authorization decision, so
  cache isolation (ADR 0003) cannot be defeated by double resolution.
- Scope enforcement remains fail-closed by the stage rules of ADR 0006: any
  authorization-stage throw denies access, typed errors are preserved for
  protected diagnostics, and clients receive only the safe denial message.

## Follow-up actions

- Land tenant-bound tool registration, tenancy mode, and tenant-scoped
  resolution in `@chainmcp/core` (done: single-tenant pinned mode,
  multi-tenant fail-closed construction, `ownerTenantId` enforcement,
  identity-scoped `listTools(context)`, cross-tenant indistinguishability, and
  fail-closed isolation tests; documented in `API_REFERENCE.md` and
  `ARCHITECTURE.md`).
- Adopt identity-filtered listing in `@chainmcp/server` (done: multi-tenant
  runtimes are served through low-level per-request `tools/list` and
  `tools/call` handlers with the tools capability declared; identity comes from
  `createContext` per request, listing resolves against the same tenant-scoped
  registry as `callTool`, and serialization, byte caps, and safe error mapping
  are shared with the single-tenant snapshot path; verified against a real MCP
  client).
- Provide the default operation-scope authorizer (done: `OperationScopeAuthorizer`
  in `@chainmcp/auth` enforces
  `operation.requiredScopes ⊆ principal.scopes` with exact token semantics,
  denies malformed definitions and principals without scope lists instead of
  failing open, and leaves the tenant match to tenant-scoped resolution so it
  cannot weaken structural isolation).
- Keep the snapshot behavior for single-tenant deployments and document it as
  trusted-local.
- Sync `API_REFERENCE.md`, `ARCHITECTURE.md`, and `docs/generated-servers.md`
  when the interface lands; leave Milestone 5 and Milestone 9 unchecked until
  the mapping is implemented and verified.
- Define the transport-side session-to-principal mapping in `CONFIGURATION.md`
  as ADR 0004's follow-up before remote transport work (Milestone 5).
- Mark this ADR accepted only after the tenant match, scope check, and
  collision rejection are implemented and demonstrated failing closed in the
  core and gateway test suites; record any deviation in a new ADR.

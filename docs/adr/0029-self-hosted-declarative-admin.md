# ADR 0029 — Self-hosted declarative admin surface

- **Status:** accepted
- **Date:** 2026-11-02
- **Supersedes:** none
- **Related:** ADR 0008 (tenant-bound registration), ADR 0026 (dynamic gateway), ADR 0028 (declarative descriptors)

## Context

The post-1.0 roadmap adds an admin surface so an operator can create, validate,
preview, and publish declarative HTTP descriptors without editing code. The
roadmap also requires an admin identity model, tenant scoping, audit records,
and a dynamic registry before the surface is exposed, and it excludes a hosted
SaaS control plane. Durable descriptor persistence is a separate roadmap item.

The project already has the pieces that should own the dangerous parts:

- `@chainmcp/gateway` owns immutable contract revisions, tenant isolation,
  atomic activation, tool-name collision checks, and audit events.
- `@chainmcp/executor` owns outbound HTTP policy: exact host allowlist, HTTPS
  default, address classification, DNS pinning, peer verification, same-host
  redirects, timeouts, and body caps.
- `@chainmcp/declarative` validates descriptors and lowers them into executor
  operations with deterministic revisions.

Adding a parallel store and execution path for descriptors would duplicate
those guarantees and create a second source of truth.

## Decision

1. Add `@chainmcp/admin`, a self-hosted HTTP surface plus a dependency-free
   operator console.
2. Authentication uses deployment-configured bearer tokens with an
   operator-facing id and an explicit tenant scope (`"*"` or a tenant list).
   Tokens are compared in constant time over fixed-length digests, must be at
   least 16 characters, are never minted, logged, echoed, or persisted by the
   surface, and the UI keeps the presented token in page memory only.
3. Every `/api/v1/tenants/{tenant}/contracts/{contract}/...` route enforces the
   token's tenant scope before resolving the binding, so a scoped token cannot
   probe which tenants or contracts exist.
4. A deployment binds each contract to a destination policy, an optional
   credential scheme map, an optional credential provider, and optional limits.
   Descriptors can only reference those schemes; they cannot add hosts, change
   the base URL, or supply credentials.
5. Publishing lowers descriptors through a per-publish `UpstreamExecutor` and
   `DeclarativeToolSource`, then calls `DynamicGateway.publishContract()` with
   `tools`. Revisions, tenant ownership, collision checks, activation, audit,
   and rollback handling stay in the gateway. The admin package stores the
   descriptor set and per-tool revisions in the revision metadata.
6. Preview is static lowering only. It returns method, path, parameters, body
   binding, authentication alternatives, and policy, and never contacts the
   upstream API. Trial invocation would require inventing an admin-as-caller
   principal and is deferred.
7. The Node server binds loopback by default and refuses a non-loopback bind
   unless `allowRemote` is set. Before the handler runs it validates `Host`
   against the bound/loopback hostnames (DNS rebinding) and rejects cross-origin
   `Origin` or `Sec-Fetch-Site` values. The console is same-origin, uses a
   strict CSP with no inline script, and every response is `no-store`.

## Alternatives considered

- **Write directly into `ContractRegistry`.** Rejected: it would bypass the
  gateway mutex, activation collision checks, audit emission, and runtime
  rebuild that compiled contracts already use.
- **Add a descriptor database now.** Deferred to the persistence milestone. It
  would need its own migration, rollback, and tenant-ownership story and would
  not change the route or security design chosen here.
- **Expose the admin API through the existing MCP HTTP server.** Rejected:
  the MCP server is caller-facing and authorizes inbound MCP traffic with a
  different identity model. The admin plane needs operator identity, tenant
  scoping, and cross-origin protection that should not be shared.
- **Support live trial invocation from the UI.** Deferred, because it would
  blur operator and caller identity and require scopes that descriptors do not
  grant.
- **Cookie sessions with CSRF tokens.** Rejected for this slice: a bearer token
  in page memory is simpler, avoids ambient authority, and keeps the CSP strict.

## Consequences

- Published descriptor sets replace the contract's active toolset; the admin
  surface does not merge descriptors with compiled or manual sources under the
  same contract name.
- Revisions and descriptor sets are in memory until the persistence milestone.
  A restart loses them, and the admin surface cannot yet roll back by itself
  (`DynamicGateway.rollbackContract` remains available programmatically).
- Only JSON request bodies and JSON responses from descriptor version 1 are
  supported; there is still no response-schema validation.
- The admin surface adds a second credential-bearing listener. Operators must
  keep it on loopback or place it behind an authenticating proxy, and they must
  treat its audit sink as security telemetry.
- Request caps (1 MiB body, 1,000 descriptors) bound validation work but do not
  rate-limit publishing; a deployment must add rate limiting in front if
  needed.

## Security implications

- The admin plane can replace the tools served to MCP callers for a bound
  contract. Compromise of a token is equivalent to contract-write access for
  its tenants, not read-only access.
- Descriptors remain data. No code, expression, `$ref`, or remote reference is
  evaluated, and no credential value can be embedded.
- Descriptor-backed tools execute through the same executor and gateway runtime
  as compiled tools, so SSRF, authorization, rate limits, caching, projection,
  and redaction are not re-implemented here.
- Cross-origin and DNS-rebinding defenses are enforced at the transport before
  authentication, and unknown hosts/origins receive no contract information.
- Admin audit records include token id, tenant, contract, revision, tool count,
  and reason codes, but never tokens, descriptor arguments, or upstream
  credentials.

## Follow-up actions

- Persist descriptor sets and revision history with tenant ownership and add an
  admin rollback route (next roadmap item).
- Decide whether publishing merges sources per contract or keeps one source
  per contract name.
- Add a CLI entry point and configuration schema for the admin surface.
- Add rate limiting and an optional external authorization adapter in front of
  publish.
- Revisit trial invocation once an operator principal model exists.

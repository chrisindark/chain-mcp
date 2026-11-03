# ADR 0028 — Versioned declarative HTTP tool descriptors

- Status: accepted
- Recorded: 2026-11-02

## Context and problem

The post-1.0 roadmap adds a self-hosted declarative tool builder: an operator
describes an HTTP tool as data instead of shipping TypeScript, and the tool is
indistinguishable from a compiled or code-first tool at invocation time.
`AGENTS.md` forbids presenting a placeholder as production-ready, and ADR 0019
requires an ADR that reopens `ENT-04` (persistence) and `ENT-05` (hosted
control plane) before any builder work starts.

The first roadmap item is the descriptor itself, not the admin surface:

> Define a versioned declarative tool descriptor (name, schema, method, URL,
> auth reference, policy) executed by the bounded HTTP executor.

The descriptor raises five questions that must be answered before code:

1. What is in the descriptor, and what is deliberately absent?
2. How is untrusted descriptor data validated?
3. How does a descriptor reach the bounded executor without creating a new
   HTTP path or a second policy implementation?
4. How does an auth reference stay separate from credentials?
5. What is the boundary between this slice, persistence, and the admin UI?

## Decision

1. **New package `@chainmcp/declarative`.** It owns the descriptor schema and
   lowers a parsed descriptor into a `CompiledOperation` for
   `@chainmcp/executor`'s `UpstreamExecutor`. It does not implement HTTP,
   authentication, caching, or policy. A descriptor therefore inherits the
   executor's exact host allowlist, HTTPS default, address classification, DNS
   pinning, peer verification, same-host redirect revalidation, timeouts, and
   response caps (ADR 0018), plus the runtime's validation, authorization,
   rate-limit, cache, and output stages.

2. **A descriptor is data, versioned by `descriptorVersion`.** Version `1`
   contains:
   - `name` and `description` for MCP discovery.
   - `inputSchema`, a JSON Schema object using the audited subset enforced by
     `auditInputSchema`.
   - `request.method` from a fixed safe set and `request.path`, a path template
     relative to the deployment's configured `baseUrl`.
   - `request.parameters`, each bound to `path`, `query`, `header`, or `cookie`,
     and an optional JSON `request.body` bound to the `body` input property.
   - `authentication`, an OR list of alternatives whose AND sets reference
     named schemes configured by the deployment. Scopes are per reference.
   - `policy`: required scopes, opt-in read cache TTL, output field selection
     and token budget, and an execution timeout.

   The root schema is closed (no unknown keys) and absolute URLs, `$ref`,
   request/response composition, remote references, and arbitrary code are
   rejected. Descriptor `1` produces a tool whose result is the upstream JSON
   payload; response-schema validation is not part of version `1`.

3. **Validation is fail-closed and happens before registration.** Structural
   parsing uses Zod; semantic checks reject:
   - a non-object root schema, an unaudited construct, or a schema that does
     not set `additionalProperties: false`;
   - an input property that is not bound to exactly one parameter or to `body`,
     a parameter whose schema is not a primitive (or array of primitives), or a
     required parameter that the schema does not list as required;
   - a path template that is absolute, contains a query or fragment or dot
     segments, leaves a placeholder unresolved, or disagrees with the declared
     path parameters;
   - a cache TTL on a non-read method, or an empty name, description, or policy
     value.

   Each failure is a typed `DeclarativeDescriptorError` with a stable code and
   issue paths, so the future admin API can return actionable diagnostics
   rather than a stack trace.

4. **Auth references, never credentials.** A descriptor names schemes such as
   `api_key`; the deployment supplies a `DeclarativeAuthSchemeMap` with the
   credential _shape_ (`apiKey` parameter name and location, `http`
   basic/bearer, or `oauth2`). Secrets continue to come from the executor's
   configured `UpstreamCredentialProvider`. An unknown scheme name fails at
   parse time instead of failing every call, and scopes are rejected on
   non-OAuth schemes. Descriptor input can therefore never carry a token,
   secret, or credential-injecting header name.

5. **Determinism is part of the contract.** A descriptor revision is
   `sha256` over canonical JSON with sorted keys and normalized defaults. The
   same descriptor always yields the same `contractRevision`, so cache
   partitioning, tracing, and the future admin revision history can rely on it.
   Two descriptors that differ only in key order or omitted-vs-default flags
   are the same revision.

6. **This slice stops before persistence and the admin surface.** Publishing,
   revision history, tenant ownership, and the local UI remain open roadmap
   items. `ENT-04` stays resolved for gateway contracts and is now also
   reopened _for descriptors_ specifically: descriptor persistence is not
   implemented, and in-memory descriptor arrays are the only source. `ENT-05`
   remains dropped; no hosted control plane is introduced.

## Alternatives considered

- **Execute descriptor URLs directly with `fetch`.** Rejected: it duplicates
  the executor's SSRF policy and creates a second, weaker egress path.
  Violates ADR 0002 and the roadmap's "same policy, SSRF, redaction, and audit
  paths" requirement.
- **Allow absolute URLs in descriptors.** Rejected: a descriptor could target
  any host, bypassing the deployment allowlist. The deployment's `baseUrl` and
  `allowedHosts` remain authoritative.
- **Embed credential values or headers in the descriptor.** Rejected: it turns
  descriptor storage into secret storage and separates credential policy from
  the executor. Named references keep inbound identity, upstream credentials,
  and descriptor data distinct.
- **Compile descriptors to TypeScript and run `chainmcp build`.** Rejected:
  recompilation for every publish is unnecessary, and the executor already
  accepts operation metadata directly.
- **Implement the admin UI, persistence, and descriptors in one slice.**
  Rejected: the roadmap requires one bounded vertical slice at a time. The
  descriptor must be independently testable before a storage or identity model
  is chosen.

## Consequences and trade-offs

- `@chainmcp/declarative` becomes a public API surface and must be documented
  in `API_REFERENCE.md`.
- Descriptors gain the full runtime and executor guarantees without a new
  execution path; the cost is that descriptor `1` only supports JSON responses
  and JSON request bodies.
- A descriptor's path is relative, so multiple descriptors can share one
  deployment `baseUrl`. A future revision may allow per-descriptor base paths
  only inside the same allowlist.
- `CompiledOperation` is reused as the internal lowering target. It is not a
  promise that descriptors are OpenAPI; it is the executor's existing input
  format.
- The descriptor revision is per tool rather than per descriptor document.
  A collection of descriptors must be versioned by the caller until the admin
  surface defines a document revision.
- Changes to descriptor `1` semantics require a new `descriptorVersion`;
  adding an optional field with a safe default is a compatible change.

## Security implications

- Descriptors are untrusted configuration until validated. They are validated
  at load time and again audited by the executor (operation validation) and the
  runtime (schema registration).
- No code, template expression, or script is evaluated. Path substitution is
  limited to declared placeholders encoded as single URL segments.
- Absolute URLs, credentials, `Host`, `Authorization`, `Cookie`, and other
  transport-owned headers are rejected as descriptor inputs.
- Output is still subject to the deployment's projector, token budget, and
  response caps; caching is opt-in, read-only, and partitioned by descriptor
  revision.
- Persistence and multi-tenant ownership are not implemented here. Operators
  must not expose a future admin API without an inbound identity model,
  authorization, and audit trail.

## Follow-up actions

1. Persist descriptors with tenant ownership, revision history, and rollback
   (reopens `ENT-04` for descriptors).
2. Add a self-hosted admin API and local UI for create, validate, preview, and
   publish; require an admin identity model and audit events before exposure.
3. Evaluate response-schema validation and non-JSON descriptor responses as a
   later descriptor version, not as a silent extension of version `1`.

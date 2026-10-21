# ADR 0017: Explicit authentication policy mapping

- Status: proposed; executor added by ADR 0018 without credential enforcement
- Date: 2026-10-21

## Context

The compiler preserves OpenAPI `security` as nested maps, but a consumer should
not have to re-read `components.securitySchemes` to learn which credential an
operation needs, where it is supplied, and which scopes are required. The
runtime's `operation.requiredScopes` is a flat list and cannot represent OR
alternatives or AND combinations. Authentication enforcement and credential
injection do not exist yet, so a flat list would either over-require or
under-require access.

OpenAPI also allows an empty requirement object (`{}`) as an anonymous
alternative, which means authentication is optional. Dropping it would change
the contract.

## Decision

Derive a `CompiledAuthenticationPolicy` for every compiled operation:

- `alternatives` mirrors the top-level OR list, in contract order.
- Each alternative has a `schemes` array whose entries are ANDed.
- An alternative with no schemes is preserved, and any such alternative (or an
  empty policy) sets `allowsAnonymous: true`.
- Scheme entries copy the credential-relevant definition: API key parameter
  name/location, HTTP scheme and bearer format, OpenID Connect URL, and OAuth2
  flows.
- Required scopes are deduplicated and sorted by code unit; scheme entries are
  sorted by name for deterministic output.
- Require scopes to be empty for non-OAuth/OIDC schemes. OAuth2 scopes must be
  declared by at least one flow: strict mode errors and permissive mode warns,
  preserving the requirement either way. OpenID Connect scopes are preserved
  without offline validation because the scope catalog comes from discovery.
- Keep `operation.requiredScopes` empty. The explicit policy is the source of
  truth until an executor interprets it.
- Fail the whole compilation, emitting no tools, when the document-level
  `security` list cannot be parsed. Every operation inherits it, so continuing
  would silently make tools public.
- Include the policy in per-tool manifest hashes.
- Do not enforce the policy or resolve credentials in this slice.

## Alternatives considered

- **Flatten everything into `requiredScopes`:** rejected because OR alternatives
  would become an AND requirement, and scheme identity would be lost.
- **Emit only the raw security map:** rejected because consumers would still need
  to join requirements against scheme definitions and could easily miss
  anonymous alternatives or credential placement.
- **Drop `{}` alternatives:** rejected because that would turn optional
  authentication into mandatory authentication and break callers.
- **Enforce authentication in the compiler:** rejected because the compiler has
  no inbound identity, no credential provider, and no transport.
- **Reject unknown OAuth2 scopes in every mode:** rejected for permissive mode,
  where stale catalog entries are common. The scope is still preserved and the
  warning makes the mismatch visible.

## Consequences

- Consumers receive an actionable authentication shape without changing runtime
  behavior.
- Authentication is still unenforced; documentation and manifests must not imply
  otherwise.
- Strict mode rejects typos in OAuth2 scopes; permissive mode reports them.
- Scheme metadata changes (for example an API key header name) change the
  per-tool hash even when the raw `security` map is unchanged.
- Future enforcement can interpret the policy without re-parsing OpenAPI.

## Security implications

- Requirements are never silently dropped, including anonymous alternatives.
- Non-OAuth scope declarations fail closed instead of implying a nonexistent
  scope check.
- Scopes and credential metadata are non-secret contract data. Actual
  credentials must remain separate from inbound identity and must never be
  embedded in generated metadata.
- The policy does not authenticate anyone. ADR 0018 adds an executor, but an
  authentication and credential design is still required before callable tools
  can use these alternatives.

## Follow-up actions

1. Define how the executor consumes `authentication` and where credentials come
   from per scheme.
2. Add outbound destination policy, redirect revalidation, response caps, and
   `context.signal` binding. Implemented by ADR 0018 without credentials.
3. Decide whether the runtime authorizer should enforce selected alternatives
   using principal scopes, or whether authentication belongs entirely to the
   executor.
4. Validate OpenID Connect scopes against discovery when network policy exists.
5. Revisit `operation.requiredScopes` once enforcement semantics are settled.

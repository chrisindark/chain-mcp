# ADR 0015: OpenAPI compiler scope and deterministic manifests

- Status: proposed
- Date: 2026-10-21

## Context

Milestone 3 compiles OpenAPI contracts into MCP tools. The milestone is large:
it includes parsing, reference resolution, schema translation, authentication
mapping, outbound destination policy, cancellation binding, generated
executors, conformance testing, and examples.

Implementing all of it in one change would mix untested network execution with
contract analysis and would make it difficult to prove which behavior is
actually supported. The project also forbids presenting an unimplemented
capability as production-ready.

## Decision

Build the compiler in vertical slices. The first slice, `@chainmcp/compiler`,
is an offline contract analyzer that emits deterministic `CompiledOperation`
metadata:

- One YAML 1.2 or JSON document, with byte, depth, node, alias, and
  operation-count bounds.
- Local `#/...` references only, with cycle and depth detection. Remote
  references are rejected rather than fetched.
- Deterministic enumeration by sorted path and fixed method order.
- Object-root input schemas built from path, query, and header parameters plus
  a JSON request body mapped to a `body` property.
- Existing runtime-schema translation: 3.0 `nullable`, 3.1 null unions,
  `readOnly` input filtering, and `auditInputSchema` enforcement.
- Security requirements preserved as OR alternatives and AND key sets. They
  are not flattened into `requiredScopes` and are not enforced yet.
- `sourceHash` over exact source text, `contractRevision` over the canonical
  parsed document plus compiler version, per-tool hashes, and a `toolsetHash`.
- `diffManifests()` for regeneration comparisons.

Strict mode is the default. Unsupported constraints are errors and omit the
operation. Permissive mode may drop constraints that cannot weaken the
supported subset, with a warning. Composition, remote references, unknown
keywords, and schema-valued `additionalProperties` are always errors.

The compiler emits metadata, not runnable `ToolDefinition`s. Executors,
credential injection, destination policy, response-schema mapping, and
Inspector conformance remain explicit Milestone 3 work.

## Alternatives considered

- **Generate runnable tools immediately:** rejected for this slice because it
  would require outbound HTTP policy, SSRF controls, redirect revalidation,
  response caps, cancellation binding, and credential separation in the same
  change. Shipping those without dedicated security tests would violate the
  outbound-safety acceptance criteria.
- **Adopt a third-party OpenAPI-to-MCP converter:** rejected because it would
  not guarantee the runtime's supported schema subset, deterministic naming and
  hashing, or fail-closed diagnostics, and would add a large trust boundary.
- **JSON-only input:** rejected because YAML is the common OpenAPI format.
  YAML is parsed with the core schema, duplicate keys rejected, and alias/node
  limits enforced.
- **Flatten OR/AND security into `requiredScopes`:** rejected because an OR
  alternative would incorrectly require scopes from every scheme, and an AND
  requirement cannot be represented by a flat subset check. Metadata preserves
  the contract until explicit policies exist.

## Consequences

- The compiler can be reviewed and tested without network access.
- Consumers must not register compiled output as callable tools yet.
- Response schemas, composed schemas, and explicit authentication policies are
  documented as unsupported or metadata-only.
- Manifest hashes are stable for the same source and compiler version, so
  regeneration diffs are meaningful. Changing canonicalization, hashed fields,
  or compiler version deliberately changes the revision.
- Additional slices must extend the same diagnostics and manifest model rather
  than introduce a parallel generation path.

## Security implications

- Compilation performs no filesystem or network I/O and cannot trigger SSRF.
- Remote references are rejected instead of fetched.
- Dropping unsupported validation is limited to permissive mode and always
  produces a warning; composition cannot be dropped.
- Credential-bearing headers (`Authorization`, `Cookie`, and similar) are never
  exposed as tool inputs.
- Security requirements are preserved, not silently discarded, but they are not
  enforced until Milestone 5 and the executor slice.
- Input size, document depth, node count, reference depth, and operation count
  are bounded.

## Follow-up actions

1. Map response schemas and add output validation.
2. Translate composed `$ref` forms (`allOf`, `oneOf`, `anyOf`, `not`).
3. Preserve supported numeric, string, and format constraints in validators.
4. Generate explicit authentication policies from OR/AND requirements.
5. Add an upstream executor with destination allowlisting, private-range and
   metadata blocking, redirect revalidation, response caps, and
   `context.signal` binding.
6. Validate generated tools with an MCP client and Inspector conformance.
7. Add a runnable end-to-end example and CLI integration.

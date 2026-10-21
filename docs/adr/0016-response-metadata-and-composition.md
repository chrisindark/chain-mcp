# ADR 0016: Response metadata and object composition

- Status: proposed
- Date: 2026-10-21

## Context

ADR 0015 established an offline compiler slice that emitted operation metadata
without response schemas or composed schemas. Contracts commonly declare
response bodies, `writeOnly` fields, and `allOf` models. Leaving responses
unmapped hides useful contract information, while pretending to validate
outputs would overstate the runtime's capabilities: there is no executor, no
output validator, and no response-cap policy yet.

The runtime validator supports only a small JSON Schema subset (objects,
arrays, primitives, `enum`, `required`, `properties`, boolean
`additionalProperties`, and `items`). It cannot enforce `allOf`, `oneOf`,
`anyOf`, formats, bounds, or patterns.

## Decision

1. Map declared responses into `CompiledOperation.responses`:
   - Emit responses in code-unit order of their status key.
   - Accept `default`, exact `100`-`599` codes, and, for OpenAPI 3.1 only, range
     keys such as `2XX`.
   - Require a non-empty `description`; reject unknown fields and malformed
     `content` with `RESPONSE_INVALID`.
   - Select the first JSON media type (`application/json` or
     `application/*+json`) in code-unit order. If only non-JSON content exists,
     record the first media type without a schema and emit a
     `RESPONSE_UNSUPPORTED` warning.
   - Do not map `headers` or `links`.
2. Treat response schemas as descriptive metadata, not a validation boundary:
   - Resolve local `$ref`s with the same cycle and depth limits.
   - Translate 3.0 `nullable` and omit `writeOnly` properties.
   - Preserve composition and constraints outside the runtime subset instead of
     dropping them, because no validator consumes the result.
   - Do not generate a validator or apply one to upstream payloads.
3. Flatten `allOf` for input schemas only when it is an object intersection:
   - Every member must translate to an object schema (or declare no type).
   - Merge properties, requiring identical schemas on conflict, and union
     `required`.
   - Because `additionalProperties: false` only sees properties declared in the
     same member, flatten only when each closed member declares every merged
     property; then close the result. Otherwise reject, since moving the
     constraint to the root would accept values the intersection rejects.
   - Reject non-object members, sibling validation keywords, and incompatible
     properties with `SCHEMA_COMPOSITION_UNSUPPORTED`.
4. Keep input `oneOf`, `anyOf`, `not`, conditional, dependent, and pattern
   composition as errors. Resolving them requires runtime validator support that
   does not exist.
5. Include `responses` in each per-tool manifest hash.

## Alternatives considered

- **Generate an output validator now:** rejected because there is no executor,
  response-size cap, or output trust boundary yet. Adding a validator without
  those would create a false guarantee and a new denial-of-service surface.
- **Preserve response schemas verbatim:** rejected because local references,
  3.0 nullability, and `writeOnly` semantics would not be represented
  consistently with inputs.
- **Reject response constraints outside the runtime subset:** rejected because
  these schemas are not enforced. Rejecting them would prevent compiling common
  contracts without improving safety.
- **Flatten `allOf` by last-member-wins or shallow merge:** rejected because it
  can accept values the intersection rejects. Incompatible members must fail.
- **Implement `oneOf`/`anyOf` input validation in the compiler only:** rejected
  because the runtime would still accept values the contract rejects. Compiler
  and runtime must enforce the same subset.

## Consequences

- Consumers can inspect declared responses and composition metadata.
- Response schemas must not be presented as output validation until an output
  validator slice exists.
- Per-tool hashes change when response metadata changes.
- Object `allOf` models compile; union and conditional models still require
  contract changes or a future validator extension.
- Diagnostics gain `RESPONSE_INVALID`, `RESPONSE_UNSUPPORTED`, and
  `SCHEMA_COMPOSITION_UNSUPPORTED`.

## Security implications

- Compilation remains offline; no remote reference is fetched.
- `writeOnly` fields are omitted from response metadata, and `readOnly` fields
  remain omitted from inputs.
- Response metadata is untrusted descriptive data. Executors must still apply
  response-size limits, content-type checks, and redaction before exposing
  upstream payloads.
- Flattening does not weaken validation: incompatible intersections and
  non-object members fail closed.
- No credentials are read, embedded, or emitted.

## Follow-up actions

1. Add an output validator and apply it only after an executor with response caps
   exists.
2. Extend the runtime validator to `oneOf`/`anyOf`/`not` if the product needs
   union inputs, then allow them in the compiler.
3. Preserve supported numeric, string, and format constraints when the runtime
   enforces them.
4. Map explicit authentication policies from OR/AND requirements.
5. Add the upstream executor with destination allowlisting, private-range and
   metadata blocking, redirect revalidation, response caps, and
   `context.signal` binding.

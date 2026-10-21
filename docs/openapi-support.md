# OpenAPI Support

## Scope

ChainMcp targets OpenAPI 3.0 and 3.1, subject to the support matrix established by implementation and tests.

## Current implementation (2026-10-21)

`@chainmcp/compiler` currently implements the parsing and catalog slice of
Milestone 3. It:

- Parses one YAML or JSON document with the YAML 1.2 core schema, rejecting
  duplicate keys, multiple documents, non-JSON values, deep nesting, cycles,
  and sources above the configured byte limit.
- Validates the OpenAPI version, `info`, `paths`, path items, operations,
  parameters, JSON request bodies, response objects, and security structures.
- Resolves local `$ref`s only, with depth and cycle limits. Remote references
  are rejected rather than fetched.
- Enumerates eligible operations in deterministic path and method order.
- Generates runtime-compatible tool names from `operationId` or a method/path
  fallback, normalizes invalid characters, and reports collisions. Strict mode
  rejects a collision; permissive mode renames it with a warning.
- Builds an object-root input schema from path/query/header parameters and a
  JSON request body mapped to a `body` property. The root rejects undeclared
  properties with `additionalProperties: false`.
- Translates OpenAPI 3.0 `nullable` into a `"null"` type union (and adds `null`
  to `enum`), preserves OpenAPI 3.1 null unions, and drops `readOnly`
  properties from request inputs.
- Flattens an `allOf` of object schemas into one object schema when the
  intersection is semantics-preserving, resolving nested local `$ref`s.
  Incompatible properties, non-object members, sibling validation keywords, and
  input `oneOf`/`anyOf`/`not`/conditional composition are rejected.
- Audits every input schema with `auditInputSchema` and refuses to emit an
  operation the runtime cannot enforce.
- Maps declared responses as metadata: status keys, descriptions, the selected
  media type, and translated response schemas. OpenAPI 3.1 status ranges are
  supported; 3.0 ranges are rejected. Non-JSON-only content is recorded with a
  warning and no schema. `headers` and `links` are not mapped.
- Translates response schemas descriptively without generating or applying an
  output validator: local `$ref`s are resolved, 3.0 nullability is translated,
  `writeOnly` properties are omitted, and composition keywords such as
  `oneOf`, `anyOf`, and `not` are preserved.
- Preserves security schemes and OR/AND requirement structure as metadata. It
  does not enforce them yet.
- Emits `sourceHash`, `contractRevision`, a deterministic manifest with
  `toolsetHash` and per-tool hashes, and `diffManifests()` for regeneration
  comparisons.

The output is operation metadata (`CompiledOperation`), not runnable
`ToolDefinition`s. There is no upstream executor, outbound destination policy,
credential injection, response validation, CLI, or generated-server integration
yet.

## Compilation behavior

The full compiler must:

1. Parse and validate the source document.
2. Resolve local references safely.
3. Enumerate eligible operations.
4. Generate deterministic tool names.
5. Translate supported parameters and request bodies.
6. Generate input validators.
7. Record authentication and operation policies.
8. Emit diagnostics for unsupported or ambiguous constructs.
9. Produce a source hash and compiler version.
10. Bind `context.signal` to generated upstream calls and release executor resources on abort or timeout.

The current slice implements items 1-5 and 8-9 for operation metadata, part of
item 6 (input validation only), and item 7 as unenforced metadata. Response
mapping is descriptive; output validation, item 10, and execution remain open.

## Initial mapping

| OpenAPI concept        | Intended MCP representation                  |
| ---------------------- | -------------------------------------------- |
| `operationId`          | Preferred tool-name source                   |
| `summary`              | Tool description                             |
| Path parameters        | Required input properties                    |
| Query parameters       | Input properties                             |
| Header parameters      | Policy-controlled inputs                     |
| Request body           | Validated input object                       |
| Security schemes       | Authentication policy                        |
| Response schema        | Output metadata (validation not implemented) |
| Deprecated operation   | Warning or exclusion based on configuration  |
| `nullable: true` (3.0) | `type` union containing `"null"`             |

### OpenAPI 3.0 `nullable`

The compiler implements this translation. OpenAPI 3.0 expresses nullability with `nullable: true`, while the runtime validates only the JSON Schema union form (`type: ["string", "null"]`). `auditInputSchema` rejects `nullable` as an unsupported keyword, so an untranslated schema would fail closed at registration with `CONTRACT_INVALID` rather than silently dropping the constraint.

The compiler must translate before auditing:

- `nullable` only takes effect in 3.0 when `type` is present in the same schema object. If `nullable: true` appears without `type`, emit a diagnostic; do not drop it silently.
- `type: T` with `nullable: true` becomes `type: [T, "null"]`.
- When `enum` is present, `null` must be added to the enum as well. The runtime validates `enum` independently of `type`, so `type: ["string", "null"], enum: ["a", "b"]` would reject `null` even though 3.0 defines `nullable` as allowing it. Do not duplicate `null` if already present.
- `nullable` on a schema that also uses `$ref`, `allOf`, or another unsupported construct must produce a diagnostic rather than silently discarding nullability.
- A nullable root schema cannot be exposed as an MCP tool input, because tool arguments must be an object; `@chainmcp/server` rejects non-object root schemas.
- Run `auditInputSchema` on the translated schema and do not emit the tool if the result is unsupported.

Cover the 3.0 and 3.1 forms with fixtures so the two paths are tested separately.

## Unsupported constructs

The compiler must not silently weaken validation when it encounters unsupported schema features. It should fail in strict mode or emit explicit diagnostics in permissive mode.

Current status: strict mode (the default) errors and omits the operation for unsupported input constraints such as `format`, bounds, `pattern`, and `uniqueItems`. Permissive mode drops only constraints that can be omitted without changing the supported subset and records a warning. Input `allOf` is flattened when every member is an object schema and merging is semantics-preserving; nested `$ref`s are resolved first. Incompatible or non-object `allOf` members, sibling validation keywords, `oneOf`, `anyOf`, `not`, conditionals, dependent and pattern schemas, schema-valued `additionalProperties`, tuple/boolean `items`, remote references, and unknown schema keywords remain errors in both modes because dropping or approximating them would accept values the contract rejects.

Response schemas are metadata, not a validation boundary. Their translation preserves composition and constraints that the runtime cannot enforce, because no output validator exists yet. When an output validator is added, it must reject or explicitly document those keywords rather than silently ignore them.

Use `auditInputSchema` from `@chainmcp/core` on every generated tool input schema. It returns the same diagnostics the runtime enforces at registration, including stable codes and JSON-path locations. Do not emit a tool while its audit result is unsupported.

## Reference resolution

- Prefer local references in the first implementation.
- Limit document size and reference depth.
- Detect circular references.
- Never fetch arbitrary remote references without explicit network policy.
- Apply SSRF controls to every external fetch.
- Never execute code embedded in descriptions or extensions.

Current status: local `#/...` references only, with per-compile depth, cycle, source-size, and operation-count limits. A remote or non-local reference is `REF_REMOTE_UNSUPPORTED`; the compiler performs no network or filesystem I/O.

## Tool naming

Names must be deterministic, unique, and compatible with the MCP SDK's validation rules. Resolve collisions predictably and report any renaming.

Current status: `operationId` is preferred, normalized to `[A-Za-z0-9_-]{1,64}` and reported when normalization changes it. Missing IDs fall back to `<method>_<path segments>`. In strict mode a collision is an error and the later operation is omitted; in permissive mode the later operation receives a deterministic numeric suffix and a warning. Collision order follows sorted paths and a fixed method order.

## Testing

Maintain fixtures for:

- Valid OpenAPI 3.0 and 3.1 documents.
- Missing operation IDs.
- Repeated operation names.
- Nested schemas and references.
- Authentication schemes.
- Read and write operations.
- Invalid documents and unsupported schema constructs.

Current fixtures live in `packages/compiler/tests/fixtures/`. The deterministic test suite covers both versions, nullable translation, local and circular references, remote-reference refusal, tool-name collisions, security OR/AND structure, unsupported constructs in both modes, parameter/body mapping, `allOf` flattening, response mapping (including `$ref` responses, 3.1 ranges, non-JSON content, and output composition), limits, and manifest diffs.

Document actual compatibility based on tests rather than assumptions.

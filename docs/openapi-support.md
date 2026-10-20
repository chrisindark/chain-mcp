# OpenAPI Support

## Scope

ChainMcp targets OpenAPI 3.0 and 3.1, subject to the support matrix established by implementation and tests.

## Compilation behavior

The compiler should:

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

## Initial mapping

| OpenAPI concept        | Intended MCP representation                 |
| ---------------------- | ------------------------------------------- |
| `operationId`          | Preferred tool-name source                  |
| `summary`              | Tool description                            |
| Path parameters        | Required input properties                   |
| Query parameters       | Input properties                            |
| Header parameters      | Policy-controlled inputs                    |
| Request body           | Validated input object                      |
| Security schemes       | Authentication policy                       |
| Response schema        | Output validation and documentation         |
| Deprecated operation   | Warning or exclusion based on configuration |
| `nullable: true` (3.0) | `type` union containing `"null"`            |

### OpenAPI 3.0 `nullable`

The compiler is not implemented yet; this section records the required translation so it is not lost.

OpenAPI 3.0 expresses nullability with `nullable: true`, while the runtime validates only the JSON Schema union form (`type: ["string", "null"]`). `auditInputSchema` rejects `nullable` as an unsupported keyword, so an untranslated schema fails closed at registration with `CONTRACT_INVALID` rather than silently dropping the constraint.

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

Use `auditInputSchema` from `@chainmcp/core` on every generated tool input schema. It returns the same diagnostics the runtime enforces at registration, including stable codes and JSON-path locations. Do not emit a tool while its audit result is unsupported.

## Reference resolution

- Prefer local references in the first implementation.
- Limit document size and reference depth.
- Detect circular references.
- Never fetch arbitrary remote references without explicit network policy.
- Apply SSRF controls to every external fetch.
- Never execute code embedded in descriptions or extensions.

## Tool naming

Names must be deterministic, unique, and compatible with the MCP SDK's validation rules. Resolve collisions predictably and report any renaming.

## Testing

Maintain fixtures for:

- Valid OpenAPI 3.0 and 3.1 documents.
- Missing operation IDs.
- Repeated operation names.
- Nested schemas and references.
- Authentication schemes.
- Read and write operations.
- Invalid documents and unsupported schema constructs.

Document actual compatibility based on tests rather than assumptions.

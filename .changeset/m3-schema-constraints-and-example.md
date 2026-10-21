---
"@chainmcp/core": minor
"@chainmcp/compiler": minor
---

Enforce bounded JSON Schema constraints in generated validators.

The runtime now supports string `minLength`/`maxLength`, `pattern`, asserted
`format` values, numeric bounds and `multipleOf`, array length and structural
`uniqueItems`, and object property counts. Patterns use the linear-time
`re2js` engine, invalid or oversized patterns fail registration, and structural
uniqueness fails closed when its bounded comparison budget is exceeded. The
compiler preserves these constraints and normalizes OpenAPI 3.0 boolean
exclusive bounds to the JSON Schema numeric form.

Add `examples/petstore`, a compiled stdio MCP server wired to a deterministic
mock upstream, plus `docs/getting-started.md` and `pnpm conformance:inspector`.
The Inspector check exercises `tools/list` and `tools/call` and runs in CI.

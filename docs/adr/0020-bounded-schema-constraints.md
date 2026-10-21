# ADR 0020 — Bounded schema constraint validation

- **Status:** proposed
- **Date:** 2026-10-21

## Context

Milestone 3 requires generated input validators to preserve required fields,
enums, formats, and numeric and string constraints. The runtime previously
supported only `type`, primitive `enum`, `required`, `properties`,
`additionalProperties`, and `items`, and the compiler rejected every other
constraint in strict mode. That left common OpenAPI bounds unenforced and made
the compiler emit less-validated tools than the contract described.

Supporting constraints introduces three security questions:

1. A JSON Schema `pattern` is a regular expression. Running a contract-supplied
   pattern with JavaScript's backtracking engine can cause catastrophic
   backtracking on adversarial input.
2. `uniqueItems` requires structural comparison. A naive pairwise comparison is
   quadratic and can be used to exhaust CPU; canonicalizing arbitrary values can
   exhaust memory.
3. `format` is an annotation by default in JSON Schema. Treating every format
   string as an assertion would reject valid values and imply enforcement that
   the runtime cannot provide.

## Decision

The runtime enforces a documented, bounded subset of validation constraints:

- string `minLength`, `maxLength`, `pattern`, and asserted `format`;
- number `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, and
  `multipleOf`;
- array `minItems`, `maxItems`, and `uniqueItems`;
- object `minProperties` and `maxProperties`.

`pattern` is compiled with `re2js`, a linear-time RE2 port, rather than the
native `RegExp` engine. Patterns longer than 4,096 characters and patterns that
RE2 cannot compile are rejected at registration. Compiled patterns are cached
with a bounded cache.

`uniqueItems` uses a deterministic canonical key with a bounded depth and node
budget. If a value exceeds the budget or is not JSON-representable, validation
fails closed instead of skipping the check. JSON object key order does not
affect equality.

Asserted formats are limited to `date-time`, `date`, `time`, `email`,
`hostname`, `ipv4`, `ipv6`, `uri`, and `uuid`. Other format strings remain
annotations, matching JSON Schema's default behavior. The date and time formats
validate RFC 3339 component ranges, including calendar month lengths and leap
years.

The compiler preserves supported constraints and audits the generated schema
with `auditInputSchema`. OpenAPI 3.0 boolean `exclusiveMinimum` and
`exclusiveMaximum` are normalized to the JSON Schema numeric form; OpenAPI 3.1
numeric bounds are preserved. Unsupported input composition remains an error
because dropping it would accept values the contract rejects.

String lengths count Unicode code points, not UTF-16 code units. Numeric
`multipleOf` uses a small floating-point tolerance so decimal multiples such as
`0.3` and `0.1` are not rejected for binary representation error.

## Consequences

- Common OpenAPI constraints are now enforced end to end without bypassing the
  audited schema boundary.
- The runtime gains a dependency on `re2js` (MIT) in `@chainmcp/core`.
- Only the documented format subset is asserted. Contracts that rely on other
  formats must add explicit constraints or accept annotation-only behavior.
- `uniqueItems` can fail closed for pathologically large or deep values even
  when the input is otherwise valid. The budget is a resource bound, not a
  semantic relaxation.
- `pattern` accepts RE2-compatible syntax, which is a subset of ECMA-262. A
  pattern using unsupported features is rejected at registration rather than
  run with a backtracking engine.
- `multipleOf` validation is approximate at floating-point precision. Contracts
  that require exact decimal arithmetic should use integer units.
- Response schemas remain metadata; this ADR does not add output validation.

## Alternatives considered

- **Use native `RegExp` with a timeout.** Node has no synchronous regex timeout;
  a worker thread per validation would add substantial complexity and latency.
- **Use a native RE2 binding.** Native builds complicate installation and
  portability. The pure-JavaScript RE2 port is sufficient for schema validation.
- **Treat every format as an assertion.** This would reject common OpenAPI
  type-annotation formats such as `int32` and would overstate the supported
  set.
- **Reject all constraints.** This was the previous behavior and left M3
  acceptance criteria unmet.

## Verification

- Core tests cover accepted and rejected values for every constraint family,
  Unicode length counting, structural uniqueness, asserted formats, invalid
  declarations, and unsupported RE2 syntax.
- Compiler tests cover constraint preservation, 3.0 exclusive-bound
  normalization, 3.1 numeric bounds, and strict/permissive annotation handling.
- The `examples/petstore` Inspector check exercises compiled constraints through
  an MCP client.

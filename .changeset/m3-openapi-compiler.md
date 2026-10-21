---
"@chainmcp/compiler": minor
"@chainmcp/core": patch
"@chainmcp/config": patch
"@chainmcp/auth": patch
"@chainmcp/cache-redis": patch
"@chainmcp/server": patch
---

Add the first Milestone 3 OpenAPI compiler slices and a blocking-I/O lint rule.

`@chainmcp/compiler` parses and validates one OpenAPI 3.0 or 3.1 YAML/JSON
document, resolves local `$ref`s, enumerates operations deterministically,
builds audited object-root input schemas from parameters and JSON request
bodies, translates 3.0 nullability, flattens object `allOf` intersections when
merging preserves the contract, maps declared responses with their media types
and descriptive schemas, and derives explicit OR/AND authentication policies
with copied credential metadata and required scopes. Anonymous alternatives are
preserved, and OAuth2 scope mismatches are diagnosed. It emits deterministic
source/contract/toolset hashes plus manifest diffs. Response schemas are
metadata only and are not used to validate upstream payloads; authentication
policies are not enforced. The compiler does not inject credentials.

The repository now enforces `chainmcp/no-blocking-io` on runtime source paths,
rejecting synchronous `fs` and `child_process` APIs, with RuleTester coverage.

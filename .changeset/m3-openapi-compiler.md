---
"@chainmcp/compiler": minor
"@chainmcp/core": patch
"@chainmcp/config": patch
"@chainmcp/auth": patch
"@chainmcp/cache-redis": patch
"@chainmcp/server": patch
---

Add the first Milestone 3 OpenAPI compiler slice and a blocking-I/O lint rule.

`@chainmcp/compiler` parses and validates one OpenAPI 3.0 or 3.1 YAML/JSON
document, resolves local `$ref`s, enumerates operations deterministically,
builds audited object-root input schemas from parameters and JSON request
bodies, translates 3.0 nullability, preserves security OR/AND metadata, and
emits deterministic source/contract/toolset hashes plus manifest diffs. It does
not emit runnable executors, map response schemas, or enforce authentication
yet.

The repository now enforces `chainmcp/no-blocking-io` on runtime source paths,
rejecting synchronous `fs` and `child_process` APIs, with RuleTester coverage.

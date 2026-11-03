---
"@chainmcp/declarative": minor
"@chainmcp/executor": patch
---

Add `@chainmcp/declarative`, the first post-1.0 builder slice. `descriptorVersion: 1`
JSON documents describe an HTTP tool (name, audited input schema, method,
relative path, parameter/body bindings, auth references, and policy), are
validated at load time with stable diagnostic codes, and lower into the
existing bounded executor. Descriptors cannot contain absolute URLs,
credentials, transport-owned headers, or code. `DeclarativeToolSource` binds
validated descriptors to a deployment executor with deterministic
`sha256:` revisions, so descriptor tools inherit the same SSRF, redirect,
timeout, response-cap, authorization, cache, and output guarantees as compiled
tools. `@chainmcp/executor` exports `isReservedRequestHeader()` and
`isValidRequestHeaderName()` so descriptor validation and request building
cannot drift.

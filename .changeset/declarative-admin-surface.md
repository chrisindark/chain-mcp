---
"@chainmcp/admin": minor
---

Add `@chainmcp/admin`, the self-hosted operator surface for declarative HTTP
tools. Bearer tokens with explicit tenant scopes unlock validate, static
preview, publish, active-tool, and revision-history routes under `/api/v1`,
plus a dependency-free console. Publication lowers descriptors through a fresh
bounded executor and hands the tools to `DynamicGateway.publishContract()`, so
tenant ownership, revisions, activation, collision checks, and audit stay in
the gateway. The Node transport binds loopback by default, refuses non-loopback
binds without `allowRemote`, and validates `Host`, `Origin`, and
`Sec-Fetch-Site` before the handler runs. Descriptor documents and revisions
remain in memory until the persistence milestone.

---
"@chainmcp/admin": minor
---

Allow `DeclarativeAdmin` to take an injectable upstream `transport` and
`resolveHost`, at the admin level and per contract binding. Descriptor-backed
tools previously always resolved hosts with system DNS and sent requests
through the built-in fetch transport, so callers could not stub an upstream in
tests or route traffic through a custom agent. A binding-level `transport` or
`resolveHost` overrides the admin-wide value for that contract; both options
are optional and default to the previous behavior.

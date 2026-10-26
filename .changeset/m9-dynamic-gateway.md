---
"@chainmcp/gateway": minor
---

Implement Milestone 9: Dynamic gateway.

- Versioned contract registry (`ContractRegistry`) managing immutable candidate, active, superseded, rolled-back, and disabled contract revisions.
- `DynamicGateway` implementing `ToolRuntime` with `tenantMode: "multi-tenant"`.
- Atomic runtime snapshot updates with mutex serialization, guaranteeing in-flight request continuity and zero downtime during reloads.
- Per-contract network destination policies and upstream credential provider bindings.
- Tool name collision rejection within revisions and across active contracts for the same tenant.
- Rollback and revision disabling with structured, redacted audit event emissions.
- Tenant discovery and invocation isolation, cache isolation, and end-to-end MCP protocol integration.

# Dynamic Gateway

## Purpose

Serve multiple API contracts through one MCP-capable service.

## Registry model

Each contract revision contains:

- Immutable revision ID and source hash.
- Validated compiled tools.
- Tenant ownership or access policy.
- Upstream destination allowlist.
- Authentication and authorization configuration.
- Cache and rate-limit policy.

## Publication workflow

1. Accept a contract through a trusted management interface.
2. Validate and compile in an isolated operation.
3. Run security policy checks.
4. Create an immutable candidate revision.
5. Atomically activate the revision.
6. Retain rollback information.
7. Emit a redacted audit event.

## Isolation

A caller must never enumerate or invoke tools belonging to an unauthorized tenant. Authentication, cache keys, upstream credentials, quotas, and metrics must retain their tenant boundaries.

## Availability

- Contract compilation must not block unrelated requests indefinitely.
- Reloads must be atomic.
- Failed publications must not replace a working revision.
- Disable and rollback operations must be auditable.
- Per-tenant limits must prevent resource exhaustion.

## Scope boundary

The gateway is a deployment mode for the open-source runtime, not a requirement for using generated servers. Do not add a mandatory hosted SaaS dependency.

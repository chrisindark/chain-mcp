> Raw triage input. The authoritative, status-tracked version is
> `docs/risk-register.md`. This file is kept as source material and is not a
> roadmap or priority list.

Phase 1 — Security

- [ ] SEC-01 [P0] Authenticate protected MCP endpoints
      Plain English: A generated MCP server must not accidentally expose its HTTP endpoints without authentication.

Build: Require authentication by default for protected endpoints. Support per-tool and per-tenant permissions, validate credentials on every request, and reject unauthorized calls before executing tools.

- [ ] SEC-02 [P0] Translate OpenAPI security schemes correctly
      Plain English: If an API requires a particular token or a combination of authentication methods, your generated tools must honor that requirement.

Build: Translate OpenAPI security schemes into explicit runtime checks. Handle alternative authentication methods versus combinations that must all be satisfied. Never silently drop a security requirement.

- [ ] SEC-03 [P0] Implement robust OAuth discovery and token refresh
      Plain English: When an MCP client connects and needs to register or discover how OAuth works, an error response should not hide the information it needs to authenticate.

Build: Implement predictable OAuth discovery, registration behavior where supported, correct HTTP status codes, and machine-readable errors. Test login, consent, callback, token refresh, expiration, and reconnection.
A temporary secrets-service failure should not permanently stop token refresh, and expired login state should not accumulate forever.

Build: Use bounded retries with backoff, refresh-token locking, expiry-aware cleanup, encrypted token storage, and alerts for repeated failures. Make sure concurrent requests cannot trigger conflicting refresh operations.

- [ ] SEC-04 [P0] Enforce tenant isolation and resource ownership
      Plain English: A badly formed request or incorrect shared configuration should not crash your service or allow someone to bypass its security rules.

Build: Validate configuration at startup, isolate customer policies, fail closed when authorization cannot be evaluated, and test malformed inputs and concurrent requests. Treat the upstream issue's security claims as reports to verify, not confirmed vulnerabilities.

- [ ] SEC-05 [P0] Add argument-level and output-level policy enforcement
      Plain English: It is not enough to decide whether a user can access a tool. Sometimes you need to control what arguments they can send and what data the tool can return.

Build: Add policies for tool name, tenant, user role, argument values, resource ownership, and sensitive output fields. For example, a user may query their own customer records but not another tenant's records.

- [ ] SEC-06a (code, M3): resolve + classify destination IPs, block loopback/private/link-local/multicast/metadata, revalidate every redirect, pin the resolved address against rebinding, no scheme/port escalation, ignore ambient proxy env unless configured, byte/time limits.
- [ ] SEC-06b (project practice): checklist, dependency scanning, secret scanning. That's not a service feature — it's Milestone 0 work and doesn't belong in a P0 code issue.
      Plain English: A reported security problem needs a reproducible test and a clear assessment before you decide whether it affects your product.

Build: Maintain a security review checklist, dependency scanning, authorization regression tests, and a process for recording confirmed vulnerabilities and remediation status.

- [ ] SEC-07 [P0] Return explicit policy-denial errors and audit events
      Plain English: If your server blocks a tool call, it must not pretend that the operation succeeded.

Build: Return a clear denial result, distinguish policy rejection from a tool failure, record the reason in audit logs, and make the result understandable to the MCP client.

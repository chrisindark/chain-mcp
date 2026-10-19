# Security Policy

## Project status

ChainMcp must be treated as an early-stage project until its runtime, network controls, authentication, and security tests are complete.

## Assets to protect

- Upstream API credentials and refresh tokens.
- User and tenant data.
- API responses and cached values.
- Contract definitions and tool metadata.
- Identity and authorization policies.
- Availability and infrastructure resources.

## Threat model

The implementation must address:

1. Server-side request forgery through malicious API contracts or URLs.
2. DNS rebinding and unsafe redirects.
3. Cross-tenant or cross-principal cache leakage.
4. Credential exposure in logs, errors, traces, and generated code.
5. Unauthorized upstream operations.
6. Malicious or oversized contracts, arguments, and responses.
7. Prompt injection contained in tool names, descriptions, or API data.
8. Resource exhaustion through concurrent requests or expensive JSON traversal.
9. Unsafe retries of payment, deletion, or other non-idempotent operations.
10. Unauthenticated access to remote MCP endpoints.

## Mandatory controls

### Network security

- Require explicit upstream host policies in hosted deployments.
- Block loopback, private, link-local, multicast, and cloud metadata destinations unless a deliberate local-development policy allows them.
- Resolve and validate destination addresses before connecting.
- Revalidate redirects and prevent policy bypass through redirect chains.
- Apply connect, read, and total timeouts.
- Enforce request and response byte limits.
- Avoid forwarding inbound credentials to upstream hosts without explicit policy.

### Authentication

- Separate inbound MCP identity from upstream API credentials.
- Enforce authorization on every tool invocation.
- Store refresh tokens and API credentials through secure secret providers.
- Support expiry, revocation, and rotation.
- Fail closed when identity or authorization cannot be verified.

### Caching

- Partition entries by tenant, principal or authorization context, tool, contract revision, and relevant arguments.
- Never use raw bearer tokens as cache keys.
- Do not cache mutations by default.
- Never serve a cached response across authorization boundaries.
- Bypass caching when a safe partition cannot be established.

### Analytics

- Redact authorization headers, cookies, API keys, and sensitive parameters.
- Exclude raw request and response bodies by default.
- Restrict access to detailed telemetry.
- Define retention and deletion behavior.

### Resource controls

- Bound concurrency, execution time, input size, response size, and JSON traversal.
- Avoid unbounded retries and cache stampedes.
- Apply quotas by tenant and principal.
- Ensure cancellation reaches upstream requests.

## Reporting vulnerabilities

Configure a private vulnerability reporting channel before public release. Do not ask reporters to publish exploit details in public issues.

## Production readiness

Before production use, complete security integration tests, dependency scanning, SSRF tests, tenant-isolation tests, and a documented security review.

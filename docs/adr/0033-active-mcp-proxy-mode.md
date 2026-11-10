# ADR 0033 — Active MCP-to-MCP proxy mode and W3C traceparent propagation

- **Status:** accepted
- **Date:** 2026-11-11
- **Supersedes:** none
- **Related:** ADR 0002 (shared runtime), ADR 0008 (MCP authorization mapping), ADR 0010 (runtime cache eligibility), ADR 0026 (dynamic gateway architecture), ADR 0032 (universal telemetry and OTLP sink)

## Context

In modern agentic architectures, developers frequently deploy third-party or language-specific MCP servers—such as Python FastMCP tools, Go MCP servers, or command-line `stdio` MCP utilities. However, these external servers lack enterprise governance capabilities:

1. They lack inbound tenant isolation and role-based or scope-based authorization.
2. They do not enforce token-bucket or concurrency rate limits against calling agents.
3. They lack partitioned hashed caching, repeating expensive upstream or model invocations unnecessarily.
4. They cannot conform responses to token budgets or apply field projections to prevent LLM context window bloat.
5. Invocations to external MCP servers produce disconnected traces unless distributed tracing context is injected across the MCP transport boundary.

## Decision

1. **Active MCP-to-MCP Proxy Engine in `@chainmcp/gateway`:**
   - Implement `McpProxyAdapter` and `publishProxyContract()` in `DynamicGateway`.
   - Support external `stdio` processes (via `@modelcontextprotocol/client/stdio`) and Streamable HTTP endpoints (via `StreamableHTTPClientTransport`), as well as custom/in-memory transports for testing.
   - Automatically query `tools/list` on the external MCP server during initialization, creating strongly-typed `ToolDefinition` instances for every discovered tool.

2. **Unified Policy & Governance Enforcement:**
   - Every proxied tool is registered into the gateway's runtime pipeline. All ChainMcp policies apply transparently:
     - **Inbound Authorization:** Required scopes are enforced before the upstream MCP call is made (`@chainmcp/auth`).
     - **Rate Limiting & Concurrency:** Caller quotas are enforced before executing the tool (`@chainmcp/rate-limit`).
     - **Smart Caching:** Configured cache-eligible tools evaluate versioned hashed cache keys; cache hits return without invoking the external process/HTTP server (`@chainmcp/cache-redis`, `@chainmcp/core`).
     - **Token Budgets & Output Projection:** Oversized results from external tools are measured and projected to protect caller context budgets (`@chainmcp/core`, `@chainmcp/json-navigation`).
     - **Audit Logging & Telemetry:** Execution timing, outcome codes, cache hits/misses, and token counts are emitted to `MetricsSink`, `StructuredLogger`, and `TelemetryRingBuffer` (`@chainmcp/analytics`, `@chainmcp/storage`).

3. **W3C `traceparent` Context Propagation:**
   - Inject a standardized W3C `traceparent` (`00-{traceId}-{spanId}-{flags}`) into `params._meta` on proxy requests (`_meta.traceparent`).
   - Also propagate correlation attributes (`_meta["tenant.id"]`, `_meta["principal.id"]`, `_meta["request.id"]`).
   - When downstream MCP servers export traces back to ChainMcp's `/v1/traces` OTLP sink (ADR 0032), outer gateway spans and inner tool execution stitch seamlessly into unified distributed traces.

4. **Security & Boundary Invariants:**
   - **No Cached Writes:** `cacheEligible` defaults to `false`. Tools are never cached unless explicitly designated.
   - **SSRF Prevention:** Upstream HTTP proxy URLs must strictly conform to `destinationPolicy.allowedHosts`.
   - **Credential Isolation:** Outbound proxy credentials (headers) remain strictly isolated from inbound caller `Principal` identity.
   - **Clean Teardown:** Upstream client connections and subprocesses are tracked and cleanly closed when revisions are deactivated, disabled, or when `gateway.close()` is invoked.

## Consequences

- Any standard MCP server (Python FastMCP, Node, Go, or stdio CLI) can be governed by ChainMcp without modifying its code.
- Unified caching, rate limiting, and token accounting are applied across all tools.
- Distributed traces stitch together the calling agent, the ChainMcp gateway, and the downstream MCP server.

---
"@chainmcp/analytics": minor
"@chainmcp/admin": minor
"@chainmcp/cli": minor
---

Telemetry-driven diagnostics & automated optimization hints:

- Add `analyzeTelemetryDiagnostics` engine in `@chainmcp/analytics` to analyze MCP tool invocations, token payloads, latency percentiles, and cache performance.
- Automated optimization hints detect token bloat (>2,000 tokens default) and propose specific projection filters (excluding verbose fields or including essential keys), detect cache candidates on high-frequency idempotent GET requests, flag slow upstream endpoints (>1,500ms p95 latency), and alert on elevated error rates (>5%).
- Enforce security invariants refusing to recommend caching on mutation operations (POST/PUT/PATCH/DELETE) and maintaining tenant boundary isolation.
- Add `chainmcp_get_diagnostics` meta-tool to `@chainmcp/admin` agent tools, plus `/api/v1/diagnostics` API endpoints and Web Studio visualization panel.
- Add `chainmcp diagnostics` CLI command supporting text and JSON output modes, custom token bloat thresholds, time windows, and tenant/contract/tool filters.

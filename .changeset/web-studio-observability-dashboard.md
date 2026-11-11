---
"@chainmcp/storage": minor
"@chainmcp/admin": minor
"@chainmcp/cli": minor
---

Add Live Shield & OTel Observability Dashboard from SQLite WAL storage (M13-4):

- `@chainmcp/storage`: Extended `TelemetryQueryOptions` and `TelemetryRingBuffer` (`MemoryStorageDriver` and `SqliteStorageDriver`) to support `until`, `isError`, `offset`, and `order: "asc" | "desc"` query filters.
- `@chainmcp/admin`: Added `GET /api/v1/telemetry/metrics` and `GET /api/v1/tenants/{tenant}/telemetry/metrics` endpoints aggregating total requests, cache hit ratio, error rates, p50/p95/p99 duration percentiles, token usage, per-tool breakdown, and 12-bucket timeSeries.
- `@chainmcp/admin`: Extended `GET /api/v1/telemetry` with status, time bounds, pagination, W3C trace correlation (`traceId`, `spanId`), and automatic secret redaction using `@chainmcp/analytics`.
- `@chainmcp/admin`: Added Shield & OTel Observability card in Web Studio UI with live metric badges, auto-refresh polling, filter controls, event table, and detail inspection modal.
- `@chainmcp/cli`: Added Web Studio observability integration tests.

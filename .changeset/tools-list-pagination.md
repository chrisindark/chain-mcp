---
"@chainmcp/server": minor
"@chainmcp/config": minor
"@chainmcp/cli": minor
---

Paginate `tools/list` with revision-bound cursors.

- `@chainmcp/server`: `McpServerOptions.toolsPageSize` (default `100`; `0` disables pagination) applies to both the single-tenant snapshot path and the multi-tenant per-request path. Pages are ordered deterministically by tool name, and `nextCursor` is opaque and bound to the listing revision. Stale, malformed, and cross-tenant cursors fail with the stable `STALE_CURSOR` error.
- `@chainmcp/config`: `server.toolsPageSize` defaults to `100` and accepts `0`.
- `@chainmcp/cli`: `serve`, `dev`, `gateway serve`, and generated server templates pass `server.toolsPageSize` through to the adapter.
- Additive: clients that request `tools/list` without a cursor still receive the complete listing because the MCP client aggregates pages.

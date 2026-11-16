---
"@chainmcp/admin": minor
"@chainmcp/cli": minor
---

Agent-callable Meta-MCP server (`chainmcp agent-server`):

- Add `createMetaMcpTools` to `@chainmcp/admin` exposing 11 agent-callable meta tools (`chainmcp_list_contracts`, `chainmcp_inspect_contract`, `chainmcp_inspect_tools`, `chainmcp_curate_tool`, `chainmcp_configure_projection`, `chainmcp_configure_cache`, `chainmcp_test_tool`, `chainmcp_compile_spec`, `chainmcp_publish_revision`, `chainmcp_list_revisions`, `chainmcp_rollback_revision`) with strict input schemas and tenant boundary isolation.
- Enforce security invariants preventing caching on mutation methods (POST/PUT/PATCH/DELETE) and preventing disabling all tools.
- Add `chainmcp agent-server` CLI command with stdio and HTTP transports for Claude, Cursor, and Gemini coding agents to inspect, curate, test, and tune running ChainMcp deployments.

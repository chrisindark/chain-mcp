---
"@chainmcp/cli": minor
"@chainmcp/executor": minor
---

Stage in Gateway, Eject to Standalone workflow:

- Add `chainmcp eject` and `chainmcp export --from-gateway` commands to eject curated gateway contracts and active SQLite storage revisions into self-contained standalone server packages.
- Prune disabled and excluded tools while preserving output projections, cache policies, and destination policies.
- Wire `ToolOutputPolicy` and per-tool timeouts in `UpstreamExecutor` tool creation and execution.
- Validate that ejected servers build and pass offline tests with zero gateway or admin runtime dependencies.

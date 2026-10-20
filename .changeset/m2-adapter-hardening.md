---
"@chainmcp/core": minor
"@chainmcp/server": minor
---

Declare `tenantMode` on `ToolRuntime`, dispatch the MCP adapter on that declaration instead of a concrete class, and preserve typed `RuntimeError`s thrown by context factories. Also map error codes through an exhaustive table, bound `maxResponseBytes` to 100 MB, and replace the placeholder `TODO` license with `UNLICENSED`.

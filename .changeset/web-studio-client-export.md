---
"@chainmcp/admin": minor
"@chainmcp/cli": minor
---

Add one-click client export snippets with secret redaction (M13-5):

- `@chainmcp/admin`: Added `generateClientExportSnippets()` and client snippet types generating ready-to-paste configurations for Claude Desktop (`claude_desktop_config.json`), Cursor (`.cursor/mcp.json`), and Claude Code CLI for both `stdio` and `sse` transports with OS path guidance.
- `@chainmcp/admin`: Enforced complete secret redaction via `@chainmcp/config`'s `redactConfigSecrets` and deep object sanitization, ensuring zero credential leakage in snippets and environment instructions.
- `@chainmcp/admin`: Exposed `GET /api/v1/export/snippets` and `GET /api/v1/tenants/{tenant}/contracts/{contract}/snippets` endpoints with transport, server name, and SSE URL options.
- `@chainmcp/admin`: Added Client Export Snippets interactive card in Web Studio UI with client tabs (Claude Desktop, Cursor, Claude Code CLI), transport selection, live snippet preview, clipboard copy with visual feedback, and environment variable setup guides.
- `@chainmcp/cli`: Updated Web Studio to pass configuration AST to admin for snippet generation and added integration tests for snippets endpoints and Web Studio UI components.

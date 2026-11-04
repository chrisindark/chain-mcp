---
"@chainmcp/cli": minor
"@chainmcp/server": minor
"@chainmcp/core": minor
"@chainmcp/analytics": minor
"@chainmcp/gateway": minor
"@chainmcp/compiler": minor
"@chainmcp/auth": minor
"@chainmcp/rate-limit": minor
"@chainmcp/json-navigation": minor
"@chainmcp/executor": minor
"@chainmcp/cache-redis": minor
"@chainmcp/config": minor
"@chainmcp/declarative": minor
"@chainmcp/admin": minor
"@chainmcp/authoring": minor
---

Documentation truth pass (P0-8).

- README now says the project is pre-1.0 and that the 1.0 release is deliberately withheld; registry `npx @chainmcp/cli` and bare `chainmcp` examples are marked as requiring publishing or an installed CLI (clone path is `node packages/cli/dist/bin.js`); intended technology no longer lists Hono or PostgreSQL (no database metadata store ships); token accounting, JSON navigation, response-schema enforcement, and auth-policy language match the shipped behavior.
- `docs/getting-started.md`: response schemas are enforced by the executor when `server.validateResponses` is `warn`/`enforce`; authentication policies are not enforced by the compiler. Code-first init examples now include `--local-deps`.
- `docs/deployment.md`: generated-server install and Dockerfile steps now use pnpm in local-deps mode.
- `docs/product-guide.md`: softened `reduce payloads by up to 90%`, `sub-millisecond`, and `military-grade` marketing claims; corrected metric names to the four emitted by `OpenTelemetryMetricsSink` (`chainmcp.tool.invocations`, `chainmcp.tool.duration`, `chainmcp.tool.tokens`, `chainmcp.tool.payload_bytes`); clarified JSON navigation requires the full document supplied inline.
- Added a CI drift guard: `pnpm docs:check` validates that every documented capability in `docs/capability-evidence.json` points to a real test file or exported API, and that the README `## Core capabilities` bullets are all covered. Wired into `pnpm check` and CI.

---
"@chainmcp/authoring": minor
"@chainmcp/cli": minor
"@chainmcp/core": minor
"@chainmcp/executor": minor
---

Implement Milestone 8: Tool Sources and Code-First Authoring.

- Add `@chainmcp/core` `ToolSource` boundary interface and `InMemoryToolRuntime.registerSource()`.
- Add `OpenApiToolSource` in `@chainmcp/executor` wrapping compiled operations and `UpstreamExecutor`.
- Add `@chainmcp/authoring` package with `defineTool()` authoring facade, `ManualToolSource`, and `zodToJsonSchema()` lowering with definition-time schema audits against the supported JSON Schema subset.
- Add policy parity tests (`packages/authoring/tests/parity.test.ts`) asserting 100% equivalence between manual and compiled tools across input validation, authorization scopes, rate limiting, cooperative cancellation/timeout, output projection, result caching, and safe error masking.
- Add `chainmcp init --blank` in `@chainmcp/cli` to scaffold contract-free, code-first MCP server projects with example tools and build templates.
- Add `chainmcp dev` in `@chainmcp/cli` for a local developer authoring loop over stdio.
- Add runnable code-first example in `examples/code-first` with automated integration tests over the official MCP SDK client.
- Update documentation in `docs/getting-started.md`, `API_REFERENCE.md`, `CONFIGURATION.md`, and `ARCHITECTURE.md`, accept ADR 0019, and record ADR 0025.

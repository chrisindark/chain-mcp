# ChainMcp

**Turn API contracts into production-ready Model Context Protocol (MCP) servers.**

ChainMcp
is an open-source TypeScript/Node.js toolkit that converts API contracts into MCP tools and provides a shared runtime for security, caching, token accounting, rate limiting, and observability.

## Vision

A developer provides an OpenAPI contract. ChainMcp
validates it, generates discoverable MCP tools, and makes them available through a standalone server or a dynamic gateway.

ChainMcp
is more than an API-to-MCP code generator: it is a reusable execution and policy layer for MCP servers.

## Core capabilities

- **Contract compilation:** OpenAPI 3.x to MCP tool definitions.
- **Generated servers:** Portable projects that run independently.
- **Dynamic gateway:** Load and serve multiple versioned API contracts.
- **Token accounting:** Token counts or explicitly labeled estimates.
- **Smart caching:** TTLs, authorization-aware cache keys, and response projection.
- **Authentication:** Separate inbound MCP authorization from upstream API credentials.
- **Rate limiting:** Tenant, principal, and tool-level quotas.
- **Analytics:** Usage, latency, failures, cache performance, and token metrics.
- **JSON navigation:** Bounded exploration of large JSON responses.

## Product principles

1. Open-source core with no mandatory hosted dependency.
2. Generated and dynamic servers share the same runtime.
3. Security-sensitive behavior defaults to deny or bypass.
4. All network and resource consumption is bounded.
5. Every public capability has tests and documentation.
6. The project never claims an unimplemented capability is production-ready.

## Intended technology

- TypeScript and Node.js
- pnpm workspaces
- Official TypeScript MCP SDK
- Zod for runtime validation
- Hono for HTTP services where appropriate
- Redis as an optional distributed cache
- PostgreSQL as an optional metadata store
- OpenTelemetry for observability

These are initial architectural choices and may change through documented architecture decision records.

## Repository documentation

- `ROADMAP.md`: milestones and acceptance criteria
- `ARCHITECTURE.md`: system design and component boundaries
- `CONFIGURATION.md`: configuration contract
- `DEVELOPMENT.md`: development and testing workflows
- `API_REFERENCE.md`: public interfaces and package contracts
- `SECURITY.md`: threat model and mandatory controls
- `RELEASES.md`: versioning and release process
- `CONTRIBUTING.md`: contribution workflow
- `AGENTS.md`: coding-agent instructions
- `docs/`: detailed product and implementation guides

## Project status

ChainMcp
begins as an early-stage project. Features are considered implemented only when the code, tests, documentation, and security requirements agree.

The current workspace contains `@chainmcp/core` (an in-memory tool registry/runtime with input validation, injectable policy/telemetry interfaces, hashed cache keys, opt-in per-tool result caching, output projection and token budgets, token measurement, and a bounded in-memory store), `@chainmcp/config` (a strict Zod schema and parser for a small configuration subset), `@chainmcp/auth` (the default authorizer enforcing `operation.requiredScopes` against the caller's principal), and `@chainmcp/server` (an official TypeScript MCP SDK adapter with local stdio transport). OpenAPI compilation, CLI, network execution, credential providers, distributed cache/rate-limit adapters, remote MCP transports, and the gateway are not implemented.

Run `pnpm install` followed by `pnpm check` from the repository root to run formatting verification, lint, typecheck, unit tests, and builds.

## Intended CLI experience

```bash
chainmcp init --spec ./openapi.yaml
chainmcp validate
chainmcp build
chainmcp serve
chainmcp export --output ./generated-server
```

These commands describe the target developer experience, not a claim that the commands already exist.

## Security

Do not expose an unreviewed instance to untrusted traffic. Read `SECURITY.md` before implementing upstream HTTP execution, remote transports, credentials, or caching.

## License

The project license must be chosen before public distribution. Do not publish the repository with an assumed license.

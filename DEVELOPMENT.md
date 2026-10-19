# Development Guide

## Prerequisites

- Node.js 20 or newer, subject to the supported-version policy.
- pnpm 11 managed through Corepack.
- Git.
- Docker when running optional Redis integration tests.

## Initial setup

```bash
corepack enable
pnpm install
pnpm build
pnpm typecheck
pnpm test
```

These commands must be implemented and verified by the initial repository-generation task. Do not claim they pass until executed successfully.

The current workspace provides `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build`; `pnpm check` runs these in sequence. `pnpm format` applies Prettier. The available packages are `@chainmcp/core` and `@chainmcp/config`.

## Engineering conventions

- Use TypeScript strict mode and ESM.
- Avoid `any`; use `unknown` at untrusted boundaries.
- Validate external data at runtime.
- Propagate `AbortSignal` through network operations.
- Keep core packages independent of infrastructure adapters.
- Use dependency injection for clocks, HTTP clients, caches, and metrics.
- Prefer deterministic tests and mock upstream APIs.
- Do not log credentials or raw response bodies by default.
- Avoid implicit retries for non-idempotent requests.
- Keep public exports explicit.

## Testing strategy

Production code lives in each package's `src/` directory; tests live in the
matching `tests/` directory. Builds emit `src/` only, while typechecking and
Vitest include both.

### Unit tests

Test validation, cache keys, policies, canonicalization, rate limits, and JSON traversal.

### Contract tests

Test OpenAPI 3.0 and 3.1 documents, invalid schemas, missing operation IDs, authentication definitions, and unsupported constructs.

### Integration tests

Test real MCP client interactions, upstream HTTP requests, cache adapters, and generated-server builds.

### Security tests

Cover SSRF, redirects, DNS rebinding considerations, cross-tenant cache isolation, credential redaction, authorization bypass, oversized responses, and malicious JSON.

### Reliability tests

Test timeouts, cancellation, upstream failures, cache outages, concurrent calls, and graceful shutdown.

## Pull request workflow

1. Read `AGENTS.md` and the relevant architecture documents.
2. Identify the applicable roadmap milestone.
3. Write a short implementation plan.
4. Implement the smallest coherent change.
5. Add tests for successful and failing behavior.
6. Update documentation and changelog.
7. Run formatting, lint, typecheck, tests, and build.
8. Report commands run and any failures honestly.

## Definition of done

A pull request is not complete merely because the code compiles. It must also satisfy relevant security controls, tests, documentation, and compatibility requirements.

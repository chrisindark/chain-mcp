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

The current workspace provides `pnpm format:check`, `pnpm lint`, `pnpm test:rules`, `pnpm typecheck`, `pnpm test`, and `pnpm build`; `pnpm check` runs these in sequence and finishes with `pnpm version:check`. `pnpm format` applies Prettier. The available packages are `@chainmcp/core`, `@chainmcp/config`, `@chainmcp/compiler`, `@chainmcp/auth`, `@chainmcp/cache-redis`, and `@chainmcp/server`.

## Commits and local hooks

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/) (`type(scope): subject`, for example `feat(core): add monotonic duration`). `commitlint` enforces this.

Husky installs two hooks during `pnpm install`:

- `pre-commit` runs `lint-staged` (Prettier and ESLint on staged files) and then `pnpm typecheck`.
- `commit-msg` runs `commitlint` against the message.

Hooks are a fast local guardrail, not the gate. CI runs the full `pnpm check`, and hooks can be bypassed with `git commit --no-verify`. Do not rely on a bypassing commit; CI is the source of truth.

## Releases and versioning

Releases use [Changesets](https://github.com/changesets/changesets). `@chainmcp/core`, `@chainmcp/config`, `@chainmcp/compiler`, `@chainmcp/auth`, `@chainmcp/cache-redis`, and `@chainmcp/server` are a fixed group: they always share one version, and the private root package mirrors it.

- Add a changeset for every user-visible change: `pnpm changeset`.
- Apply pending changesets locally with `pnpm release:version`. This runs `changeset version` and then `scripts/sync-version.mjs`, which copies the shared package version onto the root `package.json`.
- `pnpm version:check` fails when the root and package versions drift; it runs as part of `pnpm check`.
- Publishing is intended to be a protected CI responsibility (`pnpm release:publish`), never a workstation step. The protected publishing workflow is not implemented yet. See `RELEASES.md`.

`changeset status` and `changeset version` compare against `baseBranch` (`master`), so run them from a clone that has the base branch fetched.

## Engineering conventions

- Use TypeScript strict mode and ESM.
- Avoid `any`; use `unknown` at untrusted boundaries.
- Validate external data at runtime.
- Propagate `AbortSignal` through network operations and release resources on abort or timeout.
- Keep core packages independent of infrastructure adapters.
- Use dependency injection for clocks, HTTP clients, caches, and metrics.
- Prefer deterministic tests and mock upstream APIs.
- Do not log credentials or raw response bodies by default.
- Avoid implicit retries for non-idempotent requests.
- Keep public exports explicit.
- Runtime source under `packages/*/src` and `apps/*/src` must not call synchronous filesystem or child-process APIs. `chainmcp/no-blocking-io` enforces this over `fs`/`node:fs` and `child_process`/`node:child_process` imports, aliases, `require`, and dynamic import. Tooling scripts are exempt.

## Testing strategy

Production code lives in each package's `src/` directory; tests live in the
matching `tests/` directory. Builds emit `src/` only, while typechecking and
Vitest include both.

### Unit tests

Test validation, cache keys, policies, canonicalization, rate limits, and JSON traversal.

### Contract tests

Test OpenAPI 3.0 and 3.1 documents, invalid schemas, missing operation IDs, authentication definitions, and unsupported constructs. `@chainmcp/compiler` keeps deterministic fixtures in `packages/compiler/tests/fixtures/`.

### Lint-rule tests

`pnpm test:rules` runs the repository's custom ESLint rules with `node --test`. Add a RuleTester case for every new rule or detected API form.

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

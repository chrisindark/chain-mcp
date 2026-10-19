# ADR 0001 — TypeScript and pnpm monorepo

- Status: accepted
- Recorded: 2026-10-19 (reconstructed from existing documentation and workspace configuration; no new decision)

## Context and problem

ChainMcp needs a compiler, shared runtime, MCP adapters, optional infrastructure
adapters, a CLI, and generated-server tooling. These components must evolve
together while keeping transport, policy, and infrastructure dependencies
separable. The project also needs strict typing at untrusted boundaries and a
single reproducible dependency graph for contributors and CI.

## Decision

Use a TypeScript monorepo managed by pnpm workspaces.

- Target Node.js 20.11 or newer and ES modules.
- Compile with TypeScript 5.9 under `strict` mode, including
  `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `noImplicitOverride`, and `noFallthroughCasesInSwitch`.
- Keep package boundaries explicit under `packages/*`, starting with
  `@chainmcp/core` and `@chainmcp/config`; create additional packages only when
  they have real implementation and tests.
- Use workspace dependencies so packages share source contracts without
  publishing intermediate artifacts.
- Keep lint, formatting, typecheck, test, and build commands runnable from the
  repository root through `pnpm check`.

## Alternatives considered

- **A single package.** Rejected: it would couple transport, compiler, policy,
  and infrastructure adapters, making dependency direction and testing harder
  to control.
- **Independent repositories.** Rejected: cross-cutting security and interface
  changes would require coordinated releases and risk version drift.
- **npm or Yarn workspaces.** Rejected in favor of pnpm's strict workspace
  linking and a single lockfile.
- **JavaScript with optional type checking.** Rejected: external contracts and
  untrusted input require validated types at runtime and compile time.
- **Non-ESM output.** Rejected: the project targets current Node.js and the
  official TypeScript MCP SDK, and ESM avoids dual-module complexity.

## Consequences and trade-offs

- Package boundaries are visible and enforceable, but every new package adds
  build and release overhead.
- Workspace linking makes local iteration fast, but published packages must
  still declare correct dependency versions.
- Strict compiler options catch more defects at the cost of additional
  annotation and validation work.
- The monorepo does not by itself prevent dependency cycles or layer violations;
  those remain review responsibilities.

## Security implications

- Strict TypeScript reduces accidental `any` propagation at trust boundaries.
- Keeping infrastructure adapters in separate packages limits which components
  can depend directly on Redis, PostgreSQL, HTTP clients, or cloud SDKs.
- Shared workspace tooling provides one place to enforce formatting, linting,
  tests, and dependency review.
- TypeScript types do not validate untrusted runtime data; runtime validation
  remains mandatory.

## Follow-up actions

- Add the remaining CI gates: dependency scanning and secret scanning
  (Milestone 0).
- Select a license before public release.
- Keep package dependency direction aligned with `ARCHITECTURE.md`.
- Revisit the Node.js and TypeScript support matrix before 1.0.

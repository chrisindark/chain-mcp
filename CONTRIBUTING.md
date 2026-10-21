# Contributing

Contributions should improve ChainMcp without compromising its security or portability.

## Before contributing

Read `ROADMAP.md`, `ARCHITECTURE.md`, `DEVELOPMENT.md`, and `SECURITY.md`.

For changes that affect public interfaces or system design, propose an architecture decision record before implementation.

## Issue intake

Triaged issues from other projects are evidence of failure modes, not a
roadmap. An item enters `ROADMAP.md` or the active backlog only when at least
one is true:

1. It is reproducible in this repository with a failing test.
2. It blocks the current vertical slice or the golden path (one runnable
   example an MCP client can use).

Everything else goes to `docs/risk-register.md` with a status and a
re-evaluation trigger. Do not assign priority from a source tracker's severity;
priority is derived from this gate.

## Guidelines

- Keep core logic provider-neutral.
- Validate all untrusted inputs.
- Prefer explicit policies over implicit behavior.
- Do not weaken authorization to make a test pass.
- Do not add production credentials or sensitive fixtures.
- Include tests for failure and adversarial scenarios.
- Update documentation when behavior changes.
- Use Conventional Commit messages; `commitlint` enforces them through a Git hook.
- Add a Changesets entry (`pnpm changeset`) for every user-visible change, including breaking changes before 1.0.
- Keep `CHANGELOG.md` and `ROADMAP.md` synchronized with verified changes.
- Do not mark roadmap items complete without evidence.

## Pull requests

A pull request should explain:

1. The problem being solved.
2. The implementation and alternatives considered.
3. Tests executed and their results.
4. Security implications.
5. Compatibility or migration impact.
6. Documentation and changeset entries updated.

## Licensing

ChainMcp is licensed under the Apache License, Version 2.0. By contributing to ChainMcp, you agree that your contributions will be licensed under its terms.

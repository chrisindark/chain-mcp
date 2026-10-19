# Contributing

Contributions should improve ChainMcp without compromising its security or portability.

## Before contributing

Read `ROADMAP.md`, `ARCHITECTURE.md`, `DEVELOPMENT.md`, and `SECURITY.md`.

For changes that affect public interfaces or system design, propose an architecture decision record before implementation.

## Guidelines

- Keep core logic provider-neutral.
- Validate all untrusted inputs.
- Prefer explicit policies over implicit behavior.
- Do not weaken authorization to make a test pass.
- Do not add production credentials or sensitive fixtures.
- Include tests for failure and adversarial scenarios.
- Update documentation when behavior changes.
- Update `CHANGELOG.md` for user-visible changes.
- Do not mark roadmap items complete without evidence.

## Pull requests

A pull request should explain:

1. The problem being solved.
2. The implementation and alternatives considered.
3. Tests executed and their results.
4. Security implications.
5. Compatibility or migration impact.
6. Documentation updated.

## Licensing

The maintainers must select and apply a license before distributing the project publicly.

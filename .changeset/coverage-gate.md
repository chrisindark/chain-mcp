---
"@chainmcp/cli": patch
---

Add a CI coverage gate with per-package floors.

- Per-package coverage thresholds (floors set just below the coverage measured on 2026-11-05, ratcheting upward with each improvement) live in `scripts/coverage-thresholds.mjs`, the single source of truth shared by the Vitest root run (`vite.config.ts`) and the new gate script.
- New `node scripts/check-coverage.mjs --summary` (also `pnpm coverage:check`) compares the fresh `coverage/coverage-summary.json` against the global and per-package floors, writes `coverage/coverage-gate.json`, and emits a Markdown summary.
- CI runs the gate in a dedicated `coverage` job, uploads the `coverage/` directory as the `coverage-report` artifact, and posts (or updates) the summary as a pull-request comment.
- Negative behavior: a package below its floor, a package with no covered files, or a missing/unparseable coverage report fails the gate instead of passing silently. Covered by positive, negative, and missing-report tests in `scripts/check-coverage.test.mjs`.
- Additive/internal: `pnpm check` is unchanged; the gate has its own CI job because package-level `pnpm -r test` runs without coverage.

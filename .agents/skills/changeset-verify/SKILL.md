---
name: changeset-verify
description: How to record atomic changesets, update capability evidence, and run full quality gates in ChainMcp. Use when finishing a feature or preparing a release.
---

# Changesets, Capability Evidence, and Quality Gates

ChainMcp uses `@changesets/cli` for version management and `docs/capability-evidence.json` as a machine-verifiable truth registry for documentation claims.

## 1. Adding a Changeset

Whenever you make changes to one or more packages in `packages/*`:

1. Run `pnpm changeset` or create a new markdown file directly in `.changeset/<descriptive-name>.md`.
2. Format:

```markdown
---
"@chainmcp/<package-name>": patch
---

Concise explanation of the change or fix.
```

Types: `patch` for bug fixes, `minor` for backward-compatible new features, `major` for breaking changes.

## 2. Capability Evidence (`docs/capability-evidence.json`)

If your change adds or alters a capability listed in `README.md` or major docs:

- Every capability entry must point to:
  - `doc`: The markdown document containing the claim.
  - `claim`: The exact substring in the doc.
  - `source`: The source code path exporting the capability.
  - `export`: The exact exported symbol name.
  - `test`: The test file verifying the behavior.
  - `testNeedle`: An exact substring in the test file verifying execution.
- Validate with: `pnpm docs:check`

## 3. Full Quality Gate Verification

Always execute before finishing your task:

```bash
pnpm format:check
pnpm lint
pnpm docs:check
pnpm build
pnpm typecheck
pnpm test
```

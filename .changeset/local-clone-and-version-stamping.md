---
"@chainmcp/cli": minor
---

Generate installable projects from a local clone and stop hardcoding the CLI version.

- `chainmcp init` and `chainmcp export` accept `--local-deps <repo-root>`, which
  emits relative `file:` specifiers plus a `pnpm-workspace.yaml` override block
  so the unpublished `@chainmcp/*` packages resolve from a cloned checkout.
- `--workspace-deps` is now available on the CLI for projects generated inside
  the monorepo. The two flags are mutually exclusive.
- `getCliVersion()` reads the CLI `package.json` at runtime. Dependency ranges,
  the generated server's advertised version, and `manifest.generatorVersion` are
  no longer pinned to `0.1.0`.
- Breaking for embedders: `CLI_VERSION` is replaced by `getCliVersion()`, and
  `buildProjectManifest` / `buildCodeFirstManifest` now require a
  `generatorVersion` option.

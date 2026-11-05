---
"@chainmcp/cli": patch
---

Make CI report the truth (P2-0). The `checks` and `inspector` matrices drop
Node.js 20, which `pnpm@11.0.0` cannot run (`ERR_UNKNOWN_BUILTIN_MODULE: No
such built-in module: node:sqlite`), and set `fail-fast: false` so one
failing leg can no longer cancel a passing one. The root `engines.node`
floor is now `>=22.13`, and the supported-version, getting-started, release,
development, and limitations docs agree.

The coverage job no longer fails when `coverage/coverage-summary.md` is
absent (a missing summary now warns instead of throwing `ENOENT`).

Generated-project tests no longer require a warm pnpm store:
`installGeneratedProject()` tries `--offline`, retries with
`--prefer-offline` only for `ERR_PNPM_NO_OFFLINE_META` /
`ERR_PNPM_NO_OFFLINE_TARBALL`, and still surfaces every other failure.
`assertChainMcpPackagesFromClone()` proves the property the product actually
guarantees — every `@chainmcp/*` dependency is a `file:` specifier installed
at the clone's version — instead of asserting the installed path is inside
the clone, which pnpm's virtual store makes impossible. Both helpers are
pinned by `packages/cli/tests/generated-install.test.ts`. README and
getting-started no longer claim that no registry access is needed at any
step: third-party dependencies still come from npm on a first install.

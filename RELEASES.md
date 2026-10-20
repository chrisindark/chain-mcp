# Release Management

## Versioning

Use Semantic Versioning:

- **MAJOR:** incompatible public API or configuration changes.
- **MINOR:** backward-compatible functionality.
- **PATCH:** backward-compatible fixes.

Before 1.0, breaking changes are permitted but must be documented prominently.

## Release channels

- `next`: prerelease validation.
- `latest`: stable releases.

The release policy is to publish packages from a protected CI workflow rather than a developer workstation. That workflow is not implemented yet; `.github/workflows/ci.yml` runs validation only. Until a protected publishing workflow exists, do not treat `pnpm release:publish` as an approved release procedure.

## Changesets workflow

Versioning is managed with [Changesets](https://github.com/changesets/changesets).

- `@chainmcp/core`, `@chainmcp/config`, and `@chainmcp/server` form a fixed group and always share one version. The private root `package.json` mirrors that version through `scripts/sync-version.mjs`, so the repository has a single version.
- Add a changeset (`pnpm changeset`) with every change that should appear in a release. `changeset status` fails on changed packages without one.
- Apply pending changesets with `pnpm release:version`, then review the generated `CHANGELOG.md` and version bumps before committing.
- `pnpm version:check` (part of `pnpm check`) fails when the root and package versions drift.
- The configured base branch is `master`. Run `changeset status` and `changeset version` from a clone with that branch fetched.
- `pnpm release:publish` invokes Changesets publishing, but no protected publish workflow currently calls it. Treat publishing as unavailable until that workflow is implemented and reviewed.

## Release checklist

- [ ] Relevant roadmap acceptance criteria are met.
- [ ] Every releasable change has a changeset, and pending changesets are applied.
- [ ] Root and package versions match (`pnpm version:check`).
- [ ] Changelog and release notes are updated.
- [ ] Documentation and migration notes are complete.
- [ ] Lint, typecheck, unit tests, and integration tests pass.
- [ ] Generated-server build and smoke tests pass.
- [ ] Dependency, license, and secret scans pass.
- [ ] Security review covers changes to auth, caching, networking, and permissions.
- [ ] Package contents are inspected.
- [ ] Software bill of materials is generated where applicable.
- [ ] Artifacts are signed or have provenance where supported.
- [ ] Installation from the published registry is verified.
- [ ] Rollback instructions are documented.

## Version compatibility

Document supported Node.js versions, supported OpenAPI versions, MCP SDK compatibility, and configuration version.

## Version 1.0 exit criteria

- Public interfaces are stable and documented.
- Compiler limitations are explicit.
- Generated and dynamic modes pass integration tests.
- Authentication, SSRF, caching, and rate limiting have security coverage.
- Failure behavior and operational limits are documented.
- Migration and rollback procedures exist.
- Maintainers have reviewed and approved the release.

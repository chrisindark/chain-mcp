# Release Management

## Versioning

Use Semantic Versioning:

- **MAJOR:** incompatible public API or configuration changes.
- **MINOR:** backward-compatible functionality.
- **PATCH:** backward-compatible fixes.

Before 1.0, breaking changes are permitted but must be documented prominently.

## Release status

ChainMcp is **pre-1.0**. Milestones 0–9 are implemented and verified, and
Milestone 10 tooling (supported-version matrix, SBOM, migration and rollback
documentation, and the signed-release workflow) is in place, but no `1.0.0`
artifact has been published. The project deliberately withholds 1.0 until the
stack has been exercised in a real production deployment and test coverage has
expanded. Pending changesets therefore target the next pre-1.0 minor release,
and a checklist item stays unchecked until it is true for a published artifact.

## Release channels

- `next`: prerelease validation.
- `latest`: stable releases.

The release policy publishes packages from a protected GitHub Actions CI workflow (`.github/workflows/release.yml`) rather than a developer workstation. The release workflow enforces:

- Full pre-publish validation (`pnpm check`, `pnpm conformance:inspector`, and `pnpm audit`).
- Software Bill of Materials (SBOM) generation via `pnpm sbom` with CycloneDX 1.5 JSON output.
- Signed npm provenance generation (`--provenance`) enabled by GitHub Actions OIDC (`id-token: write`).
- Automated Changesets versioning and tagging.

## Changesets workflow

Versioning is managed with [Changesets](https://github.com/changesets/changesets).

- All workspace packages share one version. The private root `package.json` mirrors that version through `scripts/sync-version.mjs`, ensuring the entire repository maintains atomic, unified versioning.
- Add a changeset (`pnpm changeset`) with every user-visible change or fix.
- Apply pending changesets with `pnpm release:version`, which updates package versions and synchronizes the root version.
- `pnpm version:check` (part of `pnpm check`) runs in CI and fails if root or package versions drift.
- Releases to npm are triggered when version PRs are merged to `master` in `.github/workflows/release.yml`.

## Release checklist

- [ ] Relevant roadmap acceptance criteria are met across all milestones (Milestones 0–9 verified; Milestone 10 gates prepared but release withheld, see [Release status](#release-status); the supported-version matrix is documented, but as a pre-1.0 intended-support document—not a published 1.0 guarantee—until a `1.0.0` artifact ships).
- [ ] Every releasable change has a changeset, and pending changesets are applied (changesets are present; they are applied by the release version PR).
- [x] Root and package versions match (`pnpm version:check`).
- [x] Changelog and release notes are updated (`CHANGELOG.md`).
- [x] Documentation, supported version matrix, and migration/rollback notes are complete (`docs/supported-versions.md`, `docs/migration-and-rollback.md`).
- [x] Lint, typecheck, unit tests, resilience tests, and integration tests pass (`pnpm check`).
- [x] Generated-server build and MCP Inspector conformance tests pass (`pnpm conformance:inspector`).
- [x] Dependency audit and license scans pass (`pnpm audit --audit-level=high`, `pnpm sbom:check`).
- [x] Security review covers auth, caching, SSRF prevention, tenant isolation, and error classification (`docs/risk-register.md`).
- [x] Software bill of materials (SBOM) is generated in CycloneDX 1.5 JSON (`scripts/generate-sbom.mjs`).
- [x] Artifacts have npm provenance configured in release workflow (`NPM_CONFIG_PROVENANCE: true`).
- [x] Rollback and troubleshooting procedures are documented (`docs/migration-and-rollback.md`, `docs/troubleshooting.md`).

## Version compatibility

Detailed version support matrix and lifecycle policy are documented in [`docs/supported-versions.md`](./docs/supported-versions.md):

- **Node.js**: `>=20.11` (tested on Node.js 20 and 22 LTS).
- **Operating Systems**: Linux, macOS, containerized Alpine/Debian environments.
- **OpenAPI**: 3.0.x and 3.1.x specifications.
- **MCP Protocol**: Model Context Protocol TypeScript SDK v2 (`@modelcontextprotocol/sdk`).
- **Redis**: Redis 7+ for atomic Lua scripting and cache partitioning.
- **Configuration**: Configuration schema `version: 1`.

**Pre-1.0 note.** Until `1.0.0` is published, the matrix in `docs/supported-versions.md` documents intended support, not a published release guarantee.

## Version 1.0 exit criteria

- [x] Public interfaces are stable and documented (`API_REFERENCE.md`).
- [x] Compiler limitations and validation rules are explicit (`ARCHITECTURE.md`, `docs/limitations.md`).
- [x] Generated and dynamic modes pass integration and conformance tests.
- [x] Authentication, SSRF, caching, tenant isolation, and rate limiting have comprehensive security test coverage.
- [x] Failure behavior, error codes, and operational limits are documented (`docs/troubleshooting.md`).
- [x] Migration and rollback procedures exist (`docs/migration-and-rollback.md`).
- [ ] All 10 roadmap milestones are implemented and verified (Milestones 0–9 are verified; Milestone 10 release gates are complete but the 1.0 release is deferred pending production validation).

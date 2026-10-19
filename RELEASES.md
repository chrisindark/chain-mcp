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

Publish packages from a protected CI workflow rather than a developer workstation.

## Release checklist

- [ ] Relevant roadmap acceptance criteria are met.
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

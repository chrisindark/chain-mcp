---
"@chainmcp/core": minor
"@chainmcp/executor": minor
"@chainmcp/gateway": patch
"@chainmcp/server": minor
"@chainmcp/compiler": patch
"@chainmcp/cli": patch
"@chainmcp/auth": patch
"@chainmcp/rate-limit": patch
"@chainmcp/cache-redis": patch
"@chainmcp/analytics": patch
"@chainmcp/authoring": patch
"@chainmcp/json-navigation": patch
"@chainmcp/config": patch
---

Implement Milestone 10: Stable 1.0 release gates and production readiness.

- Public API review and interface stabilization across all workspace packages.
- Supported version matrix published in `docs/supported-versions.md` covering Node.js (>=20.11, 20 & 22 LTS), operating systems, OpenAPI (3.0.x & 3.1.x), MCP TypeScript SDK v2, Redis (7+), and configuration version 1.
- Security and dependency audit (`pnpm audit`) verified zero high or critical vulnerabilities; updated threat model and disposition in `docs/risk-register.md`.
- Comprehensive load, resilience, and fault-injection test suites in `@chainmcp/core` and `@chainmcp/executor` verifying graceful degradation under cache/limiter outages, network drops, socket aborts, 5xx server errors, DNS failures, redirect loops, and in-flight cooperative cancellations (`AbortSignal`).
- Migration and rollback procedures for standalone generated servers and the dynamic gateway in `docs/migration-and-rollback.md` and runtime troubleshooting in `docs/troubleshooting.md`.
- CycloneDX 1.5 JSON Software Bill of Materials (SBOM) generator script (`scripts/generate-sbom.mjs`) and `pnpm sbom` command.
- Automated release workflow in `.github/workflows/release.yml` with signed npm provenance (`--provenance`) and Changesets publishing.
- Recorded ADR 0027: Stable 1.0 Release and Production Readiness.

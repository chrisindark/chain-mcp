# 0027. Stable 1.0 Release and Production Readiness

- **Status:** accepted
- **Date:** 2026-10-26
- **Authors:** Christopher Paul

## Context and Problem

ChainMcp has implemented all core functional capabilities across Milestones 1 through 9:

- Bounded core runtime with input validation, output projection, token budgets, and cached results (`@chainmcp/core`).
- OpenAPI 3.0/3.1 compilation and deterministic manifest generation (`@chainmcp/compiler`).
- Upstream HTTP/HTTPS execution with strict SSRF controls, DNS pinning, and response bounding (`@chainmcp/executor`).
- Inbound MCP authorization, OAuth 2.0 client credentials, and secret storage (`@chainmcp/auth`).
- Quota and concurrency rate limiting with Redis integration (`@chainmcp/rate-limit`, `@chainmcp/cache-redis`).
- Observability with structured logging, redaction, and OpenTelemetry telemetry (`@chainmcp/analytics`).
- Bounded JSON navigation and inspection tools (`@chainmcp/json-navigation`).
- Portable standalone server generation, build, serve, and diff CLI (`@chainmcp/cli`).
- Code-first tool authoring facade with Zod lowering (`@chainmcp/authoring`).
- Multi-tenant dynamic gateway with atomic contract revisions and rollback (`@chainmcp/gateway`).

To reach Milestone 10 ("Stable release") and satisfy all 1.0 release gates in `RELEASES.md`, the repository requires:

1. Public API review and interface stability guarantees.
2. A formal supported-version matrix and compatibility policy.
3. Vulnerability audits with zero high or critical findings.
4. Comprehensive resilience and fault-injection verification under simulated transport and infrastructure degradation.
5. Operational troubleshooting and deterministic migration/rollback procedures.
6. Automated signed releases with Software Bill of Materials (SBOM) and npm provenance.

## Decision

1. **Interface Stability and Semver:**
   - Commit all public workspace packages to Semantic Versioning 2.0.0.
   - Maintain unified atomic versioning across workspace packages using Changesets and `scripts/sync-version.mjs`.
   - Preserve non-blocking asynchronous I/O enforced by `chainmcp/no-blocking-io`.

2. **Supported Version Matrix:**
   - Document supported runtimes (Node.js `>=20.11`, tested on Node 20 and 22 LTS), operating systems (Linux, macOS, containerized Linux), OpenAPI specs (3.0.x and 3.1.x), MCP protocol SDK (v2 / 2.x), Redis (7+), and configuration (`version: 1`) in `docs/supported-versions.md`.

3. **Resilience and Fault Injection:**
   - Add automated test suites in `@chainmcp/core` and `@chainmcp/executor` verifying safe degradation:
     - Cache store outages degrade gracefully to bypass without failing tool invocations.
     - Rate limiter release failures and observability sink errors do not alter tool results.
     - Upstream network drops, socket aborts, 5xx server errors, and DNS resolution failures map to safe `UPSTREAM_FAILURE` errors without leaking socket internals.
     - In-flight cancellations abort immediately via cooperative `AbortSignal` listeners and map to `CANCELLED`.
     - Multi-tenant concurrent load is isolated without cross-talk.

4. **SBOM and Release Provenance:**
   - Implement `scripts/generate-sbom.mjs` producing CycloneDX 1.5 JSON SBOMs documenting all packages, licenses (Apache-2.0), and dependency references.
   - Configure `.github/workflows/release.yml` with GitHub OIDC token generation (`id-token: write`) to publish packages to npm with cryptographic build provenance (`--provenance`).

5. **Operational Guidance:**
   - Document error code mappings and SSRF diagnostic procedures in `docs/troubleshooting.md`.
   - Document upgrade, cache invalidation, and atomic rollback workflows for both standalone servers and the dynamic gateway in `docs/migration-and-rollback.md`.

## Consequences

- **Positive:**
  - Clear, unambiguous operational contracts for users running standalone servers or the dynamic gateway.
  - Provable supply chain integrity via CycloneDX SBOMs and npm build provenance.
  - Verified resilience against infrastructure and network faults.
  - Zero high or critical security vulnerabilities across dependencies.
- **Negative / Constraints:**
  - Declarative UI tool builder and hosted SaaS control plane remain explicitly deferred to post-1.0 per `AGENTS.md` and `ROADMAP.md`.

## Security Implications

- Release artifacts are traceable back to commit SHAs via npm provenance.
- Private network ranges and localhost remain blocked by default in production executors.
- Redaction sinks prevent authorization headers, API keys, and sensitive tokens from surfacing in log records or error traces.

# Changelog

All notable project changes are recorded here.

The project is pre-release. Versions and release dates must reflect actual published artifacts.

## Unreleased

### Documentation

- Define product vision and package boundaries.
- Specify generated-server and dynamic-gateway modes.
- Define configuration and public interface contracts.
- Document security requirements and release gates.
- Establish coding-agent workflow and roadmap milestones.

### Implementation

- Add a pnpm workspace with strict TypeScript, lint/format, test, typecheck, build, and CI configuration.
- Add `@chainmcp/core` with registration, discovery, supported-subset input validation, authorization/rate-limit hooks, timeout/cancellation handling, metrics, and deterministic identity-partitioned cache-key serialization.
- Add `@chainmcp/config` with strict Zod validation and defaults for the implemented configuration subset.
- Wrap unexpected execution failures in a stable, safe runtime error and keep metrics delivery from delaying tool results.

### Limitations

- No MCP server, OpenAPI compiler, CLI, gateway, upstream HTTP executor, or concrete cache/auth/rate-limit adapter is included.
- The core input validator supports only the subset documented in `API_REFERENCE.md`.
- License selection remains unresolved; the existing `LICENSE` file is empty.

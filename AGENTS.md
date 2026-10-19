# Instructions for Coding Agents

## Primary rule

Treat repository documentation as the product specification. Do not invent completed capabilities, silently change interfaces, or mark work complete without evidence.

## Before making changes

1. Read `README.md`, `ROADMAP.md`, `ARCHITECTURE.md`, and the relevant feature documents.
2. Inspect the actual code and tests.
3. Identify the roadmap milestone and its acceptance criteria.
4. Write a short plan for changes involving multiple files.
5. Identify security and compatibility implications.

## Engineering requirements

- Use TypeScript strict mode and ESM.
- Avoid `any`; validate untrusted data.
- Keep infrastructure integrations behind interfaces.
- Reuse the same runtime for generated servers and the dynamic gateway.
- Propagate cancellation and enforce resource limits.
- Never embed credentials in generated source or artifacts.
- Never cache writes by default.
- Never bypass authorization because a result is cached.
- Keep inbound identity and upstream credentials separate.
- Prevent SSRF, unsafe redirects, and unbounded responses.
- Redact secrets and sensitive data from telemetry.
- Do not implement OAuth, token counting, or distributed caching as placeholders presented as production-ready features.

## Testing requirements

Add unit tests for core logic, integration tests for adapters, and security tests for trust boundaries.

Use deterministic fixtures and mock upstream APIs. Do not rely on production credentials or external services for normal tests.

Run the repository's available checks and report the actual results. If a check cannot run, explain why.

## Documentation synchronization

Update relevant documentation whenever implementation changes:

- `API_REFERENCE.md` for public APIs.
- `CONFIGURATION.md` for configuration changes.
- `ARCHITECTURE.md` and an ADR for significant design changes.
- `ROADMAP.md` for verified milestone progress.
- `CHANGELOG.md` for user-visible changes.

## Scope control

Implement one milestone or clearly bounded vertical slice at a time. Do not attempt to finish the entire roadmap in a single task unless explicitly requested.

Do not introduce a hosted SaaS control plane into the open-source MVP unless requested.

## Definition of done

A task is complete only when:

- implementation is present;
- relevant tests pass;
- security requirements are met;
- documentation is synchronized;
- compatibility implications are assessed;
- actual validation results are reported.

At the end of every task, summarize changed files, behavior implemented, tests executed, known limitations, and the next recommended task.

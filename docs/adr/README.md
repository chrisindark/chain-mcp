# Architecture Decision Records

Record significant architectural decisions here.

Each ADR should include:

- Number and title.
- Status: proposed, accepted, superseded, or rejected.
- Context and problem.
- Decision.
- Alternatives considered.
- Consequences and trade-offs.
- Security implications.
- Follow-up actions.

Create an ADR before making a substantial change to public APIs, tenant isolation, transports, persistence, or runtime architecture.

Initial decisions to document:

1. TypeScript and pnpm monorepo.
2. Shared runtime for generated and dynamic execution.
3. Mandatory tenant and authorization cache partitioning.
4. MCP transport and authentication strategy.
5. Versioned, hashed cache keys.

Do not invent historical decisions. Mark new decisions as proposed until reviewed.

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

## Records

| ADR                                         | Title                                  | Status   |
| ------------------------------------------- | -------------------------------------- | -------- |
| [0001](0001-typescript-monorepo.md)         | TypeScript and pnpm monorepo           | accepted |
| [0002](0002-shared-runtime.md)              | Shared runtime for both delivery modes | accepted |
| [0003](0003-cache-isolation.md)             | Mandatory cache isolation              | accepted |
| [0004](0004-transport-strategy.md)          | MCP transport strategy                 | proposed |
| [0005](0005-versioned-hashed-cache-keys.md) | Versioned, hashed cache keys           | proposed |

ADRs 0001–0003 were recorded retroactively from existing documentation and
implementation. They describe decisions already reflected in the project, not
new commitments. Mark new decisions as proposed until reviewed.

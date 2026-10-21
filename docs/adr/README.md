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

| ADR                                                 | Title                                  | Status   |
| --------------------------------------------------- | -------------------------------------- | -------- |
| [0001](0001-typescript-monorepo.md)                 | TypeScript and pnpm monorepo           | accepted |
| [0002](0002-shared-runtime.md)                      | Shared runtime for both delivery modes | accepted |
| [0003](0003-cache-isolation.md)                     | Mandatory cache isolation              | accepted |
| [0004](0004-transport-strategy.md)                  | MCP transport strategy                 | accepted |
| [0005](0005-versioned-hashed-cache-keys.md)         | Versioned, hashed cache keys           | proposed |
| [0006](0006-stage-aware-policy-errors.md)           | Stage-aware policy adapter errors      | proposed |
| [0007](0007-wall-clock-and-monotonic-duration.md)   | Wall clock and monotonic duration      | proposed |
| [0008](0008-mcp-authorization-mapping.md)           | MCP authorization mapping              | proposed |
| [0009](0009-mcp-sdk-v2-packages.md)                 | MCP SDK v2 package split and pin       | proposed |
| [0010](0010-runtime-cache-eligibility.md)           | Runtime cache eligibility and binding  | proposed |
| [0011](0011-token-measurement-labeling.md)          | Token measurement labeling             | proposed |
| [0012](0012-output-projection-and-token-budgets.md) | Output projection and token budgets    | proposed |
| [0013](0013-declarative-field-projection.md)        | Declarative field projection           | proposed |
| [0014](0014-redis-cache-adapter.md)                 | Optional Redis cache adapter           | proposed |

ADRs 0001–0003 were recorded retroactively from existing documentation and
implementation. They describe decisions already reflected in the project, not
new commitments. Mark new decisions as proposed until reviewed.

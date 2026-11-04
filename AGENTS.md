# Instructions for Coding Agents (ChainMcp)

## Non-Negotiable Invariants

1. **Documentation is Product Specification**: Never invent capabilities, change interfaces silently, or mark tasks done without running tests.
2. **Strict Scope Control**: Implement one bounded priority item at a time from `PRIORITIES.md`. Do not attempt to finish the whole backlog in one turn.
3. **Security Invariants**:
   - Never cache writes; mutations must never be cached.
   - Enforce SSRF protection on upstream URLs.
   - Never embed credentials in generated source or artifacts.
   - Keep inbound identity (`Principal`) strictly separated from upstream credentials.
4. **Known Gaps (Do Not Fix Silently)**: PostgreSQL storage and database metadata stores are intentionally not implemented (see `docs/limitations.md`).

## Progressive Disclosure & Skills

Instead of ingesting large documentation files upfront, activate the skill matching your current task:

- `add-tool`: Authoring declarative or code-first tools (`.agents/skills/add-tool/SKILL.md`)
- `compiler`: Modifying OpenAPI contract compilation logic (`.agents/skills/compiler/SKILL.md`)
- `runtime-policy`: Auth, caching, rate limiting, and token budgets (`.agents/skills/runtime-policy/SKILL.md`)
- `changeset-verify`: Changesets, capability evidence, and quality gates (`.agents/skills/changeset-verify/SKILL.md`)

## Quick File & Package Index

- `packages/core`: Core runtime interfaces (`ToolContext`, `Principal`, `Tokenizer`).
- `packages/compiler`: OpenAPI to MCP converter (`compileOpenApi`).
- `packages/declarative`: JSON/HTTP tool descriptors.
- `packages/authoring`: Code-first TypeScript tool definitions.
- `packages/gateway`: Dynamic runtime gateway (`DynamicGateway`).
- `packages/server`: Transport server (HTTP SSE & stdio).
- `docs/adr/`: Specific architectural decision records (read only the relevant ADR by number).

## Verification Cheatsheet

- Fast format & lint check: `pnpm format:check && pnpm lint`
- Capability doc truth check: `pnpm docs:check`
- Individual package test: `pnpm --filter @chainmcp/<pkg> test`
- Full quality check: `pnpm check`

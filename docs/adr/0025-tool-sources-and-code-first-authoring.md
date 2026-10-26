# ADR 0025: Tool sources and code-first authoring implementation

- Status: accepted
- Date: 2026-10-26

## Context

ChainMcp was originally designed with OpenAPI contracts as the primary tool source. However, the core runtime boundary (`ToolDefinition` in `@chainmcp/core`) is agnostic to how tools are produced: it requires an input schema conforming to the audited JSON Schema subset, policy metadata, and an asynchronous `execute(input, context)` function.

Developers need to scaffold blank projects without an OpenAPI document, author tools in code with TypeScript and Zod, and run them through the exact same runtime pipeline as compiled tools. At the same time, trust boundaries must remain explicit: tool handlers are deployer-owned code, arbitrary runtime code upload is forbidden, and manual tools must not bypass tenant isolation, authorization, rate limiting, output projection, or cancellation.

## Decision

1. **`ToolSource` boundary in `@chainmcp/core`:**
   Define `ToolSource` producing `readonly ToolDefinition[]`:

   ```ts
   export interface ToolSource {
     getTools(): Promise<readonly ToolDefinition[]> | readonly ToolDefinition[];
   }
   ```

   Add `registerSource(source: ToolSource): Promise<void>` to `ToolRuntime` and `InMemoryToolRuntime`.

2. **`OpenApiToolSource` in `@chainmcp/executor`:**
   Wrap compiled OpenAPI operations and `UpstreamExecutor` into a first-class `OpenApiToolSource` implementing `ToolSource`.

3. **`@chainmcp/authoring` package:**
   Provide `defineTool()` and `ManualToolSource`. `defineTool()` accepts either a Zod schema (`schema`) or raw JSON Schema (`inputSchema`), lowering to the audited schema subset and auditing it immediately at definition time via `auditInputSchema`. Unsupported constructs (unions of complex types, recursive `$ref`, functions) are rejected at definition time before the server ever starts.

4. **100% Policy Parity:**
   Manual tools and compiled tools share the exact same `InMemoryToolRuntime.callTool` invocation stages:
   - Untrusted argument validation (`validateInput`).
   - Inbound authorization scope checks (`OperationScopeAuthorizer`).
   - Rate limiting and concurrency permits (`RateLimiter`).
   - Result caching and tenant/authorization cache partitioning (`CacheStore`).
   - Cooperative timeout and cancellation propagation (`context.signal`).
   - Output projection and token budgets (`ResultProjector`, `Tokenizer`).
   - Safe error masking: internal exceptions are concealed with `UPSTREAM_FAILURE` without leaking internal credentials, messages, or stack traces to clients.

5. **Scaffolding and Authoring Loop:**
   - Add `chainmcp init --blank` in `@chainmcp/cli` to scaffold projects with no OpenAPI requirement, creating `chainmcp.config.yaml` without `contract`, `src/tools.ts` with an example `greet` tool, and `src/server.ts`.
   - Add `chainmcp dev` to run the developer authoring loop over stdio.

## Alternatives considered

- **Permit dynamic runtime code upload or evaluation (`eval`).** Rejected: introduces arbitrary remote code execution risks and breaks immutability. Tool handlers are application code shipped by the developer.
- **Separate runtime or bypass policy for manual tools.** Rejected: would violate ADR 0002 (shared runtime) and allow code-first tools to bypass authorization or rate limits.
- **Defer schema validation until invocation.** Rejected: definition-time audit surfaces schema errors immediately on startup or module load, preventing broken tools from reaching the registry.

## Consequences

- `@chainmcp/authoring` is introduced as a workspace package.
- Projects can be contract-driven, code-first, or hybrid (combining contract tools and manual tools in the same server).
- CLI commands `init --blank` and `dev` provide a streamlined developer experience.
- ADR 0019 is accepted and realized by this implementation.

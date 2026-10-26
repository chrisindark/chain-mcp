# ADR 0019: Tool sources and code-first authoring

- Status: accepted
- Date: 2026-10-21 (accepted 2026-10-26)

## Context

ChainMcp currently treats an OpenAPI contract as the only supported input. The
runtime boundary is already broader: `@chainmcp/core` accepts a
`ToolDefinition` with a JSON Schema, policy metadata, and an `execute`
function, and `@chainmcp/server` serves whatever is registered. OpenAPI
compilation is therefore a producer of tool definitions, not a runtime
requirement.

Users also want the "blank server" workflow: scaffold a project, define tools in
application code, and run it through the same runtime. This project should also be an
authoring SDK with scaffolding, a dev CLI, widgets, OAuth helpers, and a client.
The absence of an authoring path is a
developer-experience gap, not an architectural one.

A visual tool editor is often proposed at the same time. It is a different
surface: it requires persistence, an admin identity model, a dynamic registry,
schema editing, and a safe way to describe HTTP operations. Those requirements
reopen decisions currently recorded as out of scope (`ENT-04` persistence and
`ENT-05` control plane) and are not needed to prove the code-first workflow.

## Decision

1. **Add a `ToolSource` boundary.** A tool source produces `ToolDefinition`s.
   OpenAPI compilation (`@chainmcp/compiler` plus `@chainmcp/executor`) remains
   the default source. The runtime does not depend on any specific source.
2. **Make a manual source first-class in 1.0.** Application code may register
   tools through an authoring facade (working name `defineTool()`). Manual tools
   pass through the same registration audit, input validation, authorization,
   caching, rate-limit, timeout, cancellation, response-cap, and output-policy
   stages as compiled tools.
3. **Lower schemas at definition time.** The facade accepts a supported
   `JsonSchema` and an optional Zod adapter. It lowers to the audited JSON
   Schema subset and rejects unsupported schemas when the tool is defined, using
   the same diagnostics as the compiler. No tool reaches the registry with an
   unaudited schema.
4. **Scaffold and run locally.** Add `chainmcp init --blank` (or equivalent)
   for a project with one hand-written example tool and no contract, and
   `chainmcp dev` for a local authoring loop. Stdio is the first transport;
   HTTP follows when the remote transport lands.
5. **Keep trust boundaries explicit.** Tool handlers are application code
   shipped by the deploying developer. The server never evaluates user-supplied
   source, never uploads code, and never fetches it at runtime. A manual tool has
   no contract revision or contract manifest; it is application-owned.
6. **Defer the visual builder.** A declarative tool descriptor, self-hosted
   admin API/UI, and persistence are post-1.0 work. They require an ADR that
   reopens `ENT-04`/`ENT-05`, and they must execute descriptors through the
   bounded HTTP executor with no arbitrary code upload and no hosted control
   plane. The visual builder is not part of the 1.0 critical path.

The working package name for the authoring surface is `@chainmcp/authoring`.
The exact API and package split are finalized during implementation; the
roadmap entry in Milestone 8 is the delivery commitment.

## Alternatives considered

- **Keep OpenAPI as the only source.** Rejected: the runtime already supports
  arbitrary tools, and users who do not have a contract would have to fork the
  runtime or rebuild its policy pipeline.
- **Build the visual editor first.** Rejected for 1.0: it requires persistence,
  an admin identity model, and a dynamic registry before the code-first path is
  proven, and it expands the release surface substantially.
- **Let the UI execute arbitrary JavaScript.** Rejected: it creates a remote
  code-execution boundary, a supply-chain surface, and a determinism problem.
  Declarative HTTP descriptors are the intended post-1.0 model.
- **Generate a separate runtime for manual tools.** Rejected: it would duplicate
  authorization, caching, and error semantics, contradicting ADR 0002.

## Consequences

- `@chainmcp/core` gains a source-neutral registration path without changing
  the invocation pipeline.
- `@chainmcp/authoring` becomes a new public API surface and must be documented
  in `API_REFERENCE.md` and `CONFIGURATION.md` when implemented.
- Compiled tools keep deterministic manifests and contract hashes. Manual tools
  do not participate in a contract hash; release pinning still applies to the
  runtime and authoring packages.
- `chainmcp init --blank` and `chainmcp dev` extend the CLI contract in
  `docs/generated-servers.md` and must be tested from a clean installation.
- The 1.0 scope grows by one milestone. The gateway and stable release shift to
  Milestones 9 and 10.
- The post-1.0 builder is explicitly not a 1.0 blocker; it remains in the
  roadmap so the direction is not lost.

## Security implications

- Manual handlers are trusted deployer code, equivalent to any application
  dependency. They are not sandboxed, and the documentation must say so.
- Every manual tool still receives the runtime's untrusted-input validation.
  A handler must not assume its input was validated by the transport.
- Schema lowering must fail closed. Unsupported constructs are rejected at
  definition time rather than silently dropped.
- Manual tools must not bypass tenant binding, authorization, cache
  partitioning, or output projection.
- The post-1.0 declarative builder must use the bounded executor, exact host
  allowlisting, SSRF controls, and redacted audit events. It must not introduce
  an arbitrary-code execution path.

## Follow-up actions

1. Implement `ToolSource`, the manual source, and the authoring facade in
   Milestone 8.
2. Add `init --blank`, `dev`, and a runnable code-first example.
3. Add parity tests proving manual and compiled tools share policy behavior,
   error mapping, cancellation, and response caps.
4. Update `API_REFERENCE.md`, `CONFIGURATION.md`, `docs/getting-started.md`, and
   `docs/generated-servers.md`.
5. Before post-1.0 work, record an ADR for declarative descriptors,
   persistence, and the self-hosted admin surface, and update `ENT-04`/`ENT-05`.

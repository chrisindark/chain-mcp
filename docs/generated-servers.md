# Generated Servers

## Purpose

Generated servers provide portable deployments for developers who do not want a shared gateway.

## Generation workflow

1. Load and validate the contract.
2. Compile it into deterministic operation metadata and bind it through
   `@chainmcp/executor` to a tool registry.
3. Generate project configuration and source files, including the upstream base
   URL and exact host allowlist.
4. Pin the runtime and compiler versions.
5. Produce a manifest containing the contract hash and generator version.
6. Run validation and build checks.
7. Emit deployment instructions.

## Generated project requirements

- No embedded credentials.
- No dependence on the original developer's filesystem.
- Reproducible output for identical inputs and generator versions.
- Explicit transport and security configuration.
- Shared runtime rather than duplicated policy implementations.
- Documented dependency and license information.
- Clear handling of unsupported operations.

## CLI contract

The intended commands are:

```bash
chainmcp init --spec ./openapi.yaml
chainmcp validate
chainmcp build
chainmcp serve
chainmcp export --output ./generated-server
```

Their exact argument semantics must be implemented, tested, and documented.

Milestone 8 extends the same CLI with a code-first path: `chainmcp init --blank`
scaffolds a project with no contract, and `chainmcp dev` provides a local
authoring loop. Those commands share the runtime and policy pipeline with
generated servers; they are specified in `ROADMAP.md`, not implemented yet.

## Milestone 3 evidence

`examples/petstore` is a hand-wired project that performs steps 1, 2, 5 (via
the compiler manifest), 6, and 7 for a small contract. It is not produced by a
generator and does not claim to be a generated project. It exists to prove the
compiler, executor, runtime, and stdio adapter compose end to end.
`pnpm conformance:inspector` checks `tools/list` and `tools/call` through the
MCP Inspector CLI, and `docs/getting-started.md` documents the flow.

## Acceptance criteria

A generated project must build and run from a clean checkout, expose expected tools to an MCP client, and enforce the same authorization and caching invariants as the shared runtime.

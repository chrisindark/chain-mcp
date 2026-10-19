# Generated Servers

## Purpose

Generated servers provide portable deployments for developers who do not want a shared gateway.

## Generation workflow

1. Load and validate the contract.
2. Compile it into a deterministic tool registry.
3. Generate project configuration and source files.
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

## Acceptance criteria

A generated project must build and run from a clean checkout, expose expected tools to an MCP client, and enforce the same authorization and caching invariants as the shared runtime.

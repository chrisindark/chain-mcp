# @chainmcp/declarative

Declarative JSON/YAML HTTP tool descriptor parser, schema auditor, and compiler for ChainMcp.

## Overview

`@chainmcp/declarative` enables defining HTTP-backed MCP tools as versioned declarative descriptors:

- **Descriptor Specification:** Closed `descriptorVersion: 1` schema specifying HTTP method, URL template, parameter bindings, input schema, auth mapping, and runtime policies.
- **Auditing & Lowering:** Compiles descriptors into executable operations bound to `@chainmcp/executor`, inheriting strict SSRF protection and destination allowlists.
- **Safety:** Rejects absolute URLs, transport-owned headers, and unsupported schema keywords before execution.

## Installation

```bash
npm install @chainmcp/declarative
# or
pnpm add @chainmcp/declarative
```

## Documentation

Full documentation and API reference are available in the [ChainMcp repository](https://github.com/chrisindark/chain-mcp#readme) and [API Reference](https://github.com/chrisindark/chain-mcp/blob/master/packages/declarative/API.md).

## License

Apache-2.0

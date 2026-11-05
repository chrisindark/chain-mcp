# @chainmcp/compiler

Deterministic OpenAPI 3.0 and 3.1 compiler to Model Context Protocol (MCP) tool contracts.

## Overview

`@chainmcp/compiler` compiles OpenAPI specifications into deterministic, validated MCP tool definitions without runtime dependencies or network I/O:

- **Contract Parsing:** Parses and validates OpenAPI 3.0.x and 3.1.x YAML and JSON documents.
- **Audited Input Schemas:** Flattens parameter bindings (path, query, header, cookie) and request bodies into strict object schemas.
- **Security Mapping:** Translates declared security requirements into explicit authentication policies.
- **Integrity & Diffing:** Emits content hashes, toolset revisions, and schema diffs (`diffContracts`) with breaking change classifications.

## Installation

```bash
npm install @chainmcp/compiler
# or
pnpm add @chainmcp/compiler
```

## Documentation

Full documentation and API reference are available in the [ChainMcp repository](https://github.com/chrisindark/chain-mcp#readme) and [API Reference](https://github.com/chrisindark/chain-mcp/blob/master/packages/compiler/API.md).

## License

Apache-2.0

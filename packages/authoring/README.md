# @chainmcp/authoring

Code-first TypeScript tool definition authoring with Zod and JSON Schema lowering for ChainMcp.

## Overview

`@chainmcp/authoring` enables defining custom MCP tools directly in TypeScript without an OpenAPI specification:

- **Fluent Tool Definition:** `defineTool()` authoring facade supporting both raw JSON Schema and Zod schemas.
- **Schema Lowering:** Converts Zod schemas into the runtime-audited JSON Schema subset, rejecting unsupported constructs at definition time.
- **Full Policy Parity:** Code-first tools participate in the exact same authorization, caching, rate limiting, cancellation, and token-budgeting pipeline as compiled tools.

## Installation

```bash
npm install @chainmcp/authoring
# or
pnpm add @chainmcp/authoring
```

## Documentation

Full documentation and API reference are available in the [ChainMcp repository](https://github.com/chrisindark/chain-mcp#readme) and [API Reference](https://github.com/chrisindark/chain-mcp/blob/master/packages/authoring/API.md).

## License

Apache-2.0

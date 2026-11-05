# @chainmcp/json-navigation

Resource-bounded JSON exploration, result handles, pagination, and path selection for LLMs in MCP.

## Overview

`@chainmcp/json-navigation` equips LLMs with tools to inspect and navigate large upstream JSON payloads without exceeding context windows:

- **Result Handles:** Opaque, HMAC-tagged, tenant-scoped handles (`json_create_handle`) allowing models to query large payloads without pasting them into context.
- **Targeted Tools:** `json_select_path`, `json_paginate`, `json_inspect_shape`, and `json_filter`.
- **Bounded Resource Limits:** Strict depth, node count, byte size, and execution time bounds protecting against deeply nested or cyclic payloads.

## Installation

```bash
npm install @chainmcp/json-navigation
# or
pnpm add @chainmcp/json-navigation
```

## Documentation

Full documentation and API reference are available in the [ChainMcp repository](https://github.com/chrisindark/chain-mcp#readme) and [API Reference](https://github.com/chrisindark/chain-mcp/blob/master/packages/json-navigation/API.md).

## License

Apache-2.0

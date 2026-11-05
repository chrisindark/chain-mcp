# @chainmcp/core

Core runtime interfaces, tool invocation pipeline, validation, caching, and token budgeting for ChainMcp.

## Overview

`@chainmcp/core` provides the foundational execution engine for Model Context Protocol (MCP) servers:

- **Invocation Pipeline:** Validates tool inputs, applies authorization scopes, checks rate limits, manages read caches, enforces execution timeouts, handles cooperative `AbortSignal` cancellation, and applies output token budgeting.
- **Tenant & Principal Context:** Typed abstractions for inbound principal identification, tenant isolation, and credential boundaries.
- **Audited Schema Subset:** Input schema validation using bounded JSON Schema constructs.
- **Deterministic Token Accounting:** Supports both character-based estimates and injectable exact tokenizers.

## Installation

```bash
npm install @chainmcp/core
# or
pnpm add @chainmcp/core
```

## Documentation

Full documentation and API reference are available in the [ChainMcp repository](https://github.com/chrisindark/chain-mcp#readme) and [API Reference](https://github.com/chrisindark/chain-mcp/blob/master/packages/core/API.md).

## License

Apache-2.0

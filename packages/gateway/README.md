# @chainmcp/gateway

Multi-tenant dynamic MCP gateway with atomic contract publishing, revisioning, and tenant isolation.

## Overview

`@chainmcp/gateway` serves as a dynamic multi-tenant router and registry for MCP tool contracts:

- **Contract Registry:** Dynamic registration, compilation, and validation of OpenAPI and declarative contracts per tenant.
- **Atomic Revision Activation:** Zero-downtime hot reloading of tool sets using mutex-synchronized runtime swaps.
- **Tenant Isolation:** Enforces strict isolation across tenants; prevents collision and cross-tenant enumeration.
- **Rollback & Lifecycle:** Instant revision rollback, contract disabling, and structured audit events for contract lifecycle changes.

## Installation

```bash
npm install @chainmcp/gateway
# or
pnpm add @chainmcp/gateway
```

## Documentation

Full documentation and API reference are available in the [ChainMcp repository](https://github.com/chrisindark/chain-mcp#readme) and [API Reference](https://github.com/chrisindark/chain-mcp/blob/master/packages/gateway/API.md).

## License

Apache-2.0

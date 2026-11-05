# @chainmcp/admin

Self-hosted operator surface and management console for declarative MCP tool publishing and rollback.

## Overview

`@chainmcp/admin` provides an operator API and bundled web console for managing declarative tools:

- **Admin REST API:** Endpoints for schema validation, static preview, atomic publishing, active tool listing, and revision rollback.
- **Descriptor Persistence:** File and in-memory persistence stores with tenant ownership, revision history, and startup state restoration.
- **Operator Console:** Built-in lightweight web UI for visualizing, drafting, and managing declarative contracts.
- **Tenant Scope:** Constant-time token verification ensuring operator tokens cannot cross tenant boundaries.

## Installation

```bash
npm install @chainmcp/admin
# or
pnpm add @chainmcp/admin
```

## Documentation

Full documentation and API reference are available in the [ChainMcp repository](https://github.com/chrisindark/chain-mcp#readme) and [API Reference](https://github.com/chrisindark/chain-mcp/blob/master/packages/admin/API.md).

## License

Apache-2.0

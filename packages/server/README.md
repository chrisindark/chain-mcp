# @chainmcp/server

Model Context Protocol (MCP) server transport adapter supporting stdio and Streamable HTTP with inbound authentication.

## Overview

`@chainmcp/server` adapts the ChainMcp runtime to the official Model Context Protocol TypeScript SDK:

- **Transports:** Supports standard I/O (`serveStdio`) for local CLI agents and Streamable HTTP (`serveHttp`) for remote network deployments.
- **Inbound Security:** Implements RFC-compliant token and JWT authentication, strict CORS allowlisting, and DNS-rebinding protection.
- **Reliability:** Graceful HTTP shutdown with in-flight request draining, `GET /health` liveness, and dependency-aware `GET /readyz` readiness probes.
- **Catalog Pagination:** Revision-bound pagination for large `tools/list` catalogs.

## Installation

```bash
npm install @chainmcp/server
# or
pnpm add @chainmcp/server
```

## Documentation

Full documentation and API reference are available in the [ChainMcp repository](https://github.com/chrisindark/chain-mcp#readme) and [API Reference](https://github.com/chrisindark/chain-mcp/blob/master/packages/server/API.md).

## License

Apache-2.0

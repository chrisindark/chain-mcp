# @chainmcp/rate-limit

In-memory and Redis-backed distributed quota and concurrency rate limiting for MCP tools.

## Overview

`@chainmcp/rate-limit` protects upstream APIs and agent workflows from runaway execution:

- **Partitioning:** Evaluates rolling-window request quotas and active concurrency limits by tenant, principal, tool, or global scope.
- **Backends:** High-performance in-memory LRU tracking for single-process setups and atomic Redis Lua scripts for distributed deployments.
- **Accurate Backpressure:** Provides precise `retryAfterSeconds` calculation on quota denials and configurable failure policies (`fail-closed` or `fail-open`).

## Installation

```bash
npm install @chainmcp/rate-limit
# or
pnpm add @chainmcp/rate-limit
```

## Documentation

Full documentation and API reference are available in the [ChainMcp repository](https://github.com/chrisindark/chain-mcp#readme) and [API Reference](https://github.com/chrisindark/chain-mcp/blob/master/packages/rate-limit/API.md).

## License

Apache-2.0

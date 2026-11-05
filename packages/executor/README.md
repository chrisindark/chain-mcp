# @chainmcp/executor

SSRF-protected upstream HTTP/HTTPS executor with DNS pinning, peer verification, and bounded streaming for MCP tools.

## Overview

`@chainmcp/executor` binds compiled operations into runnable MCP tool handlers with strict security boundaries:

- **SSRF Protection:** Enforces destination host allowlists, DNS pinning, and blocks loopback, RFC1918, link-local, cloud metadata, and multicast ranges.
- **Bounded Resource Limits:** Enforces response size caps, streaming body chunk limits, redirect bounds, and execution timeouts.
- **Resilience:** Bounded exponential-backoff retries for idempotent HTTP methods and per-host circuit breakers.
- **Credential Injection:** Securely attaches credentials resolved by `@chainmcp/auth` providers without leaking secrets into error outputs.

## Installation

```bash
npm install @chainmcp/executor
# or
pnpm add @chainmcp/executor
```

## Documentation

Full documentation and API reference are available in the [ChainMcp repository](https://github.com/chrisindark/chain-mcp#readme) and [API Reference](https://github.com/chrisindark/chain-mcp/blob/master/packages/executor/API.md).

## License

Apache-2.0

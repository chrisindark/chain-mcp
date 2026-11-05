# @chainmcp/cache-redis

Production Redis cache adapter for ChainMcp with connection pooling, TLS, and partition isolation.

## Overview

`@chainmcp/cache-redis` provides shared, partitioned caching for idempotent tool results:

- **Zero Heavy Dependencies:** Native Redis client implementation with no unneeded external dependencies.
- **Connection Management:** Connection pooling, automatic reconnection backoff with jitter, and graceful connection draining.
- **Enterprise Security:** Supports `rediss://` TLS encryption, ACL credentials, and automatic URI credential redaction in logs.
- **Partition Isolation:** Guarantees isolation across tenants, principals, and schema revisions.

## Installation

```bash
npm install @chainmcp/cache-redis
# or
pnpm add @chainmcp/cache-redis
```

## Documentation

Full documentation and API reference are available in the [ChainMcp repository](https://github.com/chrisindark/chain-mcp#readme) and [API Reference](https://github.com/chrisindark/chain-mcp/blob/master/packages/cache-redis/API.md).

## License

Apache-2.0

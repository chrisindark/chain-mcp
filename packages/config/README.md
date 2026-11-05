# @chainmcp/config

Configuration schema, secret reference resolution, and runtime wiring for ChainMcp servers and gateways.

## Overview

`@chainmcp/config` handles parsing, validating, and instantiating ChainMcp runtime components from configuration:

- **Schema Validation:** Strict YAML/JSON schema validation for server and dynamic gateway configurations.
- **Secret Resolution:** Resolves `${VAR}` and `${VAR:-default}` environment references in designated secret fields while preventing secret leakage.
- **Runtime Wiring:** Factory functions to construct authenticators, rate limiters, caches, and analytics sinks directly from configuration.
- **Inspection:** Powers `chainmcp config explain` to display resolved configurations with secrets redacted.

## Installation

```bash
npm install @chainmcp/config
# or
pnpm add @chainmcp/config
```

## Documentation

Full documentation and API reference are available in the [ChainMcp repository](https://github.com/chrisindark/chain-mcp#readme) and [API Reference](https://github.com/chrisindark/chain-mcp/blob/master/packages/config/API.md).

## License

Apache-2.0

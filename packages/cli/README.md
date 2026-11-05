# @chainmcp/cli

Developer CLI and server generator for compiling, validating, testing, and serving ChainMcp projects.

## Overview

`@chainmcp/cli` is the command-line interface for the ChainMcp framework:

- **Project Scaffolding:** `chainmcp init` generates production-ready MCP servers from OpenAPI contracts or blank code-first templates.
- **Contract Validation & Diffing:** `chainmcp validate` and `chainmcp diff` check contracts and detect breaking changes.
- **Diagnostics:** `chainmcp doctor` validates environment, configuration, and security posture; `chainmcp config explain` prints resolved configurations with secrets redacted.
- **Development & Serving:** `chainmcp dev`, `chainmcp serve`, and `chainmcp gateway serve` over stdio and Streamable HTTP.
- **Stand-alone Export:** `chainmcp export` creates self-contained, Docker-ready deployment packages.

## Installation

```bash
npm install -g @chainmcp/cli
# or run directly with npx
npx @chainmcp/cli --help
```

## Documentation

Full documentation and API reference are available in the [ChainMcp repository](https://github.com/chrisindark/chain-mcp#readme) and [API Reference](https://github.com/chrisindark/chain-mcp/blob/master/packages/cli/API.md).

## License

Apache-2.0

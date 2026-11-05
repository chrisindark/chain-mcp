# @chainmcp/auth

Inbound MCP authentication verifiers, upstream credential providers, and encrypted secret storage.

## Overview

`@chainmcp/auth` manages authentication across both sides of the MCP boundary:

- **Inbound Verification:** Validates bearer tokens, API keys, and JWTs (HS256, RS256, ES256) with JWKS rotation and strict tenant mapping.
- **OAuth Protected Resource:** Implements RFC 9728 metadata (`/.well-known/oauth-protected-resource`) for remote MCP clients.
- **Upstream Credential Providers:** Pluggable providers for static API keys, basic auth, bearer tokens, and OAuth 2.0 client-credentials grant.
- **Secret Storage:** AES-256-GCM encrypted secret store with authenticated data and key rotation support.

## Installation

```bash
npm install @chainmcp/auth
# or
pnpm add @chainmcp/auth
```

## Documentation

Full documentation and API reference are available in the [ChainMcp repository](https://github.com/chrisindark/chain-mcp#readme) and [API Reference](https://github.com/chrisindark/chain-mcp/blob/master/packages/auth/API.md).

## License

Apache-2.0

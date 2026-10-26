# ChainMcp Dynamic Gateway Example

This example demonstrates deploying a multi-tenant dynamic gateway serving multiple versioned OpenAPI contracts with tenant isolation, Streamable HTTP/SSE transport, and live contract reloading.

## Structure

- `gateway.config.yaml` — Gateway deployment configuration specifying contracts, destinations, and server settings.
- `contracts/customers.yaml` — OpenAPI specification for the `customers` contract (bound to `tenant-crm`).
- `contracts/orders.yaml` — OpenAPI specification for the `orders` contract (bound to `tenant-ecommerce`).
- `src/server.ts` — Gateway entrypoint using `gatewayServeCommand`.
- `Dockerfile` — Production container build with health checks and unprivileged execution.

## Running Locally

```bash
# From workspace root
pnpm --filter @chainmcp/example-gateway build
pnpm --filter @chainmcp/example-gateway start

# Or using the CLI directly
chainmcp gateway serve --config examples/gateway/gateway.config.yaml
```

The gateway serves the Model Context Protocol endpoint at `http://127.0.0.1:3333/mcp` and health checks at `http://127.0.0.1:3333/health`.

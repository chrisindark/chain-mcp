# ChainMcp Examples

This directory contains runnable end-to-end examples demonstrating ChainMcp in action.

---

## 📂 Available Examples

| Directory                         | Type                              | Description                                                                                                                                                    |
| :-------------------------------- | :-------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **[`petstore/`](./petstore)**     | **Contract-First (OpenAPI)**      | Compiles `petstore/openapi.yaml`, validates schemas, binds with `@chainmcp/executor`, and serves tools over stdio with `@chainmcp/server`.                     |
| **[`code-first/`](./code-first)** | **Code-First (TypeScript + Zod)** | Authors custom tools directly in TypeScript using `@chainmcp/authoring` and Zod (`defineTool`), executing through the exact same security and policy pipeline. |

---

## 🚀 Running the Examples

### Step 1: Install & Build

From the repository root:

```bash
pnpm install
pnpm build
```

---

### Step 2: Test with MCP Inspector CLI

The [Model Context Protocol Inspector](https://github.com/modelcontextprotocol/inspector) is the official developer tool to inspect and test MCP servers.

#### Test the OpenAPI Petstore Example:

```bash
# List discoverable tools
npx --yes @modelcontextprotocol/inspector@2.11.0 --cli \
  node examples/petstore/dist/server.js \
  --method tools/list \
  --format json

# Call a tool with valid arguments
npx --yes @modelcontextprotocol/inspector@2.11.0 --cli \
  node examples/petstore/dist/server.js \
  --method tools/call \
  --tool-name getItem \
  --tool-args-json '{"id":"42"}' \
  --format json
```

#### Test the Code-First TypeScript Example:

```bash
# List tools
npx --yes @modelcontextprotocol/inspector@2.11.0 --cli \
  node examples/code-first/dist/server.js \
  --method tools/list \
  --format json

# Call the custom greet tool
npx --yes @modelcontextprotocol/inspector@2.11.0 --cli \
  node examples/code-first/dist/server.js \
  --method tools/call \
  --tool-name greet \
  --tool-args-json '{"name":"Alice","greeting":"Welcome"}' \
  --format json
```

---

## 🤖 Connecting to Claude Desktop or Cursor

You can connect either example directly to **Claude Desktop** or **Cursor** in 30 seconds.

### In Claude Desktop:

Open `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows) and add:

```json
{
  "mcpServers": {
    "chainmcp-petstore": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/chain-mcp/examples/petstore/dist/server.js"]
    },
    "chainmcp-codefirst": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/chain-mcp/examples/code-first/dist/server.js"]
    }
  }
}
```

Restart Claude Desktop. The hammer icon (Tools) will illuminate, and Claude will automatically be able to call `getItem`, `createItem`, or `greet`!

---

## ⚡ Adding Caching & Observability to Examples

### 1. Enabling Redis Caching

To test distributed caching with Redis, start a local Redis server (`redis-server`) and initialize the runtime with `@chainmcp/cache-redis`:

```ts
import { RedisCacheStore } from "@chainmcp/cache-redis";
import { InMemoryToolRuntime } from "@chainmcp/core";

const cacheStore = new RedisCacheStore({
  url: process.env.REDIS_URL ?? "redis://127.0.0.1:6379",
  maxEntryBytes: 256_000,
});

const runtime = new InMemoryToolRuntime({
  cache: {
    store: cacheStore,
    authorizationPartition: (ctx) => ctx.principal?.id ?? "anonymous",
  },
});
```

### 2. Enabling Structured Logging & OpenTelemetry

To stream redacted diagnostic logs and metrics to Datadog or Prometheus:

```ts
import { JsonLogger, OtelMetricsSink } from "@chainmcp/analytics";
import { InMemoryToolRuntime } from "@chainmcp/core";

const runtime = new InMemoryToolRuntime({
  logger: new JsonLogger({ level: "info" }),
  metrics: new OtelMetricsSink(),
});
```

Sensitive headers and credentials will automatically be masked as `[REDACTED]`.

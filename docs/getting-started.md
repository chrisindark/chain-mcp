# Getting started

This guide runs the Milestone 3 end-to-end example: an OpenAPI contract is
compiled into tool metadata, the bounded executor turns those operations into
runtime tools, and an MCP server exposes them over stdio.

The example uses a deterministic in-process upstream. It does not call a real
network service and does not require credentials.

## Prerequisites

- Node.js 22.13 or newer for the packages and example (pnpm 11 imports
  `node:sqlite`; Node.js 20 reached end-of-life in April 2026)
- Node.js 22.19 or newer for the Inspector 2.11 CLI check
- pnpm 11
- No API keys or external services

## Local-clone quick start (clone → build → init → serve → MCP client)

The `@chainmcp/*` packages are not published to a registry yet, so the
supported distribution is the local clone. This is the exact sequence that
the test `packages/cli/tests/quick-start.test.ts` executes in a temp
directory. Every command below is literally what a user copies and pastes.

```bash
# 1. Clone and build the repository
git clone https://github.com/chrisindark/chain-mcp.git
cd chain-mcp
pnpm install
pnpm build

# 2. Generate a standalone server project outside the workspace.
#    --local-deps records the clone root explicitly, writes relative file:
#    dependency specifiers, and adds a pnpm-workspace.yaml override block.
node packages/cli/dist/bin.js init \
  --spec ./examples/petstore/openapi.yaml \
  --output ../my-mcp-server \
  --local-deps "$PWD"

# 3. Install, build, and run the generated server (stdio MCP server)
cd ../my-mcp-server
pnpm install
pnpm build
pnpm start        # stdio MCP server
```

`--local-deps` is required because linked workspace packages declare their
siblings as `workspace:*`, which pnpm cannot resolve outside the monorepo.
Local mode never infers a repository from the current working directory:
pass the clone root with `--local-deps`. Use `--workspace-deps` instead when
the generated project lives inside the monorepo and should keep
`workspace:*`.

### Connect to Claude Desktop

Add the built server to your `claude_desktop_config.json` (absolute paths,
and replace `/Users/you/my-mcp-server` with your generated project's
directory):

```json
{
  "mcpServers": {
    "my-api": {
      "command": "node",
      "args": ["/Users/you/my-mcp-server/dist/server.js"]
    }
  }
}
```

Open Claude Desktop (or Cursor) and your API tools appear automatically in
the tool inventory. `@chainmcp/*` never needs a registry: the generated
project links them from the clone, and the example's upstream is the
deterministic in-process transport described below. The generated project's
third-party dependencies (`zod`, `yaml`, `typescript`, `@types/node`) still
come from npm the first time they are installed, so a fully offline
`pnpm install --offline` requires a warm pnpm store; plain `pnpm install`
works everywhere.

## Inspect the tools

The MCP Inspector CLI is the reference client for this check:

```bash
npx --yes @modelcontextprotocol/inspector@2.11.0 --cli \
  node examples/petstore/dist/server.js \
  --method tools/list \
  --format json
```

The result lists `createItem` and `getItem`. Each tool has an object-root input
schema with `additionalProperties: false` and the constraints declared in
`openapi.yaml`.

## Call a tool

```bash
npx --yes @modelcontextprotocol/inspector@2.11.0 --cli \
  node examples/petstore/dist/server.js \
  --method tools/call \
  --tool-name getItem \
  --tool-args-json '{"id":"42"}' \
  --format json
```

The tool returns:

```json
{ "id": "42", "name": "Demo item 42", "quantity": 3 }
```

Create an item:

```bash
npx --yes @modelcontextprotocol/inspector@2.11.0 --cli \
  node examples/petstore/dist/server.js \
  --method tools/call \
  --tool-name createItem \
  --tool-args-json '{"body":{"name":"Widget","quantity":2}}' \
  --format json
```

The same checks run through `pnpm conformance:inspector` after `pnpm build`.
That script asserts the tool list and both tool calls, and CI runs it in a separate
job with Node.js 22.19.0.

## How the pieces fit

`examples/petstore/src/server.ts` does four things:

1. Reads `openapi.yaml` asynchronously.
2. Calls `compileOpenApi()` and stops on compiler errors.
3. Creates an executor with an exact host allowlist and a pinned resolver, then
   registers the generated `ToolDefinition`s in `InMemoryToolRuntime`.
4. Serves the runtime with `serveStdio()` from `@chainmcp/server`.

The executor receives an injected `UpstreamTransport`. The example transport
returns fixed JSON for `GET /items/{id}` and `POST /items`. In production, omit
the injected transport to use the pinned Node HTTP/HTTPS transport. Keep the
resolver and transport injections only for tests or trusted adapters.

The executor rejects loopback, private, link-local, metadata, multicast, and
reserved destinations even when the hostname is allowlisted. That is why the
example does not start a localhost HTTP server. A real upstream must resolve to
public addresses and use HTTPS unless `allowInsecureHttp` is explicitly enabled.

## What is enforced

The compiled input schemas enforce:

- required properties, enums, and `additionalProperties: false`;
- string `minLength`, `maxLength`, `pattern`, and asserted formats
  (`date-time`, `date`, `time`, `email`, `hostname`, `ipv4`, `ipv6`, `uri`,
  `uuid`);
- numeric `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, and
  `multipleOf`;
- array `minItems`, `maxItems`, and `uniqueItems`;
- object `minProperties` and `maxProperties`.

Other JSON Schema `format` values are annotations and are not asserted.
`oneOf`/`anyOf` input parameters are skipped with a warning and the tool is
kept with its supported parameters. Other unsupported composition (`not` and
conditional keywords) is rejected for tool inputs rather than silently
weakened. The compiler maps response
schemas and authentication policies into metadata, and the executor enforces response
schemas when `server.validateResponses` is `warn` or `enforce`; authentication
policies are not enforced by the compiler. See `docs/openapi-support.md`.

## Next steps

- Read `API_REFERENCE.md` for the compiler, executor, runtime, server, and authoring
  interfaces.
- Read `docs/openapi-support.md` for the supported OpenAPI and JSON Schema
  subset.
- Read `SECURITY.md` and ADR 0018 before pointing the executor at a real
  upstream.

---

## Code-First Authoring Workflow

OpenAPI contracts are the default tool source, but not the only one. ChainMcp provides first-class code-first tool authoring through `@chainmcp/authoring`.

### Scaffolding a Blank Project

To create a new project without an OpenAPI document:

```bash
node packages/cli/dist/bin.js init --blank --name my-server --output ./my-server --local-deps "$PWD"
cd my-server
pnpm install
```

This scaffolds:

- `chainmcp.config.yaml`: Server configuration with no `contract` block required.
- `src/tools.ts`: An example tool authored with `defineTool()` and Zod.
- `src/server.ts`: Stdio server loading your custom tools.
- `package.json`, `tsconfig.json`, `Dockerfile`.

### Defining Tools in Code

Use `defineTool()` to author tools with typed Zod schemas:

```ts
import { defineTool } from "@chainmcp/authoring";
import { z } from "zod";

export const greetTool = defineTool({
  name: "greet",
  description: "Greets a person by name",
  schema: z.object({
    name: z.string().min(1).describe("Name of the person to greet"),
    greeting: z.string().default("Hello").describe("Greeting prefix"),
  }),
  execute: async ({ name, greeting }) => {
    return {
      message: `${greeting}, ${name}!`,
    };
  },
});

export const tools = [greetTool];
```

Manual tools pass through the **exact same** execution pipeline as OpenAPI compiled tools:

- Input arguments are validated against the audited JSON Schema subset.
- Required authorization scopes (`operation.requiredScopes`) are enforced.
- Rate limits and concurrency quotas are applied.
- Response caps and declarative field projections are honored.
- Unhandled errors are masked safely without leaking secrets or stack traces.

### Remote OpenAPI specifications

ChainMcp CLI supports remote specifications via HTTPS URLs with full SSRF protection across all commands:

```bash
# Initialize a project directly from a remote specification
node packages/cli/dist/bin.js init --spec https://api.example.com/openapi.yaml --output ./my-server

# Validate a remote specification and inspect tools with JSON output
node packages/cli/dist/bin.js validate --spec https://api.example.com/openapi.yaml --json

# Build or export a project targeting a remote contract
node packages/cli/dist/bin.js export --spec https://api.example.com/openapi.yaml --output ./dist-server
```

Remote specs are validated against strict SSRF guards: HTTPS is required by default, loopback and private IP ranges are blocked, cloud metadata endpoints are unconditionally forbidden, DNS lookups are pinned to sockets, and responses are streamed with size bounds (10 MiB limit). To target a local loopback spec during development, supply `--allow-http` (or configure `security.allowInsecureHttp: true`).

### Running over HTTP (`node packages/cli/dist/bin.js serve --transport http`)

ChainMcp can also serve tools over modern Streamable HTTP:

```bash
node packages/cli/dist/bin.js serve --transport http --port 3333
```

During local development on loopback (`127.0.0.1` or `localhost`), unauthenticated access is permitted and emits a structured startup warning:

```text
[SECURITY WARNING] HTTP server listening unauthenticated on http://127.0.0.1:3333/mcp (5 tool(s) exposed). Non-loopback binds and production environments must enforce authentication. Set "security.requireInboundAuth: true" and configure tokens, apiKeys, or jwt in "auth.inbound" to secure this server.
```

Non-loopback interfaces (e.g. `--host 0.0.0.0` or public IPs) refuse to start without authentication unless `--allow-unauthenticated-http` (or `security.allowUnauthenticatedHttp: true`) is explicitly provided.

Start the local server over stdio for testing with the MCP Inspector or Claude Desktop:

```bash
node packages/cli/dist/bin.js dev
```

## Code-First Quickstart

You can author and serve Model Context Protocol servers in TypeScript without requiring an OpenAPI specification:

### 1. Scaffold a blank project

```bash
node packages/cli/dist/bin.js init --blank --output ./my-code-server --local-deps "$PWD"
cd ./my-code-server
pnpm install
```

This generates `chainmcp.config.yaml`, `src/server.ts`, and an example tool in `src/tools.ts` using `@chainmcp/authoring` and Zod.

### 2. Define custom tools

In `src/tools.ts`:

```typescript
import { defineTool } from "@chainmcp/authoring";
import { z } from "zod";

export const helloTool = defineTool({
  name: "hello",
  description: "Says hello to a person",
  schema: z.object({
    name: z.string().describe("Person name"),
  }),
  execute: async ({ name }) => ({
    message: `Hello, ${name}!`,
  }),
});

export const tools = [helloTool];
```

### 3. Validate, build, and serve

From a clone without a globally installed CLI, replace each bare `chainmcp`
command with `node packages/cli/dist/bin.js <command>`.

```bash
# Validate project configuration and discover code-first tools
node packages/cli/dist/bin.js validate

# Build deterministic manifest and tool metadata
node packages/cli/dist/bin.js build

# Serve over stdio or Streamable HTTP
node packages/cli/dist/bin.js serve
node packages/cli/dist/bin.js serve --transport http --port 3333

# Export standalone portable server
node packages/cli/dist/bin.js export --output ./exported-server
```

Or run the runnable code-first example:

```bash
npx --yes @modelcontextprotocol/inspector@2.11.0 --cli \
  node examples/code-first/dist/server.js \
  --method tools/list \
  --format json
```

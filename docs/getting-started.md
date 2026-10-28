# Getting started

This guide runs the Milestone 3 end-to-end example: an OpenAPI contract is
compiled into tool metadata, the bounded executor turns those operations into
runtime tools, and an MCP server exposes them over stdio.

The example uses a deterministic in-process upstream. It does not call a real
network service and does not require credentials.

## Prerequisites

- Node.js 20.11 or newer for the packages and example
- Node.js 22.19 or newer for the Inspector 2.11 CLI check
- pnpm 11
- No API keys or external services

## Install and build

From the repository root:

```bash
pnpm install
pnpm build
```

The example lives in `examples/petstore/`. Its contract declares two operations:
`getItem` and `createItem`.

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
Unsupported composition (`oneOf`, `anyOf`, `not`, and conditional keywords) is
rejected for tool inputs rather than silently weakened. Response schemas and
authentication policies are compiled as metadata but are not enforced by the
runtime or executor yet.

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
chainmcp init --blank --name my-server --output ./my-server
cd my-server
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
chainmcp init --spec https://api.example.com/openapi.yaml --output ./my-server

# Validate a remote specification and inspect tools with JSON output
chainmcp validate --spec https://api.example.com/openapi.yaml --json

# Build or export a project targeting a remote contract
chainmcp export --spec https://api.example.com/openapi.yaml --output ./dist-server
```

Remote specs are validated against strict SSRF guards: HTTPS is required by default, loopback and private IP ranges are blocked, cloud metadata endpoints are unconditionally forbidden, DNS lookups are pinned to sockets, and responses are streamed with size bounds (10 MiB limit). To target a local loopback spec during development, supply `--allow-http` (or configure `security.allowInsecureHttp: true`).

### Running over HTTP (`chainmcp serve --transport http`)

ChainMcp can also serve tools over modern Streamable HTTP:

```bash
chainmcp serve --transport http --port 3333
```

During local development on loopback (`127.0.0.1` or `localhost`), unauthenticated access is permitted and emits a structured startup warning:

```text
[SECURITY WARNING] HTTP server listening unauthenticated on http://127.0.0.1:3333/mcp (5 tool(s) exposed). Non-loopback binds and production environments must enforce authentication. Set "security.requireInboundAuth: true" and configure tokens, apiKeys, or jwt in "auth.inbound" to secure this server.
```

Non-loopback interfaces (e.g. `--host 0.0.0.0` or public IPs) refuse to start without authentication unless `--allow-unauthenticated-http` (or `security.allowUnauthenticatedHttp: true`) is explicitly provided.

Start the local server over stdio for testing with the MCP Inspector or Claude Desktop:

```bash
chainmcp dev
```

## Code-First Quickstart

You can author and serve Model Context Protocol servers in TypeScript without requiring an OpenAPI specification:

### 1. Scaffold a blank project

```bash
chainmcp init --blank --output ./my-code-server
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

```bash
# Validate project configuration and discover code-first tools
chainmcp validate

# Build deterministic manifest and tool metadata
chainmcp build

# Serve over stdio or Streamable HTTP
chainmcp serve
chainmcp serve --transport http --port 3333

# Export standalone portable server
chainmcp export --output ./exported-server
```

Or run the runnable code-first example:

```bash
npx --yes @modelcontextprotocol/inspector@2.11.0 --cli \
  node examples/code-first/dist/server.js \
  --method tools/list \
  --format json
```

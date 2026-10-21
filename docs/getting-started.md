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

- Read `API_REFERENCE.md` for the compiler, executor, runtime, and server
  interfaces.
- Read `docs/openapi-support.md` for the supported OpenAPI and JSON Schema
  subset.
- Read `SECURITY.md` and ADR 0018 before pointing the executor at a real
  upstream.

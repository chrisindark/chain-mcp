# Petstore example

A compiled MCP server backed by an in-process mock upstream.

```bash
pnpm build
pnpm --filter @chainmcp/example-petstore start
```

The server speaks MCP over stdio. It is intended to be launched by a client,
not read interactively. From the repository root, use the Inspector commands in
`docs/getting-started.md`.

The mock transport exists only to keep the example deterministic. It
implements the same `UpstreamTransport` boundary as the production pinned
transport, but it does not open a socket.

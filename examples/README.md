# Examples

## Petstore

`petstore/` is the runnable Milestone 3 example. It compiles
`petstore/openapi.yaml`, binds the operations with `@chainmcp/executor`, and
serves the resulting tools over stdio with `@chainmcp/server`.

See `docs/getting-started.md` for setup, Inspector commands, and the exact
security boundary. The example uses an in-process mock upstream because the
production destination policy intentionally rejects loopback and private
addresses.

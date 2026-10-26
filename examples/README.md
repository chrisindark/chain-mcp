# Examples

## Petstore

`petstore/` is the runnable Milestone 3 example. It compiles
`petstore/openapi.yaml`, binds the operations with `@chainmcp/executor`, and
serves the resulting tools over stdio with `@chainmcp/server`.

See `docs/getting-started.md` for setup, Inspector commands, and the exact
security boundary. The example uses an in-process mock upstream because the
production destination policy intentionally rejects loopback and private
addresses.

## Code-First

`code-first/` is the runnable Milestone 8 example. It authors tools in code using
`@chainmcp/authoring` and Zod, and serves them over stdio with `@chainmcp/server`
through the exact same validation, authorization, rate-limiting, and output-policy
runtime pipeline as compiled tools.

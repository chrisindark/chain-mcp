---
name: compiler
description: Instructions for modifying or testing the OpenAPI contract compiler in ChainMcp (converting OpenAPI specs to discoverable MCP tools). Use when working on contract parsing or schema conversion.
---

# Contract Compiler in ChainMcp (`packages/compiler`)

The compiler converts OpenAPI 3.0 / 3.1 specifications into executable MCP tools with validated input schemas and execution bindings.

## 1. Key Components

- `compileOpenApi`: Main entrypoint that parses the contract, traverses paths and methods, and returns structured tool manifests.
- Schema Translation: Maps OpenAPI schemas (including `anyOf`, `allOf`, `enum`, string formats) to standard JSON Schema compatible with MCP clients.
- Parameter Resolution: Maps `path`, `query`, `header`, and `requestBody` parameters into unified tool argument schemas.

## 2. Invariants & Rules

- **Bounded Schemas**: Disallow unbounded recursive references or infinite schemas; enforce maximum depth.
- **Explicit Operations**: Skip operations missing an `operationId` or synthesize a deterministic, clash-free name.
- **Description Truncation**: Format and bound tool descriptions to fit within client LLM context limits without omitting required semantic meaning.

## 3. Verification

- Run compiler test suite: `pnpm --filter @chainmcp/compiler test`
- Verify against sample specs: `node packages/cli/dist/bin.js init --spec ./examples/petstore/openapi.yaml --output /tmp/test-server`

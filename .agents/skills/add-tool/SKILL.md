---
name: add-tool
description: Instructions for authoring declarative and code-first MCP tools in ChainMcp with schema constraints, SSRF protection, and execution bounds. Use when creating or modifying MCP tools.
---

# Authoring Tools in ChainMcp

ChainMcp supports two tool authoring paradigms: **Declarative (HTTP/JSON descriptors)** and **Code-First (TypeScript functions)**. Both run on the shared core runtime.

## 1. Tool Authoring Styles

### A. Declarative Tools (`packages/declarative`)

Declarative tools are defined as serializable descriptors (e.g. JSON/YAML) that bind an HTTP endpoint to an MCP tool.

- Descriptors specify `name`, `description`, `inputSchema`, and `upstream` HTTP config (`url`, `method`, `headers`, `timeoutMs`).
- Never hardcode credentials in descriptors. Use header templates referencing environment variables or runtime auth context.
- Validate input using JSON Schema Draft 7/2020-12 compatible types.

### B. Code-First Tools (`packages/authoring`)

Code-first tools are written directly in TypeScript using the `@chainmcp/core` runtime interfaces:

```ts
import { type Tool, type ToolContext } from "@chainmcp/core";

export const myTool: Tool = {
  name: "my_tool",
  description: "A concise description of what the tool accomplishes.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query string" },
    },
    required: ["query"],
  },
  async execute(args: { query: string }, context: ToolContext) {
    // 1. Observe cancellation signal
    if (context.signal?.aborted) {
      throw new Error("CANCELLED");
    }
    // 2. Bound execution & respect limits
    // 3. Return structured JSON or text response
    return { result: "ok" };
  },
};
```

## 2. Security & Runtime Invariants

- **Never Cache Writes**: By default, GET/read operations may be eligible for caching, but mutations (POST, PUT, DELETE) must never be cached.
- **SSRF Protection**: Upstream URLs must be validated against private IP blocks (127.0.0.1, 10.0.0.0/8, 169.254.169.254, etc.).
- **Signal Teardown**: Always pass `context.signal` to `fetch()` or downstream client calls to enable cooperative cancellation.
- **Secret Redaction**: Do not log authentication tokens or sensitive payload values in telemetry/analytics.

## 3. Verification

- Test tool in isolation: `pnpm --filter @chainmcp/declarative test` or `pnpm --filter @chainmcp/authoring test`
- Run typecheck: `pnpm typecheck`

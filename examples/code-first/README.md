# Code-First Authoring Example

This example demonstrates how to build and serve a Model Context Protocol (MCP) server directly in TypeScript using `@chainmcp/authoring` and Zod, without requiring an OpenAPI contract.

## Overview

- **Authoring Facade:** `defineTool()` with typed Zod schemas lowered and audited at definition time.
- **Shared Runtime:** The same `@chainmcp/core` execution pipeline as OpenAPI compiled tools (validation, authorization, rate limiting, caching, cancellation, output policy).
- **Tools Provided:**
  - `calculate`: Computes basic arithmetic calculations with operation validation.
  - `analyze_text`: Analyzes text for character count, line count, and optional word count.

## Project Structure

```text
examples/code-first/
├── chainmcp.config.yaml   # ChainMcp server configuration (no contract required)
├── package.json           # Dependencies on @chainmcp/authoring, core, server, zod
├── tsconfig.json          # TypeScript compilation settings
├── src/
│   ├── tools.ts           # Hand-written tool definitions via defineTool()
│   └── server.ts          # Server initialization over stdio
└── README.md
```

## Running the Server

### 1. Build TypeScript

```bash
pnpm build
```

### 2. Start Server

```bash
pnpm start
```

### 3. Authoring Loop with ChainMcp CLI

You can also run this example directly with the developer CLI:

```bash
chainmcp dev
```

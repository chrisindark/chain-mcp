# API Reference: @chainmcp/authoring

## `@chainmcp/authoring`

The `@chainmcp/authoring` package provides code-first tool authoring capabilities, schema lowering, and manual tool sources. Tools defined in application code pass through the exact same registration audit, authorization, validation, rate limiting, caching, cancellation, output policy, and error masking pipeline as compiled tools.

### `defineTool`

```ts
export function defineTool<TInput = unknown, TOutput = unknown>(
  options: DefineToolOptions<TInput, TOutput>,
): ToolDefinition<TInput, TOutput>;
```

Defines an MCP tool with definition-time schema lowering and audit. Accepts either a Zod schema (`schema`) or raw JSON Schema (`inputSchema`), and rejects unsupported constructs (unions, recursive lazy schemas, functions) immediately at definition time.

```ts
export interface DefineToolOptions<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  schema?: z.ZodType<TInput>;
  inputSchema?: JsonSchema;
  operation?: OperationPolicy;
  cache?: ToolCachePolicy;
  output?: ToolOutputPolicy;
  contractRevision?: string;
  version?: string;
  ownerTenantId?: string;
  timeoutMs?: number;
  execute(input: TInput, context: ToolContext): Promise<TOutput>;
}
```

### `ManualToolSource`

```ts
export class ManualToolSource implements ToolSource {
  constructor(tools?: readonly ToolDefinition[]);
  addTool(tool: ToolDefinition): this;
  defineTool<TInput = unknown, TOutput = unknown>(
    options: DefineToolOptions<TInput, TOutput>,
  ): ToolDefinition<TInput, TOutput>;
  getTools(): readonly ToolDefinition[];
}

export function createManualToolSource(
  tools?: readonly ToolDefinition[],
): ManualToolSource;
```

Collects hand-written tool definitions and implements `ToolSource` so they can be registered via `runtime.registerSource(source)`.

### `zodToJsonSchema`

```ts
export function zodToJsonSchema(schema: z.ZodTypeAny): JsonSchema;
```

Lowers a Zod schema to the audited JSON Schema subset supported by ChainMcp. Asserts that the root is an object schema, strips metadata keywords (`$schema`, `$id`), and verifies compatibility using `auditInputSchema`.

### `AuthoringError`

```ts
export type AuthoringErrorCode =
  | "SCHEMA_NOT_OBJECT"
  | "SCHEMA_AUDIT_FAILED"
  | "SCHEMA_LOWERING_FAILED"
  | "INVALID_TOOL_DEFINITION";

export class AuthoringError extends Error {
  public readonly code: AuthoringErrorCode;
  public readonly diagnostics?: readonly SchemaDiagnostic[];
}
```

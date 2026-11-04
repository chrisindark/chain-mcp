# API Reference: @chainmcp/declarative

## `@chainmcp/declarative`

`@chainmcp/declarative` validates versioned declarative HTTP tool descriptors
and lowers them into `CompiledOperation` metadata for the bounded executor. It
performs no HTTP itself, evaluates no code, and never stores credentials. See
`docs/declarative-tools.md` and ADR 0028.

### `parseDeclarativeToolDescriptor`

```ts
export function parseDeclarativeToolDescriptor(
  input: unknown,
  options?: { authSchemes?: DeclarativeAuthSchemeMap },
): ParsedDeclarativeTool;

export interface ParsedDeclarativeTool {
  readonly descriptor: DeclarativeToolDescriptor;
  readonly operation: CompiledOperation;
  readonly revision: string; // sha256 over canonical descriptor JSON
}
```

Validates a `descriptorVersion: 1` document and returns the normalized
descriptor, executor operation metadata, and a deterministic revision. The
root schema is closed; unsupported keys, methods, paths, schemas, bindings,
auth references, and policies throw `DeclarativeDescriptorError` with a stable
`code` and `issues` locations.

### `parseDeclarativeToolDescriptorJson`

```ts
export function parseDeclarativeToolDescriptorJson(
  text: string,
  options?: ParseDeclarativeDescriptorOptions,
): ParsedDeclarativeTool;
```

Parses UTF-8 JSON with a 256 KiB (`MAX_DESCRIPTOR_BYTES`) cap before the same
validation. Intended for a future admin API.

### `DeclarativeToolDescriptor` (version 1)

```ts
export interface DeclarativeToolDescriptor {
  descriptorVersion: 1;
  name: string;
  description: string;
  request: {
    method: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
    path: string;
    parameters?: readonly {
      name: string;
      in: "path" | "query" | "header" | "cookie";
      required?: boolean;
    }[];
    body?: { mediaType?: string; required?: boolean };
  };
  inputSchema: JsonSchema;
  authentication?: {
    alternatives: readonly {
      schemes: readonly { name: string; scopes?: readonly string[] }[];
    }[];
  };
  policy?: {
    requiredScopes?: readonly string[];
    cacheTtlSeconds?: number;
    maxOutputTokens?: number;
    outputFields?: FieldSelection;
    timeoutMs?: number;
  };
}
```

`request.path` is relative to the executor option `baseUrl`; absolute URLs are
rejected. Version 1 supports JSON request bodies and JSON responses only.

### `DeclarativeToolSource`

```ts
export class DeclarativeToolSource implements ToolSource {
  constructor(options: DeclarativeToolSourceOptions);
  getTools(): readonly ToolDefinition[];
  getDescriptors(): readonly ParsedDeclarativeTool[];
}

export interface DeclarativeToolSourceOptions {
  descriptors: readonly unknown[];
  executor: UpstreamExecutor;
  authSchemes?: DeclarativeAuthSchemeMap;
}

export function createDeclarativeToolSource(
  options: DeclarativeToolSourceOptions,
): DeclarativeToolSource;
```

Validates every descriptor at construction, rejects duplicate tool names, and
binds each tool to the deployment executor. Generated tools carry the
descriptor revision as `contractRevision` and apply opt-in cache, output, and
timeout policy. Registration through `InMemoryToolRuntime.registerSource()`
still audits the input schema and enforces tenancy.

### Credential scheme map

```ts
export type DeclarativeAuthScheme =
  | {
      type: "apiKey";
      parameterName: string;
      parameterLocation: "query" | "header" | "cookie";
    }
  | { type: "http"; httpScheme: "basic" | "bearer"; bearerFormat?: string }
  | { type: "oauth2" };

export type DeclarativeAuthSchemeMap = Readonly<
  Record<string, DeclarativeAuthScheme>
>;
```

Contains credential shape only. Secrets remain in the executor's
`UpstreamCredentialProvider`. Unreferenced map entries are validated too.

### Errors

```ts
export type DeclarativeDescriptorErrorCode =
  | "DESCRIPTOR_INVALID"
  | "DESCRIPTOR_TOO_LARGE"
  | "DESCRIPTOR_VERSION_UNSUPPORTED"
  | "NAME_INVALID"
  | "NAME_DUPLICATE"
  | "DESCRIPTION_INVALID"
  | "METHOD_UNSUPPORTED"
  | "PATH_INVALID"
  | "PARAMETER_INVALID"
  | "BODY_INVALID"
  | "SCHEMA_INVALID"
  | "BINDING_INVALID"
  | "AUTH_SCHEME_UNKNOWN"
  | "AUTH_SCHEME_INVALID"
  | "POLICY_INVALID"
  | "EXECUTOR_INVALID";

export class DeclarativeDescriptorError extends Error {
  readonly code: DeclarativeDescriptorErrorCode;
  readonly issues: readonly { path: string; message: string }[];
}
```

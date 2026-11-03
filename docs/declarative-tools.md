# Declarative HTTP tools

`@chainmcp/declarative` turns a versioned JSON descriptor into an MCP tool that
runs through the same bounded executor and runtime policy as a compiled OpenAPI
operation. It is the first slice of the post-1.0 builder. The
[declarative admin](./declarative-admin.md) validates, previews, and publishes
descriptor sets through the dynamic gateway; durable persistence is still open.

## Descriptor version 1

```json
{
  "descriptorVersion": 1,
  "name": "get_user",
  "description": "Fetches one user from the directory",
  "request": {
    "method": "GET",
    "path": "/users/{userId}",
    "parameters": [
      { "name": "userId", "in": "path", "required": true },
      { "name": "limit", "in": "query" },
      { "name": "X-Tenant", "in": "header" }
    ]
  },
  "inputSchema": {
    "type": "object",
    "additionalProperties": false,
    "required": ["userId"],
    "properties": {
      "userId": { "type": "string", "minLength": 1 },
      "limit": { "type": "integer", "minimum": 1, "maximum": 100 },
      "X-Tenant": { "type": "string" }
    }
  },
  "authentication": {
    "alternatives": [{ "schemes": [{ "name": "api_key" }] }]
  },
  "policy": {
    "requiredScopes": ["users:read"],
    "cacheTtlSeconds": 60,
    "outputFields": { "include": ["id", "name", "email"] },
    "timeoutMs": 10000
  }
}
```

The request path is always relative to the deployment's configured `baseUrl`.
Absolute URLs are rejected; the executor's exact host allowlist, address
classification, DNS pinning, peer verification, same-host redirect rules,
timeouts, and response caps still apply.

## What version 1 supports

| Field            | Supported                                       | Rules                                                                                                                                                                                                            |
| ---------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `method`         | `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE` | Case-insensitive, normalized to uppercase.                                                                                                                                                                       |
| `path`           | Relative template                               | Starts with a single `/`; no query, fragment, dot segments, empty segments, or control characters; `{name}` placeholders must match path parameters exactly once.                                                |
| `parameters`     | `path`, `query`, `header`, `cookie`             | Each input property binds to exactly one location. Path parameters must be required. Header names must be valid RFC 7230 names and must not be transport-owned (`Authorization`, `Cookie`, `Host`, and similar). |
| `inputSchema`    | Audited JSON Schema subset                      | Object root, `additionalProperties: false`, primitive or array-of-primitive values for parameters. Every property must be bound; every binding must have a property.                                             |
| `request.body`   | JSON only                                       | Bound to the `body` input property. Not allowed for `GET`/`HEAD`. A required body must be listed in the schema `required` list.                                                                                  |
| `authentication` | OR alternatives of AND scheme references        | Scheme names must exist in the deployment scheme map. Scopes are allowed only on `oauth2`. The descriptor never contains credentials.                                                                            |
| `policy`         | Scopes, cache, output, timeout                  | `cacheTtlSeconds` is read-only and capped at 7 days; `timeoutMs` is capped at 120 seconds; output fields use the runtime's include/exclude projection and token budget.                                          |

Unsupported or ambiguous constructs are rejected at load time with a
`DeclarativeDescriptorError` code and issue locations. Nothing is silently
dropped.

## Credential scheme map

The deployment supplies the credential _shape_, never the secret:

```ts
import { createDeclarativeToolSource } from "@chainmcp/declarative";
import { createUpstreamExecutor } from "@chainmcp/executor";

const executor = createUpstreamExecutor({
  baseUrl: "https://api.example.com/v1",
  allowedHosts: ["api.example.com"],
  credentialProvider, // resolves secrets per tenant and scheme name
});

const source = createDeclarativeToolSource({
  executor,
  descriptors: [loadedDescriptor],
  authSchemes: {
    api_key: {
      type: "apiKey",
      parameterName: "X-API-Key",
      parameterLocation: "header",
    },
    oauth: { type: "oauth2" },
  },
});

await runtime.registerSource(source);
```

Secrets continue to come from the executor's `UpstreamCredentialProvider`
(`@chainmcp/auth`). Descriptor JSON cannot name an arbitrary credential header,
and caller arguments cannot override injected credentials.

## Revisions and determinism

Each validated descriptor gets a `sha256:` revision over canonical JSON with
sorted keys and normalized defaults. The revision becomes the tool's
`contractRevision`, so cache keys, traces, and audit records change whenever
the descriptor changes. Two descriptors that differ only in key order or
omitted-vs-default flags share a revision.

## Error handling

`parseDeclarativeToolDescriptor()` and `parseDeclarativeToolDescriptorJson()`
throw a typed error:

```ts
try {
  parseDeclarativeToolDescriptor(input, { authSchemes });
} catch (error) {
  // error.code: DESCRIPTOR_INVALID | PATH_INVALID | SCHEMA_INVALID | ...
  // error.issues: [{ path: "request.parameters[0].name", message }]
}
```

Codes are stable so a future admin surface can return field-level diagnostics.
The JSON entry point also enforces a 256 KiB document cap.

## Security posture

- Descriptors are data. No JavaScript, template expression, `$ref`, remote
  reference, or uploaded code is evaluated.
- No descriptor HTTP path exists outside `@chainmcp/executor` (ADR 0028).
- Absolute URLs, transport-owned headers, and credential values are rejected.
- Output projection, token budgets, response caps, authorization, rate limits,
  and caching are inherited from the shared runtime; a descriptor cannot opt
  out of them.
- Registration audits the input schema again, so validation and registration
  cannot drift.

## Known limitations

- JSON request bodies and JSON responses only. Form and multipart bodies are
  supported by the executor but not exposed by descriptor version 1.
- No response-schema validation; results are bounded but not schema-checked.
- No persistence in this package. `@chainmcp/declarative` is a pure validator
  and lowering layer; durable revisions live in `@chainmcp/admin`'s
  `DescriptorRevisionStore`, and the in-memory descriptor array passed to the
  source remains valid for ephemeral use.
- Descriptor revisions are per tool, not per document collection.
- The source requires a deployment-configured executor; it has no default
  base URL and never synthesizes one.

See `docs/adr/0028-declarative-http-tool-descriptors.md` for the decision and
the remaining roadmap items.

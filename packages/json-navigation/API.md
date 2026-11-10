# API Reference: @chainmcp/json-navigation

## `@chainmcp/json-navigation`

Safe, resource-bounded JSON exploration and schema inspection:

```ts
export function inspectShape(
  data: unknown,
  options?: InspectShapeOptions,
): ShapeSummary;

export function selectPath(
  data: unknown,
  path: string | CompiledPath,
  options?: NavigationLimits,
): unknown;

export function parseJsonPath(path: string): CompiledPath;

export function paginate<T = unknown>(
  data: unknown,
  options?: PaginationOptions,
): PaginatedResult<T>;

export function filterData<T = unknown>(
  data: unknown,
  filter: FilterExpression,
  options?: NavigationLimits,
): T[];

export function createJsonNavigationTools(
  limits?: NavigationLimits,
  handleRegistry?: ResultHandleRegistry | HandleRegistryOptions,
): ToolDefinition[];
```

### Result handles

Large documents can be stored once and referenced by an opaque handle instead of being pasted back inline:

```ts
export const RESULT_HANDLE_EXPIRED: string;

export class ResultHandleExpiredError extends JsonNavigationError {
  readonly code: "RESULT_HANDLE_EXPIRED";
}

export class ResultHandleTooLargeError extends JsonNavigationError {
  readonly code: "RESULT_HANDLE_TOO_LARGE";
}

export interface HandleRegistryOptions {
  blobStore?: BlobPayloadStore;
  storageDriver?: StorageDriver;
  initialCounter?: number;
  maxPerPrincipal?: number; // default 50
  maxPerTenant?: number; // default 250
  maxTotal?: number; // default 1,000
  maxBytes?: number; // default 1,000,000 per document
  maxTotalBytes?: number; // default 8,000,000 across all documents
  ttlMs?: number; // default 600,000 (10 minutes)
  minBytes?: number; // default 0; below this, storeIfLarge returns null
  secret?: string; // per-registry HMAC secret; random when omitted
  now?: () => number;
}

export class ResultHandleRegistry {
  constructor(options?: HandleRegistryOptions);
  readonly size: number;
  readonly totalBytesUsed: number;
  measureBytes(document: unknown): number;
  store(
    document: unknown,
    key: { tenantId: string; principalId: string },
  ): string;
  storeAsync(
    document: unknown,
    key: { tenantId: string; principalId: string },
  ): Promise<string>;
  storeIfLarge(
    document: unknown,
    key: { tenantId: string; principalId: string },
  ): string | null;
  storeIfLargeAsync(
    document: unknown,
    key: { tenantId: string; principalId: string },
  ): Promise<string | null>;
  resolve(
    handle: string,
    key: { tenantId: string; principalId: string },
  ): unknown | Promise<unknown>;
  resolveAsync(
    handle: string,
    key: { tenantId: string; principalId: string },
  ): Promise<unknown>;
}
```

The four navigation tools each accept either the inline `json` argument or a `handle`, plus a fifth tool:

- `json_create_handle`: stores a document server-side and returns `{ handle, bytes }`.

Handles are tenant- and principal-scoped, opacity-preserving (tenant/principal ids are never embedded), TTL'd, and LRU-bounded per principal, per tenant, and in total (with a total-bytes cap). Unknown, expired, evicted, tampered, cross-tenant, or cross-principal handles all fail with the same stable `RESULT_HANDLE_EXPIRED` error, so handle existence does not leak across scopes. Documents above the byte cap throw `ResultHandleTooLargeError` rather than being silently truncated.

### Invariants and Limits

- `NavigationBudget` enforces `maxDepth` (default 16, hard maximum 64), `maxVisitedNodes` (default 50,000), `maxArrayItems` (default 1,000), `maxResultBytes` (default 50,000 bytes), and `timeoutMs` (default 5,000ms).
- Circular references in shapes throw `JsonNavigationError`.
- Prototype pollution targets (`__proto__`, `prototype`, `constructor`) are strictly rejected across all selectors and filters.
- Never evaluates dynamic code (`eval`, `new Function`); all selectors are linear-time AST-evaluated.
- Navigation tools never bypass upstream authorization or projection policies.

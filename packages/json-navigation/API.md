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
): ToolDefinition[];
```

### Invariants and Limits

- `NavigationBudget` enforces `maxDepth` (default 16, hard maximum 64), `maxVisitedNodes` (default 50,000), `maxArrayItems` (default 1,000), `maxResultBytes` (default 50,000 bytes), and `timeoutMs` (default 5,000ms).
- Circular references in shapes throw `JsonNavigationError`.
- Prototype pollution targets (`__proto__`, `prototype`, `constructor`) are strictly rejected across all selectors and filters.
- Never evaluates dynamic code (`eval`, `new Function`); all selectors are linear-time AST-evaluated.
- Navigation tools never bypass upstream authorization or projection policies.

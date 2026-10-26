# JSON Navigation

## 1. Overview

Upstream HTTP APIs frequently return extensive or nested JSON documents (multiple megabytes or dozens of levels deep). Presenting such payloads directly to a language model consumes context windows, triggers token budgets, and risks out-of-memory conditions.

`@chainmcp/json-navigation` provides safe, linear-time, resource-bounded JSON exploration tools and functions. It enables callers and models to inspect document shapes, query targeted paths, paginate arrays, and apply field filters without evaluating untrusted code or exceeding CPU and memory budgets.

## 2. Security and Invariants

1. **Authorization and projection parity:** JSON navigation operates strictly on data the caller has already been authorized to access. It is an exploration layer, not an access-control bypass. If a response is projected or filtered upstream, navigation tools only see the projected result.
2. **No dynamic code evaluation:** Path and filter expressions use deterministic, recursive-descent AST parsers. Expressions never use `eval()`, `new Function()`, or regex backtracking.
3. **Prototype pollution immunity:** Properties named `__proto__`, `prototype`, and `constructor` are strictly blocked across all path expressions, shape inspections, and filters.
4. **Guaranteed resource bounds:** Every operation is metered by a `NavigationBudget` that halts traversal if depth, node visits, array items, output bytes, or execution time exceed configured limits.

## 3. Core Capabilities

### Shape Inspection (`inspectShape`)

Inspects the structural schema, depth, node counts, and key names of a JSON document without expanding every child:

```ts
import { inspectShape } from "@chainmcp/json-navigation";

const summary = inspectShape(largePayload, { maxDepth: 4, maxKeys: 20 });
```

The returned `ShapeSummary` provides:

- `type`: `"object" | "array" | "string" | "number" | "boolean" | "null"`
- `depth`: maximum depth of the visited tree.
- `totalNodes`: count of traversed nodes.
- `byteEstimate`: approximate UTF-8 payload size.
- `keys` & `propertyCount`: available keys for objects.
- `itemCount` & `itemTypes`: length and types for arrays.
- `sampleItemShape`: recursive shape of the first element in an array.
- `truncated`: boolean indicating whether exploration was capped by depth or key limits.

### Path Selection (`selectPath`)

Queries sub-trees using bounded dot-bracket expressions:

```ts
import { selectPath } from "@chainmcp/json-navigation";

// Root and property access
selectPath(data, "$.store.name");
selectPath(data, "store.location.city");

// Array indices (supports negative indices)
selectPath(data, "$.items[0].id");
selectPath(data, "$.items[-1].id");

// Slices
selectPath(data, "$.books[0:5].title");

// Wildcards
selectPath(data, "$.users[*].email");

// Array filter expressions
selectPath(data, "$.books[?(@.price < 30)].title");
selectPath(data, "$.users[?(@.inStock == true)]");
selectPath(data, "$.items[?(@.active)]");
```

### Bounded Pagination (`paginate`)

Paginates arrays or object entries safely:

```ts
import { paginate } from "@chainmcp/json-navigation";

// Array pagination by offset and limit
const page1 = paginate(items, { offset: 0, limit: 25 });
// { items: [...], totalItems: 100, offset: 0, limit: 25, hasMore: true, page: 1, totalPages: 4 }

// Array pagination by page number
const page2 = paginate(items, { page: 2, pageSize: 25 });

// Object entries pagination
const entries = paginate({ a: 1, b: 2, c: 3 }, { limit: 2 });
// { items: [{ key: "a", value: 1 }, { key: "b", value: 2 }], totalItems: 3, hasMore: true }
```

### Declarative Filtering (`filterData`)

Filters array elements using structured predicates:

```ts
import { filterData } from "@chainmcp/json-navigation";

// Simple comparison
const admins = filterData(users, {
  field: "role",
  op: "eq",
  value: "admin",
});

// Composite logic (and / or / not)
const activeAdmins = filterData(users, {
  and: [
    { field: "role", op: "eq", value: "admin" },
    { field: "status", op: "eq", value: "active" },
    { field: "age", op: "gte", value: 21 },
  ],
});
```

Supported operators: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `contains`, `in`, `exists`.

## 4. Resource Limits and Defaults

| Parameter         | Default | Maximum    | Description                                                     |
| :---------------- | :------ | :--------- | :-------------------------------------------------------------- |
| `maxDepth`        | 16      | 64         | Maximum tree traversal depth.                                   |
| `maxVisitedNodes` | 50,000  | 1,000,000  | Total nodes visited before throwing `JsonNavigationLimitError`. |
| `maxArrayItems`   | 1,000   | 10,000     | Maximum items processed or returned in a slice/filter.          |
| `maxResultBytes`  | 50,000  | 10,000,000 | Maximum UTF-8 bytes allowed in the serialized output.           |
| `timeoutMs`       | 5,000   | 60,000     | Execution time deadline in milliseconds.                        |

## 5. MCP Tool Definitions

`createJsonNavigationTools(limits?)` generates four ready-to-register `ToolDefinition`s:

- `json_inspect_shape`: Takes `{ json, maxDepth?, maxKeys? }` and returns the `ShapeSummary`.
- `json_select_path`: Takes `{ json, path }` and returns selected nodes.
- `json_paginate`: Takes `{ json, offset?, limit?, page?, pageSize? }` and returns `PaginatedResult`.
- `json_filter`: Takes `{ json, field, op, value? }` and returns filtered array elements.

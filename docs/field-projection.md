# Field projection

Field projection is the built-in way to apply a declarative allowlist or
denylist to a tool result before it is cached, measured, or returned. It is
opt-in per tool through `ToolDefinition.output.fields` and requires a runtime
projector:

```ts
import {
  createFieldProjector,
  InMemoryToolRuntime,
  type ToolDefinition,
} from "@chainmcp/core";

const runtime = new InMemoryToolRuntime({
  projector: createFieldProjector(),
});

const lookupItem: ToolDefinition = {
  name: "lookup_item",
  description: "Read an item from the catalog",
  inputSchema: {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string" } },
    additionalProperties: false,
  },
  operation: { requiredScopes: ["read"] },
  contractRevision: "catalog-2026-10-21",
  cache: { ttlSeconds: 60 },
  output: {
    fields: {
      include: ["id", "name", "profile.email", "items.id"],
    },
  },
  async execute(input) {
    return upstreamLookup(input);
  },
};
```

`createFieldProjector()` passes through tools without `output.fields`, so it can
be installed once for the runtime. A tool that declares `output` still requires
a projector at registration, even if it has no field rules.

## Include and exclude

Exactly one of `include` or `exclude` must be present.

- `include` keeps only the named paths. Other properties are dropped.
- `exclude` removes the named paths and retains everything else.

Paths are dot-separated object keys:

```
id
profile.email
items.id
items.nested.keep
```

Both selections traverse arrays element-wise. `items.id` means "for every item in
`items`, keep `id`". A path ending at an array (`items`) keeps the whole array
and its elements. Root arrays are supported: `id` selects `id` from every root
element.

Limitations of the path syntax:

- No array indices (`items.0.id`).
- No wildcards, recursive descent, or JSONPath expressions.
- No escaping; a key that contains a dot cannot be selected as one segment.
- No renames, computed fields, or default values.
- `__proto__`, `prototype`, and `constructor` segments are rejected.

## Missing fields and array elements

Missing paths are ignored. Under `include`, an object with no matching paths
becomes `{}`. Array elements that cannot match the remaining path — primitives,
`null`, and non-plain objects — become `null`, preserving array positions rather
than changing indices. Plain objects and arrays are traversed; a `Date`, `Map`,
class instance, or other non-plain object is not projected as data.

Under `exclude`, unmatched values are returned as-is, and only branches on a
selected path are cloned. If an exclude path reaches a non-plain object, the
call fails with `OUTPUT_POLICY_VIOLATION` rather than retrying an unknown value
shape. Neither mode mutates the original result.

```ts
project({ include: ["id"] }, { id: "a", secret: "x" });
// { id: "a" }

project({ exclude: ["secret"] }, { id: "a", secret: "x" });
// { id: "a" }
```

## Validation

Registration rejects an invalid selection with `CONTRACT_INVALID`:

- `fields` must be an object with exactly one of `include` or `exclude`.
- The path list must be non-empty, with at most 64 unique paths.
- Each path is at most 256 characters and 16 dot-separated segments.
- Empty segments, surrounding whitespace, control characters, and the
  dangerous segments above are rejected.
- Unknown keys on the selection object are rejected.

The built-in projector revalidates the selection at call time in case trusted
code mutates the tool definition after registration. A selection that becomes
invalid fails the call rather than falling back to the raw result.

## Bounds

Projection is bounded before the runtime's JSON serialization and cache write:

- maximum projection depth: 64 levels;
- maximum visited nodes: 50,000;
- at most 64 paths, each at most 16 segments.

Exceeding a limit throws `FieldSelectionError`, which the runtime maps to
`OUTPUT_POLICY_VIOLATION`. Limits fail the call rather than truncating a result
silently. A JSON value that is too deep to project cannot be served through a
declarative policy.

## Caching and policy changes

Projection runs after execution and before the cache write. The cached value is
the projection, so a hit cannot expose fields removed by the projector. The
built-in projector is not re-run on a hit because the entry was already
projected.

Projection policy is not part of the cache key. If you change `output.fields`,
the projector, or a budget for a tool using a shared/persistent store, rotate
the cache namespace or bump `contractRevision`; otherwise old projections can be
served until they expire. If a field selection varies with caller attributes
beyond tenant, principal, and the authorization partition, include those
attributes in the partition or bypass caching.

## Security notes

- Projection is output policy, not authorization. It runs only after
  authorization and must not be used to grant access the authorizer denied.
- `include` is the safer default for sensitive upstream objects: it starts from
  an empty object and adds only approved paths.
- Rejecting `__proto__`, `prototype`, and `constructor` prevents prototype
  pollution through path traversal. Untouched input keys are copied with
  `Object.defineProperty`, so an own `__proto__` key remains data rather than
  changing a prototype.
- The projector receives the full raw result. Keep it in-process and do not log
  raw payloads or field values.
- A deployment-supplied custom projector can ignore `output.fields`. Use the
  built-in projector for declarative policy, and test custom projectors against
  unauthorized callers.

## Custom projectors

`ResultProjector` remains the extension point for computed transforms, renames,
or policy engines. A custom projector receives `{ tool, context, result }` and
must return the final value synchronously. If it wants to honor declarative
field rules, call `createFieldProjector()` or apply the selection itself; the
runtime cannot verify a custom projector's semantics.

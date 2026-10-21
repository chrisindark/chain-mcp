# ADR 0013 — Declarative field projection

- Status: proposed
- Recorded: 2026-10-21

## Context and problem

ADR 0012 introduced a deployment-supplied `ResultProjector` and required
projection before caching or measurement. That is sufficient as an extension
point, but the most common output policy is mechanical: keep approved fields or
remove sensitive ones. Asking every deployment to write and test a recursive
projector for that case invites inconsistent implementations and security bugs.

A declarative field selector needs to answer several questions safely:

- **Path semantics.** Dots in key names, arrays, root arrays, and missing fields
  are ambiguous unless the grammar is explicit.
- **Failure behavior.** A selector that silently returns the raw object after a
  path error violates output policy.
- **Bounds.** Upstream JSON can be deep, cyclic, or enormous; projection must not
  become an unbounded traversal or recursion path.
- **Prototype safety.** Copying arbitrary JSON keys through normal assignment can
  trigger `__proto__` setters.
- **Custom policy.** Some deployments need computed transforms, renames, or
  policy-engine calls; a field selector must not replace that extension point.

## Decision

1. **Opt-in declarative rules on the tool.** `ToolOutputPolicy.fields` accepts
   exactly one of `include` or `exclude`; both or neither is a registration
   error. Tools without `fields` pass through the built-in projector unchanged.
2. **A built-in projector factory.** `createFieldProjector()` returns a
   `ResultProjector` that reads `tool.output.fields`, validates it again at call
   time, and applies it. It can be installed runtime-wide; it does nothing for
   tools without field rules.
3. **Dot-separated object keys, arrays traversed element-wise.** `items.id`
   applies to every element of `items`; `id` applies to every element of a root
   array. Paths cannot contain empty segments, surrounding whitespace, control
   characters, array indices, wildcards, escapes, or dangerous prototype
   segments (`__proto__`, `prototype`, `constructor`). Keys containing dots
   cannot be selected as a single segment.
4. **Include and exclude have different construction rules.**
   - `include` builds a new value from plain JSON objects and arrays, keeping
     only selected paths. Missing fields are omitted. Array elements that do not
     match the remaining path, including primitives and non-plain objects,
     become `null` so positions do not shift.
   - `exclude` removes selected paths and retains everything else. It clones
     only modified branches and never mutates the source. A selected path that
     reaches a non-plain object fails closed.
5. **Registration validates; runtime revalidates.** Limits are 64 paths, 16
   segments and 256 characters per path, 64 projection levels, and 50,000
   visited nodes. Invalid rules fail registration with `CONTRACT_INVALID`.
   Mutated rules fail projection with `OUTPUT_POLICY_VIOLATION`.
6. **Prototype-safe copying.** Output objects are plain objects whose keys are
   assigned with `Object.defineProperty`, so an own `__proto__` key from input
   stays data. Dangerous segments cannot be selected or excluded, but untouched
   input keys are still copied safely.
7. **Custom projectors remain.** A custom `ResultProjector` can read and honor
   `output.fields`, but the runtime cannot verify that it does. The built-in
   projector is the supported way to claim declarative enforcement.
8. **No implicit default policy.** Installing `createFieldProjector()` does not
   remove fields unless a tool declares `fields`. A generic denylist remains
   rejected for the reasons in ADR 0012.

## Alternatives considered

- **Require a custom projector for every field policy.** Rejected: repetitive,
  easy to get wrong, and difficult to test uniformly across deployments.
- **Adopt full JSONPath or a JSON-navigation dependency.** Rejected for this
  milestone: more grammar, more edge cases, and more denial-of-service surface
  than an allowlist/denylist needs.
- **Support array indices and wildcards.** Rejected for now: transparent array
  traversal covers the common case, and explicit indices make policies brittle
  when upstream ordering changes.
- **Mutate the raw result in place.** Rejected: the raw result may be shared with
  logging or cache paths, and mutation makes failures harder to reason about.
- **Drop non-matching array elements under include.** Rejected: changing array
  length silently corrupts pagination and positional data. `null` preserves the
  shape without exposing the value.
- **Allow `__proto__`, `prototype`, and `constructor` segments.** Rejected:
  traversal and copying would create prototype-pollution paths for no practical
  benefit.
- **Validate only at registration.** Rejected: trusted code can mutate a tool
  definition after registration; the cost of revalidation is bounded.
- **Apply projection on cache read instead of write.** Rejected in ADR 0012: the
  raw value would be stored and could escape through another reader.

## Consequences and trade-offs

- Field selection cannot express renames, computed fields, defaults, array
  indices, or keys containing dots. Deployments needing those must use a custom
  projector.
- `include` can return `{}` or `null` placeholders. Callers should treat those as
  policy-shaped output, not as an upstream error.
- `exclude` may return the original object reference when no path matches.
  Callers cannot observe mutation because the runtime does not mutate it, but
  the value is not a deep clone.
- Projection adds a traversal on every opted-in call. Bounds prevent unbounded
  work but do not make a 50,000-node traversal free.
- Exclude policies can fail on non-plain objects that a custom projector might
  have handled; this is intentional fail-closed behavior.
- Changing `fields` does not change the cache key. Shared caches still require a
  namespace rotation or `contractRevision` bump (ADR 0012).

## Security implications

- `include` is the safer default for sensitive upstream objects. `exclude`
  protects only named paths and continues to expose new upstream fields.
- Dangerous path segments and prototype-safe copying close the obvious JSON
  prototype-pollution route.
- Projection remains output policy, not authorization. It runs after
  authorization and cannot grant access.
- Error messages name the tool and the policy problem, not field values or raw
  payloads.
- Custom projectors can ignore `fields`; deployments must not treat a declared
  selection as enforced unless the built-in projector is installed.

## Follow-up actions

- SEC-05: define contract-level field policies and tests for generated tools.
- Consider explicit array-index or key-escaping syntax only if real contracts
  require it.
- Add a shared serialization path across projection, measurement, caching, and
  transport.
- Consider compiled selection caching keyed by immutable tool definitions if
  profiling shows per-call trie building matters.

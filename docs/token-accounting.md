# Token accounting

ChainMcp records how many tokens a tool result costs when it is presented to a
model. Measurement, per-tool token budgets, and a bounded declarative field
projector are implemented; deployments can also supply a custom projector. This
page covers the measurement contract, how budgets interact with projection and
caching, and how to read the numbers without overstating them.

## What is measured

The runtime serializes the result with `JSON.stringify(result)` — the same text
the MCP adapter returns to the client — and passes that string to the configured
`Tokenizer`:

```ts
export interface Tokenizer {
  id: string;
  measurement: "exact" | "estimate";
  count(text: string): number;
}
```

Each successful invocation then records:

```ts
tokenUsage?: {
  count: number;
  measurement: "exact" | "estimate";
  tokenizer: string;
  payloadBytes: number;
};
```

`payloadBytes` is the UTF-8 size of the serialized result. The token count is
always over the serialized text, not the raw upstream response: a string result
includes its JSON quotes and escapes, because that is what the model receives.

## Configuring a tokenizer

No model-specific tokenizer is bundled. A generic character heuristic is not a
faithful count for a specific model, so exact deployments supply an adapter that
matches the model they target. The `tokenMetrics.tokenizer` setting selects one
of three modes:

| Mode          | Behavior                                                                           |
| ------------- | ---------------------------------------------------------------------------------- |
| `approximate` | Built-in character ratio (`charactersPerToken`, default 4); always `estimate`.     |
| `exact`       | Requires `tokenMetrics.module` or a registered factory; startup fails without one. |
| `none`        | Measurement is disabled.                                                           |

### Exact measurement from a module

CLI servers, generated servers, and dynamic gateways can load an exact adapter
from a module:

```yaml
tokenMetrics:
  enabled: true
  tokenizer: exact
  modelId: gpt-4o
  module: ./tokenizer.mjs
```

Relative module paths are resolved from the directory containing the
configuration file. The module must export a `createTokenizer(config)` function
(named or default). It may be `async`; the returned adapter's `count` must remain
synchronous:

```js
import { encodingForModel } from "your-tokenizer-library";

const encoding = encodingForModel("gpt-4o");

export function createTokenizer(config) {
  return {
    id: config.modelId,
    measurement: "exact",
    count: (text) => encoding.encode(text).length,
  };
}
```

The loader fails startup when exact measurement has no source
(`TOKENIZER_SOURCE_REQUIRED`), when the module cannot be imported or does not
export a factory (`TOKENIZER_MODULE_INVALID`), or when the returned adapter is
invalid (`TOKENIZER_INVALID`). An exact configuration also requires the adapter's
`id` to equal `tokenMetrics.modelId` and its `measurement` to be `"exact"`; an
adapter that declares `"estimate"` is rejected rather than relabeled.

### Exact measurement from a registered factory

Embedding code can register a factory instead of using a module:

```ts
import {
  buildRuntimeOptions,
  loadTokenizerFromConfig,
  registerTokenizerFactory,
} from "@chainmcp/config";
import { InMemoryToolRuntime, type Tokenizer } from "@chainmcp/core";

const tokenizer: Tokenizer = {
  id: "gpt-4o",
  measurement: "exact", // Only if this encoding is what the model uses.
  count: (text) => encoding.encode(text).length,
};

registerTokenizerFactory("gpt-4o", () => tokenizer);

const tokenizerFromConfig = await loadTokenizerFromConfig(config.tokenMetrics, {
  baseDir: configDir,
});
const runtime = new InMemoryToolRuntime(
  buildRuntimeOptions(config, { tokenizer: tokenizerFromConfig }),
);
```

`buildRuntimeOptions()` is synchronous and cannot import modules. When
`tokenMetrics.tokenizer: exact` is configured, it throws
`TOKENIZER_SOURCE_REQUIRED` unless the loaded tokenizer is passed through
`RuntimeOptions.tokenizer`. The CLI, gateway, and generated server load the
tokenizer once and pass that same instance to the runtime, so budget checks and
`tokenUsage` events use one adapter.

If the available counter is approximate, use `tokenizer: approximate` or an
adapter declaring `measurement: "estimate"`. The runtime records the declaration
verbatim and never upgrades it to `exact`. Module code runs in-process and is
trusted like the rest of the configuration; do not load untrusted modules.

## Exact versus estimated

- `exact` means the adapter's count is authoritative for the `id` recorded on
  the event, including any special tokens the model actually bills.
- `estimate` means the number is an approximation. It is useful for trends and
  coarse budgets, not for billing or precise limits.
- Changing the adapter or model changes the meaning of historical counts. Keep
  `tokenizer` alongside numbers in any dashboard.
- Do not compare exact and estimated counts as if they came from the same
  measurement.

The runtime rejects an adapter whose `id` is blank, whose `measurement` is not
`exact` or `estimate`, or whose `count` is not a function. It also rejects
counts that are negative, fractional, `NaN`, infinite, or beyond
`Number.MAX_SAFE_INTEGER` at measurement time; the event then omits
`tokenUsage`.

## When measurement runs

| Situation                                          | Result                                              |
| -------------------------------------------------- | --------------------------------------------------- |
| Successful call with a tokenizer                   | `tokenUsage` recorded.                              |
| Successful call served from cache                  | `tokenUsage` recorded; `cacheOutcome` is `hit`.     |
| No tokenizer configured                            | No `tokenUsage` field.                              |
| Tool or validation error                           | No measurement.                                     |
| Result is `undefined`, cyclic, or has no JSON form | No measurement; succeeds unless projection opts in. |
| Tokenizer throws or returns an invalid count       | No measurement; succeeds unless a budget needs it.  |

Measurement runs on every successful call, including cache hits, so token totals
cover both executed and cached responses. The tokenizer runs synchronously and
in-process. For a tool without a budget, it runs after execution and any
eligible cache write. For a tool with `output.maxTokens`, projection and the
budget count run before the cache write; that same count is recorded as
`tokenUsage` for the event. Either way the recorded count describes exactly what
was stored and returned. A remote counter must be fronted by a local adapter;
the runtime does not perform network I/O for measurement.

When a tool has no budget, measurement is observability and must never change a
result. A failing tokenizer, an unserializable result, or an invalid count omits
`tokenUsage` rather than failing the call or substituting a guess.

## Projection and budgets

A tool opts into output policy with `output`. The runtime must have a
`ResultProjector` from `RuntimeOptions.projector`; otherwise registration fails
with `CONTRACT_INVALID`. Projection runs after execution and before caching or
measurement, and its result must be JSON-serializable. The raw result is never
returned as a fallback when projection fails.

`output.maxTokens` turns the token count into an enforced budget:

```ts
const lookupItem: ToolDefinition = {
  // ...
  output: { maxTokens: 800 },
  async execute(input) {
    return { id: "a", name: "Example" };
  },
};

const runtime = new InMemoryToolRuntime({
  projector: {
    project({ result }) {
      // Deployment policy: remove fields this caller must not see.
      return result;
    },
  },
  tokenizer, // required for maxTokens
});
```

The runtime projects, serializes the projection, and counts it. A valid count at
or below `maxTokens` is recorded as `tokenUsage` and the projected value is
cached and returned. A count above the budget fails with
`OUTPUT_LIMIT_EXCEEDED`. A tokenizer that throws or returns an invalid count
fails with `OUTPUT_POLICY_VIOLATION`, because the budget cannot be verified.
Both failures happen before the cache write, so the cache never holds an
over-budget value, and neither failure includes the raw result in the error.

Budgets are expressed in the adapter's token units. With an `estimate` adapter
the enforcement point is only as precise as the estimate; the event still labels
it `estimate`. A cache hit is not re-projected or re-budgeted: the stored value
was projected and checked when written. Changing a projector or budget does not
change the cache key, so rotate the namespace or bump `contractRevision` when a
shared cache could still hold entries from the old policy.

## Reading the numbers

`tokenUsage` is per invocation. Aggregate by `tokenizer`, `measurement`,
`tenantId`, and `toolName` before computing averages or budgets. A token metric
without its measurement label is ambiguous and should be treated as invalid.

Cache hits and misses both carry counts, so do not add cache-hit savings to
token totals as if cached responses were free; the cost of presenting a cached
response to the model is exactly what `tokenUsage` measures. Cost saved by
caching comes from skipping upstream execution and any upstream billing, not
from model tokens disappearing.

Estimated counts must not be presented as exact in dashboards, reports, or
customer-facing claims. Do not promise savings against an estimated baseline
unless the baseline and measurement method are documented.

## Not implemented yet

- A general JSON-navigation or query language. `createFieldProjector()` supports
  bounded include/exclude paths but not renames, computed fields, or array
  indices.
- Per-content-block measurement (the current count covers the whole serialized
  result).
- Async or remote tokenizers.
- Bundled tokenizer implementations and model-specific defaults.
- Aggregated dashboards, exporters, and retention rules for token telemetry.
- Measurement of error messages, prompts, or tool metadata.
- Sharing one serialization between projection, measurement, and the transport,
  which currently each serialize separately.

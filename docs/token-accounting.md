# Token accounting

ChainMcp records how many tokens a tool result costs when it is presented to a
model. Measurement is implemented; token budgeting and response projection are
not. This page covers the measurement contract and how to read the numbers
without overstating them.

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

No tokenizer is bundled. A generic character heuristic is not a faithful count
for a specific model, so deployments supply an adapter that matches the model
they target:

```ts
import { InMemoryToolRuntime, type Tokenizer } from "@chainmcp/core";
import { encodingForModel } from "your-tokenizer-library";

const encoding = encodingForModel("gpt-4o");

const tokenizer: Tokenizer = {
  id: "gpt-4o",
  measurement: "exact", // Only if this encoding is what the model uses.
  count: (text) => encoding.encode(text).length,
};

const runtime = new InMemoryToolRuntime({
  tokenizer,
  metrics: sink,
});
```

If the available counter is approximate, set `measurement: "estimate"`. The
runtime records the declaration verbatim and never upgrades it to `exact`.

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

| Situation                                          | Result                                          |
| -------------------------------------------------- | ----------------------------------------------- |
| Successful call with a tokenizer                   | `tokenUsage` recorded.                          |
| Successful call served from cache                  | `tokenUsage` recorded; `cacheOutcome` is `hit`. |
| No tokenizer configured                            | No `tokenUsage` field.                          |
| Tool or validation error                           | No measurement.                                 |
| Result is `undefined`, cyclic, or has no JSON form | No measurement; the call still succeeds.        |
| Tokenizer throws or returns an invalid count       | No measurement; the call still succeeds.        |

Measurement runs on every successful call, including cache hits, so token totals
cover both executed and cached responses. The tokenizer runs synchronously,
in-process, after the result is produced (and after an eligible cache write). A
remote counter must be fronted by a local adapter; the runtime does not perform
network I/O for measurement.

Measurement is observability and must never change a result. A failing
tokenizer, an unserializable result, or an invalid count omits `tokenUsage`
rather than failing the call or substituting a guess.

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

- Token-budgeted projection of tool results.
- Output-level policy enforcement on the projected result (SEC-05).
- Per-content-block measurement (the current count covers the whole serialized
  result).
- Async or remote tokenizers.
- Bundled tokenizer implementations and model-specific defaults.
- Aggregated dashboards, exporters, and retention rules for token telemetry.
- Measurement of error messages, prompts, or tool metadata.

When projection lands, it must run before the result is cached or measured so
that counts and cached values reflect what the model actually receives.

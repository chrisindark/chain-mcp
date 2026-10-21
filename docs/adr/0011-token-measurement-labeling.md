# ADR 0011 — Token measurement labeling and tokenizer adapters

- Status: proposed
- Recorded: 2026-10-20

## Context and problem

Milestone 4 requires token accounting, and the roadmap exit criterion requires
accurate labeling of token measurements. Token counts are model-specific and
easy to fake: a character heuristic presented as a count is misleading, and a
hardcoded vendor tokenizer becomes wrong when the deployment targets a different
model. The runtime also has no output projection yet, so it can only measure
what the tool returned, not a budgeted variant.

Open questions:

- **Who owns tokenization?** Core cannot bundle every model's tokenizer and
  should not depend on a vendor SDK for a generic runtime.
- **How are estimates distinguished from exact counts?** A number alone loses
  the distinction once it reaches telemetry.
- **What exactly is measured?** Upstream payloads, internal objects, and the
  text presented to the client can differ.
- **What happens when counting fails?** Measurement must not become an
  availability dependency.
- **Are cache hits measured?** Cached responses still consume model tokens.

## Decision

1. **An optional synchronous `Tokenizer` adapter.** It exposes a stable `id`, a
   `measurement` of `exact` or `estimate`, and `count(text)`. The runtime
   validates the id as non-empty, the mode as one of the two values, and the
   returned count as a non-negative safe integer.
2. **Measure the presented result.** The runtime counts tokens over
   `JSON.stringify(result)`, the same text the MCP adapter sends, and records
   the UTF-8 `payloadBytes` of that string. It does not count the raw upstream
   response or an internal object graph.
3. **Record the label with the count.** Successful invocations emit
   `tokenUsage: { count, measurement, tokenizer, payloadBytes }` on the
   `tool_invocation` event. The runtime records the adapter's declaration
   verbatim and never relabels an estimate as exact.
4. **Bundle no tokenizer.** Deployments supply an adapter that matches their
   model. A heuristic is allowed only with `measurement: "estimate"`.
5. **Fail soft on measurement.** An unserializable result (`undefined`, cycles,
   `BigInt`), a throwing adapter, or an invalid count omits `tokenUsage` and
   does not change the result or its cache behavior.
6. **Measure every successful call, including cache hits.** Token usage is a
   property of presenting the result, not of executing the tool. The same event
   carries `cacheOutcome`, so token and cache data correlate without extra
   events.
7. **Synchronous and in-process.** The adapter runs on the request path without
   network I/O. A remote counter must be wrapped by a local adapter. This keeps
   cancellation, timeout, and latency behavior unchanged.
8. **Measurement only in this milestone.** Budgets, projection, and enforcement
   are separate roadmap items. Counts are telemetry, not a control.

## Alternatives considered

- **Bundle a widely used tokenizer (for example `tiktoken`).** Rejected for
  now: it adds a model- and version-specific dependency to a runtime that serves
  arbitrary contracts, and it still cannot guarantee the target model's exact
  tokenization.
- **Use `characters / 4` as the default.** Rejected: it is an estimate that
  looks exact. Shipping it as the default would invite false precision.
- **Record only a number.** Rejected: without the measurement mode and tokenizer
  id, consumers cannot tell exact from estimated or compare across models.
- **Count the raw upstream body or the internal result object.** Rejected: the
  model consumes the serialized text, which includes encoding overhead and
  excludes fields a transport might drop.
- **Throw when measurement fails.** Rejected: token accounting is optional
  observability. It must not fail calls or create an outage path.
- **Only measure cache misses.** Rejected: cached responses still consume model
  tokens; omitting them understates cost and skews cache-hit comparisons.
- **Async or remote tokenizers.** Rejected for this milestone: they add network
  I/O and a new timeout/failure mode to the request path.

## Consequences and trade-offs

- Correctness depends on the deployment choosing an adapter that matches its
  model. The runtime can enforce the presence of a label, not its truth.
- Historical counts are not comparable across tokenizer ids or modes; exporters
  must group by both.
- Every successful call serializes its result once more for measurement. Results
  are already serialized by the MCP adapter; this is duplicate work, accepted
  until measurement and transport serialization share a path.
- Measurement is not applied to errors, `undefined` results, or unserializable
  results, so totals exclude those responses rather than estimating them.
- Budget enforcement cannot be built on estimates alone. When budgeting lands,
  estimates must be labeled in limits and UI, and exact adapters should be
  preferred for enforcement.
- Projection is not implemented, so measured counts may later decrease when
  projection is introduced. Baselines must record whether projection applied;
  the current event does not yet carry that flag.

## Security implications

- The tokenizer receives the full serialized result, which may contain sensitive
  data. It must run in-process or inside a trusted boundary; do not send payloads
  to a third party for counting.
- Telemetry contains counts, ids, and byte sizes only — never payload text,
  keys, or arguments. Counts can still reveal rough response size, so protect
  telemetry accordingly.
- A hostile or buggy adapter cannot alter results: exceptions and invalid counts
  are ignored. It can still consume CPU on the request path, so adapters must be
  local and bounded.
- Token labels must not be used to weaken output policy later. Budgeted
  projection must enforce policy before caching or returning a result.

## Follow-up actions

- Token-budgeted projection and output-level policy enforcement (M4, SEC-05).
- Share serialization between measurement and the MCP adapter to avoid duplicate
  work.
- Add model-specific adapter examples and a supported-tokenizer matrix.
- Export aggregated token and cache metrics once the analytics milestone defines
  sinks and retention.
- Decide whether error responses need measurement once error projection is
  bounded.

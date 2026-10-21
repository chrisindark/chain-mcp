# ADR 0012 — Output projection and token budgets

- Status: proposed
- Recorded: 2026-10-21

## Context and problem

Milestone 4 caches results and measures tokens, but until now the runtime
returned whatever a tool produced. That leaves two gaps:

- **Output policy (SEC-05).** Authorization decides whether a caller may invoke
  a tool; it does not decide which fields the caller may see. A tool can
  legitimately read a broad upstream object and still need to hide fields such
  as internal notes, billing data, or another principal's identifiers.
- **Token budgeting.** Measurement without a limit cannot stop an oversized
  result from consuming the model's context or pushing a response past the
  transport cap.

The ordering is security-relevant. If projection is applied only when reading
from a cache, the raw value is still written; a compromised or misconfigured
store, a later policy change, or another reader can then observe unprojected
data. If the budget is checked after caching, an over-budget value is retained
and may be served later. If projection is optional, a tool that forgot to opt in
silently bypasses output policy.

## Decision

1. **Projection is a deployment-supplied, synchronous adapter.**
   `ResultProjector.project({ tool, context, result })` returns the exact value
   the caller and model may receive. The runtime does not implement a field
   policy or guess which fields are safe.
2. **Per-tool opt-in, registration-time enforcement.** `ToolDefinition.output`
   opts a tool in; `maxTokens` is optional. A declared output policy without a
   configured projector, or a budget without a tokenizer, is rejected at
   registration with `CONTRACT_INVALID`. The runtime does not silently ignore a
   policy it cannot enforce.
3. **Projection runs before the cache write and before measurement.**
   Execution → projection → budget → cache write → measurement → return. The
   cache stores only the projected value, and the recorded token usage describes
   that value.
4. **Projected output must have a JSON representation.** `undefined`, cyclic
   values, `BigInt`, thenables, and serializer failures fail closed with
   `OUTPUT_POLICY_VIOLATION`. The raw result is never a fallback, and a failed
   projection is never cached. A typed `RuntimeError` thrown by the projector is
   preserved; any other throw becomes `OUTPUT_POLICY_VIOLATION` with the cause
   retained for protected diagnostics. Thenables are rejected explicitly because
   `JSON.stringify` would otherwise serialize an `async` projector's Promise as
   `{}` and silently return a wrong value.
5. **Budgets are enforced on the serialized projection.** The runtime serializes
   the projected value and calls the configured tokenizer once. A count above
   `maxTokens` fails with `OUTPUT_LIMIT_EXCEEDED`. A tokenizer that throws, or
   returns a negative, fractional, non-finite, or unsafe count, fails with
   `OUTPUT_POLICY_VIOLATION` because the budget cannot be verified. The valid
   count is recorded as `tokenUsage` with the adapter's exact/estimate label.
6. **Hits skip projection and budgeting.** The entry was projected and checked
   when written, so it is already the value the caller may see. Re-running
   projection on a hit would make cache behavior depend on a mutable policy and
   could produce a different value than was stored.
7. **Projection policy is not part of the cache key.** The key already binds the
   contract revision, tool, caller, partition, and arguments. Deployments
   changing a projector, budget, or `output` declaration on a shared or
   persistent store must rotate the namespace or bump `contractRevision`;
   otherwise entries written under the old policy can be served until expiry.
8. **Synchronous and in-process.** Projection and counting run on the request
   path without network I/O, matching the tokenizer decision in ADR 0011.

## Alternatives considered

- **Project at read time only.** Rejected: the raw result would be cached,
  violating the requirement that cached entries contain only projected output,
  and a shared store could expose it.
- **Cache both raw and projected variants.** Rejected: the raw variant is
  exactly the data output policy is meant to contain; keeping it increases the
  blast radius of a store compromise.
- **Make `output` optional and skip projection when no projector is configured.**
  Rejected: a policy declaration that silently does nothing is worse than a
  startup error. The same reasoning applies to a budget without a tokenizer.
- **Ship a default projector that strips known sensitive keys.** Rejected for
  now: field sensitivity is contract- and caller-specific, and a generic
  denylist invites false confidence. JSON navigation and declarative selection
  are a later milestone.
- **Check the budget on the raw result.** Rejected: projection can shrink or
  expand the payload; the model receives the projection, so that is what must be
  bounded.
- **Cache first, then project and check the budget.** Rejected: an over-budget
  or unprojected value would be retained and potentially served on a later hit.
- **Allow `undefined` projections as empty responses.** Rejected: transports
  cannot consistently represent them, and it hides projector bugs. Fail closed.
- **Require an exact tokenizer for every budget.** Tempting, but it would make
  budgets unusable in deployments that only have an approximation. Estimates are
  allowed and labeled; enforcement is only as precise as the adapter. Exact
  adapters remain recommended for hard limits.
- **Async or remote projection/counting.** Rejected for this milestone: it adds
  network I/O, timeout, and cancellation failure modes to output policy.

## Consequences and trade-offs

- Correctness of field-level policy depends on the deployment projector. The
  runtime can guarantee that a projector ran and produced a JSON value, not that
  its policy is correct.
- Projection and counting add CPU work to every opted-in invocation, including
  the first miss; cache hits skip projection but still measure the cached value.
- The budget is whole-result, not per content block. Multimodal or multi-part
  results need a finer measurement model later.
- An `estimate` budget can under- or over-count relative to the model. The
  runtime labels the measurement but cannot correct the estimate.
- Serialization happens for projection validation, budget counting, measurement,
  the MCP adapter, and the in-memory store. A shared serialization path is a
  follow-up, not a correctness issue.
- The projected result can still exceed the transport byte cap. The budget is a
  token control, not a replacement for the adapter's `maxResponseBytes` check.
- A cache write can be rejected for size after projection; the projected result
  is still returned and measured, but not cached. This is the existing cache
  failure policy.
- Policy changes on a shared cache require an operational step (namespace or
  revision). This is documented rather than solved by extending the key format.

## Security implications

- Projection runs before any cache write; a hit can only contain a value that
  already passed the projector and budget.
- Failures are closed: no raw fallback, no stale raw cache entry created by the
  current call, and an uncountable budget aborts the invocation.
- Error messages do not include the raw result, the projector's output, or token
  counts. Causes are retained only for protected diagnostics.
- The projector receives the full raw result and caller context. It is trusted
  in-process code and must not forward either to an untrusted service.
- Projection is not authorization. It must not be used to grant access that the
  authorizer denied, and it runs only after authorization, validation, and rate
  limiting.
- Token counts reveal approximate payload size even when payload text is not
  logged. Protect telemetry accordingly.
- The runtime cannot detect a projector that returns an unauthorized field. Tests
  and contract review remain necessary.
- Shared caches can retain values produced under an older policy. Rotate the
  namespace or revision as part of the deployment that changes projection.
- If the projector varies with caller attributes beyond tenant, principal, and
  the authorization partition, those attributes must be folded into the
  partition or caching bypassed; otherwise a projected value could be served to
  a caller with a different projection policy.

## Follow-up actions

- SEC-05: define and test concrete output policies for generated tools,
  including field-level authorization and redaction rules.
- JSON navigation and declarative selection in Milestone 6.
- Per-content-block measurement and budgeting for multipart results.
- Share one serialization between projection validation, measurement, caching,
  and the transport.
- Consider including an output-policy fingerprint in future key versions if
  operational rotation proves error-prone.
- Add aggregated metrics for projected payload size and budget rejections.

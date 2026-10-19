# ADR 0006 — Stage-aware policy adapter errors and rate-limit decisions

- Status: proposed
- Recorded: 2026-10-19

## Context and problem

The Milestone 1 runtime invokes an optional `Authorizer`, validates input,
invokes an optional `RateLimiter`, and then executes the tool. Policy adapters
are supplied by callers, so their error behavior must be explicit and safe.

Two ambiguities existed:

- An authorizer that threw a plain `Error` was wrapped as `UPSTREAM_FAILURE`
  with the message `Tool '<name>' failed`. The natural way to reject a call
  therefore looked like an upstream tool failure to clients, and
  `AUTH_FORBIDDEN` was never constructed by the runtime itself.
- The `rate_limited` metrics outcome was derived from
  `error.code === "RATE_LIMITED"`. A limiter failure such as a Redis outage was
  classified differently depending on which error code the adapter chose, so
  the meaning of the metric depended on adapter etiquette.

## Decision

Track the invocation stage and classify failures against it.

- **Authorization.** Return normally to allow. A thrown `RuntimeError` is
  preserved. Any other thrown value fails closed as
  `RuntimeError("AUTH_FORBIDDEN", "Access denied")` with the original error as
  `cause`. Adapters that need to report an identity-provider outage rather than
  a policy denial throw a `RuntimeError` with a distinct code such as
  `UPSTREAM_FAILURE`.
- **Rate limiting.** `RateLimiter.check` returns a `RateLimitDecision`.
  `{ allowed: false }` produces `RATE_LIMITED` and the `rate_limited` metrics
  outcome. A missing or malformed decision fails closed as `UPSTREAM_FAILURE`.
  Throwing is reserved for limiter failures. A thrown `RuntimeError` other than
  `RATE_LIMITED` is preserved. Any other throw, including `RATE_LIMITED`,
  becomes `UPSTREAM_FAILURE` with a limiter-failure message.
- **Validation and execution.** Validation produces `INPUT_INVALID`. Typed
  execution errors are preserved; untyped execution failures become
  `UPSTREAM_FAILURE` with `Tool '<name>' failed`.
- **Observability.** `RuntimeEvent.outcome` is derived from the stage
  classification, not from arbitrary adapter error codes. Causes remain
  available on the `RuntimeError` for protected diagnostics and are never sent
  to clients or placed in the metrics event.

## Alternatives considered

- **Document that adapters must throw `RuntimeError`.** Rejected: it leaves the
  most natural adapter implementation misclassified to clients.
- **Map every authorization throw to `AUTH_FORBIDDEN` but keep the limiter's
  throwing contract.** Rejected: it conflates a limiter outage with a quota
  denial and keeps the metric dependent on error-code conventions.
- **Keep string-matching and document which codes adapters must use.**
  Rejected: the same physical failure can still produce different metrics
  depending on adapter implementation, and a thrown `RATE_LIMITED` cannot be
  distinguished from a genuine denial.
- **Return a full result object from `authorize` as well.** Deferred: throwing
  to deny is the established authorization shape, and untyped failures can fail
  closed without changing that interface.

## Consequences and trade-offs

- `RateLimiter` is a breaking interface change before 1.0. Adapters must return
  a decision instead of throwing to deny, and a thrown `RATE_LIMITED` is now a
  limiter failure.
- Untyped authorization failures deny access but are labeled `AUTH_FORBIDDEN`.
  Operators can distinguish a typed adapter failure by its preserved code.
  Untyped failures still indicate that the authorization stage failed.
- Metrics become reproducible across adapter implementations: only an explicit
  denial is counted as rate limiting.
- Tests must cover untyped authorization failures, typed authorization
  failures, limiter denial, limiter failure, and upstream rate-limit errors.

## Security implications

- Untyped authorization failures fail closed.
- Adapter details and causes never reach clients or metrics events, preventing
  sensitive authorization or infrastructure information from leaking.
- A limiter outage cannot be reported as a successful quota decision or as a
  `rate_limited` outcome.
- Preserving typed errors lets operators distinguish policy denial from
  identity-provider or limiter infrastructure failure without weakening the
  client-facing message.

## Follow-up actions

- Keep `API_REFERENCE.md` and `ARCHITECTURE.md` synchronized with this mapping.
- Add a logger or diagnostic sink in Milestone 6 that records causes with
  redaction and retention controls.
- Revisit whether authorization should return an explicit decision type once
  concrete auth adapters exist.

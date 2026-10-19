# ADR 0007 — Wall clock for timestamps, monotonic clock for durations

- Status: proposed
- Recorded: 2026-10-19

## Context and problem

`RuntimeEvent` carries a `timestamp` (when the call happened) and a
`durationMs` (how long it took). The Milestone 1 runtime derived both from a
single injectable `RuntimeOptions.now` clock that defaulted to `Date.now`.

`Date.now` is a wall clock. It can move backwards or jump forwards when the
system clock is adjusted (NTP, manual change, suspend/resume). Deriving a
duration from two wall-clock reads can therefore produce a negative, clamped,
or wildly inflated value, which corrupts the latency signal taken from
`durationMs`. The two values also have different units of concern: a timestamp
must be an absolute epoch value, while a duration must be a monotonic
difference.

## Decision

Separate the two clocks.

- `RuntimeOptions.now` supplies only the event `timestamp`. It defaults to
  `Date.now` (epoch milliseconds).
- `RuntimeOptions.monotonicNow` supplies `durationMs`. It defaults to
  `performance.now` (a monotonic clock in Node.js).
- `durationMs` remains clamped with `Math.max(0, ...)` as a defensive guard,
  but with a monotonic source the clamp should not normally be exercised.

Both clocks stay injectable so tests remain deterministic without real time.

## Alternatives considered

- **Keep `Date.now` for both.** Rejected: durations become sensitive to system
  clock changes, and the failure is silent because the value is still a number.
- **Use `performance.timeOrigin + performance.now()` for the timestamp.**
  Rejected: it changes the meaning of the timestamp from "epoch time at the
  event" to an approximation rooted at process start, and `timeOrigin` is not
  stable across clock adjustments either.
- **Reuse a single injected clock and document it as monotonic.** Rejected: a
  monotonic counter is not usable as an epoch timestamp, so one option cannot
  correctly serve both fields.
- **Hard-code `performance.now` without an option.** Rejected: it removes the
  deterministic clock injection that the runtime tests rely on.

## Consequences and trade-offs

- `RuntimeOptions` gains one option (`monotonicNow`); existing callers that only
  injected `now` now affect the timestamp alone. This is an additive, pre-1.0
  change.
- Tests must inject `now` and `monotonicNow` independently when asserting both
  fields.
- `durationMs` is now comparable across hosts and unaffected by clock
  adjustments, so latency aggregation is trustworthy.

## Security implications

- No trust boundary changes. The runtime still treats injected clocks as
  caller-supplied configuration.
- More reliable durations reduce the risk of a monitoring blind spot in which a
  clock change masks a hung or slow tool call.

## Follow-up actions

- Keep `API_REFERENCE.md` synchronized with the meaning of `now` and
  `monotonicNow`.
- When Milestone 6 adds structured usage events, reuse the same wall/monotonic
  split rather than re-deriving durations from timestamps.

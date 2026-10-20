---
"@chainmcp/core": minor
"@chainmcp/config": minor
---

Measure `RuntimeEvent.durationMs` with a monotonic `performance.now` clock instead of the wall clock, so system clock adjustments cannot distort or invert durations. Add `RuntimeOptions.monotonicNow` for deterministic tests; `RuntimeOptions.now` now only supplies the event `timestamp`. Add publish metadata (`license`, `repository`, `publishConfig`) to `@chainmcp/core` and `@chainmcp/config`.

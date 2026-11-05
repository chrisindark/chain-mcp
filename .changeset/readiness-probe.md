"@chainmcp/server": minor
"@chainmcp/config": minor
"@chainmcp/cli": minor
---

Add a `GET /readyz` readiness probe that reflects dependency reachability and follows the configured failure policy.

- `@chainmcp/server`: `serveHttp` accepts `readiness: { deps: [{ name, check, degradedReady? }] }`. `GET /readyz` runs each check (errors swallowed, never mirrored) and returns `200 {"status":"ready"}` when all pass, `200 {"status":"degraded"}` when only `degradedReady` deps fail, and `503 {"status":"not_ready"}` when a non-degraded dep fails. `GET /health` and `GET /livez` remain liveness-only and never touch dependencies. With no deps configured, `/readyz` returns ready with no dependency detail.
- `@chainmcp/config`: new `buildReadinessDeps(config, { rateLimiter, cacheStore })` emits one dep per Redis-backed dependency, using the same client instances as the runtime. The rate limiter probes `eval("return 1")`; the cache store probes a read of an absent key (proves liveness without writing). Both are bounded by a 500 ms probe timeout. A `fail-open` limiter is reported `degradedReady`, mirroring the call path, so an unreachable Redis keeps `/readyz` at 200 `degraded`; a `fail-closed` limiter or cache outage returns 503. Exported `ReadinessDep` type for embedded use.
- `@chainmcp/cli`: `serve` (HTTP), `gateway serve` (HTTP), and generated server templates pass `buildReadinessDeps` output to `serveHttp`.
- Additive: existing deployments without the wiring behave as before; `/health` and `/livez` responses are unchanged.

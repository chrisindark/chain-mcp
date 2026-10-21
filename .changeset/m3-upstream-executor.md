---
"@chainmcp/executor": minor
"@chainmcp/compiler": patch
"@chainmcp/core": patch
"@chainmcp/config": patch
"@chainmcp/auth": patch
"@chainmcp/cache-redis": patch
"@chainmcp/server": patch
---

Add `@chainmcp/executor`, the first upstream HTTP execution slice.

`createUpstreamExecutor()` turns compiled operations into runnable tools with
path/query/header/JSON-body mapping, an exact host allowlist, HTTPS by default,
fixed protocol/port, same-host redirect revalidation, DNS-answer classification
and address pinning, peer verification, response and request caps, and
`context.signal`/total-timeout binding. It returns JSON for 2xx responses and
maps destination, request, status, response, timeout, and cancellation failures
to safe runtime errors. It does not inject credentials, enforce authentication
policies, validate response schemas, retry, or honor proxy environment
variables.

The compiler now records sorted parameter bindings and request-body media
metadata so the executor does not re-parse OpenAPI, and includes them in
per-tool hashes.

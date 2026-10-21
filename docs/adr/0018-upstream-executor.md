# ADR 0018: Upstream executor and outbound destination policy

- Status: proposed
- Date: 2026-10-21

## Context

The compiler emits metadata but nothing performs the upstream HTTP call. The
first outbound call must land with the controls in `ROADMAP.md`,
`SECURITY.md`, and `docs/risk-register.md`: destination allowlisting,
private/link-local/metadata range blocking, redirect revalidation, response
size and time caps, and `context.signal` binding. A URL parser check alone is
not SSRF protection, and `fetch()` does not expose a pin between DNS resolution
and connect.

The runtime's execution contract is cooperative: it aborts `context.signal`
and stops waiting, but the executor must bind that signal to I/O and release
resources. It also maps untyped executor failures to a safe upstream error, so
the executor must keep client messages free of upstream details.

## Decision

Add `@chainmcp/executor` with `createUpstreamExecutor(options)`:

1. **Explicit configuration.** The caller supplies an absolute `baseUrl` and an
   exact `allowedHosts` list. The base host must be allowlisted. Wildcards,
   schemes, ports, paths, credentials, and whitespace in allowlist entries are
   rejected. HTTPS is required unless `allowInsecureHttp` is set.
2. **Origin lock.** Every request and redirect must use the base protocol and
   effective port. Redirects must also stay on the current host, even if
   another host is allowlisted. This avoids forwarding caller-supplied header
   parameters to a different host.
3. **Resolve, classify, pin.** Resolve the hostname once per hop. Reject the
   whole answer if any IPv4/IPv6 address is loopback, private, shared (CGNAT),
   link-local, metadata, multicast, documentation, unspecified, or reserved.
   Pin the selected address in the Node `lookup` callback, disable connection
   reuse, verify `socket.remoteAddress`, and leave TLS certificate validation at
   Node's secure default.
4. **No ambient network behavior.** Do not honor proxy environment variables,
   do not request or accept compressed responses, and do not retry. The default
   transport is Node `http`/`https`, not `fetch`.
5. **Bounded I/O.** Cap URL length (8 KiB), request headers (16 KiB), request
   body (1 MiB default), response headers (16 KiB), response body (1 MiB
   default), redirects (3), and total elapsed time (15 s). All bounds have hard
   maxima. Read response bodies as a stream and abort as soon as the cap is
   exceeded; a declared oversized `content-length` fails before reading.
6. **Cooperative cancellation.** Bind `context.signal` to the request and to
   waits on DNS/transport promises. Use one total-deadline timer for the whole
   redirect chain. Clear timers and listeners in `finally`.
7. **JSON-only first slice.** Send path/query/header inputs and a JSON `body`;
   query arrays become repeated keys and header arrays are comma-joined.
   Objects, arrays of objects, and `null` where OpenAPI serialization is
   ambiguous are rejected. Return parsed JSON for 2xx responses, `null` for an
   empty body, and reject non-JSON media types. Non-2xx bodies are never
   included in errors.
8. **Separate package.** Keep metadata compilation offline in
   `@chainmcp/compiler` and put runtime HTTP in `@chainmcp/executor`. The
   executor depends on compiler types and core `ToolDefinition`; it does not
   change the runtime's authorization, cache, or tenancy stages.
9. **No credentials.** Do not interpret `CompiledOperation.authentication` in
   this slice. Never forward inbound identity, cookies, or authorization
   headers. Credential providers remain Milestone 5 work.

Compiler metadata gains `parameters` and `requestBody` bindings so the executor
does not re-parse OpenAPI. Parameter bindings are sorted by input name; the
request body records the selected JSON media type and required flag. These
fields participate in per-tool hashes.

## Alternatives considered

- **Use global `fetch`.** Rejected: no DNS pin, no peer verification hook, and
  redirect behavior is harder to revalidate deterministically. `fetch` also
  makes it easy to inherit ambient proxy behavior.
- **Validate the URL string and rely on the system resolver.** Rejected: DNS
  rebinding and IPv4/IPv6 spelling bypasses. Address classification must run on
  the resolved answers and the connection must use the checked address.
- **Allow wildcard hosts or arbitrary redirects within the allowlist.**
  Rejected for the first slice: a redirect could move caller-controlled headers
  to another host and widens the SSRF surface. Exact hosts and same-host
  redirects are enforceable and easy to explain.
- **Decompress responses.** Rejected: compression expands after the transport
  cap and adds a second unbounded surface. The executor asks for identity and
  rejects compressed responses.
- **Retry automatically.** Rejected: retries can duplicate non-idempotent
  operations and interact badly with deadlines. Retries remain a later,
  opt-in policy.
- **Put HTTP in the compiler.** Rejected: compilation must stay offline and
  deterministic, and runtime HTTP needs cancellation and policy configuration
  that do not belong in the compiler.

## Consequences

- Generated tools are runnable through the shared runtime for JSON HTTP APIs
  with no authentication.
- The executor is conservative: it rejects non-public DNS answers, cross-host
  redirects, compressed responses, non-JSON responses, and ambiguous parameter
  serialization.
- Request-body serialization still allocates through `JSON.stringify` before the
  byte check; a separate bounded serializer remains future work.
- DNS resolution is not cancellable at the OS level. An aborted call stops
  waiting and aborts the HTTP request, but the resolver promise may settle
  later.
- A custom `UpstreamTransport` is trusted adapter code. The executor rechecks
  response size and JSON shape but cannot verify the socket destination chosen
  by an injected transport.
- Proxy support, credential injection, response validation, retries, multipart
  and binary media types, OpenAPI serialization styles, per-operation `servers`,
  and generated-server/CLI wiring remain open.

## Security implications

- Rejecting a resolution when any address is unsafe prevents "one public, one
  private" DNS answers from making the outcome depend on resolver ordering.
- Same-host redirects prevent header leakage to a second allowlisted host and
  reduce redirect-chain SSRF.
- Pinning and peer verification close the gap between DNS validation and the
  connection actually made by the default transport.
- Disabling connection reuse avoids reusing a socket that was authorized for a
  different destination or credential context.
- Errors expose only stable categories and status codes, never response bodies,
  resolved IPs, or transport causes.
- No authentication is enforced. Deployments must not treat this executor as an
  authenticated upstream client until the Milestone 5 credential slice lands.

## Follow-up actions

1. Define upstream credential providers and how an executor selects an
   authentication alternative without weakening the destination policy.
2. Add a bounded JSON serializer or pre-serialization size accounting.
3. Wire `security.allowedUpstreamHosts`, base URLs, and executor limits into
   `@chainmcp/config` and generated-server/CLI flows.
4. Add an output validator and response-schema enforcement.
5. Evaluate proxy support as an explicit configuration path with the same
   resolve/classify/pin guarantees.
6. Add Inspector conformance and a runnable end-to-end example.

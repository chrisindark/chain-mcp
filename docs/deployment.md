# Deployment Guide

This guide covers deployment options, operational best practices, security requirements, and containerization for ChainMcp generated servers and future gateway instances.

## 1. Overview of Deployment Modes

ChainMcp supports two core execution modes (see [ADR 0002](adr/0002-shared-runtime.md)):

1. **Generated Standalone Servers (Milestone 7):**
   - Packaged as self-contained projects using `chainmcp export --output ./my-server`.
   - Independent build and execution lifecycle with a pinned contract revision and deterministic manifest.
   - Ideal for developers who need to run API-backed MCP servers locally or inside isolated microservice containers.

2. **Dynamic Multi-Contract Gateway (Milestone 9):**
   - Serves multiple registered API contracts through a single long-running process with tenant isolation.

Both deployment modes share the exact same runtime (`@chainmcp/core`), outbound executor (`@chainmcp/executor`), authentication (`@chainmcp/auth`), rate limiting (`@chainmcp/rate-limit`), analytics (`@chainmcp/analytics`), and JSON navigation (`@chainmcp/json-navigation`) pipeline.

---

## 2. Deploying Generated Servers

### Project Structure

When exported with `chainmcp export`, a generated server has the following structure:

```text
my-server/
├── chainmcp.config.yaml    # Project configuration and security allowlists
├── chainmcp.manifest.json  # Pinned contract revision, compiler/generator versions, and toolset hash
├── spec/
│   └── openapi.yaml        # Pinned contract snapshot
├── src/
│   ├── server.ts           # Server entry point wiring runtime, executor, and stdio transport
│   └── tools.ts            # Pinned tool definitions metadata
├── package.json            # Pinned dependencies and scripts
├── tsconfig.json           # Base TypeScript configuration
├── tsconfig.build.json     # Production build configuration
├── Dockerfile              # Multi-stage container build template
├── .dockerignore           # Excluded files for container builds
├── .gitignore              # Git exclusions
└── README.md               # Quickstart and run instructions
```

### Building the Server

From the exported server directory:

```bash
pnpm install
pnpm build
```

This compiles TypeScript files from `src/` into `dist/`.

If the generated project was scaffolded with `--local-deps`, it includes a
`packageManager: pnpm@...` pin and a `pnpm-workspace.yaml` override; use pnpm.
After the `@chainmcp/*` packages are published, the generated project no longer needs the `pnpm-workspace.yaml` override; a `pnpm` or `npm` install then resolves registry packages. Adjust the `RUN` lines accordingly.

---

## 3. Running with MCP Clients

Generated servers use the Model Context Protocol (MCP) `stdio` transport. MCP clients run the server as a local child process and communicate through standard input/output streams.

### Configuration for Claude Desktop

Add your server to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "my-api-server": {
      "command": "node",
      "args": ["/absolute/path/to/my-server/dist/server.js"],
      "env": {
        "CHAINMCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

### Configuration for Cursor

Add the command in Cursor settings under MCP servers:

```bash
node /absolute/path/to/my-server/dist/server.js
```

### Verifying with the MCP Inspector

You can inspect and debug tools using the official MCP Inspector CLI:

```bash
npx -y @modelcontextprotocol/inspector@2.11.0 --cli node dist/server.js
```

---

## 4. Containerized Deployment with Docker

Exported servers include a multi-stage `Dockerfile` following container best practices:

- **Build stage:** Compiles TypeScript assets in an isolated Node.js alpine container.
- **Production runner stage:** Runs with production dependencies only (`NODE_ENV=production`), excluding developer tooling.
- **Security hardening:** Runs as a non-privileged `node` user instead of `root`.
- **Minimal attack surface:** No shell scripts or build tools in the final runner image.

### Multi-stage Dockerfile Template

```dockerfile
# Stage 1: Build
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN pnpm install --frozen-lockfile
COPY tsconfig*.json ./
COPY spec ./spec
COPY src ./src
RUN pnpm build

# Stage 2: Production runner
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN pnpm install --frozen-lockfile --prod
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/spec ./spec
COPY chainmcp.config.yaml ./
COPY chainmcp.manifest.json ./

USER node
ENTRYPOINT ["node", "dist/server.js"]
```

The template assumes the generated server was scaffolded with local-deps and
includes a `pnpm-workspace.yaml` override. The `RUN` lines use pnpm. After the
`@chainmcp/*` packages are published, the generated project no longer needs the
`pnpm-workspace.yaml` override and may use pnpm or npm; adjust the `RUN` lines
for the published-package workflow.

### Building and Running Containers

Build the container image:

```bash
docker build -t my-chainmcp-server .
```

Run interactively over stdio (connecting stdin/stdout to the client):

```bash
docker run -i --rm \
  -e CHAINMCP_LOG_LEVEL=info \
  my-chainmcp-server
```

Run in an MCP client using Docker:

```json
{
  "mcpServers": {
    "dockerized-server": {
      "command": "docker",
      "args": ["run", "-i", "--rm", "my-chainmcp-server"]
    }
  }
}
```

---

## 5. Security & Network Considerations

### Destination Allowlists (`allowedUpstreamHosts`)

Every outbound request issued by `@chainmcp/executor` must match an explicitly configured hostname in `security.allowedUpstreamHosts`.

```yaml
security:
  allowedUpstreamHosts:
    - api.example.com
```

- **Fail-Closed:** If `allowedUpstreamHosts` is empty or omitted, outbound requests are unconditionally blocked.
- **Strict Host Syntax:** Wildcards, ports, schemes, paths, and user credentials in hostnames are rejected at configuration parse time.
- **SSRF Defense:** All DNS resolutions are pinned. Resolved IP addresses in private (RFC 1918), loopback (`127.0.0.0/8`, `::1`), link-local (`169.254.0.0/16`), multicast, documentation, or cloud metadata ranges (`169.254.169.254`) fail closed with `SSRF_BLOCKED`.
- **Redirect Revalidation:** Redirects are only followed if they remain on the exact same host, protocol, and port.

### HTTP Deployment & Reverse-Proxy Guidance

When deploying servers or the dynamic gateway over Streamable HTTP (`--transport http`), enforce limits at both the reverse proxy (e.g. Nginx, Envoy, Cloudflare) and the application layer:

1. **Request Body Size Limits (`server.maxRequestBytes`):**
   - ChainMcp enforces a default 1 MiB (`1,048,576` bytes) hard cap on incoming request bodies.
   - Declared `Content-Length` headers exceeding the cap are rejected with `413 Payload Too Large` before buffering.
   - Chunked streaming bodies exceeding the cap are aborted mid-stream with `413` without unbounded memory buffering.
   - Align your reverse proxy (e.g., `client_max_body_size 1m;` in Nginx) to match or stay below `server.maxRequestBytes`.

2. **Host and DNS Rebinding Protection (`server.allowedHosts`, `server.enableDnsRebindingProtection`):**
   - Host headers are strictly validated. Missing or malformed Host headers are rejected with `400 Bad Request`.
   - When `enableDnsRebindingProtection` is enabled (or `allowedHosts` is configured), Host headers not matching the allowlist are rejected with `403 Forbidden` without echoing request data.
   - Ensure the reverse proxy forwards the client's canonical host (`proxy_set_header Host $host;`).

3. **CORS and Browser-Client Origin Verification (`server.cors`, `server.allowedOrigins`):**
   - When serving web or browser-based MCP clients (such as web chat UIs or browser extensions), configure `server.cors` with an explicit origin allowlist (`allowedOrigins`).
   - Arbitrary origin reflection is strictly prevented: only exact allowlist matches or `"null"` (if explicitly declared) are reflected in `Access-Control-Allow-Origin`.
   - Disallowed origins receive `403 Forbidden` on preflight `OPTIONS` requests, and do not receive `Access-Control-Allow-Origin` headers on standard requests.
   - Wildcard origin (`"*"`) is never permitted when `allowCredentials: true` is configured; this dangerous combination is rejected at config parse time and server startup.
   - `Access-Control-Allow-Headers` is dynamically computed from configured inbound verifier headers (such as custom `ApiKeyVerifierOptions.headerName`), standard defaults, and custom `allowedHeaders`.
   - `Vary: Origin` is always attached to HTTP responses whenever CORS is enabled.
   - CORS defaults to disabled on **every** bind host, including loopback. There is no implicit wildcard: enabling CORS requires an explicit `allowedOrigins` list, and `cors: true` without origins stays disabled. Explicit wildcard `"*"` is honoured but always emits a startup warning.
   - Browser-origin validation is always on. A request with an `Origin` outside the effective allowlist (configured origins, or the bind-host defaults such as `localhost`, `127.0.0.1`, `[::1]`) is rejected with `403` before tools run, even when CORS headers are disabled. Requests without `Origin` (CLI clients) are unaffected.
   - To use the MCP Inspector UI, opt in to its origin explicitly:

     ```yaml
     server:
       cors:
         enabled: true
         allowedOrigins:
           - http://localhost:6274
           - http://127.0.0.1:6274
     ```

     The Inspector CLI uses stdio and sends no `Origin` header.

4. **Timeouts (`server.requestTimeoutMs`):**
   - Default request timeout is 15,000 ms (15s). Ensure reverse proxy timeouts (`proxy_read_timeout`, `proxy_send_timeout`) are aligned to prevent hung connections.

5. **Inbound Authentication & Fail-Closed Non-Loopback Binds (`security.requireInboundAuth`, `security.allowUnauthenticatedHttp`):**
   - ChainMcp strictly refuses to bind HTTP servers or dynamic gateways to non-loopback interfaces (e.g. `0.0.0.0`, LAN/public IPs) without authentication, failing fast at startup unless `security.allowUnauthenticatedHttp: true` (or `--allow-unauthenticated-http`) is explicitly configured.
   - Loopback binds (`127.0.0.1`, `localhost`, `::1`) permit unauthenticated development access but emit a prominent startup warning naming the host, port, exposed tool count, and config keys.
   - When `security.requireInboundAuth: true` is configured, an inbound verifier (`auth.inbound.tokens`, `apiKeys`, or `jwt`) must be present; starting with auth required but no verifier fails fast at startup.
   - When inbound authorizer is `scope`, an inbound verifier is mandatory; starting with a scope authorizer without a verifier fails fast at startup.

### Upstream Credentials

Never hardcode credentials or secrets in `chainmcp.config.yaml` or repository files. Use:

1. **Environment references:** Credential fields accept `${VAR}` and
   `${VAR:-default}`. A missing referenced variable stops startup with
   `SECRET_UNRESOLVED` naming the field and variable:
   ```yaml
   auth:
     upstream:
       providers:
         - type: oauth
           tokenUrl: https://auth.example.com/oauth/token
           clientId: chainmcp
           clientSecret: "${OAUTH_CLIENT_SECRET}"
   ```
   See [`CONFIGURATION.md`](../CONFIGURATION.md#secret-references) for the full
   field list.
2. **Upstream credential providers:** Configure `auth.upstream` with
   `type: env` (for example `CHAINMCP_AUTH_API_KEY`), `type: secretStore`, or
   `type: oauth` using authenticated AES-256-GCM encryption.

### Shared Redis Topology

For clustered deployments using Redis for distributed caching (`@chainmcp/cache-redis`) and distributed rate limiting (`@chainmcp/rate-limit`):

- **Shared Client Instance:** When both caching and rate limiting are configured for Redis, the runtime shares a single client connection set across both subsystems to prevent redundant sockets and connection pool exhaustion.
- **Key Partitioning:** Caching keys use the configured `cache.redis.keyPrefix` (default `chainmcp:cache:`) while rate limiter keys use `rateLimit.redis.keyPrefix` (default `chainmcp:ratelimit:`), allowing both subsystems to operate safely against the same Redis cluster without key collision.
- **Outage Policy:** When Redis is degraded or unreachable, distributed caching fails open (bypassing the cache without failing the tool invocation), while rate limiting follows `rateLimit.failurePolicy` (failing closed with `UPSTREAM_FAILURE` by default to protect upstreams, or failing open if explicitly configured).

### Liveness and Readiness Probes

Three probe endpoints are served on the HTTP server:

- `GET /health` and `GET /livez` are **liveness-only**. They return `200`
  `{"status":"ok", "name", "version"}` without touching any dependency, so
  orchestrators can distinguish "process alive" from "ready to serve" and
  never restart a healthy process because a dependency is down. They are
  also excluded from the shutdown drain budget.
- `GET /readyz` is a **readiness** probe: it reports dependency
  reachability and follows the configured failure policy. With no
  dependencies configured it returns `200 {"status":"ready"}`. The CLI and
  generated servers wire Redis-backed dependencies automatically via
  `buildReadinessDeps(config, { rateLimiter, cacheStore })`:
  the rate limiter probes `eval("return 1")` and the cache store probes a
  read of an absent key (both prove liveness without writing).
  - A healthy deployment returns `200 {"status":"ready", "deps":[{"name":"rate-limiter","ok":true},{"name":"cache","ok":true}]}`.
  - A rate limiter with `rateLimit.failurePolicy: fail-open` that is
    unreachable keeps the probe at `200 {"status":"degraded", ...}`: the
    server keeps serving tools without rate limiting, exactly as the call
    path does (`docs/rate-limiting.md`).
  - A `fail-closed` limiter that is unreachable, or any cache outage,
    returns `503 {"status":"not_ready", ...}`: tools would fail with
    `UPSTREAM_FAILURE` anyway, so the orchestrator should not route
    traffic here.
  - Probes are bounded by a 500 ms timeout; a hung Redis cannot stall the
    probe. Error details are never mirrored — only pass/fail per
    dependency, so a Redis URL or credential can never leak through the
    probe response.
- Embedded `serveHttp` users opt in by passing `readiness: { deps: [...] }`
  (see `packages/server/API.md`); each dep is a `check` returning
  `boolean` and an optional `degradedReady` flag for fail-open semantics.

Point your orchestrator's liveness probe at `/health` (or `/livez`) and
its readiness probe at `/readyz`.

### Process Signals and Teardown

`@chainmcp/server` listens for `SIGINT` (Ctrl+C) and `SIGTERM` signals. Signal
handling is idempotent: the first signal sets the conventional exit code (`130`
for SIGINT, `143` for SIGTERM) and starts one shutdown; repeated or mixed
signals share the same promise and do not run teardown twice.

**HTTP transport (`--transport http`)** shuts down drain-then-cancel:

1. It marks the server as shutting down. Requests that arrive during the
   window get `503` with `Connection: close`; the listener stays bound until the
   drain ends so late clients receive a rejection rather than a reset.
2. Work-bearing `POST` and `DELETE` requests drain for up to
   `server.shutdownTimeoutMs` (default 10,000 ms; `0` skips the drain).
   `GET`/`HEAD` streams such as SSE and health probes do not extend the budget.
3. When the budget expires, it aborts the request cancellation signal. Tools
   that bind `context.signal` to their I/O are cancelled cooperatively and
   return `CANCELLED`; a tool that ignores the signal is abandoned, then its
   socket is force-closed. Teardown cannot terminate user code for it.
4. It closes the listener, tears down the MCP handler and server, and calls
   `runtime.close()` once to flush analytics sinks and drain the shared Redis
   client that `@chainmcp/config` created. Caller-supplied clients are not
   closed.

**Stdio transport** closes on application `AbortSignal`, `SIGINT`, `SIGTERM`,
and automatically when standard input (`stdin`) reaches `EOF` (for example when
the parent MCP client process terminates). It removes stream event listeners
and releases runtime-owned clients on the same `runtime.close()` hook. A
generated server inherits these defaults from `@chainmcp/server`.

---

## 6. Configuration Environment Variables

| Variable                        | Description                                                          | Default                  |
| ------------------------------- | -------------------------------------------------------------------- | ------------------------ |
| `CHAINMCP_CONFIG`               | Path to `chainmcp.config.yaml` or custom configuration file          | `./chainmcp.config.yaml` |
| `CHAINMCP_GATEWAY_CONFIG`       | Path to the gateway configuration file                               | `./gateway.config.yaml`  |
| `CHAINMCP_LOG_LEVEL`            | Log verbosity threshold (`debug`, `info`, `warn`, `error`, `silent`) | `info`                   |
| `CHAINMCP_REDIS_URL`            | Redis URL for distributed rate limiting or shared cache              | N/A                      |
| `CHAINMCP_ALLOW_MANIFEST_DRIFT` | Generated servers: warn instead of failing on artifact drift         | unset                    |
| `CHAINMCP_AUTH_<SCHEME>`        | Upstream credential lookup for the `type: env` provider              | N/A                      |

Credential fields in `chainmcp.config.yaml` also accept `${VAR}` and
`${VAR:-default}` references; a missing variable fails startup with
`SECRET_UNRESOLVED` naming the field and variable. See
[`CONFIGURATION.md`](../CONFIGURATION.md#secret-references) for the exact field
list. `chainmcp config explain` prints the resolved configuration with secrets
redacted.

---

## 7. Operational Readiness Checklist

Before moving a generated server into production:

- [ ] Contract is validated via `chainmcp validate`.
- [ ] Generation manifest is committed (`chainmcp.manifest.json`) and passes reproducibility checks (`chainmcp build --check`).
- [ ] `security.allowedUpstreamHosts` contains only minimal required upstream hostnames.
- [ ] Upstream API credentials are provided via environment variables or secret storage, never committed to git.
- [ ] Logging is set to `info` or `warn` to exclude verbose tracing.
- [ ] Docker containers run as non-root user (`node`).

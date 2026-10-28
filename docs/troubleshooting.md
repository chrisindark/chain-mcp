# Troubleshooting Guide

This guide assists operators and developers in diagnosing and resolving common operational issues, error codes, and configuration problems in ChainMcp generated servers and dynamic gateway instances.

## 1. Runtime Error Codes

ChainMcp maps internal exceptions to safe, stable error codes exposed across the MCP protocol. Internal causes and stack traces are retained exclusively in server-side diagnostic logs and are never sent over the wire.

### `TOOL_NOT_FOUND`

- **Symptom:** MCP client receives `TOOL_NOT_FOUND: Tool not found`.
- **Causes:**
  1. The requested tool name is not registered.
  2. In **multi-tenant gateway mode**, the caller belongs to Tenant A, but the tool is owned by Tenant B. By design ([ADR 0008](file:///Users/christopherpaul/projects/chain-mcp/docs/adr/0008-mcp-authorization-mapping.md)), cross-tenant tools fail closed as `TOOL_NOT_FOUND` to prevent inventory enumeration.
  3. The contract revision containing the tool was disabled or rolled back.
- **Resolution:**
  - Verify tool registration in the server or gateway active revision (`gateway.getRegistry().getActiveRevision(tenantId, contractName)`).
  - Verify the caller's authenticated `tenantId` in the transport's `createContext` callback matches the contract's `tenantId`.

### `INPUT_INVALID`

- **Symptom:** MCP client receives `INPUT_INVALID: Invalid tool arguments`.
- **Causes:**
  - Client passed arguments that violate the tool's audited JSON Schema (e.g. missing required field, string length, regex pattern failure, numeric bounds, unexpected property when `additionalProperties: false`).
- **Resolution:**
  - Inspect the tool's `inputSchema` via `tools/list` and compare with the arguments payload.
  - Check server-side diagnostic logs for the specific Ajv schema path validation message.

### `INPUT_TOO_LARGE`

- **Symptom:** MCP client receives `INPUT_TOO_LARGE: Tool '<name>' input exceeds the limit of <limit> bytes (observed at least <observed> bytes)`.
- **Causes:**
  - Inbound tool arguments exceeded `server.maxToolInputBytes` (default 1,048,576 bytes = 1 MiB). This check runs prior to schema validation to protect the runtime against memory exhaustion.
- **Resolution:**
  - Reduce the size of the invocation arguments (e.g., paginate arrays or trim input fields).
  - Increase `server.maxToolInputBytes` in `chainmcp.config.yaml` if large arguments are expected.

### `AUTH_REQUIRED`

- **Symptom:** `AUTH_REQUIRED: Authentication required`.
- **Causes:**
  - In multi-tenant mode, `listTools` or `callTool` was invoked without a caller context, or the transport's `createContext` returned `undefined`.
- **Resolution:**
  - Ensure the transport adapter configures `createContext` and resolves an authenticated `ToolContext` with `tenantId` and `principal`.

### `AUTH_FORBIDDEN`

- **Symptom:** `AUTH_FORBIDDEN: Access denied`.
- **Causes:**
  - The tool requires specific scopes (`operation.requiredScopes`), but the caller's `principal.scopes` does not contain all required tokens.
- **Resolution:**
  - Inspect the tool's required scopes and grant the missing permissions to the principal.

### `RATE_LIMITED`

- **Symptom:** `RATE_LIMITED: Rate limit exceeded. Retry after N seconds`.
- **Causes:**
  - Quota limit (requests per minute) or concurrency permit limit was exhausted for the tenant, principal, or tool.
- **Resolution:**
  - Wait the suggested `retryAfterSeconds` duration before retrying.
  - In high-throughput deployments, raise the quota limits in `chainmcp.config.yaml` (`rateLimit.requestsPerMinute` or `rateLimit.concurrency`).

### `UPSTREAM_TIMEOUT`

- **Symptom:** `UPSTREAM_TIMEOUT: Tool call timed out`.
- **Causes:**
  - The upstream HTTP service took longer than the configured execution budget (`timeoutMs`, default 15,000ms).
- **Resolution:**
  - Check upstream service health and latency.
  - Adjust timeout in `chainmcp.config.yaml` (`server.requestTimeoutMs` or operation override).

### `UPSTREAM_FAILURE`

- **Symptom:** `UPSTREAM_FAILURE: Tool invocation failed`.
- **Causes:**
  - Upstream service returned an HTTP 4xx or 5xx status code.
  - Upstream returned non-JSON data or a non-UTF8 payload.
  - Upstream closed the TCP connection prematurely.
  - Upstream response body exceeded `maxResponseBytes` (default 1 MiB; aborted immediately during streaming traversal).
  - Upstream response violated OpenAPI response schema when `server.validateResponses` is set to `"enforce"`.
- **Resolution:**
  - Inspect server diagnostic logs for the upstream HTTP status, response snippet, or schema validation failure path (response bodies are redacted for security).
  - If responses regularly exceed 1 MiB, configure `server.maxResponseBytes` up to the supported maximum (10 MiB for executor, 100 MiB for server).
  - If upstream responses legitimately deviate from the OpenAPI schema, adjust `server.validateResponses` to `"warn"` (logs audit warnings without failing) or `"off"`.

---

## 2. Network Security & SSRF Diagnoses

ChainMcp's `@chainmcp/executor` enforces strict outbound network boundaries:

### `DestinationPolicyError: Host is not allowlisted`

- **Cause:** Upstream request URL hostname is not listed in `security.allowedUpstreamHosts`.
- **Resolution:** Add the canonical hostname to `security.allowedUpstreamHosts` in `chainmcp.config.yaml` (e.g. `api.example.com`). Note: wildcards, ports, schemes, and path components are strictly forbidden in `allowedUpstreamHosts`.

### `DestinationPolicyError: Non-public destination address`

- **Cause:** The upstream hostname resolved to a loopback (`127.0.0.0/8`, `::1`), private (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), link-local (`169.254.0.0/16`), multicast, or cloud metadata address (`169.254.169.254`).
- **Resolution:** ChainMcp blocks loopback and private networks to eliminate SSRF attacks. For local development or mock servers, use an in-process mock transport (`createMockTransport` or `UpstreamTransport`) rather than loopback HTTP servers.

### `DestinationPolicyError: Redirect refused`

- **Cause:** Upstream returned an HTTP 301/302/307/308 redirecting to a different origin, protocol, or port.
- **Resolution:** ChainMcp follows only same-origin redirects. Reconfigure the upstream service or use the direct target endpoint in the contract.

### Remote Specification Loading Failures

When loading remote OpenAPI specifications via `chainmcp init --spec <url>`, `validate --spec <url>`, or when running `build`, `serve`, `export`, or `diff`:

1. **`Plain HTTP is disabled for remote specifications`**
   - **Cause:** The contract URL uses plain `http://` without opt-in.
   - **Resolution:** By default, remote contracts must use `https://`. For local loopback development, pass `--allow-http` on the CLI or set `security.allowInsecureHttp: true` in `chainmcp.config.yaml`. Note that plain HTTP is never permitted for public hosts.
2. **`Security error: Host resolves to loopback / private / metadata address`**
   - **Cause:** A public hostname resolved to an internal network address (SSRF / DNS rebinding attempt), or targeted a cloud metadata endpoint (`169.254.169.254`).
   - **Resolution:** Remote public specifications must resolve to public IP addresses. Cloud metadata endpoints are unconditionally blocked.
3. **`Unsupported content type 'text/html'`**
   - **Cause:** The remote URL returned an HTML page (such as a 404 error page, documentation browser, or captive portal) instead of raw OpenAPI JSON or YAML.
   - **Resolution:** Provide the direct URL to the raw OpenAPI document (`.json` or `.yaml`).
4. **`Spec size exceeds limit of 10485760 bytes`**
   - **Cause:** The remote contract exceeds the maximum allowed spec download size (default 10 MiB).
   - **Resolution:** Prune or modularize the contract, or download the spec locally for validation.

---

## 3. Safe Log Inspection

ChainMcp includes built-in redaction in `@chainmcp/analytics`:

- Sensitive headers (`Authorization`, `Cookie`, `X-API-Key`, `Set-Cookie`, `Proxy-Authorization`) and secrets matching token patterns are automatically replaced with `[REDACTED]`.
- Request and response bodies are excluded by default from diagnostic logs.

To adjust logging verbosity for debugging:

```bash
# In shell environment
export CHAINMCP_LOG_LEVEL=debug
```

Or in `chainmcp.config.yaml`:

```yaml
logging:
  level: debug
  destination: stdout
```

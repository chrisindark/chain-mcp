# Generated Servers

## Purpose

Generated servers provide portable, self-contained Model Context Protocol (MCP) server projects for developers who need standalone deployments without depending on a shared gateway.

---

## Architecture and Shared Runtime

Generated servers use the shared runtime (`@chainmcp/core`), upstream executor (`@chainmcp/executor`), and server adapter (`@chainmcp/server`).

- Rather than generating monolithic, bespoke policy or dispatch logic into code, the compiler emits deterministic operation metadata, pinned contract revisions, and validated input schemas.
- The generated project references published packages (`@chainmcp/core`, `@chainmcp/executor`, `@chainmcp/server`, `@chainmcp/config`, `@chainmcp/analytics`, `@chainmcp/json-navigation`, `@chainmcp/auth`, `@chainmcp/rate-limit`).
- Output is byte-identical for identical contracts and compiler/generator versions.

---

## CLI Commands (`@chainmcp/cli`)

The `@chainmcp/cli` package provides developer commands:

```bash
chainmcp <command> [options]
```

### 1. `chainmcp init`

Scaffolds a new ChainMcp project or adds configuration to an existing OpenAPI specification.

```bash
chainmcp init --spec ./openapi.yaml [--output <dir>] [--name <name>] [--base-url <url>] [--force]
```

- `--spec <path>`: Path to OpenAPI 3.0 or 3.1 contract (YAML or JSON).
- `--output <dir>`: Target directory (default: current directory `.`).
- `--name <name>`: Project name (defaults to sanitized contract title).
- `--base-url <url>`: Upstream API base URL (defaults to spec `servers[0].url`).
- `--force`: Overwrite existing files if target directory is not empty.

Emits: `spec/openapi.yaml`, `chainmcp.config.yaml`, `package.json`, `tsconfig.json`, `tsconfig.build.json`, `src/server.ts`, `src/tools.ts`, `Dockerfile`, `.dockerignore`, `.gitignore`, and `README.md`.

### 2. `chainmcp validate`

Validates project configuration and the OpenAPI contract, reporting compile diagnostics.

```bash
chainmcp validate [--config <path>] [--spec <path>] [--strict]
```

- `--config <path>`: Path to `chainmcp.config.yaml`.
- `--spec <path>`: Path to OpenAPI contract (overriding config).
- `--strict`: Enforces strict validation mode (default: `true`).

Verifies schema constraints, parameter bindings, security schemes, and warns if `security.allowedUpstreamHosts` is empty.

### 3. `chainmcp build`

Compiles the contract and produces the generation manifest and precompiled tool definitions.

```bash
chainmcp build [--config <path>] [--spec <path>] [--out-dir <dir>] [--check]
```

- `--out-dir <dir>`: Directory for emitted build artifacts (default: `./dist`).
- `--check`: Verifies reproducibility against an existing `chainmcp.manifest.json`.

Emits `chainmcp.manifest.json` and `compiled-tools.json`.

### 4. `chainmcp serve`

Runs the MCP server over standard I/O (`stdio`).

```bash
chainmcp serve [--config <path>] [--spec <path>] [--base-url <url>] [--tenant <id>]
```

- Binds the upstream executor and runtime.
- Registers compiled API tools and JSON exploration tools (`json_inspect_shape`, `json_select_path`, `json_paginate`, `json_filter`) when enabled.
- Connects to stdio transport, ready to handle incoming JSON-RPC calls from Claude Desktop, Cursor, or other MCP clients.

### 5. `chainmcp export`

Exports a clean, portable standalone server project with a pinned contract snapshot.

```bash
chainmcp export [--config <path>] [--spec <path>] [--output <dir>] [--force] [--check]
```

- `--output <dir>`: Target output directory (default: `./generated-server`).
- `--force`: Overwrite target directory if non-empty.
- `--check`: Asserts byte-for-byte reproducibility against recompilation.

---

## Generation Manifest (`chainmcp.manifest.json`)

Exported projects include an immutable generation manifest recording compiler, generator, and contract integrity:

```json
{
  "manifestVersion": 1,
  "generatorVersion": "0.1.0",
  "compilerVersion": "0.1.0",
  "openapiVersion": "3.1",
  "projectName": "petstore-api",
  "contractRevision": "sha256:7f83b1657ff1fc53b92dc18148a1d65dfc2d4b1fa3d677284addd200126d9069",
  "sourceHash": "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "toolsetHash": "sha256:ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb",
  "toolCount": 2,
  "tools": [
    {
      "name": "getItem",
      "hash": "sha256:3e23e8160039594a33894f6564e1b1348bbd7a0088d42c4acb73eeaed59c009d"
    },
    {
      "name": "createItem",
      "hash": "sha256:2e7d2c03a9507ae265ecf5b5356885a53393a2029d24139499723214eed3d4b3"
    }
  ],
  "generatedAt": "2026-01-01T00:00:00.000Z"
}
```

Reproducibility checks verify that:

1. `sourceHash` matches the canonical contract content.
2. `contractRevision` matches the parsed specification.
3. `toolsetHash` matches the collective hash of all operations.
4. Each individual tool's input schema and binding hash matches exactly.

---

## Generated Project Layout

```text
my-server/
├── chainmcp.config.yaml    # Pinned project configuration
├── chainmcp.manifest.json  # Pinned contract revision & toolset hashes
├── spec/
│   └── openapi.yaml        # Pinned contract snapshot
├── src/
│   ├── server.ts           # Standalone entry point using shared runtime
│   └── tools.ts            # Pinned tool metadata
├── package.json            # Pinned package dependencies
├── tsconfig.json           # Base TypeScript configuration
├── tsconfig.build.json     # Production build configuration
├── Dockerfile              # Multi-stage production container build
├── .dockerignore           # Excluded files for container builds
├── .gitignore              # Git exclusions
└── README.md               # Quickstart and run instructions
```

---

## Acceptance Criteria Verification

- **Independent Execution:** Generated projects build with standard `npm run build` and run with `npm start` without relying on monorepo tooling.
- **Client Protocol Conformance:** Exercised end to end with the official MCP Client (`@modelcontextprotocol/client`) over linked in-memory and stdio transports, discovering tools (`tools/list`) and executing operations (`tools/call`).
- **Reproducibility:** Re-exporting an identical contract produces byte-identical files and matching cryptographic hashes (`verifyProjectManifest`).
- **SSRF and Egress Protection:** Upstream calls enforce `security.allowedUpstreamHosts`, DNS pinning, private IP range blocking, and response size caps.

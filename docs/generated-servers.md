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

## Project Modes: Contract-Driven vs Code-First

ChainMcp projects operate in one of two modes:

1. **Contract-Driven**: Configured with an OpenAPI 3.0 or 3.1 specification (via `--spec` or `contract.source` in `chainmcp.config.yaml`). Operations are compiled into tools and dispatched upstream via the bounded HTTP executor.
2. **Code-First**: Configured without an OpenAPI specification. Tool implementations are authored directly in TypeScript using `@chainmcp/authoring` (e.g. `src/tools.ts`), passing through the exact same runtime pipeline (authorization, rate limiting, caching, projection, telemetry, JSON navigation).

### Command Capability Matrix

| Command             | Contract-Driven Projects                                                | Code-First Projects                                                       | Strict Contract Flag (`--require-contract`)                    |
| :------------------ | :---------------------------------------------------------------------- | :------------------------------------------------------------------------ | :------------------------------------------------------------- |
| `chainmcp init`     | Scaffolds from OpenAPI contract                                         | `--blank` creates code-first scaffold with example tool                   | N/A                                                            |
| `chainmcp validate` | Compiles OpenAPI and verifies schemas, params, auth, base URL           | Validates config, verifies entrypoint existence, discovers tools          | Fails validation with `DOCUMENT_INVALID` if contract is absent |
| `chainmcp build`    | Compiles spec; emits `chainmcp.manifest.json` and `compiled-tools.json` | Emits code-first deterministic manifest and compiled tool definitions     | Fails build if contract is absent                              |
| `chainmcp serve`    | Serves compiled API tools over `stdio` or `http`                        | Discovers code-first tools and serves over `stdio` or `http`              | Fails server startup if contract is absent                     |
| `chainmcp dev`      | Runs dev server with compiled API tools and file watchers               | Runs dev server with local code-defined tools                             | N/A                                                            |
| `chainmcp export`   | Exports standalone server with pinned `spec/openapi.yaml`               | Exports standalone server copying `src/`, config, and code-first manifest | Fails export if contract is absent                             |
| `chainmcp diff`     | Compares OpenAPI contracts or manifests for breaking changes            | Compares contract or manifest hashes                                      | Requires target contracts                                      |

---

## CLI Commands (`@chainmcp/cli`)

The `@chainmcp/cli` package provides developer commands:

```bash
chainmcp <command> [options]
```

### 1. `chainmcp init`

Scaffolds a new ChainMcp project or adds configuration to an existing OpenAPI specification.

```bash
chainmcp init [--spec <path|url>] [--blank] [--output <dir>] [--name <name>] [--base-url <url>] [--allow-http] [--force]
```

- `--spec <path|url>`: Path or HTTPS URL to OpenAPI contract.
- `--blank`: Initialize a blank code-first project with example tool in `src/tools.ts`.
- `--output <dir>`: Target directory (default: current directory `.`).
- `--name <name>`: Project name (defaults to sanitized contract title).
- `--base-url <url>`: Upstream API base URL (defaults to spec `servers[0].url`).
- `--allow-http`: Permit plain HTTP base URLs and remote specs for private/loopback hosts.
- `--force`: Overwrite existing files if target directory is not empty.

### 2. `chainmcp validate`

Validates project configuration, contract, or code-first entrypoints.

```bash
chainmcp validate [--config <path>] [--spec <path|url>] [--strict] [--json] [--allow-http] [--require-contract]
```

- `--config <path>`: Path to `chainmcp.config.yaml`.
- `--spec <path|url>`: Path or HTTPS URL to OpenAPI contract.
- `--strict`: Enforces strict validation mode (default: `true`).
- `--json`: Emit validation output as structured JSON including `contractKind` (`"openapi"` or `"code-first"`).
- `--allow-http`: Permit plain HTTP for loopback/private hosts.
- `--require-contract`: Require an OpenAPI contract and fail if only code-first entrypoints are present.

### 3. `chainmcp build`

Produces the generation manifest and precompiled tool definitions.

```bash
chainmcp build [--config <path>] [--spec <path|url>] [--out-dir <dir>] [--check] [--allow-http] [--require-contract]
```

- `--out-dir <dir>`: Directory for emitted build artifacts (default: `./dist`).
- `--check`: Verifies reproducibility against an existing `chainmcp.manifest.json`.
- `--require-contract`: Require an OpenAPI contract and fail if absent.

Emits `chainmcp.manifest.json` and `compiled-tools.json` for both contract-driven and code-first projects.

### 4. `chainmcp serve`

Runs the MCP server over standard I/O (`stdio`) or Streamable HTTP (`http`).

```bash
chainmcp serve [--config <path>] [--spec <path|url>] [--transport <stdio|http>] [--port <number>] [--host <string>] [--path <string>] [--base-url <url>] [--tenant <id>] [--allow-unauthenticated-http] [--allow-http] [--require-contract]
```

- Supports both contract-driven and code-first projects in-process with identical shared runtime, signal handling, rate limiting, and JSON navigation tools.
- Supports both `stdio` and `http` transports for contract-driven and code-first projects.
- `--require-contract`: Require an OpenAPI contract and fail if absent.

### 5. `chainmcp export`

Exports a clean, portable standalone server project with a pinned manifest.

```bash
chainmcp export [--config <path>] [--spec <path|url>] [--output <dir>] [--force] [--check] [--allow-http] [--require-contract]
```

- For contract-driven projects: pins `spec/openapi.yaml`, generates server code and manifest.
- For code-first projects: copies `src/`, generates `chainmcp.config.yaml`, `package.json`, code-first `chainmcp.manifest.json`, and Dockerfile without `spec` references.
- `--check`: Asserts byte-for-byte reproducibility against recompilation.
- `--require-contract`: Require an OpenAPI contract and fail if absent.

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

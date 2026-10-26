# ADR 0024: Developer CLI and Portable Generated Servers

- Status: accepted
- Date: 2026-10-26

## Context and problem

Milestone 7 requires delivering the developer CLI and portable generated server capability for ChainMcp:

1. **Independent, Portable Execution:** Developers require standalone server deployments that package a single compiled contract without relying on a shared multi-contract gateway. The exported server must build and run independently from a clean installation without depending on the developer's local filesystem or monorepo infrastructure.
2. **Deterministic Manifests & Reproducibility:** Generating servers must not create non-deterministic drift. Identical contracts and generator versions must produce byte-identical files, and contract integrity must be cryptographically attested through a generation manifest (`chainmcp.manifest.json`).
3. **Shared Runtime Invariant (ADR 0002):** Generated servers must not duplicate policy, rate limiting, caching, authorization, SSRF protection, or JSON navigation implementations in generated source code. They must use the shared `@chainmcp/*` runtime packages directly.
4. **Developer Workflow & CLI Experience:** Developers need standardized commands for the end-to-end lifecycle: `init`, `validate`, `build`, `serve`, and `export`.
5. **Containerization:** Production deployments need audited Docker templates enforcing security controls (multi-stage build, non-root user, minimal image size).

## Decision

### 1. Developer CLI Package (`@chainmcp/cli`)

We introduced `@chainmcp/cli` with native Node.js argument parsing (`util.parseArgs`), zero external CLI framework dependencies, and strict async I/O conforming to `chainmcp/no-blocking-io`:

- **`chainmcp init` (`initCommand`):** Scaffolds a complete project from an OpenAPI contract (`--spec`), derives the project name from contract metadata, extracts the default base URL and allowed upstream host, and writes project configuration (`chainmcp.config.yaml`), TypeScript configs, and templates.
- **`chainmcp validate` (`validateCommand`):** Validates configuration against `ChainMcpConfigSchema`, compiles the OpenAPI contract using `compileOpenApi`, and reports compile diagnostics. Warns if `security.allowedUpstreamHosts` is empty.
- **`chainmcp build` (`buildCommand`):** Compiles the contract, emits `compiled-tools.json`, and writes `chainmcp.manifest.json`. Supports `--check` for reproducibility verification against an existing manifest.
- **`chainmcp serve` (`serveCommand`):** Binds the contract via `@chainmcp/executor` and `@chainmcp/core`, registers API tools and optional JSON navigation tools (`@chainmcp/json-navigation`), and starts the MCP server over stdio.
- **`chainmcp export` (`exportCommand`):** Exports a self-contained, portable project into `--output` containing pinned contract snapshots, configuration, deterministic manifest, standalone server entry point (`src/server.ts`), multi-stage `Dockerfile`, `.dockerignore`, `.gitignore`, and `README.md`.

### 2. Pinned Generation Manifest (`chainmcp.manifest.json`)

Exported and built projects emit a generation manifest containing:

- `manifestVersion: 1`
- `generatorVersion: CLI_VERSION`
- `compilerVersion: COMPILER_VERSION`
- `openapiVersion: OpenApiVersion`
- `projectName: string`
- `contractRevision: string` (canonical document SHA-256)
- `sourceHash: string` (raw source SHA-256)
- `toolsetHash: string` (combined tools SHA-256)
- `toolCount: number`
- `tools: [{ name, hash }]` (sorted operation hashes)
- `generatedAt: string`

The `verifyProjectManifest` helper verifies byte-identical contract revision, source hash, toolset hash, and tool definitions for deterministic reproducibility.

### 3. Server Template and Runtime Integration

The generated `src/server.ts`:

- Loads `chainmcp.config.yaml` using `@chainmcp/config`'s `parseConfig`.
- Compiles the pinned contract snapshot `spec/openapi.yaml` with `@chainmcp/compiler`.
- Constructs `@chainmcp/executor` using `buildExecutorOptions`.
- Constructs `@chainmcp/core` runtime using `buildRuntimeOptions`.
- Registers all compiled tools and JSON navigation tools.
- Serves stdio using `@chainmcp/server`'s `serveStdio`, or connects directly via `connectMcpServer` when an explicit transport is supplied.

### 4. Hardened Multi-Stage Dockerfile Template

The exported `Dockerfile` implements a two-stage build:

- Stage 1 (builder): Installs build dependencies, copies source and spec, and runs `npm run build`.
- Stage 2 (runner): Uses `node:20-alpine`, installs production dependencies only (`NODE_ENV=production`), copies `dist/`, `spec/`, and configuration, switches to non-root `USER node`, and defines `ENTRYPOINT ["node", "dist/server.js"]`.

## Alternatives considered

- **Generate raw TypeScript functions for each API operation:** Rejected. Inlining HTTP client code, auth logic, and error mapping directly into generated files would duplicate runtime behavior and create maintenance and security drift (violating ADR 0002).
- **Bundle CLI into `@chainmcp/compiler`:** Rejected. `@chainmcp/compiler` is an offline contract parser and compiler without filesystem or transport dependencies. The CLI belongs in a dedicated `@chainmcp/cli` package.
- **Use external CLI frameworks (e.g. Commander, Yargs):** Rejected. Node 20.11+ built-in `node:util` `parseArgs` provides type-safe, standard argument parsing with zero third-party dependencies.

## Consequences and trade-offs

- New package `@chainmcp/cli` added to monorepo and published with `bin: { chainmcp: "./dist/bin.js" }`.
- Exported servers build and run independently without repository linkage.
- Docker templates provide a turnkey container deployment path.

## Security implications

- Outbound SSRF protections (`allowedUpstreamHosts`, DNS pinning, private IP range blocking) are strictly preserved in exported servers.
- No secrets or credentials are ever embedded in generated project files or manifests.
- Multi-stage Docker template runs as non-privileged `node` user.

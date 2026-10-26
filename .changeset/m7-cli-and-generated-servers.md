---
"@chainmcp/cli": minor
"@chainmcp/server": minor
---

Implement Milestone 7: Developer CLI and Portable Generated Servers.

- Add `@chainmcp/cli` package providing developer CLI commands (`init`, `validate`, `build`, `serve`, `export`) using Node.js built-in `util.parseArgs` and strictly asynchronous I/O conforming to `chainmcp/no-blocking-io`.
- Implement `chainmcp export` to generate portable, self-contained MCP server projects with pinned contract snapshots, project configurations, TypeScript configs, multi-stage `Dockerfile` templates, `.dockerignore`, `.gitignore`, `README.md`, and deterministic manifests.
- Implement `chainmcp.manifest.json` generation and reproducibility verification (`verifyProjectManifest`).
- Export `Transport` type from `@chainmcp/server`.
- Add deployment documentation in `docs/deployment.md` covering stdio client integration, Docker containerization, process lifecycle, and SSRF security controls.
- Add end-to-end integration tests verifying clean compilation with `tsc`, independent execution, and MCP SDK protocol conformance.

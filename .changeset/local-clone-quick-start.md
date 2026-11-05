---
"@chainmcp/cli": patch
---

Local-clone quick start (P1-6): the README and getting-started docs now document the exact clone → build → init → serve → MCP client sequence, including the Claude Desktop config, and that sequence is executed end to end by `packages/cli/tests/quick-start.test.ts` in a temp directory (`initCommand` + offline `pnpm install` + `pnpm build` + in-process `tools/list`/`tools/call` + `dist/server.js` stdio round trip, launched through a symlinked project path). Registry `npx @chainmcp/cli` and bare `chainmcp` steps stay gated behind "after publishing"; a bare `chainmcp validate`/`build` pair in the product guide was replaced with the clone-path commands. `docs/capability-evidence.json` gained a `local-clone-quick-start` entry pointing at `initCommand` and the quick-start test.

Fixes a silent-startup bug found by that test: the generated server's main-module guard compared `process.argv[1]` with `fileURLToPath(import.meta.url)`, which differ whenever the entry path contains a symlink (macOS `/var` → `/private/var` temp directories, symlinked checkouts). The process started, printed nothing, and exited. The guard now compares real paths (`realpathSync`) and is covered by a template source test plus the symlinked stdio round trip. `examples/code-first/src/server.ts` had the same fragile guard and is fixed the same way.

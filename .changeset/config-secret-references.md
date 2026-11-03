---
"@chainmcp/config": minor
"@chainmcp/cli": minor
"@chainmcp/compiler": minor
---

Resolve credentials from the environment instead of literal config values.

- `@chainmcp/config` exports `resolveConfigSecrets()` and `redactConfigSecrets()`. Designated secret fields accept `${VAR}` and `${VAR:-default}`; missing variables fail with `SECRET_UNRESOLVED` naming the field and variable, and non-secret fields are never interpolated.
- `chainmcp config explain` prints the resolved configuration with credentials redacted, plus value-free provenance for each secret (`--json` supported).
- CLI `validate`, `serve`, `dev`, `gateway serve`, and generated server templates resolve secret references before schema validation.
- `chainmcp build` mirrors `chainmcp.manifest.json` and `compiled-tools.json` to the project root so generated servers can verify artifacts at startup.
- Documentation no longer lists the unimplemented `CHAINMCP_DATABASE_URL`, `CHAINMCP_UPSTREAM_TIMEOUT_MS`, and `CHAINMCP_SECRET_PROVIDER` variables.

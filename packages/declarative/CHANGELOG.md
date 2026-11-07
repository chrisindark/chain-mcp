# @chainmcp/declarative

## 0.4.0

### Patch Changes

- @chainmcp/compiler@0.4.0
  - @chainmcp/core@0.4.0
  - @chainmcp/executor@0.4.0

## 0.3.1

### Patch Changes

- Updated dependencies
  - @chainmcp/core@0.3.1
  - @chainmcp/compiler@0.3.1
  - @chainmcp/executor@0.3.1

## 0.3.0

### Minor Changes

- 26e83fe: Add `@chainmcp/declarative`, the first post-1.0 builder slice. `descriptorVersion: 1`
  JSON documents describe an HTTP tool (name, audited input schema, method,
  relative path, parameter/body bindings, auth references, and policy), are
  validated at load time with stable diagnostic codes, and lower into the
  existing bounded executor. Descriptors cannot contain absolute URLs,
  credentials, transport-owned headers, or code. `DeclarativeToolSource` binds
  validated descriptors to a deployment executor with deterministic
  `sha256:` revisions, so descriptor tools inherit the same SSRF, redirect,
  timeout, response-cap, authorization, cache, and output guarantees as compiled
  tools. `@chainmcp/executor` exports `isReservedRequestHeader()` and
  `isValidRequestHeaderName()` so descriptor validation and request building
  cannot drift.
- 180f2f0: Documentation truth pass (P0-8).

  - README now says the project is pre-1.0 and that the 1.0 release is deliberately withheld; registry `npx @chainmcp/cli` and bare `chainmcp` examples are marked as requiring publishing or an installed CLI (clone path is `node packages/cli/dist/bin.js`); intended technology no longer lists Hono or PostgreSQL (no database metadata store ships); token accounting, JSON navigation, response-schema enforcement, and auth-policy language match the shipped behavior.
  - `docs/getting-started.md`: response schemas are enforced by the executor when `server.validateResponses` is `warn`/`enforce`; authentication policies are not enforced by the compiler. Code-first init examples now include `--local-deps`.
  - `docs/deployment.md`: generated-server install and Dockerfile steps now use pnpm in local-deps mode.
  - `docs/product-guide.md`: softened `reduce payloads by up to 90%`, `sub-millisecond`, and `military-grade` marketing claims; corrected metric names to the four emitted by `OpenTelemetryMetricsSink` (`chainmcp.tool.invocations`, `chainmcp.tool.duration`, `chainmcp.tool.tokens`, `chainmcp.tool.payload_bytes`); clarified JSON navigation requires the full document supplied inline.
  - Added a CI drift guard: `pnpm docs:check` validates that every documented capability in `docs/capability-evidence.json` points to a real test file or exported API, and that the README `## Core capabilities` bullets are all covered. Wired into `pnpm check` and CI.

### Patch Changes

- 5ea3ece: Add package metadata, READMEs, licenses, engines, homepage, and repository links across all workspace packages for npm distribution.
- Updated dependencies [180f2f0]
- Updated dependencies [26e83fe]
- Updated dependencies [180f2f0]
- Updated dependencies [99483c5]
- Updated dependencies [f51ff52]
- Updated dependencies [147ef5e]
- Updated dependencies [8df778b]
- Updated dependencies [805c5a4]
- Updated dependencies [1bb1a2a]
- Updated dependencies [5f3f111]
- Updated dependencies [c371655]
- Updated dependencies [c214e77]
- Updated dependencies [46e3b31]
- Updated dependencies [8252a3a]
- Updated dependencies [998b681]
- Updated dependencies [8df778b]
- Updated dependencies [5ea3ece]
- Updated dependencies [8c8483c]
  - @chainmcp/compiler@0.3.0
  - @chainmcp/executor@0.3.0
  - @chainmcp/core@0.3.0

## 0.2.0

### Minor Changes

- 26e83fe: Add `@chainmcp/declarative`, the first post-1.0 builder slice. `descriptorVersion: 1`
  JSON documents describe an HTTP tool (name, audited input schema, method,
  relative path, parameter/body bindings, auth references, and policy), are
  validated at load time with stable diagnostic codes, and lower into the
  existing bounded executor. Descriptors cannot contain absolute URLs,
  credentials, transport-owned headers, or code. `DeclarativeToolSource` binds
  validated descriptors to a deployment executor with deterministic
  `sha256:` revisions, so descriptor tools inherit the same SSRF, redirect,
  timeout, response-cap, authorization, cache, and output guarantees as compiled
  tools. `@chainmcp/executor` exports `isReservedRequestHeader()` and
  `isValidRequestHeaderName()` so descriptor validation and request building
  cannot drift.
- 180f2f0: Documentation truth pass (P0-8).

  - README now says the project is pre-1.0 and that the 1.0 release is deliberately withheld; registry `npx @chainmcp/cli` and bare `chainmcp` examples are marked as requiring publishing or an installed CLI (clone path is `node packages/cli/dist/bin.js`); intended technology no longer lists Hono or PostgreSQL (no database metadata store ships); token accounting, JSON navigation, response-schema enforcement, and auth-policy language match the shipped behavior.
  - `docs/getting-started.md`: response schemas are enforced by the executor when `server.validateResponses` is `warn`/`enforce`; authentication policies are not enforced by the compiler. Code-first init examples now include `--local-deps`.
  - `docs/deployment.md`: generated-server install and Dockerfile steps now use pnpm in local-deps mode.
  - `docs/product-guide.md`: softened `reduce payloads by up to 90%`, `sub-millisecond`, and `military-grade` marketing claims; corrected metric names to the four emitted by `OpenTelemetryMetricsSink` (`chainmcp.tool.invocations`, `chainmcp.tool.duration`, `chainmcp.tool.tokens`, `chainmcp.tool.payload_bytes`); clarified JSON navigation requires the full document supplied inline.
  - Added a CI drift guard: `pnpm docs:check` validates that every documented capability in `docs/capability-evidence.json` points to a real test file or exported API, and that the README `## Core capabilities` bullets are all covered. Wired into `pnpm check` and CI.

### Patch Changes

- Updated dependencies [180f2f0]
- Updated dependencies [26e83fe]
- Updated dependencies [180f2f0]
- Updated dependencies
- Updated dependencies [99483c5]
- Updated dependencies [f51ff52]
- Updated dependencies [147ef5e]
- Updated dependencies [8df778b]
- Updated dependencies [805c5a4]
- Updated dependencies [1bb1a2a]
- Updated dependencies [5f3f111]
- Updated dependencies [c371655]
- Updated dependencies [c214e77]
- Updated dependencies [46e3b31]
- Updated dependencies [8252a3a]
- Updated dependencies [998b681]
- Updated dependencies [8df778b]
- Updated dependencies [8c8483c]
  - @chainmcp/compiler@0.2.0
  - @chainmcp/executor@0.2.0
  - @chainmcp/core@0.2.0

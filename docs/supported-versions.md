# Supported Versions Matrix

This document defines the supported runtime environments, protocol specifications, schema formats, and infrastructure dependencies for ChainMcp 1.0.

## 1. Runtime Environments

| Component             | Supported Versions                                     | Recommended                      | Notes                                                                     |
| :-------------------- | :----------------------------------------------------- | :------------------------------- | :------------------------------------------------------------------------ |
| **Node.js**           | `>=20.11.0` (Active LTS)                               | `22.x LTS`                       | Requires native ESM, `node:crypto`, `node:dns/promises`, and Web Streams. |
| **Package Manager**   | `pnpm >=9.0.0`                                         | `pnpm 11.0.0`                    | Monorepo uses pnpm workspaces and strict hoisting.                        |
| **Operating Systems** | Linux (`x86_64`, `aarch64`), macOS (`arm64`, `x86_64`) | Linux / Debian 12 or Alpine 3.20 | Container templates provided for multi-stage Docker deployment.           |

## 2. API & Protocol Specifications

| Protocol / Standard              | Version                              | Implementation / Compliance                                                                                                                                                                                                                                                           |
| :------------------------------- | :----------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Model Context Protocol (MCP)** | `2024-11-05` (Protocol 2.x)          | Official TypeScript SDK `@modelcontextprotocol/server` & `@modelcontextprotocol/client` pinned to `2.3.1`. Supports tools capability, `tools/list`, and `tools/call`.                                                                                                                 |
| **OpenAPI Specification**        | `3.0.0` – `3.0.3`, `3.1.0` – `3.1.1` | Compiled offline via `@chainmcp/compiler`. YAML 1.2 and JSON sources supported up to 25 MiB.                                                                                                                                                                                          |
| **JSON Schema**                  | Draft 2020-12 Subset                 | Audited input subset: primitives, enums, bounded strings (length, pattern, format), bounded numbers, bounded arrays (`minItems`, `maxItems`, `uniqueItems`), and bounded objects (`properties`, `required`, `additionalProperties: false`). Linear-time regex evaluation via `re2js`. |

## 3. Infrastructure & Backends

| Service                 | Version                  | Adapter Package         | Notes                                                                                                        |
| :---------------------- | :----------------------- | :---------------------- | :----------------------------------------------------------------------------------------------------------- |
| **In-Memory Cache**     | Built-in                 | `@chainmcp/core`        | Bounded memory with LRU eviction and byte-size capping.                                                      |
| **Distributed Cache**   | Redis `7.0+`             | `@chainmcp/cache-redis` | Key-prefixed cache isolation; per-command timeouts.                                                          |
| **Rate Limiting**       | Redis `7.0+`             | `@chainmcp/rate-limit`  | Atomic Lua scripting for rolling window quota checks and concurrency tracking. Denials roll back atomically. |
| **Telemetry / Metrics** | OpenTelemetry API `1.9+` | `@chainmcp/analytics`   | W3C trace context propagation, tool execution metrics, and rolling performance aggregators.                  |

## 4. Configuration Schema

| Schema                   | Version              | Validation Mode                                                             |
| :----------------------- | :------------------- | :-------------------------------------------------------------------------- |
| `chainmcp.config.yaml`   | `version: 1`         | Strict mode: unknown keys rejected via Zod `.strict()`.                     |
| `chainmcp.manifest.json` | `manifestVersion: 1` | Cryptographic integrity verification via SHA-256 toolset and source hashes. |

## 5. Deprecation Policy

- Support for Node.js versions follows the official Node.js Release Working Group lifecycle. Once a Node.js release reaches End of Life (EOL), support will be dropped in the subsequent minor or major release.
- Breaking changes to configuration schemas or public APIs adhere strictly to Semantic Versioning (`MAJOR.MINOR.PATCH`).

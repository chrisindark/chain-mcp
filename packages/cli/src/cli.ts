import { parseArgs } from "node:util";

import { buildCommand } from "./commands/build.js";
import { devCommand } from "./commands/dev.js";
import { diffCommand } from "./commands/diff.js";
import { exportCommand } from "./commands/export.js";
import { gatewayServeCommand } from "./commands/gateway-serve.js";
import { initCommand } from "./commands/init.js";
import { serveCommand } from "./commands/serve.js";
import { validateCommand } from "./commands/validate.js";
import { CLI_VERSION, type CliIo } from "./types.js";

const HELP_TEXT = `
ChainMcp CLI - Turn API contracts into production-ready Model Context Protocol (MCP) servers.

Usage:
  chainmcp <command> [options]

Commands:
  init      Initialize a new ChainMcp project (OpenAPI contract or blank code-first)
  validate  Validate configuration and OpenAPI contract
  build     Compile contract and emit generation manifest
  diff      Compare contract against baseline or previous manifest
  serve     Serve the MCP server over stdio
  gateway   Manage dynamic multi-contract MCP gateway (gateway serve)
  dev       Run local developer authoring loop (stdio)
  export    Export a self-contained, portable generated server project

Options:
  --version, -v   Show CLI version
  --help, -h      Show help information

Command options:
  init:
    --spec <path>        Path to OpenAPI specification (YAML/JSON)
    --blank              Scaffold a blank code-first project without contract
    --output <dir>       Target project directory (default: .)
    --name <name>        Project name
    --base-url <url>     Upstream base URL
    --force              Overwrite existing configuration if present

  validate:
    --config <path>      Path to chainmcp.config.yaml
    --spec <path>        Path to OpenAPI contract
    --strict             Enforce strict validation mode (default: true)
    --json               Emit validation result as JSON
    --allow-http         Permit plain HTTP for loopback/private hosts

  build:
    --config <path>      Path to chainmcp.config.yaml
    --spec <path>        Path to OpenAPI contract
    --out-dir <dir>      Output directory for build artifacts (default: ./dist)
    --check              Verify reproducibility against existing manifest

  diff:
    --config <path>      Path to chainmcp.config.yaml
    --spec <path>        Path to OpenAPI contract
    --against <target>   Baseline OpenAPI contract or manifest.json to compare against

  serve:
    --config <path>      Path to chainmcp.config.yaml
    --spec <path>        Path to OpenAPI contract
    --transport <type>   stdio | http (default: stdio, or config server.transport)
    --port <number>      HTTP port when transport is http (default: 3333)
    --host <string>      HTTP host when transport is http (default: 127.0.0.1)
    --path <string>      HTTP base endpoint path (default: /mcp)
    --allow-unauthenticated-http Explicitly allow unauthenticated HTTP on non-loopback hosts
    --base-url <url>     Override upstream base URL
    --tenant <id>        Tenant identifier for context (default: default)

  dev:
    --config <path>      Path to chainmcp.config.yaml
    --spec <path>        Path to OpenAPI contract (if contract-driven)
    --base-url <url>     Override upstream base URL
    --tenant <id>        Tenant identifier for context (default: default)

  gateway serve:
    --config <path>      Path to gateway.config.yaml (default: ./gateway.config.yaml)
    --transport <type>   stdio | http (default: stdio, or config server.transport)
    --port <number>      HTTP port when transport is http (default: 3333)
    --host <string>      HTTP host when transport is http (default: 127.0.0.1)
    --path <string>      HTTP base endpoint path (default: /mcp)
    --allow-unauthenticated-http Explicitly allow unauthenticated HTTP on non-loopback hosts

  export:
    --config <path>      Path to chainmcp.config.yaml
    --spec <path>        Path to OpenAPI contract
    --output <dir>       Output directory for generated server (default: ./generated-server)
    --force              Overwrite non-empty target directory
    --check              Verify deterministic reproducibility
`;

function asString(val: unknown): string | undefined {
  return typeof val === "string" ? val : undefined;
}

function asBoolean(val: unknown): boolean | undefined {
  return typeof val === "boolean" ? val : undefined;
}

export async function runCli(args: string[], io?: CliIo): Promise<number> {
  const log = io?.stdout ?? console.log;
  const errLog = io?.stderr ?? console.error;

  const { values, positionals } = parseArgs({
    args,
    options: {
      version: { type: "boolean", short: "v", default: false },
      help: { type: "boolean", short: "h", default: false },
      spec: { type: "string" },
      against: { type: "string" },
      config: { type: "string" },
      output: { type: "string" },
      name: { type: "string" },
      "base-url": { type: "string" },
      "out-dir": { type: "string" },
      transport: { type: "string" },
      port: { type: "string" },
      host: { type: "string" },
      path: { type: "string" },
      tenant: { type: "string" },
      blank: { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      strict: { type: "boolean", default: true },
      check: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      "allow-http": { type: "boolean", default: false },
      "allow-unauthenticated-http": { type: "boolean", default: false },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.version) {
    log(`chainmcp v${CLI_VERSION}`);
    return 0;
  }

  const command = positionals[0];
  if (!command || values.help) {
    log(HELP_TEXT.trim());
    return 0;
  }

  switch (command) {
    case "init": {
      const result = await initCommand({
        ...(asString(values.spec) !== undefined
          ? { spec: asString(values.spec) }
          : {}),
        ...(asString(values.output) !== undefined
          ? { output: asString(values.output) }
          : {}),
        ...(asString(values.name) !== undefined
          ? { name: asString(values.name) }
          : {}),
        ...(asString(values["base-url"]) !== undefined
          ? { baseUrl: asString(values["base-url"]) }
          : {}),
        ...(asBoolean(values["allow-http"]) !== undefined
          ? { allowHttp: asBoolean(values["allow-http"]) }
          : {}),
        ...(asBoolean(values.blank) !== undefined
          ? { blank: asBoolean(values.blank) }
          : {}),
        ...(asBoolean(values.force) !== undefined
          ? { force: asBoolean(values.force) }
          : {}),
      });

      if (!result.ok) {
        errLog(`Error: ${result.error ?? "Failed to initialize project."}`);
        return 1;
      }

      log(
        `Initialized ChainMcp project '${result.projectName}' in ${result.projectDir}`,
      );
      if (result.specPath) {
        log(
          `Contract: ${result.specPath} (${result.toolCount} tools compiled)`,
        );
      } else {
        log(
          `Blank code-first project initialized with example tool in src/tools.ts (${result.toolCount} tool defined)`,
        );
      }
      log(`Config: ${result.configPath}`);
      return 0;
    }

    case "validate": {
      const result = await validateCommand({
        ...(asString(values.config) !== undefined
          ? { config: asString(values.config) }
          : {}),
        ...(asString(values.spec) !== undefined
          ? { spec: asString(values.spec) }
          : {}),
        ...(asBoolean(values.strict) !== undefined
          ? { strict: asBoolean(values.strict) }
          : {}),
        ...(asBoolean(values["allow-http"]) !== undefined
          ? { allowHttp: asBoolean(values["allow-http"]) }
          : {}),
      });

      if (values.json) {
        log(JSON.stringify(result, null, 2));
        return result.ok ? 0 : 1;
      }

      for (const diag of result.diagnostics) {
        const prefix = diag.severity === "error" ? "ERROR" : "WARN";
        const loc = diag.location ? ` at ${diag.location}` : "";
        const formatted = `[${prefix}] [${diag.code}] ${diag.message}${loc}`;
        if (diag.severity === "error") {
          errLog(formatted);
        } else {
          log(formatted);
        }
      }

      if (!result.ok) {
        errLog(`Validation failed.`);
        return 1;
      }

      log(`Validation passed:`);
      log(`Contract revision: ${result.contractRevision}`);
      log(`Tools compiled: ${result.toolCount}`);
      log(`Toolset hash: ${result.toolsetHash}`);
      if (result.resolvedSource) {
        log(`Resolved source: ${result.resolvedSource}`);
      }
      if (result.specBytes !== undefined) {
        log(`Spec size: ${result.specBytes} bytes`);
      }
      return 0;
    }

    case "build": {
      const result = await buildCommand({
        ...(asString(values.config) !== undefined
          ? { config: asString(values.config) }
          : {}),
        ...(asString(values.spec) !== undefined
          ? { spec: asString(values.spec) }
          : {}),
        ...(asString(values["out-dir"]) !== undefined
          ? { outDir: asString(values["out-dir"]) }
          : {}),
        ...(asBoolean(values.strict) !== undefined
          ? { strict: asBoolean(values.strict) }
          : {}),
        ...(asBoolean(values.check) !== undefined
          ? { check: asBoolean(values.check) }
          : {}),
        ...(asBoolean(values["allow-http"]) !== undefined
          ? { allowHttp: asBoolean(values["allow-http"]) }
          : {}),
      });

      if (!result.ok) {
        errLog(`Build failed: ${result.error ?? "Unknown error"}`);
        return 1;
      }

      log(`Build succeeded:`);
      log(`Output directory: ${result.outDir}`);
      log(`Manifest: ${result.manifestPath}`);
      log(`Contract revision: ${result.manifest.contractRevision}`);
      log(`Tools: ${result.toolCount}`);
      if (result.verifiedReproducible) {
        log(`Reproducibility: verified (matches existing manifest)`);
      }
      return 0;
    }

    case "diff": {
      const result = await diffCommand({
        ...(asString(values.config) !== undefined
          ? { config: asString(values.config) }
          : {}),
        ...(asString(values.spec) !== undefined
          ? { spec: asString(values.spec) }
          : {}),
        ...(asString(values.against) !== undefined
          ? { against: asString(values.against) }
          : {}),
        ...(asBoolean(values["allow-http"]) !== undefined
          ? { allowHttp: asBoolean(values["allow-http"]) }
          : {}),
      });

      if (!result.ok) {
        errLog(`Diff error: ${result.error ?? "Failed to diff contracts"}`);
        return 1;
      }

      if (!result.hasChanges) {
        log(
          `No schema changes detected. Toolset is identical (hash: ${result.toolsetHash}).`,
        );
        return 0;
      }

      log(`Contract diff detected:`);
      log(`Contract revision: ${result.contractRevision}`);
      log(`Toolset hash: ${result.toolsetHash}`);
      if (result.addedTools.length > 0) {
        log(`  Added tools (${result.addedTools.length}):`);
        for (const t of result.addedTools) {
          log(`    + ${t}`);
        }
      }
      if (result.removedTools.length > 0) {
        log(`  Removed tools (BREAKING) (${result.removedTools.length}):`);
        for (const t of result.removedTools) {
          log(`    - ${t}`);
        }
      }
      if (result.changedTools.length > 0) {
        log(`  Modified tools (${result.changedTools.length}):`);
        for (const t of result.changedTools) {
          log(`    ~ ${t}`);
        }
      }
      if (result.hasBreakingChanges) {
        errLog(
          `Warning: Breaking changes detected (${result.removedTools.length} tools removed).`,
        );
      }
      return 0;
    }

    case "serve": {
      try {
        const portStr = asString(values.port);
        const parsedPort =
          portStr !== undefined ? Number.parseInt(portStr, 10) : undefined;
        const transport = asString(values.transport) as
          "stdio" | "http" | undefined;

        const result = await serveCommand({
          ...(asString(values.config) !== undefined
            ? { config: asString(values.config) }
            : {}),
          ...(asString(values.spec) !== undefined
            ? { spec: asString(values.spec) }
            : {}),
          ...(transport !== undefined ? { transport } : {}),
          ...(parsedPort !== undefined && !Number.isNaN(parsedPort)
            ? { port: parsedPort }
            : {}),
          ...(asString(values.host) !== undefined
            ? { host: asString(values.host) }
            : {}),
          ...(asString(values.path) !== undefined
            ? { path: asString(values.path) }
            : {}),
          ...(asBoolean(values["allow-http"]) !== undefined
            ? { allowHttp: asBoolean(values["allow-http"]) }
            : {}),
          ...(asBoolean(values["allow-unauthenticated-http"]) !== undefined
            ? {
                allowUnauthenticatedHttp: asBoolean(
                  values["allow-unauthenticated-http"],
                ),
              }
            : {}),
          ...(asString(values["base-url"]) !== undefined
            ? { baseUrl: asString(values["base-url"]) }
            : {}),
          ...(asString(values.tenant) !== undefined
            ? { tenantId: asString(values.tenant) }
            : {}),
          ...(io?.stdin !== undefined ? { stdin: io.stdin } : {}),
          ...(io?.stdoutStream !== undefined
            ? { stdout: io.stdoutStream }
            : {}),
        });

        if (result.url) {
          log(
            `Serving MCP server '${result.serverName}' over HTTP at ${result.url.toString()} (${result.toolCount} tools registered)...`,
          );
        } else {
          log(
            `Serving MCP server '${result.serverName}' over stdio (${result.toolCount} tools registered)...`,
          );
        }
        await result.closed;
        return 0;
      } catch (err) {
        errLog(
          `Server error: ${err instanceof Error ? err.message : String(err)}`,
        );
        return 1;
      }
    }

    case "dev": {
      try {
        const result = await devCommand({
          ...(asString(values.config) !== undefined
            ? { config: asString(values.config) }
            : {}),
          ...(asString(values.spec) !== undefined
            ? { spec: asString(values.spec) }
            : {}),
          ...(asBoolean(values["allow-http"]) !== undefined
            ? { allowHttp: asBoolean(values["allow-http"]) }
            : {}),
          ...(asString(values["base-url"]) !== undefined
            ? { baseUrl: asString(values["base-url"]) }
            : {}),
          ...(asString(values.tenant) !== undefined
            ? { tenantId: asString(values.tenant) }
            : {}),
          ...(io?.stdin !== undefined ? { stdin: io.stdin } : {}),
          ...(io?.stdoutStream !== undefined
            ? { stdout: io.stdoutStream }
            : {}),
        });

        log(
          `Serving development MCP server '${result.serverName}' over stdio (${result.toolCount} tools registered)...`,
        );
        await result.closed;
        return 0;
      } catch (err) {
        errLog(
          `Dev server error: ${err instanceof Error ? err.message : String(err)}`,
        );
        return 1;
      }
    }

    case "gateway": {
      const subCommand = positionals[1];
      if (subCommand === "serve") {
        try {
          const result = await gatewayServeCommand({
            ...(asString(values.config) !== undefined
              ? { config: asString(values.config) }
              : {}),
            ...(asString(values.transport) !== undefined
              ? {
                  transport: asString(values.transport) as "stdio" | "http",
                }
              : {}),
            ...(asString(values.port) !== undefined
              ? { port: Number.parseInt(asString(values.port)!, 10) }
              : {}),
            ...(asString(values.host) !== undefined
              ? { host: asString(values.host) }
              : {}),
            ...(asString(values.path) !== undefined
              ? { path: asString(values.path) }
              : {}),
            ...(asBoolean(values["allow-unauthenticated-http"]) !== undefined
              ? {
                  allowUnauthenticatedHttp: asBoolean(
                    values["allow-unauthenticated-http"],
                  ),
                }
              : {}),
            ...(io?.stdin !== undefined ? { stdin: io.stdin } : {}),
            ...(io?.stdoutStream !== undefined
              ? { stdout: io.stdoutStream }
              : {}),
          });

          if (result.url) {
            log(
              `Serving dynamic gateway '${result.serverName}' over Streamable HTTP at ${result.url.toString()} (${result.contractCount} contracts, ${result.totalToolCount} tools loaded)...`,
            );
          } else {
            log(
              `Serving dynamic gateway '${result.serverName}' over stdio (${result.contractCount} contracts, ${result.totalToolCount} tools loaded)...`,
            );
          }
          await result.closed;
          return 0;
        } catch (err) {
          errLog(
            `Gateway serve error: ${err instanceof Error ? err.message : String(err)}`,
          );
          return 1;
        }
      }

      errLog(
        `Unknown gateway subcommand: '${subCommand}'. Expected 'chainmcp gateway serve'.`,
      );
      return 1;
    }

    case "export": {
      const result = await exportCommand({
        ...(asString(values.config) !== undefined
          ? { config: asString(values.config) }
          : {}),
        ...(asString(values.spec) !== undefined
          ? { spec: asString(values.spec) }
          : {}),
        ...(asBoolean(values["allow-http"]) !== undefined
          ? { allowHttp: asBoolean(values["allow-http"]) }
          : {}),
        ...(asString(values.output) !== undefined
          ? { output: asString(values.output) }
          : {}),
        ...(asBoolean(values.force) !== undefined
          ? { force: asBoolean(values.force) }
          : {}),
        ...(asBoolean(values.check) !== undefined
          ? { check: asBoolean(values.check) }
          : {}),
      });

      if (!result.ok) {
        errLog(`Export failed: ${result.error ?? "Unknown error"}`);
        return 1;
      }

      log(`Export succeeded:`);
      log(`Exported project to: ${result.outputDir}`);
      log(`Files written: ${result.filesWritten.length}`);
      log(`Contract revision: ${result.manifest.contractRevision}`);
      log(`Tools compiled: ${result.manifest.toolCount}`);
      if (result.verifiedReproducible) {
        log(`Reproducibility: verified`);
      }
      return 0;
    }

    default: {
      errLog(
        `Unknown command: '${command}'. Run 'chainmcp --help' for available commands.`,
      );
      return 1;
    }
  }
}

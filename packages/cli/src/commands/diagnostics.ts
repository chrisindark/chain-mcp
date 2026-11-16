import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  StorageDescriptorRevisionStore,
  type DeclarativeAdminContractBinding,
} from "@chainmcp/admin";
import {
  analyzeTelemetryDiagnostics,
  type DiagnosticReport,
  type ToolDiagnosticDescriptor,
} from "@chainmcp/analytics";
import { compileOpenApi } from "@chainmcp/compiler";
import {
  createStorageDriverFromConfig,
  parseGatewayConfig,
  resolveConfigSecrets,
  type StorageConfig,
} from "@chainmcp/config";
import { MemoryStorageDriver, type StorageDriver } from "@chainmcp/storage";

import {
  findConfigPath,
  loadServerConfigFile,
  pathExists,
} from "../config-loader.js";
import type { CliIo } from "../types.js";

function parseWindowMs(window: string | number | undefined): number {
  if (typeof window === "number" && window > 0) return window;
  if (typeof window === "string") {
    const trimmed = window.trim().toLowerCase();
    if (trimmed.endsWith("h")) {
      const hours = Number(trimmed.slice(0, -1));
      if (!Number.isNaN(hours) && hours > 0) return hours * 3_600_000;
    }
    if (trimmed.endsWith("m")) {
      const minutes = Number(trimmed.slice(0, -1));
      if (!Number.isNaN(minutes) && minutes > 0) return minutes * 60_000;
    }
    if (trimmed.endsWith("d")) {
      const days = Number(trimmed.slice(0, -1));
      if (!Number.isNaN(days) && days > 0) return days * 86_400_000;
    }
    const ms = Number(trimmed);
    if (!Number.isNaN(ms) && ms > 0) return ms;
  }
  return 3_600_000; // default 1 hour
}

export interface DiagnosticsCommandOptions {
  readonly config?: string | undefined;
  readonly tenant?: string | undefined;
  readonly contract?: string | undefined;
  readonly tool?: string | undefined;
  readonly window?: number | string | undefined;
  readonly json?: boolean | undefined;
  readonly tokenBloatThreshold?: number | undefined;
  readonly cwd?: string | undefined;
  readonly io?: CliIo | undefined;
}

export interface DiagnosticsCommandResult {
  readonly ok: boolean;
  readonly report?: DiagnosticReport | undefined;
  readonly error?: string | undefined;
}

export async function diagnosticsCommand(
  options: DiagnosticsCommandOptions = {},
): Promise<DiagnosticsCommandResult> {
  const cwd = options.cwd ?? process.cwd();
  const log = options.io?.stdout ?? console.log;
  const errLog = options.io?.stderr ?? console.error;

  // 1. Resolve configuration file
  let configPath: string | undefined;
  if (options.config !== undefined) {
    const resolved = resolve(cwd, options.config);
    if (!(await pathExists(resolved))) {
      const err = `Configuration file not found: ${resolved}`;
      if (!options.json) errLog(err);
      return { ok: false, error: err };
    }
    configPath = resolved;
  } else {
    configPath = await findConfigPath({ cwd });
  }

  if (!configPath || !(await pathExists(configPath))) {
    const err = "No ChainMcp configuration file found in working directory";
    if (!options.json) errLog(err);
    return { ok: false, error: err };
  }

  // 2. Parse configuration
  let storageConfig: StorageConfig | undefined;
  const bindings: DeclarativeAdminContractBinding[] = [];
  const descriptors: ToolDiagnosticDescriptor[] = [];

  try {
    const rawYaml = await readFile(configPath, "utf8");
    const isGateway =
      rawYaml.includes("contracts:") ||
      configPath.includes("gateway.config") ||
      configPath.includes("chainmcp.gateway");

    if (isGateway) {
      const { parse: parseYaml } = await import("yaml");
      const parsedRaw = parseYaml(rawYaml);
      const resolved = resolveConfigSecrets(parsedRaw);
      const gatewayConfig = parseGatewayConfig(resolved.config);
      storageConfig = gatewayConfig.storage;

      if (Array.isArray(gatewayConfig.contracts)) {
        for (const contract of gatewayConfig.contracts) {
          if (options.tenant && contract.tenantId !== options.tenant) continue;
          if (options.contract && contract.name !== options.contract) continue;

          if (contract.destination) {
            bindings.push({
              tenantId: contract.tenantId,
              contractName: contract.name,
              destinationPolicy: {
                baseUrl: contract.destination.baseUrl,
                allowedHosts: [...contract.destination.allowedHosts],
              },
            });

            // If spec is available, compile to extract tools
            if (contract.spec) {
              const specFilePath = resolve(cwd, contract.spec);
              if (await pathExists(specFilePath)) {
                const specSource = await readFile(specFilePath, "utf8");
                try {
                  const compileRes = compileOpenApi(specSource);
                  for (const tool of compileRes.tools) {
                    descriptors.push({
                      contractName: contract.name,
                      name: tool.name,
                      method: tool.method.toUpperCase(),
                      requestMethod: tool.method.toUpperCase(),
                    });
                  }
                } catch {
                  // Ignore compilation failure; proceed with telemetry analysis
                }
              }
            }
          }
        }
      }
    } else {
      const serverConfig = await loadServerConfigFile(configPath);
      storageConfig = serverConfig.config.storage;
    }
  } catch (error) {
    const err = `Failed to parse configuration from ${configPath}: ${error instanceof Error ? error.message : String(error)}`;
    if (!options.json) errLog(err);
    return { ok: false, error: err };
  }

  // 3. Initialize storage driver
  let storageDriver: StorageDriver;
  if (storageConfig && storageConfig.enabled) {
    const configured = createStorageDriverFromConfig(storageConfig);
    storageDriver = configured ?? new MemoryStorageDriver();
  } else {
    storageDriver = new MemoryStorageDriver();
  }

  try {
    await storageDriver.init();
  } catch (error) {
    const err = `Failed to initialize storage driver: ${error instanceof Error ? error.message : String(error)}`;
    if (!options.json) errLog(err);
    return { ok: false, error: err };
  }

  // 4. Also inspect stored active revisions in storage if available
  const store = await StorageDescriptorRevisionStore.open(storageDriver);
  for (const b of bindings) {
    try {
      const active = await store.getActive(b.tenantId, b.contractName);
      if (active && Array.isArray(active.descriptors)) {
        for (const d of active.descriptors) {
          const existing = descriptors.find(
            (existingD) =>
              existingD.contractName === b.contractName &&
              existingD.name === d.name,
          );
          if (existing) {
            existing.policy = {
              cacheTtlSeconds: d.policy?.cacheTtlSeconds,
              maxOutputTokens: d.policy?.maxOutputTokens,
              outputFields: d.policy?.outputFields,
              timeoutMs: d.policy?.timeoutMs,
            };
          } else {
            descriptors.push({
              contractName: b.contractName,
              name: d.name,
              method: d.request.method,
              requestMethod: d.request.method,
              policy: {
                cacheTtlSeconds: d.policy?.cacheTtlSeconds,
                maxOutputTokens: d.policy?.maxOutputTokens,
                outputFields: d.policy?.outputFields,
                timeoutMs: d.policy?.timeoutMs,
              },
            });
          }
        }
      }
    } catch {
      // Ignore active revision retrieval error
    }
  }

  // 5. Query telemetry ring buffer
  const windowMs = parseWindowMs(options.window);
  const now = Date.now();
  const ring = storageDriver.getTelemetryRingBuffer();
  const rawEvents = await ring.query({
    ...(options.tenant ? { tenantId: options.tenant } : {}),
    ...(options.tool ? { toolName: options.tool } : {}),
    since: now - windowMs,
    until: now,
    limit: 10_000,
  });

  // 6. Run diagnostics analyzer
  const report = analyzeTelemetryDiagnostics(rawEvents, {
    now,
    windowMs,
    tenantId: options.tenant,
    descriptors,
    ...(options.tokenBloatThreshold !== undefined
      ? { tokenBloatThreshold: options.tokenBloatThreshold }
      : {}),
  });

  // 7. Output results
  if (options.json) {
    log(JSON.stringify(report, null, 2));
  } else {
    log("\n=======================================================");
    log("       ChainMcp Telemetry Diagnostics & Optimization   ");
    log("=======================================================\n");
    log(
      `Analyzed ${report.totalEventsAnalyzed} telemetry events across the last ${Math.round(windowMs / 60_000)} minutes.`,
    );
    log(
      `Found ${report.summary.totalHints} actionable optimization hint(s).\n`,
    );

    if (report.summary.totalHints > 0) {
      log(
        `- Potential Token Savings : ${report.summary.potentialTokenSavingsPercent}%`,
      );
      log(`- Bloated Tool Outputs    : ${report.summary.tokenBloatHints}`);
      log(
        `- Cache Opportunities     : ${report.summary.cacheOpportunityHints}`,
      );
      log(`- Slow Upstreams          : ${report.summary.slowUpstreamHints}`);
      log(`- High Error Rates        : ${report.summary.errorRateHints}\n`);

      log("--- Optimization Hints --------------------------------\n");
      for (const hint of report.hints) {
        const sevBadge =
          hint.severity === "critical"
            ? "[CRITICAL]"
            : hint.severity === "warning"
              ? "[WARNING] "
              : "[INFO]    ";
        log(`${sevBadge} ${hint.title}`);
        log(`           Tool     : ${hint.toolName} (${hint.contractName})`);
        log(`           Finding  : ${hint.message}`);
        log(`           Action   : ${hint.recommendation.action}`);
        if (hint.recommendation.suggestedOutputFields) {
          log(
            `           Proposal : outputFields = ${JSON.stringify(hint.recommendation.suggestedOutputFields)}`,
          );
        }
        if (hint.recommendation.suggestedCacheTtlSeconds) {
          log(
            `           Proposal : cacheTtlSeconds = ${hint.recommendation.suggestedCacheTtlSeconds}s`,
          );
        }
        if (hint.recommendation.suggestedTimeoutMs) {
          log(
            `           Proposal : timeoutMs = ${hint.recommendation.suggestedTimeoutMs}ms`,
          );
        }
        log("");
      }
    } else {
      log(
        "All inspected tools are operating cleanly within nominal token and latency thresholds.",
      );
    }
  }

  await storageDriver.close();
  return { ok: true, report };
}

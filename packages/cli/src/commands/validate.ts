import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

import { compileOpenApi, type CompileDiagnostic } from "@chainmcp/compiler";
import { parseConfig, type ChainMcpConfig } from "@chainmcp/config";

import type { ValidateOptions, ValidateResult } from "../types.js";

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function validateCommand(
  options: ValidateOptions,
): Promise<ValidateResult> {
  const cwd = options.cwd ?? process.cwd();

  // 1. Locate configuration
  let configPath = options.config
    ? resolve(cwd, options.config)
    : process.env.CHAINMCP_CONFIG
      ? resolve(cwd, process.env.CHAINMCP_CONFIG)
      : undefined;

  if (!configPath) {
    const candidateConfigs = [
      resolve(cwd, "chainmcp.config.yaml"),
      resolve(cwd, "chainmcp.config.yml"),
      resolve(cwd, "chainmcp.config.json"),
    ];
    for (const cand of candidateConfigs) {
      if (await fileExists(cand)) {
        configPath = cand;
        break;
      }
    }
  }

  let config: ChainMcpConfig | undefined;
  if (configPath && (await fileExists(configPath))) {
    try {
      const rawText = await readFile(configPath, "utf8");
      const parsed = parseYaml(rawText);
      config = parseConfig(parsed);
    } catch (err) {
      return {
        ok: false,
        configPath,
        toolCount: 0,
        toolNames: [],
        diagnostics: [
          {
            severity: "error",
            code: "DOCUMENT_INVALID",
            message: `Failed to parse configuration: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        error: `Invalid configuration at ${configPath}`,
      };
    }
  }

  // 2. Locate contract
  const configDir = configPath ? dirname(configPath) : cwd;
  let specPath = options.spec
    ? resolve(cwd, options.spec)
    : config?.contract?.source
      ? resolve(configDir, config.contract.source)
      : undefined;

  if (!specPath) {
    const candidateSpecs = [
      resolve(cwd, "spec/openapi.yaml"),
      resolve(cwd, "openapi.yaml"),
      resolve(cwd, "openapi.json"),
      resolve(cwd, "spec/openapi.json"),
    ];
    for (const cand of candidateSpecs) {
      if (await fileExists(cand)) {
        specPath = cand;
        break;
      }
    }
  }

  if (!specPath || !(await fileExists(specPath))) {
    return {
      ok: false,
      config,
      configPath,
      toolCount: 0,
      toolNames: [],
      diagnostics: [
        {
          severity: "error",
          code: "DOCUMENT_INVALID",
          message:
            "No OpenAPI contract found. Specify --spec <path> or declare contract.source in chainmcp.config.yaml.",
        },
      ],
      error: "Contract specification file not found.",
    };
  }

  // 3. Read and compile contract
  const specContent = await readFile(specPath, "utf8");
  const strictMode = options.strict ?? config?.contract?.strict ?? true;
  const compiled = compileOpenApi(specContent, { strict: strictMode });

  const diagnostics: CompileDiagnostic[] = [...compiled.diagnostics];

  // 4. Validate security configuration if config is present
  if (config) {
    if (config.security.allowedUpstreamHosts.length === 0) {
      diagnostics.push({
        severity: "warning",
        code: "SECURITY_INVALID",
        message:
          "security.allowedUpstreamHosts is empty. Outbound HTTP requests will fail closed.",
      });
    }
  }

  const hasErrors =
    diagnostics.some((d) => d.severity === "error") || !compiled.ok;

  return {
    ok: !hasErrors,
    config,
    configPath,
    specPath,
    contractRevision: compiled.contractRevision,
    sourceHash: compiled.sourceHash,
    toolsetHash: compiled.manifest.toolsetHash,
    toolCount: compiled.tools.length,
    toolNames: compiled.tools.map((t) => t.name),
    manifest: compiled.manifest,
    diagnostics,
    error: hasErrors ? "Validation failed with errors." : undefined,
  };
}

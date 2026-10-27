import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

import { compileOpenApi, type CompileDiagnostic } from "@chainmcp/compiler";
import { parseConfig, type ChainMcpConfig } from "@chainmcp/config";
import { normalizeAllowedHost } from "@chainmcp/executor";

import { loadSpec } from "../spec-loader.js";
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
  let rawParsedConfig: Record<string, unknown> | undefined;
  if (configPath && (await fileExists(configPath))) {
    try {
      const rawText = await readFile(configPath, "utf8");
      const parsed = parseYaml(rawText);
      rawParsedConfig =
        typeof parsed === "object" && parsed !== null
          ? (parsed as Record<string, unknown>)
          : undefined;
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

  // 2. Locate or fetch contract
  const configDir = configPath ? dirname(configPath) : cwd;
  let candidateSource = options.spec ?? config?.contract?.source;

  if (!candidateSource) {
    const candidateSpecs = [
      resolve(cwd, "spec/openapi.yaml"),
      resolve(cwd, "openapi.yaml"),
      resolve(cwd, "openapi.json"),
      resolve(cwd, "spec/openapi.json"),
    ];
    for (const cand of candidateSpecs) {
      if (await fileExists(cand)) {
        candidateSource = cand;
        break;
      }
    }
  }

  if (!candidateSource) {
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

  let specPath = "";
  let specContent = "";
  let resolvedSource = "";
  let specBytes = 0;

  try {
    const loaded = await loadSpec({
      source: candidateSource,
      cwd: options.spec ? cwd : configDir,
      allowHttp:
        options.allowHttp ?? config?.security?.allowInsecureHttp ?? false,
    });
    specPath = loaded.resolvedSource;
    specContent = loaded.content;
    resolvedSource = loaded.resolvedSource;
    specBytes = loaded.bytes;
  } catch (err) {
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
          message: err instanceof Error ? err.message : String(err),
        },
      ],
      error: `Could not fetch spec from ${candidateSource}`,
    };
  }

  // 3. Compile contract
  const strictMode = options.strict ?? config?.contract?.strict ?? true;
  const compiled = compileOpenApi(specContent, { strict: strictMode });

  const diagnostics: CompileDiagnostic[] = [...compiled.diagnostics];

  // 4. Validate security and contract configuration if config is present
  if (config) {
    if (config.contract?.baseUrl) {
      let parsedBase: URL | undefined;
      try {
        parsedBase = new URL(config.contract.baseUrl);
      } catch {
        // BaseUrlSchema parse already caught invalid URLs
      }

      if (parsedBase) {
        let baseHost: string;
        try {
          baseHost = normalizeAllowedHost(parsedBase.hostname);
        } catch {
          baseHost = parsedBase.hostname;
        }

        const rawSecurity = rawParsedConfig?.security as
          { allowedUpstreamHosts?: unknown[] } | undefined;
        const rawHosts = Array.isArray(rawSecurity?.allowedUpstreamHosts)
          ? rawSecurity.allowedUpstreamHosts.map((h) => {
              if (typeof h === "string") {
                try {
                  return normalizeAllowedHost(h);
                } catch {
                  return h;
                }
              }
              return "";
            })
          : [];

        if (!rawHosts.includes(baseHost)) {
          diagnostics.push({
            severity: "warning",
            code: "SECURITY_INVALID",
            message: `contract.baseUrl host '${baseHost}' was not declared in security.allowedUpstreamHosts; automatically added to allowlist.`,
          });
        }

        if (
          parsedBase.protocol === "http:" &&
          !config.security.allowInsecureHttp
        ) {
          diagnostics.push({
            severity: "error",
            code: "SECURITY_INVALID",
            message:
              "contract.baseUrl uses insecure HTTP ('http://'). Set security.allowInsecureHttp: true to permit insecure upstream traffic.",
          });
        }
      }
    } else if (config.contract?.source) {
      diagnostics.push({
        severity: "warning",
        code: "CONFIG_DEPRECATED",
        message:
          "contract.baseUrl is not configured. Falling back to allowedUpstreamHosts[0]. Configure contract.baseUrl to explicitly define the upstream target scheme, port, and path.",
      });
    }

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
    specContent,
    resolvedSource,
    specBytes,
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

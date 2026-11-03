import { redactConfigSecrets, SecretResolutionError } from "@chainmcp/config";

import {
  findConfigPath,
  loadServerConfigFile,
  pathExists,
} from "../config-loader.js";
import type { ConfigExplainOptions, ConfigExplainResult } from "../types.js";

/**
 * Print the resolved server configuration with every credential field
 * redacted. Secret values never leave this function, including in errors.
 */
export async function configExplainCommand(
  options: ConfigExplainOptions,
): Promise<ConfigExplainResult> {
  const cwd = options.cwd ?? process.cwd();
  const configPath = await findConfigPath({
    explicit: options.config,
    cwd,
    ...(options.env !== undefined ? { env: options.env } : {}),
  });

  if (!configPath) {
    return {
      ok: false,
      error: `No configuration file found in ${cwd}. Expected one of chainmcp.config.yaml, chainmcp.config.yml, chainmcp.config.json, or --config <path>.`,
    };
  }

  if (!(await pathExists(configPath))) {
    return {
      ok: false,
      configPath,
      error: `Configuration file not found: ${configPath}`,
    };
  }

  try {
    const loaded = await loadServerConfigFile(
      configPath,
      options.env !== undefined ? { env: options.env } : undefined,
    );

    return {
      ok: true,
      configPath,
      config: redactConfigSecrets(loaded.config),
      secretSources: loaded.secretSources,
    };
  } catch (err) {
    if (err instanceof SecretResolutionError) {
      return {
        ok: false,
        configPath,
        error: `[${err.code}] ${err.message}`,
      };
    }
    return {
      ok: false,
      configPath,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

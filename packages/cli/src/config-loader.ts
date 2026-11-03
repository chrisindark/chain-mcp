import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";

import {
  parseConfig,
  resolveConfigSecrets,
  type ChainMcpConfig,
  type SecretResolutionSource,
} from "@chainmcp/config";

export const DEFAULT_CONFIG_FILENAMES = [
  "chainmcp.config.yaml",
  "chainmcp.config.yml",
  "chainmcp.config.json",
] as const;

export interface FindConfigPathOptions {
  /** Explicit `--config` value, resolved relative to `cwd`. */
  readonly explicit?: string | undefined;
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Locate the server configuration file. `--config` wins, then
 * `CHAINMCP_CONFIG`, then the conventional filenames in `cwd`.
 */
export async function findConfigPath(
  options: FindConfigPathOptions,
): Promise<string | undefined> {
  if (options.explicit !== undefined && options.explicit.length > 0) {
    return resolve(options.cwd, options.explicit);
  }

  const env = options.env ?? process.env;
  const fromEnv = env.CHAINMCP_CONFIG;
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return resolve(options.cwd, fromEnv);
  }

  for (const candidate of DEFAULT_CONFIG_FILENAMES) {
    const resolved = resolve(options.cwd, candidate);
    if (await pathExists(resolved)) {
      return resolved;
    }
  }

  return undefined;
}

export interface LoadedServerConfig {
  readonly config: ChainMcpConfig;
  /** Raw YAML/JSON document with secret templates still unresolved. */
  readonly rawConfig: Record<string, unknown> | undefined;
  /** Value-free description of every designated secret field. */
  readonly secretSources: readonly SecretResolutionSource[];
}

/**
 * Read, resolve, and validate a server configuration file.
 *
 * Secret fields are resolved from the process environment before schema
 * validation, so a missing `${VAR}` fails here with the field and variable
 * named instead of producing a literal placeholder secret.
 */
export async function loadServerConfigFile(
  configPath: string,
  options?: {
    readonly env?: Readonly<Record<string, string | undefined>>;
  },
): Promise<LoadedServerConfig> {
  const rawText = await readFile(configPath, "utf8");
  const parsed = parseYaml(rawText);
  const rawConfig =
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;

  const resolved = resolveConfigSecrets(
    parsed,
    options?.env !== undefined ? { env: options.env } : undefined,
  );

  return {
    config: parseConfig(resolved.config),
    rawConfig,
    secretSources: resolved.sources,
  };
}

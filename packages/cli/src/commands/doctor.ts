import { redactConfigSecrets } from "@chainmcp/config";

import {
  findConfigPath,
  loadServerConfigFile,
  pathExists,
} from "../config-loader.js";

export interface DoctorOptions {
  config?: string | undefined;
  cwd?: string | undefined;
  json?: boolean | undefined;
}

export interface DoctorResult {
  ok: boolean;
  checks: Array<{ name: string; ok: boolean; detail?: string }>;
  error?: string | undefined;
}

export async function doctorCommand(
  options: DoctorOptions = {},
): Promise<DoctorResult> {
  const cwd = options.cwd ?? process.cwd();
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];
  try {
    const configPath = await findConfigPath({
      explicit: options.config,
      cwd,
    });
    if (!configPath) {
      checks.push({ name: "config", ok: false, detail: "not found" });
      return { ok: false, checks, error: "configuration file not found" };
    }
    if (!(await pathExists(configPath))) {
      checks.push({ name: "config", ok: false, detail: "missing file" });
      return {
        ok: false,
        checks,
        error: `configuration file not found: ${configPath}`,
      };
    }
    const loaded = await loadServerConfigFile(configPath);
    checks.push({ name: "config", ok: true, detail: configPath });
    checks.push({
      name: "auth",
      ok: true,
      detail: loaded.config.security.requireInboundAuth
        ? "required"
        : "optional",
    });
    void redactConfigSecrets;
    return { ok: true, checks };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    checks.push({ name: "config", ok: false, detail: message });
    return { ok: false, checks, error: message };
  }
}

import { readFile } from "node:fs/promises";

const PACKAGE_JSON_URL = new URL("../package.json", import.meta.url);

let cachedVersion: Promise<string> | undefined;

const SEMVER_PATTERN =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?(?:\+[0-9A-Za-z-.]+)?$/;

/**
 * Reads the CLI's own version from its `package.json`.
 *
 * The file is resolved relative to this module, so the same URL works from
 * `src/` during development and from `dist/` after build. The value is cached;
 * a failed read is not cached so a later call can retry.
 */
export function getCliVersion(): Promise<string> {
  cachedVersion ??= readVersion().catch((error: unknown) => {
    cachedVersion = undefined;
    throw error;
  });
  return cachedVersion;
}

async function readVersion(): Promise<string> {
  const raw = await readFile(PACKAGE_JSON_URL, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("CLI package.json must contain a JSON object");
  }
  const version = (parsed as { version?: unknown }).version;
  if (typeof version !== "string" || version.trim().length === 0) {
    throw new Error("CLI package.json is missing a string 'version' field");
  }
  const trimmed = version.trim();
  if (!SEMVER_PATTERN.test(trimmed)) {
    throw new Error(
      `CLI package.json has an invalid semver version: '${trimmed}'`,
    );
  }
  return trimmed;
}

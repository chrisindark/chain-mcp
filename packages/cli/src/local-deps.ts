import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import { CHAINMCP_PACKAGE_DEPENDENCIES } from "./templates.js";

export interface LocalDependencyOptions {
  /** Explicit path to the cloned ChainMcp repository root. */
  repoRoot: string;
  /** Directory that will contain the generated project's package.json. */
  projectDir: string;
}

export interface LocalDependencyResult {
  ok: boolean;
  /** Maps every required ChainMcp package to a relative `file:` specifier. */
  specs: Record<string, string>;
  repoRoot: string;
  error?: string | undefined;
}

/**
 * Resolves symlinks for the longest existing prefix of a path.
 *
 * macOS exposes temporary directories as `/var/...` while the real path is
 * `/private/var/...`. Package managers canonicalize the project directory, so
 * relative dependency specifiers must be computed from the canonical path.
 */
async function canonicalize(path: string): Promise<string> {
  const absolute = resolve(path);
  const missing: string[] = [];
  let current = absolute;

  for (;;) {
    try {
      const real = await realpath(current);
      return join(real, ...missing.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return absolute;
      missing.push(basename(current));
      current = parent;
    }
  }
}

async function readPackageName(
  packageDir: string,
): Promise<string | undefined> {
  try {
    const raw = await readFile(join(packageDir, "package.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const name = (parsed as { name?: unknown }).name;
    return typeof name === "string" && name.length > 0 ? name : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolves the ChainMcp workspace packages inside an explicit repository root
 * and turns them into `file:` specifiers relative to the generated project.
 *
 * Local mode is intentionally explicit: the repository root is always supplied
 * by the caller and is never inferred from the current working directory.
 */
export async function resolveLocalDependencySpecs(
  options: LocalDependencyOptions,
): Promise<LocalDependencyResult> {
  const repoRoot = await canonicalize(options.repoRoot);
  const projectDir = await canonicalize(options.projectDir);
  const packagesDir = join(repoRoot, "packages");

  let entries: string[];
  try {
    const packagesStat = await stat(packagesDir);
    if (!packagesStat.isDirectory()) {
      return failure(repoRoot, `'${packagesDir}' is not a directory`);
    }
    entries = await readdir(packagesDir);
  } catch {
    return failure(
      repoRoot,
      `'${packagesDir}' does not exist. Pass --local-deps with the root of a cloned ChainMcp repository.`,
    );
  }

  const packagesByName = new Map<string, string>();
  for (const entry of [...entries].sort()) {
    const packageDir = join(packagesDir, entry);
    const packageStat = await stat(packageDir).catch(() => undefined);
    if (!packageStat?.isDirectory()) continue;
    const name = await readPackageName(packageDir);
    if (name !== undefined) {
      packagesByName.set(name, packageDir);
    }
  }

  const missing = CHAINMCP_PACKAGE_DEPENDENCIES.filter(
    (name) => !packagesByName.has(name),
  );
  if (missing.length > 0) {
    return failure(
      repoRoot,
      `'${repoRoot}' is not a complete ChainMcp checkout; missing package(s): ${missing.join(", ")}`,
    );
  }

  const specs: Record<string, string> = {};
  for (const name of CHAINMCP_PACKAGE_DEPENDENCIES) {
    const packageDir = packagesByName.get(name)!;
    let relativePath = relative(projectDir, packageDir).split(sep).join("/");
    if (!relativePath.startsWith(".")) {
      relativePath = `./${relativePath}`;
    }
    specs[name] = `file:${relativePath}`;
  }

  return { ok: true, specs, repoRoot };
}

function failure(repoRoot: string, detail: string): LocalDependencyResult {
  return {
    ok: false,
    specs: {},
    repoRoot,
    error: `Local dependency resolution failed: ${detail}`,
  };
}

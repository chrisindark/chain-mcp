import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * pnpm error codes that mean "this machine has no registry metadata/tarballs
 * cached, so a fully offline install cannot resolve a semver range". These are
 * environment facts, not product failures: on a cold CI runner the generated
 * project still installs `@chainmcp/*` from `file:` links, but its
 * third-party dependencies (zod, yaml, TypeScript) legitimately need the
 * registry the first time.
 */
const COLD_STORE_CODES = [
  "ERR_PNPM_NO_OFFLINE_META",
  "ERR_PNPM_NO_OFFLINE_TARBALL",
] as const;

export interface GeneratedInstallResult {
  /** True when the install succeeded with no network access at all. */
  offline: boolean;
}

function errorOutput(error: unknown): { stdout: string; stderr: string } {
  if (typeof error !== "object" || error === null) {
    return { stdout: "", stderr: String(error) };
  }
  const record = error as Record<string, unknown>;
  return {
    stdout: typeof record.stdout === "string" ? record.stdout : "",
    stderr: typeof record.stderr === "string" ? record.stderr : "",
  };
}

async function runPnpm(args: string[], cwd: string): Promise<void> {
  try {
    await execFileAsync("pnpm", args, { cwd, timeout: 180_000 });
  } catch (error) {
    const { stdout, stderr } = errorOutput(error);
    throw new Error(
      `pnpm ${args.join(" ")} failed in ${cwd}.\nstdout: ${stdout}\nstderr: ${stderr}`,
      { cause: error },
    );
  }
}

/**
 * Installs a generated project without requiring a warm pnpm store.
 *
 * Tries a fully offline install first (the strongest claim: nothing is fetched
 * from a registry). On a cold store, pnpm cannot resolve semver ranges for
 * third-party dependencies, so it retries with `--prefer-offline`, which still
 * prefers the local store but allows the registry for anything missing.
 * `@chainmcp/*` never depends on that fallback — callers assert the links.
 */
export async function installGeneratedProject(
  projectDir: string,
): Promise<GeneratedInstallResult> {
  try {
    await runPnpm(["install", "--offline", "--ignore-scripts"], projectDir);
    return { offline: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!COLD_STORE_CODES.some((code) => message.includes(code))) {
      throw error;
    }
  }
  await runPnpm(
    ["install", "--prefer-offline", "--ignore-scripts"],
    projectDir,
  );
  return { offline: false };
}

async function readPackageJson(path: string): Promise<{
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
}> {
  return JSON.parse(await readFile(path, "utf8")) as {
    name?: string;
    version?: string;
    dependencies?: Record<string, string>;
  };
}

/**
 * Asserts that every `@chainmcp/*` dependency of a generated project is a
 * `file:` specifier and installed at the version the clone declares.
 *
 * pnpm materializes `file:` dependencies inside the project's own virtual
 * store, so the installed path is not inside the clone. Since no `@chainmcp/*`
 * package is published, a successful install is itself proof the packages came
 * from the clone; the version comparison catches a stale copy, and the spec
 * check catches a regression back to a registry range. This property holds
 * whether or not third-party dependencies had to be fetched.
 */
export async function assertChainMcpPackagesFromClone(
  projectDir: string,
  repoRoot: string,
): Promise<void> {
  const pkgJson = await readPackageJson(join(projectDir, "package.json"));
  const chainMcpDeps = Object.entries(pkgJson.dependencies ?? {}).filter(
    ([name]) => name.startsWith("@chainmcp/"),
  );
  if (chainMcpDeps.length === 0) {
    throw new Error(
      `${projectDir}/package.json declares no @chainmcp/* dependencies`,
    );
  }

  for (const [name, spec] of chainMcpDeps) {
    if (!spec.startsWith("file:")) {
      throw new Error(
        `${name} is declared as "${spec}"; local-clone mode must emit "file:" specifiers`,
      );
    }

    const installed = await readPackageJson(
      join(projectDir, "node_modules", name, "package.json"),
    ).catch(() => undefined);
    if (installed === undefined) {
      throw new Error(`${name} is not installed in ${projectDir}/node_modules`);
    }

    const packageDir = name.slice("@chainmcp/".length);
    const clonePackage = await readPackageJson(
      join(repoRoot, "packages", packageDir, "package.json"),
    );
    if (installed.version !== clonePackage.version) {
      throw new Error(
        `${name} installed at ${String(installed.version)} but the clone declares ${String(clonePackage.version)}`,
      );
    }
  }
}

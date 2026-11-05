import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  assertChainMcpPackagesFromClone,
  installGeneratedProject,
} from "./support/generated-install.js";

/**
 * These tests pin the cold-store contract without needing a cold pnpm store.
 *
 * A real CI runner has no cached registry metadata, so `pnpm install --offline`
 * legitimately fails with ERR_PNPM_NO_OFFLINE_META while `@chainmcp/*` are
 * still satisfied from `file:` links. Forcing that state locally is not
 * reliable (pnpm re-fetches its own tarball when the store is redirected), so
 * a fake `pnpm` on PATH reproduces the exact exit codes and lets the real
 * helper logic run unmodified.
 */
const posixOnly = process.platform === "win32" ? it.skip : it;

const FAKE_PNPM = `#!/bin/sh
echo "$@" >> "$FAKE_PNPM_LOG"
if [ "$1" = "install" ]; then
  case " $* " in
    *" --offline "*)
      if [ "$FAKE_PNPM_OFFLINE_FAILS" = "1" ]; then
        echo "$FAKE_PNPM_OFFLINE_ERROR" >&2
        exit 1
      fi
      ;;
  esac
fi
exit 0
`;

let tempDir: string;
let binDir: string;
let projectDir: string;
let logPath: string;
let originalPath: string | undefined;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "chainmcp-generated-install-"));
  binDir = join(tempDir, "bin");
  projectDir = join(tempDir, "project");
  logPath = join(tempDir, "pnpm.log");
  await mkdir(binDir, { recursive: true });
  await mkdir(projectDir, { recursive: true });
  const fakePnpm = join(binDir, "pnpm");
  await writeFile(fakePnpm, FAKE_PNPM, "utf8");
  await chmod(fakePnpm, 0o755);

  originalPath = process.env.PATH;
  process.env.PATH = `${binDir}:${originalPath ?? ""}`;
  process.env.FAKE_PNPM_LOG = logPath;
});

afterEach(async () => {
  process.env.PATH = originalPath;
  delete process.env.FAKE_PNPM_LOG;
  delete process.env.FAKE_PNPM_OFFLINE_FAILS;
  delete process.env.FAKE_PNPM_OFFLINE_ERROR;
  await rm(tempDir, { recursive: true, force: true });
});

async function invocations(): Promise<string[]> {
  const log = await readFile(logPath, "utf8").catch(() => "");
  return log.split("\n").filter((line) => line.length > 0);
}

describe("installGeneratedProject", () => {
  posixOnly("keeps the fully offline install when it succeeds", async () => {
    const result = await installGeneratedProject(projectDir);

    expect(result).toEqual({ offline: true });
    expect(await invocations()).toEqual(["install --offline --ignore-scripts"]);
  });

  posixOnly(
    "retries with --prefer-offline on a cold metadata store",
    async () => {
      process.env.FAKE_PNPM_OFFLINE_FAILS = "1";
      process.env.FAKE_PNPM_OFFLINE_ERROR =
        "ERR_PNPM_NO_OFFLINE_META: Failed to resolve @types/node@>=22.19.0 <23.0.0-0";

      const result = await installGeneratedProject(projectDir);

      expect(result).toEqual({ offline: false });
      expect(await invocations()).toEqual([
        "install --offline --ignore-scripts",
        "install --prefer-offline --ignore-scripts",
      ]);
    },
  );

  posixOnly("retries when a tarball is missing from the store", async () => {
    process.env.FAKE_PNPM_OFFLINE_FAILS = "1";
    process.env.FAKE_PNPM_OFFLINE_ERROR =
      "ERR_PNPM_NO_OFFLINE_TARBALL: typescript@5.9.3";

    const result = await installGeneratedProject(projectDir);

    expect(result).toEqual({ offline: false });
    expect(await invocations()).toHaveLength(2);
  });

  posixOnly("does not swallow unrelated install failures", async () => {
    process.env.FAKE_PNPM_OFFLINE_FAILS = "1";
    process.env.FAKE_PNPM_OFFLINE_ERROR = "ERR_PNPM_LOCKFILE_BREAKING_CHANGE";

    await expect(installGeneratedProject(projectDir)).rejects.toThrow(
      "ERR_PNPM_LOCKFILE_BREAKING_CHANGE",
    );
    expect(await invocations()).toEqual(["install --offline --ignore-scripts"]);
  });
});

describe("assertChainMcpPackagesFromClone", () => {
  let cloneRoot: string;

  beforeEach(async () => {
    cloneRoot = join(tempDir, "clone");
    await mkdir(join(cloneRoot, "packages", "core"), { recursive: true });
    await writeFile(
      join(cloneRoot, "packages", "core", "package.json"),
      JSON.stringify({ name: "@chainmcp/core", version: "0.2.0" }),
      "utf8",
    );
    await mkdir(join(projectDir, "node_modules", "@chainmcp", "core"), {
      recursive: true,
    });
    await writeFile(
      join(projectDir, "node_modules", "@chainmcp", "core", "package.json"),
      JSON.stringify({ name: "@chainmcp/core", version: "0.2.0" }),
      "utf8",
    );
  });

  async function writeProjectPackageJson(dependencies: Record<string, string>) {
    await writeFile(
      join(projectDir, "package.json"),
      JSON.stringify({ name: "generated", dependencies }),
      "utf8",
    );
  }

  it("accepts a file: dependency at the clone's version", async () => {
    await writeProjectPackageJson({
      "@chainmcp/core": "file:../clone/packages/core",
    });

    await expect(
      assertChainMcpPackagesFromClone(projectDir, cloneRoot),
    ).resolves.toBeUndefined();
  });

  it("rejects a registry specifier", async () => {
    await writeProjectPackageJson({ "@chainmcp/core": "^0.2.0" });

    await expect(
      assertChainMcpPackagesFromClone(projectDir, cloneRoot),
    ).rejects.toThrow(/must emit "file:" specifiers/);
  });

  it("rejects a stale copy that drifted from the clone", async () => {
    await writeProjectPackageJson({
      "@chainmcp/core": "file:../clone/packages/core",
    });
    await writeFile(
      join(cloneRoot, "packages", "core", "package.json"),
      JSON.stringify({ name: "@chainmcp/core", version: "0.3.0" }),
      "utf8",
    );

    await expect(
      assertChainMcpPackagesFromClone(projectDir, cloneRoot),
    ).rejects.toThrow(/installed at 0\.2\.0 but the clone declares 0\.3\.0/);
  });

  it("rejects a project that installed nothing", async () => {
    await writeProjectPackageJson({
      "@chainmcp/core": "file:../clone/packages/core",
    });
    await rm(join(projectDir, "node_modules"), {
      recursive: true,
      force: true,
    });

    await expect(
      assertChainMcpPackagesFromClone(projectDir, cloneRoot),
    ).rejects.toThrow(/is not installed/);
  });
});

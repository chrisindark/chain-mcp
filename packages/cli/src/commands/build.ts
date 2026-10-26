import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { compileOpenApi } from "@chainmcp/compiler";

import { buildProjectManifest, verifyProjectManifest } from "../manifest.js";
import type { BuildOptions, BuildResult, ProjectManifest } from "../types.js";
import { validateCommand } from "./validate.js";

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function buildCommand(
  options: BuildOptions,
): Promise<BuildResult> {
  const cwd = options.cwd ?? process.cwd();
  const outDir = options.outDir
    ? resolve(cwd, options.outDir)
    : resolve(cwd, "dist");

  // 1. Run validation
  const validation = await validateCommand({
    config: options.config,
    spec: options.spec,
    strict: options.strict,
    cwd,
  });

  if (!validation.ok || !validation.specPath) {
    const errorDetails = validation.diagnostics
      .filter((d) => d.severity === "error")
      .map((d) => `[${d.code}] ${d.message}`)
      .join("; ");
    return {
      ok: false,
      outDir,
      manifestPath: "",
      manifest: {} as ProjectManifest,
      toolCount: 0,
      error: `Build failed: ${errorDetails || validation.error || "Validation error"}`,
    };
  }

  // 2. Read spec and compile
  let specContent = validation.specContent;
  if (!specContent && validation.specPath) {
    if (
      validation.specPath.startsWith("http://") ||
      validation.specPath.startsWith("https://")
    ) {
      const res = await fetch(validation.specPath);
      specContent = await res.text();
    } else {
      specContent = await readFile(validation.specPath, "utf8");
    }
  }

  if (!specContent) {
    return {
      ok: false,
      outDir,
      manifestPath: "",
      manifest: {} as ProjectManifest,
      toolCount: 0,
      error: "Build failed: Contract content could not be retrieved.",
    };
  }

  const compiled = compileOpenApi(specContent, {
    strict: options.strict ?? validation.config?.contract?.strict ?? true,
  });

  if (!compiled.ok) {
    return {
      ok: false,
      outDir,
      manifestPath: "",
      manifest: {} as ProjectManifest,
      toolCount: 0,
      error: "Build failed: Compiler returned errors.",
    };
  }

  // 3. Build project manifest
  const projectName = validation.config?.name ?? "chainmcp-server";
  const manifest = buildProjectManifest(projectName, compiled);
  const manifestPath = join(outDir, "chainmcp.manifest.json");

  // 4. Reproducibility check if requested
  let verifiedReproducible: boolean | undefined;
  if (options.check) {
    if (await fileExists(manifestPath)) {
      const existingRaw = await readFile(manifestPath, "utf8");
      const existing = JSON.parse(existingRaw) as ProjectManifest;
      const verification = verifyProjectManifest(existing, manifest);
      if (!verification.match) {
        return {
          ok: false,
          outDir,
          manifestPath,
          manifest,
          toolCount: compiled.tools.length,
          verifiedReproducible: false,
          error: `Reproducibility check failed: ${verification.mismatches.join("; ")}`,
        };
      }
      verifiedReproducible = true;
    }
  }

  // 5. Ensure outDir exists and emit artifacts
  await mkdir(outDir, { recursive: true });

  await writeFile(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );

  const toolsPath = join(outDir, "compiled-tools.json");
  await writeFile(
    toolsPath,
    `${JSON.stringify(compiled.tools, null, 2)}\n`,
    "utf8",
  );

  return {
    ok: true,
    outDir,
    manifestPath,
    manifest,
    toolCount: compiled.tools.length,
    verifiedReproducible,
  };
}

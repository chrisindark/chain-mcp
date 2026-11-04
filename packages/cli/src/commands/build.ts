import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { compileOpenApi } from "@chainmcp/compiler";

import { loadCodeFirstTools } from "../code-first-loader.js";
import {
  attachCompiledToolsArtifact,
  buildCodeFirstManifest,
  buildProjectManifest,
  serializeCompiledTools,
  verifyProjectManifest,
} from "../manifest.js";
import { loadSpec } from "../spec-loader.js";
import type { BuildOptions, BuildResult, ProjectManifest } from "../types.js";
import { getCliVersion } from "../version.js";
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
  const cwd =
    options.cwd ??
    (options.config
      ? dirname(resolve(process.cwd(), options.config))
      : process.cwd());
  const outDir = options.outDir
    ? resolve(cwd, options.outDir)
    : resolve(cwd, "dist");
  const version = await getCliVersion();

  // 1. Run validation
  const validation = await validateCommand({
    config: options.config,
    spec: options.spec,
    strict: options.strict,
    allowHttp: options.allowHttp,
    requireContract: options.requireContract,
    tools: options.tools,
    cwd,
  });

  if (!validation.ok) {
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

  const projectName = validation.config?.name ?? "chainmcp-server";
  const manifestPath = join(outDir, "chainmcp.manifest.json");

  // Handle code-first project build
  if (validation.contractKind === "code-first") {
    const loaded = await loadCodeFirstTools({
      cwd,
      injectedTools: options.tools,
    });

    if (loaded.tools.length === 0) {
      return {
        ok: false,
        outDir,
        manifestPath: "",
        manifest: {} as ProjectManifest,
        toolCount: 0,
        error:
          "Build failed: Cannot build code-first project: no tools could be loaded from entrypoint. Define and export tools in src/tools.ts or compile TypeScript files first with 'tsc'.",
      };
    }

    const compiledTools = loaded.tools.map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: t.inputSchema ?? {},
    }));
    const serialized = serializeCompiledTools(compiledTools);
    const manifest = attachCompiledToolsArtifact(
      buildCodeFirstManifest(projectName, loaded.tools, {
        generatorVersion: version,
      }),
      serialized.artifact,
    );

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
            toolCount: loaded.tools.length,
            verifiedReproducible: false,
            error: `Reproducibility check failed: ${verification.mismatches.join("; ")}`,
          };
        }
        verifiedReproducible = true;
      }
    }

    const manifestContent = `${JSON.stringify(manifest, null, 2)}\n`;
    await mkdir(outDir, { recursive: true });
    await writeFile(manifestPath, manifestContent, "utf8");

    const toolsPath = join(outDir, "compiled-tools.json");
    await writeFile(toolsPath, serialized.content, "utf8");
    await writeRootArtifacts(cwd, manifestContent, serialized.content);

    return {
      ok: true,
      outDir,
      manifestPath,
      manifest,
      toolCount: loaded.tools.length,
      verifiedReproducible,
    };
  }

  // 2. Read spec and compile (reuse loaded specContent from validation to avoid re-fetching)
  let specContent = validation.specContent;
  if (!specContent && validation.specPath) {
    const loaded = await loadSpec({
      source: validation.specPath,
      cwd,
      allowHttp:
        options.allowHttp ?? validation.config?.security?.allowInsecureHttp,
    });
    specContent = loaded.content;
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

  // 3. Build project manifest with compiled-artifact integrity metadata
  const serialized = serializeCompiledTools(compiled.tools, {
    contractRevision: compiled.contractRevision,
  });
  const manifest = attachCompiledToolsArtifact(
    buildProjectManifest(projectName, compiled, { generatorVersion: version }),
    serialized.artifact,
  );

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
  const manifestContent = `${JSON.stringify(manifest, null, 2)}\n`;
  await mkdir(outDir, { recursive: true });

  await writeFile(manifestPath, manifestContent, "utf8");

  const toolsPath = join(outDir, "compiled-tools.json");
  await writeFile(toolsPath, serialized.content, "utf8");
  await writeRootArtifacts(cwd, manifestContent, serialized.content);

  return {
    ok: true,
    outDir,
    manifestPath,
    manifest,
    toolCount: compiled.tools.length,
    verifiedReproducible,
  };
}

/**
 * Generated servers read `chainmcp.manifest.json` from the project root and
 * `dist/compiled-tools.json` at startup. Build output stays in `outDir`, so
 * mirror the root copies that `export` already writes and that the
 * documentation promises for `chainmcp build`.
 */
async function writeRootArtifacts(
  projectDir: string,
  manifestContent: string,
  compiledToolsContent: string,
): Promise<void> {
  await writeFile(
    join(projectDir, "chainmcp.manifest.json"),
    manifestContent,
    "utf8",
  );
  await writeFile(
    join(projectDir, "compiled-tools.json"),
    compiledToolsContent,
    "utf8",
  );
}

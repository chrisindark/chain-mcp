import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { compileOpenApi } from "@chainmcp/compiler";

import { buildProjectManifest, verifyProjectManifest } from "../manifest.js";
import {
  renderConfigYaml,
  renderDockerfile,
  renderDockerignore,
  renderGitignore,
  renderPackageJson,
  renderReadme,
  renderServerTs,
  renderToolsTs,
  renderTsconfigBuildJson,
  renderTsconfigJson,
} from "../templates.js";
import type { ExportOptions, ExportResult, ProjectManifest } from "../types.js";
import { validateCommand } from "./validate.js";

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function isDirectoryEmpty(path: string): Promise<boolean> {
  try {
    const entries = await readdir(path);
    return entries.length === 0;
  } catch {
    return true;
  }
}

export async function exportCommand(
  options: ExportOptions,
): Promise<ExportResult> {
  const cwd = options.cwd ?? process.cwd();
  const outputDir = resolve(cwd, options.output ?? "./generated-server");

  // 1. Validate configuration and contract
  const validation = await validateCommand({
    config: options.config,
    spec: options.spec,
    cwd,
  });

  if (!validation.ok || !validation.specPath) {
    const errorDetails = validation.diagnostics
      .filter((d) => d.severity === "error")
      .map((d) => `[${d.code}] ${d.message}`)
      .join("; ");
    return {
      ok: false,
      outputDir,
      manifest: {} as ProjectManifest,
      filesWritten: [],
      error: `Export failed: ${errorDetails || validation.error || "Validation error"}`,
    };
  }

  // 2. Check target directory emptiness unless --force is set
  if (!options.force && (await fileExists(outputDir))) {
    const empty = await isDirectoryEmpty(outputDir);
    if (!empty) {
      return {
        ok: false,
        outputDir,
        manifest: {} as ProjectManifest,
        filesWritten: [],
        error: `Target directory '${outputDir}' is not empty. Use --force to overwrite.`,
      };
    }
  }

  // 3. Read and compile contract
  const specContent = await readFile(validation.specPath, "utf8");
  const compiled = compileOpenApi(specContent, {
    strict: validation.config?.contract?.strict ?? true,
  });

  if (!compiled.ok) {
    return {
      ok: false,
      outputDir,
      manifest: {} as ProjectManifest,
      filesWritten: [],
      error: "Export failed: Contract compilation returned errors.",
    };
  }

  // 4. Build deterministic manifest
  const projectName = validation.config?.name ?? "chainmcp-server";
  const manifest = buildProjectManifest(projectName, compiled);

  // 5. Ensure directory structure
  await mkdir(outputDir, { recursive: true });
  await mkdir(join(outputDir, "spec"), { recursive: true });
  await mkdir(join(outputDir, "src"), { recursive: true });

  const filesWritten: string[] = [];

  // Pinned contract snapshot
  const targetSpecPath = join(outputDir, "spec", "openapi.yaml");
  await writeFile(targetSpecPath, specContent, "utf8");
  filesWritten.push("spec/openapi.yaml");

  // Generation manifest
  const manifestPath = join(outputDir, "chainmcp.manifest.json");
  await writeFile(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  filesWritten.push("chainmcp.manifest.json");

  // Project configuration
  const allowedHosts = validation.config?.security.allowedUpstreamHosts ?? [
    "api.example.com",
  ];
  const configYaml = renderConfigYaml({
    name: projectName,
    allowedHosts,
    specRelativePath: "./spec/openapi.yaml",
    baseUrl: validation.config?.contract?.baseUrl,
    allowInsecureHttp: validation.config?.security.allowInsecureHttp,
  });
  await writeFile(join(outputDir, "chainmcp.config.yaml"), configYaml, "utf8");
  filesWritten.push("chainmcp.config.yaml");

  // package.json
  const packageJson = renderPackageJson({
    name: projectName,
    workspaceDependencies: options.workspaceDependencies,
    dependencyOverrides: options.dependencyOverrides,
  });
  await writeFile(join(outputDir, "package.json"), packageJson, "utf8");
  filesWritten.push("package.json");

  // TypeScript configs
  await writeFile(
    join(outputDir, "tsconfig.json"),
    renderTsconfigJson(),
    "utf8",
  );
  filesWritten.push("tsconfig.json");
  await writeFile(
    join(outputDir, "tsconfig.build.json"),
    renderTsconfigBuildJson(),
    "utf8",
  );
  filesWritten.push("tsconfig.build.json");

  // Standalone server source
  await writeFile(
    join(outputDir, "src", "server.ts"),
    renderServerTs(),
    "utf8",
  );
  filesWritten.push("src/server.ts");
  await writeFile(join(outputDir, "src", "tools.ts"), renderToolsTs(), "utf8");
  filesWritten.push("src/tools.ts");

  // Docker templates & ignores
  await writeFile(join(outputDir, "Dockerfile"), renderDockerfile(), "utf8");
  filesWritten.push("Dockerfile");
  await writeFile(
    join(outputDir, ".dockerignore"),
    renderDockerignore(),
    "utf8",
  );
  filesWritten.push(".dockerignore");
  await writeFile(join(outputDir, ".gitignore"), renderGitignore(), "utf8");
  filesWritten.push(".gitignore");

  // README.md
  await writeFile(
    join(outputDir, "README.md"),
    renderReadme({
      name: projectName,
      toolCount: compiled.tools.length,
      contractRevision: compiled.contractRevision,
    }),
    "utf8",
  );
  filesWritten.push("README.md");

  // 6. Reproducibility check if requested
  let verifiedReproducible: boolean | undefined;
  if (options.check) {
    const recompilation = compileOpenApi(specContent, {
      strict: validation.config?.contract?.strict ?? true,
    });
    const recompiledManifest = buildProjectManifest(projectName, recompilation);
    const verification = verifyProjectManifest(manifest, recompiledManifest);
    if (!verification.match) {
      return {
        ok: false,
        outputDir,
        manifest,
        filesWritten,
        verifiedReproducible: false,
        error: `Reproducibility verification failed: ${verification.mismatches.join("; ")}`,
      };
    }
    verifiedReproducible = true;
  }

  return {
    ok: true,
    outputDir,
    manifest,
    filesWritten,
    verifiedReproducible,
  };
}

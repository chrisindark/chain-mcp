import { copyFile, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { compileOpenApi } from "@chainmcp/compiler";

import { loadCodeFirstTools } from "../code-first-loader.js";
import { resolveLocalDependencySpecs } from "../local-deps.js";
import {
  buildCodeFirstManifest,
  buildProjectManifest,
  verifyProjectManifest,
} from "../manifest.js";
import { loadSpec } from "../spec-loader.js";
import { getCliVersion } from "../version.js";
import {
  renderConfigYaml,
  renderDockerfile,
  renderDockerignore,
  renderGitignore,
  renderPackageJson,
  renderPnpmWorkspaceYaml,
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
  const cwd =
    options.cwd ??
    (options.config
      ? dirname(resolve(process.cwd(), options.config))
      : process.cwd());
  const outputDir = resolve(cwd, options.output ?? "./generated-server");
  const version = options.version ?? (await getCliVersion());

  if (
    options.localDeps !== undefined &&
    options.workspaceDependencies === true
  ) {
    return {
      ok: false,
      outputDir,
      manifest: {} as ProjectManifest,
      filesWritten: [],
      error:
        "Choose either --local-deps (file: dependencies) or --workspace-deps (workspace:*), not both.",
    };
  }

  let dependencySpecs: Record<string, string> | undefined;
  if (options.localDeps !== undefined) {
    const local = await resolveLocalDependencySpecs({
      repoRoot: options.localDeps,
      projectDir: outputDir,
    });
    if (!local.ok) {
      return {
        ok: false,
        outputDir,
        manifest: {} as ProjectManifest,
        filesWritten: [],
        error: local.error,
      };
    }
    dependencySpecs = local.specs;
  }
  const localDependencies = dependencySpecs !== undefined;
  const dependencyOptions = {
    ...(dependencySpecs !== undefined ? { dependencySpecs } : {}),
    ...(localDependencies ? { localDependencies: true } : {}),
    ...(options.workspaceDependencies === true
      ? { workspaceDependencies: true }
      : {}),
  };

  // 1. Validate configuration and contract
  const validation = await validateCommand({
    config: options.config,
    spec: options.spec,
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

  const projectName = validation.config?.name ?? "chainmcp-server";

  // Handle code-first project export
  if (validation.contractKind === "code-first") {
    const loaded = await loadCodeFirstTools({
      cwd,
      injectedTools: options.tools,
    });

    const manifest = buildCodeFirstManifest(projectName, loaded.tools, {
      generatorVersion: version,
    });

    await mkdir(outputDir, { recursive: true });
    await mkdir(join(outputDir, "src"), { recursive: true });

    const filesWritten: string[] = [];

    // Generation manifest
    const manifestPath = join(outputDir, "chainmcp.manifest.json");
    await writeFile(
      manifestPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );
    filesWritten.push("chainmcp.manifest.json");

    // Project configuration without contract
    const allowedHosts = validation.config?.security.allowedUpstreamHosts ?? [];
    const configYaml = renderConfigYaml({
      name: projectName,
      allowedHosts,
      blank: true,
    });
    await writeFile(
      join(outputDir, "chainmcp.config.yaml"),
      configYaml,
      "utf8",
    );
    filesWritten.push("chainmcp.config.yaml");

    // Source files from src/ if present
    const srcDir = join(cwd, "src");
    let hasServerTs = false;
    let hasToolsTs = false;
    if (await fileExists(srcDir)) {
      const entries = await readdir(srcDir);
      for (const entry of entries) {
        await copyFile(join(srcDir, entry), join(outputDir, "src", entry));
        filesWritten.push(`src/${entry}`);
        if (entry === "server.ts" || entry === "server.js") {
          hasServerTs = true;
        }
        if (entry === "tools.ts" || entry === "tools.js") {
          hasToolsTs = true;
        }
      }
    }

    if (!hasServerTs) {
      await writeFile(
        join(outputDir, "src", "server.ts"),
        renderServerTs({ version }),
        "utf8",
      );
      filesWritten.push("src/server.ts");
    }

    if (!hasToolsTs) {
      await writeFile(
        join(outputDir, "src", "tools.ts"),
        renderToolsTs({ blank: true }),
        "utf8",
      );
      filesWritten.push("src/tools.ts");
    }

    // Compiled tools artifact for verified startup
    const codeFirstCompiledToolsPath = join(
      outputDir,
      "dist",
      "compiled-tools.json",
    );
    await mkdir(join(outputDir, "dist"), { recursive: true });
    const compiledToolsForExport = loaded.tools.map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: t.inputSchema ?? {},
    }));
    await writeFile(
      codeFirstCompiledToolsPath,
      `${JSON.stringify(compiledToolsForExport, null, 2)}\n`,
      "utf8",
    );
    filesWritten.push("dist/compiled-tools.json");
    await writeFile(
      join(outputDir, "compiled-tools.json"),
      `${JSON.stringify(compiledToolsForExport, null, 2)}\n`,
      "utf8",
    );
    filesWritten.push("compiled-tools.json");

    // package.json
    const packageJson = renderPackageJson({
      name: projectName,
      version,
      ...dependencyOptions,
      dependencyOverrides: options.dependencyOverrides,
    });
    await writeFile(join(outputDir, "package.json"), packageJson, "utf8");
    filesWritten.push("package.json");

    if (dependencySpecs !== undefined) {
      await writeFile(
        join(outputDir, "pnpm-workspace.yaml"),
        renderPnpmWorkspaceYaml({ overrides: dependencySpecs }),
        "utf8",
      );
      filesWritten.push("pnpm-workspace.yaml");
    }

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

    // Docker templates & ignores
    await writeFile(
      join(outputDir, "Dockerfile"),
      renderDockerfile({ codeFirst: true }),
      "utf8",
    );
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
        toolCount: manifest.toolCount,
        ...(localDependencies ? { localDependencies: true } : {}),
      }),
      "utf8",
    );
    filesWritten.push("README.md");

    let verifiedReproducible: boolean | undefined;
    if (options.check) {
      const recompiledManifest = buildCodeFirstManifest(
        projectName,
        loaded.tools,
        { generatorVersion: version },
      );
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

  // 3. Read and compile contract
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
      outputDir,
      manifest: {} as ProjectManifest,
      filesWritten: [],
      error: "Export failed: Contract content could not be retrieved.",
    };
  }

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
  const manifest = buildProjectManifest(projectName, compiled, {
    generatorVersion: version,
  });

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
    version,
    ...dependencyOptions,
    dependencyOverrides: options.dependencyOverrides,
  });
  await writeFile(join(outputDir, "package.json"), packageJson, "utf8");
  filesWritten.push("package.json");

  if (dependencySpecs !== undefined) {
    await writeFile(
      join(outputDir, "pnpm-workspace.yaml"),
      renderPnpmWorkspaceYaml({ overrides: dependencySpecs }),
      "utf8",
    );
    filesWritten.push("pnpm-workspace.yaml");
  }

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
    renderServerTs({ version }),
    "utf8",
  );
  filesWritten.push("src/server.ts");
  await writeFile(join(outputDir, "src", "tools.ts"), renderToolsTs(), "utf8");
  filesWritten.push("src/tools.ts");

  // Compiled tools artifact for verified startup
  const compiledToolsPath = join(outputDir, "dist", "compiled-tools.json");
  await mkdir(join(outputDir, "dist"), { recursive: true });
  await writeFile(
    compiledToolsPath,
    `${JSON.stringify(compiled.tools, null, 2)}\n`,
    "utf8",
  );
  filesWritten.push("dist/compiled-tools.json");
  // Also copy to root for compatibility
  await writeFile(
    join(outputDir, "compiled-tools.json"),
    `${JSON.stringify(compiled.tools, null, 2)}\n`,
    "utf8",
  );
  filesWritten.push("compiled-tools.json");

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
      ...(localDependencies ? { localDependencies: true } : {}),
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
    const recompiledManifest = buildProjectManifest(
      projectName,
      recompilation,
      { generatorVersion: version },
    );
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

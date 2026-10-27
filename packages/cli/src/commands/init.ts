import { copyFile, mkdir, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

import { compileOpenApi } from "@chainmcp/compiler";
import { normalizeAllowedHost } from "@chainmcp/executor";

import { loadSpec } from "../spec-loader.js";

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
import type { InitOptions, InitResult } from "../types.js";

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function sanitizeProjectName(input: string): string {
  const sanitized = input
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized.length > 0 ? sanitized : "chainmcp-server";
}

interface NormalizedBaseUrlResult {
  baseUrl: string;
  host: string;
  allowInsecureHttp: boolean;
}

function normalizeInitBaseUrl(raw: string): NormalizedBaseUrlResult {
  let urlStr = raw.trim();
  if (!urlStr.startsWith("http://") && !urlStr.startsWith("https://")) {
    urlStr = `https://${urlStr}`;
  }
  let url: URL;
  try {
    url = new URL(urlStr);
  } catch {
    url = new URL("https://api.example.com");
  }

  let host: string;
  try {
    host = normalizeAllowedHost(url.hostname);
  } catch {
    host = "api.example.com";
  }

  const pathname = url.pathname.replace(/\/+$/, "");
  const baseUrl = `${url.origin}${pathname}`;
  const allowInsecureHttp = url.protocol === "http:";
  return { baseUrl, host, allowInsecureHttp };
}

export async function initCommand(options: InitOptions): Promise<InitResult> {
  const cwd = options.cwd ?? process.cwd();
  const projectDir = resolve(cwd, options.output ?? ".");

  // Handle blank code-first project scaffolding
  if (options.blank) {
    const rawTitle = options.name ?? basename(projectDir) ?? "chainmcp-server";
    const projectName = sanitizeProjectName(rawTitle);

    const configPath = join(projectDir, "chainmcp.config.yaml");
    if (!options.force && (await fileExists(configPath))) {
      return {
        ok: false,
        projectName,
        projectDir,
        specPath: "",
        configPath,
        toolCount: 1,
        createdFiles: [],
        error: `Directory already contains ${configPath}. Use --force to overwrite.`,
      };
    }

    await mkdir(projectDir, { recursive: true });
    await mkdir(join(projectDir, "src"), { recursive: true });

    const createdFiles: string[] = [];

    // Write configuration without contract
    const configYaml = renderConfigYaml({
      name: projectName,
      allowedHosts: [],
      blank: true,
    });
    await writeFile(configPath, configYaml, "utf8");
    createdFiles.push("chainmcp.config.yaml");

    // Write package.json
    const packageJson = renderPackageJson({ name: projectName });
    await writeFile(join(projectDir, "package.json"), packageJson, "utf8");
    createdFiles.push("package.json");

    // Write TypeScript configs
    await writeFile(
      join(projectDir, "tsconfig.json"),
      renderTsconfigJson(),
      "utf8",
    );
    createdFiles.push("tsconfig.json");
    await writeFile(
      join(projectDir, "tsconfig.build.json"),
      renderTsconfigBuildJson(),
      "utf8",
    );
    createdFiles.push("tsconfig.build.json");

    // Write source files
    await writeFile(
      join(projectDir, "src", "server.ts"),
      renderServerTs(),
      "utf8",
    );
    createdFiles.push("src/server.ts");
    await writeFile(
      join(projectDir, "src", "tools.ts"),
      renderToolsTs({ blank: true }),
      "utf8",
    );
    createdFiles.push("src/tools.ts");

    // Write Docker and git templates
    await writeFile(join(projectDir, "Dockerfile"), renderDockerfile(), "utf8");
    createdFiles.push("Dockerfile");
    await writeFile(
      join(projectDir, ".dockerignore"),
      renderDockerignore(),
      "utf8",
    );
    createdFiles.push(".dockerignore");
    await writeFile(join(projectDir, ".gitignore"), renderGitignore(), "utf8");
    createdFiles.push(".gitignore");

    // Write README.md
    await writeFile(
      join(projectDir, "README.md"),
      renderReadme({
        name: projectName,
        toolCount: 1,
        blank: true,
      }),
      "utf8",
    );
    createdFiles.push("README.md");

    return {
      ok: true,
      projectName,
      projectDir,
      specPath: "",
      configPath,
      toolCount: 1,
      createdFiles,
    };
  }

  // 1. Locate spec file or fetch from URL
  let candidateSource = options.spec;
  if (!candidateSource) {
    const candidates = [
      resolve(cwd, "openapi.yaml"),
      resolve(cwd, "openapi.json"),
      resolve(cwd, "spec/openapi.yaml"),
      resolve(cwd, "spec/openapi.json"),
    ];
    for (const cand of candidates) {
      if (await fileExists(cand)) {
        candidateSource = cand;
        break;
      }
    }
  }

  if (!candidateSource) {
    return {
      ok: false,
      projectName: "",
      projectDir,
      specPath: "",
      configPath: "",
      toolCount: 0,
      createdFiles: [],
      error:
        "OpenAPI specification file was not found. Please specify --spec <path>.",
    };
  }

  let candidateSpecPath = "";
  let specContent = "";

  try {
    const loaded = await loadSpec({
      source: candidateSource,
      cwd,
      allowHttp: options.allowHttp ?? false,
    });
    candidateSpecPath = loaded.resolvedSource;
    specContent = loaded.content;
  } catch (err) {
    return {
      ok: false,
      projectName: "",
      projectDir,
      specPath: options.spec ?? "",
      configPath: "",
      toolCount: 0,
      createdFiles: [],
      error: `Failed to fetch OpenAPI spec from ${candidateSource}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  // 2. Compile spec
  const compiled = compileOpenApi(specContent, { strict: false });
  if (!compiled.ok) {
    const errors = compiled.diagnostics
      .filter((d) => d.severity === "error")
      .map((d) => `[${d.code}] ${d.message}`)
      .join("; ");
    return {
      ok: false,
      projectName: "",
      projectDir,
      specPath: candidateSpecPath,
      configPath: "",
      toolCount: 0,
      createdFiles: [],
      error: `Failed to compile OpenAPI contract: ${errors}`,
    };
  }

  // 3. Derive project name and base URL
  let parsedRaw: { info?: { title?: string }; servers?: { url?: string }[] } =
    {};
  try {
    parsedRaw = parseYaml(specContent) ?? {};
  } catch {
    // If parsing raw fails, compilation already validated or will use fallbacks
  }

  const rawTitle =
    options.name ??
    parsedRaw.info?.title ??
    basename(projectDir) ??
    "chainmcp-server";
  const projectName = sanitizeProjectName(rawTitle);

  let rawUrl =
    options.baseUrl ?? parsedRaw.servers?.[0]?.url ?? "https://api.example.com";
  if (rawUrl.startsWith("/")) {
    rawUrl = options.baseUrl ?? "https://api.example.com";
  }
  const {
    baseUrl,
    host: allowedHost,
    allowInsecureHttp,
  } = normalizeInitBaseUrl(rawUrl);

  // 4. Check for existing project
  const configPath = join(projectDir, "chainmcp.config.yaml");
  if (!options.force && (await fileExists(configPath))) {
    return {
      ok: false,
      projectName,
      projectDir,
      specPath: candidateSpecPath,
      configPath,
      toolCount: compiled.tools.length,
      createdFiles: [],
      error: `Directory already contains ${configPath}. Use --force to overwrite.`,
    };
  }

  // 5. Ensure target directory structure
  await mkdir(projectDir, { recursive: true });
  await mkdir(join(projectDir, "spec"), { recursive: true });
  await mkdir(join(projectDir, "src"), { recursive: true });

  const targetSpecPath = join(projectDir, "spec", "openapi.yaml");
  const createdFiles: string[] = [];

  // Copy or write spec
  if (
    candidateSpecPath.startsWith("http://") ||
    candidateSpecPath.startsWith("https://")
  ) {
    await writeFile(targetSpecPath, specContent, "utf8");
  } else if (resolve(candidateSpecPath) !== resolve(targetSpecPath)) {
    await copyFile(candidateSpecPath, targetSpecPath);
  } else {
    await writeFile(targetSpecPath, specContent, "utf8");
  }
  createdFiles.push("spec/openapi.yaml");

  // Write configuration
  const configYaml = renderConfigYaml({
    name: projectName,
    allowedHosts: [allowedHost],
    specRelativePath: "./spec/openapi.yaml",
    baseUrl,
    allowInsecureHttp,
  });
  await writeFile(configPath, configYaml, "utf8");
  createdFiles.push("chainmcp.config.yaml");

  // Write package.json
  const packageJson = renderPackageJson({ name: projectName });
  await writeFile(join(projectDir, "package.json"), packageJson, "utf8");
  createdFiles.push("package.json");

  // Write TypeScript configs
  await writeFile(
    join(projectDir, "tsconfig.json"),
    renderTsconfigJson(),
    "utf8",
  );
  createdFiles.push("tsconfig.json");
  await writeFile(
    join(projectDir, "tsconfig.build.json"),
    renderTsconfigBuildJson(),
    "utf8",
  );
  createdFiles.push("tsconfig.build.json");

  // Write source files
  await writeFile(
    join(projectDir, "src", "server.ts"),
    renderServerTs(),
    "utf8",
  );
  createdFiles.push("src/server.ts");
  await writeFile(join(projectDir, "src", "tools.ts"), renderToolsTs(), "utf8");
  createdFiles.push("src/tools.ts");

  // Write Docker and git templates
  await writeFile(join(projectDir, "Dockerfile"), renderDockerfile(), "utf8");
  createdFiles.push("Dockerfile");
  await writeFile(
    join(projectDir, ".dockerignore"),
    renderDockerignore(),
    "utf8",
  );
  createdFiles.push(".dockerignore");
  await writeFile(join(projectDir, ".gitignore"), renderGitignore(), "utf8");
  createdFiles.push(".gitignore");

  // Write README.md
  await writeFile(
    join(projectDir, "README.md"),
    renderReadme({
      name: projectName,
      toolCount: compiled.tools.length,
      contractRevision: compiled.contractRevision,
    }),
    "utf8",
  );
  createdFiles.push("README.md");

  return {
    ok: true,
    projectName,
    projectDir,
    specPath: targetSpecPath,
    configPath,
    toolCount: compiled.tools.length,
    createdFiles,
  };
}

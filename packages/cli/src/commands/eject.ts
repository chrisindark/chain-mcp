import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

import { StorageDescriptorRevisionStore } from "@chainmcp/admin";
import { COMPILER_VERSION, compileOpenApi } from "@chainmcp/compiler";
import {
  createStorageDriverFromConfig,
  parseGatewayConfig,
  resolveConfigSecrets,
  type StorageConfig,
} from "@chainmcp/config";
import { loadServerConfigFile } from "../config-loader.js";
import {
  declarativeToolPolicy,
  parseDeclarativeToolDescriptor,
  type DeclarativeHttpMethod,
  type DeclarativeToolDescriptor,
} from "@chainmcp/declarative";
import { SqliteStorageDriver, type StorageDriver } from "@chainmcp/storage";

import { resolveLocalDependencySpecs } from "../local-deps.js";
import {
  attachCompiledToolsArtifact,
  buildDeclarativeManifest,
  hashContent,
  serializeCompiledTools,
  verifyProjectManifest,
} from "../manifest.js";
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
import type { EjectOptions, EjectResult, ProjectManifest } from "../types.js";

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

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname.endsWith(".localhost")
  );
}

function validateDestinationPolicy(
  policy: {
    baseUrl?: string | undefined;
    allowedHosts?: readonly string[] | undefined;
  },
  allowInsecureHttp?: boolean,
):
  | { ok: true; baseUrl: string; allowedHosts: string[] }
  | { ok: false; error: string } {
  if (
    !policy ||
    typeof policy.baseUrl !== "string" ||
    policy.baseUrl.trim().length === 0
  ) {
    return {
      ok: false,
      error: "Contract destination policy requires a non-empty baseUrl.",
    };
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(policy.baseUrl);
  } catch {
    return {
      ok: false,
      error: `Invalid destination baseUrl: '${policy.baseUrl}'`,
    };
  }

  if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
    return {
      ok: false,
      error: `Destination protocol '${parsedUrl.protocol}' is unsupported. Only https: and http: are allowed.`,
    };
  }

  if (
    parsedUrl.protocol === "http:" &&
    !allowInsecureHttp &&
    !isLoopbackHost(parsedUrl.hostname)
  ) {
    return {
      ok: false,
      error: `Plain HTTP destination '${policy.baseUrl}' is prohibited without explicit allowInsecureHttp permission.`,
    };
  }

  const hosts = new Set<string>();
  if (Array.isArray(policy.allowedHosts)) {
    for (const h of policy.allowedHosts) {
      if (typeof h === "string" && h.trim().length > 0) {
        hosts.add(h.trim().toLowerCase());
      }
    }
  }
  hosts.add(parsedUrl.hostname.toLowerCase());

  return { ok: true, baseUrl: policy.baseUrl, allowedHosts: [...hosts].sort() };
}

export async function ejectCommand(
  options: EjectOptions,
): Promise<EjectResult> {
  const cwd =
    options.cwd ??
    (options.config
      ? dirname(resolve(process.cwd(), options.config))
      : process.cwd());
  const version = options.version ?? (await getCliVersion());

  if (
    options.localDeps !== undefined &&
    options.workspaceDependencies === true
  ) {
    return {
      ok: false,
      contractName: options.contract ?? "unknown",
      outputDir: "",
      manifest: {} as ProjectManifest,
      filesWritten: [],
      error:
        "Choose either --local-deps (file: dependencies) or --workspace-deps (workspace:*), not both.",
    };
  }

  // 1. Resolve configuration file path
  let configPath: string | undefined;
  if (options.config !== undefined) {
    configPath = resolve(cwd, options.config);
    if (!(await fileExists(configPath))) {
      return {
        ok: false,
        contractName: options.contract ?? "unknown",
        outputDir: "",
        manifest: {} as ProjectManifest,
        filesWritten: [],
        error: `Configuration file '${options.config}' was not found.`,
      };
    }
  } else {
    const candidates = [
      "gateway.config.yaml",
      "gateway.config.yml",
      "chainmcp.gateway.yaml",
      "chainmcp.gateway.yml",
      "chainmcp.config.yaml",
      "chainmcp.config.yml",
    ];
    for (const candidate of candidates) {
      const fullPath = resolve(cwd, candidate);
      if (await fileExists(fullPath)) {
        configPath = fullPath;
        break;
      }
    }
  }

  let parsedConfig: unknown;
  let isGateway = false;
  if (configPath !== undefined) {
    try {
      const rawText = await readFile(configPath, "utf8");
      parsedConfig = parseYaml(rawText);
      isGateway =
        typeof parsedConfig === "object" &&
        parsedConfig !== null &&
        ("contracts" in parsedConfig || configPath.includes("gateway"));
    } catch (err) {
      return {
        ok: false,
        contractName: options.contract ?? "unknown",
        outputDir: "",
        manifest: {} as ProjectManifest,
        filesWritten: [],
        error: `Failed to load configuration file at '${configPath}': ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  let targetContractName: string;
  let targetTenantId: string;
  let rawDestination: {
    baseUrl?: string | undefined;
    allowedHosts?: readonly string[] | undefined;
  } = {};
  let storageConfig: StorageConfig | undefined;
  let allowInsecureHttp = false;
  let contractExcludes = new Set<string>();
  let contractIncludes: Set<string> | undefined;
  let contractSourceFile: string | undefined;
  let configInlineDescriptors: readonly DeclarativeToolDescriptor[] | undefined;

  if (isGateway && parsedConfig) {
    const resolved = resolveConfigSecrets(parsedConfig);
    const gatewayConfig = parseGatewayConfig(resolved.config);
    storageConfig = gatewayConfig.storage;
    allowInsecureHttp = gatewayConfig.security.allowInsecureHttp ?? false;

    const availableContracts = gatewayConfig.contracts ?? [];
    if (availableContracts.length === 0) {
      return {
        ok: false,
        contractName: options.contract ?? "unknown",
        outputDir: "",
        manifest: {} as ProjectManifest,
        filesWritten: [],
        error: "No contracts defined in gateway configuration.",
      };
    }

    let selectedContract: (typeof availableContracts)[number];
    if (options.contract !== undefined) {
      const match = availableContracts.find((c) => c.name === options.contract);
      if (!match) {
        const names = availableContracts.map((c) => c.name).join(", ");
        return {
          ok: false,
          contractName: options.contract,
          outputDir: "",
          manifest: {} as ProjectManifest,
          filesWritten: [],
          error: `Contract '${options.contract}' was not found in gateway configuration. Available contracts: ${names}`,
        };
      }
      selectedContract = match;
    } else if (availableContracts.length === 1) {
      selectedContract = availableContracts[0]!;
    } else {
      const names = availableContracts.map((c) => c.name).join(", ");
      return {
        ok: false,
        contractName: "unknown",
        outputDir: "",
        manifest: {} as ProjectManifest,
        filesWritten: [],
        error: `Multiple contracts found in gateway configuration (${names}). Please specify --contract <name>.`,
      };
    }

    targetContractName = selectedContract.name;
    targetTenantId = options.tenant ?? selectedContract.tenantId ?? "default";
    if (selectedContract.destination) {
      rawDestination = {
        baseUrl: selectedContract.destination.baseUrl,
        allowedHosts: selectedContract.destination.allowedHosts,
      };
    }
    if (selectedContract.tools?.exclude) {
      contractExcludes = new Set(selectedContract.tools.exclude);
    }
    if (selectedContract.tools?.include) {
      contractIncludes = new Set(selectedContract.tools.include);
    }
    contractSourceFile =
      selectedContract.spec ?? (selectedContract as { source?: string }).source;
    const rawDesc =
      (selectedContract as { descriptors?: unknown }).descriptors ??
      (selectedContract.metadata as { descriptors?: unknown } | undefined)
        ?.descriptors;
    if (Array.isArray(rawDesc)) {
      configInlineDescriptors = rawDesc as DeclarativeToolDescriptor[];
    }
  } else if (configPath !== undefined) {
    const serverConfig = await loadServerConfigFile(configPath);
    targetContractName =
      options.contract ?? serverConfig.config.name ?? "chainmcp-server";
    targetTenantId = options.tenant ?? serverConfig.config.tenant ?? "default";
    rawDestination = {
      baseUrl: serverConfig.config.contract?.baseUrl,
      allowedHosts: serverConfig.config.security.allowedUpstreamHosts,
    };
    storageConfig = serverConfig.config.storage;
    allowInsecureHttp = serverConfig.config.security.allowInsecureHttp ?? false;
    contractSourceFile = serverConfig.config.contract?.source;
  } else {
    return {
      ok: false,
      contractName: options.contract ?? "unknown",
      outputDir: "",
      manifest: {} as ProjectManifest,
      filesWritten: [],
      error:
        "No gateway or server configuration file found in working directory. Use --config to specify a configuration path.",
    };
  }

  // 2. Validate destination policy (SSRF protection & invariant checks)
  const destValidation = validateDestinationPolicy(
    rawDestination,
    allowInsecureHttp,
  );
  if (!destValidation.ok) {
    return {
      ok: false,
      contractName: targetContractName,
      outputDir: "",
      manifest: {} as ProjectManifest,
      filesWritten: [],
      error: `Destination policy error for contract '${targetContractName}': ${destValidation.error}`,
    };
  }

  // 3. Retrieve descriptors and active revision from storage or contract source
  let descriptors: DeclarativeToolDescriptor[] | undefined;
  let contractRevisionId: string | undefined;

  let storageDriver: StorageDriver | undefined;
  if (options.storagePath) {
    storageDriver = new SqliteStorageDriver({
      path: resolve(cwd, options.storagePath),
    });
  } else if (storageConfig && storageConfig.enabled) {
    storageDriver = createStorageDriverFromConfig(storageConfig);
  }

  if (storageDriver) {
    try {
      await storageDriver.init();
      const store = await StorageDescriptorRevisionStore.open(storageDriver);
      const active = await store.getActive(targetTenantId, targetContractName);
      if (active) {
        descriptors = [...active.descriptors];
        contractRevisionId = active.revisionId;
      }
    } catch {
      // Storage access failure falls back to source compilation
    } finally {
      try {
        await storageDriver.close();
      } catch {
        // Driver close cleanup
      }
    }
  }

  // Fallback: compile from contract source file or inline descriptors
  if (!descriptors || descriptors.length === 0) {
    if (configInlineDescriptors && configInlineDescriptors.length > 0) {
      descriptors = [...configInlineDescriptors];
      contractRevisionId = `inline_${targetContractName}`;
    } else if (contractSourceFile) {
      const specFullPath = resolve(
        configPath ? dirname(configPath) : cwd,
        contractSourceFile,
      );
      if (!(await fileExists(specFullPath))) {
        return {
          ok: false,
          contractName: targetContractName,
          outputDir: "",
          manifest: {} as ProjectManifest,
          filesWritten: [],
          error: `Contract source spec '${specFullPath}' was not found.`,
        };
      }
      const specContent = await readFile(specFullPath, "utf8");
      const compiled = compileOpenApi(specContent, { strict: true });
      if (!compiled.ok) {
        const errorDetails = compiled.diagnostics
          .filter((d) => d.severity === "error")
          .map((d) => `[${d.code}] ${d.message}`)
          .join("; ");
        return {
          ok: false,
          contractName: targetContractName,
          outputDir: "",
          manifest: {} as ProjectManifest,
          filesWritten: [],
          error: `Contract compilation failed for '${targetContractName}': ${errorDetails}`,
        };
      }

      contractRevisionId = compiled.contractRevision;
      descriptors = compiled.tools.map((op) => ({
        descriptorVersion: 1,
        name: op.name,
        description: op.description,
        enabled: true,
        inputSchema: op.inputSchema,
        request: {
          method: op.method.toUpperCase() as DeclarativeHttpMethod,
          path: op.path,
          parameters: op.parameters.map((p) => ({
            name: p.name,
            in: p.in,
            required: p.required,
          })),
          ...(op.requestBody
            ? {
                body: {
                  mediaType: op.requestBody.mediaType,
                  required: op.requestBody.required,
                },
              }
            : {}),
        },
        ...(op.operation.requiredScopes &&
        op.operation.requiredScopes.length > 0
          ? { policy: { requiredScopes: op.operation.requiredScopes } }
          : {}),
      }));
    }
  }

  if (!descriptors || descriptors.length === 0) {
    return {
      ok: false,
      contractName: targetContractName,
      outputDir: "",
      manifest: {} as ProjectManifest,
      filesWritten: [],
      error: `No active or valid tool descriptors found for contract '${targetContractName}'.`,
    };
  }

  // 4. Apply curation filters: exclude disabled tools and pruned tools
  const curatedDescriptors = descriptors.filter((d) => {
    if (d.enabled === false) return false;
    if (contractExcludes.has(d.name)) return false;
    if (contractIncludes && !contractIncludes.has(d.name)) return false;
    return true;
  });

  if (curatedDescriptors.length === 0) {
    return {
      ok: false,
      contractName: targetContractName,
      outputDir: "",
      manifest: {} as ProjectManifest,
      filesWritten: [],
      error: `Contract '${targetContractName}' has no active tools after curation pruning.`,
    };
  }

  // 5. Parse each descriptor and compile operation with attached policies
  const compiledOperations: unknown[] = [];
  try {
    for (const desc of curatedDescriptors) {
      const parsed = parseDeclarativeToolDescriptor(desc);
      const policy = declarativeToolPolicy(desc);
      compiledOperations.push({
        ...parsed.operation,
        ...(policy.cache !== undefined ? { cache: policy.cache } : {}),
        ...(policy.output !== undefined ? { output: policy.output } : {}),
        ...(policy.timeoutMs !== undefined
          ? { timeoutMs: policy.timeoutMs }
          : {}),
      });
    }
  } catch (err) {
    return {
      ok: false,
      contractName: targetContractName,
      outputDir: "",
      manifest: {} as ProjectManifest,
      filesWritten: [],
      error: `Descriptor parsing failed for contract '${targetContractName}': ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // 6. Target directory check
  const outputDir = resolve(
    cwd,
    options.output ?? `./${targetContractName}-server`,
  );
  if (!options.force && (await fileExists(outputDir))) {
    const empty = await isDirectoryEmpty(outputDir);
    if (!empty) {
      return {
        ok: false,
        contractName: targetContractName,
        outputDir,
        manifest: {} as ProjectManifest,
        filesWritten: [],
        error: `Target directory '${outputDir}' is not empty. Use --force to overwrite.`,
      };
    }
  }

  // 7. Local dependency resolution if requested
  let dependencySpecs: Record<string, string> | undefined;
  if (options.localDeps !== undefined) {
    const local = await resolveLocalDependencySpecs({
      repoRoot: options.localDeps,
      projectDir: outputDir,
    });
    if (!local.ok) {
      return {
        ok: false,
        contractName: targetContractName,
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

  // 8. Generate standalone server package artifacts
  const serialized = serializeCompiledTools(compiledOperations, {
    contractRevision: contractRevisionId,
  });
  const descriptorsContent = `${JSON.stringify(curatedDescriptors, null, 2)}\n`;
  const projectName = `${targetContractName}-server`;

  const manifest = attachCompiledToolsArtifact(
    buildDeclarativeManifest(projectName, compiledOperations, {
      generatorVersion: version,
      contractRevision: contractRevisionId,
      sourceHash: hashContent(descriptorsContent),
    }),
    serialized.artifact,
  );

  await mkdir(outputDir, { recursive: true });
  await mkdir(join(outputDir, "dist"), { recursive: true });
  await mkdir(join(outputDir, "src"), { recursive: true });

  const filesWritten: string[] = [];

  // Pinned descriptors artifact
  await writeFile(
    join(outputDir, "descriptors.json"),
    descriptorsContent,
    "utf8",
  );
  filesWritten.push("descriptors.json");

  // Manifest
  const manifestPath = join(outputDir, "chainmcp.manifest.json");
  await writeFile(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  filesWritten.push("chainmcp.manifest.json");

  // Standalone chainmcp.config.yaml (curated destination policy, no gateway/admin dependencies)
  const configYaml = renderConfigYaml({
    name: projectName,
    allowedHosts: destValidation.allowedHosts,
    baseUrl: destValidation.baseUrl,
    specRelativePath: "./descriptors.json",
    allowInsecureHttp,
    transport: options.transport ?? "stdio",
  });
  await writeFile(join(outputDir, "chainmcp.config.yaml"), configYaml, "utf8");
  filesWritten.push("chainmcp.config.yaml");

  // Compiled tools for verified startup
  await writeFile(
    join(outputDir, "dist", "compiled-tools.json"),
    serialized.content,
    "utf8",
  );
  filesWritten.push("dist/compiled-tools.json");
  await writeFile(
    join(outputDir, "compiled-tools.json"),
    serialized.content,
    "utf8",
  );
  filesWritten.push("compiled-tools.json");

  // package.json (no @chainmcp/gateway or @chainmcp/admin dependencies)
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

  // Server & Tools source
  await writeFile(
    join(outputDir, "src", "server.ts"),
    renderServerTs({ version, compilerVersion: COMPILER_VERSION }),
    "utf8",
  );
  filesWritten.push("src/server.ts");

  await writeFile(
    join(outputDir, "src", "tools.ts"),
    renderToolsTs({ blank: true }),
    "utf8",
  );
  filesWritten.push("src/tools.ts");

  // Docker & Git configs
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

  // README
  await writeFile(
    join(outputDir, "README.md"),
    renderReadme({
      name: projectName,
      toolCount: manifest.toolCount,
      contractRevision: contractRevisionId,
      ...(localDependencies ? { localDependencies: true } : {}),
    }),
    "utf8",
  );
  filesWritten.push("README.md");

  // 9. Reproducibility check if requested
  let verifiedReproducible: boolean | undefined;
  if (options.check) {
    const recomputedSerialized = serializeCompiledTools(compiledOperations, {
      contractRevision: contractRevisionId,
    });
    const recomputedManifest = attachCompiledToolsArtifact(
      buildDeclarativeManifest(projectName, compiledOperations, {
        generatorVersion: version,
        contractRevision: contractRevisionId,
        sourceHash: hashContent(descriptorsContent),
      }),
      recomputedSerialized.artifact,
    );
    const verification = verifyProjectManifest(manifest, recomputedManifest);
    if (!verification.match) {
      return {
        ok: false,
        contractName: targetContractName,
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
    contractName: targetContractName,
    outputDir,
    manifest,
    filesWritten,
    verifiedReproducible,
  };
}

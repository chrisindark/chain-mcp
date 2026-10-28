import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";

import {
  compileOpenApi,
  diffContracts,
  diffManifests,
  type CompileManifest,
  type ContractDiffTool,
  type OpenApiVersion,
} from "@chainmcp/compiler";

import type { DiffOptions, DiffResult, ProjectManifest } from "../types.js";
import { validateCommand } from "./validate.js";
import { loadSpec } from "../spec-loader.js";

function normalizeOpenApiVersion(
  version: string | undefined,
): OpenApiVersion | "unknown" {
  if (version === "3.0" || version?.startsWith("3.0")) return "3.0";
  if (version === "3.1" || version?.startsWith("3.1")) return "3.1";
  return "unknown";
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function diffCommand(options: DiffOptions): Promise<DiffResult> {
  const cwd = options.cwd ?? process.cwd();

  // 1. Validate and locate current spec
  const validation = await validateCommand({
    config: options.config,
    spec: options.spec,
    allowHttp: options.allowHttp,
    cwd,
  });

  if (!validation.ok || !validation.manifest) {
    return {
      schemaVersion: 1,
      ok: false,
      contractRevision: validation.contractRevision ?? "",
      sourceHash: validation.sourceHash ?? "",
      toolsetHash: validation.toolsetHash ?? "",
      hasChanges: false,
      hasBreakingChanges: false,
      hasPotentiallyBreakingChanges: false,
      summary: {
        breaking: 0,
        potentiallyBreaking: 0,
        nonBreaking: 0,
      },
      addedTools: [],
      removedTools: [],
      changedTools: [],
      unchangedTools: [],
      changes: [],
      breaking: [],
      potentiallyBreaking: [],
      nonBreaking: [],
      error: `Failed to load current contract: ${validation.error ?? "unknown error"}`,
    };
  }

  const currentManifest = validation.manifest;
  const contractRevision = validation.contractRevision ?? "";
  const sourceHash = validation.sourceHash ?? "";
  const toolsetHash = validation.toolsetHash ?? "";

  // 2. Locate baseline manifest or spec to diff against
  let baselineManifest: CompileManifest | undefined;
  let baselineTools: ContractDiffTool[] = [];
  let baselineBaseUrl: string | undefined;

  if (options.against) {
    let againstContent = "";
    try {
      const loaded = await loadSpec({
        source: options.against,
        cwd,
        allowHttp:
          options.allowHttp ?? validation.config?.security?.allowInsecureHttp,
      });
      againstContent = loaded.content;
    } catch (err) {
      return {
        schemaVersion: 1,
        ok: false,
        contractRevision,
        sourceHash,
        toolsetHash,
        hasChanges: false,
        hasBreakingChanges: false,
        hasPotentiallyBreakingChanges: false,
        summary: {
          breaking: 0,
          potentiallyBreaking: 0,
          nonBreaking: 0,
        },
        addedTools: [],
        removedTools: [],
        changedTools: [],
        unchangedTools: [],
        changes: [],
        breaking: [],
        potentiallyBreaking: [],
        nonBreaking: [],
        error: `Failed to load comparison target from ${options.against}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }

    let isJsonManifestOrTools = false;

    try {
      const parsed = JSON.parse(againstContent) as unknown;
      if (typeof parsed === "object" && parsed !== null) {
        if (
          "manifestVersion" in parsed &&
          Array.isArray((parsed as Record<string, unknown>).tools)
        ) {
          const manifestObj = parsed as ProjectManifest | CompileManifest;
          baselineManifest = {
            manifestVersion: 1,
            compilerVersion: manifestObj.compilerVersion ?? "0.1.0",
            openapiVersion: normalizeOpenApiVersion(manifestObj.openapiVersion),
            sourceHash: manifestObj.sourceHash ?? "",
            contractRevision: manifestObj.contractRevision ?? "",
            toolsetHash: manifestObj.toolsetHash ?? "",
            toolCount: manifestObj.toolCount ?? manifestObj.tools.length,
            tools: manifestObj.tools.map((t) => ({
              name: t.name,
              hash: t.hash,
            })),
          };
          baselineTools = manifestObj.tools.map((t) => ({ name: t.name }));
          isJsonManifestOrTools = true;
        } else if (Array.isArray(parsed)) {
          baselineTools = parsed as ContractDiffTool[];
          isJsonManifestOrTools = true;
        } else if (
          "tools" in parsed &&
          Array.isArray((parsed as Record<string, unknown>).tools)
        ) {
          const rawTools = (parsed as { tools: unknown[] }).tools;
          if (
            rawTools.length > 0 &&
            typeof rawTools[0] === "object" &&
            rawTools[0] !== null &&
            "inputSchema" in rawTools[0]
          ) {
            baselineTools = rawTools as ContractDiffTool[];
            isJsonManifestOrTools = true;
          }
        }
      }
    } catch {
      // Not a JSON manifest/toolset, compile as OpenAPI
    }

    if (!isJsonManifestOrTools) {
      // Compile as an OpenAPI contract
      const againstCompiled = compileOpenApi(againstContent, {
        strict: false,
      });
      if (againstCompiled.ok || againstCompiled.tools.length > 0) {
        baselineManifest = againstCompiled.manifest;
        baselineTools = againstCompiled.tools as unknown as ContractDiffTool[];
        try {
          const rawDoc = parseYaml(againstContent) as Record<
            string,
            unknown
          > | null;
          if (
            rawDoc &&
            Array.isArray(rawDoc.servers) &&
            rawDoc.servers[0]?.url
          ) {
            baselineBaseUrl = String(rawDoc.servers[0].url);
          }
        } catch {
          // Ignore YAML parse error for servers
        }
      } else {
        return {
          schemaVersion: 1,
          ok: false,
          contractRevision,
          sourceHash,
          toolsetHash,
          hasChanges: false,
          hasBreakingChanges: false,
          hasPotentiallyBreakingChanges: false,
          summary: {
            breaking: 0,
            potentiallyBreaking: 0,
            nonBreaking: 0,
          },
          addedTools: [],
          removedTools: [],
          changedTools: [],
          unchangedTools: [],
          changes: [],
          breaking: [],
          potentiallyBreaking: [],
          nonBreaking: [],
          error: `Target comparison contract failed to compile: ${againstCompiled.diagnostics.map((d) => d.message).join("; ")}`,
        };
      }
    }
  } else {
    // Default candidate locations for existing build artifacts
    const candidateToolsPaths = [
      resolve(cwd, "dist/compiled-tools.json"),
      resolve(cwd, "compiled-tools.json"),
    ];
    for (const tp of candidateToolsPaths) {
      if (await fileExists(tp)) {
        try {
          const raw = await readFile(tp, "utf8");
          const parsed = JSON.parse(raw) as unknown;
          if (Array.isArray(parsed)) {
            baselineTools = parsed as ContractDiffTool[];
            break;
          }
        } catch {
          // Ignore invalid file
        }
      }
    }

    const candidateManifestPaths = [
      resolve(cwd, "dist/chainmcp.manifest.json"),
      resolve(cwd, "dist/manifest.json"),
      resolve(cwd, "manifest.json"),
    ];
    for (const cand of candidateManifestPaths) {
      if (await fileExists(cand)) {
        try {
          const raw = await readFile(cand, "utf8");
          const parsed = JSON.parse(raw) as ProjectManifest | CompileManifest;
          if (parsed && Array.isArray(parsed.tools)) {
            baselineManifest = {
              manifestVersion: 1,
              compilerVersion: parsed.compilerVersion ?? "0.1.0",
              openapiVersion: normalizeOpenApiVersion(parsed.openapiVersion),
              sourceHash: parsed.sourceHash ?? "",
              contractRevision: parsed.contractRevision ?? "",
              toolsetHash: parsed.toolsetHash ?? "",
              toolCount: parsed.toolCount ?? parsed.tools.length,
              tools: parsed.tools.map((t) => ({ name: t.name, hash: t.hash })),
            };
            if (baselineTools.length === 0) {
              baselineTools = parsed.tools.map((t) => ({ name: t.name }));
            }
            break;
          }
        } catch {
          // Ignore invalid manifest files
        }
      }
    }
  }

  // 3. If no baseline was found
  if (!baselineManifest && baselineTools.length === 0) {
    const currentTools = currentManifest.tools.map((t) => t.name);
    return {
      schemaVersion: 1,
      ok: true,
      contractRevision,
      sourceHash,
      toolsetHash,
      hasChanges: false,
      hasBreakingChanges: false,
      hasPotentiallyBreakingChanges: false,
      summary: {
        breaking: 0,
        potentiallyBreaking: 0,
        nonBreaking: 0,
      },
      addedTools: currentTools,
      removedTools: [],
      changedTools: [],
      unchangedTools: [],
      changes: [],
      breaking: [],
      potentiallyBreaking: [],
      nonBreaking: [],
    };
  }

  // 4. Compare schemas and contracts
  const currentCompiledTools =
    (validation.compiled?.tools as unknown as ContractDiffTool[]) ??
    currentManifest.tools.map((t) => ({ name: t.name }));

  let currentSpecBaseUrl = validation.config?.contract?.baseUrl;
  if (!currentSpecBaseUrl && validation.specContent) {
    try {
      const rawDoc = parseYaml(validation.specContent) as Record<
        string,
        unknown
      > | null;
      if (rawDoc && Array.isArray(rawDoc.servers) && rawDoc.servers[0]?.url) {
        currentSpecBaseUrl = String(rawDoc.servers[0].url);
      }
    } catch {
      // Ignore
    }
  }

  const contractDiff = diffContracts(
    {
      tools: baselineTools,
      baseUrl: baselineBaseUrl,
    },
    {
      tools: currentCompiledTools,
      baseUrl: currentSpecBaseUrl,
    },
  );

  let manifestDiffAdded: readonly string[] = [];
  let manifestDiffRemoved: readonly string[] = [];
  let manifestDiffChanged: readonly string[] = [];
  let manifestDiffUnchanged: readonly string[] = [];

  if (baselineManifest) {
    const mDiff = diffManifests(baselineManifest, currentManifest);
    manifestDiffAdded = mDiff.added;
    manifestDiffRemoved = mDiff.removed;
    manifestDiffChanged = mDiff.changed;
    manifestDiffUnchanged = mDiff.unchanged;
  }

  const addedTools = Array.from(
    new Set([...contractDiff.addedTools, ...manifestDiffAdded]),
  ).sort();
  const removedTools = Array.from(
    new Set([...contractDiff.removedTools, ...manifestDiffRemoved]),
  ).sort();
  const changedTools = Array.from(
    new Set([...contractDiff.changedTools, ...manifestDiffChanged]),
  ).sort();
  const unchangedTools = Array.from(
    new Set([...contractDiff.unchangedTools, ...manifestDiffUnchanged]),
  )
    .filter((t) => !changedTools.includes(t) && !removedTools.includes(t))
    .sort();

  const hasChanges =
    contractDiff.hasChanges ||
    manifestDiffAdded.length > 0 ||
    manifestDiffRemoved.length > 0 ||
    manifestDiffChanged.length > 0;
  const hasBreakingChanges =
    contractDiff.hasBreakingChanges || manifestDiffRemoved.length > 0;
  const hasPotentiallyBreakingChanges =
    contractDiff.hasPotentiallyBreakingChanges;

  return {
    schemaVersion: 1,
    ok: true,
    contractRevision,
    sourceHash,
    toolsetHash,
    hasChanges,
    hasBreakingChanges,
    hasPotentiallyBreakingChanges,
    summary: {
      breaking: contractDiff.breaking.length,
      potentiallyBreaking: contractDiff.potentiallyBreaking.length,
      nonBreaking: contractDiff.nonBreaking.length,
    },
    addedTools,
    removedTools,
    changedTools,
    unchangedTools,
    changes: contractDiff.changes,
    breaking: contractDiff.breaking,
    potentiallyBreaking: contractDiff.potentiallyBreaking,
    nonBreaking: contractDiff.nonBreaking,
  };
}

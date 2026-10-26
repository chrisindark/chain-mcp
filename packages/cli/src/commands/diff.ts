import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

import {
  compileOpenApi,
  diffManifests,
  type CompileManifest,
  type OpenApiVersion,
} from "@chainmcp/compiler";

import type { DiffOptions, DiffResult, ProjectManifest } from "../types.js";
import { validateCommand } from "./validate.js";

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
    cwd,
  });

  if (!validation.ok || !validation.manifest) {
    return {
      ok: false,
      contractRevision: validation.contractRevision ?? "",
      sourceHash: validation.sourceHash ?? "",
      toolsetHash: validation.toolsetHash ?? "",
      hasChanges: false,
      hasBreakingChanges: false,
      addedTools: [],
      removedTools: [],
      changedTools: [],
      unchangedTools: [],
      error: `Failed to load current contract: ${validation.error ?? "unknown error"}`,
    };
  }

  const currentManifest = validation.manifest;
  const contractRevision = validation.contractRevision ?? "";
  const sourceHash = validation.sourceHash ?? "";
  const toolsetHash = validation.toolsetHash ?? "";

  // 2. Locate baseline manifest or spec to diff against
  let baselineManifest: CompileManifest | undefined;

  if (options.against) {
    let againstContent = "";
    const isUrl =
      options.against.startsWith("http://") ||
      options.against.startsWith("https://");

    if (isUrl) {
      try {
        const res = await fetch(options.against);
        if (!res.ok) {
          return {
            ok: false,
            contractRevision,
            sourceHash,
            toolsetHash,
            hasChanges: false,
            hasBreakingChanges: false,
            addedTools: [],
            removedTools: [],
            changedTools: [],
            unchangedTools: [],
            error: `Failed to fetch target comparison from ${options.against}: HTTP ${res.status} ${res.statusText}`,
          };
        }
        againstContent = await res.text();
      } catch (err) {
        return {
          ok: false,
          contractRevision,
          sourceHash,
          toolsetHash,
          hasChanges: false,
          hasBreakingChanges: false,
          addedTools: [],
          removedTools: [],
          changedTools: [],
          unchangedTools: [],
          error: `Network error fetching target comparison from ${options.against}: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    } else {
      const againstPath = resolve(cwd, options.against);
      if (!(await fileExists(againstPath))) {
        return {
          ok: false,
          contractRevision,
          sourceHash,
          toolsetHash,
          hasChanges: false,
          hasBreakingChanges: false,
          addedTools: [],
          removedTools: [],
          changedTools: [],
          unchangedTools: [],
          error: `Target comparison file not found: ${againstPath}`,
        };
      }
      againstContent = await readFile(againstPath, "utf8");
    }

    try {
      const parsed = JSON.parse(againstContent) as
        ProjectManifest | CompileManifest;
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
      }
    } catch {
      // Not a JSON manifest, compile as an OpenAPI contract
      const againstCompiled = compileOpenApi(againstContent, {
        strict: false,
      });
      if (againstCompiled.ok) {
        baselineManifest = againstCompiled.manifest;
      } else {
        return {
          ok: false,
          contractRevision,
          sourceHash,
          toolsetHash,
          hasChanges: false,
          hasBreakingChanges: false,
          addedTools: [],
          removedTools: [],
          changedTools: [],
          unchangedTools: [],
          error: `Target comparison contract failed to compile: ${againstCompiled.diagnostics.map((d) => d.message).join("; ")}`,
        };
      }
    }
  } else {
    // Default candidate locations for existing build manifest
    const candidatePaths = [
      resolve(cwd, "dist/chainmcp.manifest.json"),
      resolve(cwd, "dist/manifest.json"),
      resolve(cwd, "manifest.json"),
    ];
    for (const cand of candidatePaths) {
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
            break;
          }
        } catch {
          // Ignore invalid manifest files
        }
      }
    }
  }

  // 3. Compare manifests
  if (!baselineManifest) {
    const currentTools = currentManifest.tools.map((t) => t.name);
    return {
      ok: true,
      contractRevision,
      sourceHash,
      toolsetHash,
      hasChanges: false,
      hasBreakingChanges: false,
      addedTools: currentTools,
      removedTools: [],
      changedTools: [],
      unchangedTools: [],
    };
  }

  const diff = diffManifests(baselineManifest, currentManifest);
  const hasChanges =
    diff.added.length > 0 || diff.removed.length > 0 || diff.changed.length > 0;
  const hasBreakingChanges = diff.removed.length > 0;

  return {
    ok: true,
    contractRevision,
    sourceHash,
    toolsetHash,
    hasChanges,
    hasBreakingChanges,
    addedTools: diff.added,
    removedTools: diff.removed,
    changedTools: diff.changed,
    unchangedTools: diff.unchanged,
  };
}

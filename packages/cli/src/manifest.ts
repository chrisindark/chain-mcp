import { createHash } from "node:crypto";
import { COMPILER_VERSION, type CompileResult } from "@chainmcp/compiler";
import { CLI_VERSION, type ProjectManifest } from "./types.js";

/**
 * Computes a SHA-256 hexadecimal hash of the given UTF-8 content.
 */
export function sha256(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Builds a deterministic ProjectManifest from a contract compilation result and project metadata.
 * Uses a fixed timestamp when deterministicTimestamp is passed, or an ISO string.
 */
export function buildProjectManifest(
  projectName: string,
  compiled: CompileResult,
  options?: { generatedAt?: string },
): ProjectManifest {
  return {
    manifestVersion: 1,
    generatorVersion: CLI_VERSION,
    compilerVersion: COMPILER_VERSION,
    openapiVersion: compiled.manifest.openapiVersion,
    projectName,
    contractRevision: compiled.contractRevision,
    sourceHash: compiled.sourceHash,
    toolsetHash: compiled.manifest.toolsetHash,
    toolCount: compiled.manifest.toolCount,
    tools: compiled.manifest.tools.map((t) => ({
      name: t.name,
      hash: t.hash,
    })),
    ...(compiled.manifest.warnings && compiled.manifest.warnings.length > 0
      ? { warnings: compiled.manifest.warnings }
      : {}),
    generatedAt: options?.generatedAt ?? "2026-01-01T00:00:00.000Z",
  };
}

export interface ManifestVerificationResult {
  match: boolean;
  mismatches: string[];
}

/**
 * Verifies reproducibility between an existing manifest and a fresh compilation.
 */
export function verifyProjectManifest(
  existing: ProjectManifest,
  recompiled: ProjectManifest,
): ManifestVerificationResult {
  const mismatches: string[] = [];

  if (existing.sourceHash !== recompiled.sourceHash) {
    mismatches.push(
      `Source hash mismatch: expected ${existing.sourceHash}, got ${recompiled.sourceHash}`,
    );
  }
  if (existing.contractRevision !== recompiled.contractRevision) {
    mismatches.push(
      `Contract revision mismatch: expected ${existing.contractRevision}, got ${recompiled.contractRevision}`,
    );
  }
  if (existing.toolsetHash !== recompiled.toolsetHash) {
    mismatches.push(
      `Toolset hash mismatch: expected ${existing.toolsetHash}, got ${recompiled.toolsetHash}`,
    );
  }
  if (existing.toolCount !== recompiled.toolCount) {
    mismatches.push(
      `Tool count mismatch: expected ${existing.toolCount}, got ${recompiled.toolCount}`,
    );
  }

  const existingTools = new Map(existing.tools.map((t) => [t.name, t.hash]));
  const recompiledTools = new Map(
    recompiled.tools.map((t) => [t.name, t.hash]),
  );

  for (const [name, hash] of existingTools.entries()) {
    const recompiledHash = recompiledTools.get(name);
    if (!recompiledHash) {
      mismatches.push(`Tool '${name}' missing in recompiled manifest`);
    } else if (recompiledHash !== hash) {
      mismatches.push(
        `Tool '${name}' hash mismatch: expected ${hash}, got ${recompiledHash}`,
      );
    }
  }

  for (const name of recompiledTools.keys()) {
    if (!existingTools.has(name)) {
      mismatches.push(`Unexpected new tool '${name}' in recompiled manifest`);
    }
  }

  return {
    match: mismatches.length === 0,
    mismatches,
  };
}

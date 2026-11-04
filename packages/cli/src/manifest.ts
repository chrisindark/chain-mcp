import { createHash } from "node:crypto";
import { COMPILER_VERSION, type CompileResult } from "@chainmcp/compiler";
import type { ToolDefinition } from "@chainmcp/core";
import type {
  CompiledToolsArtifact,
  ManifestToolEntry,
  ProjectManifest,
} from "./types.js";

export type { CompiledToolsArtifact, ManifestToolEntry };

export interface ManifestOptions {
  /** Generator (CLI) version, read at runtime rather than hardcoded. */
  generatorVersion: string;
  generatedAt?: string | undefined;
}

export interface CodeFirstManifestOptions extends ManifestOptions {
  sourceHash?: string | undefined;
}

/**
 * Computes a SHA-256 hexadecimal hash of the given UTF-8 content.
 */
export function sha256(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Prefix used by compiler and artifact hashes so the algorithm is visible in
 * the value. Keep in sync with the generated server verifier.
 */
export function hashContent(content: string | Uint8Array): string {
  return `sha256:${sha256(content)}`;
}

/**
 * Canonical JSON with object keys sorted. Used to hash a compiled tool record
 * independently of serialization key order.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

export interface SerializedCompiledTools {
  /** Exact file content written to `compiled-tools.json`. */
  content: string;
  artifact: CompiledToolsArtifact;
}

/**
 * Serializes compiled tool records and computes the integrity metadata a
 * generated server verifies at startup. Key order of the input does not affect
 * the hashes, so re-running the generator is deterministic.
 */
export function serializeCompiledTools(
  tools: readonly unknown[],
  options: {
    path?: string | undefined;
    contractRevision?: string | undefined;
  } = {},
): SerializedCompiledTools {
  const content = `${JSON.stringify(tools, null, 2)}\n`;
  const entries: ManifestToolEntry[] = [];
  for (const tool of tools) {
    if (
      tool === null ||
      typeof tool !== "object" ||
      Array.isArray(tool) ||
      typeof (tool as { name?: unknown }).name !== "string"
    ) {
      throw new TypeError(
        "Compiled tool records must be objects with a string name",
      );
    }
    entries.push({
      name: (tool as { name: string }).name,
      hash: hashContent(canonicalJson(tool)),
    });
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  return {
    content,
    artifact: {
      path: options.path ?? "dist/compiled-tools.json",
      sha256: hashContent(content),
      ...(options.contractRevision !== undefined
        ? { contractRevision: options.contractRevision }
        : {}),
      toolCount: tools.length,
      tools: entries,
    },
  };
}

/** Attaches compiled-artifact integrity metadata to a project manifest. */
export function attachCompiledToolsArtifact(
  manifest: ProjectManifest,
  artifact: CompiledToolsArtifact,
): ProjectManifest {
  return { ...manifest, artifacts: { compiledTools: artifact } };
}

/**
 * Builds a deterministic ProjectManifest from a contract compilation result and project metadata.
 * Uses a fixed timestamp when deterministicTimestamp is passed, or an ISO string.
 */
export function buildProjectManifest(
  projectName: string,
  compiled: CompileResult,
  options: ManifestOptions,
): ProjectManifest {
  return {
    manifestVersion: 1,
    generatorVersion: options.generatorVersion,
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

/**
 * Builds a deterministic ProjectManifest for a code-first project from its tool definitions.
 */
export function buildCodeFirstManifest(
  projectName: string,
  tools: readonly ToolDefinition[],
  options: CodeFirstManifestOptions,
): ProjectManifest {
  const toolEntries = tools.map((t) => {
    const canonical = JSON.stringify({
      name: t.name,
      description: t.description ?? "",
      inputSchema: t.inputSchema ?? {},
    });
    return {
      name: t.name,
      hash: sha256(canonical),
    };
  });
  toolEntries.sort((a, b) => a.name.localeCompare(b.name));
  const combinedHashes = toolEntries.map((t) => t.hash).join(":");
  const toolsetHash = sha256(combinedHashes);

  return {
    manifestVersion: 1,
    generatorVersion: options.generatorVersion,
    compilerVersion: COMPILER_VERSION,
    projectName,
    sourceHash: options?.sourceHash ?? sha256("code-first"),
    toolsetHash,
    toolCount: tools.length,
    tools: toolEntries,
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
  if (existing.openapiVersion !== recompiled.openapiVersion) {
    mismatches.push(
      `OpenAPI version mismatch: expected ${existing.openapiVersion}, got ${recompiled.openapiVersion}`,
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

  const existingArtifact = existing.artifacts?.compiledTools;
  const recompiledArtifact = recompiled.artifacts?.compiledTools;
  if (existingArtifact !== undefined && recompiledArtifact !== undefined) {
    if (existingArtifact.sha256 !== recompiledArtifact.sha256) {
      mismatches.push(
        `Compiled tools digest mismatch: expected ${existingArtifact.sha256}, got ${recompiledArtifact.sha256}`,
      );
    }
    if (existingArtifact.toolCount !== recompiledArtifact.toolCount) {
      mismatches.push(
        `Compiled tools count mismatch: expected ${existingArtifact.toolCount}, got ${recompiledArtifact.toolCount}`,
      );
    }
  }

  return {
    match: mismatches.length === 0,
    mismatches,
  };
}

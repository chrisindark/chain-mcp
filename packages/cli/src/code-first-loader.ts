import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ToolDefinition } from "@chainmcp/core";

export async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export interface DiscoveredEntrypoint {
  path: string;
  kind: "tools" | "server";
}

/**
 * Searches for code-first entrypoints (tool definitions or server modules) in order of preference.
 */
export async function discoverCodeFirstEntrypoint(
  cwd: string,
  explicitEntrypoint?: string,
): Promise<DiscoveredEntrypoint | undefined> {
  if (explicitEntrypoint) {
    const explicitPath = resolve(cwd, explicitEntrypoint);
    if (await fileExists(explicitPath)) {
      return {
        path: explicitPath,
        kind: explicitPath.includes("server") ? "server" : "tools",
      };
    }
    return undefined;
  }

  const candidates: Array<{ relPath: string; kind: "tools" | "server" }> = [
    { relPath: "dist/tools.js", kind: "tools" },
    { relPath: "src/tools.js", kind: "tools" },
    { relPath: "tools.js", kind: "tools" },
    { relPath: "dist/server.js", kind: "server" },
    { relPath: "src/server.js", kind: "server" },
    { relPath: "server.js", kind: "server" },
    { relPath: "src/tools.ts", kind: "tools" },
    { relPath: "tools.ts", kind: "tools" },
    { relPath: "src/server.ts", kind: "server" },
    { relPath: "server.ts", kind: "server" },
  ];

  for (const candidate of candidates) {
    const fullPath = resolve(cwd, candidate.relPath);
    if (await fileExists(fullPath)) {
      return {
        path: fullPath,
        kind: candidate.kind,
      };
    }
  }

  return undefined;
}

function isToolLike(value: unknown): value is ToolDefinition {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.name === "string" &&
    obj.name.length > 0 &&
    typeof obj.execute === "function"
  );
}

/**
 * Parses tool names statically using regex when TypeScript source cannot be imported
 * (e.g. before npm install in a newly scaffolded project or in plain Node without tsx).
 */
export function extractToolNamesFromSource(source: string): string[] {
  const names = new Set<string>();

  // Matches defineTool({ name: "..." }) or tool definition schemas
  const defineToolPattern =
    /defineTool\s*\(\s*\{[\s\S]*?name:\s*["']([^"']+)["']/g;
  let match: RegExpExecArray | null = defineToolPattern.exec(source);
  while (match !== null) {
    if (match[1]) {
      names.add(match[1]);
    }
    match = defineToolPattern.exec(source);
  }

  // Fallback for name: "..." in exported objects if none found
  if (names.size === 0) {
    const generalNamePattern = /name:\s*["']([a-zA-Z0-9_-]+)["']/g;
    match = generalNamePattern.exec(source);
    while (match !== null) {
      if (match[1] && match[1] !== "string" && match[1] !== "object") {
        names.add(match[1]);
      }
      match = generalNamePattern.exec(source);
    }
  }

  return Array.from(names);
}

export interface LoadCodeFirstToolsOptions {
  cwd: string;
  explicitEntrypoint?: string | undefined;
  injectedTools?: readonly ToolDefinition[] | undefined;
}

export interface LoadedCodeFirstTools {
  tools: readonly ToolDefinition[];
  toolNames: string[];
  entrypoint?: DiscoveredEntrypoint;
  error?: string;
  staticFallback?: boolean;
}

/**
 * Discovers and loads code-first tool definitions for validation, serving, and exporting.
 */
export async function loadCodeFirstTools(
  options: LoadCodeFirstToolsOptions,
): Promise<LoadedCodeFirstTools> {
  const { cwd, explicitEntrypoint, injectedTools } = options;

  if (injectedTools && injectedTools.length > 0) {
    return {
      tools: injectedTools,
      toolNames: injectedTools.map((t) => t.name),
    };
  }

  const entrypoint = await discoverCodeFirstEntrypoint(cwd, explicitEntrypoint);
  if (!entrypoint) {
    return {
      tools: [],
      toolNames: [],
      error:
        "No code-first entrypoint found. Expected 'src/server.ts' or 'src/tools.ts'.",
    };
  }

  try {
    const fileUrl = pathToFileURL(entrypoint.path).href;
    const imported = (await import(fileUrl)) as Record<string, unknown>;

    const discoveredTools: ToolDefinition[] = [];

    if (Array.isArray(imported.tools)) {
      for (const item of imported.tools) {
        if (isToolLike(item)) {
          discoveredTools.push(item);
        }
      }
    }

    if (discoveredTools.length === 0 && Array.isArray(imported.default)) {
      for (const item of imported.default) {
        if (isToolLike(item)) {
          discoveredTools.push(item);
        }
      }
    }

    if (
      discoveredTools.length === 0 &&
      typeof imported.getTools === "function"
    ) {
      const result = (imported.getTools as () => unknown)();
      if (Array.isArray(result)) {
        for (const item of result) {
          if (isToolLike(item)) {
            discoveredTools.push(item);
          }
        }
      }
    }

    // Check individual named tool exports
    if (discoveredTools.length === 0) {
      for (const value of Object.values(imported)) {
        if (isToolLike(value) && !discoveredTools.includes(value)) {
          discoveredTools.push(value);
        }
      }
    }

    return {
      tools: discoveredTools,
      toolNames: discoveredTools.map((t) => t.name),
      entrypoint,
    };
  } catch (err) {
    // Dynamic import failed (e.g. dependencies not installed or TS file in plain Node)
    try {
      const source = await readFile(entrypoint.path, "utf8");
      const staticNames = extractToolNamesFromSource(source);
      return {
        tools: [],
        toolNames: staticNames,
        entrypoint,
        staticFallback: true,
        error: err instanceof Error ? err.message : String(err),
      };
    } catch {
      return {
        tools: [],
        toolNames: [],
        entrypoint,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

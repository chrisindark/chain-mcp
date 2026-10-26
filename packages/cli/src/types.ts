import type { Readable, Writable } from "node:stream";
import type { CompileDiagnostic, CompileManifest } from "@chainmcp/compiler";
import type { ChainMcpConfig } from "@chainmcp/config";
import type { ToolDefinition } from "@chainmcp/core";

export const CLI_VERSION = "0.1.0";

/**
 * Portable generation manifest emitted in `chainmcp.manifest.json`.
 * Pinned to compiler and generator versions, with deterministic hashes.
 */
export interface ProjectManifest {
  manifestVersion: 1;
  generatorVersion: string;
  compilerVersion: string;
  openapiVersion: string;
  projectName: string;
  contractRevision: string;
  sourceHash: string;
  toolsetHash: string;
  toolCount: number;
  tools: readonly {
    name: string;
    hash: string;
  }[];
  generatedAt: string;
}

export interface InitOptions {
  spec?: string | undefined;
  output?: string | undefined;
  name?: string | undefined;
  baseUrl?: string | undefined;
  blank?: boolean | undefined;
  force?: boolean | undefined;
  cwd?: string | undefined;
}

export interface InitResult {
  ok: boolean;
  projectName: string;
  projectDir: string;
  specPath: string;
  configPath: string;
  toolCount: number;
  createdFiles: readonly string[];
  error?: string | undefined;
}

export interface ValidateOptions {
  config?: string | undefined;
  spec?: string | undefined;
  strict?: boolean | undefined;
  cwd?: string | undefined;
}

export interface ValidateResult {
  ok: boolean;
  config?: ChainMcpConfig | undefined;
  configPath?: string | undefined;
  specPath?: string | undefined;
  contractRevision?: string | undefined;
  sourceHash?: string | undefined;
  toolsetHash?: string | undefined;
  toolCount: number;
  toolNames: readonly string[];
  manifest?: CompileManifest | undefined;
  diagnostics: readonly CompileDiagnostic[];
  error?: string | undefined;
}

export interface BuildOptions {
  config?: string | undefined;
  spec?: string | undefined;
  outDir?: string | undefined;
  strict?: boolean | undefined;
  check?: boolean | undefined;
  cwd?: string | undefined;
}

export interface BuildResult {
  ok: boolean;
  outDir: string;
  manifestPath: string;
  manifest: ProjectManifest;
  toolCount: number;
  verifiedReproducible?: boolean | undefined;
  error?: string | undefined;
}

export interface ServeOptions {
  config?: string | undefined;
  spec?: string | undefined;
  transport?: "stdio" | "http" | undefined;
  port?: number | undefined;
  host?: string | undefined;
  path?: string | undefined;
  baseUrl?: string | undefined;
  tenantId?: string | undefined;
  cwd?: string | undefined;
  stdin?: Readable | undefined;
  stdout?: Writable | undefined;
  signal?: AbortSignal | undefined;
}

export interface ServeResult {
  ok: boolean;
  serverName: string;
  toolCount: number;
  url?: URL | undefined;
  close(): Promise<void>;
  closed: Promise<void>;
}

export interface DevOptions {
  config?: string | undefined;
  spec?: string | undefined;
  baseUrl?: string | undefined;
  cwd?: string | undefined;
  tools?: readonly ToolDefinition[] | undefined;
  tenantId?: string | undefined;
  stdin?: Readable | undefined;
  stdout?: Writable | undefined;
  signal?: AbortSignal | undefined;
}

export interface DevResult {
  ok: boolean;
  serverName: string;
  toolCount: number;
  toolNames: readonly string[];
  close(): Promise<void>;
  closed: Promise<void>;
  error?: string | undefined;
}

export interface ExportOptions {
  config?: string | undefined;
  spec?: string | undefined;
  output?: string | undefined;
  force?: boolean | undefined;
  check?: boolean | undefined;
  workspaceDependencies?: boolean | undefined;
  dependencyOverrides?: Record<string, string> | undefined;
  cwd?: string | undefined;
}

export interface ExportResult {
  ok: boolean;
  outputDir: string;
  manifest: ProjectManifest;
  filesWritten: readonly string[];
  verifiedReproducible?: boolean | undefined;
  error?: string | undefined;
}

export interface CliIo {
  stdout?: ((msg: string) => void) | undefined;
  stderr?: ((msg: string) => void) | undefined;
  stdin?: Readable | undefined;
  stdoutStream?: Writable | undefined;
}

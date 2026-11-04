# API Reference: @chainmcp/cli

## `@chainmcp/cli`

The `@chainmcp/cli` package implements developer commands and generated server scaffolding and export capabilities.

### CLI Binary

Exported as the `chainmcp` executable (`dist/bin.js`).

```bash
chainmcp init [--spec <path|url>] [--blank] [--output <dir>] [--name <name>] [--base-url <url>] [--allow-http] [--force] [--local-deps <path>] [--workspace-deps]
chainmcp validate [--config <path>] [--spec <path|url>] [--strict] [--json] [--allow-http] [--require-contract]
chainmcp build [--config <path>] [--spec <path|url>] [--out-dir <dir>] [--allow-http] [--check] [--require-contract]
chainmcp diff [--config <path>] [--spec <path|url>] [--against <target>] [--fail-on <breaking|breaking+potential|none>] [--fail-on-breaking] [--json] [--allow-http]
chainmcp serve [--config <path>] [--spec <path|url>] [--transport <stdio|http>] [--port <number>] [--host <string>] [--path <string>] [--allow-unauthenticated-http] [--allow-http] [--base-url <url>] [--tenant <id>] [--require-contract]
chainmcp gateway serve [--config <path>] [--transport <stdio|http>] [--port <number>] [--host <string>] [--path <string>] [--allow-unauthenticated-http] [--tenant <id>]
chainmcp dev [--config <path>] [--spec <path|url>] [--base-url <url>] [--allow-http] [--tenant <id>]
chainmcp export [--config <path>] [--spec <path|url>] [--output <dir>] [--allow-http] [--force] [--check] [--require-contract] [--local-deps <path>] [--workspace-deps]
chainmcp config explain [--config <path>] [--json]
```

### Configuration inspection

`chainmcp config explain` loads the project configuration, resolves
`${VAR}` / `${VAR:-default}` secret references, validates the result, and prints
the resolved configuration with every credential field replaced by
`[REDACTED]`. It also prints value-free provenance for each secret
(`auth.inbound.tokens[#1]: ${INBOUND_TOKEN}`). `--json` emits
`{ configPath, config, secretSources }`. A missing variable exits non-zero with
`SECRET_UNRESOLVED` naming the field and variable; resolved values are never
printed.

### Local dependency mode

The workspace packages are unpublished. `init` and `export` accept two explicit
modes for dependency specifiers:

- `--local-deps <path>`: `path` must be the root of a cloned ChainMcp
  repository. Every `@chainmcp/*` dependency becomes a relative `file:`
  specifier, and the generated project receives a `pnpm-workspace.yaml` whose
  `overrides` map each internal package back to the same local directory. The
  override block is required because linked packages declare `workspace:*`
  siblings. Install generated projects with pnpm.
- `--workspace-deps`: keeps `workspace:*` specifiers for projects generated
  inside the monorepo.

The two flags are mutually exclusive. The repository root is never inferred
from the current working directory. Passing a directory that is missing any
required package fails before any files are written.

### Programmatic API

```ts
export function runCli(args: string[], io?: CliIo): Promise<number>;

export function configExplainCommand(
  options: ConfigExplainOptions,
): Promise<ConfigExplainResult>;

export function findConfigPath(
  options: FindConfigPathOptions,
): Promise<string | undefined>;

export function loadServerConfigFile(
  configPath: string,
  options?: { env?: Readonly<Record<string, string | undefined>> },
): Promise<LoadedServerConfig>;

export interface ConfigExplainOptions {
  config?: string | undefined;
  cwd?: string | undefined;
  env?: Readonly<Record<string, string | undefined>> | undefined;
}

export interface ConfigExplainResult {
  ok: boolean;
  configPath?: string | undefined;
  config?: unknown;
  secretSources?: readonly SecretResolutionSource[] | undefined;
  error?: string | undefined;
}

export interface FindConfigPathOptions {
  explicit?: string | undefined;
  cwd: string;
  env?: Readonly<Record<string, string | undefined>>;
}

export interface LoadedServerConfig {
  readonly config: ChainMcpConfig;
  readonly rawConfig: Record<string, unknown> | undefined;
  readonly secretSources: readonly SecretResolutionSource[];
}

export function initCommand(options: InitOptions): Promise<InitResult>;
export function validateCommand(
  options: ValidateOptions,
): Promise<ValidateResult>;
export function buildCommand(options: BuildOptions): Promise<BuildResult>;
export function diffCommand(options: DiffOptions): Promise<DiffResult>;
export function serveCommand(options: ServeOptions): Promise<ServeResult>;
export function gatewayServeCommand(
  options: GatewayServeOptions,
): Promise<GatewayServeResult>;
export function devCommand(options: DevOptions): Promise<DevResult>;
export function exportCommand(options: ExportOptions): Promise<ExportResult>;

export function loadSpec(options: LoadSpecOptions): Promise<LoadedSpec>;

export interface LoadSpecOptions {
  source: string;
  allowHttp?: boolean | undefined;
  timeoutMs?: number | undefined;
  maxBytes?: number | undefined;
  maxRedirects?: number | undefined;
  allowPrivateHosts?: boolean | undefined;
  signal?: AbortSignal | undefined;
  cwd?: string | undefined;
  rejectUnauthorized?: boolean | undefined;
  resolver?: HostResolver | undefined;
}

export interface LoadedSpec {
  content: string;
  sourceKind: "file" | "url";
  resolvedSource: string;
  bytes: number;
  contentType?: string | undefined;
}

/**
 * Reads the CLI's own version from its package.json at runtime. The value is
 * cached after the first successful read.
 */
export function getCliVersion(): Promise<string>;

export interface LocalDependencyOptions {
  /** Explicit path to the cloned ChainMcp repository root. */
  repoRoot: string;
  /** Directory that will contain the generated project's package.json. */
  projectDir: string;
}

export interface LocalDependencyResult {
  ok: boolean;
  /** Relative `file:` specifier for every required @chainmcp package. */
  specs: Record<string, string>;
  repoRoot: string;
  error?: string | undefined;
}

export function resolveLocalDependencySpecs(
  options: LocalDependencyOptions,
): Promise<LocalDependencyResult>;

export function buildProjectManifest(
  projectName: string,
  compiled: CompileResult,
  options: { generatorVersion: string; generatedAt?: string },
): ProjectManifest;

export function buildCodeFirstManifest(
  projectName: string,
  tools: readonly ToolDefinition[],
  options: {
    generatorVersion: string;
    sourceHash?: string;
    generatedAt?: string;
  },
): ProjectManifest;

export function verifyProjectManifest(
  existing: ProjectManifest,
  recompiled: ProjectManifest,
): ManifestVerificationResult;

export interface ManifestToolEntry {
  name: string;
  hash: string;
}

export interface CompiledToolsArtifact {
  /** Project-relative artifact path, e.g. `dist/compiled-tools.json`. */
  path: string;
  /** `sha256:` digest of the artifact bytes exactly as written. */
  sha256: string;
  contractRevision?: string | undefined;
  toolCount: number;
  tools: readonly ManifestToolEntry[];
}

export interface SerializedCompiledTools {
  content: string;
  artifact: CompiledToolsArtifact;
}

export function serializeCompiledTools(
  tools: readonly unknown[],
  options?: { path?: string; contractRevision?: string },
): SerializedCompiledTools;

export function attachCompiledToolsArtifact(
  manifest: ProjectManifest,
  artifact: CompiledToolsArtifact,
): ProjectManifest;

export function hashContent(content: string | Uint8Array): string;
export function canonicalJson(value: unknown): string;

export function loadCodeFirstTools(
  options: LoadCodeFirstToolsOptions,
): Promise<LoadedCodeFirstTools>;

export function discoverCodeFirstEntrypoint(
  cwd: string,
  explicitEntrypoint?: string,
): Promise<DiscoveredEntrypoint | undefined>;

export function extractToolNamesFromSource(source: string): string[];

export type DiffFailOn = "breaking" | "breaking+potential" | "none";

export interface DiffOptions {
  config?: string | undefined;
  spec?: string | undefined;
  against?: string | undefined;
  allowHttp?: boolean | undefined;
  failOn?: DiffFailOn | undefined;
  failOnBreaking?: boolean | undefined;
  json?: boolean | undefined;
  cwd?: string | undefined;
}

export interface DiffResult {
  schemaVersion: 1;
  ok: boolean;
  contractRevision: string;
  sourceHash: string;
  toolsetHash: string;
  hasChanges: boolean;
  hasBreakingChanges: boolean;
  hasPotentiallyBreakingChanges: boolean;
  summary: {
    breaking: number;
    potentiallyBreaking: number;
    nonBreaking: number;
  };
  addedTools: readonly string[];
  removedTools: readonly string[];
  changedTools: readonly string[];
  unchangedTools: readonly string[];
  changes: readonly ContractChange[];
  breaking: readonly ContractChange[];
  potentiallyBreaking: readonly ContractChange[];
  nonBreaking: readonly ContractChange[];
  error?: string | undefined;
}
```

### Manifest Schema (`chainmcp.manifest.json`)

```ts
export interface ProjectManifest {
  manifestVersion: 1;
  generatorVersion: string;
  compilerVersion: string;
  openapiVersion?: string | undefined;
  projectName: string;
  contractRevision?: string | undefined;
  sourceHash: string;
  toolsetHash: string;
  toolCount: number;
  tools: readonly {
    name: string;
    hash: string;
  }[];
  warnings?: readonly CompileDiagnostic[];
  /**
   * Integrity metadata for emitted build artifacts. Generated servers verify
   * this before registering tools so a stale or modified artifact fails fast.
   */
  artifacts?: { compiledTools: CompiledToolsArtifact } | undefined;
  generatedAt: string;
}
```

Generated servers load `dist/compiled-tools.json` and verify `manifestVersion`,
`generatorVersion`, `compilerVersion`, `sourceHash`, `contractRevision`,
`toolCount`, `artifacts.compiledTools.sha256`, and every per-tool hash before
registering tools. Recompiling the pinned contract happens only when
`NODE_ENV=development` and the artifact is unreadable, so production startup
does not import `@chainmcp/compiler`.

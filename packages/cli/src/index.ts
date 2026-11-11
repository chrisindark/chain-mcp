import { getCliVersion } from "./version.js";
export { getCliVersion };

export {
  resolveLocalDependencySpecs,
  type LocalDependencyOptions,
  type LocalDependencyResult,
} from "./local-deps.js";
export type {
  BuildOptions,
  BuildResult,
  CliIo,
  ConfigExplainOptions,
  ConfigExplainResult,
  DevOptions,
  DevResult,
  DiffOptions,
  DiffResult,
  ExportOptions,
  ExportResult,
  GatewayServeOptions,
  GatewayServeResult,
  InitOptions,
  InitResult,
  LoadSpecOptions,
  LoadedSpec,
  ProjectManifest,
  ServeOptions,
  ServeResult,
  ValidateOptions,
  ValidateResult,
} from "./types.js";

export { loadSpec } from "./spec-loader.js";
export {
  loadCodeFirstTools,
  discoverCodeFirstEntrypoint,
  extractToolNamesFromSource,
  type DiscoveredEntrypoint,
  type LoadCodeFirstToolsOptions,
  type LoadedCodeFirstTools,
} from "./code-first-loader.js";

export { runCli } from "./cli.js";
export { configExplainCommand } from "./commands/config.js";
export { doctorCommand } from "./commands/doctor.js";
export { adminCommand } from "./commands/admin.js";
export {
  studioCommand,
  type StudioCommandOptions,
  type StudioCommandResult,
} from "./commands/studio.js";
export {
  DEFAULT_CONFIG_FILENAMES,
  findConfigPath,
  loadServerConfigFile,
  pathExists,
  type FindConfigPathOptions,
  type LoadedServerConfig,
} from "./config-loader.js";
export { initCommand } from "./commands/init.js";
export { validateCommand } from "./commands/validate.js";
export { buildCommand } from "./commands/build.js";
export { diffCommand } from "./commands/diff.js";
export { devCommand } from "./commands/dev.js";
export { serveCommand } from "./commands/serve.js";
export { gatewayServeCommand } from "./commands/gateway-serve.js";
export { exportCommand } from "./commands/export.js";

export {
  attachCompiledToolsArtifact,
  buildCodeFirstManifest,
  buildProjectManifest,
  canonicalJson,
  hashContent,
  serializeCompiledTools,
  sha256,
  verifyProjectManifest,
  type CodeFirstManifestOptions,
  type CompiledToolsArtifact,
  type ManifestOptions,
  type ManifestToolEntry,
  type ManifestVerificationResult,
  type SerializedCompiledTools,
} from "./manifest.js";

export {
  CHAINMCP_PACKAGE_DEPENDENCIES,
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
  type ConfigYamlOptions,
  type PackageJsonOptions,
  type PnpmWorkspaceOptions,
  type ReadmeOptions,
  type ServerTsOptions,
} from "./templates.js";

export { CLI_VERSION } from "./types.js";
export type {
  BuildOptions,
  BuildResult,
  CliIo,
  DevOptions,
  DevResult,
  ExportOptions,
  ExportResult,
  GatewayServeOptions,
  GatewayServeResult,
  InitOptions,
  InitResult,
  ProjectManifest,
  ServeOptions,
  ServeResult,
  ValidateOptions,
  ValidateResult,
} from "./types.js";

export { runCli } from "./cli.js";
export { initCommand } from "./commands/init.js";
export { validateCommand } from "./commands/validate.js";
export { buildCommand } from "./commands/build.js";
export { devCommand } from "./commands/dev.js";
export { serveCommand } from "./commands/serve.js";
export { gatewayServeCommand } from "./commands/gateway-serve.js";
export { exportCommand } from "./commands/export.js";

export {
  buildProjectManifest,
  sha256,
  verifyProjectManifest,
  type ManifestVerificationResult,
} from "./manifest.js";

export {
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
  type ConfigYamlOptions,
  type PackageJsonOptions,
  type ReadmeOptions,
} from "./templates.js";

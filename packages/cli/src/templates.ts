import { stringify } from "yaml";

/** Workspace packages every generated project depends on. */
export const CHAINMCP_PACKAGE_DEPENDENCIES = [
  "@chainmcp/analytics",
  "@chainmcp/auth",
  "@chainmcp/authoring",
  "@chainmcp/cache-redis",
  "@chainmcp/compiler",
  "@chainmcp/config",
  "@chainmcp/core",
  "@chainmcp/executor",
  "@chainmcp/json-navigation",
  "@chainmcp/rate-limit",
  "@chainmcp/server",
] as const;

export interface PackageJsonOptions {
  name: string;
  /** Generator version. Required so output never pins a hardcoded literal. */
  version: string;
  workspaceDependencies?: boolean | undefined;
  /** Per-package dependency specifiers, e.g. local `file:` paths. */
  dependencySpecs?: Readonly<Record<string, string>> | undefined;
  dependencyOverrides?: Record<string, string> | undefined;
  /** Emit a pnpm packageManager pin (local repository mode). */
  localDependencies?: boolean | undefined;
}

export function renderPackageJson(options: PackageJsonOptions): string {
  const versionSpec =
    options.workspaceDependencies === true
      ? "workspace:*"
      : `^${options.version}`;

  const defaultDependencies: Record<string, string> = {};
  for (const name of CHAINMCP_PACKAGE_DEPENDENCIES) {
    defaultDependencies[name] = versionSpec;
  }
  defaultDependencies.yaml = "^2.9.1";
  defaultDependencies.zod = "^4.1.12";

  const finalDependencies = {
    ...defaultDependencies,
    ...(options.dependencySpecs ?? {}),
    ...(options.dependencyOverrides ?? {}),
  };

  // Sort keys deterministically
  const sortedDeps: Record<string, string> = {};
  for (const key of Object.keys(finalDependencies).sort()) {
    const val = finalDependencies[key];
    if (val !== undefined) {
      sortedDeps[key] = val;
    }
  }

  const pkg = {
    name: options.name,
    version: options.version,
    private: true,
    type: "module",
    ...(options.localDependencies === true
      ? { packageManager: "pnpm@11.0.0" }
      : {}),
    scripts: {
      build: "tsc -p tsconfig.build.json",
      start: "node dist/server.js",
      typecheck: "tsc -p tsconfig.json --noEmit",
    },
    dependencies: sortedDeps,
    devDependencies: {
      "@types/node": "^22.19.0",
      typescript: "^5.9.3",
    },
  };

  return `${JSON.stringify(pkg, null, 2)}\n`;
}

export interface PnpmWorkspaceOptions {
  /** Local `file:` dependency specifiers, also applied as overrides. */
  overrides: Readonly<Record<string, string>>;
}

/**
 * pnpm 11 reads settings from `pnpm-workspace.yaml`. Linked workspace packages
 * still declare `workspace:*` for their siblings, so local mode has to override
 * each internal package back to its local path.
 */
export function renderPnpmWorkspaceYaml(options: PnpmWorkspaceOptions): string {
  const workspace = {
    packages: ["."],
    overrides: { ...options.overrides },
  };
  return stringify(workspace);
}

export function renderTsconfigJson(): string {
  const tsconfig = {
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      lib: ["ES2022"],
      types: ["node"],
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      forceConsistentCasingInFileNames: true,
      noEmit: true,
    },
    include: ["src/**/*.ts"],
  };

  return `${JSON.stringify(tsconfig, null, 2)}\n`;
}

export function renderTsconfigBuildJson(): string {
  const tsconfigBuild = {
    extends: "./tsconfig.json",
    compilerOptions: {
      noEmit: false,
      rootDir: "src",
      outDir: "dist",
      declaration: true,
    },
    include: ["src/**/*.ts"],
  };

  return `${JSON.stringify(tsconfigBuild, null, 2)}\n`;
}

export interface ConfigYamlOptions {
  name: string;
  allowedHosts: readonly string[];
  specRelativePath?: string | undefined;
  blank?: boolean | undefined;
  baseUrl?: string | undefined;
  allowInsecureHttp?: boolean | undefined;
  transport?: "stdio" | "http" | undefined;
}

export function renderConfigYaml(options: ConfigYamlOptions): string {
  const isBlank = options.blank === true;
  const config = {
    version: 1,
    name: options.name,
    ...(isBlank
      ? {}
      : {
          contract: {
            source: options.specRelativePath ?? "./spec/openapi.yaml",
            strict: true,
            ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
          },
        }),
    server: {
      transport: options.transport ?? "stdio",
      requestTimeoutMs: 15000,
      maxResponseBytes: 1000000,
      toolsPageSize: 100,
    },
    security: {
      requireInboundAuth: false,
      allowUnauthenticatedHttp: false,
      ...(options.allowInsecureHttp ? { allowInsecureHttp: true } : {}),
      allowedUpstreamHosts: [...options.allowedHosts],
    },
    rateLimit: {
      enabled: false,
    },
    auth: {
      inbound: {
        requireInboundAuth: false,
      },
    },
    logging: {
      level: "info",
    },
    jsonNavigation: {
      enabled: true,
    },
    analytics: {
      enabled: true,
    },
  };

  return stringify(config);
}

export interface ServerTsOptions {
  /** Generator version embedded in the generated server metadata. */
  version: string;
  /**
   * Compiler version embedded at generation time. The generated server checks
   * build artifacts against it, so production startup never imports the
   * compiler.
   */
  compilerVersion: string;
}

export function renderServerTs(options: ServerTsOptions): string {
  return `import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

import {
  buildExecutorOptions,
  buildReadinessDeps,
  buildRuntimeOptions,
  createHandleRegistryOptionsFromConfig,
  createNavigationLimitsFromConfig,
  loadTokenizerFromConfig,
  logRateLimiterStartup,
  parseConfig,
  resolveConfigSecrets,
  type RedisRateLimitClient,
} from "@chainmcp/config";
import { InMemoryToolRuntime, RuntimeError } from "@chainmcp/core";
import {
  createUpstreamExecutor,
  type UpstreamTransport,
} from "@chainmcp/executor";
import { createJsonNavigationTools } from "@chainmcp/json-navigation";
import {
  connectMcpServer,
  createInboundVerifier,
  serveHttp,
  serveStdio,
  type McpRequestContext,
  type Transport,
} from "@chainmcp/server";
import { tools } from "./tools.js";

/** Generator version pinned when this project was scaffolded. */
const GENERATOR_VERSION = ${JSON.stringify(options.version)};
/** Compiler version pinned when this project was scaffolded. */
const COMPILER_VERSION = ${JSON.stringify(options.compilerVersion)};

const MANIFEST_FILE = "chainmcp.manifest.json";
const COMPILED_TOOLS_ARTIFACT_PATH = "dist/compiled-tools.json";
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;

interface VerifiedArtifacts {
  /** False when the manifest or artifact could not be read or parsed. */
  readable: boolean;
  tools: unknown[];
  contractRevision: string | undefined;
  mismatches: string[];
}

function hashContent(content: string | Uint8Array): string {
  return "sha256:" + createHash("sha256").update(content).digest("hex");
}

/** Canonical JSON with sorted object keys, matching the generator's hashing. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalJson).join(",") + "]";
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .map((key) => JSON.stringify(key) + ":" + canonicalJson(record[key]));
    return "{" + entries.join(",") + "}";
  }
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toolName(tool: unknown): string | undefined {
  if (!isRecord(tool)) return undefined;
  return typeof tool.name === "string" ? tool.name : undefined;
}

function parseToolHashes(
  value: unknown,
  mismatches: string[],
): Map<string, string> {
  const hashes = new Map<string, string>();
  if (!Array.isArray(value)) {
    mismatches.push(
      "Manifest records no per-tool hashes for " + COMPILED_TOOLS_ARTIFACT_PATH,
    );
    return hashes;
  }
  for (const entry of value) {
    if (
      isRecord(entry) &&
      typeof entry.name === "string" &&
      typeof entry.hash === "string"
    ) {
      hashes.set(entry.name, entry.hash);
    } else {
      mismatches.push("Manifest contains a malformed tool hash entry");
    }
  }
  return hashes;
}

/**
 * Loads the generation manifest and compiled tool definitions and verifies
 * that they still describe each other and the pinned contract. Returns every
 * mismatch instead of throwing so the caller decides whether drift is fatal.
 */
async function verifyBuildArtifacts(
  projectRoot: string,
  specPath: string,
): Promise<VerifiedArtifacts> {
  const manifestPath = join(projectRoot, MANIFEST_FILE);
  const compiledToolsPath = join(projectRoot, COMPILED_TOOLS_ARTIFACT_PATH);
  const mismatches: string[] = [];

  let manifest: Record<string, unknown>;
  let compiledToolsRaw: string;
  let parsedTools: unknown;
  try {
    const [manifestRaw, artifactRaw] = await Promise.all([
      readFile(manifestPath, "utf8"),
      readFile(compiledToolsPath, "utf8"),
    ]);
    compiledToolsRaw = artifactRaw;
    const parsedManifest: unknown = JSON.parse(manifestRaw);
    if (!isRecord(parsedManifest)) {
      throw new Error(MANIFEST_FILE + " must contain a JSON object");
    }
    manifest = parsedManifest;
    parsedTools = JSON.parse(compiledToolsRaw) as unknown;
  } catch (error) {
    return {
      readable: false,
      tools: [],
      contractRevision: undefined,
      mismatches: [
        "build artifacts could not be read (" +
          (error instanceof Error ? error.message : String(error)) +
          "); expected " +
          MANIFEST_FILE +
          " and " +
          COMPILED_TOOLS_ARTIFACT_PATH,
      ],
    };
  }

  if (manifest.manifestVersion !== 1) {
    mismatches.push(
      "manifest schema version mismatch: expected 1, got " +
        String(manifest.manifestVersion),
    );
  }
  if (manifest.generatorVersion !== GENERATOR_VERSION) {
    mismatches.push(
      "generator version mismatch: expected " +
        GENERATOR_VERSION +
        ", got " +
        String(manifest.generatorVersion),
    );
  }
  if (manifest.compilerVersion !== COMPILER_VERSION) {
    mismatches.push(
      "compiler version mismatch: expected " +
        COMPILER_VERSION +
        ", got " +
        String(manifest.compilerVersion),
    );
  }
  const contractRevision =
    typeof manifest.contractRevision === "string" &&
    SHA256_PATTERN.test(manifest.contractRevision)
      ? manifest.contractRevision
      : undefined;
  if (contractRevision === undefined) {
    mismatches.push("contract revision is missing or malformed");
  }
  const sourceHash =
    typeof manifest.sourceHash === "string" &&
    SHA256_PATTERN.test(manifest.sourceHash)
      ? manifest.sourceHash
      : undefined;
  if (sourceHash === undefined) {
    mismatches.push("source hash is missing or malformed");
  }

  if (!Array.isArray(parsedTools)) {
    return {
      readable: false,
      tools: [],
      contractRevision,
      mismatches: [
        ...mismatches,
        COMPILED_TOOLS_ARTIFACT_PATH +
          " must contain an array of compiled tools",
      ],
    };
  }
  const compiledTools: unknown[] = parsedTools;
  if (manifest.toolCount !== compiledTools.length) {
    mismatches.push(
      "tool count mismatch: manifest " +
        String(manifest.toolCount) +
        ", compiled-tools " +
        compiledTools.length,
    );
  }

  const artifactMetadata = isRecord(manifest.artifacts)
    ? manifest.artifacts.compiledTools
    : undefined;
  if (!isRecord(artifactMetadata)) {
    mismatches.push(
      "manifest does not record compiled-tools.json integrity (artifacts.compiledTools); rebuild the project",
    );
  } else {
    if (artifactMetadata.sha256 !== hashContent(compiledToolsRaw)) {
      mismatches.push(
        COMPILED_TOOLS_ARTIFACT_PATH +
          " digest does not match the manifest; the build artifact was modified after build",
      );
    }
    if (artifactMetadata.toolCount !== compiledTools.length) {
      mismatches.push(
        "artifact tool count mismatch: manifest " +
          String(artifactMetadata.toolCount) +
          ", compiled-tools " +
          compiledTools.length,
      );
    }
    if (artifactMetadata.contractRevision !== contractRevision) {
      mismatches.push(
        "artifact contract revision does not match the manifest contract revision",
      );
    }
    const expectedHashes = parseToolHashes(
      artifactMetadata.tools,
      mismatches,
    );
    for (const tool of compiledTools) {
      const name = toolName(tool);
      if (name === undefined) {
        mismatches.push(
          "compiled-tools.json contains a tool without a name",
        );
        continue;
      }
      const expectedHash = expectedHashes.get(name);
      if (expectedHash === undefined) {
        mismatches.push(
          "tool '" + name + "' is missing from the manifest tool hashes",
        );
        continue;
      }
      expectedHashes.delete(name);
      if (expectedHash !== hashContent(canonicalJson(tool))) {
        mismatches.push(
          "tool '" + name + "' does not match its manifest hash",
        );
      }
    }
    for (const name of expectedHashes.keys()) {
      mismatches.push(
        "tool '" +
          name +
          "' is recorded in the manifest but missing from " +
          COMPILED_TOOLS_ARTIFACT_PATH,
      );
    }
  }

  const manifestTools = Array.isArray(manifest.tools) ? manifest.tools : [];
  if (manifestTools.length !== compiledTools.length) {
    mismatches.push(
      "tool set mismatch between manifest and " + COMPILED_TOOLS_ARTIFACT_PATH,
    );
  } else {
    const manifestNames = new Set<string>();
    for (const entry of manifestTools) {
      const name = toolName(entry);
      if (name !== undefined) manifestNames.add(name);
    }
    for (const tool of compiledTools) {
      const name = toolName(tool);
      if (name !== undefined && !manifestNames.has(name)) {
        mismatches.push("tool '" + name + "' is missing from the manifest");
      }
    }
  }

  if (sourceHash !== undefined) {
    try {
      const specContent = await readFile(specPath, "utf8");
      if (hashContent(specContent) !== sourceHash) {
        mismatches.push(
          "pinned contract '" +
            specPath +
            "' changed after build (source hash no longer matches the manifest)",
        );
      }
    } catch (error) {
      mismatches.push(
        "pinned contract '" +
          specPath +
          "' could not be read (" +
          (error instanceof Error ? error.message : String(error)) +
          ")",
      );
    }
  }

  return {
    readable: true,
    tools: compiledTools,
    contractRevision,
    mismatches,
  };
}

export interface RunServerOptions {
  configPath?: string;
  contractPath?: string;
  baseUrl?: string;
  transport?: UpstreamTransport;
  resolveHost?: (hostname: string) => Promise<string[]>;
  serverTransport?: Transport;
  stdin?: Readable;
  stdout?: Writable;
  signal?: AbortSignal;
}

export async function runServer(options?: RunServerOptions) {
  const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

  const configPath =
    options?.configPath ??
    process.env.CHAINMCP_CONFIG ??
    join(projectRoot, "chainmcp.config.yaml");
  const rawConfigText = await readFile(configPath, "utf8");
  const rawConfig = parseYaml(rawConfigText);
  const config = parseConfig(resolveConfigSecrets(rawConfig).config);

  const tokenizer = await loadTokenizerFromConfig(config.tokenMetrics, {
    baseDir: projectRoot,
  });
  const runtimeOptions = buildRuntimeOptions(
    config,
    tokenizer !== undefined ? { tokenizer } : {},
  );
  const runtime = new InMemoryToolRuntime(runtimeOptions);
  await logRateLimiterStartup(config.rateLimit, {
    logger: runtimeOptions.logger,
    client: (
      runtimeOptions.rateLimiter as
        | { client?: RedisRateLimitClient }
        | undefined
    )?.client,
  });

  // Register verified contract operations if a contract is configured.
  const effectiveContractPath =
    options?.contractPath ??
    (config.contract?.source ? join(projectRoot, config.contract.source) : undefined);

  if (effectiveContractPath) {
    const allowManifestDrift =
      process.env.CHAINMCP_ALLOW_MANIFEST_DRIFT === "1" ||
      process.argv.includes("--allow-manifest-drift");
    const developmentMode = process.env.NODE_ENV === "development";

    const verification = await verifyBuildArtifacts(
      projectRoot,
      effectiveContractPath,
    );
    if (verification.mismatches.length > 0) {
      const detail = verification.mismatches.join("; ");
      if (allowManifestDrift) {
        console.warn(
          "[WARN] Build artifact verification failed (--allow-manifest-drift): " +
            detail,
        );
      } else if (verification.readable || !developmentMode) {
        throw new Error(
          "[ERROR] Build artifact verification failed: " +
            detail +
            ". Rebuild with 'chainmcp build', or start with --allow-manifest-drift for development.",
        );
      }
    }

    let compiledTools: readonly unknown[] = verification.tools;
    let contractRevision = verification.contractRevision;

    // Development fallback: recompile the pinned contract. Production startup
    // uses the verified artifact and never imports the compiler.
    if (!verification.readable) {
      if (!allowManifestDrift && !developmentMode) {
        throw new Error(
          "Build artifacts are missing and development recompilation is disabled. Rebuild with 'chainmcp build'.",
        );
      }
      console.warn(
        "[WARN] Build artifacts unavailable; recompiling the pinned contract in development mode.",
      );
      const { compileOpenApi } = await import("@chainmcp/compiler");
      const contractSource = await readFile(effectiveContractPath, "utf8");
      const compiled = compileOpenApi(contractSource, {
        strict: config.contract?.strict ?? true,
      });
      if (!compiled.ok) {
        const diagnostics = compiled.diagnostics
          .filter((diagnostic) => diagnostic.severity === "error")
          .map(
            (diagnostic) =>
              "[" + diagnostic.code + "] " + diagnostic.message,
          )
          .join("; ");
        throw new Error("Contract compilation failed: " + diagnostics);
      }
      compiledTools = compiled.tools;
      contractRevision = compiled.contractRevision;
    }

    const baseUrl =
      options?.baseUrl ??
      config.contract?.baseUrl ??
      (config.security.allowedUpstreamHosts[0]
        ? "https://" + config.security.allowedUpstreamHosts[0]
        : undefined);

    if (!baseUrl) {
      throw new Error(
        "No baseUrl configured in contract.baseUrl or options, and security.allowedUpstreamHosts is empty.",
      );
    }

    const executorOverrides: Parameters<typeof buildExecutorOptions>[1] = {
      baseUrl,
      ...(contractRevision !== undefined ? { contractRevision } : {}),
      ...(options?.transport !== undefined ? { transport: options.transport } : {}),
      ...(options?.resolveHost !== undefined
        ? { resolveHost: options.resolveHost }
        : {}),
    };

    const executorOptions = buildExecutorOptions(config, executorOverrides);
    const executor = createUpstreamExecutor(executorOptions);

    for (const tool of executor.createTools(
      compiledTools as Parameters<typeof executor.createTools>[0],
    )) {
      runtime.register(tool);
    }
  }
  // Register code-defined tools
  for (const customTool of tools) {
    runtime.register(customTool);
  }

  // Register JSON navigation tools if enabled
  if (config.jsonNavigation.enabled) {
    const limits = createNavigationLimitsFromConfig(config.jsonNavigation);
    const handles = createHandleRegistryOptionsFromConfig(
      config.jsonNavigation,
    );
    const navTools = createJsonNavigationTools(limits, handles);
    for (const navTool of navTools) {
      runtime.register(navTool);
    }
  }

  const serverOptions = {
    name: config.name,
    version: GENERATOR_VERSION,
    maxResponseBytes: config.server.maxResponseBytes,
    toolsPageSize: config.server.toolsPageSize,
    createContext: (request: McpRequestContext) => {
      const auth = request.authInfo;
      const authTenant =
        typeof auth?.extra?.tenantId === "string" &&
        auth.extra.tenantId.trim().length > 0
          ? auth.extra.tenantId
          : undefined;
      const explicitTenant = config.tenant;
      const tenantId = authTenant ?? explicitTenant;
      if (auth && !tenantId) {
        throw new RuntimeError(
          "TENANT_REQUIRED",
          "Tenant context required: authenticated principal has no tenantId",
        );
      }
      return {
        requestId: randomUUID(),
        tenantId: tenantId ?? "",
        principal: {
          id: auth?.clientId ?? "mcp-caller",
          scopes: auth?.scopes ?? [],
        },
      };
    },
  };

  if (options?.serverTransport !== undefined) {
    return await connectMcpServer(
      runtime,
      options.serverTransport,
      serverOptions,
    );
  }

  if (config.server.transport === "http") {
    const verifier = createInboundVerifier(config.auth.inbound, {
      ...(config.tenant !== undefined
        ? { fallbackTenantId: config.tenant }
        : {}),
    });
    const requireInboundAuth =
      config.security.requireInboundAuth ||
      config.auth.inbound.requireInboundAuth;
    return await serveHttp(
      runtime,
      serverOptions,
      {
        port: config.server.port,
        host: config.server.host,
        path: config.server.path,
        verifier,
        requireAuth: requireInboundAuth,
        requireInboundAuth,
        allowUnauthenticatedHttp: config.security.allowUnauthenticatedHttp,
        authorizer: requireInboundAuth
          ? config.auth.inbound.authorizer
          : "none",
        authorizerType: requireInboundAuth
          ? config.auth.inbound.authorizer
          : "none",
        maxRequestBytes: config.server.maxRequestBytes,
        allowedHosts: config.server.allowedHosts,
        allowedOrigins: config.server.allowedOrigins,
        cors: config.server.cors,
        enableDnsRebindingProtection:
          config.server.enableDnsRebindingProtection,
        requestTimeoutMs: config.server.requestTimeoutMs,
        shutdownTimeoutMs: config.server.shutdownTimeoutMs,
        readiness: {
          deps: buildReadinessDeps(config, {
            rateLimiter: runtimeOptions.rateLimiter,
            cacheStore: runtimeOptions.cache?.store,
          }),
        },
        ...(options?.signal !== undefined ? { signal: options.signal } : {}),
      },
    );
  }

  const serverHandle = await serveStdio(
    runtime,
    serverOptions,
    {
      ...(options?.stdin !== undefined ? { stdin: options.stdin } : {}),
      ...(options?.stdout !== undefined ? { stdout: options.stdout } : {}),
      ...(options?.signal !== undefined ? { signal: options.signal } : {}),
    },
  );

  return serverHandle;
}

// Automatically start if executed as main.
// Node resolves symlinks when loading the entry module, so import.meta.url may
// point at a different (real) path than process.argv[1] — for example under
// macOS's /var -> /private/var temp directories or any symlinked checkout.
// Compare against the real path so the server is never a silent no-op.
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (entry === undefined || entry.length === 0) return false;
  const self = fileURLToPath(import.meta.url);
  if (entry === self) return true;
  try {
    return realpathSync(entry) === self;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  runServer().catch((error) => {
    console.error("Fatal server error:", error);
    process.exit(1);
  });
}
`;
}

export function renderToolsTs(options?: { blank?: boolean }): string {
  if (options?.blank) {
    return `import { defineTool } from "@chainmcp/authoring";
import { z } from "zod";

/**
 * Example code-first tool definition using @chainmcp/authoring and Zod.
 * This tool passes through the exact same authorization, validation, caching,
 * rate limiting, cancellation, and output policies as compiled OpenAPI tools.
 */
export const greetTool = defineTool({
  name: "greet",
  description: "Greets a person by name",
  schema: z.object({
    name: z.string().min(1).describe("Name of the person to greet"),
    greeting: z.string().default("Hello").describe("Greeting prefix to prepend"),
  }),
  execute: async ({ name, greeting }) => {
    return {
      message: \`\${greeting}, \${name}!\`,
    };
  },
});

export const tools = [greetTool];
`;
  }
  return `import type { ToolDefinition } from "@chainmcp/core";

/**
 * Custom application tools for ChainMcp.
 * Export custom tools in the \`tools\` array to be served alongside compiled operations.
 */
export const tools: readonly ToolDefinition[] = [];
`;
}

export function renderDockerfile(options?: {
  blank?: boolean;
  codeFirst?: boolean;
}): string {
  const isCodeFirst = options?.codeFirst || options?.blank;
  if (isCodeFirst) {
    return `# Multi-stage Docker build for ChainMcp generated server (code-first)
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci || npm install
COPY tsconfig*.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --only=production || npm install --production
COPY --from=builder /app/dist ./dist
COPY chainmcp.config.yaml ./
COPY chainmcp.manifest.json ./
COPY compiled-tools.json ./dist/compiled-tools.json
EXPOSE 3333

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3333/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

USER node
ENTRYPOINT ["node", "dist/server.js"]
`;
  }
  return `# Multi-stage Docker build for ChainMcp generated server
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci || npm install
COPY tsconfig*.json ./
COPY spec ./spec
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --only=production || npm install --production
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/spec ./spec
COPY chainmcp.config.yaml ./
COPY chainmcp.manifest.json ./
COPY compiled-tools.json ./dist/compiled-tools.json

EXPOSE 3333

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3333/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

USER node
ENTRYPOINT ["node", "dist/server.js"]
`;
}

export function renderDockerignore(): string {
  return `node_modules
dist
.git
.DS_Store
`;
}

export function renderGitignore(): string {
  return `node_modules/
dist/
*.log
.DS_Store
`;
}

export interface ReadmeOptions {
  name: string;
  toolCount: number;
  contractRevision?: string | undefined;
  blank?: boolean | undefined;
  /** When true, dependencies point at a local ChainMcp checkout. */
  localDependencies?: boolean | undefined;
}

export function renderReadme(options: ReadmeOptions): string {
  const isBlank = options.blank === true;
  return `# ${options.name}

${
  isBlank
    ? "Code-first Model Context Protocol (MCP) server authored with [ChainMcp](https://github.com/chrisindark/chain-mcp)."
    : "Portable Model Context Protocol (MCP) server generated by [ChainMcp](https://github.com/chrisindark/chain-mcp)."
}

## Overview

${
  isBlank
    ? `- **Authoring Model:** Code-first (\`@chainmcp/authoring\` + Zod)
- **Exposed Tools:** ${options.toolCount} code-defined tools in \`src/tools.ts\``
    : `- **Contract Revision:** \`${options.contractRevision ?? "unknown"}\`
- **Exposed Tools:** ${options.toolCount} compiled API operations`
}
- **Transport:** Standard I/O (\`stdio\`)
- **Shared Runtime:** Powered by \`@chainmcp/core\`, \`@chainmcp/executor\`, and \`@chainmcp/server\`

## Getting Started

### Prerequisites

- Node.js >= 20.11

### Installation

${
  options.localDependencies === true
    ? `This project links the ChainMcp packages from a local clone, so install with pnpm:

\`\`\`bash
pnpm install
\`\`\``
    : `\`\`\`bash
npm install
\`\`\``
}

### Build

Compile TypeScript source code:

\`\`\`bash
npm run build
\`\`\`

${
  isBlank
    ? ""
    : `### Build Artifacts

The project pins its contract in \`spec/openapi.yaml\` and records \`chainmcp.manifest.json\` plus \`dist/compiled-tools.json\`. At startup the server verifies the manifest schema version, generator and compiler versions, contract source hash, and per-tool hashes, and exits when they no longer match. Run \`chainmcp build\` after editing the contract; for local development, \`--allow-manifest-drift\` downgrades verification failures to warnings.

`
}### Run with an MCP Client

Start the server over stdio:

\`\`\`bash
npm start
\`\`\`

Configure your MCP client (such as Claude Desktop or Cursor) to execute this server:

\`\`\`json
{
  "mcpServers": {
    "${options.name}": {
      "command": "node",
      "args": ["<path-to-this-project>/dist/server.js"]
    }
  }
}
\`\`\`

### Docker Container

Build and run in a container:

\`\`\`bash
docker build -t ${options.name} .
docker run -i ${options.name}
\`\`\`

## Configuration

Configuration is stored in \`chainmcp.config.yaml\`. You can customize:
- Allowed upstream hosts (\`security.allowedUpstreamHosts\`)
- Request timeouts and response size limits (\`server.requestTimeoutMs\`, \`server.maxResponseBytes\`)
- Rate limiting (\`rateLimit\`)
- Structured logging level (\`logging.level\`)
- Upstream credentials (\`auth.upstream\`)

Credential fields accept \`\${VAR}\` and \`\${VAR:-default}\` environment
references instead of literal secrets. Supported fields are inbound tokens and
API keys (their record keys), \`auth.inbound.jwt.secret\`, static upstream
credentials, OAuth \`clientSecret\`, \`secretStore\` encryption keys, and Redis
URLs/TLS keys. A referenced variable that is unset and has no default stops
startup with the field and variable named.

Environment variables:
- \`CHAINMCP_CONFIG\`: Path to custom configuration file.
- \`CHAINMCP_LOG_LEVEL\`: Override log level (\`debug\`, \`info\`, \`warn\`, \`error\`, \`silent\`).
${
  isBlank
    ? ""
    : `
## Compiler Limitations

Union-typed parameters (\`anyOf\`/\`oneOf\`) cannot be represented by the
runtime validator and are skipped with a \`SCHEMA_COMPOSITION_UNSUPPORTED\`
warning; the tool is kept with its supported parameters. Other unsupported
composition (\`not\`, conditional/pattern/dependent schemas), schema-valued
\`additionalProperties\`, tuple/boolean \`items\`, \`const\`, and remote
\`$ref\`s remain errors. See the repository \`docs/limitations.md\` for the
full boundary.
`
}
## License

Apache-2.0
`;
}

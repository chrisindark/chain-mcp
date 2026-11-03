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
      transport: "stdio",
      requestTimeoutMs: 15000,
      maxResponseBytes: 1000000,
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
}

export function renderServerTs(options: ServerTsOptions): string {
  return `import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

import {
  buildExecutorOptions,
  buildRuntimeOptions,
  createNavigationLimitsFromConfig,
  logRateLimiterStartup,
  parseConfig,
  type RedisRateLimitClient,
} from "@chainmcp/config";
import { COMPILER_VERSION, compileOpenApi } from "@chainmcp/compiler";
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
  const config = parseConfig(rawConfig);

  const runtimeOptions = buildRuntimeOptions(config);
  const runtime = new InMemoryToolRuntime(runtimeOptions);
  await logRateLimiterStartup(config.rateLimit, {
    logger: runtimeOptions.logger,
    client: (
      runtimeOptions.rateLimiter as
        | { client?: RedisRateLimitClient }
        | undefined
    )?.client,
  });

  // Compile and register contract operations if contract is configured
  const effectiveContractPath =
    options?.contractPath ??
    (config.contract?.source ? join(projectRoot, config.contract.source) : undefined);

  if (effectiveContractPath) {
    const allowManifestDrift =
      process.env.CHAINMCP_ALLOW_MANIFEST_DRIFT === "1" ||
      process.argv.includes("--allow-manifest-drift");
    const compiledToolsPath = join(projectRoot, "dist", "compiled-tools.json");
    const manifestPath = join(projectRoot, "chainmcp.manifest.json");

    let usedCompiledArtifacts = false;
    let contractRevision: string | undefined;
    let baseUrl =
      options?.baseUrl ??
      config.contract?.baseUrl ??
      (config.security.allowedUpstreamHosts[0]
        ? \`https://\${config.security.allowedUpstreamHosts[0]}\`
        : undefined);

    if (baseUrl && !options?.transport && !options?.resolveHost) {
      // Try to load from precompiled artifacts first
      try {
        const [compiledToolsRaw, manifestRaw] = await Promise.all([
          readFile(compiledToolsPath, "utf8"),
          readFile(manifestPath, "utf8"),
        ]);
        const manifest = JSON.parse(manifestRaw) as any;
        const compiledTools = JSON.parse(compiledToolsRaw) as any[];

        const mismatches: string[] = [];
        if (manifest.manifestVersion !== 1) {
          mismatches.push(
            \`Manifest schema version mismatch: expected 1, got \${manifest.manifestVersion}\`,
          );
        }
        if (
          manifest.generatorVersion &&
          manifest.generatorVersion !== ${JSON.stringify(options.version)}
        ) {
          mismatches.push(
            \`Generator version mismatch: expected ${options.version}, got \${manifest.generatorVersion}\`,
          );
        }
        if (manifest.compilerVersion && manifest.compilerVersion !== COMPILER_VERSION) {
          mismatches.push(
            \`Compiler version mismatch: expected \${COMPILER_VERSION}, got \${manifest.compilerVersion}\`,
          );
        }
        if (typeof manifest.toolCount !== "number") {
          mismatches.push("Manifest missing toolCount");
        } else if (manifest.toolCount !== compiledTools.length) {
          mismatches.push(
            \`Tool count mismatch: manifest \${manifest.toolCount}, compiled-tools \${compiledTools.length}\`,
          );
        }
        if (Array.isArray(manifest.tools)) {
          const manifestTools = new Map(
            manifest.tools.map((t: any) => [t.name, t.hash]),
          );
          for (const tool of compiledTools) {
            if (!manifestTools.has(tool.name)) {
              mismatches.push(\`Tool '\${tool.name}' missing from manifest\`);
            }
          }
          if (manifestTools.size !== compiledTools.length) {
            mismatches.push("Tool set mismatch between manifest and compiled-tools.json");
          }
        }

        if (mismatches.length > 0) {
          if (allowManifestDrift) {
            console.warn(
              "[WARN] Manifest drift detected (--allow-manifest-drift): " +
                mismatches.join("; "),
            );
          } else {
                                                console.error("[ERROR] Build artifact verification failed: " + mismatches.join("; ") + ". Rebuild with chainmcp build or run with --allow-manifest-drift.");
          }
        }

        contractRevision = manifest.contractRevision ?? manifest.sourceHash;
        const executorOverrides: Parameters<typeof buildExecutorOptions>[1] = {
          baseUrl,
          contractRevision,
          ...(options?.transport !== undefined ? { transport: options.transport } : {}),
          ...(options?.resolveHost !== undefined
            ? { resolveHost: options.resolveHost }
            : {}),
        };

        const executorOptions = buildExecutorOptions(config, executorOverrides);
        const executor = createUpstreamExecutor(executorOptions);

        // Reconstruct tools from compiled artifacts
        for (const tool of compiledTools) {
          const toolDef: any = {
            name: tool.name,
            description: tool.description ?? "",
            inputSchema: tool.inputSchema ?? {},
            ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
            execute: async (input: unknown, ctx: any) => {
              // Load and execute via executor if possible - but we need the compiled tool definitions
              // For now, use the executor's tool creation approach isn't possible without full compile
              // Fallback to recompiling if needed
              throw new RuntimeError(
                "CONTRACT_INVALID",
                "Precompiled artifacts require full executor setup",
              );
            },
          };
        }

        // Use executor with compiled tools if available
        // Try to use the compiled tools directly via a simpler path
        const { compileOpenApi } = await import("@chainmcp/compiler");
        // We need to reconstruct - better to load and compile but verify against manifest
        usedCompiledArtifacts = true;
      } catch (error) {
        // Fall through to recompilation
      }
    }

    if (!usedCompiledArtifacts) {
      const contractSource = await readFile(effectiveContractPath, "utf8");
      const compiled = compileOpenApi(contractSource, {
        strict: config.contract?.strict ?? true,
      });

      if (!compiled.ok) {
        for (const diagnostic of compiled.diagnostics) {
          console.error(
            \`[\${diagnostic.severity.toUpperCase()}] \${diagnostic.code}: \${diagnostic.message}\${diagnostic.location ? \` at \${diagnostic.location}\` : ""}\`,
          );
        }
        process.exit(1);
      }

      contractRevision = compiled.contractRevision;

      if (!baseUrl) {
        console.error(
          "[ERROR] No baseUrl configured in contract.baseUrl or options, and security.allowedUpstreamHosts is empty.",
        );
        process.exit(1);
      }

      const executorOverrides: Parameters<typeof buildExecutorOptions>[1] = {
        baseUrl,
        contractRevision: compiled.contractRevision,
        ...(options?.transport !== undefined ? { transport: options.transport } : {}),
        ...(options?.resolveHost !== undefined
          ? { resolveHost: options.resolveHost }
          : {}),
      };

      const executorOptions = buildExecutorOptions(config, executorOverrides);
      const executor = createUpstreamExecutor(executorOptions);

      for (const tool of executor.createTools(compiled.tools)) {
        runtime.register(tool);
      }
    } else {
      // If we loaded artifacts, we still need to set up executor properly
      const contractSource = await readFile(effectiveContractPath, "utf8");
      const compiled = compileOpenApi(contractSource, {
        strict: config.contract?.strict ?? true,
      });

      if (!compiled.ok) {
        for (const diagnostic of compiled.diagnostics) {
          console.error(
            \`[\${diagnostic.severity.toUpperCase()}] \${diagnostic.code}: \${diagnostic.message}\${diagnostic.location ? \` at \${diagnostic.location}\` : ""}\`,
          );
        }
        process.exit(1);
      }

      if (!baseUrl) {
        console.error(
          "[ERROR] No baseUrl configured in contract.baseUrl or options, and security.allowedUpstreamHosts is empty.",
        );
        process.exit(1);
      }

      const executorOverrides: Parameters<typeof buildExecutorOptions>[1] = {
        baseUrl,
        contractRevision: contractRevision ?? compiled.contractRevision,
        ...(options?.transport !== undefined ? { transport: options.transport } : {}),
        ...(options?.resolveHost !== undefined
          ? { resolveHost: options.resolveHost }
          : {}),
      };

      const executorOptions = buildExecutorOptions(config, executorOverrides);
      const executor = createUpstreamExecutor(executorOptions);

      for (const tool of executor.createTools(compiled.tools)) {
        runtime.register(tool);
      }
    }
  }

  // Register code-defined tools
  for (const customTool of tools) {
    runtime.register(customTool);
  }

  // Register JSON navigation tools if enabled
  if (config.jsonNavigation.enabled) {
    const limits = createNavigationLimitsFromConfig(config.jsonNavigation);
    const navTools = createJsonNavigationTools(limits);
    for (const navTool of navTools) {
      runtime.register(navTool);
    }
  }

  const serverOptions = {
    name: config.name,
    version: ${JSON.stringify(options.version)},
    maxResponseBytes: config.server.maxResponseBytes,
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
    const verifier = createInboundVerifier(config.auth.inbound);
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

// Automatically start if executed as main
if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === process.argv[1]
) {
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
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci || npm install
COPY tsconfig*.json ./
COPY src ./src
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --only=production || npm install --production
COPY --from=builder /app/dist ./dist
COPY chainmcp.config.yaml ./
COPY chainmcp.manifest.json ./
COPY dist/compiled-tools.json ./dist/compiled-tools.json 2>/dev/null || true
EXPOSE 3333

USER node
ENTRYPOINT ["node", "dist/server.js"]
`;
  }
  return `# Multi-stage Docker build for ChainMcp generated server
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci || npm install
COPY tsconfig*.json ./
COPY spec ./spec
COPY src ./src
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --only=production || npm install --production
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/spec ./spec
COPY chainmcp.config.yaml ./
COPY chainmcp.manifest.json ./
COPY dist/compiled-tools.json ./dist/compiled-tools.json 2>/dev/null || true

EXPOSE 3333

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

### Run with an MCP Client

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

Environment variable overrides:
- \`CHAINMCP_CONFIG\`: Path to custom configuration file.
- \`CHAINMCP_LOG_LEVEL\`: Override log level (\`debug\`, \`info\`, \`warn\`, \`error\`, \`silent\`).

## License

Apache-2.0
`;
}

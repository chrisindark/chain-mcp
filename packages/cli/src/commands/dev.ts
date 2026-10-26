import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";

import { compileOpenApi } from "@chainmcp/compiler";
import {
  buildExecutorOptions,
  buildRuntimeOptions,
  createNavigationLimitsFromConfig,
  parseConfig,
  type ChainMcpConfig,
} from "@chainmcp/config";
import { InMemoryToolRuntime, type ToolDefinition } from "@chainmcp/core";
import { createUpstreamExecutor } from "@chainmcp/executor";
import { createJsonNavigationTools } from "@chainmcp/json-navigation";
import { serveStdio } from "@chainmcp/server";

import type { DevOptions, DevResult } from "../types.js";

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function devCommand(options: DevOptions): Promise<DevResult> {
  const cwd = options.cwd ?? process.cwd();

  // 1. Locate and parse configuration if present
  let configPath = options.config
    ? resolve(cwd, options.config)
    : process.env.CHAINMCP_CONFIG
      ? resolve(cwd, process.env.CHAINMCP_CONFIG)
      : undefined;

  if (!configPath) {
    const candidateConfigs = [
      resolve(cwd, "chainmcp.config.yaml"),
      resolve(cwd, "chainmcp.config.yml"),
      resolve(cwd, "chainmcp.config.json"),
    ];
    for (const cand of candidateConfigs) {
      if (await fileExists(cand)) {
        configPath = cand;
        break;
      }
    }
  }

  let config: ChainMcpConfig;
  if (configPath && (await fileExists(configPath))) {
    const rawText = await readFile(configPath, "utf8");
    const parsed = parseYaml(rawText);
    config = parseConfig(parsed);
  } else {
    config = parseConfig({
      version: 1,
      name: "chainmcp-dev-server",
      security: {
        allowedUpstreamHosts: ["api.example.com"],
      },
    });
  }

  const runtimeOptions = buildRuntimeOptions(config);
  const runtime = new InMemoryToolRuntime(runtimeOptions);

  // 2. Register tools provided directly (for programmatic invocation and testing)
  if (options.tools && options.tools.length > 0) {
    for (const tool of options.tools) {
      runtime.register(tool);
    }
  }

  // 3. Compile and register OpenAPI operations if contract is configured or provided
  const configDir = configPath ? dirname(configPath) : cwd;
  const specPath = options.spec
    ? resolve(cwd, options.spec)
    : config.contract?.source
      ? resolve(configDir, config.contract.source)
      : undefined;

  if (specPath && (await fileExists(specPath))) {
    const specContent = await readFile(specPath, "utf8");
    const compiled = compileOpenApi(specContent, {
      strict: config.contract?.strict ?? false,
    });
    if (compiled.ok) {
      const primaryHost =
        config.security.allowedUpstreamHosts[0] ?? "api.example.com";
      const baseUrl = options.baseUrl ?? `https://${primaryHost}`;
      const executorOptions = buildExecutorOptions(config, {
        baseUrl,
        contractRevision: compiled.contractRevision,
      });
      const executor = createUpstreamExecutor(executorOptions);
      for (const tool of executor.createTools(compiled.tools)) {
        runtime.register(tool);
      }
    }
  }

  // 4. Discover and register code-first tools if present on disk
  const candidateToolModules = [
    resolve(cwd, "dist/tools.js"),
    resolve(cwd, "src/tools.js"),
    resolve(cwd, "tools.js"),
  ];

  for (const modulePath of candidateToolModules) {
    if (await fileExists(modulePath)) {
      try {
        const imported = (await import(pathToFileURL(modulePath).href)) as {
          tools?: readonly ToolDefinition[];
          default?:
            | readonly ToolDefinition[]
            | { getTools?(): readonly ToolDefinition[] };
        };
        const toolsToRegister: readonly ToolDefinition[] = Array.isArray(
          imported.tools,
        )
          ? imported.tools
          : Array.isArray(imported.default)
            ? imported.default
            : [];
        for (const tool of toolsToRegister) {
          runtime.register(tool);
        }
        break;
      } catch (err) {
        console.warn(`Warning: Could not load tools from ${modulePath}:`, err);
      }
    }
  }

  // 5. Register JSON navigation tools if enabled
  if (config.jsonNavigation.enabled) {
    const limits = createNavigationLimitsFromConfig(config.jsonNavigation);
    const navTools = createJsonNavigationTools(limits);
    for (const navTool of navTools) {
      runtime.register(navTool);
    }
  }

  const listedTools = runtime.listTools();
  const toolNames = listedTools.map((t) => t.name);

  // 6. Serve over stdio
  const serverOptions = {
    name: config.name,
    version: "0.1.0",
    maxResponseBytes: config.server.maxResponseBytes,
    createContext: () => ({
      requestId: randomUUID(),
      tenantId: options.tenantId ?? "default",
      principal: { id: "mcp-caller", scopes: [] },
    }),
  };

  const serverHandle = await serveStdio(runtime, serverOptions, {
    ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
    ...(options.stdout !== undefined ? { stdout: options.stdout } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });

  return {
    ok: true,
    serverName: config.name,
    toolCount: listedTools.length,
    toolNames,
    close: serverHandle.close,
    closed: serverHandle.closed,
  };
}

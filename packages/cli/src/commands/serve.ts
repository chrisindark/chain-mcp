import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { compileOpenApi } from "@chainmcp/compiler";
import {
  buildExecutorOptions,
  buildRuntimeOptions,
  createNavigationLimitsFromConfig,
  parseConfig,
  type ChainMcpConfig,
} from "@chainmcp/config";
import { InMemoryToolRuntime } from "@chainmcp/core";
import { createUpstreamExecutor } from "@chainmcp/executor";
import { createJsonNavigationTools } from "@chainmcp/json-navigation";
import { serveStdio } from "@chainmcp/server";

import type { ServeOptions, ServeResult } from "../types.js";
import { validateCommand } from "./validate.js";

export async function serveCommand(
  options: ServeOptions,
): Promise<ServeResult> {
  const cwd = options.cwd ?? process.cwd();

  const validation = await validateCommand({
    config: options.config,
    spec: options.spec,
    cwd,
  });

  if (!validation.ok || !validation.specPath) {
    const errorDetails = validation.diagnostics
      .filter((d) => d.severity === "error")
      .map((d) => `[${d.code}] ${d.message}`)
      .join("; ");
    throw new Error(
      `Cannot serve: validation failed. ${errorDetails || validation.error || ""}`,
    );
  }

  // 1. Compile contract
  const specContent = await readFile(validation.specPath, "utf8");
  const compiled = compileOpenApi(specContent, {
    strict: validation.config?.contract?.strict ?? true,
  });

  if (!compiled.ok) {
    throw new Error("Cannot serve: contract compilation returned errors.");
  }

  // 2. Prepare configuration
  let config: ChainMcpConfig = validation.config!;
  if (!config) {
    config = parseConfig({
      version: 1,
      name: "chainmcp-server",
      security: {
        allowedUpstreamHosts: ["api.example.com"],
      },
    });
  }

  // 3. Executor and Runtime setup
  const primaryHost =
    config.security.allowedUpstreamHosts[0] ?? "api.example.com";
  const baseUrl = options.baseUrl ?? `https://${primaryHost}`;

  const executorOptions = buildExecutorOptions(config, {
    baseUrl,
    contractRevision: compiled.contractRevision,
  });
  const executor = createUpstreamExecutor(executorOptions);

  const runtimeOptions = buildRuntimeOptions(config);
  const runtime = new InMemoryToolRuntime(runtimeOptions);

  // Register compiled API operations
  for (const tool of executor.createTools(compiled.tools)) {
    runtime.register(tool);
  }

  // Register JSON navigation tools if enabled
  if (config.jsonNavigation.enabled) {
    const limits = createNavigationLimitsFromConfig(config.jsonNavigation);
    const navTools = createJsonNavigationTools(limits);
    for (const navTool of navTools) {
      runtime.register(navTool);
    }
  }

  const totalToolCount =
    compiled.tools.length + (config.jsonNavigation.enabled ? 4 : 0);

  // 4. Serve over stdio
  const serverHandle = await serveStdio(
    runtime,
    {
      name: config.name,
      version: "0.1.0",
      createContext: () => ({
        requestId: randomUUID(),
        tenantId: options.tenantId ?? "default",
        principal: { id: "mcp-caller", scopes: [] },
      }),
    },
    {
      ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
      ...(options.stdout !== undefined ? { stdout: options.stdout } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    },
  );

  return {
    ok: true,
    serverName: config.name,
    toolCount: totalToolCount,
    close: serverHandle.close,
    closed: serverHandle.closed,
  };
}

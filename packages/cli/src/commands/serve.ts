import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";

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
import { createInboundVerifier, serveHttp, serveStdio } from "@chainmcp/server";

import { loadCodeFirstTools } from "../code-first-loader.js";
import { loadSpec } from "../spec-loader.js";
import type { ServeOptions, ServeResult } from "../types.js";
import { validateCommand } from "./validate.js";

export async function serveCommand(
  options: ServeOptions,
): Promise<ServeResult> {
  const cwd =
    options.cwd ??
    (options.config
      ? dirname(resolve(process.cwd(), options.config))
      : process.cwd());

  const validation = await validateCommand({
    config: options.config,
    spec: options.spec,
    allowHttp: options.allowHttp,
    requireContract: options.requireContract,
    tools: options.tools,
    cwd,
  });

  if (!validation.ok) {
    const errorDetails = validation.diagnostics
      .filter((d) => d.severity === "error")
      .map((d) => `[${d.code}] ${d.message}`)
      .join("; ");
    throw new Error(
      `Cannot serve: validation failed. ${errorDetails || validation.error || ""}`,
    );
  }

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

  const runtimeOptions = buildRuntimeOptions(config);
  const runtime = new InMemoryToolRuntime(runtimeOptions);
  let totalToolCount = 0;

  if (validation.contractKind === "code-first") {
    // 1. Load code-first tools
    const loaded = await loadCodeFirstTools({
      cwd,
      injectedTools: options.tools,
    });

    if (loaded.tools.length === 0) {
      throw new Error(
        "Cannot serve code-first project: no tools found. Export a 'tools' array from src/tools.ts or src/server.ts.",
      );
    }

    for (const tool of loaded.tools) {
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

    totalToolCount =
      loaded.tools.length + (config.jsonNavigation.enabled ? 4 : 0);
  } else {
    // 1. Compile contract
    let specContent = validation.specContent;
    if (!specContent && validation.specPath) {
      const loaded = await loadSpec({
        source: validation.specPath,
        cwd,
        allowHttp:
          options.allowHttp ?? validation.config?.security?.allowInsecureHttp,
      });
      specContent = loaded.content;
    }

    if (!specContent) {
      throw new Error("Cannot serve: contract content could not be retrieved.");
    }

    const compiled = compileOpenApi(specContent, {
      strict: validation.config?.contract?.strict ?? true,
    });

    if (!compiled.ok) {
      throw new Error("Cannot serve: contract compilation returned errors.");
    }

    // 2. Executor and Runtime setup
    const baseUrl =
      options.baseUrl ??
      config.contract?.baseUrl ??
      (config.security.allowedUpstreamHosts[0]
        ? `https://${config.security.allowedUpstreamHosts[0]}`
        : undefined);

    if (!baseUrl) {
      throw new Error(
        "Cannot serve: no baseUrl configured in contract.baseUrl or options, and security.allowedUpstreamHosts is empty.",
      );
    }

    const executorOptions = buildExecutorOptions(config, {
      baseUrl,
      contractRevision: compiled.contractRevision,
    });
    const executor = createUpstreamExecutor(executorOptions);

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

    totalToolCount =
      compiled.tools.length + (config.jsonNavigation.enabled ? 4 : 0);
  }

  const transport = options.transport ?? config.server.transport ?? "stdio";

  if (transport === "http") {
    const port = options.port ?? config.server.port ?? 3333;
    const host = options.host ?? config.server.host ?? "127.0.0.1";
    const path = options.path ?? config.server.path ?? "/mcp";
    const verifier = createInboundVerifier(config.auth.inbound);
    const requireInboundAuth =
      config.security.requireInboundAuth ||
      config.auth.inbound.requireInboundAuth;
    const allowUnauthenticatedHttp =
      options.allowUnauthenticatedHttp ??
      config.security.allowUnauthenticatedHttp;

    const serverHandle = await serveHttp(
      runtime,
      {
        name: config.name,
        version: "0.1.0",
        maxResponseBytes: config.server.maxResponseBytes,
        createContext: (request) => {
          const auth = request.authInfo;
          return {
            requestId: randomUUID(),
            tenantId:
              (auth?.extra?.tenantId as string) ??
              options.tenantId ??
              "default",
            principal: {
              id: auth?.clientId ?? "mcp-caller",
              scopes: auth?.scopes ?? [],
            },
          };
        },
      },
      {
        port,
        host,
        path,
        verifier,
        requireAuth: requireInboundAuth,
        requireInboundAuth,
        allowUnauthenticatedHttp,
        authorizer: requireInboundAuth
          ? config.auth.inbound.authorizer
          : "none",
        authorizerType: requireInboundAuth
          ? config.auth.inbound.authorizer
          : "none",
        toolCount: totalToolCount,
        maxRequestBytes: config.server.maxRequestBytes,
        allowedHosts: config.server.allowedHosts,
        allowedOrigins: config.server.allowedOrigins,
        cors: config.server.cors,
        enableDnsRebindingProtection:
          config.server.enableDnsRebindingProtection,
        requestTimeoutMs: config.server.requestTimeoutMs,
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      },
    );

    return {
      ok: true,
      serverName: config.name,
      toolCount: totalToolCount,
      url: serverHandle.url,
      close: serverHandle.close,
      closed: serverHandle.closed,
    };
  }

  // 4. Serve over stdio
  const serverHandle = await serveStdio(
    runtime,
    {
      name: config.name,
      version: "0.1.0",
      maxResponseBytes: config.server.maxResponseBytes,
      createContext: (request) => {
        const auth = request.authInfo;
        return {
          requestId: randomUUID(),
          tenantId:
            (auth?.extra?.tenantId as string) ?? options.tenantId ?? "default",
          principal: {
            id: auth?.clientId ?? "mcp-caller",
            scopes: auth?.scopes ?? [],
          },
        };
      },
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

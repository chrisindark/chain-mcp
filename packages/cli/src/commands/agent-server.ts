import { randomBytes, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";

import {
  createMetaMcpTools,
  DeclarativeAdmin,
  MIN_DECLARATIVE_ADMIN_TOKEN_LENGTH,
  StorageDescriptorRevisionStore,
  type DeclarativeAdminContractBinding,
} from "@chainmcp/admin";
import {
  createStorageDriverFromConfig,
  parseGatewayConfig,
  resolveConfigSecrets,
  type StorageConfig,
} from "@chainmcp/config";
import { createFieldProjector, InMemoryToolRuntime } from "@chainmcp/core";
import { DynamicGateway } from "@chainmcp/gateway";
import { serveHttp, serveStdio } from "@chainmcp/server";
import { MemoryStorageDriver, type StorageDriver } from "@chainmcp/storage";

import { findConfigPath, loadServerConfigFile } from "../config-loader.js";
import type { AgentServerOptions, AgentServerResult } from "../types.js";
import { getCliVersion } from "../version.js";
import { syncConfigToolCuration } from "./studio.js";

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs an agent-callable Meta-MCP server exposing tools for inspecting, testing,
 * compiling, curating, and optimizing ChainMcp contracts.
 */
export async function agentServerCommand(
  options: AgentServerOptions = {},
): Promise<AgentServerResult> {
  const cwd = options.cwd ?? process.cwd();

  try {
    // 1. Resolve configuration file if present
    let configPath: string | undefined;
    if (options.config !== undefined) {
      const resolved = resolve(cwd, options.config);
      if (!(await fileExists(resolved))) {
        return {
          ok: false,
          serverName: "chainmcp-agent-server",
          toolCount: 0,
          close: async () => {},
          closed: Promise.resolve(),
          error: `Configuration file not found: ${resolved}`,
        };
      }
      configPath = resolved;
    } else {
      // Search conventional gateway & server config candidates
      const gatewayCandidates = [
        "gateway.config.yaml",
        "gateway.config.yml",
        "gateway.config.json",
      ];
      for (const candidate of gatewayCandidates) {
        const candidatePath = resolve(cwd, candidate);
        if (await fileExists(candidatePath)) {
          configPath = candidatePath;
          break;
        }
      }

      if (!configPath) {
        configPath = await findConfigPath({ cwd });
      }
    }

    let storageConfig: StorageConfig | undefined;
    let parsedConfig: unknown | undefined;
    const bindings: DeclarativeAdminContractBinding[] = [];

    if (configPath && (await fileExists(configPath))) {
      try {
        const rawText = await readFile(configPath, "utf8");
        const parsed = parseYaml(rawText);
        parsedConfig = parsed;
        const isGateway =
          typeof parsed === "object" &&
          parsed !== null &&
          ("contracts" in parsed ||
            configPath.includes("gateway.config") ||
            configPath.includes("chainmcp.gateway"));

        if (isGateway) {
          const resolved = resolveConfigSecrets(parsed);
          const gatewayConfig = parseGatewayConfig(resolved.config);
          storageConfig = gatewayConfig.storage;
          if (Array.isArray(gatewayConfig.contracts)) {
            for (const contract of gatewayConfig.contracts) {
              if (contract.destination) {
                bindings.push({
                  tenantId: contract.tenantId,
                  contractName: contract.name,
                  destinationPolicy: {
                    baseUrl: contract.destination.baseUrl,
                    allowedHosts: [...contract.destination.allowedHosts],
                    ...(contract.destination.allowInsecureHttp !== undefined
                      ? {
                          allowInsecureHttp:
                            contract.destination.allowInsecureHttp,
                        }
                      : {}),
                  },
                  ...(contract.limits !== undefined
                    ? { limits: contract.limits }
                    : {}),
                });
              }
            }
          }
        } else {
          const serverConfig = await loadServerConfigFile(configPath);
          storageConfig = serverConfig.config.storage;
          if (serverConfig.config.contract?.baseUrl) {
            bindings.push({
              tenantId: serverConfig.config.tenant ?? "default",
              contractName: serverConfig.config.name,
              destinationPolicy: {
                baseUrl: serverConfig.config.contract.baseUrl,
                allowedHosts: [
                  ...serverConfig.config.security.allowedUpstreamHosts,
                ],
                allowInsecureHttp:
                  serverConfig.config.security.allowInsecureHttp ?? false,
              },
            });
          }
        }
      } catch (error) {
        throw new Error(
          `Failed to load configuration from ${configPath}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    // 2. Token validation or generation
    const explicitToken = options.token ?? process.env.CHAINMCP_ADMIN_TOKEN;
    let token: string;
    if (explicitToken !== undefined && explicitToken.length > 0) {
      if (explicitToken.length < MIN_DECLARATIVE_ADMIN_TOKEN_LENGTH) {
        throw new Error(
          `Admin token must be at least ${MIN_DECLARATIVE_ADMIN_TOKEN_LENGTH} characters`,
        );
      }
      token = explicitToken;
    } else {
      token = randomBytes(16).toString("hex");
    }

    // 3. Storage initialization
    let storageDriver: StorageDriver;
    if (storageConfig && storageConfig.enabled) {
      const configuredDriver = createStorageDriverFromConfig(storageConfig);
      storageDriver = configuredDriver ?? new MemoryStorageDriver();
    } else {
      storageDriver = new MemoryStorageDriver();
    }

    await storageDriver.init();

    let repository: StorageDescriptorRevisionStore;
    try {
      repository = await StorageDescriptorRevisionStore.open(storageDriver);
    } catch (error) {
      await storageDriver.close();
      throw new Error(
        `Failed to open descriptor store: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    // 4. Dynamic Gateway and DeclarativeAdmin initialization
    const gateway = new DynamicGateway({
      projector: createFieldProjector(),
    });

    const admin = new DeclarativeAdmin({
      gateway,
      tokens: [
        {
          id: "agent-caller",
          token,
          tenants: options.tenant ? [options.tenant] : "*",
        },
      ],
      contracts: bindings,
      repository,
      storageDriver,
      ...(configPath !== undefined ? { configPath } : {}),
      ...(parsedConfig !== undefined ? { configObject: parsedConfig } : {}),
      ...(configPath !== undefined
        ? {
            onConfigSync: async (update: {
              tenantId: string;
              contractName: string;
              toolName: string;
              enabled: boolean;
            }) => {
              await syncConfigToolCuration(configPath!, update);
            },
          }
        : {}),
    });

    try {
      await admin.restore();
    } catch {
      // Non-fatal if initial store is empty
    }

    // 5. Build Meta-MCP tools
    const metaTools = createMetaMcpTools(admin, {
      tokenId: "agent-server",
      tenants: options.tenant ? [options.tenant] : "*",
      requireApproval: options.requireApproval ?? true,
    });

    const runtimeTenant = options.tenant ?? "default";
    const runtime = new InMemoryToolRuntime({
      tenantMode: "single-tenant",
      tenantId: runtimeTenant,
    });

    for (const tool of metaTools) {
      runtime.register(tool);
    }

    const cliVersion = await getCliVersion();
    const serverName = "chainmcp-agent-server";

    // 6. Transport serving
    if (options.transport === "http") {
      const port = options.port ?? 3333;
      const host = options.host ?? "127.0.0.1";

      const serverHandle = await serveHttp(
        runtime,
        {
          name: serverName,
          version: cliVersion,
          createContext: () => ({
            requestId: randomUUID(),
            tenantId: runtimeTenant,
            principal: { id: "agent-caller", scopes: [] },
          }),
        },
        {
          port,
          host,
          allowUnauthenticatedHttp: true,
          toolCount: metaTools.length,
          ...(options.signal !== undefined ? { signal: options.signal } : {}),
        },
      );

      return {
        ok: true,
        serverName,
        toolCount: metaTools.length,
        url: serverHandle.url,
        close: async () => {
          await serverHandle.close();
          await storageDriver.close();
        },
        closed: serverHandle.closed,
      };
    }

    // Default: stdio transport
    const serverHandle = await serveStdio(
      runtime,
      {
        name: serverName,
        version: cliVersion,
        createContext: () => ({
          requestId: randomUUID(),
          tenantId: runtimeTenant,
          principal: { id: "agent-caller", scopes: [] },
        }),
      },
      {
        ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
        ...(options.stdout !== undefined ? { stdout: options.stdout } : {}),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
        handleProcessSignals: true,
      },
    );

    return {
      ok: true,
      serverName,
      toolCount: metaTools.length,
      close: async () => {
        await serverHandle.close();
        await storageDriver.close();
      },
      closed: serverHandle.closed,
    };
  } catch (error) {
    return {
      ok: false,
      serverName: "chainmcp-agent-server",
      toolCount: 0,
      close: async () => {},
      closed: Promise.resolve(),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

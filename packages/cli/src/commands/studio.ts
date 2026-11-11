import { randomBytes } from "node:crypto";
import { readFile, rename, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import {
  DeclarativeAdmin,
  DEFAULT_STUDIO_PORT,
  MIN_DECLARATIVE_ADMIN_TOKEN_LENGTH,
  startDeclarativeAdminServer,
  StorageDescriptorRevisionStore,
  type DeclarativeAdminContractBinding,
} from "@chainmcp/admin";
import {
  createStorageDriverFromConfig,
  parseGatewayConfig,
  resolveConfigSecrets,
  type StorageConfig,
} from "@chainmcp/config";
import { DynamicGateway } from "@chainmcp/gateway";
import { MemoryStorageDriver, type StorageDriver } from "@chainmcp/storage";

import { findConfigPath, loadServerConfigFile } from "../config-loader.js";

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export interface StudioCommandOptions {
  readonly host?: string | undefined;
  readonly port?: number | undefined;
  readonly config?: string | undefined;
  readonly tenant?: string | undefined;
  readonly token?: string | undefined;
  readonly allowRemote?: boolean | undefined;
  readonly json?: boolean | undefined;
  readonly cwd?: string | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface StudioCommandResult {
  readonly ok: boolean;
  readonly url?: string | undefined;
  readonly host?: string | undefined;
  readonly port?: number | undefined;
  readonly storeKind?: string | undefined;
  readonly storageDriver?: string | undefined;
  readonly storagePath?: string | undefined;
  readonly contractCount?: number | undefined;
  readonly token?: string | undefined;
  readonly error?: string | undefined;
  readonly close?: (() => Promise<void>) | undefined;
  readonly closed?: Promise<void> | undefined;
}

export async function studioCommand(
  options: StudioCommandOptions = {},
): Promise<StudioCommandResult> {
  const cwd = options.cwd ?? process.cwd();

  // 1. Resolve configuration file if present
  let configPath: string | undefined;
  if (options.config !== undefined) {
    const resolved = resolve(cwd, options.config);
    if (!(await fileExists(resolved))) {
      return {
        ok: false,
        error: `Configuration file not found: ${resolved}`,
      };
    }
    configPath = resolved;
  } else {
    // Search conventional candidates
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
  const bindings: DeclarativeAdminContractBinding[] = [];

  if (configPath && (await fileExists(configPath))) {
    try {
      const rawText = await readFile(configPath, "utf8");
      const parsed = parseYaml(rawText);
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
                },
              });
            }
          }
        }
      } else {
        const serverConfig = await loadServerConfigFile(configPath);
        storageConfig = serverConfig.config.storage;
      }
    } catch (error) {
      return {
        ok: false,
        error: `Failed to load configuration from ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  // 2. Token validation or generation
  const explicitToken = options.token ?? process.env.CHAINMCP_ADMIN_TOKEN;
  let token: string;
  if (explicitToken !== undefined && explicitToken.length > 0) {
    if (explicitToken.length < MIN_DECLARATIVE_ADMIN_TOKEN_LENGTH) {
      return {
        ok: false,
        error: `Admin bearer token must be at least ${MIN_DECLARATIVE_ADMIN_TOKEN_LENGTH} characters`,
      };
    }
    token = explicitToken;
  } else {
    // Generate a secure random token for ephemeral loopback session
    token = randomBytes(16).toString("hex");
  }

  // 3. Storage initialization
  let storageDriver: StorageDriver;
  let storagePath: string | undefined;

  if (storageConfig && storageConfig.enabled) {
    const configuredDriver = createStorageDriverFromConfig(storageConfig);
    if (configuredDriver) {
      storageDriver = configuredDriver;
      storagePath = storageConfig.path;
    } else {
      storageDriver = new MemoryStorageDriver();
    }
  } else {
    storageDriver = new MemoryStorageDriver();
  }

  try {
    await storageDriver.init();
  } catch (error) {
    return {
      ok: false,
      error: `Failed to initialize storage driver: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  // 4. Descriptor store
  let repository: StorageDescriptorRevisionStore;
  try {
    repository = await StorageDescriptorRevisionStore.open(storageDriver);
  } catch (error) {
    await storageDriver.close();
    return {
      ok: false,
      error: `Failed to open descriptor store: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  // 5. Gateway and Admin surface
  const gateway = new DynamicGateway({});
  const admin = new DeclarativeAdmin({
    gateway,
    tokens: [
      {
        id: "studio-operator",
        token,
        tenants: options.tenant ? [options.tenant] : "*",
      },
    ],
    contracts: bindings,
    repository,
    storageDriver,
    ...(configPath !== undefined ? { configPath } : {}),
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
    // Non-fatal if restore fails on initial startup with empty store
  }

  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? DEFAULT_STUDIO_PORT;

  let closedResolve: () => void;
  const closedPromise = new Promise<void>((resolve) => {
    closedResolve = resolve;
  });

  try {
    const server = await startDeclarativeAdminServer({
      admin,
      host,
      port,
      ...(options.allowRemote !== undefined
        ? { allowRemote: options.allowRemote }
        : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });

    let closed = false;
    const close = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      try {
        await server.close();
      } finally {
        await storageDriver.close();
        closedResolve();
      }
    };

    return {
      ok: true,
      url: server.url,
      host: server.host,
      port: server.port,
      storeKind: repository.kind,
      storageDriver: storageDriver.id,
      storagePath,
      contractCount: bindings.length,
      token,
      close,
      closed: closedPromise,
    };
  } catch (error) {
    await storageDriver.close();
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function syncConfigToolCuration(
  configPath: string,
  update: {
    tenantId: string;
    contractName: string;
    toolName: string;
    enabled: boolean;
  },
): Promise<void> {
  let content: string;
  try {
    content = await readFile(configPath, "utf8");
  } catch {
    return;
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch {
    return;
  }

  if (typeof parsed !== "object" || parsed === null) {
    return;
  }

  const { contractName, toolName, enabled } = update;
  const obj = parsed as Record<string, unknown>;

  if (Array.isArray(obj.contracts)) {
    const targetContract = obj.contracts.find(
      (c) =>
        c &&
        typeof c === "object" &&
        (c as Record<string, unknown>).name === contractName,
    );
    if (targetContract && typeof targetContract === "object") {
      updateContractToolsFilter(
        targetContract as Record<string, unknown>,
        toolName,
        enabled,
      );
    }
  } else if (
    "contracts" in obj &&
    typeof obj.contracts === "object" &&
    obj.contracts !== null
  ) {
    const contracts = obj.contracts as Record<string, unknown>;
    let targetContract = contracts[contractName];
    if (!targetContract) {
      for (const val of Object.values(contracts)) {
        if (
          val &&
          typeof val === "object" &&
          (val as Record<string, unknown>).name === contractName
        ) {
          targetContract = val;
          break;
        }
      }
    }
    if (targetContract && typeof targetContract === "object") {
      updateContractToolsFilter(
        targetContract as Record<string, unknown>,
        toolName,
        enabled,
      );
    }
  } else if (
    "contract" in obj &&
    typeof obj.contract === "object" &&
    obj.contract !== null
  ) {
    updateContractToolsFilter(
      obj.contract as Record<string, unknown>,
      toolName,
      enabled,
    );
  } else {
    return;
  }

  const isJson = configPath.endsWith(".json");
  const newContent = isJson
    ? JSON.stringify(parsed, null, 2) + "\n"
    : stringifyYaml(parsed);
  const tmpPath = `${configPath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  await writeFile(tmpPath, newContent, "utf8");
  await rename(tmpPath, configPath);
}

function updateContractToolsFilter(
  contract: Record<string, unknown>,
  toolName: string,
  enabled: boolean,
): void {
  if (
    !("tools" in contract) ||
    typeof contract.tools !== "object" ||
    contract.tools === null
  ) {
    contract.tools = {};
  }
  const tools = contract.tools as Record<string, unknown>;
  const exclude: string[] = Array.isArray(tools.exclude)
    ? [...(tools.exclude as string[])]
    : [];
  const include: string[] | undefined = Array.isArray(tools.include)
    ? [...(tools.include as string[])]
    : undefined;

  if (enabled) {
    const filteredExclude = exclude.filter((n) => n !== toolName);
    if (filteredExclude.length > 0) {
      tools.exclude = filteredExclude;
    } else {
      delete tools.exclude;
    }
    if (include && !include.includes(toolName)) {
      include.push(toolName);
      tools.include = include;
    }
  } else {
    if (!exclude.includes(toolName)) {
      exclude.push(toolName);
    }
    tools.exclude = exclude;
    if (include) {
      tools.include = include.filter((n) => n !== toolName);
    }
  }

  if (
    tools.exclude === undefined &&
    tools.include === undefined &&
    Object.keys(tools).length === 0
  ) {
    delete contract.tools;
  }
}

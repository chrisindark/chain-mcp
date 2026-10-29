import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";

import {
  OpenTelemetryMetricsSink,
  RollingAnalyticsAggregator,
  ToolTracer,
} from "@chainmcp/analytics";
import { OperationScopeAuthorizer } from "@chainmcp/auth";
import {
  createAuthorizerFromConfig,
  createCacheStoreFromConfig,
  createLoggerFromConfig,
  createRateLimiterFromConfig,
  createTokenizerFromConfig,
  parseGatewayConfig,
  type GatewayConfig,
} from "@chainmcp/config";
import {
  createFieldProjector,
  type MetricsSink,
  type RuntimeCacheOptions,
  RuntimeError,
} from "@chainmcp/core";
import { DynamicGateway } from "@chainmcp/gateway";
import { createInboundVerifier, serveHttp, serveStdio } from "@chainmcp/server";

import type { GatewayServeOptions, GatewayServeResult } from "../types.js";

const DEFAULT_CONFIG_CANDIDATES = [
  "gateway.config.yaml",
  "gateway.config.yml",
  "gateway.config.json",
  "chainmcp.gateway.yaml",
  "chainmcp.gateway.yml",
];

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function resolveGatewayConfigFile(
  explicitPath: string | undefined,
  cwd: string,
): Promise<string> {
  if (explicitPath) {
    const resolved = path.resolve(cwd, explicitPath);
    if (!(await pathExists(resolved))) {
      throw new Error(`Gateway config file not found: ${resolved}`);
    }
    return resolved;
  }

  const envPath = process.env.CHAINMCP_GATEWAY_CONFIG;
  if (envPath) {
    const resolved = path.resolve(cwd, envPath);
    if (await pathExists(resolved)) {
      return resolved;
    }
  }

  for (const candidate of DEFAULT_CONFIG_CANDIDATES) {
    const resolved = path.resolve(cwd, candidate);
    if (await pathExists(resolved)) {
      return resolved;
    }
  }

  throw new Error(
    `No gateway configuration found in ${cwd}. Expected one of: ${DEFAULT_CONFIG_CANDIDATES.join(", ")} or --config <path>.`,
  );
}

export async function loadGatewayConfig(
  configPath: string,
): Promise<{ config: GatewayConfig; dir: string }> {
  const content = await readFile(configPath, "utf8");
  const parsed = parseYaml(content);
  const config = parseGatewayConfig(parsed);
  return { config, dir: path.dirname(configPath) };
}

export async function gatewayServeCommand(
  options: GatewayServeOptions,
): Promise<GatewayServeResult> {
  const cwd = options.cwd ?? process.cwd();
  const configPath = await resolveGatewayConfigFile(options.config, cwd);
  const { config, dir: configDir } = await loadGatewayConfig(configPath);

  // 1. Inbound authorizer
  const authorizer =
    createAuthorizerFromConfig(config.auth.inbound) ??
    new OperationScopeAuthorizer();

  // 2. Rate limiter
  const rateLimiter = createRateLimiterFromConfig(config.rateLimit);

  // 3. Cache
  let cache: RuntimeCacheOptions | undefined;
  if (config.cache.enabled) {
    const store = createCacheStoreFromConfig(config.cache);
    if (store) {
      cache = {
        store,
        authorizationPartition(context) {
          return context.principal.scopes.length > 0
            ? [...context.principal.scopes].sort().join(",")
            : "public";
        },
      };
    }
  }

  // 4. Tokenizer & Projector
  const tokenizer = config.tokenMetrics.enabled
    ? createTokenizerFromConfig(config.tokenMetrics)
    : undefined;
  const projector = config.projection.enabled
    ? createFieldProjector()
    : undefined;

  // 5. Logger
  const logger =
    config.logging.level !== "silent"
      ? createLoggerFromConfig(config.logging)
      : undefined;

  // 6. Metrics & Tracing
  let metrics: MetricsSink | undefined;
  if (config.analytics.enabled) {
    if (config.analytics.openTelemetry.enabled) {
      metrics = new OpenTelemetryMetricsSink({
        meterName: config.analytics.openTelemetry.serviceName,
      });
    } else {
      metrics = new RollingAnalyticsAggregator({
        retentionMs: config.analytics.retentionDays * 86_400_000,
      });
    }
  }

  let tracer: ToolTracer | undefined;
  if (
    config.analytics.enabled &&
    config.analytics.openTelemetry.enabled &&
    config.analytics.openTelemetry.tracing.enabled
  ) {
    tracer = new ToolTracer({
      tracerName: config.analytics.openTelemetry.serviceName,
      sampleRatio: config.analytics.openTelemetry.tracing.sampleRatio,
      ...(config.analytics.openTelemetry.endpoint !== undefined
        ? { endpoint: config.analytics.openTelemetry.endpoint }
        : {}),
    });
  }

  // 7. Dynamic Gateway instantiation
  const gateway = new DynamicGateway({
    authorizer,
    ...(rateLimiter !== undefined ? { rateLimiter } : {}),
    ...(cache !== undefined ? { cache } : {}),
    ...(tokenizer !== undefined ? { tokenizer } : {}),
    ...(projector !== undefined ? { projector } : {}),
    ...(logger !== undefined ? { logger } : {}),
    ...(metrics !== undefined ? { metrics } : {}),
    ...(tracer !== undefined ? { tracer } : {}),
    defaultTimeoutMs: config.server.requestTimeoutMs,
  });

  // 8. Publish and compile each configured contract
  let totalToolCount = 0;
  for (const contract of config.contracts) {
    const specPath = path.resolve(configDir, contract.spec);
    if (!(await pathExists(specPath))) {
      throw new Error(
        `OpenAPI specification file not found for contract '${contract.name}': ${specPath}`,
      );
    }
    const specContent = await readFile(specPath, "utf8");
    const revision = await gateway.publishContract({
      tenantId: contract.tenantId,
      contractName: contract.name,
      source: specContent,
      destinationPolicy: contract.destination,
      ...(contract.auth !== undefined ? { authConfig: contract.auth } : {}),
      ...(contract.limits !== undefined ? { limits: contract.limits } : {}),
      ...(contract.metadata !== undefined
        ? { metadata: contract.metadata }
        : {}),
      autoActivate: contract.autoActivate,
    });
    totalToolCount += revision.tools.length;
  }

  const verifier = createInboundVerifier(config.auth.inbound);
  const explicitTenant = options.tenantId ?? config.tenant;

  if (!verifier && !explicitTenant) {
    throw new Error(
      "Dynamic gateway requires a tenant resolver: configure inbound authentication (auth.inbound) or specify an explicit tenant via --tenant <id> (or config tenant).",
    );
  }

  const transport = options.transport ?? config.server.transport ?? "stdio";

  const createContext = (request: { authInfo?: unknown }) => {
    const auth = request.authInfo as
      | {
          clientId?: string;
          scopes?: string[];
          extra?: Record<string, unknown>;
        }
      | undefined;
    const authTenant =
      typeof auth?.extra?.tenantId === "string" &&
      auth.extra.tenantId.trim().length > 0
        ? auth.extra.tenantId
        : undefined;
    const tenantId = authTenant ?? explicitTenant;
    const requestId = randomUUID();
    const principalId = auth?.clientId ?? "mcp-caller";
    const scopes = auth?.scopes ?? [];

    if (!tenantId) {
      void gateway.emitAudit({
        type: "tenant_resolution_failed",
        timestamp: Date.now(),
        tenantId: "",
        contractName: "",
        revisionId: "",
        toolCount: 0,
        details: {
          principalId,
          requestId,
          reason:
            "No tenantId in authenticated credentials and no explicit tenant configured",
        },
      });
      throw new RuntimeError(
        "TENANT_REQUIRED",
        "Tenant context required: no tenant identified from authentication or configuration",
      );
    }

    return {
      requestId,
      tenantId,
      principal: {
        id: principalId,
        scopes,
      },
    };
  };

  // 9. Serve over HTTP or Stdio
  if (transport === "http") {
    const port = options.port ?? config.server.port ?? 3333;
    const host = options.host ?? config.server.host ?? "127.0.0.1";
    const mcpPath = options.path ?? config.server.path ?? "/mcp";
    const requireInboundAuth =
      config.security.requireInboundAuth ||
      config.auth.inbound.requireInboundAuth;
    const allowUnauthenticatedHttp =
      options.allowUnauthenticatedHttp ??
      config.security.allowUnauthenticatedHttp;

    const serverHandle = await serveHttp(
      gateway,
      {
        name: config.name,
        version: "0.1.0",
        maxResponseBytes: config.server.maxResponseBytes,
        createContext,
      },
      {
        port,
        host,
        path: mcpPath,
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
      contractCount: config.contracts.length,
      totalToolCount,
      url: serverHandle.url,
      close: serverHandle.close,
      closed: serverHandle.closed,
    };
  }

  const serverHandle = await serveStdio(
    gateway,
    {
      name: config.name,
      version: "0.1.0",
      maxResponseBytes: config.server.maxResponseBytes,
      createContext,
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
    contractCount: config.contracts.length,
    totalToolCount,
    close: serverHandle.close,
    closed: serverHandle.closed,
  };
}

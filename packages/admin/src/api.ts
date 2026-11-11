import { randomBytes } from "node:crypto";
import { redactValue } from "@chainmcp/analytics";
import {
  assertFieldSelection,
  createFieldProjector,
  type FieldSelection,
  type Tokenizer,
  type ToolContext,
  type ToolDefinition,
} from "@chainmcp/core";
import type { StorageDriver, TelemetryEvent } from "@chainmcp/storage";
import {
  DeclarativeDescriptorError,
  DeclarativeToolSource,
  MAX_DECLARATIVE_DESCRIPTORS,
  type DeclarativeDescriptorIssue,
  type DeclarativeToolDescriptor,
  type ParsedDeclarativeTool,
} from "@chainmcp/declarative";
import { createUpstreamExecutor } from "@chainmcp/executor";
import {
  type ContractRevision,
  type DynamicGateway,
  GatewayError,
} from "@chainmcp/gateway";

import {
  assertTenantAllowed,
  authenticateAdminToken,
  validateAdminTokens,
  type DeclarativeAdminPrincipal,
} from "./auth.js";
import { evaluateDescriptorSet } from "./evaluate.js";
import {
  InMemoryDescriptorRevisionStore,
  createDescriptorRevisionId,
  descriptorToolsetHash,
  toStoredRevisionSummary,
} from "./store.js";
import {
  DeclarativeAdminError,
  DescriptorStoreError,
  MAX_DECLARATIVE_ADMIN_REQUEST_BYTES,
  type DeclarativeAdminAuditEvent,
  type DeclarativeAdminAuditEventType,
  type DeclarativeAdminContractBinding,
  type DeclarativeAdminOptions,
  type DeclarativeAdminPublishedRevision,
  type DeclarativeAdminRestoreResult,
  type DeclarativeAdminToolSummary,
  type DescriptorRevisionStore,
  type StoredDescriptorRevision,
  type TelemetryEventResponse,
  type TelemetryMetricsResponse,
  type TelemetryMetricsSummary,
  type TelemetryToolMetrics,
} from "./types.js";
import { ADMIN_APP_CSS, ADMIN_APP_JS, ADMIN_INDEX_HTML } from "./ui.js";

const CONTRACT_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_BODY_LIMIT = 10 * 1_048_576;
const MIN_BODY_LIMIT = 1_024;

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

const UI_HEADERS: Readonly<Record<string, string>> = {
  ...SECURITY_HEADERS,
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

function extractTraceCorrelation(metadata?: Record<string, unknown>): {
  readonly traceId?: string;
  readonly spanId?: string;
} {
  if (!metadata || typeof metadata !== "object") return {};
  let traceId =
    typeof metadata.traceId === "string" ? metadata.traceId : undefined;
  let spanId =
    typeof metadata.spanId === "string" ? metadata.spanId : undefined;

  if ((!traceId || !spanId) && typeof metadata.traceparent === "string") {
    const parts = metadata.traceparent.split("-");
    if (parts.length >= 4) {
      if (!traceId && parts[1]?.length === 32) traceId = parts[1];
      if (!spanId && parts[2]?.length === 16) spanId = parts[2];
    }
  }

  return {
    ...(traceId ? { traceId } : {}),
    ...(spanId ? { spanId } : {}),
  };
}

function formatTelemetryEvent(event: TelemetryEvent): TelemetryEventResponse {
  const correlation = extractTraceCorrelation(event.metadata);
  const redactedMetadata = event.metadata
    ? (redactValue(event.metadata) as Record<string, unknown>)
    : undefined;

  return {
    id: event.id,
    timestamp: event.timestamp,
    ...(event.tenantId !== undefined ? { tenantId: event.tenantId } : {}),
    ...(event.toolName !== undefined ? { toolName: event.toolName } : {}),
    ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
    ...(event.isError !== undefined ? { isError: event.isError } : {}),
    ...(event.errorCode !== undefined ? { errorCode: event.errorCode } : {}),
    ...(event.cached !== undefined ? { cached: event.cached } : {}),
    ...(event.tokenCount !== undefined ? { tokenCount: event.tokenCount } : {}),
    ...correlation,
    ...(redactedMetadata !== undefined ? { metadata: redactedMetadata } : {}),
  };
}

export function computeTelemetryMetrics(
  events: readonly TelemetryEvent[],
  since: number,
  until: number,
): TelemetryMetricsResponse {
  const totalRequests = events.length;
  let totalErrors = 0;
  let totalCached = 0;
  let totalTokens = 0;
  const durations: number[] = [];

  const toolStats = new Map<
    string,
    {
      requests: number;
      errors: number;
      cached: number;
      tokens: number;
      durations: number[];
    }
  >();

  for (const event of events) {
    if (event.isError) totalErrors++;
    if (event.cached) totalCached++;
    if (typeof event.tokenCount === "number" && event.tokenCount > 0) {
      totalTokens += event.tokenCount;
    }
    if (typeof event.durationMs === "number" && event.durationMs >= 0) {
      durations.push(event.durationMs);
    }

    const tool = event.toolName || "unknown";
    let stats = toolStats.get(tool);
    if (!stats) {
      stats = {
        requests: 0,
        errors: 0,
        cached: 0,
        tokens: 0,
        durations: [],
      };
      toolStats.set(tool, stats);
    }
    stats.requests++;
    if (event.isError) stats.errors++;
    if (event.cached) stats.cached++;
    if (typeof event.tokenCount === "number") stats.tokens += event.tokenCount;
    if (typeof event.durationMs === "number")
      stats.durations.push(event.durationMs);
  }

  durations.sort((a, b) => a - b);
  const percentile = (p: number): number => {
    if (durations.length === 0) return 0;
    const index = Math.ceil((p / 100) * durations.length) - 1;
    return durations[Math.max(0, Math.min(index, durations.length - 1))] ?? 0;
  };

  const avgDurationMs =
    durations.length > 0
      ? Math.round(
          (durations.reduce((acc, v) => acc + v, 0) / durations.length) * 10,
        ) / 10
      : 0;

  const errorRate =
    totalRequests > 0
      ? Math.round((totalErrors / totalRequests) * 1000) / 1000
      : 0;
  const cacheHitRatio =
    totalRequests > 0
      ? Math.round((totalCached / totalRequests) * 1000) / 1000
      : 0;
  const avgTokensPerRequest =
    totalRequests > 0 ? Math.round(totalTokens / totalRequests) : 0;

  const summary: TelemetryMetricsSummary = {
    totalRequests,
    totalErrors,
    errorRate,
    totalCached,
    cacheHitRatio,
    totalTokens,
    avgTokensPerRequest,
    p50DurationMs: percentile(50),
    p95DurationMs: percentile(95),
    p99DurationMs: percentile(99),
    avgDurationMs,
  };

  const byTool: TelemetryToolMetrics[] = [...toolStats.entries()]
    .map(([toolName, stats]) => {
      const avg =
        stats.durations.length > 0
          ? Math.round(
              (stats.durations.reduce((a, b) => a + b, 0) /
                stats.durations.length) *
                10,
            ) / 10
          : 0;
      return {
        toolName,
        requests: stats.requests,
        errors: stats.errors,
        cached: stats.cached,
        tokens: stats.tokens,
        avgDurationMs: avg,
      };
    })
    .sort((a, b) => b.requests - a.requests);

  interface MutableBucket {
    bucketStart: number;
    bucketEnd: number;
    requests: number;
    errors: number;
    cached: number;
    tokens: number;
  }
  const bucketCount = 12;
  const windowDuration = Math.max(1, until - since);
  const bucketSize = Math.max(1, Math.ceil(windowDuration / bucketCount));
  const buckets: MutableBucket[] = [];

  for (let i = 0; i < bucketCount; i++) {
    const bStart = since + i * bucketSize;
    const bEnd = Math.min(until, bStart + bucketSize);
    buckets.push({
      bucketStart: bStart,
      bucketEnd: bEnd,
      requests: 0,
      errors: 0,
      cached: 0,
      tokens: 0,
    });
  }

  for (const event of events) {
    if (event.timestamp < since || event.timestamp > until) continue;
    const bucketIndex = Math.min(
      bucketCount - 1,
      Math.max(0, Math.floor((event.timestamp - since) / bucketSize)),
    );
    const b = buckets[bucketIndex];
    if (b) {
      b.requests++;
      if (event.isError) b.errors++;
      if (event.cached) b.cached++;
      if (typeof event.tokenCount === "number") b.tokens += event.tokenCount;
    }
  }

  return {
    ok: true,
    window: { since, until },
    summary,
    byTool,
    timeSeries: buckets,
  };
}

function createDefaultTokenizer(): Tokenizer {
  return {
    id: "approximate-chars-ratio-4",
    measurement: "estimate",
    count(text: string): number {
      if (!text) return 0;
      return Math.ceil(text.length / 4);
    },
  };
}

/**
 * Self-hosted admin surface for versioned declarative HTTP descriptors.
 *
 * It validates descriptor sets against a bound contract's credential scheme
 * map, lowers them statically for preview, persists revision history, and
 * publishes them through the existing `DynamicGateway`. Publishing reuses the
 * gateway's tenant isolation, revision history, destination policy, and audit
 * path; the admin package adds authentication, tenant scoping, durable
 * descriptor revisions, restore, rollback, and an operator UI. It never
 * executes an upstream request and never sees a credential value.
 */
export class DeclarativeAdmin {
  readonly #gateway: DynamicGateway;
  readonly #tokens: DeclarativeAdminOptions["tokens"];
  readonly #bindings: ReadonlyMap<string, DeclarativeAdminContractBinding>;
  readonly #maxRequestBytes: number;
  readonly #now: () => number;
  readonly #auditSink: DeclarativeAdminOptions["auditSink"];
  readonly #logger: DeclarativeAdminOptions["logger"];
  readonly #store: DescriptorRevisionStore;
  readonly #storageDriver: StorageDriver | undefined;
  readonly #configPath: string | undefined;
  readonly #onConfigSync: DeclarativeAdminOptions["onConfigSync"];
  readonly #transport: DeclarativeAdminOptions["transport"];
  readonly #resolveHost: DeclarativeAdminOptions["resolveHost"];
  readonly #tokenizer: Tokenizer;

  constructor(options: DeclarativeAdminOptions) {
    if (typeof options !== "object" || options === null) {
      throw new TypeError("DeclarativeAdmin requires an options object");
    }
    if (
      !options.gateway ||
      typeof options.gateway.publishContract !== "function" ||
      typeof options.gateway.getRegistry !== "function"
    ) {
      throw new TypeError(
        "DeclarativeAdmin requires a DynamicGateway with publishContract() and getRegistry()",
      );
    }

    const tokens = options.tokens;
    if (!Array.isArray(tokens) || tokens.length === 0) {
      throw new TypeError(
        "DeclarativeAdmin requires at least one configured bearer token",
      );
    }
    // Token validation lives in auth.ts so the handler and tests share it.
    validateAdminTokens(tokens);

    const maxRequestBytes =
      options.maxRequestBytes ?? MAX_DECLARATIVE_ADMIN_REQUEST_BYTES;
    if (
      !Number.isInteger(maxRequestBytes) ||
      maxRequestBytes < MIN_BODY_LIMIT ||
      maxRequestBytes > MAX_BODY_LIMIT
    ) {
      throw new TypeError(
        `maxRequestBytes must be an integer between ${MIN_BODY_LIMIT} and ${MAX_BODY_LIMIT}`,
      );
    }

    this.#gateway = options.gateway;
    this.#tokens = Object.freeze([...tokens]);
    this.#bindings = buildBindingIndex(options.contracts ?? []);
    this.#maxRequestBytes = maxRequestBytes;
    this.#now = options.now ?? Date.now;
    this.#auditSink = options.auditSink;
    this.#logger = options.logger;
    this.#store = options.repository ?? new InMemoryDescriptorRevisionStore();
    this.#storageDriver = options.storageDriver;
    this.#configPath = options.configPath;
    this.#onConfigSync = options.onConfigSync;
    this.#transport = options.transport;
    this.#resolveHost = options.resolveHost;
    this.#tokenizer = options.tokenizer ?? createDefaultTokenizer();
    if (
      typeof this.#store !== "object" ||
      this.#store === null ||
      typeof this.#store.listRevisions !== "function" ||
      typeof this.#store.getActive !== "function" ||
      typeof this.#store.createRevision !== "function" ||
      typeof this.#store.activateRevision !== "function" ||
      typeof this.#store.recordGatewayRevision !== "function" ||
      typeof this.#store.failRevision !== "function"
    ) {
      throw new TypeError(
        "DeclarativeAdmin repository must implement the DescriptorRevisionStore interface",
      );
    }
  }

  /** The configured revision store, for startup diagnostics. */
  get storeKind(): string {
    return this.#store.kind;
  }

  /** The configured storage driver, if any. */
  get storageDriver(): StorageDriver | undefined {
    return this.#storageDriver;
  }

  /** The configured configuration file path, if any. */
  get configPath(): string | undefined {
    return this.#configPath;
  }

  /** HTTP entry point. Never throws; failures become JSON error responses. */
  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      return await this.dispatch(request, url);
    } catch (error) {
      return await this.errorResponse(error, request, url);
    }
  }

  private async dispatch(request: Request, url: URL): Promise<Response> {
    const segments = splitPath(url.pathname);

    if (segments.length === 0) {
      assertMethod(request, ["GET"]);
      return htmlResponse(ADMIN_INDEX_HTML);
    }

    if (segments[0] === "ui" && segments.length === 2) {
      assertMethod(request, ["GET"]);
      if (segments[1] === "app.js")
        return assetResponse("app.js", ADMIN_APP_JS);
      if (segments[1] === "app.css")
        return assetResponse("app.css", ADMIN_APP_CSS);
      throw routeNotFound(request);
    }

    if (segments[0] === "api" && segments[1] === "v1") {
      return await this.dispatchApi(request, url, segments.slice(2));
    }

    throw routeNotFound(request);
  }

  private async dispatchApi(
    request: Request,
    url: URL,
    segments: readonly string[],
  ): Promise<Response> {
    if (segments.length === 0) {
      assertMethod(request, ["GET"]);
      return jsonResponse(200, {
        service: "chainmcp-declarative-admin",
        apiVersion: 1,
        endpoints: [
          "GET /api/v1/status",
          "GET /api/v1/healthz",
          "GET /api/v1/contracts",
          "GET /api/v1/telemetry",
          "GET /api/v1/telemetry/metrics",
          "GET /api/v1/tenants/{tenant}/telemetry",
          "GET /api/v1/tenants/{tenant}/telemetry/metrics",
          "GET /api/v1/tenants/{tenant}/contracts/{contract}/tools",
          "GET /api/v1/tenants/{tenant}/contracts/{contract}/tools/{toolName}",
          "PATCH /api/v1/tenants/{tenant}/contracts/{contract}/tools/{toolName}",
          "POST /api/v1/tenants/{tenant}/contracts/{contract}/tools/{toolName}/test",
          "POST /api/v1/tenants/{tenant}/contracts/{contract}/curate",
          "GET /api/v1/tenants/{tenant}/contracts/{contract}/revisions",
          "GET /api/v1/tenants/{tenant}/contracts/{contract}/revisions/{revisionId}",
          "POST /api/v1/tenants/{tenant}/contracts/{contract}/validate",
          "POST /api/v1/tenants/{tenant}/contracts/{contract}/preview",
          "POST /api/v1/tenants/{tenant}/contracts/{contract}/publish",
          "POST /api/v1/tenants/{tenant}/contracts/{contract}/rollback",
        ],
      });
    }

    if (segments.length === 1 && segments[0] === "healthz") {
      assertMethod(request, ["GET"]);
      return jsonResponse(200, { status: "ok" });
    }

    if (segments.length === 1 && segments[0] === "status") {
      assertMethod(request, ["GET"]);
      return jsonResponse(200, {
        status: "ok",
        service: "chainmcp-studio",
        apiVersion: 1,
        storeKind: this.#store.kind,
        storage: {
          connected: this.#storageDriver?.isConnected ?? false,
          driver: this.#storageDriver?.id ?? "none",
        },
        contractsCount: this.#bindings.size,
      });
    }

    const principal = await this.authenticate(request, url);
    const route = `${request.method} ${url.pathname}`;

    if (segments.length === 1 && segments[0] === "contracts") {
      assertMethod(request, ["GET"]);
      return jsonResponse(200, {
        contracts: [...this.#bindings.values()]
          .filter(
            (binding) =>
              principal.tenants === "*" ||
              principal.tenants.includes(binding.tenantId),
          )
          .map((binding) => ({
            tenantId: binding.tenantId,
            contractName: binding.contractName,
            baseUrl: binding.destinationPolicy.baseUrl,
            allowedHosts: [...binding.destinationPolicy.allowedHosts],
          })),
      });
    }

    if (
      segments.length === 2 &&
      segments[0] === "telemetry" &&
      segments[1] === "metrics"
    ) {
      assertMethod(request, ["GET"]);
      const tenantParam = url.searchParams.get("tenant") ?? undefined;
      if (
        tenantParam &&
        principal.tenants !== "*" &&
        !principal.tenants.includes(tenantParam)
      ) {
        throw new DeclarativeAdminError(
          "ADMIN_TENANT_FORBIDDEN",
          403,
          `Token is not authorized for tenant '${tenantParam}'`,
        );
      }
      const toolName = url.searchParams.get("tool") ?? undefined;
      const now = this.#now();
      const until = url.searchParams.has("until")
        ? Number(url.searchParams.get("until"))
        : now;
      const since = url.searchParams.has("since")
        ? Number(url.searchParams.get("since"))
        : until - 3_600_000;

      if (!this.#storageDriver) {
        return jsonResponse(200, computeTelemetryMetrics([], since, until));
      }
      const ringBuffer = this.#storageDriver.getTelemetryRingBuffer();
      const rawEvents = await ringBuffer.query({
        ...(tenantParam ? { tenantId: tenantParam } : {}),
        ...(toolName ? { toolName } : {}),
        since,
        until,
        limit: 10_000,
      });
      return jsonResponse(
        200,
        computeTelemetryMetrics(rawEvents, since, until),
      );
    }

    if (segments.length === 1 && segments[0] === "telemetry") {
      assertMethod(request, ["GET"]);
      const tenantParam = url.searchParams.get("tenant") ?? undefined;
      if (
        tenantParam &&
        principal.tenants !== "*" &&
        !principal.tenants.includes(tenantParam)
      ) {
        throw new DeclarativeAdminError(
          "ADMIN_TENANT_FORBIDDEN",
          403,
          `Token is not authorized for tenant '${tenantParam}'`,
        );
      }
      const toolName = url.searchParams.get("tool") ?? undefined;
      const statusParam = url.searchParams.get("status") ?? undefined;
      const isError =
        statusParam === "error"
          ? true
          : statusParam === "success"
            ? false
            : undefined;
      const since = url.searchParams.has("since")
        ? Number(url.searchParams.get("since"))
        : undefined;
      const until = url.searchParams.has("until")
        ? Number(url.searchParams.get("until"))
        : undefined;
      const limit = url.searchParams.has("limit")
        ? Math.min(1000, Math.max(1, Number(url.searchParams.get("limit"))))
        : 100;
      const offset = url.searchParams.has("offset")
        ? Math.max(0, Number(url.searchParams.get("offset")))
        : 0;
      const orderParam = url.searchParams.get("order");
      const order = orderParam === "asc" ? "asc" : "desc";

      if (!this.#storageDriver) {
        return jsonResponse(200, { ok: true, events: [], count: 0 });
      }
      const ringBuffer = this.#storageDriver.getTelemetryRingBuffer();
      const rawEvents = await ringBuffer.query({
        ...(tenantParam ? { tenantId: tenantParam } : {}),
        ...(toolName ? { toolName } : {}),
        ...(isError !== undefined ? { isError } : {}),
        ...(since !== undefined ? { since } : {}),
        ...(until !== undefined ? { until } : {}),
        limit,
        offset,
        order,
      });
      const events = rawEvents.map(formatTelemetryEvent);
      return jsonResponse(200, { ok: true, events, count: events.length });
    }

    if (
      segments.length === 4 &&
      segments[0] === "tenants" &&
      segments[2] === "telemetry" &&
      segments[3] === "metrics"
    ) {
      assertMethod(request, ["GET"]);
      const tenant = segments[1]!;
      assertTenantAllowed(principal, tenant);
      const toolName = url.searchParams.get("tool") ?? undefined;
      const now = this.#now();
      const until = url.searchParams.has("until")
        ? Number(url.searchParams.get("until"))
        : now;
      const since = url.searchParams.has("since")
        ? Number(url.searchParams.get("since"))
        : until - 3_600_000;

      if (!this.#storageDriver) {
        return jsonResponse(200, computeTelemetryMetrics([], since, until));
      }
      const ringBuffer = this.#storageDriver.getTelemetryRingBuffer();
      const rawEvents = await ringBuffer.query({
        tenantId: tenant,
        ...(toolName ? { toolName } : {}),
        since,
        until,
        limit: 10_000,
      });
      return jsonResponse(
        200,
        computeTelemetryMetrics(rawEvents, since, until),
      );
    }

    if (
      segments.length === 3 &&
      segments[0] === "tenants" &&
      segments[2] === "telemetry"
    ) {
      assertMethod(request, ["GET"]);
      const tenant = segments[1]!;
      assertTenantAllowed(principal, tenant);
      const toolName = url.searchParams.get("tool") ?? undefined;
      const statusParam = url.searchParams.get("status") ?? undefined;
      const isError =
        statusParam === "error"
          ? true
          : statusParam === "success"
            ? false
            : undefined;
      const since = url.searchParams.has("since")
        ? Number(url.searchParams.get("since"))
        : undefined;
      const until = url.searchParams.has("until")
        ? Number(url.searchParams.get("until"))
        : undefined;
      const limit = url.searchParams.has("limit")
        ? Math.min(1000, Math.max(1, Number(url.searchParams.get("limit"))))
        : 100;
      const offset = url.searchParams.has("offset")
        ? Math.max(0, Number(url.searchParams.get("offset")))
        : 0;
      const orderParam = url.searchParams.get("order");
      const order = orderParam === "asc" ? "asc" : "desc";

      if (!this.#storageDriver) {
        return jsonResponse(200, { ok: true, events: [], count: 0 });
      }
      const ringBuffer = this.#storageDriver.getTelemetryRingBuffer();
      const rawEvents = await ringBuffer.query({
        tenantId: tenant,
        ...(toolName ? { toolName } : {}),
        ...(isError !== undefined ? { isError } : {}),
        ...(since !== undefined ? { since } : {}),
        ...(until !== undefined ? { until } : {}),
        limit,
        offset,
        order,
      });
      const events = rawEvents.map(formatTelemetryEvent);
      return jsonResponse(200, { ok: true, events, count: events.length });
    }

    if (
      segments.length < 4 ||
      segments[0] !== "tenants" ||
      segments[2] !== "contracts"
    ) {
      throw routeNotFound(request);
    }

    const tenantId = segments[1] ?? "";
    const contractName = segments[3] ?? "";
    assertTenantAllowed(principal, tenantId);

    const binding = this.#bindings.get(bindingKey(tenantId, contractName));
    if (binding === undefined) {
      throw new DeclarativeAdminError(
        "ADMIN_CONTRACT_UNKNOWN",
        404,
        `No admin binding is configured for tenant '${tenantId}' and contract '${contractName}'`,
      );
    }

    const rest = segments.slice(4);
    if (rest.length === 0) throw routeNotFound(request);

    if (rest.length === 1) {
      switch (rest[0]) {
        case "tools": {
          assertMethod(request, ["GET"]);
          const active = this.#gateway
            .getRegistry()
            .getActiveRevision(tenantId, contractName);
          const activeRecord = await this.#store
            .getActive(tenantId, contractName)
            .catch(() => undefined);

          let tools: DeclarativeAdminToolSummary[];
          if (activeRecord && activeRecord.descriptors.length > 0) {
            tools = activeRecord.descriptors.map((desc) => ({
              name: desc.name,
              description: desc.description,
              contractRevision: active?.revisionId ?? activeRecord.revisionId,
              requiredScopes: desc.policy?.requiredScopes
                ? [...desc.policy.requiredScopes]
                : [],
              inputSchema: desc.inputSchema,
              enabled: desc.enabled !== false,
            }));
          } else {
            tools = (active?.tools ?? []).map((tool) => ({
              name: tool.name,
              description: tool.description,
              contractRevision: tool.contractRevision ?? "",
              requiredScopes: [...(tool.operation.requiredScopes ?? [])],
              inputSchema: tool.inputSchema,
              enabled: true,
            }));
          }
          return jsonResponse(200, {
            tenantId,
            contractName,
            revisionId: active?.revisionId ?? activeRecord?.revisionId ?? null,
            tools,
          });
        }
        case "curate": {
          assertMethod(request, ["POST"]);
          return await this.handleCurate(request, binding, route, principal);
        }
        case "revisions": {
          assertMethod(request, ["GET"]);
          const revisions = (
            await this.readStore(() =>
              this.#store.listRevisions(tenantId, contractName),
            )
          ).map((record) => toStoredRevisionSummary(record));
          return jsonResponse(200, { tenantId, contractName, revisions });
        }
        case "validate": {
          assertMethod(request, ["POST"]);
          return await this.handleValidate(request, binding, route, principal);
        }
        case "preview": {
          assertMethod(request, ["POST"]);
          return await this.handlePreview(request, binding, route, principal);
        }
        case "publish": {
          assertMethod(request, ["POST"]);
          return await this.handlePublish(request, binding, route, principal);
        }
        case "rollback": {
          assertMethod(request, ["POST"]);
          return await this.handleRollback(request, binding, route, principal);
        }
        default:
          throw routeNotFound(request);
      }
    }

    if (rest.length === 2 && rest[0] === "tools") {
      if (request.method === "GET") {
        return await this.handleGetTool(binding, rest[1]!);
      }
      assertMethod(request, ["PATCH"]);
      const toolName = rest[1]!;
      return await this.handleCurateTool(
        request,
        binding,
        toolName,
        route,
        principal,
      );
    }

    if (rest.length === 3 && rest[0] === "tools" && rest[2] === "test") {
      assertMethod(request, ["POST"]);
      const toolName = rest[1]!;
      return await this.handleTestTool(
        request,
        binding,
        toolName,
        route,
        principal,
      );
    }

    if (rest.length === 2 && rest[0] === "revisions") {
      assertMethod(request, ["GET"]);
      const revisionId = rest[1] ?? "";
      const record = await this.readStore(() =>
        this.#store.getRevision(tenantId, contractName, revisionId),
      );
      if (record === undefined) {
        throw new DeclarativeAdminError(
          "ADMIN_REVISION_UNKNOWN",
          404,
          `Revision '${revisionId}' was not found for this contract`,
        );
      }
      return jsonResponse(200, {
        ...toStoredRevisionSummary(record),
        descriptorSet: record.descriptors,
      });
    }

    throw routeNotFound(request);
  }

  private async readStore<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw mapStoreFailure(error);
    }
  }

  private async handleValidate(
    request: Request,
    binding: DeclarativeAdminContractBinding,
    route: string,
    principal: DeclarativeAdminPrincipal,
  ): Promise<Response> {
    const descriptors = readDescriptors(
      await readJsonBody(request, this.#maxRequestBytes),
    );
    const { evaluation } = evaluateDescriptorSet({
      descriptors,
      authSchemes: binding.authSchemes,
    });

    await this.emitAudit({
      type: "admin_validate",
      timestamp: this.#now(),
      route,
      tokenId: principal.tokenId,
      tenantId: binding.tenantId,
      contractName: binding.contractName,
      toolCount: evaluation.tools.length,
      reason: evaluation.valid ? undefined : "descriptors_invalid",
    });

    return jsonResponse(evaluation.valid ? 200 : 422, evaluation);
  }

  private async handlePreview(
    request: Request,
    binding: DeclarativeAdminContractBinding,
    route: string,
    principal: DeclarativeAdminPrincipal,
  ): Promise<Response> {
    const descriptors = readDescriptors(
      await readJsonBody(request, this.#maxRequestBytes),
    );
    const { preview } = evaluateDescriptorSet({
      descriptors,
      authSchemes: binding.authSchemes,
    });

    await this.emitAudit({
      type: "admin_preview",
      timestamp: this.#now(),
      route,
      tokenId: principal.tokenId,
      tenantId: binding.tenantId,
      contractName: binding.contractName,
      toolCount: preview.tools.length,
      reason: preview.valid ? undefined : "descriptors_invalid",
    });

    return jsonResponse(preview.valid ? 200 : 422, preview);
  }

  private async handlePublish(
    request: Request,
    binding: DeclarativeAdminContractBinding,
    route: string,
    principal: DeclarativeAdminPrincipal,
  ): Promise<Response> {
    const descriptors = readDescriptors(
      await readJsonBody(request, this.#maxRequestBytes),
    );
    const { evaluation, parsed } = evaluateDescriptorSet({
      descriptors,
      authSchemes: binding.authSchemes,
    });

    if (!evaluation.valid) {
      return jsonResponse(422, evaluation);
    }

    const published = await this.publishParsedDescriptors(
      binding,
      parsed,
      principal.tokenId,
    );

    await this.emitAudit({
      type: "admin_publish",
      timestamp: this.#now(),
      route,
      tokenId: principal.tokenId,
      tenantId: binding.tenantId,
      contractName: binding.contractName,
      revisionId: published.revisionId,
      ...(published.gatewayRevisionId === undefined
        ? {}
        : { gatewayRevisionId: published.gatewayRevisionId }),
      toolCount: published.toolCount,
    });

    return jsonResponse(201, published);
  }

  private async handleRollback(
    request: Request,
    binding: DeclarativeAdminContractBinding,
    route: string,
    principal: DeclarativeAdminPrincipal,
  ): Promise<Response> {
    const revisionId = readRevisionId(
      await readJsonBody(request, this.#maxRequestBytes),
    );
    const target = await this.readStore(() =>
      this.#store.getRevision(
        binding.tenantId,
        binding.contractName,
        revisionId,
      ),
    );
    if (target === undefined) {
      throw new DeclarativeAdminError(
        "ADMIN_REVISION_UNKNOWN",
        404,
        `Revision '${revisionId}' was not found for this contract`,
      );
    }
    if (target.status === "active") {
      throw new DeclarativeAdminError(
        "ADMIN_REVISION_CONFLICT",
        409,
        `Revision '${revisionId}' is already active`,
      );
    }
    if (target.status !== "superseded") {
      throw new DeclarativeAdminError(
        "ADMIN_REVISION_CONFLICT",
        409,
        `Revision '${revisionId}' is ${target.status} and cannot be restored`,
      );
    }

    const { evaluation, parsed } = evaluateDescriptorSet({
      descriptors: target.descriptors,
      authSchemes: binding.authSchemes,
    });
    if (!evaluation.valid) {
      throw new DeclarativeAdminError(
        "ADMIN_DESCRIPTOR_INVALID",
        422,
        `Stored revision '${revisionId}' no longer validates under the current contract binding (${evaluation.diagnostics
          .map((diagnostic) => diagnostic.code)
          .join(", ")})`,
        evaluation.diagnostics.flatMap((diagnostic) => diagnostic.issues),
      );
    }

    const published = await this.publishParsedDescriptors(
      binding,
      parsed,
      principal.tokenId,
      revisionId,
    );

    await this.emitAudit({
      type: "admin_rollback",
      timestamp: this.#now(),
      route,
      tokenId: principal.tokenId,
      tenantId: binding.tenantId,
      contractName: binding.contractName,
      revisionId: published.revisionId,
      ...(published.gatewayRevisionId === undefined
        ? {}
        : { gatewayRevisionId: published.gatewayRevisionId }),
      toolCount: published.toolCount,
      reason: `rollback_of:${revisionId}`,
    });

    return jsonResponse(201, published);
  }

  private async handleGetTool(
    binding: DeclarativeAdminContractBinding,
    toolName: string,
  ): Promise<Response> {
    const activeRecord = await this.readStore(() =>
      this.#store.getActive(binding.tenantId, binding.contractName),
    ).catch(() => undefined);
    const activeGateway = this.#gateway
      .getRegistry()
      .getActiveRevision(binding.tenantId, binding.contractName);

    if (activeRecord && activeRecord.descriptors.length > 0) {
      const desc = activeRecord.descriptors.find((d) => d.name === toolName);
      if (!desc) {
        throw new DeclarativeAdminError(
          "ADMIN_TOOL_NOT_FOUND",
          404,
          `Tool '${toolName}' was not found in contract '${binding.contractName}'`,
        );
      }
      return jsonResponse(200, {
        tenantId: binding.tenantId,
        contractName: binding.contractName,
        tool: {
          name: desc.name,
          description: desc.description,
          contractRevision:
            activeGateway?.revisionId ?? activeRecord.revisionId,
          requiredScopes: desc.policy?.requiredScopes
            ? [...desc.policy.requiredScopes]
            : [],
          inputSchema: desc.inputSchema,
          enabled: desc.enabled !== false,
        },
      });
    }

    const tool = activeGateway?.tools.find((t) => t.name === toolName);
    if (!tool) {
      throw new DeclarativeAdminError(
        "ADMIN_TOOL_NOT_FOUND",
        404,
        `Tool '${toolName}' was not found in contract '${binding.contractName}'`,
      );
    }

    return jsonResponse(200, {
      tenantId: binding.tenantId,
      contractName: binding.contractName,
      tool: {
        name: tool.name,
        description: tool.description,
        contractRevision: tool.contractRevision ?? "",
        requiredScopes: [...(tool.operation.requiredScopes ?? [])],
        inputSchema: tool.inputSchema,
        enabled: true,
      },
    });
  }

  private async handleCurateTool(
    request: Request,
    binding: DeclarativeAdminContractBinding,
    toolName: string,
    route: string,
    principal: DeclarativeAdminPrincipal,
  ): Promise<Response> {
    const body = await readJsonBody(request, this.#maxRequestBytes);
    if (
      typeof body !== "object" ||
      body === null ||
      typeof (body as { enabled?: unknown }).enabled !== "boolean"
    ) {
      throw new DeclarativeAdminError(
        "ADMIN_REQUEST_INVALID",
        400,
        "Curate request body must be a JSON object with a boolean 'enabled' property",
      );
    }
    const targetEnabled = (body as { enabled: boolean }).enabled;

    return await this.executeCurate(
      binding,
      [{ toolName, enabled: targetEnabled }],
      route,
      principal,
    );
  }

  private async handleTestTool(
    request: Request,
    binding: DeclarativeAdminContractBinding,
    toolName: string,
    route: string,
    principal: DeclarativeAdminPrincipal,
  ): Promise<Response> {
    const body = await readJsonBody(request, this.#maxRequestBytes);
    if (body !== null && typeof body !== "object") {
      throw new DeclarativeAdminError(
        "ADMIN_REQUEST_INVALID",
        400,
        "Test request body must be a JSON object",
      );
    }
    const dict = (body as Record<string, unknown>) ?? {};

    const activeRecord = await this.readStore(() =>
      this.#store.getActive(binding.tenantId, binding.contractName),
    ).catch(() => undefined);

    let desc: DeclarativeToolDescriptor | undefined;
    if (activeRecord && activeRecord.descriptors.length > 0) {
      desc = activeRecord.descriptors.find((d) => d.name === toolName);
    }

    if (!desc) {
      const activeGateway = this.#gateway
        .getRegistry()
        .getActiveRevision(binding.tenantId, binding.contractName);
      if (
        activeGateway?.metadata &&
        Array.isArray(activeGateway.metadata.descriptorSet)
      ) {
        desc = (
          activeGateway.metadata
            .descriptorSet as readonly DeclarativeToolDescriptor[]
        ).find((d) => d.name === toolName);
      }
    }

    if (!desc) {
      throw new DeclarativeAdminError(
        "ADMIN_TOOL_NOT_FOUND",
        404,
        `Tool '${toolName}' was not found in contract '${binding.contractName}'`,
      );
    }

    // Build sandboxed executor for this binding with direct un-cached execution
    const limits = binding.limits;
    const transport = binding.transport ?? this.#transport;
    const resolveHost = binding.resolveHost ?? this.#resolveHost;
    const executor = createUpstreamExecutor({
      baseUrl: binding.destinationPolicy.baseUrl,
      allowedHosts: binding.destinationPolicy.allowedHosts,
      ...(binding.destinationPolicy.allowInsecureHttp === undefined
        ? {}
        : {
            allowInsecureHttp: binding.destinationPolicy.allowInsecureHttp,
          }),
      ...(limits?.maxResponseBytes === undefined
        ? {}
        : { maxResponseBytes: limits.maxResponseBytes }),
      ...(limits?.maxRequestBytes === undefined
        ? {}
        : { maxRequestBytes: limits.maxRequestBytes }),
      ...(limits?.maxRedirects === undefined
        ? {}
        : { maxRedirects: limits.maxRedirects }),
      ...(limits?.timeoutMs === undefined
        ? {}
        : { timeoutMs: limits.timeoutMs }),
      ownerTenantId: binding.tenantId,
      ...(resolveHost === undefined ? {} : { resolveHost }),
      ...(transport === undefined ? {} : { transport }),
      ...(binding.credentialProvider === undefined
        ? {}
        : { credentialProvider: binding.credentialProvider }),
    });

    const source = new DeclarativeToolSource({
      descriptors: [{ ...desc, enabled: true }],
      executor,
      ...(binding.authSchemes === undefined
        ? {}
        : { authSchemes: binding.authSchemes }),
    });

    const [tool] = source.getTools();
    if (!tool) {
      throw new DeclarativeAdminError(
        "ADMIN_TOOL_NOT_FOUND",
        404,
        `Failed to bind tool '${toolName}' for testing`,
      );
    }

    const testArgs =
      "arguments" in dict &&
      typeof dict.arguments === "object" &&
      dict.arguments !== null
        ? (dict.arguments as Record<string, unknown>)
        : {};

    let selection: FieldSelection | undefined;
    if (
      "projection" in dict &&
      typeof dict.projection === "object" &&
      dict.projection !== null
    ) {
      selection = dict.projection as FieldSelection;
      try {
        assertFieldSelection(selection);
      } catch (error) {
        throw new DeclarativeAdminError(
          "ADMIN_REQUEST_INVALID",
          400,
          `Invalid projection: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } else if (desc.policy?.outputFields) {
      selection = desc.policy.outputFields;
    }

    const context: ToolContext = {
      tenantId: binding.tenantId,
      requestId: `test-${Date.now()}-${randomBytes(4).toString("hex")}`,
      principal: {
        id: principal.tokenId,
        scopes: desc.policy?.requiredScopes ?? [],
      },
    };

    const startTime = performance.now();
    let raw: unknown;
    try {
      raw = await tool.execute(testArgs, context);
    } catch (error) {
      const executionTimeMs = Math.round(performance.now() - startTime);
      await this.emitAudit({
        type: "admin_test_tool",
        timestamp: this.#now(),
        route,
        tokenId: principal.tokenId,
        tenantId: binding.tenantId,
        contractName: binding.contractName,
        toolName,
        reason: `test_failed:${error instanceof Error ? error.message : String(error)}`,
      });

      if (this.#storageDriver) {
        const ring = this.#storageDriver.getTelemetryRingBuffer();
        await ring
          .push({
            id: `tel-${Date.now()}-${randomBytes(4).toString("hex")}`,
            timestamp: this.#now(),
            tenantId: binding.tenantId,
            toolName,
            durationMs: executionTimeMs,
            isError: true,
            errorCode:
              error instanceof Error && "code" in error
                ? String((error as { code: unknown }).code)
                : "TEST_EXECUTION_FAILED",
            cached: false,
            metadata: {
              errorMessage:
                error instanceof Error ? error.message : String(error),
              source: "studio_playground",
            },
          })
          .catch(() => undefined);
      }

      return jsonResponse(400, {
        ok: false,
        toolName,
        executionTimeMs,
        error: {
          code:
            error instanceof Error && "code" in error
              ? String((error as { code: unknown }).code)
              : "TEST_EXECUTION_FAILED",
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }

    const executionTimeMs = Math.round(performance.now() - startTime);

    let projected = raw;
    if (
      selection &&
      ((selection.include && selection.include.length > 0) ||
        (selection.exclude && selection.exclude.length > 0))
    ) {
      const projector = createFieldProjector();
      projected = projector.project({
        tool: {
          name: toolName,
          output: { fields: selection },
        } as unknown as ToolDefinition,
        result: raw,
        context,
      });
    }

    const rawStr = typeof raw === "string" ? raw : JSON.stringify(raw);
    const projectedStr =
      typeof projected === "string" ? projected : JSON.stringify(projected);
    const rawTokens = this.#tokenizer.count(rawStr);
    const projectedTokens = this.#tokenizer.count(projectedStr);
    const savedTokens = Math.max(0, rawTokens - projectedTokens);
    const percentSavings =
      rawTokens > 0 ? Math.round((savedTokens / rawTokens) * 100) : 0;

    await this.emitAudit({
      type: "admin_test_tool",
      timestamp: this.#now(),
      route,
      tokenId: principal.tokenId,
      tenantId: binding.tenantId,
      contractName: binding.contractName,
      toolName,
      reason: `test_success:${savedTokens}_tokens_saved`,
    });

    if (this.#storageDriver) {
      const ring = this.#storageDriver.getTelemetryRingBuffer();
      await ring
        .push({
          id: `tel-${Date.now()}-${randomBytes(4).toString("hex")}`,
          timestamp: this.#now(),
          tenantId: binding.tenantId,
          toolName,
          durationMs: executionTimeMs,
          isError: false,
          cached: false,
          tokenCount: projectedTokens,
          metadata: {
            rawTokens,
            projectedTokens,
            savedTokens,
            source: "studio_playground",
          },
        })
        .catch(() => undefined);
    }

    return jsonResponse(200, {
      ok: true,
      toolName,
      executionTimeMs,
      raw,
      projected,
      metrics: {
        rawTokens,
        projectedTokens,
        savedTokens,
        percentSavings,
        tokenizerId: this.#tokenizer.id,
      },
    });
  }

  private async handleCurate(
    request: Request,
    binding: DeclarativeAdminContractBinding,
    route: string,
    principal: DeclarativeAdminPrincipal,
  ): Promise<Response> {
    const body = await readJsonBody(request, this.#maxRequestBytes);
    if (typeof body !== "object" || body === null) {
      throw new DeclarativeAdminError(
        "ADMIN_REQUEST_INVALID",
        400,
        "Curate request body must be a JSON object",
      );
    }

    const dict = body as Record<string, unknown>;
    const updates: Array<{ toolName: string; enabled: boolean }> = [];
    if ("toolName" in dict && typeof dict.toolName === "string") {
      if (typeof dict.enabled !== "boolean") {
        throw new DeclarativeAdminError(
          "ADMIN_REQUEST_INVALID",
          400,
          "Curate request body property 'enabled' must be a boolean",
        );
      }
      updates.push({
        toolName: dict.toolName,
        enabled: dict.enabled,
      });
    } else if (
      "tools" in dict &&
      typeof dict.tools === "object" &&
      dict.tools !== null
    ) {
      for (const [name, enabled] of Object.entries(
        dict.tools as Record<string, unknown>,
      )) {
        if (typeof enabled !== "boolean") {
          throw new DeclarativeAdminError(
            "ADMIN_REQUEST_INVALID",
            400,
            `Tool '${name}' enabled value must be a boolean`,
          );
        }
        updates.push({ toolName: name, enabled });
      }
    } else {
      throw new DeclarativeAdminError(
        "ADMIN_REQUEST_INVALID",
        400,
        "Curate request must contain 'toolName' and 'enabled', or a 'tools' map",
      );
    }

    return await this.executeCurate(binding, updates, route, principal);
  }

  private async executeCurate(
    binding: DeclarativeAdminContractBinding,
    updates: ReadonlyArray<{ toolName: string; enabled: boolean }>,
    route: string,
    principal: DeclarativeAdminPrincipal,
  ): Promise<Response> {
    if (updates.length === 0) {
      throw new DeclarativeAdminError(
        "ADMIN_REQUEST_INVALID",
        400,
        "No tool curation updates provided",
      );
    }

    const activeRecord = await this.readStore(() =>
      this.#store.getActive(binding.tenantId, binding.contractName),
    );

    let descriptors: readonly DeclarativeToolDescriptor[] | undefined =
      activeRecord?.descriptors;

    if (!descriptors || descriptors.length === 0) {
      const activeGateway = this.#gateway
        .getRegistry()
        .getActiveRevision(binding.tenantId, binding.contractName);
      if (
        activeGateway?.metadata &&
        Array.isArray(activeGateway.metadata.descriptorSet)
      ) {
        descriptors = activeGateway.metadata
          .descriptorSet as readonly DeclarativeToolDescriptor[];
      }
    }

    if (!descriptors || descriptors.length === 0) {
      throw new DeclarativeAdminError(
        "ADMIN_TOOL_NOT_FOUND",
        404,
        `No active descriptors found for contract '${binding.contractName}'`,
      );
    }

    const updateMap = new Map(updates.map((u) => [u.toolName, u.enabled]));
    for (const toolName of updateMap.keys()) {
      if (!descriptors.some((d) => d.name === toolName)) {
        throw new DeclarativeAdminError(
          "ADMIN_TOOL_NOT_FOUND",
          404,
          `Tool '${toolName}' was not found in contract '${binding.contractName}'`,
        );
      }
    }

    const updatedDescriptors = descriptors.map((desc) => {
      if (updateMap.has(desc.name)) {
        return {
          ...desc,
          enabled: updateMap.get(desc.name)!,
        };
      }
      return desc;
    });

    if (updatedDescriptors.every((d) => d.enabled === false)) {
      throw new DeclarativeAdminError(
        "ADMIN_REQUEST_INVALID",
        400,
        "Cannot disable all tools: contract must have at least one active tool",
      );
    }

    const { evaluation, parsed } = evaluateDescriptorSet({
      descriptors: updatedDescriptors,
      authSchemes: binding.authSchemes,
    });

    if (!evaluation.valid) {
      return jsonResponse(422, evaluation);
    }

    const published = await this.publishParsedDescriptors(
      binding,
      parsed,
      principal.tokenId,
    );

    if (this.#onConfigSync) {
      for (const [toolName, enabled] of updateMap.entries()) {
        await this.#onConfigSync({
          tenantId: binding.tenantId,
          contractName: binding.contractName,
          toolName,
          enabled,
        });
      }
    }

    await this.emitAudit({
      type: "admin_curate",
      timestamp: this.#now(),
      route,
      tokenId: principal.tokenId,
      tenantId: binding.tenantId,
      contractName: binding.contractName,
      toolName: updates.length === 1 ? updates[0]!.toolName : undefined,
      enabled: updates.length === 1 ? updates[0]!.enabled : undefined,
      revisionId: published.revisionId,
      ...(published.gatewayRevisionId === undefined
        ? {}
        : { gatewayRevisionId: published.gatewayRevisionId }),
      toolCount: published.toolCount,
      reason: updates
        .map((u) => `${u.toolName}:${u.enabled ? "enabled" : "disabled"}`)
        .join(","),
    });

    return jsonResponse(200, {
      ok: true,
      toolName: updates.length === 1 ? updates[0]!.toolName : undefined,
      enabled: updates.length === 1 ? updates[0]!.enabled : undefined,
      updates,
      revisionId: published.revisionId,
      gatewayRevisionId: published.gatewayRevisionId,
      toolCount: published.toolCount,
    });
  }

  /**
   * Persists a candidate revision, publishes it through the gateway, and marks
   * it active. If the gateway rejects it, the candidate is marked failed so
   * the store never claims a revision that is not serving.
   */
  private async publishParsedDescriptors(
    binding: DeclarativeAdminContractBinding,
    parsed: readonly ParsedDeclarativeTool[],
    publisherId: string,
    rollbackOf?: string,
  ): Promise<DeclarativeAdminPublishedRevision> {
    const descriptors: readonly DeclarativeToolDescriptor[] = parsed.map(
      (tool) => tool.descriptor,
    );
    const tools = this.buildTools(binding, parsed);
    const toolRevisions = parsed.map((tool) => ({
      name: tool.descriptor.name,
      revision: tool.revision,
    }));
    const toolsetHash = descriptorToolsetHash(toolRevisions);
    const createdAt = this.#now();
    const record: StoredDescriptorRevision = {
      revisionId: createDescriptorRevisionId(
        binding.tenantId,
        binding.contractName,
        toolsetHash,
        createdAt,
      ),
      tenantId: binding.tenantId,
      contractName: binding.contractName,
      createdAt,
      status: "candidate",
      toolsetHash,
      descriptors,
      toolRevisions,
      publishedBy: publisherId,
      ...(rollbackOf === undefined ? {} : { rollbackOf }),
    };

    try {
      await this.#store.createRevision(record);
    } catch (error) {
      throw mapStoreFailure(error);
    }

    let revision: ContractRevision;
    try {
      revision = await this.#gateway.publishContract({
        tenantId: binding.tenantId,
        contractName: binding.contractName,
        tools,
        destinationPolicy: binding.destinationPolicy,
        ...(binding.limits === undefined ? {} : { limits: binding.limits }),
        metadata: {
          source: "declarative",
          descriptorVersion: 1,
          adminRevisionId: record.revisionId,
          descriptorSetHash: toolsetHash,
          descriptors: toolRevisions,
          descriptorSet: descriptors,
          ...(rollbackOf === undefined ? {} : { rollbackOf }),
        },
      });
    } catch (error) {
      await this.#store
        .failRevision(binding.tenantId, binding.contractName, record.revisionId)
        .catch(() => undefined);
      throw mapGatewayFailure(error);
    }

    try {
      await this.#store.activateRevision(
        binding.tenantId,
        binding.contractName,
        record.revisionId,
        revision.revisionId,
      );
    } catch (error) {
      throw mapStoreFailure(error);
    }

    return {
      ...toStoredRevisionSummary({
        ...record,
        status: "active",
        gatewayRevisionId: revision.revisionId,
      }),
      sourceHash: revision.sourceHash,
      baseUrl: revision.destinationPolicy.baseUrl,
      allowedHosts: [...revision.destinationPolicy.allowedHosts],
    };
  }

  /**
   * Republishes the active persisted revision of every bound contract into the
   * gateway. Call after constructing the gateway to recover descriptor-backed
   * tools across a restart. Per-contract failures are reported, not thrown.
   */
  async restore(): Promise<DeclarativeAdminRestoreResult> {
    const restored: DeclarativeAdminRestoreResult["restored"][number][] = [];
    const skipped: DeclarativeAdminRestoreResult["skipped"][number][] = [];
    const failures: DeclarativeAdminRestoreResult["failures"][number][] = [];

    for (const binding of this.#bindings.values()) {
      const { tenantId, contractName } = binding;
      let active: StoredDescriptorRevision | undefined;
      try {
        active = await this.#store.getActive(tenantId, contractName);
      } catch (error) {
        failures.push({
          tenantId,
          contractName,
          revisionId: "",
          reason: describeFailure(error),
        });
        continue;
      }
      if (active === undefined) continue;

      let evaluated;
      try {
        evaluated = evaluateDescriptorSet({
          descriptors: active.descriptors,
          authSchemes: binding.authSchemes,
        });
      } catch (error) {
        failures.push({
          tenantId,
          contractName,
          revisionId: active.revisionId,
          reason: describeFailure(error),
        });
        continue;
      }
      const { evaluation, parsed } = evaluated;
      if (!evaluation.valid) {
        skipped.push({
          tenantId,
          contractName,
          revisionId: active.revisionId,
          reason: "descriptors_invalid",
        });
        continue;
      }

      const current = this.#gateway
        .getRegistry()
        .getActiveRevision(tenantId, contractName);
      if (
        current !== undefined &&
        (current.revisionId === active.gatewayRevisionId ||
          current.metadata?.descriptorSetHash === active.toolsetHash)
      ) {
        skipped.push({
          tenantId,
          contractName,
          revisionId: active.revisionId,
          reason: "already_active",
        });
        continue;
      }

      try {
        const tools = this.buildTools(binding, parsed);
        const revision = await this.#gateway.publishContract({
          tenantId,
          contractName,
          tools,
          destinationPolicy: binding.destinationPolicy,
          ...(binding.limits === undefined ? {} : { limits: binding.limits }),
          metadata: {
            source: "declarative",
            descriptorVersion: 1,
            adminRevisionId: active.revisionId,
            descriptorSetHash: active.toolsetHash,
            descriptors: active.toolRevisions,
            descriptorSet: active.descriptors,
            restored: true,
          },
        });
        await this.#store.recordGatewayRevision(
          tenantId,
          contractName,
          active.revisionId,
          revision.revisionId,
        );
        restored.push({
          tenantId,
          contractName,
          revisionId: active.revisionId,
          gatewayRevisionId: revision.revisionId,
        });
        await this.emitAudit({
          type: "admin_restore",
          timestamp: this.#now(),
          route: "startup",
          tenantId,
          contractName,
          revisionId: active.revisionId,
          gatewayRevisionId: revision.revisionId,
          toolCount: tools.length,
        });
      } catch (error) {
        failures.push({
          tenantId,
          contractName,
          revisionId: active.revisionId,
          reason: describeFailure(error),
        });
      }
    }

    return { restored, skipped, failures };
  }

  private buildTools(
    binding: DeclarativeAdminContractBinding,
    parsed: readonly ParsedDeclarativeTool[],
  ): readonly ToolDefinition[] {
    const limits = binding.limits;
    // A binding may override the admin-wide transport and resolver so one
    // admin can front upstreams that are reachable only through a specific
    // network path.
    const transport = binding.transport ?? this.#transport;
    const resolveHost = binding.resolveHost ?? this.#resolveHost;
    const executor = createUpstreamExecutor({
      baseUrl: binding.destinationPolicy.baseUrl,
      allowedHosts: binding.destinationPolicy.allowedHosts,
      ...(binding.destinationPolicy.allowInsecureHttp === undefined
        ? {}
        : {
            allowInsecureHttp: binding.destinationPolicy.allowInsecureHttp,
          }),
      ...(limits?.maxResponseBytes === undefined
        ? {}
        : { maxResponseBytes: limits.maxResponseBytes }),
      ...(limits?.maxRequestBytes === undefined
        ? {}
        : { maxRequestBytes: limits.maxRequestBytes }),
      ...(limits?.maxRedirects === undefined
        ? {}
        : { maxRedirects: limits.maxRedirects }),
      ...(limits?.timeoutMs === undefined
        ? {}
        : { timeoutMs: limits.timeoutMs }),
      ownerTenantId: binding.tenantId,
      ...(resolveHost === undefined ? {} : { resolveHost }),
      ...(transport === undefined ? {} : { transport }),
      ...(binding.credentialProvider === undefined
        ? {}
        : { credentialProvider: binding.credentialProvider }),
    });

    try {
      // Re-validates every descriptor and lowers it through the same bounded
      // executor that serves compiled contracts.
      const source = new DeclarativeToolSource({
        descriptors: parsed.map((tool) => tool.descriptor),
        executor,
        ...(binding.authSchemes === undefined
          ? {}
          : { authSchemes: binding.authSchemes }),
      });
      return source.getTools();
    } catch (error) {
      throw mapDescriptorFailure(error);
    }
  }

  private async authenticate(
    request: Request,
    url: URL,
  ): Promise<DeclarativeAdminPrincipal> {
    try {
      return authenticateAdminToken(
        this.#tokens,
        request.headers.get("authorization"),
      );
    } catch (error) {
      if (error instanceof DeclarativeAdminError) {
        await this.emitAudit({
          type: "admin_auth_failed",
          timestamp: this.#now(),
          route: `${request.method} ${url.pathname}`,
          reason: error.code,
        });
      }
      throw error;
    }
  }

  private async errorResponse(
    error: unknown,
    request: Request,
    url: URL,
  ): Promise<Response> {
    if (error instanceof DeclarativeAdminError) {
      if (!error.code.startsWith("ADMIN_AUTH")) {
        await this.emitAudit({
          type: "admin_request_rejected",
          timestamp: this.#now(),
          route: `${request.method} ${url.pathname}`,
          reason: error.code,
        });
      }
      return errorJsonResponse(error);
    }

    this.#logger?.error("Declarative admin request failed", {
      route: `${request.method} ${url.pathname}`,
      error: error instanceof Error ? error.name : "unknown",
    });
    const internal = new DeclarativeAdminError(
      "ADMIN_INTERNAL",
      500,
      "The admin request failed",
    );
    return errorJsonResponse(internal);
  }

  private async emitAudit(
    event: Omit<DeclarativeAdminAuditEvent, "type"> & {
      readonly type: DeclarativeAdminAuditEventType;
    },
  ): Promise<void> {
    if (this.#auditSink === undefined) return;
    const record: DeclarativeAdminAuditEvent = {
      type: event.type,
      timestamp: event.timestamp,
      route: event.route,
      ...(event.tokenId === undefined ? {} : { tokenId: event.tokenId }),
      ...(event.tenantId === undefined ? {} : { tenantId: event.tenantId }),
      ...(event.contractName === undefined
        ? {}
        : { contractName: event.contractName }),
      ...(event.revisionId === undefined
        ? {}
        : { revisionId: event.revisionId }),
      ...(event.gatewayRevisionId === undefined
        ? {}
        : { gatewayRevisionId: event.gatewayRevisionId }),
      ...(event.toolCount === undefined ? {} : { toolCount: event.toolCount }),
      ...(event.toolName === undefined ? {} : { toolName: event.toolName }),
      ...(event.enabled === undefined ? {} : { enabled: event.enabled }),
      ...(event.reason === undefined ? {} : { reason: event.reason }),
    };
    try {
      await this.#auditSink(record);
    } catch {
      // Audit failures must not change the admin response.
    }
  }
}

export function createDeclarativeAdmin(
  options: DeclarativeAdminOptions,
): DeclarativeAdmin {
  return new DeclarativeAdmin(options);
}

/** Convenience wrapper for programmatic use and tests. */
export async function handleDeclarativeAdminRequest(
  admin: DeclarativeAdmin,
  request: Request,
): Promise<Response> {
  return await admin.handle(request);
}

function buildBindingIndex(
  bindings: readonly DeclarativeAdminContractBinding[],
): ReadonlyMap<string, DeclarativeAdminContractBinding> {
  if (!Array.isArray(bindings)) {
    throw new TypeError("DeclarativeAdmin contracts must be an array");
  }
  const index = new Map<string, DeclarativeAdminContractBinding>();
  for (const binding of bindings) {
    if (
      typeof binding !== "object" ||
      binding === null ||
      typeof binding.tenantId !== "string" ||
      binding.tenantId.trim().length === 0 ||
      hasControlCharacters(binding.tenantId)
    ) {
      throw new TypeError(
        "Each admin contract binding requires a non-empty tenantId without control characters",
      );
    }
    if (!CONTRACT_NAME.test(binding.contractName)) {
      throw new TypeError(
        `Admin contract name '${binding.contractName}' is invalid. Must be 1-64 alphanumeric characters, hyphens, or underscores`,
      );
    }
    const policy = binding.destinationPolicy;
    if (
      typeof policy !== "object" ||
      policy === null ||
      typeof policy.baseUrl !== "string" ||
      policy.baseUrl.length === 0 ||
      !Array.isArray(policy.allowedHosts) ||
      policy.allowedHosts.length === 0 ||
      policy.allowedHosts.some(
        (host: unknown) => typeof host !== "string" || host.length === 0,
      )
    ) {
      throw new TypeError(
        `Admin contract '${binding.contractName}' requires a destination policy with a baseUrl and non-empty allowedHosts`,
      );
    }
    const key = bindingKey(binding.tenantId, binding.contractName);
    if (index.has(key)) {
      throw new TypeError(
        `Admin contract binding for tenant '${binding.tenantId}' and contract '${binding.contractName}' is duplicated`,
      );
    }
    index.set(key, binding);
  }
  return index;
}

function bindingKey(tenantId: string, contractName: string): string {
  return `${tenantId}\u0000${contractName}`;
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) <= 0x1f) return true;
  }
  return false;
}

function splitPath(pathname: string): readonly string[] {
  const raw = pathname.split("/").filter((segment) => segment.length > 0);
  return raw.map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      throw new DeclarativeAdminError(
        "ADMIN_REQUEST_INVALID",
        400,
        "Request path contains invalid percent-encoding",
      );
    }
  });
}

function assertMethod(request: Request, allowed: readonly string[]): void {
  if (!allowed.includes(request.method)) {
    throw new DeclarativeAdminError(
      "ADMIN_METHOD_NOT_ALLOWED",
      405,
      `Method ${request.method} is not allowed for this route`,
      [],
      allowed,
    );
  }
}

function routeNotFound(request: Request): DeclarativeAdminError {
  return new DeclarativeAdminError(
    "ADMIN_ROUTE_NOT_FOUND",
    404,
    `No admin route matches ${request.method} ${new URL(request.url).pathname}`,
  );
}

async function readJsonBody(
  request: Request,
  maxBytes: number,
): Promise<unknown> {
  const contentType = request.headers.get("content-type");
  if (contentType === null) {
    throw new DeclarativeAdminError(
      "ADMIN_MEDIA_TYPE_UNSUPPORTED",
      415,
      "Content-Type must be application/json",
    );
  }
  const mime = contentType.split(";")[0]?.trim().toLowerCase();
  if (mime !== "application/json") {
    throw new DeclarativeAdminError(
      "ADMIN_MEDIA_TYPE_UNSUPPORTED",
      415,
      "Content-Type must be application/json",
    );
  }

  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isInteger(length) || length < 0) {
      throw new DeclarativeAdminError(
        "ADMIN_REQUEST_INVALID",
        400,
        "Content-Length must be a non-negative integer",
      );
    }
    if (length > maxBytes) {
      throw new DeclarativeAdminError(
        "ADMIN_REQUEST_TOO_LARGE",
        413,
        `Request body exceeds the ${maxBytes} byte limit`,
      );
    }
  }

  if (request.body === null) {
    throw new DeclarativeAdminError(
      "ADMIN_REQUEST_INVALID",
      400,
      "A JSON request body is required",
    );
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new DeclarativeAdminError(
        "ADMIN_REQUEST_TOO_LARGE",
        413,
        `Request body exceeds the ${maxBytes} byte limit`,
      );
    }
    chunks.push(value);
  }

  if (total === 0) {
    throw new DeclarativeAdminError(
      "ADMIN_REQUEST_INVALID",
      400,
      "A JSON request body is required",
    );
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(
      concatChunks(chunks, total),
    );
  } catch {
    throw new DeclarativeAdminError(
      "ADMIN_REQUEST_INVALID",
      400,
      "Request body must be UTF-8 encoded JSON",
    );
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new DeclarativeAdminError(
      "ADMIN_REQUEST_INVALID",
      400,
      "Request body must be valid JSON",
    );
  }
}

function concatChunks(
  chunks: readonly Uint8Array[],
  total: number,
): Uint8Array {
  const buffer = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return buffer;
}

function readDescriptors(body: unknown): readonly unknown[] {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new DeclarativeAdminError(
      "ADMIN_REQUEST_INVALID",
      400,
      "Request body must be a JSON object",
    );
  }
  const descriptors = (body as { descriptors?: unknown }).descriptors;
  if (!Array.isArray(descriptors)) {
    throw new DeclarativeAdminError(
      "ADMIN_REQUEST_INVALID",
      400,
      "Request body must contain a 'descriptors' array",
    );
  }
  if (descriptors.length > MAX_DECLARATIVE_DESCRIPTORS) {
    throw new DeclarativeAdminError(
      "ADMIN_REQUEST_INVALID",
      400,
      `At most ${MAX_DECLARATIVE_DESCRIPTORS} descriptors may be submitted at once`,
    );
  }
  return descriptors;
}

function mapDescriptorFailure(error: unknown): DeclarativeAdminError {
  if (error instanceof DeclarativeDescriptorError) {
    return new DeclarativeAdminError(
      "ADMIN_DESCRIPTOR_INVALID",
      422,
      error.message,
      error.issues,
    );
  }
  if (error instanceof DeclarativeAdminError) return error;
  return new DeclarativeAdminError(
    "ADMIN_PUBLISH_FAILED",
    500,
    "Descriptors could not be lowered for publication",
  );
}

function mapGatewayFailure(error: unknown): DeclarativeAdminError {
  if (error instanceof GatewayError) {
    const status =
      error.code === "DESTINATION_INVALID"
        ? 400
        : error.code === "REVISION_CONFLICT" ||
            error.code === "POLICY_VIOLATION" ||
            error.code === "TENANT_MISMATCH" ||
            error.code === "INVALID_REVISION_STATE"
          ? 409
          : error.code === "COMPILATION_FAILED"
            ? 422
            : 404;
    return new DeclarativeAdminError(
      status === 409 ? "ADMIN_PUBLISH_CONFLICT" : "ADMIN_PUBLISH_FAILED",
      status,
      error.message,
    );
  }
  return new DeclarativeAdminError(
    "ADMIN_PUBLISH_FAILED",
    500,
    "The contract could not be published",
  );
}

function readRevisionId(body: unknown): string {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new DeclarativeAdminError(
      "ADMIN_REQUEST_INVALID",
      400,
      "Request body must be a JSON object",
    );
  }
  const revisionId = (body as { revisionId?: unknown }).revisionId;
  if (
    typeof revisionId !== "string" ||
    !/^dset_[0-9a-f]{16}$/.test(revisionId)
  ) {
    throw new DeclarativeAdminError(
      "ADMIN_REQUEST_INVALID",
      400,
      "Request body must contain a stored 'revisionId' (dset_…)",
    );
  }
  return revisionId;
}

const STORE_FAILURE_MESSAGES: Readonly<Record<string, string>> = {
  STORE_IO: "Descriptor revision storage is unavailable",
  STORE_CORRUPT: "Descriptor revision storage is corrupt",
  STORE_TOO_LARGE: "Descriptor revision storage is full",
  STORE_DUPLICATE: "The descriptor revision already exists",
  STORE_STATE_INVALID: "The descriptor revision is not in a valid state",
  STORE_LIMIT_EXCEEDED: "Descriptor revision limit reached for this contract",
  STORE_NOT_FOUND: "The descriptor revision was not found",
};

function mapStoreFailure(error: unknown): DeclarativeAdminError {
  if (error instanceof DeclarativeAdminError) return error;
  if (error instanceof DescriptorStoreError) {
    const status =
      error.code === "STORE_NOT_FOUND"
        ? 404
        : error.code === "STORE_TOO_LARGE"
          ? 413
          : error.code === "STORE_DUPLICATE" ||
              error.code === "STORE_STATE_INVALID" ||
              error.code === "STORE_LIMIT_EXCEEDED"
            ? 409
            : 500;
    const code =
      error.code === "STORE_NOT_FOUND"
        ? "ADMIN_REVISION_UNKNOWN"
        : status === 409
          ? "ADMIN_REVISION_CONFLICT"
          : "ADMIN_STORE_FAILURE";
    return new DeclarativeAdminError(
      code,
      status,
      STORE_FAILURE_MESSAGES[error.code] ??
        "Descriptor revision storage failed",
    );
  }
  return new DeclarativeAdminError(
    "ADMIN_STORE_FAILURE",
    500,
    "Descriptor revision storage failed",
  );
}

function describeFailure(error: unknown): string {
  if (error instanceof DescriptorStoreError) return error.code;
  if (error instanceof GatewayError) return error.code;
  if (error instanceof DeclarativeDescriptorError) return error.code;
  if (error instanceof DeclarativeAdminError) return error.code;
  return error instanceof Error ? error.name : "unknown";
}

function jsonResponse(
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...SECURITY_HEADERS,
      ...headers,
    },
  });
}

function errorJsonResponse(error: DeclarativeAdminError): Response {
  const issues: readonly DeclarativeDescriptorIssue[] = error.issues;
  return jsonResponse(
    error.status,
    {
      error: {
        code: error.code,
        message: error.message,
        ...(issues.length === 0 ? {} : { issues }),
      },
    },
    error.allow.length === 0 ? {} : { allow: error.allow.join(", ") },
  );
}

function htmlResponse(html: string): Response {
  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      ...UI_HEADERS,
    },
  });
}

function assetResponse(name: "app.js" | "app.css", content: string): Response {
  return new Response(content, {
    status: 200,
    headers: {
      "content-type":
        name === "app.js"
          ? "text/javascript; charset=utf-8"
          : "text/css; charset=utf-8",
      ...UI_HEADERS,
    },
  });
}

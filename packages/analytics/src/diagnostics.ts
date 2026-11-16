import type { FieldSelection } from "@chainmcp/core";
import type { TelemetryEvent } from "@chainmcp/storage";

export type OptimizationHintCategory =
  "token_bloat" | "cache_opportunity" | "slow_upstream" | "error_rate";

export type OptimizationHintSeverity = "info" | "warning" | "critical";

export type OptimizationHintAction =
  | "configure_projection"
  | "configure_cache"
  | "configure_timeout"
  | "curate_tool";

export interface ToolDiagnosticDescriptor {
  contractName: string;
  name: string;
  method?: string | undefined;
  requestMethod?: string | undefined;
  policy?:
    | {
        cacheTtlSeconds?: number | undefined;
        maxOutputTokens?: number | undefined;
        outputFields?: FieldSelection | undefined;
        timeoutMs?: number | undefined;
      }
    | undefined;
  inputSchema?: Record<string, unknown> | undefined;
  outputProperties?: string[] | undefined;
}

export interface OptimizationHint {
  id: string;
  category: OptimizationHintCategory;
  severity: OptimizationHintSeverity;
  contractName: string;
  toolName: string;
  title: string;
  message: string;
  evidence: {
    requestCount: number;
    totalTokens?: number | undefined;
    avgTokens?: number | undefined;
    peakTokens?: number | undefined;
    cacheHitRatio?: number | undefined;
    avgDurationMs?: number | undefined;
    p95DurationMs?: number | undefined;
    errorRate?: number | undefined;
    observedKeys?: string[] | undefined;
  };
  recommendation: {
    action: OptimizationHintAction;
    suggestedOutputFields?: FieldSelection | undefined;
    suggestedMaxTokens?: number | undefined;
    suggestedCacheTtlSeconds?: number | undefined;
    suggestedTimeoutMs?: number | undefined;
    estimatedTokenSavingsPercent?: number | undefined;
  };
}

export interface DiagnosticReportSummary {
  totalHints: number;
  tokenBloatHints: number;
  cacheOpportunityHints: number;
  slowUpstreamHints: number;
  errorRateHints: number;
  potentialTokenSavingsPercent: number;
}

export interface DiagnosticReport {
  timestamp: number;
  tenantId?: string | undefined;
  windowMs: number;
  totalEventsAnalyzed: number;
  summary: DiagnosticReportSummary;
  hints: OptimizationHint[];
}

export interface DiagnosticAnalyzerOptions {
  /** Min tokens/call to trigger a token bloat hint. Defaults to 800. */
  tokenBloatThreshold?: number | undefined;
  /** Latency threshold in ms for p95 slow upstream. Defaults to 1500. */
  slowUpstreamThresholdMs?: number | undefined;
  /** Error rate threshold (0..1) to flag errors. Defaults to 0.05 (5%). */
  errorRateThreshold?: number | undefined;
  /** Min requests required before flagging cache opportunity. Defaults to 5. */
  minCacheOpportunityRequests?: number | undefined;
  /** Cache hit ratio threshold under which to suggest caching. Defaults to 0.1 (10%). */
  cacheHitRatioThreshold?: number | undefined;
  /** Default cache TTL to recommend in seconds. Defaults to 120. */
  recommendedCacheTtlSeconds?: number | undefined;
  /** Active descriptors for the contracts being diagnosed. */
  descriptors?: readonly ToolDiagnosticDescriptor[] | undefined;
  /** Anchor timestamp for diagnostics. Defaults to Date.now(). */
  now?: number | undefined;
  /** Lookback window in milliseconds. Defaults to 3,600,000 (1 hour). */
  windowMs?: number | undefined;
  /** Tenant filter. */
  tenantId?: string | undefined;
}

const COMMON_VERBOSE_KEYS = [
  "debug",
  "trace",
  "stack",
  "rawResponse",
  "rawHtml",
  "metadata",
  "headers",
  "internal",
  "logs",
  "session",
  "extendedHistory",
  "auditLog",
  "telemetry",
];

const COMMON_ESSENTIAL_KEYS = [
  "id",
  "userId",
  "name",
  "title",
  "status",
  "email",
  "items",
  "data",
  "results",
];

/**
 * Analyzes telemetry events and active contract tool descriptors to generate
 * actionable optimization recommendations (token bloat, cache opportunities, slow upstreams, error rates).
 */
export function analyzeTelemetryDiagnostics(
  events: readonly TelemetryEvent[],
  options: DiagnosticAnalyzerOptions = {},
): DiagnosticReport {
  const now = options.now ?? Date.now();
  const windowMs = options.windowMs ?? 3_600_000;
  const tokenBloatThreshold = options.tokenBloatThreshold ?? 800;
  const slowUpstreamThresholdMs = options.slowUpstreamThresholdMs ?? 1500;
  const errorRateThreshold = options.errorRateThreshold ?? 0.05;
  const minCacheOpportunityRequests = options.minCacheOpportunityRequests ?? 5;
  const cacheHitRatioThreshold = options.cacheHitRatioThreshold ?? 0.1;
  const recommendedCacheTtlSeconds = options.recommendedCacheTtlSeconds ?? 120;

  // Build descriptor lookup map by toolName
  const descriptorMap = new Map<string, ToolDiagnosticDescriptor>();
  if (options.descriptors) {
    for (const desc of options.descriptors) {
      descriptorMap.set(desc.name, desc);
    }
  }

  // Filter events within time window and tenant if specified
  const filteredEvents = events.filter((e) => {
    if (options.tenantId && e.tenantId && e.tenantId !== options.tenantId) {
      return false;
    }
    if (e.timestamp < now - windowMs || e.timestamp > now) {
      return false;
    }
    return true;
  });

  // Group events by toolName
  interface ToolStats {
    toolName: string;
    contractName: string;
    requests: number;
    errors: number;
    cached: number;
    totalTokens: number;
    tokenCounts: number[];
    durations: number[];
    observedKeys: Set<string>;
  }

  const statsMap = new Map<string, ToolStats>();

  for (const event of filteredEvents) {
    const toolName = event.toolName || "unknown";
    let stats = statsMap.get(toolName);
    if (!stats) {
      const desc = descriptorMap.get(toolName);
      stats = {
        toolName,
        contractName: desc?.contractName ?? "default",
        requests: 0,
        errors: 0,
        cached: 0,
        totalTokens: 0,
        tokenCounts: [],
        durations: [],
        observedKeys: new Set<string>(),
      };
      statsMap.set(toolName, stats);
    }

    stats.requests++;
    if (event.isError) stats.errors++;
    if (event.cached) stats.cached++;
    if (typeof event.tokenCount === "number" && event.tokenCount > 0) {
      stats.totalTokens += event.tokenCount;
      stats.tokenCounts.push(event.tokenCount);
    }
    if (typeof event.durationMs === "number" && event.durationMs >= 0) {
      stats.durations.push(event.durationMs);
    }

    // Inspect metadata for observed payload keys
    if (event.metadata) {
      const keys =
        event.metadata["observedKeys"] ??
        event.metadata["fields"] ??
        event.metadata["properties"];
      if (Array.isArray(keys)) {
        for (const k of keys) {
          if (typeof k === "string") stats.observedKeys.add(k);
        }
      }
    }
  }

  // Also include tools from descriptors even if they had 0 invocations (for completeness if requested)
  if (options.descriptors) {
    for (const desc of options.descriptors) {
      if (!statsMap.has(desc.name)) {
        statsMap.set(desc.name, {
          toolName: desc.name,
          contractName: desc.contractName,
          requests: 0,
          errors: 0,
          cached: 0,
          totalTokens: 0,
          tokenCounts: [],
          durations: [],
          observedKeys: new Set<string>(desc.outputProperties ?? []),
        });
      }
    }
  }

  const hints: OptimizationHint[] = [];
  let tokenSavingsAccumulator = 0;
  let tokenSavingsCount = 0;

  for (const [toolName, stats] of statsMap.entries()) {
    if (toolName === "unknown" || stats.requests === 0) continue;

    const desc = descriptorMap.get(toolName);
    const method = desc?.requestMethod ?? desc?.method?.toUpperCase() ?? "GET";
    const isMutation = ["POST", "PUT", "PATCH", "DELETE"].includes(method);

    const avgTokens =
      stats.tokenCounts.length > 0
        ? Math.round(stats.totalTokens / stats.tokenCounts.length)
        : 0;
    const peakTokens =
      stats.tokenCounts.length > 0 ? Math.max(...stats.tokenCounts) : 0;

    stats.durations.sort((a, b) => a - b);
    const p95DurationMs =
      stats.durations.length > 0
        ? stats.durations[
            Math.min(
              Math.ceil(stats.durations.length * 0.95) - 1,
              stats.durations.length - 1,
            )
          ]!
        : 0;
    const avgDurationMs =
      stats.durations.length > 0
        ? Math.round(
            stats.durations.reduce((a, b) => a + b, 0) / stats.durations.length,
          )
        : 0;

    const cacheHitRatio =
      stats.requests > 0
        ? Math.round((stats.cached / stats.requests) * 1000) / 1000
        : 0;
    const errorRate =
      stats.requests > 0
        ? Math.round((stats.errors / stats.requests) * 1000) / 1000
        : 0;

    const observedKeys = Array.from(stats.observedKeys);
    if (observedKeys.length === 0 && desc?.outputProperties) {
      observedKeys.push(...desc.outputProperties);
    }

    // 1. Token Bloat Analysis
    const hasOutputFields =
      Boolean(desc?.policy?.outputFields?.include?.length) ||
      Boolean(desc?.policy?.outputFields?.exclude?.length);

    if (avgTokens >= tokenBloatThreshold && !hasOutputFields) {
      const verboseFound = observedKeys.filter((k) =>
        COMMON_VERBOSE_KEYS.includes(k),
      );
      let suggestedProjection: FieldSelection | undefined;
      let estimatedSavings = 50;

      if (verboseFound.length > 0) {
        suggestedProjection = { exclude: verboseFound };
        estimatedSavings = Math.min(75, 40 + verboseFound.length * 10);
      } else if (observedKeys.length > 4) {
        const essentials = observedKeys.filter((k) =>
          COMMON_ESSENTIAL_KEYS.includes(k),
        );
        const includeList =
          essentials.length > 0 ? essentials : observedKeys.slice(0, 3);
        suggestedProjection = { include: includeList };
        estimatedSavings = 65;
      }

      const suggestedMaxTokens = Math.max(250, Math.round(avgTokens * 0.5));
      tokenSavingsAccumulator += estimatedSavings;
      tokenSavingsCount++;

      hints.push({
        id: `hint_token_bloat_${stats.contractName}_${toolName}`,
        category: "token_bloat",
        severity: avgTokens >= tokenBloatThreshold * 2 ? "critical" : "warning",
        contractName: stats.contractName,
        toolName,
        title: `Bloated tool output on '${toolName}' (${avgTokens} avg tokens/call)`,
        message:
          `Tool '${toolName}' returns on average ${avgTokens} tokens per invocation across ${stats.requests} requests. ` +
          `Configuring field projection or maxOutputTokens can reduce LLM context overhead by up to ${estimatedSavings}%.`,
        evidence: {
          requestCount: stats.requests,
          totalTokens: stats.totalTokens,
          avgTokens,
          peakTokens,
          observedKeys: observedKeys.length > 0 ? observedKeys : undefined,
        },
        recommendation: {
          action: "configure_projection",
          suggestedOutputFields: suggestedProjection,
          suggestedMaxTokens,
          estimatedTokenSavingsPercent: estimatedSavings,
        },
      });
    }

    // 2. Cache Opportunity Analysis (STRICT: Never suggest caching on mutations!)
    const currentTtl = desc?.policy?.cacheTtlSeconds ?? 0;
    if (
      !isMutation &&
      currentTtl === 0 &&
      stats.requests >= minCacheOpportunityRequests &&
      cacheHitRatio <= cacheHitRatioThreshold
    ) {
      hints.push({
        id: `hint_cache_opp_${stats.contractName}_${toolName}`,
        category: "cache_opportunity",
        severity: stats.requests >= 20 ? "warning" : "info",
        contractName: stats.contractName,
        toolName,
        title: `Frequent uncached calls to read tool '${toolName}' (${stats.requests} calls)`,
        message:
          `Tool '${toolName}' is an idempotent ${method} endpoint called ${stats.requests} times with low cache utilization (${Math.round(cacheHitRatio * 100)}% hits). ` +
          `Setting cacheTtlSeconds to ${recommendedCacheTtlSeconds}s can eliminate duplicate upstream requests and lower latency.`,
        evidence: {
          requestCount: stats.requests,
          cacheHitRatio,
          avgDurationMs,
        },
        recommendation: {
          action: "configure_cache",
          suggestedCacheTtlSeconds: recommendedCacheTtlSeconds,
        },
      });
    }

    // 3. Slow Upstream Analysis
    if (
      stats.durations.length >= 3 &&
      p95DurationMs >= slowUpstreamThresholdMs
    ) {
      const suggestedTimeout = Math.ceil((p95DurationMs * 1.5) / 500) * 500;
      hints.push({
        id: `hint_slow_upstream_${stats.contractName}_${toolName}`,
        category: "slow_upstream",
        severity:
          p95DurationMs >= slowUpstreamThresholdMs * 2 ? "critical" : "warning",
        contractName: stats.contractName,
        toolName,
        title: `Slow upstream latency on '${toolName}' (p95: ${p95DurationMs}ms)`,
        message:
          `Upstream response time for '${toolName}' has p95 latency of ${p95DurationMs}ms (avg ${avgDurationMs}ms). ` +
          `Configure timeoutMs or caching to prevent agent stalls.`,
        evidence: {
          requestCount: stats.requests,
          p95DurationMs,
          avgDurationMs,
        },
        recommendation: {
          action: "configure_timeout",
          suggestedTimeoutMs: suggestedTimeout,
        },
      });
    }

    // 4. Elevated Error Rate Analysis
    if (stats.requests >= 5 && errorRate >= errorRateThreshold) {
      hints.push({
        id: `hint_error_rate_${stats.contractName}_${toolName}`,
        category: "error_rate",
        severity: errorRate >= 0.25 ? "critical" : "warning",
        contractName: stats.contractName,
        toolName,
        title: `Elevated error rate on '${toolName}' (${Math.round(errorRate * 100)}% failed)`,
        message:
          `Tool '${toolName}' failed ${stats.errors} out of ${stats.requests} requests (${Math.round(errorRate * 100)}% error rate). ` +
          `Investigate upstream failures or consider disabling the tool if broken.`,
        evidence: {
          requestCount: stats.requests,
          errorRate,
        },
        recommendation: {
          action: "curate_tool",
        },
      });
    }
  }

  // Sort hints by severity (critical > warning > info)
  const severityScore: Record<OptimizationHintSeverity, number> = {
    critical: 3,
    warning: 2,
    info: 1,
  };
  hints.sort((a, b) => severityScore[b.severity] - severityScore[a.severity]);

  const tokenBloatHints = hints.filter(
    (h) => h.category === "token_bloat",
  ).length;
  const cacheOpportunityHints = hints.filter(
    (h) => h.category === "cache_opportunity",
  ).length;
  const slowUpstreamHints = hints.filter(
    (h) => h.category === "slow_upstream",
  ).length;
  const errorRateHints = hints.filter(
    (h) => h.category === "error_rate",
  ).length;
  const potentialTokenSavingsPercent =
    tokenSavingsCount > 0
      ? Math.round(tokenSavingsAccumulator / tokenSavingsCount)
      : 0;

  return {
    timestamp: now,
    tenantId: options.tenantId,
    windowMs,
    totalEventsAnalyzed: filteredEvents.length,
    summary: {
      totalHints: hints.length,
      tokenBloatHints,
      cacheOpportunityHints,
      slowUpstreamHints,
      errorRateHints,
      potentialTokenSavingsPercent,
    },
    hints,
  };
}

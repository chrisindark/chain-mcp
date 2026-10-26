import type { MetricsSink, RuntimeEvent } from "@chainmcp/core";

export interface AnalyticsSummary {
  totalInvocations: number;
  successCount: number;
  errorCount: number;
  rateLimitedCount: number;
  cache: {
    hits: number;
    misses: number;
    bypasses: number;
    hitRatio: number;
  };
  tokens: {
    totalTokens: number;
    exactTokens: number;
    estimatedTokens: number;
    totalPayloadBytes: number;
  };
  latency: {
    minMs: number;
    maxMs: number;
    avgMs: number;
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
  };
  byTool: Record<string, { invocations: number; errors: number }>;
  byTenant: Record<string, { invocations: number; errors: number }>;
}

export interface AggregatorOptions {
  /** Maximum number of raw events retained in the window. Defaults to 50,000. */
  maxEvents?: number;
  /** Retention period in milliseconds. Defaults to 14 days (14 * 24 * 3600 * 1000). */
  retentionMs?: number;
}

export class RollingAnalyticsAggregator implements MetricsSink {
  private readonly events: RuntimeEvent[] = [];
  readonly maxEvents: number;
  readonly retentionMs: number;

  constructor(options?: AggregatorOptions) {
    this.maxEvents = Math.max(1, options?.maxEvents ?? 50_000);
    this.retentionMs = Math.max(
      1_000,
      options?.retentionMs ?? 14 * 24 * 60 * 60 * 1_000,
    );
  }

  record(event: RuntimeEvent): void {
    if (this.events.length >= this.maxEvents) {
      this.events.shift();
    }
    this.events.push(event);
    this.prune();
  }

  private prune(): void {
    const cutoff = Date.now() - this.retentionMs;
    while (this.events.length > 0) {
      const first = this.events[0];
      if (first !== undefined && first.timestamp < cutoff) {
        this.events.shift();
      } else {
        break;
      }
    }
  }

  getSummary(filter?: {
    toolName?: string;
    tenantId?: string;
  }): AnalyticsSummary {
    this.prune();

    const filtered = this.events.filter((e) => {
      if (filter?.toolName && e.toolName !== filter.toolName) return false;
      if (filter?.tenantId && e.tenantId !== filter.tenantId) return false;
      return true;
    });

    let successCount = 0;
    let errorCount = 0;
    let rateLimitedCount = 0;
    let cacheHits = 0;
    let cacheMisses = 0;
    let cacheBypasses = 0;
    let totalTokens = 0;
    let exactTokens = 0;
    let estimatedTokens = 0;
    let totalPayloadBytes = 0;

    const durations: number[] = [];
    const byTool: Record<string, { invocations: number; errors: number }> = {};
    const byTenant: Record<string, { invocations: number; errors: number }> =
      {};

    for (const event of filtered) {
      durations.push(event.durationMs);

      // Tool breakdown
      if (!byTool[event.toolName]) {
        byTool[event.toolName] = { invocations: 0, errors: 0 };
      }
      byTool[event.toolName]!.invocations++;

      // Tenant breakdown
      if (!byTenant[event.tenantId]) {
        byTenant[event.tenantId] = { invocations: 0, errors: 0 };
      }
      byTenant[event.tenantId]!.invocations++;

      if (event.outcome === "success") {
        successCount++;
      } else if (event.outcome === "rate_limited") {
        rateLimitedCount++;
      } else {
        errorCount++;
        byTool[event.toolName]!.errors++;
        byTenant[event.tenantId]!.errors++;
      }

      if (event.cacheOutcome === "hit") cacheHits++;
      else if (event.cacheOutcome === "miss") cacheMisses++;
      else if (event.cacheOutcome === "bypass") cacheBypasses++;

      if (event.tokenUsage) {
        totalTokens += event.tokenUsage.count;
        if (event.tokenUsage.measurement === "exact") {
          exactTokens += event.tokenUsage.count;
        } else {
          estimatedTokens += event.tokenUsage.count;
        }
        totalPayloadBytes += event.tokenUsage.payloadBytes;
      }
    }

    const totalEligible = cacheHits + cacheMisses;
    const hitRatio = totalEligible > 0 ? cacheHits / totalEligible : 0;

    durations.sort((a, b) => a - b);
    const count = durations.length;
    const minMs = count > 0 ? durations[0]! : 0;
    const maxMs = count > 0 ? durations[count - 1]! : 0;
    const sum = durations.reduce((acc, d) => acc + d, 0);
    const avgMs = count > 0 ? sum / count : 0;

    function getPercentile(p: number): number {
      if (count === 0) return 0;
      const idx = Math.min(Math.floor((p / 100) * count), count - 1);
      return durations[idx] ?? 0;
    }

    return {
      totalInvocations: filtered.length,
      successCount,
      errorCount,
      rateLimitedCount,
      cache: {
        hits: cacheHits,
        misses: cacheMisses,
        bypasses: cacheBypasses,
        hitRatio,
      },
      tokens: {
        totalTokens,
        exactTokens,
        estimatedTokens,
        totalPayloadBytes,
      },
      latency: {
        minMs,
        maxMs,
        avgMs,
        p50Ms: getPercentile(50),
        p95Ms: getPercentile(95),
        p99Ms: getPercentile(99),
      },
      byTool,
      byTenant,
    };
  }

  clear(): void {
    this.events.length = 0;
  }
}

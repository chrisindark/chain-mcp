import type { TelemetryEvent } from "@chainmcp/storage";
import { describe, expect, it } from "vitest";

import {
  analyzeTelemetryDiagnostics,
  type ToolDiagnosticDescriptor,
} from "../src/index.js";

describe("analyzeTelemetryDiagnostics (M14-3)", () => {
  const baseNow = 1_700_000_000_000;

  it("detects token bloat on tools without projection and suggests concrete field exclusions for verbose keys", () => {
    const descriptors: ToolDiagnosticDescriptor[] = [
      {
        contractName: "customers-api",
        name: "get_customer",
        method: "GET",
      },
    ];

    const events: TelemetryEvent[] = Array.from({ length: 10 }, (_, i) => ({
      id: `evt-${i}`,
      timestamp: baseNow - 60_000 * i,
      toolName: "get_customer",
      tokenCount: 1500,
      durationMs: 120,
      metadata: {
        observedKeys: ["id", "name", "email", "debug", "trace", "rawResponse"],
      },
    }));

    const report = analyzeTelemetryDiagnostics(events, {
      now: baseNow,
      descriptors,
      tokenBloatThreshold: 800,
    });

    expect(report.summary.totalHints).toBeGreaterThanOrEqual(1);
    expect(report.summary.tokenBloatHints).toBe(1);

    const bloatHint = report.hints.find((h) => h.category === "token_bloat")!;
    expect(bloatHint).toBeDefined();
    expect(bloatHint.toolName).toBe("get_customer");
    expect(bloatHint.severity).toBe("warning");
    expect(bloatHint.evidence.avgTokens).toBe(1500);
    expect(bloatHint.recommendation.action).toBe("configure_projection");
    expect(bloatHint.recommendation.suggestedOutputFields).toEqual({
      exclude: ["debug", "trace", "rawResponse"],
    });
    expect(
      bloatHint.recommendation.estimatedTokenSavingsPercent,
    ).toBeGreaterThanOrEqual(50);
  });

  it("suggests field inclusion when payload has many fields without known verbose markers", () => {
    const descriptors: ToolDiagnosticDescriptor[] = [
      {
        contractName: "products-api",
        name: "list_products",
        method: "GET",
        outputProperties: [
          "id",
          "name",
          "category",
          "sku",
          "inventoryLevel",
          "warehouseLocation",
          "supplierNotes",
        ],
      },
    ];

    const events: TelemetryEvent[] = Array.from({ length: 5 }, (_, i) => ({
      id: `evt-${i}`,
      timestamp: baseNow - 10_000 * i,
      toolName: "list_products",
      tokenCount: 2200,
      durationMs: 80,
    }));

    const report = analyzeTelemetryDiagnostics(events, {
      now: baseNow,
      descriptors,
      tokenBloatThreshold: 800,
    });

    const bloatHint = report.hints.find((h) => h.category === "token_bloat")!;
    expect(bloatHint.severity).toBe("critical");
    expect(bloatHint.recommendation.suggestedOutputFields).toEqual({
      include: ["id", "name"],
    });
  });

  it("SECURITY BOUNDARY: NEVER recommends cache on mutation methods (POST, PUT, PATCH, DELETE)", () => {
    const descriptors: ToolDiagnosticDescriptor[] = [
      {
        contractName: "orders-api",
        name: "create_order",
        method: "POST",
      },
      {
        contractName: "orders-api",
        name: "update_order",
        method: "PUT",
      },
      {
        contractName: "orders-api",
        name: "patch_order",
        method: "PATCH",
      },
      {
        contractName: "orders-api",
        name: "cancel_order",
        method: "DELETE",
      },
    ];

    // High volume, zero cache hits on all mutation tools
    const events: TelemetryEvent[] = [];
    for (const d of descriptors) {
      for (let i = 0; i < 20; i++) {
        events.push({
          id: `evt-${d.name}-${i}`,
          timestamp: baseNow - 5_000 * i,
          toolName: d.name,
          durationMs: 50,
          cached: false,
          tokenCount: 100,
        });
      }
    }

    const report = analyzeTelemetryDiagnostics(events, {
      now: baseNow,
      descriptors,
      minCacheOpportunityRequests: 5,
    });

    const cacheHints = report.hints.filter(
      (h) => h.category === "cache_opportunity",
    );
    expect(cacheHints).toHaveLength(0);
  });

  it("recommends cache on high-frequency read tools (GET) without cache TTL configured", () => {
    const descriptors: ToolDiagnosticDescriptor[] = [
      {
        contractName: "users-api",
        name: "get_user",
        method: "GET",
        policy: { cacheTtlSeconds: 0 },
      },
    ];

    const events: TelemetryEvent[] = Array.from({ length: 25 }, (_, i) => ({
      id: `evt-${i}`,
      timestamp: baseNow - 2_000 * i,
      toolName: "get_user",
      durationMs: 150,
      cached: false,
      tokenCount: 200,
    }));

    const report = analyzeTelemetryDiagnostics(events, {
      now: baseNow,
      descriptors,
      minCacheOpportunityRequests: 10,
      recommendedCacheTtlSeconds: 180,
    });

    expect(report.summary.cacheOpportunityHints).toBe(1);
    const hint = report.hints.find((h) => h.category === "cache_opportunity")!;
    expect(hint.toolName).toBe("get_user");
    expect(hint.recommendation.action).toBe("configure_cache");
    expect(hint.recommendation.suggestedCacheTtlSeconds).toBe(180);
  });

  it("detects slow upstreams (p95 latency) and recommends timeoutMs configuration", () => {
    const descriptors: ToolDiagnosticDescriptor[] = [
      {
        contractName: "payments-api",
        name: "charge_payment",
        method: "POST",
      },
    ];

    const events: TelemetryEvent[] = [
      {
        id: "1",
        timestamp: baseNow - 1000,
        toolName: "charge_payment",
        durationMs: 2500,
      },
      {
        id: "2",
        timestamp: baseNow - 2000,
        toolName: "charge_payment",
        durationMs: 3200,
      },
      {
        id: "3",
        timestamp: baseNow - 3000,
        toolName: "charge_payment",
        durationMs: 4000,
      },
    ];

    const report = analyzeTelemetryDiagnostics(events, {
      now: baseNow,
      descriptors,
      slowUpstreamThresholdMs: 2000,
    });

    expect(report.summary.slowUpstreamHints).toBe(1);
    const hint = report.hints.find((h) => h.category === "slow_upstream")!;
    expect(hint.severity).toBe("critical");
    expect(hint.evidence.p95DurationMs).toBeGreaterThanOrEqual(3200);
    expect(hint.recommendation.action).toBe("configure_timeout");
    expect(hint.recommendation.suggestedTimeoutMs).toBeGreaterThanOrEqual(4000);
  });

  it("detects elevated error rates and flags tools for curation or remediation", () => {
    const descriptors: ToolDiagnosticDescriptor[] = [
      {
        contractName: "inventory-api",
        name: "check_stock",
        method: "GET",
      },
    ];

    const events: TelemetryEvent[] = Array.from({ length: 10 }, (_, i) => ({
      id: `evt-${i}`,
      timestamp: baseNow - 1000 * i,
      toolName: "check_stock",
      isError: i < 4, // 40% error rate
      durationMs: 50,
    }));

    const report = analyzeTelemetryDiagnostics(events, {
      now: baseNow,
      descriptors,
      errorRateThreshold: 0.1,
    });

    expect(report.summary.errorRateHints).toBe(1);
    const hint = report.hints.find((h) => h.category === "error_rate")!;
    expect(hint.severity).toBe("critical");
    expect(hint.evidence.errorRate).toBe(0.4);
    expect(hint.recommendation.action).toBe("curate_tool");
  });

  it("respects tenantId filter and windowMs time boundary", () => {
    const events: TelemetryEvent[] = [
      // In window, tenant-a
      {
        id: "1",
        timestamp: baseNow - 5_000,
        tenantId: "tenant-a",
        toolName: "tool_a",
        tokenCount: 1500,
      },
      // In window, tenant-b
      {
        id: "2",
        timestamp: baseNow - 5_000,
        tenantId: "tenant-b",
        toolName: "tool_b",
        tokenCount: 1500,
      },
      // Outside window (older than 10s)
      {
        id: "3",
        timestamp: baseNow - 20_000,
        tenantId: "tenant-a",
        toolName: "tool_a",
        tokenCount: 2000,
      },
    ];

    const report = analyzeTelemetryDiagnostics(events, {
      now: baseNow,
      windowMs: 10_000,
      tenantId: "tenant-a",
    });

    expect(report.totalEventsAnalyzed).toBe(1);
    expect(report.hints).toHaveLength(1);
    expect(report.hints[0]!.toolName).toBe("tool_a");
  });
});

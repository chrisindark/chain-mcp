import { createHash } from "node:crypto";
import {
  type Authorizer,
  InMemoryToolRuntime,
  type ToolContext,
  type ToolContextFactory,
  type ToolDefinition,
  type ToolRuntime,
  type ToolSource,
} from "@chainmcp/core";
import { OperationScopeAuthorizer } from "@chainmcp/auth";
import { compileOpenApi } from "@chainmcp/compiler";
import { createUpstreamExecutor } from "@chainmcp/executor";
import { ContractRegistry } from "./registry.js";
import {
  type ContractRevision,
  type DynamicGatewayOptions,
  GatewayError,
  type GatewayAuditEvent,
  type PublishContractOptions,
  type ToolSummary,
} from "./types.js";

/** Simple asynchronous mutex ensuring atomic sequential revision updates. */
class AsyncMutex {
  private queue = Promise.resolve();

  async runExclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    const res = this.queue.then(() => fn());
    this.queue = res.then(
      () => {},
      () => {},
    );
    return res;
  }
}

export class DynamicGateway implements ToolRuntime {
  public readonly tenantMode = "multi-tenant" as const;
  private readonly registry: ContractRegistry;
  private readonly options: DynamicGatewayOptions;
  private readonly mutex = new AsyncMutex();
  private readonly toolChangeListeners = new Set<() => void | Promise<void>>();
  private activeRuntime: InMemoryToolRuntime;

  constructor(options: DynamicGatewayOptions = {}) {
    this.options = options;
    this.registry = new ContractRegistry();
    this.activeRuntime = this.buildEmptyRuntime();
    if (options.onToolsChanged) {
      this.toolChangeListeners.add(options.onToolsChanged);
    }
  }

  getRegistry(): ContractRegistry {
    return this.registry;
  }

  /**
   * Registers a listener invoked whenever active tools change across any tenant
   * (via contract publication, activation, disabling, or rollback).
   * Returns an unsubscribe function.
   */
  onToolsChanged(listener: () => void | Promise<void>): () => void {
    if (typeof listener !== "function") {
      throw new TypeError("listener must be a function");
    }
    this.toolChangeListeners.add(listener);
    return () => {
      this.toolChangeListeners.delete(listener);
    };
  }

  private async notifyToolsChanged(): Promise<void> {
    for (const listener of this.toolChangeListeners) {
      try {
        await listener();
      } catch {
        // Notification listeners must not interrupt runtime operations
      }
    }
  }

  /**
   * Publishes a new contract revision. Compiles in isolation, validates
   * destination allowlist and tools, registers the candidate revision, and
   * atomically activates it if autoActivate is true (the default).
   */
  async publishContract(
    options: PublishContractOptions,
  ): Promise<ContractRevision> {
    return this.mutex.runExclusive(async () => {
      let tools: readonly ToolDefinition[];
      let sourceHash: string;

      if (options.source !== undefined) {
        if (typeof options.source !== "string" || options.source.length === 0) {
          throw new GatewayError(
            "COMPILATION_FAILED",
            "Contract source must be a non-empty string",
          );
        }

        const compileResult = compileOpenApi(options.source, { strict: true });
        if (
          compileResult.diagnostics.some((d) => d.severity === "error") ||
          compileResult.tools.length === 0
        ) {
          const errors = compileResult.diagnostics
            .filter((d) => d.severity === "error")
            .map((d) => d.message)
            .join("; ");
          throw new GatewayError(
            "COMPILATION_FAILED",
            `Failed to compile OpenAPI contract for '${options.contractName}': ${errors || "No valid operations found"}`,
          );
        }

        sourceHash = compileResult.sourceHash;

        // Build tools using UpstreamExecutor bound to this contract's network and auth policy
        const executor = createUpstreamExecutor({
          baseUrl: options.destinationPolicy.baseUrl,
          allowedHosts: options.destinationPolicy.allowedHosts,
          ...(options.destinationPolicy.allowInsecureHttp !== undefined
            ? { allowInsecureHttp: options.destinationPolicy.allowInsecureHttp }
            : {}),
          ...(options.limits?.maxResponseBytes !== undefined
            ? { maxResponseBytes: options.limits.maxResponseBytes }
            : {}),
          ...(options.limits?.maxRequestBytes !== undefined
            ? { maxRequestBytes: options.limits.maxRequestBytes }
            : {}),
          ...(options.limits?.maxRedirects !== undefined
            ? { maxRedirects: options.limits.maxRedirects }
            : {}),
          ...(options.limits?.timeoutMs !== undefined
            ? { timeoutMs: options.limits.timeoutMs }
            : {}),
          ownerTenantId: options.tenantId,
          ...(this.options.resolveHost
            ? { resolveHost: this.options.resolveHost }
            : {}),
          ...(this.options.transport
            ? { transport: this.options.transport }
            : {}),
          ...(options.authConfig?.credentialProvider
            ? { credentialProvider: options.authConfig.credentialProvider }
            : {}),
        });

        tools = executor.createTools(compileResult.tools);
      } else if (options.tools !== undefined) {
        if (!Array.isArray(options.tools) || options.tools.length === 0) {
          throw new GatewayError(
            "POLICY_VIOLATION",
            "Contract tools must be a non-empty array",
          );
        }
        tools = options.tools;
        sourceHash = createHash("sha256")
          .update(
            options.tools
              .map(
                (t) =>
                  `${t.name}:${t.description ?? ""}:${JSON.stringify(t.inputSchema)}`,
              )
              .join(";"),
          )
          .digest("hex");
      } else {
        throw new GatewayError(
          "POLICY_VIOLATION",
          "Either 'source' or 'tools' must be supplied when publishing a contract",
        );
      }

      // If contract specifies requiredScopes in authConfig, merge into each tool's requiredScopes
      if (
        options.authConfig?.requiredScopes &&
        options.authConfig.requiredScopes.length > 0
      ) {
        const extraScopes = options.authConfig.requiredScopes;
        tools = tools.map((t) => ({
          ...t,
          operation: {
            ...t.operation,
            requiredScopes: [
              ...new Set([
                ...(t.operation?.requiredScopes ?? []),
                ...extraScopes,
              ]),
            ],
          },
        }));
      }

      const candidate = this.registry.createRevision({
        tenantId: options.tenantId,
        contractName: options.contractName,
        sourceHash,
        tools,
        destinationPolicy: options.destinationPolicy,
        ...(options.authConfig !== undefined
          ? { authConfig: options.authConfig }
          : {}),
        ...(options.limits !== undefined ? { limits: options.limits } : {}),
        ...(options.metadata !== undefined
          ? { metadata: options.metadata }
          : {}),
        ...(this.options.now !== undefined ? { now: this.options.now } : {}),
      });

      await this.emitAudit({
        type: "contract_published",
        timestamp: this.now(),
        tenantId: options.tenantId,
        contractName: options.contractName,
        revisionId: candidate.revisionId,
        toolCount: candidate.tools.length,
        details: {
          sourceHash: candidate.sourceHash,
          baseUrl: candidate.destinationPolicy.baseUrl,
          allowedHosts: [...candidate.destinationPolicy.allowedHosts],
        },
      });

      if (options.autoActivate !== false) {
        const { activatedRevision, previousRevision } =
          this.registry.activateRevision(
            options.tenantId,
            options.contractName,
            candidate.revisionId,
          );

        this.rebuildActiveRuntime();

        await this.emitAudit({
          type: "contract_activated",
          timestamp: this.now(),
          tenantId: options.tenantId,
          contractName: options.contractName,
          revisionId: activatedRevision.revisionId,
          ...(previousRevision?.revisionId !== undefined
            ? { previousRevisionId: previousRevision.revisionId }
            : {}),
          toolCount: activatedRevision.tools.length,
        });

        await this.notifyToolsChanged();

        return activatedRevision;
      }

      return candidate;
    });
  }

  /**
   * Atomically activates a candidate or superseded revision.
   */
  async activateRevision(
    tenantId: string,
    contractName: string,
    revisionId: string,
  ): Promise<ContractRevision> {
    return this.mutex.runExclusive(async () => {
      const { activatedRevision, previousRevision } =
        this.registry.activateRevision(tenantId, contractName, revisionId);

      this.rebuildActiveRuntime();

      await this.emitAudit({
        type: "contract_activated",
        timestamp: this.now(),
        tenantId,
        contractName,
        revisionId: activatedRevision.revisionId,
        ...(previousRevision?.revisionId !== undefined
          ? { previousRevisionId: previousRevision.revisionId }
          : {}),
        toolCount: activatedRevision.tools.length,
      });

      await this.notifyToolsChanged();

      return activatedRevision;
    });
  }

  /**
   * Atomically disables a contract. Its tools become immediately invisible
   * and uncallable to callers.
   */
  async disableContract(
    tenantId: string,
    contractName: string,
  ): Promise<ContractRevision> {
    return this.mutex.runExclusive(async () => {
      const disabledRevision = this.registry.disableRevision(
        tenantId,
        contractName,
      );

      this.rebuildActiveRuntime();

      await this.emitAudit({
        type: "contract_disabled",
        timestamp: this.now(),
        tenantId,
        contractName,
        revisionId: disabledRevision.revisionId,
        toolCount: disabledRevision.tools.length,
      });

      await this.notifyToolsChanged();

      return disabledRevision;
    });
  }

  /**
   * Atomically rolls back a contract to a target revision in its history.
   */
  async rollbackContract(
    tenantId: string,
    contractName: string,
    targetRevisionId: string,
  ): Promise<ContractRevision> {
    return this.mutex.runExclusive(async () => {
      const { reactivatedRevision, rolledBackRevision } =
        this.registry.rollbackRevision(
          tenantId,
          contractName,
          targetRevisionId,
        );

      this.rebuildActiveRuntime();

      await this.emitAudit({
        type: "contract_rolled_back",
        timestamp: this.now(),
        tenantId,
        contractName,
        revisionId: reactivatedRevision.revisionId,
        ...(rolledBackRevision?.revisionId !== undefined
          ? { previousRevisionId: rolledBackRevision.revisionId }
          : {}),
        toolCount: reactivatedRevision.tools.length,
        ...(rolledBackRevision?.revisionId !== undefined
          ? {
              details: {
                rolledBackFromRevisionId: rolledBackRevision.revisionId,
              },
            }
          : {}),
      });

      await this.notifyToolsChanged();

      return reactivatedRevision;
    });
  }

  /**
   * Lists tools scoped strictly to the caller's tenant.
   * Calls without a context fail closed with AUTH_REQUIRED.
   */
  listTools(context?: ToolContext): ReadonlyArray<ToolSummary> {
    return this.activeRuntime.listTools(context);
  }

  /**
   * Invokes a tool scoped to the caller's tenant.
   * Unknown tools or tools of other tenants fail closed with TOOL_NOT_FOUND.
   */
  async callTool(
    name: string,
    input: unknown,
    context: ToolContext | ToolContextFactory,
  ): Promise<unknown> {
    return this.activeRuntime.callTool(name, input, context);
  }

  async invalidateCachedResult(
    name: string,
    input: unknown,
    context: ToolContext,
  ): Promise<void> {
    return this.activeRuntime.invalidateCachedResult?.(name, input, context);
  }

  register(tool: ToolDefinition): void {
    this.activeRuntime.register(tool);
  }

  async registerSource(source: ToolSource): Promise<void> {
    await this.activeRuntime.registerSource?.(source);
  }

  /**
   * Rebuilds an isolated runtime snapshot containing tools from all
   * currently active revisions across all tenants, and atomically swaps it.
   */
  private rebuildActiveRuntime(): void {
    const authorizer: Authorizer =
      this.options.authorizer ?? new OperationScopeAuthorizer();
    const runtime = new InMemoryToolRuntime({
      tenantMode: "multi-tenant",
      authorizer,
      ...(this.options.rateLimiter !== undefined
        ? { rateLimiter: this.options.rateLimiter }
        : {}),
      ...(this.options.cache !== undefined
        ? { cache: this.options.cache }
        : {}),
      ...(this.options.tokenizer !== undefined
        ? { tokenizer: this.options.tokenizer }
        : {}),
      ...(this.options.projector !== undefined
        ? { projector: this.options.projector }
        : {}),
      ...(this.options.metrics !== undefined
        ? { metrics: this.options.metrics }
        : {}),
      ...(this.options.logger !== undefined
        ? { logger: this.options.logger }
        : {}),
      ...(this.options.defaultTimeoutMs !== undefined
        ? { defaultTimeoutMs: this.options.defaultTimeoutMs }
        : {}),
      ...(this.options.now !== undefined ? { now: this.options.now } : {}),
      ...(this.options.monotonicNow !== undefined
        ? { monotonicNow: this.options.monotonicNow }
        : {}),
    });

    const activeRevisions = this.registry.listActiveRevisions();
    for (const revision of activeRevisions) {
      for (const tool of revision.tools) {
        runtime.register(tool);
      }
    }

    // Atomic reference assignment
    this.activeRuntime = runtime;
  }

  private buildEmptyRuntime(): InMemoryToolRuntime {
    const authorizer: Authorizer =
      this.options.authorizer ?? new OperationScopeAuthorizer();
    return new InMemoryToolRuntime({
      tenantMode: "multi-tenant",
      authorizer,
      ...(this.options.rateLimiter !== undefined
        ? { rateLimiter: this.options.rateLimiter }
        : {}),
      ...(this.options.cache !== undefined
        ? { cache: this.options.cache }
        : {}),
      ...(this.options.tokenizer !== undefined
        ? { tokenizer: this.options.tokenizer }
        : {}),
      ...(this.options.projector !== undefined
        ? { projector: this.options.projector }
        : {}),
      ...(this.options.metrics !== undefined
        ? { metrics: this.options.metrics }
        : {}),
      ...(this.options.logger !== undefined
        ? { logger: this.options.logger }
        : {}),
      ...(this.options.defaultTimeoutMs !== undefined
        ? { defaultTimeoutMs: this.options.defaultTimeoutMs }
        : {}),
      ...(this.options.now !== undefined ? { now: this.options.now } : {}),
      ...(this.options.monotonicNow !== undefined
        ? { monotonicNow: this.options.monotonicNow }
        : {}),
    });
  }

  /**
   * Emits a gateway audit event to the configured logger and audit sink.
   */
  async emitAudit(event: GatewayAuditEvent): Promise<void> {
    this.options.logger?.audit?.(`Gateway audit: ${event.type}`, {
      ...event,
      category: "audit",
    });

    if (this.options.auditSink) {
      try {
        await this.options.auditSink(event);
      } catch (err) {
        this.options.logger?.warn("Gateway auditSink invocation failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }
}

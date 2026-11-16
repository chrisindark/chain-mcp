import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";

import { compileOpenApi } from "@chainmcp/compiler";
import {
  assertFieldSelection,
  createFieldProjector,
  RuntimeError,
  type FieldSelection,
  type ToolContext,
  type ToolDefinition,
  type Tokenizer,
} from "@chainmcp/core";
import {
  DeclarativeToolSource,
  type DeclarativeToolDescriptor,
} from "@chainmcp/declarative";
import { createUpstreamExecutor } from "@chainmcp/executor";

import type { DeclarativeAdmin } from "./api.js";
import { evaluateDescriptorSet } from "./evaluate.js";
import type { DeclarativeAdminContractBinding } from "./types.js";

export interface MetaMcpToolsOptions {
  /** Optional principal tokenId or identifier to stamp on audit records and test calls. */
  tokenId?: string | undefined;
  /** Restrict operations to specific tenant(s). Defaults to all tenants configured on the admin. */
  tenants?: string[] | "*" | undefined;
  /** Optional custom tokenizer for token savings metrics. Defaults to admin tokenizer. */
  tokenizer?: Tokenizer | undefined;
  /** Optional file reader for reading OpenAPI specs from disk. */
  readSpecFile?: ((path: string) => Promise<string>) | undefined;
  /**
   * When true, agent mutations (curate, projection, cache, publish, rollback) are
   * created as draft proposals requiring explicit human approval in Web Studio
   * rather than immediately mutating the active gateway runtime.
   */
  requireApproval?: boolean | undefined;
}

function resolveBinding(
  admin: DeclarativeAdmin,
  contractName: string,
  tenantId?: string | undefined,
  options: MetaMcpToolsOptions = {},
): DeclarativeAdminContractBinding {
  const allowed = [...admin.bindings.values()].filter((b) => {
    if (options.tenants && options.tenants !== "*") {
      return options.tenants.includes(b.tenantId);
    }
    return true;
  });

  const matching = allowed.filter((b) => {
    if (b.contractName !== contractName) return false;
    if (tenantId !== undefined && b.tenantId !== tenantId) return false;
    return true;
  });

  if (matching.length === 0) {
    throw new RuntimeError(
      "CONTRACT_INVALID",
      `Contract '${contractName}'${tenantId ? ` for tenant '${tenantId}'` : ""} was not found or is not accessible`,
    );
  }

  if (matching.length > 1) {
    throw new RuntimeError(
      "TENANT_REQUIRED",
      `Multiple contracts match '${contractName}' across tenants (${matching.map((m) => m.tenantId).join(", ")}). Please specify 'tenantId'.`,
    );
  }

  return matching[0]!;
}

async function getActiveDescriptors(
  admin: DeclarativeAdmin,
  binding: DeclarativeAdminContractBinding,
): Promise<readonly DeclarativeToolDescriptor[]> {
  const activeRecord = await admin.store
    .getActive(binding.tenantId, binding.contractName)
    .catch(() => undefined);
  if (activeRecord && activeRecord.descriptors.length > 0) {
    return activeRecord.descriptors;
  }
  const activeGateway = admin.gateway
    .getRegistry()
    .getActiveRevision(binding.tenantId, binding.contractName);
  if (
    activeGateway?.metadata &&
    Array.isArray(activeGateway.metadata.descriptorSet)
  ) {
    return activeGateway.metadata
      .descriptorSet as readonly DeclarativeToolDescriptor[];
  }
  throw new RuntimeError(
    "CONTRACT_INVALID",
    `No active descriptors found for contract '${binding.contractName}' (tenant '${binding.tenantId}')`,
  );
}

/**
 * Creates the suite of Agent-callable Meta-MCP tools that allow coding agents
 * (Claude, Gemini, Cursor) to inspect, test, compile, curate, and optimize ChainMcp servers.
 */
export function createMetaMcpTools(
  admin: DeclarativeAdmin,
  options: MetaMcpToolsOptions = {},
): ToolDefinition[] {
  const tokenizer = options.tokenizer ?? admin.tokenizer;
  const callerTokenId = options.tokenId ?? "agent-meta-server";

  // 1. chainmcp_list_contracts
  const listContractsTool: ToolDefinition = {
    name: "chainmcp_list_contracts",
    description:
      "List all OpenAPI and declarative contracts managed by the ChainMcp gateway or configuration, including tenant, destination, and tool counts.",
    inputSchema: {
      type: "object",
      properties: {
        tenantId: {
          type: "string",
          description: "Optional tenant ID filter.",
        },
      },
      additionalProperties: false,
    },
    operation: {},
    async execute(inputRaw: unknown) {
      const input = (inputRaw as { tenantId?: string }) ?? {};
      const allowedBindings = [...admin.bindings.values()].filter((b) => {
        if (options.tenants && options.tenants !== "*") {
          if (!options.tenants.includes(b.tenantId)) return false;
        }
        if (input.tenantId !== undefined && b.tenantId !== input.tenantId) {
          return false;
        }
        return true;
      });

      const contracts = await Promise.all(
        allowedBindings.map(async (binding) => {
          const active = await admin.store
            .getActive(binding.tenantId, binding.contractName)
            .catch(() => undefined);
          const activeGateway = admin.gateway
            .getRegistry()
            .getActiveRevision(binding.tenantId, binding.contractName);
          const descriptors =
            active?.descriptors ??
            (activeGateway?.metadata?.descriptorSet as
              readonly DeclarativeToolDescriptor[] | undefined) ??
            [];
          return {
            contractName: binding.contractName,
            tenantId: binding.tenantId,
            baseUrl: binding.destinationPolicy.baseUrl,
            allowedHosts: [...binding.destinationPolicy.allowedHosts],
            activeRevisionId: active?.revisionId ?? activeGateway?.revisionId,
            toolCount: descriptors.length,
            enabledToolCount: descriptors.filter((d) => d.enabled !== false)
              .length,
            status: active || activeGateway ? "active" : "uninitialized",
          };
        }),
      );

      return { contracts };
    },
  };

  // 2. chainmcp_inspect_contract
  const inspectContractTool: ToolDefinition = {
    name: "chainmcp_inspect_contract",
    description:
      "Inspect configuration, destination policy, active revision metadata, and summary of tools for a contract.",
    inputSchema: {
      type: "object",
      properties: {
        contractName: {
          type: "string",
          description: "Name of the contract.",
        },
        tenantId: {
          type: "string",
          description: "Optional tenant ID.",
        },
      },
      required: ["contractName"],
      additionalProperties: false,
    },
    operation: {},
    async execute(inputRaw: unknown) {
      const input = inputRaw as { contractName: string; tenantId?: string };
      const binding = resolveBinding(
        admin,
        input.contractName,
        input.tenantId,
        options,
      );
      const activeRecord = await admin.store
        .getActive(binding.tenantId, binding.contractName)
        .catch(() => undefined);
      const activeGateway = admin.gateway
        .getRegistry()
        .getActiveRevision(binding.tenantId, binding.contractName);
      const descriptors =
        activeRecord?.descriptors ??
        (activeGateway?.metadata?.descriptorSet as
          readonly DeclarativeToolDescriptor[] | undefined) ??
        [];

      return {
        contractName: binding.contractName,
        tenantId: binding.tenantId,
        destination: {
          baseUrl: binding.destinationPolicy.baseUrl,
          allowedHosts: [...binding.destinationPolicy.allowedHosts],
          allowInsecureHttp:
            binding.destinationPolicy.allowInsecureHttp ?? false,
        },
        activeRevisionId: activeRecord?.revisionId ?? activeGateway?.revisionId,
        toolCount: descriptors.length,
        enabledToolCount: descriptors.filter((d) => d.enabled !== false).length,
        tools: descriptors.map((d) => ({
          name: d.name,
          description: d.description,
          enabled: d.enabled !== false,
          method: d.request.method,
          path: d.request.path,
        })),
      };
    },
  };

  // 3. chainmcp_inspect_tools
  const inspectToolsTool: ToolDefinition = {
    name: "chainmcp_inspect_tools",
    description:
      "Inspect tool definitions for a contract, including full JSON input schemas, HTTP methods, paths, current policies, and curation status.",
    inputSchema: {
      type: "object",
      properties: {
        contractName: {
          type: "string",
          description: "Name of the contract.",
        },
        tenantId: {
          type: "string",
          description: "Optional tenant ID.",
        },
        toolName: {
          type: "string",
          description: "Optional specific tool name to inspect.",
        },
      },
      required: ["contractName"],
      additionalProperties: false,
    },
    operation: {},
    async execute(inputRaw: unknown) {
      const input = inputRaw as {
        contractName: string;
        tenantId?: string;
        toolName?: string;
      };
      const binding = resolveBinding(
        admin,
        input.contractName,
        input.tenantId,
        options,
      );
      const descriptors = await getActiveDescriptors(admin, binding);

      let filtered = descriptors;
      if (input.toolName !== undefined) {
        const match = descriptors.find((d) => d.name === input.toolName);
        if (!match) {
          throw new RuntimeError(
            "TOOL_NOT_FOUND",
            `Tool '${input.toolName}' was not found in contract '${binding.contractName}'`,
          );
        }
        filtered = [match];
      }

      return {
        contractName: binding.contractName,
        tenantId: binding.tenantId,
        tools: filtered.map((d) => ({
          name: d.name,
          description: d.description,
          enabled: d.enabled !== false,
          request: {
            method: d.request.method,
            path: d.request.path,
            parameterCount: d.request.parameters?.length ?? 0,
          },
          inputSchema: d.inputSchema,
          policy: {
            requiredScopes: d.policy?.requiredScopes
              ? [...d.policy.requiredScopes]
              : [],
            cacheTtlSeconds: d.policy?.cacheTtlSeconds,
            maxOutputTokens: d.policy?.maxOutputTokens,
            outputFields: d.policy?.outputFields,
            timeoutMs: d.policy?.timeoutMs,
          },
        })),
      };
    },
  };

  // 4. chainmcp_curate_tool
  const curateToolTool: ToolDefinition = {
    name: "chainmcp_curate_tool",
    description:
      "Enable or disable one or more tools in a contract. Automatically generates and activates a new revision.",
    inputSchema: {
      type: "object",
      properties: {
        contractName: {
          type: "string",
          description: "Name of the contract.",
        },
        toolName: {
          type: "string",
          description: "Single tool name to curate.",
        },
        enabled: {
          type: "boolean",
          description: "Whether the tool is enabled.",
        },
        tools: {
          type: "array",
          items: {
            type: "object",
            properties: {
              toolName: { type: "string" },
              enabled: { type: "boolean" },
            },
            required: ["toolName", "enabled"],
            additionalProperties: false,
          },
          description: "Batch curation: array of toolName and enabled updates.",
        },
        tenantId: {
          type: "string",
          description: "Optional tenant ID.",
        },
      },
      required: ["contractName"],
      additionalProperties: false,
    },
    operation: {},
    async execute(inputRaw: unknown) {
      const input = inputRaw as {
        contractName: string;
        toolName?: string;
        enabled?: boolean;
        tools?: Array<{ toolName: string; enabled: boolean }>;
        tenantId?: string;
      };

      const binding = resolveBinding(
        admin,
        input.contractName,
        input.tenantId,
        options,
      );
      const updates: Array<{ toolName: string; enabled: boolean }> = [];

      if (input.toolName !== undefined && typeof input.enabled === "boolean") {
        updates.push({ toolName: input.toolName, enabled: input.enabled });
      } else if (Array.isArray(input.tools)) {
        for (const t of input.tools) {
          if (
            typeof t.toolName === "string" &&
            typeof t.enabled === "boolean"
          ) {
            updates.push({ toolName: t.toolName, enabled: t.enabled });
          }
        }
      }

      if (updates.length === 0) {
        throw new RuntimeError(
          "INPUT_INVALID",
          "Must provide either 'toolName' and 'enabled', or a non-empty 'tools' array",
        );
      }

      const currentDescriptors = await getActiveDescriptors(admin, binding);
      const updateMap = new Map(updates.map((u) => [u.toolName, u.enabled]));

      for (const tName of updateMap.keys()) {
        if (!currentDescriptors.some((d) => d.name === tName)) {
          throw new RuntimeError(
            "TOOL_NOT_FOUND",
            `Tool '${tName}' was not found in contract '${binding.contractName}'`,
          );
        }
      }

      const updatedDescriptors = currentDescriptors.map((desc) => {
        if (updateMap.has(desc.name)) {
          return {
            ...desc,
            enabled: updateMap.get(desc.name)!,
          };
        }
        return desc;
      });

      if (updatedDescriptors.every((d) => d.enabled === false)) {
        throw new RuntimeError(
          "CONTRACT_INVALID",
          "Cannot disable all tools: contract must have at least one active tool",
        );
      }

      const { evaluation, parsed } = evaluateDescriptorSet({
        descriptors: updatedDescriptors,
        authSchemes: binding.authSchemes,
      });

      if (!evaluation.valid) {
        return {
          ok: false,
          error: "Descriptor validation failed",
          diagnostics: evaluation.diagnostics,
        };
      }

      if (options.requireApproval) {
        const reason = updates
          .map((u) => `${u.toolName}:${u.enabled ? "enabled" : "disabled"}`)
          .join(",");
        const proposal = await admin.createProposal({
          tenantId: binding.tenantId,
          contractName: binding.contractName,
          descriptors: updatedDescriptors,
          proposedBy: callerTokenId,
          proposalReason: `Agent curation proposal: ${reason}`,
          tokenId: callerTokenId,
        });
        return {
          ok: true,
          status: "proposal",
          requiresApproval: true,
          contractName: binding.contractName,
          tenantId: binding.tenantId,
          revisionId: proposal.summary.revisionId,
          toolCount: proposal.summary.toolCount,
          message:
            "Proposal submitted for human operator approval in Web Studio. Gateway active runtime state was not modified.",
          estimatedTokenSavings: proposal.summary.estimatedTokenSavings,
          diff: proposal.diff,
        };
      }

      const published = await admin.publishDescriptors(
        binding,
        parsed,
        callerTokenId,
      );

      if (admin.onConfigSync) {
        for (const [tName, isEnabled] of updateMap.entries()) {
          await admin.onConfigSync({
            tenantId: binding.tenantId,
            contractName: binding.contractName,
            toolName: tName,
            enabled: isEnabled,
          });
        }
      }

      await admin.emitAuditRecord({
        type: "admin_curate",
        timestamp: admin.now(),
        route: "mcp/chainmcp_curate_tool",
        tokenId: callerTokenId,
        tenantId: binding.tenantId,
        contractName: binding.contractName,
        revisionId: published.revisionId,
        toolCount: published.toolCount,
        reason: updates
          .map((u) => `${u.toolName}:${u.enabled ? "enabled" : "disabled"}`)
          .join(","),
      });

      return {
        ok: true,
        contractName: binding.contractName,
        tenantId: binding.tenantId,
        revisionId: published.revisionId,
        gatewayRevisionId: published.gatewayRevisionId,
        toolCount: published.toolCount,
        updates,
      };
    },
  };

  // 5. chainmcp_configure_projection
  const configureProjectionTool: ToolDefinition = {
    name: "chainmcp_configure_projection",
    description:
      "Configure field projection (include or exclude paths) and optional token budget for a tool to minimize LLM token waste. Generates and activates a new revision.",
    inputSchema: {
      type: "object",
      properties: {
        contractName: {
          type: "string",
          description: "Name of the contract.",
        },
        toolName: {
          type: "string",
          description: "Tool name to configure.",
        },
        outputFields: {
          type: "object",
          properties: {
            include: {
              type: "array",
              items: { type: "string" },
              description:
                "Field paths to include. Mutually exclusive with exclude.",
            },
            exclude: {
              type: "array",
              items: { type: "string" },
              description:
                "Field paths to exclude. Mutually exclusive with include.",
            },
          },
          additionalProperties: false,
          description:
            "Field projection rules. Must supply either include or exclude, not both.",
        },
        maxOutputTokens: {
          type: "integer",
          minimum: 1,
          description: "Optional maximum output token budget.",
        },
        proposalReason: {
          type: "string",
          description: "Optional rationale or summary for this proposal.",
        },
        tenantId: {
          type: "string",
          description: "Optional tenant ID.",
        },
      },
      required: ["contractName", "toolName"],
      additionalProperties: false,
    },
    operation: {},
    async execute(inputRaw: unknown) {
      const input = inputRaw as {
        contractName: string;
        toolName: string;
        outputFields?: FieldSelection;
        maxOutputTokens?: number;
        proposalReason?: string;
        tenantId?: string;
      };

      if (!input.outputFields && input.maxOutputTokens === undefined) {
        throw new RuntimeError(
          "INPUT_INVALID",
          "Must specify at least one of 'outputFields' or 'maxOutputTokens'",
        );
      }

      if (input.outputFields !== undefined) {
        assertFieldSelection(input.outputFields);
      }

      if (
        input.maxOutputTokens !== undefined &&
        (!Number.isInteger(input.maxOutputTokens) || input.maxOutputTokens < 1)
      ) {
        throw new RuntimeError(
          "INPUT_INVALID",
          "maxOutputTokens must be a positive integer",
        );
      }

      const binding = resolveBinding(
        admin,
        input.contractName,
        input.tenantId,
        options,
      );
      const currentDescriptors = await getActiveDescriptors(admin, binding);
      const targetDesc = currentDescriptors.find(
        (d) => d.name === input.toolName,
      );

      if (!targetDesc) {
        throw new RuntimeError(
          "TOOL_NOT_FOUND",
          `Tool '${input.toolName}' was not found in contract '${binding.contractName}'`,
        );
      }

      const updatedDescriptors = currentDescriptors.map((desc) => {
        if (desc.name === input.toolName) {
          const policy = { ...(desc.policy ?? {}) };
          if (input.outputFields !== undefined) {
            policy.outputFields = input.outputFields;
          }
          if (input.maxOutputTokens !== undefined) {
            policy.maxOutputTokens = input.maxOutputTokens;
          }
          return {
            ...desc,
            policy,
          };
        }
        return desc;
      });

      const { evaluation, parsed } = evaluateDescriptorSet({
        descriptors: updatedDescriptors,
        authSchemes: binding.authSchemes,
      });

      if (!evaluation.valid) {
        return {
          ok: false,
          error: "Descriptor validation failed",
          diagnostics: evaluation.diagnostics,
        };
      }

      if (options.requireApproval) {
        const proposal = await admin.createProposal({
          tenantId: binding.tenantId,
          contractName: binding.contractName,
          descriptors: updatedDescriptors,
          proposedBy: callerTokenId,
          proposalReason:
            input.proposalReason ??
            `Agent projection proposal for '${input.toolName}'`,
          tokenId: callerTokenId,
        });
        return {
          ok: true,
          status: "proposal",
          requiresApproval: true,
          contractName: binding.contractName,
          tenantId: binding.tenantId,
          toolName: input.toolName,
          revisionId: proposal.summary.revisionId,
          toolCount: proposal.summary.toolCount,
          message:
            "Proposal submitted for human operator approval in Web Studio. Gateway active runtime state was not modified.",
          policy: {
            outputFields: input.outputFields ?? targetDesc.policy?.outputFields,
            maxOutputTokens:
              input.maxOutputTokens ?? targetDesc.policy?.maxOutputTokens,
          },
          estimatedTokenSavings: proposal.summary.estimatedTokenSavings,
          diff: proposal.diff,
        };
      }

      const published = await admin.publishDescriptors(
        binding,
        parsed,
        callerTokenId,
      );

      await admin.emitAuditRecord({
        type: "admin_curate",
        timestamp: admin.now(),
        route: "mcp/chainmcp_configure_projection",
        tokenId: callerTokenId,
        tenantId: binding.tenantId,
        contractName: binding.contractName,
        toolName: input.toolName,
        revisionId: published.revisionId,
        toolCount: published.toolCount,
        reason: `projection_configured:${input.toolName}`,
      });

      return {
        ok: true,
        contractName: binding.contractName,
        tenantId: binding.tenantId,
        toolName: input.toolName,
        revisionId: published.revisionId,
        policy: {
          outputFields: input.outputFields ?? targetDesc.policy?.outputFields,
          maxOutputTokens:
            input.maxOutputTokens ?? targetDesc.policy?.maxOutputTokens,
        },
      };
    },
  };

  // 6. chainmcp_configure_cache
  const configureCacheTool: ToolDefinition = {
    name: "chainmcp_configure_cache",
    description:
      "Configure cache TTL for a read-only idempotent tool (GET/HEAD). Mutations (POST/PUT/PATCH/DELETE) are strictly forbidden from being cached.",
    inputSchema: {
      type: "object",
      properties: {
        contractName: {
          type: "string",
          description: "Name of the contract.",
        },
        toolName: {
          type: "string",
          description: "Tool name to configure caching for.",
        },
        ttlSeconds: {
          type: "integer",
          minimum: 0,
          description: "Cache time-to-live in seconds (0 removes caching).",
        },
        proposalReason: {
          type: "string",
          description: "Optional rationale or summary for this proposal.",
        },
        tenantId: {
          type: "string",
          description: "Optional tenant ID.",
        },
      },
      required: ["contractName", "toolName", "ttlSeconds"],
      additionalProperties: false,
    },
    operation: {},
    async execute(inputRaw: unknown) {
      const input = inputRaw as {
        contractName: string;
        toolName: string;
        ttlSeconds: number;
        proposalReason?: string;
        tenantId?: string;
      };

      const binding = resolveBinding(
        admin,
        input.contractName,
        input.tenantId,
        options,
      );
      const currentDescriptors = await getActiveDescriptors(admin, binding);
      const targetDesc = currentDescriptors.find(
        (d) => d.name === input.toolName,
      );

      if (!targetDesc) {
        throw new RuntimeError(
          "TOOL_NOT_FOUND",
          `Tool '${input.toolName}' was not found in contract '${binding.contractName}'`,
        );
      }

      // SECURITY INVARIANT: never cache mutations
      const method = targetDesc.request.method.toUpperCase();
      if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
        throw new RuntimeError(
          "AUTH_FORBIDDEN",
          `Cannot configure caching on mutation method '${method}'. Only idempotent read methods (GET, HEAD) may be cached.`,
        );
      }

      const updatedDescriptors = currentDescriptors.map((desc) => {
        if (desc.name === input.toolName) {
          const policy = { ...(desc.policy ?? {}) };
          if (input.ttlSeconds > 0) {
            policy.cacheTtlSeconds = input.ttlSeconds;
          } else {
            delete policy.cacheTtlSeconds;
          }
          return {
            ...desc,
            policy,
          };
        }
        return desc;
      });

      const { evaluation, parsed } = evaluateDescriptorSet({
        descriptors: updatedDescriptors,
        authSchemes: binding.authSchemes,
      });

      if (!evaluation.valid) {
        return {
          ok: false,
          error: "Descriptor validation failed",
          diagnostics: evaluation.diagnostics,
        };
      }

      if (options.requireApproval) {
        const proposal = await admin.createProposal({
          tenantId: binding.tenantId,
          contractName: binding.contractName,
          descriptors: updatedDescriptors,
          proposedBy: callerTokenId,
          proposalReason:
            input.proposalReason ??
            `Agent cache proposal for '${input.toolName}': ${input.ttlSeconds}s TTL`,
          tokenId: callerTokenId,
        });
        return {
          ok: true,
          status: "proposal",
          requiresApproval: true,
          contractName: binding.contractName,
          tenantId: binding.tenantId,
          toolName: input.toolName,
          revisionId: proposal.summary.revisionId,
          toolCount: proposal.summary.toolCount,
          message:
            "Proposal submitted for human operator approval in Web Studio. Gateway active runtime state was not modified.",
          cacheTtlSeconds: input.ttlSeconds > 0 ? input.ttlSeconds : undefined,
          estimatedTokenSavings: proposal.summary.estimatedTokenSavings,
          diff: proposal.diff,
        };
      }

      const published = await admin.publishDescriptors(
        binding,
        parsed,
        callerTokenId,
      );

      await admin.emitAuditRecord({
        type: "admin_curate",
        timestamp: admin.now(),
        route: "mcp/chainmcp_configure_cache",
        tokenId: callerTokenId,
        tenantId: binding.tenantId,
        contractName: binding.contractName,
        toolName: input.toolName,
        revisionId: published.revisionId,
        toolCount: published.toolCount,
        reason: `cache_configured:${input.toolName}:${input.ttlSeconds}s`,
      });

      return {
        ok: true,
        contractName: binding.contractName,
        tenantId: binding.tenantId,
        toolName: input.toolName,
        revisionId: published.revisionId,
        cacheTtlSeconds: input.ttlSeconds > 0 ? input.ttlSeconds : undefined,
      };
    },
  };

  // 7. chainmcp_test_tool
  const testToolTool: ToolDefinition = {
    name: "chainmcp_test_tool",
    description:
      "Test-fire a tool with sample arguments and optional projection. Returns execution status, raw and projected payloads, and token savings metrics.",
    inputSchema: {
      type: "object",
      properties: {
        contractName: {
          type: "string",
          description: "Name of the contract.",
        },
        toolName: {
          type: "string",
          description: "Name of the tool to test.",
        },
        arguments: {
          type: "object",
          description: "Tool input arguments matching its JSON schema.",
        },
        projection: {
          type: "object",
          properties: {
            include: { type: "array", items: { type: "string" } },
            exclude: { type: "array", items: { type: "string" } },
          },
          additionalProperties: false,
          description:
            "Optional ad-hoc projection to simulate token savings without persisting.",
        },
        tenantId: {
          type: "string",
          description: "Optional tenant ID.",
        },
      },
      required: ["contractName", "toolName"],
      additionalProperties: false,
    },
    operation: {},
    async execute(inputRaw: unknown) {
      const input = inputRaw as {
        contractName: string;
        toolName: string;
        arguments?: Record<string, unknown>;
        projection?: FieldSelection;
        tenantId?: string;
      };

      const binding = resolveBinding(
        admin,
        input.contractName,
        input.tenantId,
        options,
      );
      const currentDescriptors = await getActiveDescriptors(admin, binding);
      const targetDesc = currentDescriptors.find(
        (d) => d.name === input.toolName,
      );

      if (!targetDesc) {
        throw new RuntimeError(
          "TOOL_NOT_FOUND",
          `Tool '${input.toolName}' was not found in contract '${binding.contractName}'`,
        );
      }

      const limits = binding.limits;
      const transport = binding.transport ?? admin.transport;
      const resolveHost = binding.resolveHost ?? admin.resolveHost;
      const executor = createUpstreamExecutor({
        baseUrl: binding.destinationPolicy.baseUrl,
        allowedHosts: binding.destinationPolicy.allowedHosts,
        ...(binding.destinationPolicy.allowInsecureHttp === undefined
          ? {}
          : { allowInsecureHttp: binding.destinationPolicy.allowInsecureHttp }),
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
        descriptors: [{ ...targetDesc, enabled: true }],
        executor,
        ...(binding.authSchemes === undefined
          ? {}
          : { authSchemes: binding.authSchemes }),
      });

      const [tool] = source.getTools();
      if (!tool) {
        throw new RuntimeError(
          "CONTRACT_INVALID",
          `Failed to bind tool '${input.toolName}' for testing`,
        );
      }

      let selection: FieldSelection | undefined;
      if (input.projection) {
        assertFieldSelection(input.projection);
        selection = input.projection;
      } else if (targetDesc.policy?.outputFields) {
        selection = targetDesc.policy.outputFields;
      }

      const context: ToolContext = {
        tenantId: binding.tenantId,
        requestId: `test-${Date.now()}-${randomBytes(4).toString("hex")}`,
        principal: {
          id: callerTokenId,
          scopes: targetDesc.policy?.requiredScopes
            ? [...targetDesc.policy.requiredScopes]
            : [],
        },
      };

      const testArgs = input.arguments ?? {};
      const startTime = performance.now();
      let raw: unknown;

      try {
        raw = await tool.execute(testArgs, context);
      } catch (error) {
        const executionTimeMs = Math.round(performance.now() - startTime);
        const errorCode =
          error instanceof Error && "code" in error
            ? String((error as { code: unknown }).code)
            : "TEST_EXECUTION_FAILED";

        if (admin.storageDriver) {
          const ring = admin.storageDriver.getTelemetryRingBuffer();
          await ring
            .push({
              id: `tel-${Date.now()}-${randomBytes(4).toString("hex")}`,
              timestamp: admin.now(),
              tenantId: binding.tenantId,
              toolName: input.toolName,
              durationMs: executionTimeMs,
              isError: true,
              errorCode,
              cached: false,
              metadata: {
                errorMessage:
                  error instanceof Error ? error.message : String(error),
                source: "agent_meta_server",
              },
            })
            .catch(() => undefined);
        }

        return {
          ok: false,
          toolName: input.toolName,
          executionTimeMs,
          error: {
            code: errorCode,
            message: error instanceof Error ? error.message : String(error),
          },
        };
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
            name: input.toolName,
            output: { fields: selection },
          } as unknown as ToolDefinition,
          result: raw,
          context,
        });
      }

      const rawStr = typeof raw === "string" ? raw : JSON.stringify(raw);
      const projectedStr =
        typeof projected === "string" ? projected : JSON.stringify(projected);
      const rawTokens = tokenizer.count(rawStr);
      const projectedTokens = tokenizer.count(projectedStr);
      const savedTokens = Math.max(0, rawTokens - projectedTokens);
      const percentSavings =
        rawTokens > 0 ? Math.round((savedTokens / rawTokens) * 100) : 0;

      if (admin.storageDriver) {
        const ring = admin.storageDriver.getTelemetryRingBuffer();
        await ring
          .push({
            id: `tel-${Date.now()}-${randomBytes(4).toString("hex")}`,
            timestamp: admin.now(),
            tenantId: binding.tenantId,
            toolName: input.toolName,
            durationMs: executionTimeMs,
            isError: false,
            cached: false,
            tokenCount: projectedTokens,
            metadata: {
              rawTokens,
              projectedTokens,
              savedTokens,
              source: "agent_meta_server",
            },
          })
          .catch(() => undefined);
      }

      await admin.emitAuditRecord({
        type: "admin_test_tool",
        timestamp: admin.now(),
        route: "mcp/chainmcp_test_tool",
        tokenId: callerTokenId,
        tenantId: binding.tenantId,
        contractName: binding.contractName,
        toolName: input.toolName,
        reason: `test_success:${savedTokens}_tokens_saved`,
      });

      return {
        ok: true,
        toolName: input.toolName,
        executionTimeMs,
        raw,
        projected,
        metrics: {
          rawTokens,
          projectedTokens,
          savedTokens,
          percentSavings,
          tokenizerId: tokenizer.id,
        },
      };
    },
  };

  // 8. chainmcp_compile_spec
  const compileSpecTool: ToolDefinition = {
    name: "chainmcp_compile_spec",
    description:
      "Compile and validate an OpenAPI specification (string content or file path). Returns compiled tools, schemas, and diagnostics without publishing.",
    inputSchema: {
      type: "object",
      properties: {
        spec: {
          type: "string",
          description:
            "OpenAPI specification content (YAML or JSON) or file path.",
        },
        strict: {
          type: "boolean",
          description: "Whether to enforce strict OpenAPI compliance rules.",
        },
      },
      required: ["spec"],
      additionalProperties: false,
    },
    operation: {},
    async execute(inputRaw: unknown) {
      const input = inputRaw as { spec: string; strict?: boolean };
      let content = input.spec;

      if (options.readSpecFile) {
        try {
          content = await options.readSpecFile(input.spec);
        } catch {
          // Fall through to raw content
        }
      } else if (
        input.spec.endsWith(".json") ||
        input.spec.endsWith(".yaml") ||
        input.spec.endsWith(".yml")
      ) {
        try {
          content = await readFile(input.spec, "utf8");
        } catch {
          // Fall through to raw content
        }
      }

      const compiled = compileOpenApi(content, {
        strict: input.strict ?? false,
      });

      return {
        ok: compiled.ok,
        toolCount: compiled.tools.length,
        tools: compiled.tools.map((t) => ({
          name: t.name,
          description: t.description,
          operation: t.operation,
          inputSchema: t.inputSchema,
        })),
        diagnostics: compiled.diagnostics,
      };
    },
  };

  // 9. chainmcp_publish_revision
  const publishRevisionTool: ToolDefinition = {
    name: "chainmcp_publish_revision",
    description:
      "Commit and activate a new descriptor revision containing declarative tool descriptors for a contract.",
    inputSchema: {
      type: "object",
      properties: {
        contractName: {
          type: "string",
          description: "Name of the contract.",
        },
        descriptors: {
          type: "array",
          items: { type: "object" },
          description: "Full array of declarative tool descriptors.",
        },
        proposalReason: {
          type: "string",
          description: "Optional rationale or summary for this proposal.",
        },
        tenantId: {
          type: "string",
          description: "Optional tenant ID.",
        },
      },
      required: ["contractName", "descriptors"],
      additionalProperties: false,
    },
    operation: {},
    async execute(inputRaw: unknown) {
      const input = inputRaw as {
        contractName: string;
        descriptors: unknown[];
        proposalReason?: string;
        tenantId?: string;
      };

      if (!Array.isArray(input.descriptors) || input.descriptors.length === 0) {
        throw new RuntimeError(
          "INPUT_INVALID",
          "descriptors must be a non-empty array of declarative tool descriptors",
        );
      }

      const binding = resolveBinding(
        admin,
        input.contractName,
        input.tenantId,
        options,
      );

      const { evaluation, parsed } = evaluateDescriptorSet({
        descriptors: input.descriptors,
        authSchemes: binding.authSchemes,
      });

      if (!evaluation.valid) {
        return {
          ok: false,
          error: "Descriptor validation failed",
          diagnostics: evaluation.diagnostics,
        };
      }

      if (options.requireApproval) {
        const proposal = await admin.createProposal({
          tenantId: binding.tenantId,
          contractName: binding.contractName,
          descriptors: input.descriptors,
          proposedBy: callerTokenId,
          proposalReason:
            input.proposalReason ?? "Agent publish revision proposal",
          tokenId: callerTokenId,
        });
        return {
          ok: true,
          status: "proposal",
          requiresApproval: true,
          contractName: binding.contractName,
          tenantId: binding.tenantId,
          revisionId: proposal.summary.revisionId,
          toolCount: proposal.summary.toolCount,
          message:
            "Proposal submitted for human operator approval in Web Studio. Gateway active runtime state was not modified.",
          estimatedTokenSavings: proposal.summary.estimatedTokenSavings,
          diff: proposal.diff,
        };
      }

      const published = await admin.publishDescriptors(
        binding,
        parsed,
        callerTokenId,
      );

      await admin.emitAuditRecord({
        type: "admin_publish",
        timestamp: admin.now(),
        route: "mcp/chainmcp_publish_revision",
        tokenId: callerTokenId,
        tenantId: binding.tenantId,
        contractName: binding.contractName,
        revisionId: published.revisionId,
        toolCount: published.toolCount,
        reason: `agent_published:${published.revisionId}`,
      });

      return {
        ok: true,
        contractName: binding.contractName,
        tenantId: binding.tenantId,
        revisionId: published.revisionId,
        gatewayRevisionId: published.gatewayRevisionId,
        toolCount: published.toolCount,
        status: "active",
      };
    },
  };

  // 10. chainmcp_list_revisions
  const listRevisionsTool: ToolDefinition = {
    name: "chainmcp_list_revisions",
    description:
      "List revision history for a contract with timestamps, publisher, and status.",
    inputSchema: {
      type: "object",
      properties: {
        contractName: {
          type: "string",
          description: "Name of the contract.",
        },
        tenantId: {
          type: "string",
          description: "Optional tenant ID.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          description: "Maximum revisions to return.",
        },
      },
      required: ["contractName"],
      additionalProperties: false,
    },
    operation: {},
    async execute(inputRaw: unknown) {
      const input = inputRaw as {
        contractName: string;
        tenantId?: string;
        limit?: number;
      };

      const binding = resolveBinding(
        admin,
        input.contractName,
        input.tenantId,
        options,
      );
      const revisions = await admin.store.listRevisions(
        binding.tenantId,
        binding.contractName,
      );
      const sliced =
        input.limit !== undefined ? revisions.slice(0, input.limit) : revisions;

      return {
        contractName: binding.contractName,
        tenantId: binding.tenantId,
        revisions: sliced.map((r) => ({
          revisionId: r.revisionId,
          status: r.status,
          createdAt: r.createdAt,
          publishedBy: r.publishedBy,
          toolCount: r.descriptors.length,
          gatewayRevisionId: r.gatewayRevisionId,
        })),
      };
    },
  };

  // 11. chainmcp_rollback_revision
  const rollbackRevisionTool: ToolDefinition = {
    name: "chainmcp_rollback_revision",
    description: "Roll back a contract to a previous active revision.",
    inputSchema: {
      type: "object",
      properties: {
        contractName: {
          type: "string",
          description: "Name of the contract.",
        },
        targetRevisionId: {
          type: "string",
          description: "Revision ID to restore and activate.",
        },
        tenantId: {
          type: "string",
          description: "Optional tenant ID.",
        },
      },
      required: ["contractName", "targetRevisionId"],
      additionalProperties: false,
    },
    operation: {},
    async execute(inputRaw: unknown) {
      const input = inputRaw as {
        contractName: string;
        targetRevisionId: string;
        tenantId?: string;
      };

      const binding = resolveBinding(
        admin,
        input.contractName,
        input.tenantId,
        options,
      );
      const target = await admin.store.getRevision(
        binding.tenantId,
        binding.contractName,
        input.targetRevisionId,
      );

      if (!target) {
        throw new RuntimeError(
          "CONTRACT_INVALID",
          `Revision '${input.targetRevisionId}' was not found for contract '${binding.contractName}'`,
        );
      }

      if (target.status === "active") {
        throw new RuntimeError(
          "CONTRACT_INVALID",
          `Revision '${input.targetRevisionId}' is already active`,
        );
      }

      const { evaluation, parsed } = evaluateDescriptorSet({
        descriptors: target.descriptors,
        authSchemes: binding.authSchemes,
      });

      if (!evaluation.valid) {
        throw new RuntimeError(
          "CONTRACT_INVALID",
          `Stored revision '${input.targetRevisionId}' no longer validates under the current contract binding`,
        );
      }

      if (options.requireApproval) {
        const proposal = await admin.createProposal({
          tenantId: binding.tenantId,
          contractName: binding.contractName,
          descriptors: target.descriptors,
          proposedBy: callerTokenId,
          proposalReason: `Agent rollback proposal: restore '${input.targetRevisionId}'`,
          tokenId: callerTokenId,
        });
        return {
          ok: true,
          status: "proposal",
          requiresApproval: true,
          contractName: binding.contractName,
          tenantId: binding.tenantId,
          revisionId: proposal.summary.revisionId,
          restoredRevisionId: input.targetRevisionId,
          toolCount: proposal.summary.toolCount,
          message:
            "Rollback submitted as proposal for human operator approval in Web Studio. Gateway active runtime state was not modified.",
          diff: proposal.diff,
        };
      }

      const published = await admin.publishDescriptors(
        binding,
        parsed,
        callerTokenId,
        input.targetRevisionId,
      );

      await admin.emitAuditRecord({
        type: "admin_rollback",
        timestamp: admin.now(),
        route: "mcp/chainmcp_rollback_revision",
        tokenId: callerTokenId,
        tenantId: binding.tenantId,
        contractName: binding.contractName,
        revisionId: published.revisionId,
        toolCount: published.toolCount,
        reason: `rollback_of:${input.targetRevisionId}`,
      });

      return {
        ok: true,
        contractName: binding.contractName,
        tenantId: binding.tenantId,
        restoredRevisionId: input.targetRevisionId,
        revisionId: published.revisionId,
        toolCount: published.toolCount,
      };
    },
  };

  // 12. chainmcp_get_diagnostics
  const getDiagnosticsTool: ToolDefinition = {
    name: "chainmcp_get_diagnostics",
    description:
      "Analyze telemetry events, latency, error rates, and payload sizes across active contracts to discover bottlenecks, token bloat, and cache opportunities, returning actionable optimization proposals.",
    inputSchema: {
      type: "object",
      properties: {
        contractName: {
          type: "string",
          description: "Optional contract name to filter diagnostics.",
        },
        toolName: {
          type: "string",
          description: "Optional tool name to filter diagnostics.",
        },
        tenantId: {
          type: "string",
          description: "Optional tenant ID filter.",
        },
        windowMs: {
          type: "number",
          description:
            "Analysis window in milliseconds (default: 3600000 = 1 hour).",
        },
        tokenBloatThreshold: {
          type: "number",
          description:
            "Minimum tokens/call to trigger a token bloat hint (default: 800).",
        },
      },
      additionalProperties: false,
    },
    operation: {},
    async execute(inputRaw: unknown) {
      const input =
        (inputRaw as {
          contractName?: string;
          toolName?: string;
          tenantId?: string;
          windowMs?: number;
          tokenBloatThreshold?: number;
        }) ?? {};

      if (options.tenants && options.tenants !== "*") {
        if (input.tenantId && !options.tenants.includes(input.tenantId)) {
          throw new RuntimeError(
            "AUTH_FORBIDDEN",
            `Access to tenant '${input.tenantId}' is forbidden`,
          );
        }
      }

      return await admin.getDiagnostics({
        contractName: input.contractName,
        toolName: input.toolName,
        tenantId:
          input.tenantId ??
          (options.tenants &&
          options.tenants !== "*" &&
          options.tenants.length === 1
            ? options.tenants[0]
            : undefined),
        windowMs: input.windowMs,
        analyzerOptions: {
          ...(input.tokenBloatThreshold !== undefined
            ? { tokenBloatThreshold: input.tokenBloatThreshold }
            : {}),
        },
      });
    },
  };

  // 13. chainmcp_submit_proposal
  const submitProposalTool: ToolDefinition = {
    name: "chainmcp_submit_proposal",
    description:
      "Submit a proposed descriptor revision for operator review and approval in Web Studio without mutating active runtime gateway state.",
    inputSchema: {
      type: "object",
      properties: {
        contractName: {
          type: "string",
          description: "Name of the contract.",
        },
        descriptors: {
          type: "array",
          items: { type: "object" },
          description: "Full array of proposed declarative tool descriptors.",
        },
        proposalReason: {
          type: "string",
          description: "Rationale or summary of the proposed changes.",
        },
        tenantId: {
          type: "string",
          description: "Optional tenant ID.",
        },
      },
      required: ["contractName", "descriptors"],
      additionalProperties: false,
    },
    operation: {},
    async execute(inputRaw: unknown) {
      const input = inputRaw as {
        contractName: string;
        descriptors: unknown[];
        proposalReason?: string;
        tenantId?: string;
      };

      if (!Array.isArray(input.descriptors) || input.descriptors.length === 0) {
        throw new RuntimeError(
          "INPUT_INVALID",
          "descriptors must be a non-empty array of declarative tool descriptors",
        );
      }

      const binding = resolveBinding(
        admin,
        input.contractName,
        input.tenantId,
        options,
      );

      const result = await admin.createProposal({
        tenantId: binding.tenantId,
        contractName: binding.contractName,
        descriptors: input.descriptors,
        proposedBy: callerTokenId,
        proposalReason: input.proposalReason,
        tokenId: callerTokenId,
      });

      return {
        ok: true,
        status: "proposal",
        requiresApproval: true,
        contractName: binding.contractName,
        tenantId: binding.tenantId,
        revisionId: result.summary.revisionId,
        toolCount: result.summary.toolCount,
        message:
          "Proposal submitted for human operator approval in Web Studio. Gateway active runtime state was not modified.",
        estimatedTokenSavings: result.summary.estimatedTokenSavings,
        diff: result.diff,
      };
    },
  };

  // 14. chainmcp_list_proposals
  const listProposalsTool: ToolDefinition = {
    name: "chainmcp_list_proposals",
    description:
      "List pending agent proposals awaiting human operator approval in Web Studio.",
    inputSchema: {
      type: "object",
      properties: {
        contractName: {
          type: "string",
          description: "Optional contract name filter.",
        },
        tenantId: {
          type: "string",
          description: "Optional tenant ID filter.",
        },
      },
      additionalProperties: false,
    },
    operation: {},
    async execute(inputRaw: unknown) {
      const input =
        (inputRaw as {
          contractName?: string;
          tenantId?: string;
        }) ?? {};

      const allowedBindings = [...admin.bindings.values()].filter((b) => {
        if (options.tenants && options.tenants !== "*") {
          if (!options.tenants.includes(b.tenantId)) return false;
        }
        if (input.tenantId !== undefined && b.tenantId !== input.tenantId) {
          return false;
        }
        if (
          input.contractName !== undefined &&
          b.contractName !== input.contractName
        ) {
          return false;
        }
        return true;
      });

      const proposals: unknown[] = [];
      for (const binding of allowedBindings) {
        const list = await admin.store
          .listProposals(binding.tenantId, binding.contractName)
          .catch(() => []);
        proposals.push(
          ...list.map((r) => ({
            revisionId: r.revisionId,
            tenantId: r.tenantId,
            contractName: r.contractName,
            status: r.status,
            createdAt: r.createdAt,
            proposedBy: r.proposedBy,
            proposalReason: r.proposalReason,
            estimatedTokenSavings: r.estimatedTokenSavings,
            toolCount: r.descriptors.length,
          })),
        );
      }

      return {
        ok: true,
        proposals,
        count: proposals.length,
      };
    },
  };

  return [
    listContractsTool,
    inspectContractTool,
    inspectToolsTool,
    curateToolTool,
    configureProjectionTool,
    configureCacheTool,
    testToolTool,
    compileSpecTool,
    publishRevisionTool,
    listRevisionsTool,
    rollbackRevisionTool,
    getDiagnosticsTool,
    submitProposalTool,
    listProposalsTool,
  ];
}

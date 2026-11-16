import type { DeclarativeToolDescriptor } from "@chainmcp/declarative";

import type {
  ProposalDiffReport,
  ProposalToolChanges,
  ProposalToolDiff,
} from "./types.js";

/**
 * Options for computing diffs and estimated context token savings between
 * active descriptors and a proposed revision.
 */
export interface ComputeProposalDiffOptions {
  readonly proposalRevisionId?: string | undefined;
  readonly activeRevisionId?: string | undefined;
  readonly tenantId: string;
  readonly contractName: string;
  readonly defaultToolTokens?: number | undefined;
}

/**
 * Computes deep field-level diffs and estimates context token savings per tool
 * invocation between active and proposed tool descriptor sets.
 */
export function computeProposalDiffAndSavings(
  activeDescriptors: readonly DeclarativeToolDescriptor[] | undefined,
  proposedDescriptors: readonly DeclarativeToolDescriptor[],
  options: ComputeProposalDiffOptions,
): ProposalDiffReport {
  const activeMap = new Map<string, DeclarativeToolDescriptor>();
  for (const tool of activeDescriptors ?? []) {
    activeMap.set(tool.name, tool);
  }

  const proposedMap = new Map<string, DeclarativeToolDescriptor>();
  for (const tool of proposedDescriptors) {
    proposedMap.set(tool.name, tool);
  }

  const allToolNames = Array.from(
    new Set([...activeMap.keys(), ...proposedMap.keys()]),
  ).sort();

  const toolDiffs: ProposalToolDiff[] = [];
  let totalSavedTokens = 0;
  let changedCount = 0;

  for (const name of allToolNames) {
    const activeTool = activeMap.get(name);
    const proposedTool = proposedMap.get(name);

    if (activeTool === undefined && proposedTool !== undefined) {
      changedCount += 1;
      toolDiffs.push({
        toolName: name,
        changeType: "added",
        changes: {},
        estimatedTokensSavedPerCall: 0,
      });
      continue;
    }

    if (activeTool !== undefined && proposedTool === undefined) {
      changedCount += 1;
      const saved = options.defaultToolTokens ?? 1000;
      totalSavedTokens += saved;
      toolDiffs.push({
        toolName: name,
        changeType: "removed",
        changes: {},
        estimatedTokensSavedPerCall: saved,
      });
      continue;
    }

    if (activeTool !== undefined && proposedTool !== undefined) {
      const changes: ProposalToolChanges = {};
      let isChanged = false;
      let toolSavings = 0;

      // 1. Check enabled state
      const activeEnabled = activeTool.enabled !== false;
      const proposedEnabled = proposedTool.enabled !== false;
      if (activeEnabled !== proposedEnabled) {
        changes.enabled = { before: activeEnabled, after: proposedEnabled };
        isChanged = true;
        if (activeEnabled && !proposedEnabled) {
          // Disabling a tool saves entire context payload
          toolSavings += options.defaultToolTokens ?? 1200;
        }
      }

      // 2. Check description changes
      if (activeTool.description !== proposedTool.description) {
        changes.description = {
          before: activeTool.description,
          after: proposedTool.description,
        };
        isChanged = true;
      }

      // 3. Check projection / fieldSelection changes
      const activeProj = activeTool.policy?.outputFields;
      const proposedProj = proposedTool.policy?.outputFields;
      const projChanged =
        JSON.stringify(activeProj) !== JSON.stringify(proposedProj);
      if (projChanged) {
        changes.projection = { before: activeProj, after: proposedProj };
        isChanged = true;

        if (proposedProj !== undefined) {
          if (proposedProj.exclude?.length) {
            // Excluding verbose/bloated fields typically saves 250-400 tokens per excluded field
            toolSavings += Math.min(proposedProj.exclude.length * 300, 1500);
          } else if (proposedProj.include?.length) {
            // Including only essential fields typically eliminates ~50% of payload bloat
            toolSavings += 650;
          }
        }
      }

      // 4. Check cache TTL changes
      const activeCache = activeTool.policy?.cacheTtlSeconds;
      const proposedCache = proposedTool.policy?.cacheTtlSeconds;
      if (activeCache !== proposedCache) {
        changes.cache = {
          before:
            activeCache !== undefined ? { ttlSeconds: activeCache } : undefined,
          after:
            proposedCache !== undefined
              ? { ttlSeconds: proposedCache }
              : undefined,
        };
        isChanged = true;
      }

      if (isChanged) {
        changedCount += 1;
        totalSavedTokens += toolSavings;
        toolDiffs.push({
          toolName: name,
          changeType: "modified",
          changes,
          estimatedTokensSavedPerCall: toolSavings,
        });
      } else {
        toolDiffs.push({
          toolName: name,
          changeType: "unchanged",
          changes: {},
          estimatedTokensSavedPerCall: 0,
        });
      }
    }
  }

  return {
    proposalRevisionId: options.proposalRevisionId ?? "pending",
    activeRevisionId: options.activeRevisionId,
    tenantId: options.tenantId,
    contractName: options.contractName,
    totalTools: allToolNames.length,
    changedToolsCount: changedCount,
    estimatedTotalTokensSavedPerCall: totalSavedTokens,
    toolDiffs,
  };
}

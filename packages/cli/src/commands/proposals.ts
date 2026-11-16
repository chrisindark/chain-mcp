import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
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
import { createFieldProjector } from "@chainmcp/core";
import { DynamicGateway } from "@chainmcp/gateway";
import { MemoryStorageDriver, type StorageDriver } from "@chainmcp/storage";

import {
  findConfigPath,
  loadServerConfigFile,
  pathExists,
} from "../config-loader.js";
import type {
  ProposalsCommandOptions,
  ProposalsCommandResult,
} from "../types.js";

/**
 * CLI command to list, diff, approve, and reject agent proposals.
 * Provides the terminal operator interface for Human-in-the-Loop (HITL) approval gates.
 */
export async function proposalsCommand(
  options: ProposalsCommandOptions = {},
): Promise<ProposalsCommandResult> {
  const cwd = options.cwd ?? process.cwd();
  const log = options.io?.stdout ?? console.log;
  const errLog = options.io?.stderr ?? console.error;
  const action = options.action ?? "list";

  // 1. Resolve configuration file
  let configPath: string | undefined;
  if (options.config !== undefined) {
    const resolved = resolve(cwd, options.config);
    if (!(await pathExists(resolved))) {
      const err = `Configuration file not found: ${resolved}`;
      if (!options.json) errLog(err);
      return { ok: false, action, error: err };
    }
    configPath = resolved;
  } else {
    configPath = await findConfigPath({ cwd });
  }

  if (!configPath || !(await pathExists(configPath))) {
    const err = "No configuration file found. Specify one with --config.";
    if (!options.json) errLog(err);
    return { ok: false, action, error: err };
  }

  try {
    const rawYaml = await readFile(configPath, "utf8");
    const isGateway =
      rawYaml.includes("contracts:") ||
      configPath.includes("gateway.config") ||
      configPath.includes("chainmcp.gateway");

    let storageConfig: StorageConfig | undefined;
    const bindings: DeclarativeAdminContractBinding[] = [];

    if (isGateway) {
      const { parse: parseYaml } = await import("yaml");
      const parsedRaw = parseYaml(rawYaml);
      const resolved = resolveConfigSecrets(parsedRaw);
      const gatewayConfig = parseGatewayConfig(resolved.config);
      storageConfig = gatewayConfig.storage;

      if (Array.isArray(gatewayConfig.contracts)) {
        for (const contract of gatewayConfig.contracts) {
          if (options.tenant && contract.tenantId !== options.tenant) continue;
          if (options.contract && contract.name !== options.contract) continue;

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
      bindings.push({
        tenantId: options.tenant ?? "default",
        contractName: options.contract ?? "default",
        destinationPolicy: {
          baseUrl: "http://127.0.0.1:8080",
          allowedHosts: ["127.0.0.1", "localhost"],
        },
      });
    }

    let storageDriver: StorageDriver;
    if (storageConfig && storageConfig.enabled) {
      const configured = createStorageDriverFromConfig(storageConfig);
      storageDriver = configured ?? new MemoryStorageDriver();
    } else {
      storageDriver = new MemoryStorageDriver();
    }
    await storageDriver.init();

    const repository = await StorageDescriptorRevisionStore.open(storageDriver);
    const gateway = new DynamicGateway({
      projector: createFieldProjector(),
    });

    const admin = new DeclarativeAdmin({
      gateway,
      tokens: [
        {
          id: "cli-operator",
          token: "0".repeat(MIN_DECLARATIVE_ADMIN_TOKEN_LENGTH),
          tenants: options.tenant ? [options.tenant] : "*",
        },
      ],
      contracts: bindings,
      repository,
      storageDriver,
    });

    try {
      await admin.restore();
    } catch {
      // Non-fatal if initial store is empty
    }

    // 2. Execute Action
    if (action === "list") {
      const targetBindings = bindings.filter((b) => {
        if (options.tenant && b.tenantId !== options.tenant) return false;
        if (options.contract && b.contractName !== options.contract)
          return false;
        return true;
      });

      const allProposals: unknown[] = [];
      for (const b of targetBindings) {
        const list = await repository
          .listProposals(b.tenantId, b.contractName)
          .catch(() => []);
        allProposals.push(
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

      if (options.json) {
        log(
          JSON.stringify(
            { ok: true, proposals: allProposals, count: allProposals.length },
            null,
            2,
          ),
        );
      } else {
        log(`ChainMcp Pending Agent Proposals (${allProposals.length})`);
        log("=".repeat(60));
        if (allProposals.length === 0) {
          log(
            "No pending proposals found. All changes are currently up to date.",
          );
        } else {
          for (const raw of allProposals) {
            const p = raw as {
              revisionId: string;
              tenantId: string;
              contractName: string;
              proposedBy?: string;
              createdAt: number;
              proposalReason?: string;
              estimatedTokenSavings?: number;
              toolCount: number;
            };
            log(
              `• [${p.revisionId}] ${p.tenantId} / ${p.contractName} (${p.toolCount} tools)`,
            );
            log(
              `  Proposed By: ${p.proposedBy ?? "agent"} | Created: ${new Date(p.createdAt).toISOString()}`,
            );
            if (p.estimatedTokenSavings) {
              log(
                `  Estimated Savings: ~${p.estimatedTokenSavings} tokens / call`,
              );
            }
            if (p.proposalReason) {
              log(`  Reason: ${p.proposalReason}`);
            }
            log("");
          }
        }
      }

      await storageDriver.close();
      return { ok: true, action: "list", proposals: allProposals };
    }

    if (action === "diff") {
      if (!options.revisionId) {
        const err =
          "A revision ID is required for proposals diff (e.g. chainmcp proposals diff dset_...)";
        if (!options.json) errLog(err);
        await storageDriver.close();
        return { ok: false, action: "diff", error: err };
      }

      // Locate the proposal across bindings
      let foundBinding: DeclarativeAdminContractBinding | undefined;
      let foundRecord: unknown;
      for (const b of bindings) {
        if (options.tenant && b.tenantId !== options.tenant) continue;
        if (options.contract && b.contractName !== options.contract) continue;
        const rec = await repository.getRevision(
          b.tenantId,
          b.contractName,
          options.revisionId,
        );
        if (rec) {
          foundBinding = b;
          foundRecord = rec;
          break;
        }
      }

      if (!foundBinding || !foundRecord) {
        const err = `Proposal revision '${options.revisionId}' was not found.`;
        if (!options.json) errLog(err);
        await storageDriver.close();
        return { ok: false, action: "diff", error: err };
      }

      const diffResult = await admin.getProposalDiff(
        foundBinding.tenantId,
        foundBinding.contractName,
        options.revisionId,
      );

      if (options.json) {
        log(JSON.stringify(diffResult, null, 2));
      } else {
        log(`Proposal Diff Report: ${options.revisionId}`);
        log(
          `Contract: ${foundBinding.tenantId} / ${foundBinding.contractName}`,
        );
        log(
          `Total Tools: ${diffResult.diff.totalTools} | Changed Tools: ${diffResult.diff.changedToolsCount}`,
        );
        log(
          `Estimated Token Savings: ~${diffResult.diff.estimatedTotalTokensSavedPerCall} tokens/call`,
        );
        log("-".repeat(60));
        for (const t of diffResult.diff.toolDiffs) {
          if (t.changeType === "unchanged") continue;
          log(`• Tool '${t.toolName}': [${t.changeType.toUpperCase()}]`);
          if (t.changes.enabled) {
            log(
              `    Enabled: ${t.changes.enabled.before} -> ${t.changes.enabled.after}`,
            );
          }
          if (t.changes.projection) {
            log(
              `    Projection: ${JSON.stringify(t.changes.projection.before)} -> ${JSON.stringify(t.changes.projection.after)}`,
            );
          }
          if (t.changes.cache) {
            log(
              `    Cache TTL: ${t.changes.cache.before?.ttlSeconds ?? "none"}s -> ${t.changes.cache.after?.ttlSeconds ?? "none"}s`,
            );
          }
          if (t.estimatedTokensSavedPerCall) {
            log(
              `    Estimated Savings: ~${t.estimatedTokensSavedPerCall} tokens`,
            );
          }
        }
      }

      await storageDriver.close();
      return {
        ok: true,
        action: "diff",
        diff: diffResult.diff,
        proposal: diffResult.proposal,
      };
    }

    if (action === "approve") {
      if (!options.revisionId) {
        const err =
          "A revision ID is required for proposals approve (e.g. chainmcp proposals approve dset_...)";
        if (!options.json) errLog(err);
        await storageDriver.close();
        return { ok: false, action: "approve", error: err };
      }

      let foundBinding: DeclarativeAdminContractBinding | undefined;
      for (const b of bindings) {
        if (options.tenant && b.tenantId !== options.tenant) continue;
        if (options.contract && b.contractName !== options.contract) continue;
        const rec = await repository.getRevision(
          b.tenantId,
          b.contractName,
          options.revisionId,
        );
        if (rec) {
          foundBinding = b;
          break;
        }
      }

      if (!foundBinding) {
        const err = `Proposal revision '${options.revisionId}' was not found.`;
        if (!options.json) errLog(err);
        await storageDriver.close();
        return { ok: false, action: "approve", error: err };
      }

      const approveRes = await admin.approveProposal({
        tenantId: foundBinding.tenantId,
        contractName: foundBinding.contractName,
        revisionId: options.revisionId,
        reviewedBy: "cli-operator",
        comment: options.comment ?? "Approved via CLI",
        tokenId: "cli-operator",
      });

      if (options.json) {
        log(JSON.stringify(approveRes, null, 2));
      } else {
        log(`✓ Proposal '${options.revisionId}' approved!`);
        log(
          `  Contract: ${foundBinding.tenantId} / ${foundBinding.contractName}`,
        );
        log(`  Live Gateway Revision: ${approveRes.gatewayRevisionId}`);
        log(`  Active Tools: ${approveRes.toolCount}`);
        log("  Status: active (atomically published with reversible rollback)");
      }

      await storageDriver.close();
      return { ok: true, action: "approve", result: approveRes };
    }

    if (action === "reject") {
      if (!options.revisionId) {
        const err =
          "A revision ID is required for proposals reject (e.g. chainmcp proposals reject dset_...)";
        if (!options.json) errLog(err);
        await storageDriver.close();
        return { ok: false, action: "reject", error: err };
      }

      let foundBinding: DeclarativeAdminContractBinding | undefined;
      for (const b of bindings) {
        if (options.tenant && b.tenantId !== options.tenant) continue;
        if (options.contract && b.contractName !== options.contract) continue;
        const rec = await repository.getRevision(
          b.tenantId,
          b.contractName,
          options.revisionId,
        );
        if (rec) {
          foundBinding = b;
          break;
        }
      }

      if (!foundBinding) {
        const err = `Proposal revision '${options.revisionId}' was not found.`;
        if (!options.json) errLog(err);
        await storageDriver.close();
        return { ok: false, action: "reject", error: err };
      }

      const rejectRes = await admin.rejectProposal({
        tenantId: foundBinding.tenantId,
        contractName: foundBinding.contractName,
        revisionId: options.revisionId,
        reviewedBy: "cli-operator",
        reason: options.reason ?? "Rejected via CLI",
        tokenId: "cli-operator",
      });

      if (options.json) {
        log(JSON.stringify(rejectRes, null, 2));
      } else {
        log(`✓ Proposal '${options.revisionId}' rejected.`);
        log(
          `  Contract: ${foundBinding.tenantId} / ${foundBinding.contractName}`,
        );
        log("  Gateway active runtime state remains unchanged.");
      }

      await storageDriver.close();
      return { ok: true, action: "reject", result: rejectRes };
    }

    await storageDriver.close();
    return { ok: false, action, error: `Unknown action: ${action}` };
  } catch (error) {
    const err = error instanceof Error ? error.message : String(error);
    if (!options.json) errLog(`Error executing proposals command: ${err}`);
    return { ok: false, action, error: err };
  }
}

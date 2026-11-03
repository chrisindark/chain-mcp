import type { ToolDefinition, ToolSource } from "@chainmcp/core";
import type { UpstreamExecutor } from "@chainmcp/executor";

import { normalizeAuthSchemeMap } from "./auth-schemes.js";
import {
  declarativeToolPolicy,
  parseDeclarativeToolDescriptor,
  type ParsedDeclarativeTool,
} from "./descriptor.js";
import {
  DeclarativeDescriptorError,
  MAX_DECLARATIVE_DESCRIPTORS,
  type DeclarativeAuthSchemeMap,
} from "./types.js";

export interface DeclarativeToolSourceOptions {
  /** Untrusted descriptor documents; each is validated at construction. */
  descriptors: readonly unknown[];
  /** The deployment's bounded executor. Descriptors never perform their own HTTP. */
  executor: UpstreamExecutor;
  /** Credential shape for referenced schemes. Contains no secrets. */
  authSchemes?: DeclarativeAuthSchemeMap;
}

/**
 * A `ToolSource` for versioned declarative HTTP descriptors. Construction
 * validates every descriptor and lowers it through the deployment's
 * `UpstreamExecutor`, so an invalid descriptor cannot be registered and a
 * valid one shares the executor's SSRF, redirect, timeout, and response-cap
 * guarantees.
 */
export class DeclarativeToolSource implements ToolSource {
  private readonly parsedTools: readonly ParsedDeclarativeTool[];
  private readonly tools: readonly ToolDefinition[];

  constructor(private readonly options: DeclarativeToolSourceOptions) {
    if (typeof options !== "object" || options === null) {
      throw new DeclarativeDescriptorError(
        "EXECUTOR_INVALID",
        "DeclarativeToolSource options must be an object",
      );
    }
    if (
      !options.executor ||
      typeof options.executor.createTool !== "function"
    ) {
      throw new DeclarativeDescriptorError(
        "EXECUTOR_INVALID",
        "DeclarativeToolSource requires an UpstreamExecutor with createTool()",
      );
    }
    if (!Array.isArray(options.descriptors)) {
      throw new DeclarativeDescriptorError(
        "DESCRIPTOR_INVALID",
        "DeclarativeToolSource requires an array of descriptors",
      );
    }
    if (options.descriptors.length > MAX_DECLARATIVE_DESCRIPTORS) {
      throw new DeclarativeDescriptorError(
        "DESCRIPTOR_INVALID",
        `A source cannot declare more than ${MAX_DECLARATIVE_DESCRIPTORS} descriptors`,
      );
    }

    const schemes = normalizeAuthSchemeMap(options.authSchemes);
    const parsed: ParsedDeclarativeTool[] = [];
    const names = new Set<string>();

    options.descriptors.forEach((descriptor, index) => {
      let tool: ParsedDeclarativeTool;
      try {
        tool = parseDeclarativeToolDescriptor(descriptor, {
          authSchemes: schemes,
        });
      } catch (error) {
        if (error instanceof DeclarativeDescriptorError) {
          throw new DeclarativeDescriptorError(
            error.code,
            `descriptors[${index}]: ${error.message}`,
            error.issues,
          );
        }
        throw error;
      }
      if (names.has(tool.descriptor.name)) {
        throw new DeclarativeDescriptorError(
          "NAME_DUPLICATE",
          `descriptors[${index}]: tool '${tool.descriptor.name}' is already defined in this source`,
        );
      }
      names.add(tool.descriptor.name);
      parsed.push(tool);
    });

    this.parsedTools = Object.freeze(parsed);
    this.tools = Object.freeze(
      this.parsedTools.map((tool) => this.createTool(tool)),
    );
  }

  getTools(): readonly ToolDefinition[] {
    return this.tools;
  }

  /** Validated descriptors and revisions, for preview and diagnostics. */
  getDescriptors(): readonly ParsedDeclarativeTool[] {
    return this.parsedTools;
  }

  private createTool(parsed: ParsedDeclarativeTool): ToolDefinition {
    let base: ToolDefinition;
    try {
      base = this.options.executor.createTool(parsed.operation);
    } catch (error) {
      throw new DeclarativeDescriptorError(
        "EXECUTOR_INVALID",
        `Descriptor '${parsed.descriptor.name}' could not be bound to the executor: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
    }
    const policy = declarativeToolPolicy(parsed.descriptor);
    return {
      ...base,
      // A per-descriptor revision keeps cache keys and traces isolated across
      // descriptor edits even when several tools share one deployment base URL.
      contractRevision: parsed.revision,
      ...(policy.cache === undefined ? {} : { cache: policy.cache }),
      ...(policy.output === undefined ? {} : { output: policy.output }),
      ...(policy.timeoutMs === undefined
        ? {}
        : { timeoutMs: policy.timeoutMs }),
    };
  }
}

export function createDeclarativeToolSource(
  options: DeclarativeToolSourceOptions,
): DeclarativeToolSource {
  return new DeclarativeToolSource(options);
}

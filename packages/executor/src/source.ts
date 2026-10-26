import type { ToolDefinition, ToolSource } from "@chainmcp/core";
import type { CompiledOperation } from "@chainmcp/compiler";
import type { UpstreamExecutor } from "./types.js";

export interface OpenApiToolSourceOptions {
  executor: UpstreamExecutor;
  operations: readonly CompiledOperation[];
}

export class OpenApiToolSource implements ToolSource {
  private readonly tools: readonly ToolDefinition[];

  constructor(options: OpenApiToolSourceOptions) {
    if (!options || typeof options !== "object") {
      throw new TypeError("OpenApiToolSource options must be an object");
    }
    if (
      !options.executor ||
      typeof options.executor.createTools !== "function"
    ) {
      throw new TypeError(
        "OpenApiToolSource requires an UpstreamExecutor with createTools()",
      );
    }
    if (!Array.isArray(options.operations)) {
      throw new TypeError(
        "OpenApiToolSource requires an array of CompiledOperation",
      );
    }
    this.tools = Object.freeze(
      options.executor.createTools(options.operations),
    );
  }

  getTools(): readonly ToolDefinition[] {
    return this.tools;
  }
}

export function createOpenApiToolSource(
  options: OpenApiToolSourceOptions,
): OpenApiToolSource {
  return new OpenApiToolSource(options);
}

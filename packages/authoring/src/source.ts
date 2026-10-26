import type { ToolDefinition, ToolSource } from "@chainmcp/core";
import { defineTool } from "./define-tool.js";
import { AuthoringError, type DefineToolOptions } from "./types.js";

/**
 * ManualToolSource allows authoring and managing tools manually in code.
 * Implements ToolSource to be registered seamlessly with ToolRuntime.registerSource().
 */
export class ManualToolSource implements ToolSource {
  private readonly tools = new Map<string, ToolDefinition>();

  constructor(tools?: readonly ToolDefinition[]) {
    if (tools) {
      for (const tool of tools) {
        this.addTool(tool);
      }
    }
  }

  addTool(tool: ToolDefinition): this {
    if (!tool || typeof tool !== "object" || typeof tool.name !== "string") {
      throw new TypeError("addTool requires a valid ToolDefinition");
    }
    if (this.tools.has(tool.name)) {
      throw new AuthoringError(
        "INVALID_TOOL_DEFINITION",
        `Tool '${tool.name}' is already defined in this source`,
      );
    }
    this.tools.set(tool.name, tool);
    return this;
  }

  defineTool<TInput = unknown, TOutput = unknown>(
    options: DefineToolOptions<TInput, TOutput>,
  ): ToolDefinition<TInput, TOutput> {
    const tool = defineTool(options);
    this.addTool(tool as ToolDefinition);
    return tool;
  }

  getTools(): readonly ToolDefinition[] {
    return Object.freeze(Array.from(this.tools.values()));
  }
}

export function createManualToolSource(
  tools?: readonly ToolDefinition[],
): ManualToolSource {
  return new ManualToolSource(tools);
}

import { defineTool } from "@chainmcp/authoring";
import { z } from "zod";

export const calculatorTool = defineTool({
  name: "calculate",
  description: "Performs basic mathematical calculations",
  schema: z.object({
    operation: z
      .enum(["add", "subtract", "multiply", "divide"])
      .describe("Mathematical operation to perform"),
    a: z.number().describe("First operand"),
    b: z.number().describe("Second operand"),
  }),
  execute: async ({ operation, a, b }) => {
    switch (operation) {
      case "add":
        return { result: a + b };
      case "subtract":
        return { result: a - b };
      case "multiply":
        return { result: a * b };
      case "divide": {
        if (b === 0) {
          throw new Error("Division by zero is not allowed");
        }
        return { result: a / b };
      }
    }
  },
});

export const textAnalyzerTool = defineTool({
  name: "analyze_text",
  description:
    "Analyzes textual content reporting length, word count, and character counts",
  schema: z.object({
    text: z.string().min(1).describe("Text to analyze"),
    includeWords: z
      .boolean()
      .default(true)
      .describe("Whether to include word count breakdown"),
  }),
  execute: async ({ text, includeWords }) => {
    const characters = text.length;
    const lines = text.split("\n").length;
    const words = includeWords
      ? text.trim().split(/\s+/).filter(Boolean).length
      : undefined;

    return {
      characters,
      lines,
      ...(words !== undefined ? { words } : {}),
    };
  },
});

export const tools = [calculatorTool, textAnalyzerTool];

import { describe, expect, it } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { InMemoryToolRuntime } from "@chainmcp/core";
import { connectMcpServer } from "@chainmcp/server";
import { tools } from "../src/tools.js";

describe("examples/code-first", () => {
  it("exposes tools and serves them to an MCP client over InMemoryTransport", async () => {
    const runtime = new InMemoryToolRuntime();
    for (const tool of tools) {
      runtime.register(tool);
    }

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    const client = new Client(
      { name: "code-first-client", version: "0.1.0" },
      { capabilities: {} },
    );

    await connectMcpServer(runtime, serverTransport, {
      name: "example-code-first",
      version: "0.1.0",
      createContext: () => ({
        requestId: "req-1",
        tenantId: "default",
        principal: { id: "caller", scopes: [] },
      }),
    });

    await client.connect(clientTransport);

    // 1. List tools
    const toolList = await client.listTools();
    const toolNames = toolList.tools.map((t) => t.name);
    expect(toolNames).toContain("calculate");
    expect(toolNames).toContain("analyze_text");

    // 2. Call calculate tool (addition)
    const calcResult = await client.callTool({
      name: "calculate",
      arguments: {
        operation: "add",
        a: 10,
        b: 25,
      },
    });

    expect(calcResult.isError).toBeFalsy();
    const calcText = (calcResult.content[0] as { type: "text"; text: string })
      .text;
    expect(JSON.parse(calcText)).toEqual({ result: 35 });

    // 3. Call calculate tool with invalid operation
    const invalidOpResult = await client.callTool({
      name: "calculate",
      arguments: {
        operation: "mod",
        a: 10,
        b: 5,
      },
    });
    expect(invalidOpResult.isError).toBe(true);

    // 4. Call analyze_text tool
    const analyzeResult = await client.callTool({
      name: "analyze_text",
      arguments: {
        text: "The quick brown fox jumps over the lazy dog",
        includeWords: true,
      },
    });

    expect(analyzeResult.isError).toBeFalsy();
    const analyzeText = (
      analyzeResult.content[0] as { type: "text"; text: string }
    ).text;
    expect(JSON.parse(analyzeText)).toEqual({
      characters: 43,
      lines: 1,
      words: 9,
    });
  });
});

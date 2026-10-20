import { InMemoryToolRuntime, RuntimeError } from "@chainmcp/core";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PassThrough, Writable } from "node:stream";

import type { ToolContext, ToolRuntime } from "@chainmcp/core";
import {
  connectMcpServer,
  createMcpServer,
  type McpRequestContext,
  type McpServerOptions,
  serveStdio,
} from "../src/index.js";

const context = {
  requestId: "test-request",
  tenantId: "test-tenant",
  principal: { id: "test-principal", scopes: [] },
};

const clients: Client[] = [];
const servers: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function connected(
  runtime: ToolRuntime,
  options: Partial<
    Pick<McpServerOptions, "createContext" | "maxResponseBytes">
  > = {},
) {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "chainmcp-test-client", version: "0.1.0" });
  const connectedServer = await connectMcpServer(runtime, serverTransport, {
    name: "chainmcp-test-server",
    version: "0.1.0",
    createContext: options.createContext ?? (() => context),
    ...options,
  });
  clients.push(client);
  servers.push(connectedServer);
  await client.connect(clientTransport);
  return client;
}

describe("MCP runtime adapter", () => {
  it("lists runtime tools and invokes them end to end through an MCP client", async () => {
    const runtime = new InMemoryToolRuntime();
    let createdContext: ToolContext | undefined;
    let receivedRequest: McpRequestContext | undefined;
    runtime.register({
      name: "lookup_item",
      description: "Look up one item",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
      operation: {},
      execute: async (input, executionContext) => {
        createdContext = executionContext;
        return { item: (input as { id: string }).id };
      },
    });
    const client = await connected(runtime, {
      createContext: (request) => {
        receivedRequest = request;
        return {
          ...context,
          requestId: String(request.id),
          signal: request.signal,
        };
      },
    });

    const listed = await client.listTools();
    expect(listed.tools).toHaveLength(1);
    expect(listed.tools[0]).toMatchObject({
      name: "lookup_item",
      description: "Look up one item",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
    });

    const result = await client.callTool({
      name: "lookup_item",
      arguments: { id: "abc" },
    });
    expect(result.isError).not.toBe(true);
    expect(result.content).toEqual([{ type: "text", text: '{"item":"abc"}' }]);
    expect(receivedRequest?.id).toBeDefined();
    expect(receivedRequest?.signal).toBeInstanceOf(AbortSignal);
    expect(createdContext?.requestId).toBe(String(receivedRequest?.id));
    expect(createdContext?.signal).toBeDefined();
  });

  it("classifies context creation failures as authorization errors and records metrics", async () => {
    const record = vi.fn();
    const runtime = new InMemoryToolRuntime({ metrics: { record } });
    const execute = vi.fn(async () => "must not execute");
    runtime.register({
      name: "context_tool",
      description: "Requires context",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      operation: {},
      execute,
    });
    const client = await connected(runtime, {
      createContext: () => {
        throw new Error("private identity provider detail");
      },
    });

    const result = await client.callTool({
      name: "context_tool",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      { type: "text", text: "AUTH_FORBIDDEN: Access denied" },
    ]);
    expect(execute).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "unknown",
        toolName: "context_tool",
        outcome: "error",
        errorCode: "AUTH_FORBIDDEN",
      }),
    );
  });

  it("preserves typed context factory failures instead of flattening them", async () => {
    const record = vi.fn();
    const runtime = new InMemoryToolRuntime({ metrics: { record } });
    runtime.register({
      name: "context_tool",
      description: "Requires context",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      operation: {},
      execute: async () => "must not execute",
    });
    const client = await connected(runtime, {
      createContext: () => {
        throw new RuntimeError(
          "UPSTREAM_FAILURE",
          "identity provider unavailable",
        );
      },
    });

    const result = await client.callTool({
      name: "context_tool",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      { type: "text", text: "UPSTREAM_FAILURE: Tool invocation failed" },
    ]);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "unknown",
        toolName: "context_tool",
        outcome: "error",
        errorCode: "UPSTREAM_FAILURE",
      }),
    );
  });

  it("dispatches on the declared tenancy mode, not the runtime class", async () => {
    const listed: Array<ToolContext | undefined> = [];
    const custom: ToolRuntime = {
      tenantMode: "multi-tenant",
      register: () => {},
      listTools: (caller) => {
        listed.push(caller);
        return caller?.tenantId === context.tenantId
          ? [
              {
                name: "custom_tool",
                description: "Tool from a custom runtime",
                inputSchema: {
                  type: "object",
                  properties: {},
                  additionalProperties: false,
                },
              },
            ]
          : [];
      },
      callTool: async () => "custom result",
    };
    const client = await connected(custom);

    const { tools } = await client.listTools();
    expect(tools.map(({ name }) => name)).toEqual(["custom_tool"]);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ tenantId: context.tenantId });

    const result = await client.callTool({
      name: "custom_tool",
      arguments: {},
    });
    expect(result.content).toEqual([{ type: "text", text: '"custom result"' }]);
  });

  it("maps known runtime failures to safe MCP error results", async () => {
    const runtime = new InMemoryToolRuntime();
    runtime.register({
      name: "private_tool",
      description: "Private",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      operation: {},
      execute: async () => {
        throw new RuntimeError(
          "UPSTREAM_FAILURE",
          "secret-token-value from private executor",
          {
            cause: new Error("secret-cause-value"),
          },
        );
      },
    });
    const client = await connected(runtime);

    const result = await client.callTool({
      name: "private_tool",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      { type: "text", text: "UPSTREAM_FAILURE: Tool invocation failed" },
    ]);
    expect(JSON.stringify(result)).not.toContain("secret-token-value");
    expect(JSON.stringify(result)).not.toContain("secret-cause-value");
  });

  it("keeps MCP schema validation and runtime validation aligned", async () => {
    const runtime = new InMemoryToolRuntime();
    const execute = vi.fn(async () => "unexpected");
    runtime.register({
      name: "strict_tool",
      description: "Strict",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
      operation: {},
      execute,
    });
    const client = await connected(runtime);
    const runtimeCall = vi.spyOn(runtime, "callTool");

    const result = await client.callTool({
      name: "strict_tool",
      arguments: { id: 42, unexpected: true },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toMatch(/input validation error/i);
    expect(runtimeCall).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    await expect(
      runtime.callTool("strict_tool", { id: 42, unexpected: true }, () =>
        Promise.resolve(context),
      ),
    ).rejects.toMatchObject({ code: "INPUT_INVALID" });
  });

  it("rejects nullable root schemas because MCP tool arguments must be objects", () => {
    const runtime = new InMemoryToolRuntime();
    runtime.register({
      name: "nullable_root",
      description: "A nullable root must not be exposed as an MCP tool",
      inputSchema: { type: ["object", "null"] },
      operation: {},
      execute: async () => "must not execute",
    });

    expect(() =>
      createMcpServer(runtime, {
        name: "nullable-root-server",
        version: "0.1.0",
        createContext: () => context,
      }),
    ).toThrow("must declare an object input schema");
  });

  it("maps a non-JSON result to a safe upstream failure", async () => {
    const runtime = new InMemoryToolRuntime();
    runtime.register({
      name: "undefined_tool",
      description: "Returns no JSON value",
      inputSchema: { type: "object", additionalProperties: false },
      operation: {},
      execute: async () => undefined,
    });
    const client = await connected(runtime);

    const result = await client.callTool({
      name: "undefined_tool",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      { type: "text", text: "UPSTREAM_FAILURE: Tool invocation failed" },
    ]);
  });

  it("maps runtime timeouts to the matching safe MCP error", async () => {
    const runtime = new InMemoryToolRuntime();
    runtime.register({
      name: "timeout_tool",
      description: "Never completes",
      inputSchema: { type: "object", additionalProperties: false },
      operation: {},
      timeoutMs: 5,
      execute: async () => new Promise(() => {}),
    });
    const client = await connected(runtime);

    const result = await client.callTool({
      name: "timeout_tool",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      { type: "text", text: "UPSTREAM_TIMEOUT: Tool call timed out" },
    ]);
  });

  it("propagates MCP request cancellation to the runtime execution signal", async () => {
    const runtime = new InMemoryToolRuntime();
    let executionSignal: AbortSignal | undefined;
    runtime.register({
      name: "cancel_tool",
      description: "Waits for cancellation",
      inputSchema: { type: "object", additionalProperties: false },
      operation: {},
      execute: async (_input, executionContext) =>
        new Promise((_resolve, reject) => {
          executionSignal = executionContext.signal;
          executionSignal?.addEventListener(
            "abort",
            () => reject(new RuntimeError("CANCELLED", "cancelled")),
            { once: true },
          );
        }),
    });
    const client = await connected(runtime);
    const controller = new AbortController();

    const call = client.callTool(
      { name: "cancel_tool", arguments: {} },
      { signal: controller.signal },
    );
    await vi.waitFor(() => expect(executionSignal).toBeInstanceOf(AbortSignal));
    controller.abort();

    await expect(call).rejects.toBeDefined();
    await vi.waitFor(() => expect(executionSignal?.aborted).toBe(true));
  });

  it("rejects invalid response limits and maps oversize outputs safely", async () => {
    const runtime = new InMemoryToolRuntime();
    runtime.register({
      name: "large_tool",
      description: "Large",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      operation: {},
      execute: async () => "x".repeat(100),
    });
    expect(() =>
      createMcpServer(runtime, {
        name: "invalid",
        version: "1",
        createContext: () => context,
        maxResponseBytes: 0,
      }),
    ).toThrow("maxResponseBytes");
    expect(() =>
      createMcpServer(runtime, {
        name: "invalid",
        version: "1",
        createContext: () => context,
        maxResponseBytes: 100_000_001,
      }),
    ).toThrow("maxResponseBytes");

    const client = await connected(runtime, { maxResponseBytes: 10 });
    const result = await client.callTool({ name: "large_tool", arguments: {} });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      {
        type: "text",
        text: "UPSTREAM_FAILURE: Tool invocation failed",
      },
    ]);
  });

  it("closes an active MCP session idempotently", async () => {
    const runtime = new InMemoryToolRuntime();
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({
      name: "chainmcp-test-client",
      version: "0.1.0",
    });
    const onclose = vi.fn();
    const server = await connectMcpServer(runtime, serverTransport, {
      name: "chainmcp-test-server",
      version: "0.1.0",
      createContext: () => context,
      onclose,
    });
    await client.connect(clientTransport);
    let secondCloseSettled = false;
    let releaseTransportClose: (() => void) | undefined;
    const closeGate = new Promise<void>((resolve) => {
      releaseTransportClose = resolve;
    });
    const closeTransport = serverTransport.close.bind(serverTransport);
    vi.spyOn(serverTransport, "close").mockImplementation(async () => {
      await closeGate;
      await closeTransport();
    });
    const firstClose = server.close();
    const secondClose = server.close().then(() => {
      secondCloseSettled = true;
    });
    await Promise.resolve();
    expect(secondCloseSettled).toBe(false);
    releaseTransportClose?.();
    await Promise.all([firstClose, secondClose, server.closed]);
    expect(secondCloseSettled).toBe(true);
    expect(onclose).toHaveBeenCalledOnce();
    await client.close();
  });

  it("propagates peer transport closure through the closed promise and callback", async () => {
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({
      name: "chainmcp-peer-close-test",
      version: "0.1.0",
    });
    const onclose = vi.fn();
    const server = await connectMcpServer(
      new InMemoryToolRuntime(),
      serverTransport,
      {
        name: "chainmcp-peer-close-server",
        version: "0.1.0",
        createContext: () => context,
        onclose,
      },
    );
    await client.connect(clientTransport);

    await client.close();
    await server.closed;
    expect(onclose).toHaveBeenCalledOnce();
  });

  it("closes stdio on EOF and propagates the close event", async () => {
    const stdin = new PassThrough();
    const stdout = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    const onclose = vi.fn();
    const connected = await serveStdio(
      new InMemoryToolRuntime(),
      {
        name: "chainmcp-stdio-test",
        version: "0.1.0",
        createContext: () => context,
        onclose,
      },
      { stdin, stdout, handleProcessSignals: false },
    );

    stdin.end();
    await connected.closed;
    expect(onclose).toHaveBeenCalledOnce();
    expect(stdin.listenerCount("end")).toBe(0);
    stdin.destroy();
    stdout.destroy();
  });

  it("closes stdio when its application abort signal fires", async () => {
    const stdin = new PassThrough();
    const stdout = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    const controller = new AbortController();
    const connected = await serveStdio(
      new InMemoryToolRuntime(),
      {
        name: "chainmcp-stdio-abort-test",
        version: "0.1.0",
        createContext: () => context,
      },
      {
        stdin,
        stdout,
        signal: controller.signal,
        handleProcessSignals: false,
      },
    );

    controller.abort();
    await connected.closed;
    stdin.destroy();
    stdout.destroy();
  });

  it.each([
    { signal: "SIGINT" as const, exitCode: 130 },
    { signal: "SIGTERM" as const, exitCode: 143 },
  ])("gracefully closes stdio on $signal", async ({ signal, exitCode }) => {
    const stdin = new PassThrough();
    const stdout = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    const previousExitCode = process.exitCode;
    const previousSignalListeners = process.listenerCount(signal);
    const connected = await serveStdio(
      new InMemoryToolRuntime(),
      {
        name: "chainmcp-stdio-signal-test",
        version: "0.1.0",
        createContext: () => context,
      },
      { stdin, stdout },
    );

    process.emit(signal);
    await connected.closed;
    expect(process.exitCode).toBe(exitCode);
    expect(process.listenerCount(signal)).toBe(previousSignalListeners);
    process.exitCode = previousExitCode;
    stdin.destroy();
    stdout.destroy();
  });

  it("closes the transport after connect failure and preserves the failure", async () => {
    const [, transport] = InMemoryTransport.createLinkedPair();
    const failure = new Error("transport start failed");
    vi.spyOn(transport, "start").mockRejectedValue(failure);
    const close = vi.spyOn(transport, "close");
    const onclose = vi.fn();

    await expect(
      connectMcpServer(new InMemoryToolRuntime(), transport, {
        name: "chainmcp-failure-test",
        version: "0.1.0",
        createContext: () => context,
        onclose,
      }),
    ).rejects.toBe(failure);
    expect(close).toHaveBeenCalled();
    expect(onclose).toHaveBeenCalledOnce();
  });
});

describe("multi-tenant per-request listing (ADR 0008)", () => {
  const tenantContext = (tenantId: string): ToolContext => ({
    requestId: `request-${tenantId}`,
    tenantId,
    principal: { id: `user-${tenantId}`, scopes: [] },
  });

  function multiTenantRuntime(): InMemoryToolRuntime {
    const runtime = new InMemoryToolRuntime({
      tenantMode: "multi-tenant",
      authorizer: { authorize: () => {} },
    });
    runtime.register({
      name: "lookup_item",
      description: "Tenant one tool",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
      operation: {},
      ownerTenantId: "tenant-1",
      execute: async (input) => ({ item: (input as { id: string }).id }),
    });
    runtime.register({
      name: "secret_tool",
      description: "Tenant two tool",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      operation: {},
      ownerTenantId: "tenant-2",
      execute: async () => ({ secret: true }),
    });
    return runtime;
  }

  it("scopes tools/list to the caller's tenant and re-scopes per request", async () => {
    const receivedTenants: string[] = [];
    let currentTenant = "tenant-1";
    const client = await connected(multiTenantRuntime(), {
      createContext: (request) => {
        expect(request.signal).toBeInstanceOf(AbortSignal);
        expect(request.id).toBeDefined();
        receivedTenants.push(currentTenant);
        return tenantContext(currentTenant);
      },
    });

    expect((await client.listTools()).tools.map(({ name }) => name)).toEqual([
      "lookup_item",
    ]);

    currentTenant = "tenant-2";
    expect((await client.listTools()).tools.map(({ name }) => name)).toEqual([
      "secret_tool",
    ]);

    expect(receivedTenants).toEqual(["tenant-1", "tenant-2"]);
  });

  it("declares the tools capability without list-changed notifications", async () => {
    const client = await connected(multiTenantRuntime(), {
      createContext: () => tenantContext("tenant-1"),
    });
    const capabilities = client.getServerCapabilities();
    expect(capabilities).toMatchObject({ tools: {} });
    expect((await client.listTools()).tools.map(({ name }) => name)).toEqual([
      "lookup_item",
    ]);
  });

  it("fails closed listing when identity cannot be established", async () => {
    const client = await connected(multiTenantRuntime(), {
      createContext: () => {
        throw new Error("private identity provider detail");
      },
    });
    await expect(client.listTools()).rejects.toThrow(/Access denied/);
  });

  it("invokes only same-tenant tools with unknown-tool indistinguishability", async () => {
    let currentTenant = "tenant-2";
    const client = await connected(multiTenantRuntime(), {
      createContext: () => tenantContext(currentTenant),
    });

    const allowed = await client.callTool({
      name: "secret_tool",
      arguments: {},
    });
    expect(allowed.isError).not.toBe(true);
    expect(allowed.content).toEqual([
      { type: "text", text: '{"secret":true}' },
    ]);

    const crossTenant = await client.callTool({
      name: "lookup_item",
      arguments: { id: "x" },
    });
    expect(crossTenant.isError).toBe(true);
    expect(crossTenant.content).toEqual([
      { type: "text", text: "TOOL_NOT_FOUND: Tool not found" },
    ]);
    const unknownTool = await client.callTool({
      name: "no_such_tool",
      arguments: {},
    });
    expect(unknownTool.content).toEqual(crossTenant.content);

    currentTenant = "tenant-1";
    const switched = await client.callTool({
      name: "lookup_item",
      arguments: { id: "y" },
    });
    expect(switched.content).toEqual([{ type: "text", text: '{"item":"y"}' }]);
  });
});

import {
  InMemoryToolRuntime,
  RuntimeError,
  type ToolContext,
  type ToolDefinition,
} from "@chainmcp/core";
import { describe, expect, it, vi } from "vitest";

import { OperationScopeAuthorizer } from "../src/index.js";

const context = (scopes: string[]): ToolContext => ({
  requestId: "request-1",
  tenantId: "tenant-1",
  principal: { id: "user-1", scopes },
});

const contextWithBrokenPrincipal = {
  requestId: "request-1",
  tenantId: "tenant-1",
  principal: { id: "user-1", scopes: undefined },
} as unknown as ToolContext;

function tool(requiredScopes: readonly string[] = []): ToolDefinition {
  return {
    name: "lookup_item",
    description: "Look up a test item",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
    operation: { requiredScopes },
    ownerTenantId: "tenant-1",
    execute: async (input) => input,
  };
}

async function authorizeResult(
  authorizer: OperationScopeAuthorizer,
  definition: ToolDefinition,
  callerContext: ToolContext,
): Promise<unknown> {
  try {
    await authorizer.authorize(definition, callerContext);
    return "allowed";
  } catch (error) {
    return error;
  }
}

describe("OperationScopeAuthorizer", () => {
  it("allows tools that declare no required scopes", () => {
    const authorizer = new OperationScopeAuthorizer();
    expect(() => authorizer.authorize(tool(), context([]))).not.toThrow();
    expect(() =>
      authorizer.authorize(tool(["read"]), context(["read"])),
    ).not.toThrow();
  });

  it("grants when every required scope is present, without order or duplicate sensitivity", () => {
    const authorizer = new OperationScopeAuthorizer();
    expect(() =>
      authorizer.authorize(tool(["a", "b"]), context(["b", "a", "a"])),
    ).not.toThrow();
    expect(() =>
      authorizer.authorize(tool(["a", "a"]), context(["a"])),
    ).not.toThrow();
  });

  it("denies missing scopes fail closed with the safe message and a diagnostic cause", async () => {
    const authorizer = new OperationScopeAuthorizer();
    const failure = await authorizeResult(
      authorizer,
      tool(["read", "write"]),
      context(["read"]),
    );
    expect(failure).toBeInstanceOf(RuntimeError);
    const denial = failure as RuntimeError;
    expect(denial.code).toBe("AUTH_FORBIDDEN");
    expect(denial.message).toBe("Access denied");
    // The client-facing message never carries scope names; they are retained
    // only for protected diagnostics.
    expect(JSON.stringify(denial)).not.toContain("read");
    expect(denial.cause).toBeInstanceOf(Error);
    expect((denial.cause as Error).message).toContain("write");
  });

  it("matches scope tokens exactly", async () => {
    const authorizer = new OperationScopeAuthorizer();
    const failure = await authorizeResult(
      authorizer,
      tool(["read"]),
      context(["READ", "readWrite", "read:write"]),
    );
    expect(failure).toBeInstanceOf(RuntimeError);
    expect((failure as RuntimeError).code).toBe("AUTH_FORBIDDEN");
  });

  it("denies when the principal carries no scopes", async () => {
    const authorizer = new OperationScopeAuthorizer();
    const failure = await authorizeResult(
      authorizer,
      tool(["read"]),
      contextWithBrokenPrincipal,
    );
    expect(failure).toBeInstanceOf(RuntimeError);
    expect((failure as RuntimeError).code).toBe("AUTH_FORBIDDEN");
  });

  it("denies a required scope that is not a string", async () => {
    const authorizer = new OperationScopeAuthorizer();
    const failure = await authorizeResult(
      authorizer,
      tool(["read", 42 as unknown as string]),
      context(["read", "42"]),
    );
    expect(failure).toBeInstanceOf(RuntimeError);
    expect((failure as RuntimeError).code).toBe("AUTH_FORBIDDEN");
    expect((failure as RuntimeError).cause).toBeInstanceOf(Error);
  });

  describe("composition with the shared runtime (ADR 0008)", () => {
    function tenantTool(
      ownerTenantId: string,
      requiredScopes: readonly string[],
      execute: ToolDefinition["execute"],
    ): ToolDefinition {
      return {
        ...tool(requiredScopes),
        name: "lookup_item",
        ownerTenantId,
        execute,
      };
    }

    const tenantToolContext = (
      tenantId: string,
      scopes: string[],
    ): ToolContext => ({
      requestId: "request-2",
      tenantId,
      principal: { id: `user-${tenantId}`, scopes },
    });

    function scopedRuntime(
      scopeAuthorizer: OperationScopeAuthorizer,
      metrics?: { record: (event: unknown) => void },
    ): InMemoryToolRuntime {
      return new InMemoryToolRuntime({
        tenantMode: "multi-tenant",
        authorizer: scopeAuthorizer,
        ...(metrics ? { metrics } : {}),
      });
    }

    it("enforces required scopes in a multi-tenant runtime and records the denial", async () => {
      const scopeAuthorizer = new OperationScopeAuthorizer();
      const authorizeSpy = vi.spyOn(scopeAuthorizer, "authorize");
      const metrics = vi.fn();
      const runtime = scopedRuntime(scopeAuthorizer, { record: metrics });
      runtime.register(
        tenantTool("tenant-1", ["read"], async (input) => input),
      );

      await expect(
        runtime.callTool(
          "lookup_item",
          { id: "a" },
          tenantToolContext("tenant-1", []),
        ),
      ).rejects.toMatchObject({ code: "AUTH_FORBIDDEN" });
      expect(authorizeSpy).toHaveBeenCalledOnce();
      expect(metrics).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: "error",
          errorCode: "AUTH_FORBIDDEN",
          tenantId: "tenant-1",
          toolName: "lookup_item",
        }),
      );
    });

    it("grants qualified same-tenant calls", async () => {
      const runtime = scopedRuntime(new OperationScopeAuthorizer());
      runtime.register(
        tenantTool("tenant-1", ["read"], async (input) => input),
      );
      await expect(
        runtime.callTool(
          "lookup_item",
          { id: "a" },
          tenantToolContext("tenant-1", ["read"]),
        ),
      ).resolves.toEqual({ id: "a" });
    });

    it("cross-tenant calls fail structurally before the authorizer runs", async () => {
      const scopeAuthorizer = new OperationScopeAuthorizer();
      const authorizeSpy = vi.spyOn(scopeAuthorizer, "authorize");
      const runtime = scopedRuntime(scopeAuthorizer);
      runtime.register(
        tenantTool("tenant-2", ["read"], async (input) => input),
      );
      await expect(
        runtime.callTool(
          "lookup_item",
          { id: "a" },
          tenantToolContext("tenant-1", ["read"]),
        ),
      ).rejects.toMatchObject({ code: "TOOL_NOT_FOUND" });
      expect(authorizeSpy).not.toHaveBeenCalled();
    });
  });
});

import type {
  JsonSchema,
  OperationPolicy,
  SchemaDiagnostic,
  ToolCachePolicy,
  ToolContext,
  ToolOutputPolicy,
} from "@chainmcp/core";
import type { z } from "zod";

export type AuthoringErrorCode =
  | "SCHEMA_NOT_OBJECT"
  | "SCHEMA_AUDIT_FAILED"
  | "SCHEMA_LOWERING_FAILED"
  | "INVALID_TOOL_DEFINITION";

export class AuthoringError extends Error {
  constructor(
    public readonly code: AuthoringErrorCode,
    message: string,
    public readonly diagnostics?: readonly SchemaDiagnostic[] | undefined,
  ) {
    super(message);
    this.name = "AuthoringError";
  }
}

export interface DefineToolOptions<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  /**
   * Zod schema for input arguments. Must be an object schema at the root.
   * Lowered and audited at definition time.
   */
  schema?: z.ZodType<TInput>;
  /**
   * Raw JSON Schema for input arguments. Must be an object schema at the root
   * and conform to the audited JSON Schema subset. Mutually exclusive with `schema`.
   */
  inputSchema?: JsonSchema;
  /**
   * Access control policy and required scopes.
   */
  operation?: OperationPolicy;
  /**
   * Opt-in cache policy for idempotent read operations.
   */
  cache?: ToolCachePolicy;
  /**
   * Opt-in output projection and token budgets.
   */
  output?: ToolOutputPolicy;
  /**
   * Explicit contract or tool revision for cache key isolation.
   */
  contractRevision?: string;
  /**
   * Alias for contractRevision.
   */
  version?: string;
  /**
   * Tenant binding in multi-tenant mode.
   */
  ownerTenantId?: string;
  /**
   * Execution timeout in milliseconds.
   */
  timeoutMs?: number;
  /**
   * Execution handler.
   */
  execute(input: TInput, context: ToolContext): Promise<TOutput>;
}

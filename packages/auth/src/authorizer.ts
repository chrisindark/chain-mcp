import {
  RuntimeError,
  type Authorizer,
  type ToolContext,
  type ToolDefinition,
} from "@chainmcp/core";

/**
 * Default authorizer that enforces operation scopes (ADR 0008): every scope
 * listed in `tool.operation.requiredScopes` must also appear in
 * `context.principal.scopes`.
 *
 * Semantics:
 *
 * - Matching is plain set membership: exact, case-sensitive scope tokens,
 *   compared without wildcards, patterns, or hierarchical expansion.
 * - Duplicates in either list are irrelevant to the decision.
 * - `requiredScopes` that is missing or empty imposes no requirement, so a
 *   tool without declared scopes is callable by any established caller
 *   identity. Tools that must be restricted declare their scopes.
 * - The tenant match is enforced structurally by the runtime's tenant-scoped
 *   resolution (ADR 0008); this authorizer adds no tenant decision of its
 *   own, so composing it with custom authorizers cannot weaken either rule.
 *
 * Denial follows the authorization-stage contract of ADR 0006 and the stage
 * rules of `ARCHITECTURE.md`: a denied invocation throws
 * `RuntimeError("AUTH_FORBIDDEN")`, whose client-facing message is the safe
 * `Access denied` string; the identity-provided scopes and the individual
 * missing requirement are retained only as a protected diagnostic cause,
 * never in the client-facing message or metrics event.
 */
export class OperationScopeAuthorizer implements Authorizer {
  authorize(tool: ToolDefinition, context: ToolContext): void {
    const requiredScopes = tool.operation.requiredScopes ?? [];
    if (requiredScopes.length === 0) return;
    const grantedScopes = context.principal?.scopes;
    const missing = requiredScopes.filter(
      (scope) =>
        typeof scope !== "string" ||
        !Array.isArray(grantedScopes) ||
        !grantedScopes.includes(scope),
    );
    if (missing.length === 0) return;
    throw new RuntimeError("AUTH_FORBIDDEN", "Access denied", {
      cause: new Error(
        `Required scopes not granted: ${missing.map((scope) => (typeof scope === "string" ? scope : "[not-a-string]")).join(", ")}`,
      ),
    });
  }
}

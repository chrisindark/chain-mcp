import type {
  Authorizer,
  JsonSchema,
  Logger,
  MetricsSink,
  RateLimiter,
  ResultProjector,
  RuntimeCacheOptions,
  Tokenizer,
  ToolDefinition,
} from "@chainmcp/core";
import type { HostResolver, UpstreamTransport } from "@chainmcp/executor";
import type { UpstreamCredentialProvider } from "@chainmcp/auth";

export type ContractRevisionStatus =
  "candidate" | "active" | "disabled" | "superseded" | "rolled_back";

export interface ContractDestinationPolicy {
  readonly baseUrl: string;
  readonly allowedHosts: readonly string[];
  readonly allowInsecureHttp?: boolean | undefined;
}

export interface ContractAuthConfig {
  readonly requiredScopes?: readonly string[] | undefined;
  readonly credentialProvider?: UpstreamCredentialProvider | undefined;
}

export interface ContractLimits {
  readonly timeoutMs?: number | undefined;
  readonly maxResponseBytes?: number | undefined;
  readonly maxRequestBytes?: number | undefined;
  readonly maxRedirects?: number | undefined;
}

export interface ContractRevision {
  readonly revisionId: string;
  readonly contractName: string;
  readonly tenantId: string;
  readonly sourceHash: string;
  readonly createdAt: number;
  readonly status: ContractRevisionStatus;
  readonly tools: readonly ToolDefinition[];
  readonly destinationPolicy: ContractDestinationPolicy;
  readonly authConfig?: ContractAuthConfig | undefined;
  readonly limits?: ContractLimits | undefined;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
}

export interface PublishContractOptions {
  readonly tenantId: string;
  readonly contractName: string;
  /** Raw OpenAPI 3.0 / 3.1 YAML or JSON string. Either source or tools must be supplied. */
  readonly source?: string | undefined;
  /** Pre-compiled or manual tools. Either source or tools must be supplied. */
  readonly tools?: readonly ToolDefinition[] | undefined;
  readonly destinationPolicy: ContractDestinationPolicy;
  readonly authConfig?: ContractAuthConfig | undefined;
  readonly limits?: ContractLimits | undefined;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
  /** Automatically activate the candidate revision upon successful compilation and validation. Default true. */
  readonly autoActivate?: boolean | undefined;
}

export type GatewayAuditEventType =
  | "contract_published"
  | "contract_activated"
  | "contract_disabled"
  | "contract_rolled_back"
  | "tenant_resolution_failed";

export interface GatewayAuditEvent {
  readonly type: GatewayAuditEventType;
  readonly timestamp: number;
  readonly tenantId: string;
  readonly contractName: string;
  readonly revisionId: string;
  readonly previousRevisionId?: string | undefined;
  readonly toolCount: number;
  readonly details?: Readonly<Record<string, unknown>> | undefined;
}

export type GatewayAuditSink = (
  event: GatewayAuditEvent,
) => void | Promise<void>;

export interface DynamicGatewayOptions {
  /**
   * Inbound authorizer. In multi-tenant mode an authorizer is mandatory;
   * defaults to OperationScopeAuthorizer if omitted.
   */
  readonly authorizer?: Authorizer | undefined;
  readonly rateLimiter?: RateLimiter | undefined;
  readonly cache?: RuntimeCacheOptions | undefined;
  readonly tokenizer?: Tokenizer | undefined;
  readonly projector?: ResultProjector | undefined;
  readonly metrics?: MetricsSink | undefined;
  readonly logger?: Logger | undefined;
  readonly auditSink?: GatewayAuditSink | undefined;
  readonly resolveHost?: HostResolver | undefined;
  readonly transport?: UpstreamTransport | undefined;
  readonly defaultTimeoutMs?: number | undefined;
  readonly onToolsChanged?: (() => void | Promise<void>) | undefined;
  readonly now?: (() => number) | undefined;
  readonly monotonicNow?: (() => number) | undefined;
}

export type GatewayErrorCode =
  | "CONTRACT_NOT_FOUND"
  | "REVISION_NOT_FOUND"
  | "REVISION_CONFLICT"
  | "INVALID_REVISION_STATE"
  | "COMPILATION_FAILED"
  | "POLICY_VIOLATION"
  | "DESTINATION_INVALID"
  | "TENANT_MISMATCH";

export class GatewayError extends Error {
  public readonly code: GatewayErrorCode;

  constructor(code: GatewayErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GatewayError";
    this.code = code;
  }
}

export interface ToolSummary {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
}

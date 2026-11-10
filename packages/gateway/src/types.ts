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
  ToolTracer,
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

export type ProxyTransportType = "http" | "stdio" | "custom";

export interface ProxyDestinationConfig {
  /** Transport mode: streamable HTTP, subprocess stdio, or custom transport. */
  readonly transport: ProxyTransportType;
  /** For HTTP: target MCP URL (e.g. http://localhost:8000/mcp). */
  readonly url?: string | undefined;
  /** For Stdio: command executable (e.g. "python", "uvx", "node"). */
  readonly command?: string | undefined;
  /** For Stdio: arguments passed to command. */
  readonly args?: readonly string[] | undefined;
  /** For Stdio: environment variables for child process. */
  readonly env?: Readonly<Record<string, string>> | undefined;
  /** For Stdio: working directory. */
  readonly cwd?: string | undefined;
  /** For HTTP: additional request headers (e.g. Authorization, X-API-Key). */
  readonly headers?: Readonly<Record<string, string>> | undefined;
  /** Optional custom client transport (e.g. InMemoryTransport for testing). */
  readonly customTransport?: unknown | undefined;
  /** Optional prefix added to tool names (e.g. "github_" -> "github_list_repos"). */
  readonly toolPrefix?: string | undefined;
  /**
   * Tool caching eligibility. Set to `true` to make all tools cache-eligible,
   * or provide an array of specific tool names that should be cached.
   * Default is false (mutations and default proxy calls are not cached).
   */
  readonly cacheEligible?: boolean | readonly string[] | undefined;
}

export interface PublishProxyContractOptions {
  readonly tenantId: string;
  readonly contractName: string;
  readonly proxy: ProxyDestinationConfig;
  readonly destinationPolicy?: Partial<ContractDestinationPolicy> | undefined;
  readonly authConfig?: ContractAuthConfig | undefined;
  readonly limits?: ContractLimits | undefined;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
  readonly autoActivate?: boolean | undefined;
}

export type GatewayAuditEventType =
  | "contract_published"
  | "contract_activated"
  | "contract_disabled"
  | "contract_rolled_back"
  | "proxy_connected"
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
  readonly tracer?: ToolTracer | undefined;
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

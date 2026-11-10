# API Reference: @chainmcp/gateway

## `@chainmcp/gateway`

The `@chainmcp/gateway` package implements the multi-tenant dynamic gateway, versioned contract registry, atomic revision activation, and rollback capabilities.

### Interfaces and Types

```ts
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
  readonly source?: string | undefined;
  readonly tools?: readonly ToolDefinition[] | undefined;
  readonly destinationPolicy: ContractDestinationPolicy;
  readonly authConfig?: ContractAuthConfig | undefined;
  readonly limits?: ContractLimits | undefined;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
  readonly autoActivate?: boolean | undefined;
}

export type ProxyTransportType = "stdio" | "http" | "custom";

export interface ProxyDestinationConfig {
  readonly transport: ProxyTransportType;
  readonly url?: string | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly command?: string | undefined;
  readonly args?: readonly string[] | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly cwd?: string | undefined;
  readonly customTransport?: unknown | undefined;
  readonly toolPrefix?: string | undefined;
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
  readonly now?: (() => number) | undefined;
  readonly monotonicNow?: (() => number) | undefined;
}
```

### Classes and Functions

```ts
export class ContractRegistry {
  createRevision(options: CreateRevisionOptions): ContractRevision;
  activateRevision(
    tenantId: string,
    contractName: string,
    revisionId: string,
  ): ActivationResult;
  disableRevision(
    tenantId: string,
    contractName: string,
    revisionId?: string,
  ): ContractRevision;
  rollbackRevision(
    tenantId: string,
    contractName: string,
    targetRevisionId: string,
  ): RollbackResult;
  getActiveRevision(
    tenantId: string,
    contractName: string,
  ): ContractRevision | undefined;
  getRevision(revisionId: string): ContractRevision | undefined;
  listRevisions(
    tenantId: string,
    contractName?: string,
  ): readonly ContractRevision[];
  listActiveRevisions(tenantId?: string): readonly ContractRevision[];
}

export class DynamicGateway implements ToolRuntime {
  readonly tenantMode: "multi-tenant";
  constructor(options?: DynamicGatewayOptions);
  getRegistry(): ContractRegistry;
  publishContract(options: PublishContractOptions): Promise<ContractRevision>;
  publishProxyContract(
    options: PublishProxyContractOptions,
  ): Promise<ContractRevision>;
  activateRevision(
    tenantId: string,
    contractName: string,
    revisionId: string,
  ): Promise<ContractRevision>;
  disableContract(
    tenantId: string,
    contractName: string,
  ): Promise<ContractRevision>;
  rollbackContract(
    tenantId: string,
    contractName: string,
    targetRevisionId: string,
  ): Promise<ContractRevision>;
  listTools(context?: ToolContext): ReadonlyArray<ToolSummary>;
  callTool(
    name: string,
    input: unknown,
    context: ToolContext | ToolContextFactory,
  ): Promise<unknown>;
  invalidateCachedResult?(
    name: string,
    input: unknown,
    context: ToolContext,
  ): Promise<void>;
  register(tool: ToolDefinition): void;
  registerSource(source: ToolSource): Promise<void>;
  close(): Promise<void>;
}

export class McpProxyAdapter implements ToolSource {
  readonly tenantId: string;
  readonly contractName: string;
  readonly proxyConfig: ProxyDestinationConfig;
  constructor(options: McpProxyAdapterOptions);
  connect(): Promise<void>;
  getTools(): readonly ToolDefinition[];
  close(): Promise<void>;
}

export function generateTraceparent(context?: ToolContext): string;

export function unwrapCallToolResult(result: CallToolResult): unknown;

export function createGatewayServer(
  gateway: DynamicGateway,
  options: GatewayServerOptions,
): McpServer;

export function connectGatewayServer(
  gateway: DynamicGateway,
  transport: Transport,
  options: GatewayServerOptions,
): Promise<ConnectedMcpServer>;
```

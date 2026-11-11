import type { FieldSelection, Logger, Tokenizer } from "@chainmcp/core";
import type { UpstreamCredentialProvider } from "@chainmcp/auth";
import type { HostResolver, UpstreamTransport } from "@chainmcp/executor";
import type { StorageDriver } from "@chainmcp/storage";
import type {
  DeclarativeAuthSchemeMap,
  DeclarativeDescriptorErrorCode,
  DeclarativeDescriptorIssue,
  DeclarativePolicyDescriptor,
  DeclarativeToolDescriptor,
} from "@chainmcp/declarative";
import type {
  ContractDestinationPolicy,
  ContractLimits,
  ContractRevisionStatus,
  DynamicGateway,
} from "@chainmcp/gateway";

/** HTTP prefix for every admin API route. */
export const DECLARATIVE_ADMIN_API_PREFIX = "/api/v1";

/** Default port for the self-hosted admin surface and Web Studio. */
export const DEFAULT_DECLARATIVE_ADMIN_PORT = 3341;
export const DEFAULT_STUDIO_PORT = DEFAULT_DECLARATIVE_ADMIN_PORT;

/** Default maximum request body size for descriptor submissions. */
export const MAX_DECLARATIVE_ADMIN_REQUEST_BYTES = 1_048_576;

/** Upper bound on descriptors accepted in one submission. */
export const MAX_DECLARATIVE_ADMIN_DESCRIPTORS = 1_000;

/** Minimum accepted length for an admin bearer token. */
export const MIN_DECLARATIVE_ADMIN_TOKEN_LENGTH = 16;

/**
 * One admin bearer token. Tokens are deployment-issued; the admin surface
 * never mints, stores, or returns them. `id` is a non-secret label used in
 * audit records and must be unique.
 */
export interface DeclarativeAdminToken {
  readonly id: string;
  readonly token: string;
  /** Tenants this token may administer, or `"*"` for every bound tenant. */
  readonly tenants: readonly string[] | "*";
}

/**
 * Binds the admin surface to one tenant/contract pair. The destination policy
 * and credential provider are deployment configuration, never descriptor
 * input, so a descriptor cannot widen the hosts or reach new credentials.
 */
export interface DeclarativeAdminContractBinding {
  readonly tenantId: string;
  readonly contractName: string;
  readonly destinationPolicy: ContractDestinationPolicy;
  /** Credential shape for schemes referenced by descriptors. */
  readonly authSchemes?: DeclarativeAuthSchemeMap;
  /** Secret source for referenced schemes. Secrets never enter descriptors. */
  readonly credentialProvider?: UpstreamCredentialProvider;
  readonly limits?: ContractLimits;
  /**
   * Transport for this contract's descriptor-backed tools. Overrides the
   * admin-wide `transport` so one admin can front upstreams on different
   * network paths (for example an internal fetcher plus a proxied one).
   */
  readonly transport?: UpstreamTransport;
  /** Per-contract DNS resolver override for `transport`. */
  readonly resolveHost?: HostResolver;
}

export type DeclarativeAdminAuditEventType =
  | "admin_validate"
  | "admin_preview"
  | "admin_publish"
  | "admin_curate"
  | "admin_test_tool"
  | "admin_rollback"
  | "admin_restore"
  | "admin_auth_failed"
  | "admin_request_rejected";

/**
 * Structured admin audit record. It never contains bearer tokens, descriptor
 * arguments, or upstream credentials.
 */
export interface DeclarativeAdminAuditEvent {
  readonly type: DeclarativeAdminAuditEventType;
  readonly timestamp: number;
  readonly route: string;
  readonly tokenId?: string | undefined;
  readonly tenantId?: string | undefined;
  readonly contractName?: string | undefined;
  readonly toolName?: string | undefined;
  readonly enabled?: boolean | undefined;
  readonly revisionId?: string | undefined;
  readonly gatewayRevisionId?: string | undefined;
  readonly toolCount?: number | undefined;
  readonly reason?: string | undefined;
}

export type DeclarativeAdminAuditSink = (
  event: DeclarativeAdminAuditEvent,
) => void | Promise<void>;

export interface DeclarativeAdminOptions {
  /** The live gateway that owns revisions, tenant isolation, and execution. */
  readonly gateway: DynamicGateway;
  /** At least one bearer token. Empty configuration is rejected. */
  readonly tokens: readonly DeclarativeAdminToken[];
  /** Tenant/contract pairs this surface may validate and publish. */
  readonly contracts?: readonly DeclarativeAdminContractBinding[];
  /** Body cap. Default 1 MiB; maximum 10 MiB. */
  readonly maxRequestBytes?: number;
  /**
   * Descriptor revision storage. Defaults to an in-memory store, which loses
   * history on restart. Use `FileDescriptorRevisionStore`, `StorageDescriptorRevisionStore`,
   * or a database adapter for durable revisions.
   */
  readonly repository?: DescriptorRevisionStore;
  /**
   * Storage driver from @chainmcp/storage (e.g. SqliteStorageDriver or MemoryStorageDriver)
   * used for persistent descriptor revisions and telemetry queries.
   */
  readonly storageDriver?: StorageDriver;
  /**
   * Transport for descriptor-backed tools. Defaults to the executor's fetch
   * transport. Inject one to stub upstreams instead of calling the network.
   */
  readonly transport?: UpstreamTransport;
  /**
   * DNS resolver for descriptor-backed tools. Defaults to system DNS, so
   * deployments behind a custom network or tests should inject one.
   */
  readonly resolveHost?: HostResolver;
  readonly logger?: Logger;
  readonly auditSink?: DeclarativeAdminAuditSink;
  readonly now?: () => number;
  /** Optional tokenizer used for token counting in playground and metrics. */
  readonly tokenizer?: Tokenizer | undefined;
  /** Optional config file path to synchronize with descriptor and tool curation changes. */
  readonly configPath?: string | undefined;
  /** Optional callback invoked when a tool's enabled/curated state changes. */
  readonly onConfigSync?:
    | ((update: {
        tenantId: string;
        contractName: string;
        toolName: string;
        enabled: boolean;
      }) => Promise<void>)
    | undefined;
}

export type DeclarativeAdminErrorCode =
  | "ADMIN_AUTH_REQUIRED"
  | "ADMIN_AUTH_INVALID"
  | "ADMIN_TENANT_FORBIDDEN"
  | "ADMIN_ORIGIN_FORBIDDEN"
  | "ADMIN_ROUTE_NOT_FOUND"
  | "ADMIN_METHOD_NOT_ALLOWED"
  | "ADMIN_CONTRACT_UNKNOWN"
  | "ADMIN_TOOL_NOT_FOUND"
  | "ADMIN_REQUEST_INVALID"
  | "ADMIN_REQUEST_TOO_LARGE"
  | "ADMIN_MEDIA_TYPE_UNSUPPORTED"
  | "ADMIN_DESCRIPTOR_INVALID"
  | "ADMIN_PUBLISH_CONFLICT"
  | "ADMIN_PUBLISH_FAILED"
  | "ADMIN_REVISION_UNKNOWN"
  | "ADMIN_REVISION_CONFLICT"
  | "ADMIN_STORE_FAILURE"
  | "ADMIN_INTERNAL";

/**
 * Typed admin failure carrying the HTTP status the handler emits. `issues`
 * contains descriptor field locations only; descriptor input can never contain
 * credentials, so diagnostics are safe to return.
 */
export class DeclarativeAdminError extends Error {
  constructor(
    readonly code: DeclarativeAdminErrorCode,
    readonly status: number,
    message: string,
    readonly issues: readonly DeclarativeDescriptorIssue[] = [],
    /** Methods accepted by the matched route, for the 405 `Allow` header. */
    readonly allow: readonly string[] = [],
  ) {
    super(message);
    this.name = "DeclarativeAdminError";
  }
}

/** Validated descriptor identity shared by validate/preview/publish responses. */
export interface DeclarativeAdminDescriptorSummary {
  readonly index: number;
  readonly name: string;
  /** Deterministic `sha256:` revision of the descriptor document. */
  readonly revision: string;
}

export interface DeclarativeAdminParameterPreview {
  readonly name: string;
  readonly in: "path" | "query" | "header" | "cookie";
  readonly required: boolean;
}

export interface DeclarativeAdminPolicyPreview {
  readonly requiredScopes: readonly string[];
  readonly cacheTtlSeconds?: number | undefined;
  readonly maxOutputTokens?: number | undefined;
  readonly timeoutMs?: number | undefined;
  readonly outputFields?: FieldSelection | undefined;
}

/** Static lowering result. Preview never performs an upstream request. */
export interface DeclarativeAdminToolPreview extends DeclarativeAdminDescriptorSummary {
  readonly description: string;
  readonly method: string;
  readonly path: string;
  readonly parameters: readonly DeclarativeAdminParameterPreview[];
  readonly body?:
    { readonly mediaType: string; readonly required: boolean } | undefined;
  readonly authentication: {
    readonly allowsAnonymous: boolean;
    readonly alternatives: readonly (readonly string[])[];
  };
  readonly policy: DeclarativeAdminPolicyPreview;
}

export interface DeclarativeAdminDescriptorDiagnostic {
  readonly index: number;
  readonly code: DeclarativeDescriptorErrorCode;
  readonly message: string;
  readonly issues: readonly DeclarativeDescriptorIssue[];
}

export interface DeclarativeAdminEvaluation {
  readonly valid: boolean;
  readonly tools: readonly DeclarativeAdminDescriptorSummary[];
  readonly diagnostics: readonly DeclarativeAdminDescriptorDiagnostic[];
}

export interface DeclarativeAdminPreview {
  readonly valid: boolean;
  readonly tools: readonly DeclarativeAdminToolPreview[];
  readonly diagnostics: readonly DeclarativeAdminDescriptorDiagnostic[];
}

export interface DeclarativeAdminDescriptorRevision {
  readonly name: string;
  readonly revision: string;
}

export interface DeclarativeAdminRevisionSummary {
  readonly revisionId: string;
  readonly tenantId: string;
  readonly contractName: string;
  readonly createdAt: number;
  readonly status: ContractRevisionStatus;
  readonly sourceHash: string;
  readonly toolCount: number;
  readonly toolNames: readonly string[];
  readonly descriptors: readonly DeclarativeAdminDescriptorRevision[];
}
export interface DeclarativeAdminPublishedRevision extends DeclarativeAdminStoredRevisionSummary {
  readonly sourceHash: string;
  readonly baseUrl: string;
  readonly allowedHosts: readonly string[];
}

/** Version written into a file-backed descriptor store. */
export const DESCRIPTOR_STORE_VERSION = 1 as const;

/** Revisions retained per tenant/contract in the built-in stores. */
export const MAX_STORED_DESCRIPTOR_REVISIONS = 100;

/** Default byte ceiling for a serialized descriptor store. */
export const MAX_DESCRIPTOR_STORE_BYTES = 10 * 1_048_576;

export type StoredDescriptorRevisionStatus =
  "candidate" | "active" | "superseded" | "failed";

/**
 * One persisted descriptor revision. Records are immutable once written by the
 * store except for their status and gateway revision binding.
 */
export interface StoredDescriptorRevision {
  /** Admin revision id (`dset_…`), independent of the gateway revision id. */
  readonly revisionId: string;
  readonly tenantId: string;
  readonly contractName: string;
  readonly createdAt: number;
  readonly status: StoredDescriptorRevisionStatus;
  /** SHA-256 over the ordered `name:revision` list. */
  readonly toolsetHash: string;
  /** Validated descriptor documents, exactly as submitted. */
  readonly descriptors: readonly DeclarativeToolDescriptor[];
  readonly toolRevisions: readonly DeclarativeAdminDescriptorRevision[];
  /** Gateway revision that served this set, once published. */
  readonly gatewayRevisionId?: string | undefined;
  /** Non-secret admin token id that published the set. */
  readonly publishedBy?: string | undefined;
  /** Admin revision this record restores, for rollback history. */
  readonly rollbackOf?: string | undefined;
}

/**
 * Durable storage boundary for descriptor revisions. Implementations must
 * serialize mutations and keep tenants isolated by `(tenantId, contractName)`.
 * The built-in file store is a single-writer implementation; deployments that
 * need concurrency should provide an adapter over their database.
 */
export interface DescriptorRevisionStore {
  /** Stable adapter name for diagnostics. */
  readonly kind: string;
  listRevisions(
    tenantId: string,
    contractName: string,
  ): Promise<readonly StoredDescriptorRevision[]>;
  getRevision(
    tenantId: string,
    contractName: string,
    revisionId: string,
  ): Promise<StoredDescriptorRevision | undefined>;
  getActive(
    tenantId: string,
    contractName: string,
  ): Promise<StoredDescriptorRevision | undefined>;
  /** Appends a `candidate` record. Rejects duplicate ids and store limits. */
  createRevision(record: StoredDescriptorRevision): Promise<void>;
  /** Marks a candidate active and supersedes the previous active record. */
  activateRevision(
    tenantId: string,
    contractName: string,
    revisionId: string,
    gatewayRevisionId: string,
  ): Promise<void>;
  /** Binds a new gateway revision to an already-active record (restore). */
  recordGatewayRevision(
    tenantId: string,
    contractName: string,
    revisionId: string,
    gatewayRevisionId: string,
  ): Promise<void>;
  /** Marks a candidate failed after a publication error. */
  failRevision(
    tenantId: string,
    contractName: string,
    revisionId: string,
  ): Promise<void>;
}

export type DescriptorStoreErrorCode =
  | "STORE_IO"
  | "STORE_CORRUPT"
  | "STORE_TOO_LARGE"
  | "STORE_DUPLICATE"
  | "STORE_STATE_INVALID"
  | "STORE_LIMIT_EXCEEDED"
  | "STORE_NOT_FOUND";

/** Typed store failure. Messages never contain descriptor contents or secrets. */
export class DescriptorStoreError extends Error {
  constructor(
    readonly code: DescriptorStoreErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DescriptorStoreError";
  }
}

/** Public projection of a stored revision. */
export interface DeclarativeAdminStoredRevisionSummary {
  readonly revisionId: string;
  readonly tenantId: string;
  readonly contractName: string;
  readonly createdAt: number;
  readonly status: StoredDescriptorRevisionStatus;
  readonly toolsetHash: string;
  readonly toolCount: number;
  readonly toolNames: readonly string[];
  readonly descriptors: readonly DeclarativeAdminDescriptorRevision[];
  readonly gatewayRevisionId?: string | undefined;
  readonly publishedBy?: string | undefined;
  readonly rollbackOf?: string | undefined;
}

export interface DeclarativeAdminRestoreEntry {
  readonly tenantId: string;
  readonly contractName: string;
  readonly revisionId: string;
  readonly gatewayRevisionId: string;
}

export interface DeclarativeAdminRestoreSkip {
  readonly tenantId: string;
  readonly contractName: string;
  readonly revisionId: string;
  readonly reason: "already_active" | "descriptors_invalid";
}

export interface DeclarativeAdminRestoreFailure {
  readonly tenantId: string;
  readonly contractName: string;
  readonly revisionId: string;
  readonly reason: string;
}

/** Result of restoring persisted active revisions into the gateway. */
export interface DeclarativeAdminRestoreResult {
  readonly restored: readonly DeclarativeAdminRestoreEntry[];
  readonly skipped: readonly DeclarativeAdminRestoreSkip[];
  readonly failures: readonly DeclarativeAdminRestoreFailure[];
}

/** Active tool listing for the bound contract, scoped to its tenant. */
export interface DeclarativeAdminToolSummary {
  readonly name: string;
  readonly description: string;
  readonly contractRevision: string;
  readonly requiredScopes: readonly string[];
  readonly inputSchema?: unknown | undefined;
  readonly enabled?: boolean | undefined;
}

/** The request field's declared policy is echoed back for UI display. */
export function descriptorPolicyPreview(
  policy: DeclarativePolicyDescriptor | undefined,
): DeclarativeAdminPolicyPreview {
  if (policy === undefined) return { requiredScopes: [] };
  return {
    requiredScopes: [...(policy.requiredScopes ?? [])],
    ...(policy.cacheTtlSeconds === undefined
      ? {}
      : { cacheTtlSeconds: policy.cacheTtlSeconds }),
    ...(policy.maxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: policy.maxOutputTokens }),
    ...(policy.timeoutMs === undefined ? {} : { timeoutMs: policy.timeoutMs }),
    ...(policy.outputFields === undefined
      ? {}
      : { outputFields: policy.outputFields }),
  };
}

export interface DeclarativeAdminToolTestRequest {
  readonly arguments?: Record<string, unknown> | undefined;
  readonly projection?: FieldSelection | undefined;
}

export interface DeclarativeAdminToolTestMetrics {
  readonly rawTokens: number;
  readonly projectedTokens: number;
  readonly savedTokens: number;
  readonly percentSavings: number;
  readonly tokenizerId: string;
}

export interface DeclarativeAdminToolTestResult {
  readonly ok: boolean;
  readonly toolName: string;
  readonly executionTimeMs: number;
  readonly raw?: unknown;
  readonly projected?: unknown;
  readonly metrics?: DeclarativeAdminToolTestMetrics;
  readonly error?: {
    readonly code: string;
    readonly message: string;
  };
}

export interface TelemetryMetricsSummary {
  readonly totalRequests: number;
  readonly totalErrors: number;
  readonly errorRate: number;
  readonly totalCached: number;
  readonly cacheHitRatio: number;
  readonly totalTokens: number;
  readonly avgTokensPerRequest: number;
  readonly p50DurationMs: number;
  readonly p95DurationMs: number;
  readonly p99DurationMs: number;
  readonly avgDurationMs: number;
}

export interface TelemetryToolMetrics {
  readonly toolName: string;
  readonly requests: number;
  readonly errors: number;
  readonly cached: number;
  readonly tokens: number;
  readonly avgDurationMs: number;
}

export interface TelemetryTimeBucket {
  readonly bucketStart: number;
  readonly bucketEnd: number;
  readonly requests: number;
  readonly errors: number;
  readonly cached: number;
  readonly tokens: number;
}

export interface TelemetryMetricsResponse {
  readonly ok: boolean;
  readonly window: {
    readonly since: number;
    readonly until: number;
  };
  readonly summary: TelemetryMetricsSummary;
  readonly byTool: readonly TelemetryToolMetrics[];
  readonly timeSeries: readonly TelemetryTimeBucket[];
}

export interface TelemetryEventResponse {
  readonly id: string;
  readonly timestamp: number;
  readonly tenantId?: string | undefined;
  readonly toolName?: string | undefined;
  readonly durationMs?: number | undefined;
  readonly isError?: boolean | undefined;
  readonly errorCode?: string | undefined;
  readonly cached?: boolean | undefined;
  readonly tokenCount?: number | undefined;
  readonly traceId?: string | undefined;
  readonly spanId?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

import type { ToolDefinition } from "@chainmcp/core";
import type { CompiledOperation } from "@chainmcp/compiler";
import type { UpstreamCredentialProvider } from "@chainmcp/auth";

/** A resolved upstream address pinned for one request. */
export interface ResolvedDestination {
  /** URL after allowlist, origin, and length checks. */
  url: URL;
  /** Normalized hostname used for the Host header and TLS SNI. */
  hostname: string;
  /** Canonical IP address selected from the resolver results. */
  address: string;
  family: 4 | 6;
}

/**
 * Resolves a hostname to candidate IP addresses. The default uses the system
 * resolver. Injected resolvers are trusted adapter code and must not bypass the
 * destination policy; the executor classifies every returned address.
 */
export type HostResolver = (hostname: string) => Promise<readonly string[]>;

export interface UpstreamTransportRequest {
  url: URL;
  /** Original hostname, retained for the Host header and TLS SNI. */
  hostname: string;
  /** Pinned address the transport must connect to. */
  address: string;
  family: 4 | 6;
  method: string;
  headers: Readonly<Record<string, string>>;
  body?: Uint8Array;
  maxResponseBytes: number;
  signal: AbortSignal;
}

export interface UpstreamTransportResponse {
  status: number;
  headers: Readonly<Record<string, string | string[] | undefined>>;
  body: Uint8Array;
}

/**
 * Low-level HTTP transport. The default implementation pins DNS, verifies the
 * connected peer, refuses compressed responses, and enforces the response cap.
 * A custom transport is advanced adapter code and must preserve those
 * guarantees; the executor rechecks the cap and JSON shape but cannot verify
 * the socket destination of an injected transport.
 */
export interface UpstreamTransport {
  request(
    request: UpstreamTransportRequest,
  ): Promise<UpstreamTransportResponse>;
}

export interface UpstreamExecutorOptions {
  /**
   * Absolute base URL for the contract, including any base path. Query strings
   * and fragments are rejected. The host must appear in `allowedHosts`.
   */
  baseUrl: string;
  /**
   * Exact hostnames permitted for upstream requests and redirects. No
   * wildcards are accepted. IDN names are normalized to punycode; matching is
   * case-insensitive and ignores one trailing dot.
   */
  allowedHosts: readonly string[];
  /**
   * Permit plain HTTP. Default false. Private, loopback, link-local, metadata,
   * multicast, and reserved destinations remain blocked either way.
   */
  allowInsecureHttp?: boolean;
  /** Response body cap in bytes. Default 1 MiB; maximum 10 MiB. */
  maxResponseBytes?: number;
  /** Request body cap in bytes. Default 1 MiB; maximum 10 MiB. */
  maxRequestBytes?: number;
  /** Redirects followed per call. Default 3; maximum 5. */
  maxRedirects?: number;
  /** Total time budget per call in milliseconds. Default 15s; maximum 120s. */
  timeoutMs?: number;
  /** Opt-in default time-to-live in seconds for read-only (GET/HEAD) operations. */
  defaultReadCacheTtlSeconds?: number;
  /** Marks generated tools with the compiled contract revision. */
  contractRevision?: string;
  /** Optional tenant binding for multi-tenant deployments. */
  ownerTenantId?: string;
  /** Defaults to the system DNS resolver. */
  resolveHost?: HostResolver;
  /** Defaults to the pinned Node HTTP transport. */
  transport?: UpstreamTransport;
  /** Optional upstream credential provider to satisfy authentication schemes. */
  credentialProvider?: UpstreamCredentialProvider;
}

export interface UpstreamExecutor {
  createTool(operation: CompiledOperation): ToolDefinition;
  createTools(
    operations: readonly CompiledOperation[],
  ): readonly ToolDefinition[];
}

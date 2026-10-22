import {
  DEFAULT_TOKEN_TIMEOUT_MS,
  MAX_TOKEN_RESPONSE_BYTES,
  MAX_TOKEN_URL_LENGTH,
  type OAuthTokenFetcher,
  type OAuthTokenFetcherOptions,
  type OAuthTokenResponse,
} from "@chainmcp/auth";

import {
  effectivePort,
  normalizeAllowedHost,
  resolveDestination,
  type DestinationPolicy,
} from "./destination.js";
import { InvalidResponseError, UpstreamStatusError } from "./errors.js";
import { createStopSignal } from "./stop-signal.js";
import type { HostResolver, UpstreamTransport } from "./types.js";

export interface TokenEndpointFetcherOptions {
  resolver: HostResolver;
  transport: UpstreamTransport;
  maxResponseBytes?: number;
  timeoutMs?: number;
}

/**
 * Builds the OAuth token endpoint fetcher handed to credential providers.
 *
 * Token acquisition is an outbound HTTP call, so it runs through the same
 * policy and transport as upstream API requests: exact host allowlist (the
 * provider's configured hosts, or the token URL's own host), HTTPS unless the
 * provider explicitly opts in, rejection of any non-public resolved address,
 * DNS pinning with peer verification, refusal of redirects, and a bounded,
 * uncompressed response. Providers that support this via
 * `context.tokenEndpointFetch` never fall back to the platform fetch when the
 * executor wires them up.
 */
export function createTokenEndpointFetcher(
  options: TokenEndpointFetcherOptions,
): OAuthTokenFetcher {
  const maxResponseBytes = options.maxResponseBytes ?? MAX_TOKEN_RESPONSE_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TOKEN_TIMEOUT_MS;

  return async function tokenEndpointFetch(
    url: string,
    body: URLSearchParams,
    headers: Readonly<Record<string, string>>,
    fetchOptions?: OAuthTokenFetcherOptions,
  ): Promise<OAuthTokenResponse> {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      throw new InvalidResponseError("OAuth token URL is not valid");
    }
    if (target.username.length > 0 || target.password.length > 0) {
      throw new InvalidResponseError(
        "OAuth token URL must not contain credentials",
      );
    }

    const policy = buildTokenEndpointPolicy(target, fetchOptions);
    const destination = await resolveDestination(
      target,
      policy,
      options.resolver,
    );

    const stop = createStopSignal(fetchOptions?.signal, timeoutMs);
    try {
      const response = await options.transport.request({
        url: destination.url,
        hostname: destination.hostname,
        address: destination.address,
        family: destination.family,
        method: "POST",
        headers: { ...headers },
        body: Buffer.from(body.toString(), "utf8"),
        maxResponseBytes,
        signal: stop.signal,
      });

      // A redirect would move the request (and the client credentials used to
      // authorize it) to an origin the caller never approved.
      if (response.status >= 300 && response.status < 400) {
        throw new InvalidResponseError(
          "OAuth token endpoint redirects are not followed",
        );
      }
      if (response.status < 200 || response.status >= 300) {
        throw new UpstreamStatusError(response.status);
      }
      if (!hasJsonContentType(response.headers)) {
        throw new InvalidResponseError(
          "OAuth token endpoint returned a non-JSON response",
        );
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.from(response.body).toString("utf8"));
      } catch (error) {
        throw new InvalidResponseError(
          "OAuth token response was not valid JSON",
          {
            cause: error,
          },
        );
      }
      if (typeof parsed !== "object" || parsed === null) {
        throw new InvalidResponseError(
          "OAuth token response was not a JSON object",
        );
      }
      return parsed as OAuthTokenResponse;
    } finally {
      stop.dispose();
    }
  };
}

function buildTokenEndpointPolicy(
  target: URL,
  fetchOptions: OAuthTokenFetcherOptions | undefined,
): DestinationPolicy {
  const declared = fetchOptions?.allowedHosts ?? [];
  // Without a declared allowlist the configured token URL is the allowlist:
  // the operator already named exactly one endpoint.
  const hosts = declared.length > 0 ? declared : [target.hostname];
  return {
    allowedHosts: new Set(hosts.map((host) => normalizeAllowedHost(host))),
    protocol: target.protocol === "http:" ? "http:" : "https:",
    port: effectivePort(target),
    allowInsecureHttp: fetchOptions?.allowInsecureHttp === true,
    maxUrlLength: MAX_TOKEN_URL_LENGTH,
  };
}

function hasJsonContentType(
  headers: Readonly<Record<string, string | string[] | undefined>>,
): boolean {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== "content-type") continue;
    const values = Array.isArray(value)
      ? value
      : value === undefined
        ? []
        : [value];
    return values.some((entry) => {
      const lower = entry.toLowerCase();
      return lower.includes("application/json") || lower.includes("+json");
    });
  }
  return false;
}

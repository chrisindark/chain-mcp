import { createNodeUpstreamTransport } from "./transport.js";
import type {
  UpstreamTransport,
  UpstreamTransportRequest,
  UpstreamTransportResponse,
} from "./types.js";

export interface ResilientTransportOptions {
  /** Base transport to wrap (defaults to a fresh node transport). */
  transport?: UpstreamTransport | undefined;
  /** Maximum number of attempts for an idempotent request (default 3). */
  maxAttempts?: number | undefined;
  /** Base delay in ms for exponential backoff (default 100). */
  baseDelayMs?: number | undefined;
  /** Max delay in ms (default 2000). */
  maxDelayMs?: number | undefined;
  /** Consecutive failures before opening the circuit (default 5). */
  failureThreshold?: number | undefined;
  /** Cooldown ms while circuit is open (default 30000). */
  cooldownMs?: number | undefined;
  /** Status codes that are retryable (default 429, 502, 503, 504). */
  retryableStatuses?: ReadonlySet<number> | undefined;
}

const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "OPTIONS", "PUT", "DELETE"]);
const DEFAULT_RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);

interface HostState {
  failures: number;
  openUntil: number;
}

export class CircuitBreakerOpenError extends Error {
  constructor(host: string) {
    super(`Circuit breaker open for host ${host}`);
    this.name = "CircuitBreakerOpenError";
  }
}

export function createResilientUpstreamTransport(
  options: ResilientTransportOptions = {},
): UpstreamTransport {
  const base = options.transport ?? createNodeUpstreamTransport();
  // Note: caller should pass a real transport; default placeholder avoids null.
  const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
  const baseDelayMs = options.baseDelayMs ?? 100;
  const maxDelayMs = options.maxDelayMs ?? 2000;
  const failureThreshold = options.failureThreshold ?? 5;
  const cooldownMs = options.cooldownMs ?? 30000;
  const retryableStatuses =
    options.retryableStatuses ?? DEFAULT_RETRYABLE_STATUSES;

  const hosts = new Map<string, HostState>();

  function getState(host: string): HostState {
    let s = hosts.get(host);
    if (!s) {
      s = { failures: 0, openUntil: 0 };
      hosts.set(host, s);
    }
    return s;
  }

  function sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      const t = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(t);
        reject(new DOMException("Aborted", "AbortError"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  return {
    async request(
      req: UpstreamTransportRequest,
    ): Promise<UpstreamTransportResponse> {
      const method = req.method.toUpperCase();
      const idempotent = IDEMPOTENT_METHODS.has(method);
      const host = req.url.hostname;
      const state = getState(host);

      const now = Date.now();
      if (state.openUntil > now) {
        throw new CircuitBreakerOpenError(host);
      }

      const attempts = idempotent ? maxAttempts : 1;
      let lastError: unknown;
      for (let attempt = 0; attempt < attempts; attempt++) {
        if (attempt > 0) {
          const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
          await sleep(delay, req.signal);
        }
        try {
          const res = await base.request(req);
          if (
            retryableStatuses.has(res.status) &&
            idempotent &&
            attempt < attempts - 1
          ) {
            state.failures += 1;
            if (state.failures >= failureThreshold) {
              state.openUntil = Date.now() + cooldownMs;
            }
            lastError = new Error(`Retryable status ${res.status}`);
            continue;
          }
          // success
          state.failures = 0;
          return res;
        } catch (err) {
          lastError = err;
          if (!idempotent || attempt >= attempts - 1) {
            state.failures += 1;
            if (state.failures >= failureThreshold) {
              state.openUntil = Date.now() + cooldownMs;
            }
            throw err;
          }
          state.failures += 1;
          if (state.failures >= failureThreshold) {
            state.openUntil = Date.now() + cooldownMs;
          }
        }
      }
      throw lastError instanceof Error
        ? lastError
        : new Error("Upstream request failed");
    },
  };
}

// Aliases for discoverability
export const createRetryTransport = createResilientUpstreamTransport;
export const createCircuitBreakerTransport = createResilientUpstreamTransport;

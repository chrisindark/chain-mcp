import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { type AddressInfo, isIP } from "node:net";

import type { Logger } from "@chainmcp/core";
import { normalizeHostname } from "@chainmcp/executor";

import { createDeclarativeAdmin, DeclarativeAdmin } from "./api.js";
import {
  DEFAULT_DECLARATIVE_ADMIN_PORT,
  MAX_DECLARATIVE_ADMIN_REQUEST_BYTES,
  type DeclarativeAdminErrorCode,
  type DeclarativeAdminOptions,
} from "./types.js";

const DEFAULT_HOST = "127.0.0.1";
const LOOPBACK_HOSTS: readonly string[] = ["localhost", "127.0.0.1", "::1"];
const MAX_REQUEST_BYTES_LIMIT = 10 * 1_048_576;

/** Headers the admin surface owns; a client cannot supply them. */
const UNSAFE_REQUEST_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "transfer-encoding",
]);

export interface DeclarativeAdminServerOptions {
  /** A configured admin handler, or options to build one. */
  readonly admin: DeclarativeAdmin | DeclarativeAdminOptions;
  /** Bind address. Defaults to loopback. */
  readonly host?: string;
  /** Port. Defaults to 3341; use 0 for an ephemeral port in tests. */
  readonly port?: number;
  /**
   * Permit a non-loopback bind. Defaults to false. The admin plane exposes
   * revision history and publication, so it must sit behind an authenticating
   * proxy when bound beyond loopback.
   */
  readonly allowRemote?: boolean;
  /** Node request-body cap in bytes. Default 1 MiB; maximum 10 MiB. */
  readonly maxRequestBytes?: number;
  /** Aborts shutdown when triggered. */
  readonly signal?: AbortSignal;
  readonly logger?: Logger;
}

export interface RunningDeclarativeAdminServer {
  readonly url: string;
  readonly host: string;
  readonly port: number;
  close(): Promise<void>;
}

/**
 * Starts the admin surface on a Node HTTP server.
 *
 * The transport adds two defenses the platform cannot: a Host allowlist (DNS
 * rebinding) and a same-origin check when a browser sends `Origin`/`Sec-Fetch-Site`
 * (cross-site requests carrying an operator's token). Both apply before the
 * admin handler runs.
 */
export async function startDeclarativeAdminServer(
  options: DeclarativeAdminServerOptions,
): Promise<RunningDeclarativeAdminServer> {
  const admin =
    options.admin instanceof DeclarativeAdmin
      ? options.admin
      : createDeclarativeAdmin(options.admin);

  const bindHost = normalizeHostname(options.host ?? DEFAULT_HOST);
  const port = options.port ?? DEFAULT_DECLARATIVE_ADMIN_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new TypeError("port must be an integer between 0 and 65535");
  }

  const allowRemote = options.allowRemote ?? false;
  const bindsAllInterfaces = bindHost === "0.0.0.0" || bindHost === "::";
  if (!allowRemote && !isLoopbackHost(bindHost)) {
    throw new TypeError(
      `Refusing to bind the declarative admin surface to non-loopback host '${bindHost}' without allowRemote: true`,
    );
  }

  const maxRequestBytes =
    options.maxRequestBytes ?? MAX_DECLARATIVE_ADMIN_REQUEST_BYTES;
  if (
    !Number.isInteger(maxRequestBytes) ||
    maxRequestBytes < 1_024 ||
    maxRequestBytes > MAX_REQUEST_BYTES_LIMIT
  ) {
    throw new TypeError(
      `maxRequestBytes must be an integer between 1024 and ${MAX_REQUEST_BYTES_LIMIT}`,
    );
  }

  const allowedHosts = new Set<string>(
    bindsAllInterfaces ? [] : [bindHost, ...LOOPBACK_HOSTS],
  );

  const server = createServer((request, response) => {
    void handleNodeRequest(
      admin,
      allowedHosts,
      maxRequestBytes,
      request,
      response,
      options.logger,
    );
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, bindHost);
  });

  const address = server.address() as AddressInfo;
  const displayHost = bindsAllInterfaces ? DEFAULT_HOST : bindHost;
  const url = `http://${formatHost(displayHost)}:${address.port}`;

  options.logger?.info("Declarative admin listening", {
    url,
    allowRemote,
  });
  if (bindsAllInterfaces) {
    options.logger?.warn(
      "Declarative admin is bound to all interfaces; Host header validation is disabled",
      { url },
    );
  }

  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    return closing;
  };

  const onAbort = (): void => {
    void close();
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });

  return {
    url,
    host: displayHost,
    port: address.port,
    close: async () => {
      options.signal?.removeEventListener("abort", onAbort);
      await close();
    },
  };
}

async function handleNodeRequest(
  admin: DeclarativeAdmin,
  allowedHosts: ReadonlySet<string>,
  maxRequestBytes: number,
  request: IncomingMessage,
  response: ServerResponse,
  logger: Logger | undefined,
): Promise<void> {
  const reject = (
    status: number,
    code: DeclarativeAdminErrorCode,
    message: string,
  ): void => {
    if (response.writableEnded) return;
    const payload = JSON.stringify({ error: { code, message } });
    response.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-length": Buffer.byteLength(payload),
    });
    response.end(payload);
  };

  try {
    const hostHeader = readHostHeader(request);
    if (hostHeader === undefined) {
      reject(400, "ADMIN_REQUEST_INVALID", "A valid Host header is required");
      return;
    }

    let hostname: string;
    try {
      hostname = normalizeHostname(new URL(`http://${hostHeader}`).hostname);
    } catch {
      reject(400, "ADMIN_REQUEST_INVALID", "Host header is invalid");
      return;
    }
    if (allowedHosts.size > 0 && !allowedHosts.has(hostname)) {
      reject(
        403,
        "ADMIN_ORIGIN_FORBIDDEN",
        "Host header is not an allowed admin hostname",
      );
      return;
    }

    const origin = request.headers.origin;
    if (origin !== undefined) {
      if (
        typeof origin !== "string" ||
        origin.toLowerCase() !== `http://${hostHeader.toLowerCase()}`
      ) {
        reject(
          403,
          "ADMIN_ORIGIN_FORBIDDEN",
          "Cross-origin admin requests are not allowed",
        );
        return;
      }
    }

    const fetchSite = request.headers["sec-fetch-site"];
    if (
      fetchSite !== undefined &&
      fetchSite !== "same-origin" &&
      fetchSite !== "none"
    ) {
      reject(
        403,
        "ADMIN_ORIGIN_FORBIDDEN",
        "Cross-site admin requests are not allowed",
      );
      return;
    }

    const method = request.method ?? "GET";
    const isBodyMethod = method !== "GET" && method !== "HEAD";

    const headers = new Headers();
    const raw = request.rawHeaders;
    for (let index = 0; index + 1 < raw.length; index += 2) {
      const name = raw[index];
      const value = raw[index + 1];
      if (name === undefined || value === undefined) continue;
      if (UNSAFE_REQUEST_HEADERS.has(name.toLowerCase())) continue;
      try {
        headers.append(name, value);
      } catch {
        reject(400, "ADMIN_REQUEST_INVALID", "Request headers are invalid");
        return;
      }
    }

    let body: Uint8Array | undefined;
    if (isBodyMethod) {
      const read = await readRequestBody(request, maxRequestBytes);
      if (!read.ok) {
        reject(413, "ADMIN_REQUEST_TOO_LARGE", read.message);
        return;
      }
      body = read.body;
    }

    const url = new URL(request.url ?? "/", `http://${hostHeader}`);
    const adminRequest = new Request(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body: new Uint8Array(body) }),
    });

    const adminResponse = await admin.handle(adminRequest);
    if (response.writableEnded) return;

    const responseHeaders: Record<string, string> = {};
    adminResponse.headers.forEach((value, name) => {
      responseHeaders[name] = value;
    });
    const payload = Buffer.from(await adminResponse.arrayBuffer());
    response.writeHead(adminResponse.status, responseHeaders);
    response.end(method === "HEAD" ? undefined : payload);
  } catch (error) {
    logger?.error("Declarative admin transport failure", {
      error: error instanceof Error ? error.name : "unknown",
    });
    reject(500, "ADMIN_INTERNAL", "The admin request failed");
  }
}

function readHostHeader(request: IncomingMessage): string | undefined {
  const host = request.headers.host;
  if (typeof host !== "string" || host.length === 0) return undefined;
  // Reject userinfo, whitespace, and paths smuggled into the Host header.
  if (!/^[A-Za-z0-9._:[\]-]+(?::\d{1,5})?$/.test(host)) return undefined;
  return host;
}

function formatHost(hostname: string): string {
  return isIP(hostname) === 6 ? `[${hostname}]` : hostname;
}

function isLoopbackHost(hostname: string): boolean {
  if (LOOPBACK_HOSTS.includes(hostname)) return true;
  return isIP(hostname) === 4 && hostname.startsWith("127.");
}

type BodyReadResult =
  | { readonly ok: true; readonly body: Uint8Array }
  | { readonly ok: false; readonly message: string };

function readRequestBody(
  request: IncomingMessage,
  maxBytes: number,
): Promise<BodyReadResult> {
  const declared = request.headers["content-length"];
  if (typeof declared === "string") {
    const length = Number(declared);
    if (!Number.isInteger(length) || length < 0) {
      return Promise.resolve({
        ok: false,
        message: "Content-Length must be a non-negative integer",
      });
    }
    if (length > maxBytes) {
      return Promise.resolve({
        ok: false,
        message: `Request body exceeds the ${maxBytes} byte limit`,
      });
    }
  }

  return new Promise<BodyReadResult>((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const finish = (result: BodyReadResult): void => {
      if (settled) return;
      settled = true;
      request.removeListener("data", onData);
      request.removeListener("end", onEnd);
      request.removeListener("error", onError);
      resolve(result);
    };

    function onData(chunk: Buffer): void {
      if (settled) return;
      total += chunk.byteLength;
      if (total > maxBytes) {
        finish({
          ok: false,
          message: `Request body exceeds the ${maxBytes} byte limit`,
        });
        // Drain the rest without buffering so the connection stays usable.
        request.resume();
        return;
      }
      chunks.push(chunk);
    }

    function onEnd(): void {
      finish({ ok: true, body: new Uint8Array(Buffer.concat(chunks, total)) });
    }

    function onError(): void {
      finish({ ok: false, message: "Request body could not be read" });
    }

    request.on("data", onData);
    request.on("end", onEnd);
    request.on("error", onError);
  });
}

import * as http from "node:http";
import * as https from "node:https";
import { readFile, stat } from "node:fs/promises";
import { isIP } from "node:net";
import { isAbsolute, resolve } from "node:path";

import {
  canonicalizeIp,
  classifyAddress,
  isSameAddress,
  normalizeHostname,
  systemHostResolver,
  type HostResolver,
} from "@chainmcp/executor";

import { CLI_VERSION } from "./types.js";

export const DEFAULT_SPEC_TIMEOUT_MS = 10_000;
export const DEFAULT_SPEC_MAX_BYTES = 10 * 1024 * 1024; // 10 MiB
export const DEFAULT_SPEC_MAX_REDIRECTS = 3;
export const MAX_SPEC_HEADER_BYTES = 16_384;

export interface LoadSpecOptions {
  source: string; // path or URL
  allowHttp?: boolean | undefined; // default false outside localhost
  timeoutMs?: number | undefined; // default 10_000
  maxBytes?: number | undefined; // default 10 MiB
  maxRedirects?: number | undefined; // default 3
  allowPrivateHosts?: boolean | undefined; // default false
  signal?: AbortSignal | undefined;
  cwd?: string | undefined;
  rejectUnauthorized?: boolean | undefined; // default true
  resolver?: HostResolver | undefined;
}

export interface LoadedSpec {
  content: string;
  sourceKind: "file" | "url";
  resolvedSource: string; // final URL after redirects, or resolved file path
  bytes: number;
  contentType?: string | undefined;
}

export function isUrlSource(source: string): boolean {
  if (source.startsWith("http://") || source.startsWith("https://")) {
    return true;
  }
  if (source.includes("://")) {
    try {
      const parsed = new URL(source);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error(
          `Unsupported URL scheme '${parsed.protocol}'. Only HTTP and HTTPS are supported for remote specifications.`,
        );
      }
      return true;
    } catch (err) {
      if (
        err instanceof Error &&
        err.message.includes("Unsupported URL scheme")
      ) {
        throw err;
      }
      throw new Error(`Invalid URL '${source}': ${(err as Error).message}`);
    }
  }
  return false;
}

export async function loadSpec(options: LoadSpecOptions): Promise<LoadedSpec> {
  if (isUrlSource(options.source)) {
    return loadUrlSpec(options);
  }
  return loadFileSpec(options);
}

async function loadFileSpec(options: LoadSpecOptions): Promise<LoadedSpec> {
  const maxBytes = options.maxBytes ?? DEFAULT_SPEC_MAX_BYTES;
  const filePath = isAbsolute(options.source)
    ? options.source
    : resolve(options.cwd ?? process.cwd(), options.source);

  let fileStat;
  try {
    fileStat = await stat(filePath);
  } catch (err) {
    throw new Error(
      `OpenAPI specification file was not found at ${filePath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  if (fileStat.size > maxBytes) {
    throw new Error(
      `Spec size exceeds limit of ${maxBytes} bytes (file is ${fileStat.size} bytes)`,
    );
  }

  const content = await readFile(filePath, "utf8");
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > maxBytes) {
    throw new Error(
      `Spec size exceeds limit of ${maxBytes} bytes (file is ${bytes} bytes)`,
    );
  }

  return {
    content,
    sourceKind: "file",
    resolvedSource: filePath,
    bytes,
  };
}

function validateContentType(
  rawHeader: string | undefined,
): string | undefined {
  if (!rawHeader) return undefined;
  const mime = rawHeader.split(";")[0]?.trim().toLowerCase();
  if (!mime) return undefined;

  if (mime === "text/html" || mime === "application/xhtml+xml") {
    throw new Error(
      `Unsupported content type '${mime}'. OpenAPI specifications must be JSON or YAML.`,
    );
  }

  const allowedMimes = new Set([
    "application/json",
    "application/yaml",
    "text/yaml",
    "application/x-yaml",
    "text/plain",
    "text/x-yaml",
    "application/octet-stream",
    "application/vnd.oai.openapi",
    "application/vnd.oai.openapi+json",
    "application/vnd.oai.openapi+yaml",
  ]);

  if (
    !allowedMimes.has(mime) &&
    !mime.endsWith("+json") &&
    !mime.endsWith("+yaml")
  ) {
    throw new Error(
      `Unsupported content type '${mime}'. OpenAPI specifications must be JSON or YAML.`,
    );
  }

  return mime;
}

interface HopFetchOptions {
  url: URL;
  pinnedAddress: string;
  addressFamily: 4 | 6;
  timeoutMs: number;
  maxBytes: number;
  rejectUnauthorized: boolean;
  callerSignal?: AbortSignal | undefined;
}

type HopResult =
  | { type: "redirect"; location: string }
  | {
      type: "content";
      content: string;
      bytes: number;
      contentType?: string | undefined;
    };

function fetchOneHop(options: HopFetchOptions): Promise<HopResult> {
  const {
    url,
    pinnedAddress,
    addressFamily,
    timeoutMs,
    maxBytes,
    rejectUnauthorized,
    callerSignal,
  } = options;
  const isHttps = url.protocol === "https:";
  const port = url.port ? Number(url.port) : isHttps ? 443 : 80;

  return new Promise<HopResult>((resolve, reject) => {
    let settled = false;
    let peerMismatch = false;
    let timeoutTimer: NodeJS.Timeout | undefined;

    const cleanup = (): void => {
      if (timeoutTimer !== undefined) {
        clearTimeout(timeoutTimer);
        timeoutTimer = undefined;
      }
    };

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };

    const abortController = new AbortController();
    let timedOut = false;

    timeoutTimer = setTimeout(() => {
      timedOut = true;
      abortController.abort(
        new Error(`Request timed out after ${timeoutMs}ms`),
      );
    }, timeoutMs);

    if (callerSignal) {
      if (callerSignal.aborted) {
        finish(() => reject(new Error("Request was aborted")));
        return;
      }
      callerSignal.addEventListener(
        "abort",
        () => {
          abortController.abort(new Error("Request was aborted"));
        },
        { once: true },
      );
    }

    const reqOptions: https.RequestOptions = {
      protocol: url.protocol,
      hostname: url.hostname,
      port,
      method: "GET",
      path: `${url.pathname}${url.search}`,
      headers: {
        accept:
          "application/yaml, application/json, text/yaml, text/plain, */*",
        "user-agent": `chainmcp/${CLI_VERSION}`,
      },
      agent: false,
      signal: abortController.signal,
      maxHeaderSize: MAX_SPEC_HEADER_BYTES,
      rejectUnauthorized,
      lookup: (_hostname, lookupOptions, callback) => {
        if (lookupOptions.all) {
          callback(null, [{ address: pinnedAddress, family: addressFamily }]);
        } else {
          callback(null, pinnedAddress, addressFamily);
        }
      },
    };

    const clientReq = isHttps
      ? https.request(reqOptions)
      : http.request(reqOptions);

    clientReq.on("socket", (socket) => {
      socket.once("connect", () => {
        const remote = socket.remoteAddress;
        if (remote !== undefined && !isSameAddress(remote, pinnedAddress)) {
          peerMismatch = true;
          socket.destroy(new Error("Pinned destination mismatch"));
        }
      });
    });

    clientReq.on("error", (err) => {
      finish(() => {
        if (timedOut) {
          reject(new Error(`Request timed out after ${timeoutMs}ms`));
        } else if (callerSignal?.aborted) {
          reject(new Error("Request was aborted"));
        } else if (peerMismatch) {
          reject(
            new Error(
              `Security error: Connected peer address did not match pinned address ${pinnedAddress}`,
            ),
          );
        } else {
          reject(err);
        }
      });
    });

    clientReq.on("response", (res) => {
      const status = res.statusCode ?? 0;

      // 1. Handle Redirects
      if ([301, 302, 303, 307, 308].includes(status)) {
        const location = res.headers.location;
        res.resume(); // discard response body
        if (!location) {
          finish(() =>
            reject(
              new Error(
                `HTTP ${status} redirect without Location header from ${url.href}`,
              ),
            ),
          );
          return;
        }
        finish(() => resolve({ type: "redirect", location }));
        return;
      }

      // 2. Non-redirect, non-2xx
      if (status < 200 || status >= 300) {
        res.resume();
        finish(() =>
          reject(
            new Error(
              `Failed to fetch spec from ${url.href}: HTTP ${status} ${
                res.statusMessage ?? ""
              }`.trim(),
            ),
          ),
        );
        return;
      }

      // 3. Validate Content-Type
      let contentType: string | undefined;
      try {
        contentType = validateContentType(res.headers["content-type"]);
      } catch (err) {
        res.resume();
        finish(() => reject(err));
        return;
      }

      // 4. Check Content-Length header against maxBytes
      const cl = res.headers["content-length"];
      if (cl !== undefined && /^\d+$/.test(cl)) {
        const lengthNum = Number(cl);
        if (lengthNum > maxBytes) {
          res.destroy();
          finish(() =>
            reject(new Error(`Spec size exceeds limit of ${maxBytes} bytes`)),
          );
          return;
        }
      }

      // 5. Stream body with byte limit
      const chunks: Buffer[] = [];
      let totalBytes = 0;

      res.on("data", (chunk: Buffer | string) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        totalBytes += buf.byteLength;
        if (totalBytes > maxBytes) {
          res.destroy();
          finish(() =>
            reject(new Error(`Spec size exceeds limit of ${maxBytes} bytes`)),
          );
          return;
        }
        chunks.push(buf);
      });

      res.on("end", () => {
        const fullContent = Buffer.concat(chunks, totalBytes).toString("utf8");
        finish(() =>
          resolve({
            type: "content",
            content: fullContent,
            bytes: totalBytes,
            ...(contentType ? { contentType } : {}),
          }),
        );
      });

      res.on("error", (err) => {
        finish(() => {
          if (timedOut) {
            reject(new Error(`Request timed out after ${timeoutMs}ms`));
          } else {
            reject(err);
          }
        });
      });
    });

    clientReq.end();
  });
}

async function loadUrlSpec(options: LoadSpecOptions): Promise<LoadedSpec> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_SPEC_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_SPEC_MAX_BYTES;
  const maxRedirects = options.maxRedirects ?? DEFAULT_SPEC_MAX_REDIRECTS;
  const allowHttp = options.allowHttp ?? false;
  const allowPrivateHosts = options.allowPrivateHosts ?? false;
  const rejectUnauthorized = options.rejectUnauthorized ?? true;
  const resolver = options.resolver ?? systemHostResolver;

  let currentUrl = new URL(options.source);
  let redirectCount = 0;

  while (true) {
    // 1. Validate scheme
    if (currentUrl.protocol !== "https:" && currentUrl.protocol !== "http:") {
      throw new Error(
        `Unsupported URL scheme '${currentUrl.protocol}'. Only HTTP and HTTPS are supported for remote specifications.`,
      );
    }

    // 2. Plain HTTP check: HTTP is disabled by default
    if (currentUrl.protocol === "http:" && !allowHttp) {
      throw new Error(
        "Plain HTTP is disabled for remote specifications. Use HTTPS, or set allowHttp to permit HTTP for loopback/private hosts.",
      );
    }

    // 3. Credentials check
    if (currentUrl.username.length > 0 || currentUrl.password.length > 0) {
      throw new Error("Remote specification URL must not contain credentials.");
    }

    // 4. Normalize hostname
    let hostname: string;
    try {
      hostname = normalizeHostname(currentUrl.hostname);
    } catch {
      throw new Error(
        `Invalid hostname '${currentUrl.hostname}' in specification URL.`,
      );
    }

    // 5. DNS resolution
    const ipVersion = isIP(hostname);
    let addresses: readonly string[];
    if (ipVersion === 4 || ipVersion === 6) {
      const canonical = canonicalizeIp(hostname);
      if (!canonical) {
        throw new Error(
          `Invalid IP address '${hostname}' in specification URL.`,
        );
      }
      addresses = [canonical];
    } else {
      try {
        addresses = await resolver(hostname);
      } catch (err) {
        throw new Error(
          `Could not resolve host '${hostname}': ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    if (!Array.isArray(addresses) || addresses.length === 0) {
      throw new Error(`Host '${hostname}' resolved to no addresses.`);
    }

    // Canonicalize all resolved addresses
    const canonicalAddresses: string[] = [];
    for (const addr of addresses) {
      const canonical = canonicalizeIp(addr);
      if (!canonical) {
        throw new Error(
          `Resolver returned invalid address '${addr}' for host '${hostname}'.`,
        );
      }
      canonicalAddresses.push(canonical);
    }

    // 6. Security classification and SSRF checks on all returned addresses
    for (const address of canonicalAddresses) {
      const classification = classifyAddress(address);

      if (classification === "metadata") {
        throw new Error(
          `Security error: Host '${currentUrl.hostname}' resolves to metadata address (${address}), which is blocked for SSRF protection.`,
        );
      }

      if (classification === "invalid" || classification === "unspecified") {
        throw new Error(
          `Security error: Host '${currentUrl.hostname}' resolves to invalid/unspecified address (${address}).`,
        );
      }

      if (classification === "loopback") {
        // If the hostname was not literally localhost / loopback IP, this is an SSRF/DNS rebinding attack
        if (hostname !== "localhost" && ipVersion === 0) {
          throw new Error(
            `Security error: Host '${hostname}' resolves to loopback address (${address}), which is blocked for SSRF protection.`,
          );
        }
        if (currentUrl.protocol === "http:" && !allowHttp) {
          throw new Error(
            "Plain HTTP is disabled for remote specifications. Use HTTPS, or set allowHttp to permit HTTP for loopback/private hosts.",
          );
        }
      } else if (
        classification === "private" ||
        classification === "link-local" ||
        classification === "shared" ||
        classification === "documentation" ||
        classification === "reserved" ||
        classification === "multicast"
      ) {
        if (!allowPrivateHosts) {
          throw new Error(
            `Security error: Host '${hostname}' resolves to private or restricted address (${address}), which is blocked for SSRF protection.`,
          );
        }
      } else if (classification === "public") {
        if (currentUrl.protocol === "http:") {
          throw new Error(
            "Plain HTTP is not permitted for public hosts. Remote specifications from public hosts must use HTTPS.",
          );
        }
      }
    }

    const pinnedAddress = canonicalAddresses[0]!;
    const addressFamily = isIP(pinnedAddress) as 4 | 6;

    // 7. Perform single request hop
    const hopResult = await fetchOneHop({
      url: currentUrl,
      pinnedAddress,
      addressFamily,
      timeoutMs,
      maxBytes,
      rejectUnauthorized,
      callerSignal: options.signal,
    });

    if (hopResult.type === "redirect") {
      redirectCount++;
      if (redirectCount > maxRedirects) {
        throw new Error(`Exceeded maximum redirect limit of ${maxRedirects}`);
      }
      const nextUrl = new URL(hopResult.location, currentUrl);
      if (currentUrl.protocol === "https:" && nextUrl.protocol === "http:") {
        throw new Error(
          "Insecure redirect: HTTPS to HTTP downgrade is not permitted.",
        );
      }
      currentUrl = nextUrl;
      continue;
    }

    return {
      content: hopResult.content,
      sourceKind: "url",
      resolvedSource: currentUrl.href,
      bytes: hopResult.bytes,
      ...(hopResult.contentType ? { contentType: hopResult.contentType } : {}),
    };
  }
}

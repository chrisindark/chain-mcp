import * as http from "node:http";
import * as https from "node:https";

import {
  InvalidResponseError,
  ResponseTooLargeError,
  UnsupportedResponseError,
} from "./errors.js";
import { isSameAddress } from "./destination.js";
import type {
  UpstreamTransport,
  UpstreamTransportRequest,
  UpstreamTransportResponse,
} from "./types.js";

export const MAX_RESPONSE_HEADER_BYTES = 16_384;

/**
 * Default transport. It ignores proxy environment variables, does not reuse
 * connections, pins the already-resolved address in the DNS lookup, verifies
 * the connected peer, refuses compressed responses, and caps the body while it
 * is still streaming.
 */
export function createNodeUpstreamTransport(): UpstreamTransport {
  return {
    request: requestNodeUpstream,
  };
}

function requestNodeUpstream(
  request: UpstreamTransportRequest,
): Promise<UpstreamTransportResponse> {
  if (
    !Number.isSafeInteger(request.maxResponseBytes) ||
    request.maxResponseBytes <= 0
  ) {
    return Promise.reject(
      new TypeError("maxResponseBytes must be a positive integer"),
    );
  }
  const isHttps = request.url.protocol === "https:";
  const port =
    request.url.port.length > 0 ? Number(request.url.port) : isHttps ? 443 : 80;
  const headers: Record<string, string> = { ...request.headers };
  if (request.body !== undefined && !hasHeader(headers, "content-length")) {
    headers["content-length"] = String(request.body.byteLength);
  }

  return new Promise<UpstreamTransportResponse>((resolve, reject) => {
    let settled = false;
    let peerMismatch = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      callback();
    };

    const options: https.RequestOptions = {
      protocol: request.url.protocol,
      hostname: request.hostname,
      port,
      method: request.method,
      path: `${request.url.pathname}${request.url.search}`,
      headers,
      agent: false,
      signal: request.signal,
      maxHeaderSize: MAX_RESPONSE_HEADER_BYTES,
      lookup: (_hostname, lookupOptions, callback) => {
        // Ignore the hostname argument: Node must connect to the exact
        // address that policy checks approved, not perform a second lookup.
        if (lookupOptions.all) {
          callback(null, [
            { address: request.address, family: request.family },
          ]);
        } else {
          callback(null, request.address, request.family);
        }
      },
    };

    const clientRequest = isHttps
      ? https.request(options)
      : http.request(options);

    clientRequest.on("socket", (socket) => {
      socket.once("connect", () => {
        const remote = socket.remoteAddress;
        if (remote === undefined || !isSameAddress(remote, request.address)) {
          peerMismatch = true;
          socket.destroy(new Error("Pinned destination mismatch"));
        }
      });
    });

    clientRequest.on("error", (error) => {
      finish(() =>
        reject(
          peerMismatch
            ? new InvalidResponseError("Upstream peer did not match policy", {
                cause: error,
              })
            : error,
        ),
      );
    });

    clientRequest.on("response", (response) => {
      const status = response.statusCode;
      if (status === undefined) {
        discardResponse(response);
        finish(() =>
          reject(new InvalidResponseError("Upstream response had no status")),
        );
        return;
      }

      const encodings = headerValues(response.headers, "content-encoding");
      if (encodings.some((encoding) => encoding.toLowerCase() !== "identity")) {
        discardResponse(response);
        finish(() =>
          reject(
            new UnsupportedResponseError(
              "Compressed upstream responses are not supported",
            ),
          ),
        );
        return;
      }

      const contentLengths = headerValues(response.headers, "content-length");
      if (contentLengths.length > 1) {
        discardResponse(response);
        finish(() =>
          reject(
            new InvalidResponseError(
              "Upstream response had duplicate content-length headers",
            ),
          ),
        );
        return;
      }
      const contentLength = contentLengths[0];
      if (
        contentLength !== undefined &&
        /^\d+$/.test(contentLength) &&
        Number(contentLength) > request.maxResponseBytes
      ) {
        discardResponse(response);
        finish(() => reject(new ResponseTooLargeError()));
        return;
      }

      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.byteLength;
        if (size > request.maxResponseBytes) {
          finish(() => reject(new ResponseTooLargeError()));
          response.destroy();
          return;
        }
        chunks.push(buffer);
      });
      response.on("aborted", () => {
        finish(() =>
          reject(new InvalidResponseError("Upstream response was aborted")),
        );
      });
      response.on("error", (error) => {
        finish(() => reject(error));
      });
      response.on("end", () => {
        finish(() =>
          resolve({
            status,
            headers: response.headers,
            body: Buffer.concat(chunks, size),
          }),
        );
      });
    });

    if (request.body === undefined) clientRequest.end();
    else clientRequest.end(request.body);
  });
}

function hasHeader(
  headers: Readonly<Record<string, string>>,
  name: string,
): boolean {
  return Object.keys(headers).some(
    (key) => key.toLowerCase() === name.toLowerCase(),
  );
}

/** Drains a rejected response while absorbing late stream errors. */
function discardResponse(response: http.IncomingMessage): void {
  response.on("error", () => {});
  response.on("aborted", () => {});
  response.resume();
}

function headerValues(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  name: string,
): readonly string[] {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name) continue;
    if (Array.isArray(value)) return value;
    return value === undefined ? [] : [value];
  }
  return [];
}

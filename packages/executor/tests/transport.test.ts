import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createNodeUpstreamTransport,
  type UpstreamTransportRequest,
} from "../src/index.js";

let server: Server;
let port: number;

beforeEach(async () => {
  server = createServer((request, response) => {
    const url = request.url ?? "/";
    if (url === "/json") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true}');
      return;
    }
    if (url === "/large") {
      response.writeHead(200, { "content-type": "application/json" });
      for (let index = 0; index < 32; index += 1) {
        response.write("0123456789abcdef");
      }
      response.end();
      return;
    }
    if (url === "/declared-large") {
      response.writeHead(200, {
        "content-type": "application/json",
        "content-length": "999999",
      });
      response.end("{}");
      return;
    }
    if (url === "/compressed") {
      response.writeHead(200, {
        "content-type": "application/json",
        "content-encoding": "gzip",
      });
      response.end("{}");
      return;
    }
    if (url === "/echo") {
      let body = "";
      request.on("data", (chunk: Buffer) => {
        body += chunk.toString("utf8");
      });
      request.on("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            method: request.method,
            body,
            contentLength: request.headers["content-length"],
          }),
        );
      });
      return;
    }
    if (url === "/hang") {
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("test server did not bind to a port");
  }
  port = address.port;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

function request(
  path: string,
  overrides: Partial<UpstreamTransportRequest> = {},
): UpstreamTransportRequest {
  return {
    url: new URL(`http://127.0.0.1:${port}${path}`),
    hostname: "127.0.0.1",
    address: "127.0.0.1",
    family: 4,
    method: "GET",
    headers: { accept: "application/json", "accept-encoding": "identity" },
    maxResponseBytes: 1_024,
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe("Node upstream transport", () => {
  it("returns a bounded response and verifies the pinned peer", async () => {
    const response = await createNodeUpstreamTransport().request(
      request("/json"),
    );
    expect(response.status).toBe(200);
    expect(new TextDecoder().decode(response.body)).toBe('{"ok":true}');
  });

  it("sends the body with a content length", async () => {
    const response = await createNodeUpstreamTransport().request(
      request("/echo", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: new TextEncoder().encode('{"a":1}'),
      }),
    );
    expect(JSON.parse(new TextDecoder().decode(response.body))).toEqual({
      method: "POST",
      body: '{"a":1}',
      contentLength: "7",
    });
  });

  it("caps a streamed response", async () => {
    await expect(
      createNodeUpstreamTransport().request(
        request("/large", { maxResponseBytes: 64 }),
      ),
    ).rejects.toMatchObject({ name: "ResponseTooLargeError" });
  });

  it("rejects a declared content length over the cap", async () => {
    await expect(
      createNodeUpstreamTransport().request(
        request("/declared-large", { maxResponseBytes: 64 }),
      ),
    ).rejects.toMatchObject({ name: "ResponseTooLargeError" });
  });

  it("rejects compressed responses instead of decompressing", async () => {
    await expect(
      createNodeUpstreamTransport().request(request("/compressed")),
    ).rejects.toMatchObject({ name: "UnsupportedResponseError" });
  });

  it("aborts an in-flight request", async () => {
    const controller = new AbortController();
    const pending = createNodeUpstreamTransport().request(
      request("/hang", { signal: controller.signal }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort(new Error("cancelled"));
    await expect(pending).rejects.toBeDefined();
  });
});

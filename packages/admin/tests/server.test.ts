import { request as httpRequest } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import {
  startDeclarativeAdminServer,
  type RunningDeclarativeAdminServer,
} from "../src/index.js";
import {
  ADMIN_TOKEN,
  CONTRACT_PATH,
  makeAdmin,
  makeDescriptor,
} from "./fixtures.js";

const running: RunningDeclarativeAdminServer[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.close()));
});

async function start(): Promise<RunningDeclarativeAdminServer> {
  const { admin } = makeAdmin();
  const server = await startDeclarativeAdminServer({ admin, port: 0 });
  running.push(server);
  return server;
}

describe("declarative admin server", () => {
  it("serves the console and API on loopback", async () => {
    const server = await start();
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    const page = await fetch(`${server.url}/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Declarative tool admin");

    const contracts = await fetch(`${server.url}/api/v1/contracts`, {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(contracts.status).toBe(200);
    expect(await contracts.json()).toMatchObject({
      contracts: [{ tenantId: "tenant-a", contractName: "users" }],
    });
  });

  it("accepts same-origin browser submissions", async () => {
    const server = await start();

    const response = await fetch(`${server.url}${CONTRACT_PATH}/validate`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${ADMIN_TOKEN}`,
        "content-type": "application/json",
        origin: server.url,
        "sec-fetch-site": "same-origin",
      },
      body: JSON.stringify({ descriptors: [makeDescriptor()] }),
    });

    expect(response.status).toBe(200);
  });

  it("rejects cross-origin requests before the admin handler runs", async () => {
    const server = await start();
    const { audit } = makeAdmin();
    expect(audit).toEqual([]);

    const response = await fetch(`${server.url}${CONTRACT_PATH}/publish`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${ADMIN_TOKEN}`,
        "content-type": "application/json",
        origin: "http://evil.example",
      },
      body: JSON.stringify({ descriptors: [makeDescriptor()] }),
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { code: "ADMIN_ORIGIN_FORBIDDEN" },
    });

    const crossSite = await fetch(`${server.url}/api/v1/contracts`, {
      headers: {
        authorization: `Bearer ${ADMIN_TOKEN}`,
        "sec-fetch-site": "cross-site",
      },
    });
    expect(crossSite.status).toBe(403);
  });

  it("rejects requests whose Host header is not an admin host", async () => {
    const server = await start();
    const url = new URL(server.url);

    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(
        {
          hostname: url.hostname,
          port: url.port,
          path: "/",
          method: "GET",
          headers: { host: "evil.example" },
        },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        },
      );
      request.on("error", reject);
      request.end();
    });

    expect(status).toBe(403);
  });

  it("refuses a non-loopback bind without allowRemote", async () => {
    const { admin } = makeAdmin();
    await expect(
      startDeclarativeAdminServer({ admin, host: "0.0.0.0", port: 0 }),
    ).rejects.toThrowError(/non-loopback/);
  });

  it("stops accepting requests after close", async () => {
    const { admin } = makeAdmin();
    const server = await startDeclarativeAdminServer({ admin, port: 0 });
    await server.close();

    await expect(fetch(`${server.url}/`)).rejects.toThrow();
  });
});

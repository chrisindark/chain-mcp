import { request as httpRequest } from "node:http";
import { describe, expect, it, vi } from "vitest";

import {
  DeclarativeAdmin,
  startDeclarativeAdminServer,
  type DeclarativeAdminOptions,
} from "../src/index.js";
import {
  ADMIN_TOKEN,
  CONTRACT_PATH,
  makeAdmin,
  makeDescriptor,
} from "./fixtures.js";

const TENANT_ID = "tenant-a";

describe("admin api and server additional coverage", () => {
  describe("server options and request handling", () => {
    it("validates server port and maxRequestBytes options", async () => {
      const { admin } = makeAdmin();
      await expect(
        startDeclarativeAdminServer({ admin, port: -1 }),
      ).rejects.toThrowError(/port must be an integer between 0 and 65535/);

      await expect(
        startDeclarativeAdminServer({ admin, port: 70000 }),
      ).rejects.toThrowError(/port must be an integer between 0 and 65535/);

      await expect(
        startDeclarativeAdminServer({ admin, port: 0, maxRequestBytes: 100 }),
      ).rejects.toThrowError(/maxRequestBytes must be an integer between 1024/);
    });

    it("supports 0.0.0.0 bind with allowRemote: true and logs warning", async () => {
      const warnMock = vi.fn();
      const logger = {
        info: vi.fn(),
        warn: warnMock,
        error: vi.fn(),
        debug: vi.fn(),
      };
      const { admin } = makeAdmin();
      const server = await startDeclarativeAdminServer({
        admin,
        host: "0.0.0.0",
        port: 0,
        allowRemote: true,
        logger,
      });

      expect(warnMock).toHaveBeenCalled();
      await server.close();
    });

    it("aborts shutdown when options.signal is triggered", async () => {
      const controller = new AbortController();
      const { admin } = makeAdmin();
      const server = await startDeclarativeAdminServer({
        admin,
        port: 0,
        signal: controller.signal,
      });

      controller.abort();
      await new Promise((r) => setTimeout(r, 50));
      await expect(fetch(`${server.url}/`)).rejects.toThrow();
    });

    it("handles HEAD requests without a response body", async () => {
      const { admin } = makeAdmin();
      const server = await startDeclarativeAdminServer({ admin, port: 0 });

      try {
        const res = await fetch(`${server.url}/`, { method: "HEAD" });
        expect(res.status).toBe(405);
        const text = await res.text();
        expect(text).toBe("");
      } finally {
        await server.close();
      }
    });

    it("rejects node request when Host header is missing or invalid", async () => {
      const { admin } = makeAdmin();
      const server = await startDeclarativeAdminServer({ admin, port: 0 });
      const url = new URL(server.url);

      try {
        const status = await new Promise<number>((resolve, reject) => {
          const req = httpRequest(
            {
              hostname: url.hostname,
              port: url.port,
              path: "/",
              method: "GET",
              headers: { host: "invalid::host::name" },
            },
            (res) => {
              res.resume();
              resolve(res.statusCode ?? 0);
            },
          );
          req.on("error", reject);
          req.end();
        });
        expect(status).toBe(400);
      } finally {
        await server.close();
      }
    });

    it("rejects node request when body exceeds maxRequestBytes", async () => {
      const { admin } = makeAdmin();
      const server = await startDeclarativeAdminServer({
        admin,
        port: 0,
        maxRequestBytes: 1024,
      });

      try {
        const largeBody = JSON.stringify({
          descriptors: [makeDescriptor()],
          extra: "x".repeat(2000),
        });

        const res = await fetch(`${server.url}${CONTRACT_PATH}/validate`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${ADMIN_TOKEN}`,
            "content-type": "application/json",
          },
          body: largeBody,
        });

        expect(res.status).toBe(413);
        const json = await res.json();
        expect(json.error.code).toBe("ADMIN_REQUEST_TOO_LARGE");
      } finally {
        await server.close();
      }
    });
  });

  describe("DeclarativeAdmin constructor validation", () => {
    it("validates constructor options", () => {
      expect(
        () => new DeclarativeAdmin(null as unknown as DeclarativeAdminOptions),
      ).toThrowError(/requires an options object/);
      expect(
        () =>
          new DeclarativeAdmin({
            gateway: {},
          } as unknown as DeclarativeAdminOptions),
      ).toThrowError(/requires a DynamicGateway with publishContract/);
      expect(
        () =>
          new DeclarativeAdmin({
            gateway: { publishContract: () => {}, getRegistry: () => {} },
            tokens: [],
          } as unknown as DeclarativeAdminOptions),
      ).toThrowError(/requires at least one configured bearer token/);
      expect(
        () =>
          new DeclarativeAdmin({
            gateway: { publishContract: () => {}, getRegistry: () => {} },
            tokens: [{ id: "t1", token: ADMIN_TOKEN, tenants: "*" }],
            maxRequestBytes: 50,
          } as unknown as DeclarativeAdminOptions),
      ).toThrowError(/maxRequestBytes must be an integer between/);
      expect(
        () =>
          new DeclarativeAdmin({
            gateway: { publishContract: () => {}, getRegistry: () => {} },
            tokens: [{ id: "t1", token: ADMIN_TOKEN, tenants: "*" }],
            repository: {} as unknown as DeclarativeAdminOptions["repository"],
          } as unknown as DeclarativeAdminOptions),
      ).toThrowError(/repository must implement the DescriptorRevisionStore/);
    });

    it("exposes storeKind getter", () => {
      const { admin } = makeAdmin();
      expect(admin.storeKind).toBe("memory");
    });
  });

  describe("DeclarativeAdmin HTTP endpoints and error handling", () => {
    it("handles healthz and root endpoints index", async () => {
      const { admin } = makeAdmin();

      const healthRes = await admin.handle(
        new Request("http://127.0.0.1/api/v1/healthz", { method: "GET" }),
      );
      expect(healthRes.status).toBe(200);
      expect(await healthRes.json()).toEqual({ status: "ok" });

      const indexRes = await admin.handle(
        new Request("http://127.0.0.1/api/v1", { method: "GET" }),
      );
      expect(indexRes.status).toBe(200);
      const indexJson = await indexRes.json();
      expect(indexJson.service).toBe("chainmcp-declarative-admin");
      expect(Array.isArray(indexJson.endpoints)).toBe(true);
    });

    it("serves ui static assets and 404s on unknown assets", async () => {
      const { admin } = makeAdmin();

      const jsRes = await admin.handle(
        new Request("http://127.0.0.1/ui/app.js", { method: "GET" }),
      );
      expect(jsRes.status).toBe(200);
      expect(jsRes.headers.get("content-type")).toContain("javascript");

      const cssRes = await admin.handle(
        new Request("http://127.0.0.1/ui/app.css", { method: "GET" }),
      );
      expect(cssRes.status).toBe(200);
      expect(cssRes.headers.get("content-type")).toContain("css");

      const notFoundRes = await admin.handle(
        new Request("http://127.0.0.1/ui/missing.png", { method: "GET" }),
      );
      expect(notFoundRes.status).toBe(404);
    });

    it("rejects path with invalid percent encoding", async () => {
      const { admin } = makeAdmin();
      const res = await admin.handle(
        new Request("http://127.0.0.1/api/v1/%E0%A4%A", { method: "GET" }),
      );
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe("ADMIN_REQUEST_INVALID");
    });

    it("enforces assertMethod on endpoints (405)", async () => {
      const { admin } = makeAdmin();
      const res = await admin.handle(
        new Request("http://127.0.0.1/api/v1/healthz", { method: "DELETE" }),
      );
      expect(res.status).toBe(405);
      const json = await res.json();
      expect(json.error.code).toBe("ADMIN_METHOD_NOT_ALLOWED");
    });

    it("validates Content-Type header on POST endpoints (415)", async () => {
      const { admin } = makeAdmin();

      const missingCt = await admin.handle(
        new Request(`http://127.0.0.1${CONTRACT_PATH}/validate`, {
          method: "POST",
          headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
          body: JSON.stringify({ descriptors: [] }),
        }),
      );
      expect(missingCt.status).toBe(415);

      const wrongCt = await admin.handle(
        new Request(`http://127.0.0.1${CONTRACT_PATH}/validate`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${ADMIN_TOKEN}`,
            "content-type": "text/plain",
          },
          body: JSON.stringify({ descriptors: [] }),
        }),
      );
      expect(wrongCt.status).toBe(415);
    });

    it("validates Content-Length header format and limits", async () => {
      const { admin } = makeAdmin();

      const invalidCl = await admin.handle(
        new Request(`http://127.0.0.1${CONTRACT_PATH}/validate`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${ADMIN_TOKEN}`,
            "content-type": "application/json",
            "content-length": "not-a-number",
          },
          body: JSON.stringify({ descriptors: [] }),
        }),
      );
      expect(invalidCl.status).toBe(400);

      const hugeCl = await admin.handle(
        new Request(`http://127.0.0.1${CONTRACT_PATH}/validate`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${ADMIN_TOKEN}`,
            "content-type": "application/json",
            "content-length": "999999999",
          },
          body: JSON.stringify({ descriptors: [] }),
        }),
      );
      expect(hugeCl.status).toBe(413);
    });

    it("validates JSON request bodies", async () => {
      const { admin } = makeAdmin();

      // Empty body
      const emptyRes = await admin.handle(
        new Request(`http://127.0.0.1${CONTRACT_PATH}/validate`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${ADMIN_TOKEN}`,
            "content-type": "application/json",
          },
          body: "",
        }),
      );
      expect(emptyRes.status).toBe(400);

      // Malformed JSON syntax
      const malformedRes = await admin.handle(
        new Request(`http://127.0.0.1${CONTRACT_PATH}/validate`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${ADMIN_TOKEN}`,
            "content-type": "application/json",
          },
          body: "{ not json }",
        }),
      );
      expect(malformedRes.status).toBe(400);

      // Body is an array instead of an object
      const arrayRes = await admin.handle(
        new Request(`http://127.0.0.1${CONTRACT_PATH}/validate`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${ADMIN_TOKEN}`,
            "content-type": "application/json",
          },
          body: "[]",
        }),
      );
      expect(arrayRes.status).toBe(400);

      // Body missing descriptors array
      const noDescRes = await admin.handle(
        new Request(`http://127.0.0.1${CONTRACT_PATH}/validate`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${ADMIN_TOKEN}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ other: 123 }),
        }),
      );
      expect(noDescRes.status).toBe(400);

      // Descriptors exceeds MAX_DECLARATIVE_DESCRIPTORS (1000)
      const tooManyDescRes = await admin.handle(
        new Request(`http://127.0.0.1${CONTRACT_PATH}/validate`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${ADMIN_TOKEN}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            descriptors: Array.from({ length: 1001 }, () => makeDescriptor()),
          }),
        }),
      );
      expect(tooManyDescRes.status).toBe(400);
    });

    it("returns 404 for unknown contract or revision", async () => {
      const { admin } = makeAdmin();

      const contractRes = await admin.handle(
        new Request(
          `http://127.0.0.1/api/v1/tenants/${TENANT_ID}/contracts/nonexistent/tools`,
          {
            method: "GET",
            headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
          },
        ),
      );
      expect(contractRes.status).toBe(404);

      const revRes = await admin.handle(
        new Request(
          `http://127.0.0.1${CONTRACT_PATH}/revisions/rev_nonexistent`,
          {
            method: "GET",
            headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
          },
        ),
      );
      expect(revRes.status).toBe(404);
    });

    it("rejects rollback of already active revision or non-superseded revision", async () => {
      const { admin } = makeAdmin();

      // Publish revision 1
      const pubRes = await admin.handle(
        new Request(`http://127.0.0.1${CONTRACT_PATH}/publish`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${ADMIN_TOKEN}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ descriptors: [makeDescriptor()] }),
        }),
      );
      expect(pubRes.status).toBe(201);
      const pubData = await pubRes.json();
      const rev1Id = pubData.revisionId;

      // Attempting to rollback to the already active revision returns 409
      const conflictRes = await admin.handle(
        new Request(`http://127.0.0.1${CONTRACT_PATH}/rollback`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${ADMIN_TOKEN}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ revisionId: rev1Id }),
        }),
      );
      expect(conflictRes.status).toBe(409);
      const conflictJson = await conflictRes.json();
      expect(conflictJson.error.code).toBe("ADMIN_REVISION_CONFLICT");
      expect(conflictJson.error.message).toContain("is already active");
    });

    it("handles audit sink errors gracefully without failing request", async () => {
      const { admin } = makeAdmin({
        auditSink: vi.fn().mockRejectedValue(new Error("audit write failure")),
      });

      const res = await admin.handle(
        new Request(`http://127.0.0.1${CONTRACT_PATH}/validate`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${ADMIN_TOKEN}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ descriptors: [makeDescriptor()] }),
        }),
      );
      expect(res.status).toBe(200);
    });

    it("restore handles empty active revision and already active contract", async () => {
      const { admin } = makeAdmin();

      // Initially no active revision in store
      const res1 = await admin.restore();
      expect(res1.restored).toEqual([]);
      expect(res1.failures).toEqual([]);

      // Publish a revision so it becomes active in store and gateway
      await admin.handle(
        new Request(`http://127.0.0.1${CONTRACT_PATH}/publish`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${ADMIN_TOKEN}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ descriptors: [makeDescriptor()] }),
        }),
      );

      // Restore should now see the revision is already active in gateway
      const res2 = await admin.restore();
      expect(res2.skipped.some((s) => s.reason === "already_active")).toBe(
        true,
      );
    });
  });
});

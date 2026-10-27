import * as http from "node:http";
import * as https from "node:https";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { exportCommand } from "../src/commands/export.js";
import { serveCommand } from "../src/commands/serve.js";
import { loadSpec } from "../src/spec-loader.js";

const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQCc9DzW9/w4QfZm
du1KRmaKCkz6Vim5nXKMrkcoJc+CdC4fdbpqlJSDdCnUAHkoqJ+YbH8cqtJeQi4+
HRLI305EevgjlJ8unNl0Pz6fSJArr0r/fipzAHnJLB6wwJ9sByX9tx6nuSzAfHUp
eCB+vHbtIa7+ALn29ABVT1F/znTE0ri/oOmmNUjNoI8ty3hx3t6W+SlBM/kwjzL6
ukF64Lu+n2FonalrhOWskw8oMMK/rh/YjuxLe0D1RgdK3/rTVot9+C+nrIZalFXp
5Nnpq9E7d4dy3VTysywWjRYBDCH3o7AHo1dy/6In4HhCnm9SNUpP55f6gDg8xw0h
Ot2enXtvAgMBAAECggEAORDEHhTD62BwSgjrdZnrJj1gh5RUT1xjjaq/zGUS8Yd0
TZPsV1v2M2VE4APcCWBlxnGMNcwV+JdvYL4JWmd2eYeMOMOMrNHybkWgayFi6b8u
MX6ZyH5fyTj1X6ZpUEm5EmpGBw1YrBOUNaOrjOjRBJ6+lTOGabeFd38DTsitw/GX
sj7JhE5mZBW50eFJZBG5RBkLzliAqOV9g10zOSu2d4LlzrTkc93tEcEo2HvZaM8A
BrtZ17a203UBTrCQsZrHS4McooTyuPPh+wbo6omEhutwPSC/fh8kfQrGj1sddqkm
KIUZVjhzMpZj5lHdrpPFUdxw7Pjg4CFShepaj/3YwQKBgQDSjx/VOZijJTJEdxvQ
+y41BIAY5ZbK1MojTG2yGn7mD5lAjNyAVIWFW4fsLTNYFt0Lh8czViX8QWixo1RA
1cg1jqb3/SYlywSo2zkUBYqArHcaE8Pdoml+786hg3lQtvH1BHo08jTw/rIcufmN
SNNPhR6tHZuD18abJs5T5RYCVwKBgQC+05D7ozvL1fCSDkcwy8oWy020GQr99DiC
HPj9UrpHyitUiijeDEV1NKgCWFLJdFcbu0ct3APY2xotsPromDo5gQS4kpIuj5OD
IDHww6h64klzQL+vc16pth2E7UojcbNE0GpksP15C9r1wx0VQfb5UD7EV6cPJWsq
bwE5o0OQqQKBgQDLjHbujxZiqOO2Uhq+5QNfV3FqIBCtFhYvF4R4B6sjRnMVdtb2
7D6Dk9+LTorzHm8j5WeJ1j80ZBsMluMtJj28oKIC3GOTZ3aisgK0u0KQb6lXuUHA
sXAguTzc4JdXkvPGtERbiMXrL50JrjN0BLHajsr/+b5MLz0c4d/WNIEZUwKBgCpc
JI73iUqSTzjc2ojGdDHjJ3iXJo2BLRoU/GCfgKJ3Cm9VzASejLyb17/Ng3Mc1Elf
pUlU0bXNzV3fL5N6V1J0hWvDfZfAX2p4Nx3PERNWMB/Ze7Oi1JyvxJXBZve/QaBA
850ufNXl/9EWYtpZLk3htk03d+ow0D03Lvpwd4shAoGBAKzMBUZPYqwiTPVADIqq
DwudHOutbheFu4C4JhCQCC24y2a27Kf7Ib7pAL6e1OTuN4d9IxRMwIf1Xr9juzek
z6qedOjHhUAj2FJeYlvUvMTtsBK9jsKtEDGxD8dkX/nOIcvSFgYK2Lq7mDWYwdTB
ap0EN0ddKs/L8t8fB8U14Ahi
-----END PRIVATE KEY-----`;

const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIC6DCCAdCgAwIBAgIUcB0z8uPBel7SKIH8gELzMQ0Dx8YwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MTAyNzExMTgyNloXDTM2MTAy
NDExMTgyNlowFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEAnPQ81vf8OEH2ZnbtSkZmigpM+lYpuZ1yjK5HKCXPgnQu
H3W6apSUg3Qp1AB5KKifmGx/HKrSXkIuPh0SyN9ORHr4I5SfLpzZdD8+n0iQK69K
/34qcwB5ySwesMCfbAcl/bcep7kswHx1KXggfrx27SGu/gC59vQAVU9Rf850xNK4
v6DppjVIzaCPLct4cd7elvkpQTP5MI8y+rpBeuC7vp9haJ2pa4TlrJMPKDDCv64f
2I7sS3tA9UYHSt/601aLffgvp6yGWpRV6eTZ6avRO3eHct1U8rMsFo0WAQwh96Ow
B6NXcv+iJ+B4Qp5vUjVKT+eX+oA4PMcNITrdnp17bwIDAQABozIwMDAdBgNVHQ4E
FgQUGKp7nv8s1l/+cp9fxhPWtoTmVNwwDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG
9w0BAQsFAAOCAQEAUdXDYOvDicfrNJXqX0Z2j/R7nloG48kH1r7d6SoXpdXvGL6t
9qIEjnw+Rxcjgy9hVtLuxTKkTyoaFUi+woc3v4pnRyzrkRxC+wZBP5QcrphNeqql
/LH7rVGuqI5CtWVosLXePX9Iq5gp4Rz1LDtDALl5zHfi2RWbKAX/O+l52K4+eQOL
+7IS5Kij5Dv8h/2Fw8lfcQ2nmPZjGn93RVmrbHISCW7DsVnNKKiwCcbQS7L35XeV
+vUxuMJC4F2ygCR+d7XZu3R9JVJDY6RP0ajNWIPnECvWgkXxyZa0GsW9svNoQSqg
DF3daExmno2gJnNsVZwt9kxn7NLO4SJaeroEpA==
-----END CERTIFICATE-----`;

const SAMPLE_SPEC = `
openapi: "3.1.0"
info:
  title: Pet Catalog API
  version: "1.0.0"
servers:
  - url: https://api.petstore.test/v1
paths:
  /pets:
    get:
      operationId: listPets
      summary: List all pets
      responses:
        "200":
          description: A list of pets
          content:
            application/json:
              schema:
                type: array
                items:
                  type: object
                  properties:
                    id:
                      type: string
`;

describe("spec-loader (RM-07)", () => {
  let tempDir: string;
  let specPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "chainmcp-spec-loader-test-"));
    specPath = join(tempDir, "openapi.yaml");
    await writeFile(specPath, SAMPLE_SPEC, "utf8");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("file path loads and reports sourceKind: 'file'", async () => {
    const loaded = await loadSpec({ source: specPath });
    expect(loaded.sourceKind).toBe("file");
    expect(loaded.resolvedSource).toBe(specPath);
    expect(loaded.bytes).toBeGreaterThan(0);
    expect(loaded.content).toContain("Pet Catalog API");
  });

  it("https URL to a local test server loads", async () => {
    const server = https.createServer(
      { key: TEST_KEY, cert: TEST_CERT },
      (req, res) => {
        void req;
        res.writeHead(200, { "content-type": "application/yaml" });
        res.end(SAMPLE_SPEC);
      },
    );

    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const port = (server.address() as { port: number }).port;

    try {
      const loaded = await loadSpec({
        source: `https://127.0.0.1:${port}/spec.yaml`,
        rejectUnauthorized: false,
      });

      expect(loaded.sourceKind).toBe("url");
      expect(loaded.resolvedSource).toBe(`https://127.0.0.1:${port}/spec.yaml`);
      expect(loaded.bytes).toBeGreaterThan(0);
      expect(loaded.content).toContain("Pet Catalog API");
      expect(loaded.contentType).toBe("application/yaml");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("http URL to loopback without opt-in is rejected with a clear error", async () => {
    const server = http.createServer((req, res) => {
      void req;
      res.writeHead(200, { "content-type": "application/yaml" });
      res.end(SAMPLE_SPEC);
    });

    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const port = (server.address() as { port: number }).port;

    try {
      await expect(
        loadSpec({ source: `http://127.0.0.1:${port}/spec.yaml` }),
      ).rejects.toThrow(/Plain HTTP is disabled/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("http URL to loopback with opt-in loads", async () => {
    const server = http.createServer((req, res) => {
      void req;
      res.writeHead(200, { "content-type": "application/yaml" });
      res.end(SAMPLE_SPEC);
    });

    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const port = (server.address() as { port: number }).port;

    try {
      const loaded = await loadSpec({
        source: `http://127.0.0.1:${port}/spec.yaml`,
        allowHttp: true,
      });

      expect(loaded.sourceKind).toBe("url");
      expect(loaded.resolvedSource).toBe(`http://127.0.0.1:${port}/spec.yaml`);
      expect(loaded.bytes).toBeGreaterThan(0);
      expect(loaded.content).toContain("Pet Catalog API");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("public URL resolving to 127.0.0.1 is blocked (SSRF guard)", async () => {
    await expect(
      loadSpec({
        source: "https://api.example.com/openapi.yaml",
        resolver: async () => ["127.0.0.1"],
      }),
    ).rejects.toThrow(/Security error.*loopback address.*SSRF protection/);
  });

  it("URL resolving to 169.254.169.254 is blocked (SSRF guard)", async () => {
    await expect(
      loadSpec({
        source: "https://metadata.example.com/spec.yaml",
        resolver: async () => ["169.254.169.254"],
      }),
    ).rejects.toThrow(/Security error.*metadata address.*SSRF protection/);
  });

  it("response larger than cap is aborted and error names the cap", async () => {
    const server = http.createServer((req, res) => {
      void req;
      res.writeHead(200, { "content-type": "application/yaml" });
      res.write("a".repeat(200));
      res.end();
    });

    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const port = (server.address() as { port: number }).port;

    try {
      await expect(
        loadSpec({
          source: `http://127.0.0.1:${port}/spec.yaml`,
          allowHttp: true,
          maxBytes: 100,
        }),
      ).rejects.toThrow(/limit of 100 bytes/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("redirect chain of 4 is rejected at maxRedirects", async () => {
    let redirectStep = 0;
    const server = http.createServer((req, res) => {
      redirectStep++;
      if (req.url === "/final") {
        res.writeHead(200, { "content-type": "application/yaml" });
        res.end(SAMPLE_SPEC);
      } else {
        res.writeHead(302, { location: `/hop-${redirectStep}` });
        res.end();
      }
    });

    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const port = (server.address() as { port: number }).port;

    try {
      await expect(
        loadSpec({
          source: `http://127.0.0.1:${port}/start`,
          allowHttp: true,
          maxRedirects: 3,
        }),
      ).rejects.toThrow(/Exceeded maximum redirect limit of 3/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("HTTPS to HTTP redirect is rejected", async () => {
    const httpServer = http.createServer((req, res) => {
      void req;
      res.writeHead(200, { "content-type": "application/yaml" });
      res.end(SAMPLE_SPEC);
    });
    await new Promise<void>((resolve) =>
      httpServer.listen(0, "127.0.0.1", resolve),
    );
    const httpPort = (httpServer.address() as { port: number }).port;

    const httpsServer = https.createServer(
      { key: TEST_KEY, cert: TEST_CERT },
      (req, res) => {
        void req;
        res.writeHead(302, {
          location: `http://127.0.0.1:${httpPort}/spec.yaml`,
        });
        res.end();
      },
    );
    await new Promise<void>((resolve) =>
      httpsServer.listen(0, "127.0.0.1", resolve),
    );
    const httpsPort = (httpsServer.address() as { port: number }).port;

    try {
      await expect(
        loadSpec({
          source: `https://127.0.0.1:${httpsPort}/start`,
          allowHttp: true,
          rejectUnauthorized: false,
        }),
      ).rejects.toThrow(
        /Insecure redirect: HTTPS to HTTP downgrade is not permitted/,
      );
    } finally {
      await Promise.all([
        new Promise<void>((resolve) => httpServer.close(() => resolve())),
        new Promise<void>((resolve) => httpsServer.close(() => resolve())),
      ]);
    }
  });

  it("text/html response is rejected", async () => {
    const server = http.createServer((req, res) => {
      void req;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<html><body>Not an OpenAPI spec</body></html>");
    });

    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const port = (server.address() as { port: number }).port;

    try {
      await expect(
        loadSpec({
          source: `http://127.0.0.1:${port}/spec.html`,
          allowHttp: true,
        }),
      ).rejects.toThrow(/Unsupported content type 'text\/html'/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("timeout is aborted within bounds", async () => {
    const server = http.createServer(() => {
      // Deliberately do not respond to trigger timeout
    });

    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const port = (server.address() as { port: number }).port;

    try {
      const start = Date.now();
      await expect(
        loadSpec({
          source: `http://127.0.0.1:${port}/spec.yaml`,
          allowHttp: true,
          timeoutMs: 80,
        }),
      ).rejects.toThrow(/Request timed out after 80ms/);
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(1000);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  describe("command-level URL tests (serve and export)", () => {
    let mockServer: http.Server;
    let mockUrl: string;

    beforeEach(async () => {
      mockServer = http.createServer((req, res) => {
        if (req.url === "/openapi.yaml") {
          res.writeHead(200, { "content-type": "application/yaml" });
          res.end(SAMPLE_SPEC);
        } else {
          res.writeHead(404);
          res.end("Not found");
        }
      });

      await new Promise<void>((resolve) =>
        mockServer.listen(0, "127.0.0.1", resolve),
      );
      const port = (mockServer.address() as { port: number }).port;
      mockUrl = `http://127.0.0.1:${port}`;
    });

    afterEach(async () => {
      await new Promise<void>((resolve) => mockServer.close(() => resolve()));
    });

    it("serveCommand accepts a URL spec", async () => {
      const stdin = new PassThrough();
      const stdout = new PassThrough();

      const serverHandle = await serveCommand({
        spec: `${mockUrl}/openapi.yaml`,
        allowHttp: true,
        cwd: tempDir,
        stdin,
        stdout,
      });

      expect(serverHandle.ok).toBe(true);
      expect(serverHandle.serverName).toBe("chainmcp-server");
      expect(serverHandle.toolCount).toBeGreaterThan(0);

      await serverHandle.close();
      await serverHandle.closed;
    });

    it("exportCommand accepts a URL spec and outputs a standalone project", async () => {
      const exportDir = join(tempDir, "exported-from-url");

      const exportResult = await exportCommand({
        spec: `${mockUrl}/openapi.yaml`,
        output: exportDir,
        allowHttp: true,
        check: true,
        cwd: tempDir,
      });

      expect(exportResult.ok).toBe(true);
      expect(exportResult.filesWritten).toContain("spec/openapi.yaml");
      expect(exportResult.filesWritten).toContain("chainmcp.manifest.json");

      const savedSpec = await readFile(
        join(exportDir, "spec", "openapi.yaml"),
        "utf8",
      );
      expect(savedSpec).toContain("Pet Catalog API");
    });
  });
});

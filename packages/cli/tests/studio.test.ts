import { request as httpRequest } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../src/cli.js";
import {
  studioCommand,
  type StudioCommandResult,
} from "../src/commands/studio.js";

const activeStudios: StudioCommandResult[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  for (const studio of activeStudios.splice(0)) {
    if (studio.close) {
      await studio.close();
    }
  }
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("M13-1: chainmcp studio command", () => {
  it("launches Web Studio on loopback with in-memory storage fallback", async () => {
    const result = await studioCommand({
      port: 0,
      host: "127.0.0.1",
    });
    activeStudios.push(result);

    expect(result.ok).toBe(true);
    expect(result.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(result.storageDriver).toBe("memory");
    expect(result.token).toBeDefined();
    expect(result.token!.length).toBeGreaterThanOrEqual(16);

    // 1. Verify HTML console
    const pageRes = await fetch(`${result.url}/`);
    expect(pageRes.status).toBe(200);
    const html = await pageRes.text();
    expect(html).toContain("ChainMcp Web Studio");
    expect(html).toContain("Declarative tool admin");

    // 2. Verify /api/v1/status endpoint for UI initialization
    const statusRes = await fetch(`${result.url}/api/v1/status`);
    expect(statusRes.status).toBe(200);
    const statusJson = await statusRes.json();
    expect(statusJson).toMatchObject({
      status: "ok",
      service: "chainmcp-studio",
      storage: {
        connected: true,
        driver: "memory",
      },
    });

    // 3. Verify /api/v1/telemetry endpoint with generated bearer token
    const telemRes = await fetch(`${result.url}/api/v1/telemetry`, {
      headers: { authorization: `Bearer ${result.token}` },
    });
    expect(telemRes.status).toBe(200);
    const telemJson = await telemRes.json();
    expect(telemJson).toEqual({ events: [] });
  });

  it("launches Web Studio with SQLite WAL storage configuration", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chainmcp-studio-sqlite-"));
    tempDirs.push(dir);
    const sqlitePath = join(dir, "studio-storage.db");

    const configContent = `
version: 1
name: studio-sqlite-test
security:
  allowedUpstreamHosts:
    - api.example.com
storage:
  enabled: true
  driver: sqlite
  path: ${sqlitePath}
`;
    const configPath = join(dir, "chainmcp.config.yaml");
    await writeFile(configPath, configContent, "utf8");

    const result = await studioCommand({
      config: configPath,
      port: 0,
      host: "127.0.0.1",
    });
    activeStudios.push(result);

    expect(result.ok).toBe(true);
    expect(result.storageDriver).toBe("sqlite");
    expect(result.storagePath).toBe(sqlitePath);

    const statusRes = await fetch(`${result.url}/api/v1/status`);
    expect(statusRes.status).toBe(200);
    const statusJson = await statusRes.json();
    expect(statusJson.storage).toMatchObject({
      connected: true,
      driver: "sqlite",
    });
  });

  it("rejects token shorter than 16 characters", async () => {
    const result = await studioCommand({
      token: "short",
      port: 0,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("at least 16 characters");
  });

  it("refuses to bind to non-loopback host without allowRemote: true", async () => {
    const result = await studioCommand({
      host: "0.0.0.0",
      port: 0,
      allowRemote: false,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Refusing to bind");
  });

  it("enforces DNS rebinding Host header defense", async () => {
    const result = await studioCommand({
      port: 0,
      host: "127.0.0.1",
    });
    activeStudios.push(result);

    const url = new URL(result.url!);
    const statusCode = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: url.hostname,
          port: url.port,
          path: "/",
          method: "GET",
          headers: { host: "attacker.example.com" },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end();
    });

    expect(statusCode).toBe(403);
  });

  it("enforces cross-origin and cross-site request protection", async () => {
    const result = await studioCommand({
      port: 0,
      host: "127.0.0.1",
    });
    activeStudios.push(result);

    // Foreign origin rejection
    const crossOriginRes = await fetch(`${result.url}/api/v1/status`, {
      headers: {
        origin: "http://malicious-website.com",
      },
    });
    expect(crossOriginRes.status).toBe(403);
    const crossOriginJson = await crossOriginRes.json();
    expect(crossOriginJson.error.code).toBe("ADMIN_ORIGIN_FORBIDDEN");

    // Cross-site Sec-Fetch-Site rejection
    const crossSiteRes = await fetch(`${result.url}/api/v1/status`, {
      headers: {
        "sec-fetch-site": "cross-site",
      },
    });
    expect(crossSiteRes.status).toBe(403);
    const crossSiteJson = await crossSiteRes.json();
    expect(crossSiteJson.error.code).toBe("ADMIN_ORIGIN_FORBIDDEN");
  });

  it("CLI prints studio help and executes with --json", async () => {
    const logs: string[] = [];
    const io = {
      stdout: (msg: string) => logs.push(msg),
      stderr: (msg: string) => logs.push(msg),
    };

    // 1. Help text contains studio
    const helpCode = await runCli(["--help"], io);
    expect(helpCode).toBe(0);
    expect(logs.join("\n")).toContain("studio");

    logs.length = 0;

    // 2. Run studio with --json
    const studioExitCodePromise = runCli(
      ["studio", "--port", "0", "--json"],
      io,
    );

    // Wait a brief tick for the JSON log to be emitted
    await new Promise((r) => setTimeout(r, 200));

    const jsonOutput = logs.find((l) => l.includes('"ok": true'));
    expect(jsonOutput).toBeDefined();
    const parsed = JSON.parse(jsonOutput!);
    expect(parsed.ok).toBe(true);
    expect(parsed.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(parsed.storageDriver).toBe("memory");

    const exitCode = await studioExitCodePromise;
    expect(exitCode).toBe(0);
  });
});

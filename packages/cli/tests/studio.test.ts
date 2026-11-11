import { request as httpRequest } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import { runCli } from "../src/cli.js";
import {
  studioCommand,
  syncConfigToolCuration,
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
    expect(telemJson).toMatchObject({ events: [] });
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

describe("M13-2: Visual tool curation and bidirectional configuration sync", () => {
  it("syncs tool curation updates atomically to chainmcp.config.yaml", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chainmcp-studio-sync-"));
    tempDirs.push(dir);
    const configPath = join(dir, "chainmcp.config.yaml");

    const initialYaml = `
version: 1
name: petstore
contract:
  source: ./openapi.yaml
`;
    await writeFile(configPath, initialYaml, "utf8");

    // 1. Disable "delete_pet"
    await syncConfigToolCuration(configPath, {
      tenantId: "default",
      contractName: "petstore",
      toolName: "delete_pet",
      enabled: false,
    });

    let content = await readFile(configPath, "utf8");
    let parsed = parseYaml(content);
    expect(parsed.contract?.tools?.exclude).toEqual(["delete_pet"]);

    // 2. Disable another tool "add_pet"
    await syncConfigToolCuration(configPath, {
      tenantId: "default",
      contractName: "petstore",
      toolName: "add_pet",
      enabled: false,
    });

    content = await readFile(configPath, "utf8");
    parsed = parseYaml(content);
    expect(parsed.contract?.tools?.exclude).toEqual(["delete_pet", "add_pet"]);

    // 3. Re-enable "delete_pet"
    await syncConfigToolCuration(configPath, {
      tenantId: "default",
      contractName: "petstore",
      toolName: "delete_pet",
      enabled: true,
    });

    content = await readFile(configPath, "utf8");
    parsed = parseYaml(content);
    expect(parsed.contract?.tools?.exclude).toEqual(["add_pet"]);

    // 4. Re-enable "add_pet" (exclude becomes empty, deleted cleanly)
    await syncConfigToolCuration(configPath, {
      tenantId: "default",
      contractName: "petstore",
      toolName: "add_pet",
      enabled: true,
    });

    content = await readFile(configPath, "utf8");
    parsed = parseYaml(content);
    expect(parsed.contract?.tools).toBeUndefined();
  });

  it("syncs tool curation updates to gateway.config.yaml multi-contract configurations", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chainmcp-studio-gw-sync-"));
    tempDirs.push(dir);
    const configPath = join(dir, "gateway.config.yaml");

    const initialYaml = `
version: 1
contracts:
  users:
    tenantId: default
    destination:
      baseUrl: https://users.example.com
      allowedHosts:
        - users.example.com
  orders:
    tenantId: default
    destination:
      baseUrl: https://orders.example.com
      allowedHosts:
        - orders.example.com
`;
    await writeFile(configPath, initialYaml, "utf8");

    // Prune an endpoint in orders
    await syncConfigToolCuration(configPath, {
      tenantId: "default",
      contractName: "orders",
      toolName: "cancel_order",
      enabled: false,
    });

    const content = await readFile(configPath, "utf8");
    const parsed = parseYaml(content);
    expect(parsed.contracts.orders.tools.exclude).toEqual(["cancel_order"]);
    expect(parsed.contracts.users.tools).toBeUndefined();
  });

  it("serves Web Studio with visual curation UI and syncs curation changes to config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chainmcp-studio-live-curate-"));
    tempDirs.push(dir);
    const configPath = join(dir, "gateway.config.yaml");
    const specPath = join(dir, "spec.json");
    await writeFile(
      specPath,
      JSON.stringify({
        openapi: "3.0.0",
        info: { title: "Test", version: "1.0.0" },
        paths: {},
      }),
      "utf8",
    );

    const initialYaml = `
version: 1
name: chainmcp-gateway
contracts:
  - name: test_contract
    tenantId: default
    spec: ${specPath}
    destination:
      baseUrl: https://api.example.com
      allowedHosts:
        - api.example.com
`;
    await writeFile(configPath, initialYaml, "utf8");

    const result = await studioCommand({
      config: configPath,
      port: 0,
      host: "127.0.0.1",
    });
    if (!result.ok) {
      throw new Error(`studioCommand failed: ${result.error}`);
    }
    activeStudios.push(result);
    expect(result.ok).toBe(true);

    // 1. Verify HTML console includes Tools & Curation section
    const pageRes = await fetch(`${result.url}/`);
    expect(pageRes.status).toBe(200);
    const html = await pageRes.text();
    expect(html).toContain("Tools &amp; Curation");
    expect(html).toContain("Refresh tools");

    // 2. Publish descriptors for test_contract
    const desc1 = {
      descriptorVersion: 1,
      name: "query_items",
      description: "Query available items",
      request: { method: "GET", path: "/items" },
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    };
    const desc2 = {
      descriptorVersion: 1,
      name: "delete_item",
      description: "Delete an item",
      request: { method: "DELETE", path: "/items" },
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    };

    const pubRes = await fetch(
      `${result.url}/api/v1/tenants/default/contracts/test_contract/publish`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${result.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ descriptors: [desc1, desc2] }),
      },
    );
    expect(pubRes.status).toBe(201);

    // 3. GET tools list
    const toolsRes = await fetch(
      `${result.url}/api/v1/tenants/default/contracts/test_contract/tools`,
      {
        headers: { authorization: `Bearer ${result.token}` },
      },
    );
    expect(toolsRes.status).toBe(200);
    const toolsJson = await toolsRes.json();
    expect(toolsJson.tools).toHaveLength(2);
    expect(toolsJson.tools.map((t: { name: string }) => t.name).sort()).toEqual(
      ["delete_item", "query_items"],
    );

    // 4. PATCH disable tool "delete_item"
    const patchRes = await fetch(
      `${result.url}/api/v1/tenants/default/contracts/test_contract/tools/delete_item`,
      {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${result.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ enabled: false }),
      },
    );
    expect(patchRes.status).toBe(200);
    const patchJson = await patchRes.json();
    expect(patchJson.ok).toBe(true);
    expect(patchJson.toolName).toBe("delete_item");
    expect(patchJson.enabled).toBe(false);

    // 5. Verify config file was updated on disk
    const updatedYaml = await readFile(configPath, "utf8");
    const parsedConfig = parseYaml(updatedYaml);
    const updatedContract = parsedConfig.contracts.find(
      (c: { name: string }) => c.name === "test_contract",
    );
    expect(updatedContract.tools.exclude).toEqual(["delete_item"]);
  });

  it("M13-3: serves Interactive Projection Playground UI and supports test-firing", async () => {
    const result = await studioCommand({
      port: 0,
      host: "127.0.0.1",
    });
    activeStudios.push(result);

    // 1. Verify HTML console includes playground sections
    const pageRes = await fetch(`${result.url}/`);
    expect(pageRes.status).toBe(200);
    const html = await pageRes.text();
    expect(html).toContain('id="playground-section"');
    expect(html).toContain("Projection Playground");
    expect(html).toContain('id="pg-test-fire"');
    expect(html).toContain("playground-diff-grid");
    expect(html).toContain('id="m-savings-pct"');
  });

  it("M13-4: serves Live Shield & OTel Observability Dashboard and metrics endpoint", async () => {
    const result = await studioCommand({
      port: 0,
      host: "127.0.0.1",
    });
    activeStudios.push(result);

    // 1. Verify HTML console includes observability dashboard
    const pageRes = await fetch(`${result.url}/`);
    expect(pageRes.status).toBe(200);
    const html = await pageRes.text();
    expect(html).toContain('id="observability-section"');
    expect(html).toContain("Shield &amp; OTel Observability");
    expect(html).toContain('id="obs-auto-refresh"');
    expect(html).toContain('id="obs-metrics-cards"');
    expect(html).toContain('id="obs-telemetry-table"');

    // 2. Query /api/v1/telemetry/metrics
    const metricsRes = await fetch(`${result.url}/api/v1/telemetry/metrics`, {
      headers: { authorization: `Bearer ${result.token}` },
    });
    expect(metricsRes.status).toBe(200);
    const metricsJson = await metricsRes.json();
    expect(metricsJson.ok).toBe(true);
    expect(metricsJson.summary).toBeDefined();
    expect(metricsJson.summary.totalRequests).toBe(0);
    expect(metricsJson.timeSeries).toHaveLength(12);

    // 3. Query /api/v1/telemetry
    const telemRes = await fetch(`${result.url}/api/v1/telemetry`, {
      headers: { authorization: `Bearer ${result.token}` },
    });
    expect(telemRes.status).toBe(200);
    const telemJson = await telemRes.json();
    expect(telemJson.ok).toBe(true);
    expect(telemJson.events).toEqual([]);
  });
});

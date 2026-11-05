import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@chainmcp/admin", () => ({
  startDeclarativeAdminServer: vi
    .fn()
    .mockImplementation(async (opts: { host?: string; port?: number }) => {
      if (opts.host === "throw-error.test") {
        throw new Error("Bind failed on host");
      }
      return {
        url: `http://${opts.host ?? "127.0.0.1"}:${opts.port ?? 8787}`,
        close: vi.fn(),
      };
    }),
}));

import { adminCommand } from "../src/commands/admin.js";
import { doctorCommand } from "../src/commands/doctor.js";
import { renderConfigYaml } from "../src/templates.js";

describe("CLI Admin & Doctor Commands", () => {
  let tempDir: string;
  const originalEnvToken = process.env.CHAINMCP_ADMIN_TOKEN;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "chainmcp-cli-admin-doctor-"));
    delete process.env.CHAINMCP_ADMIN_TOKEN;
  });

  afterEach(async () => {
    if (originalEnvToken !== undefined) {
      process.env.CHAINMCP_ADMIN_TOKEN = originalEnvToken;
    } else {
      delete process.env.CHAINMCP_ADMIN_TOKEN;
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("adminCommand", () => {
    it("fails when token is not supplied via options or environment", async () => {
      const res = await adminCommand({});
      expect(res.ok).toBe(false);
      expect(res.error).toBe("CHAINMCP_ADMIN_TOKEN is required");
    });

    it("uses token from environment variable CHAINMCP_ADMIN_TOKEN", async () => {
      process.env.CHAINMCP_ADMIN_TOKEN = "env-secret-token";
      const res = await adminCommand({ port: 9000 });
      expect(res.ok).toBe(true);
      expect(res.url).toContain("9000");
    });

    it("uses explicit token option over environment variable", async () => {
      process.env.CHAINMCP_ADMIN_TOKEN = "env-token";
      const res = await adminCommand({
        token: "explicit-token",
        host: "127.0.0.1",
        port: 9001,
      });
      expect(res.ok).toBe(true);
      expect(res.url).toBe("http://127.0.0.1:9001");
    });

    it("catches and returns errors from startDeclarativeAdminServer", async () => {
      const res = await adminCommand({
        token: "token",
        host: "throw-error.test",
      });
      expect(res.ok).toBe(false);
      expect(res.error).toBe("Bind failed on host");
    });
  });

  describe("doctorCommand", () => {
    it("reports failure when no configuration file is found in directory", async () => {
      const res = await doctorCommand({ cwd: tempDir });
      expect(res.ok).toBe(false);
      expect(res.error).toBe("configuration file not found");
      expect(res.checks).toEqual([
        { name: "config", ok: false, detail: "not found" },
      ]);
    });

    it("reports failure when explicit config path does not exist", async () => {
      const missingPath = join(tempDir, "nonexistent-config.json");
      const res = await doctorCommand({ config: missingPath, cwd: tempDir });
      expect(res.ok).toBe(false);
      expect(res.error).toContain("configuration file not found");
      expect(res.checks[0]).toMatchObject({
        name: "config",
        ok: false,
        detail: "missing file",
      });
    });

    it("reports success with auth details when valid configuration is loaded", async () => {
      const configPath = join(tempDir, "chainmcp.config.yaml");
      const yaml = renderConfigYaml({
        name: "test-server",
        allowedHosts: [],
        blank: true,
      });
      await writeFile(configPath, yaml, "utf8");

      const res = await doctorCommand({ cwd: tempDir });
      expect(res.ok).toBe(true);
      expect(res.checks).toEqual([
        { name: "config", ok: true, detail: configPath },
        { name: "auth", ok: true, detail: "optional" },
      ]);
    });

    it("reports auth: required when requireInboundAuth is true", async () => {
      const configPath = join(tempDir, "chainmcp.config.yaml");
      const yaml = renderConfigYaml({
        name: "test-server",
        allowedHosts: [],
        blank: true,
      }).replace("requireInboundAuth: false", "requireInboundAuth: true");
      await writeFile(configPath, yaml, "utf8");

      const res = await doctorCommand({ config: configPath });
      expect(res.ok).toBe(true);
      expect(res.checks).toEqual([
        { name: "config", ok: true, detail: configPath },
        { name: "auth", ok: true, detail: "required" },
      ]);
    });

    it("catches syntax errors in invalid JSON config files", async () => {
      const configPath = join(tempDir, "chainmcp.config.json");
      await writeFile(configPath, "{ invalid json ...", "utf8");

      const res = await doctorCommand({ config: configPath });
      expect(res.ok).toBe(false);
      expect(res.checks[0]?.ok).toBe(false);
      expect(res.error).toBeDefined();
    });
  });
});

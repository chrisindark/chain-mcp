import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { diffCommand } from "../src/commands/diff.js";
import { isUrlSource, loadSpec } from "../src/spec-loader.js";

const VALID_SPEC_A = JSON.stringify({
  openapi: "3.1.0",
  info: { title: "API A", version: "1.0.0" },
  paths: {
    "/users": {
      get: {
        operationId: "getUsers",
        responses: { "200": { description: "ok" } },
      },
    },
  },
});

const VALID_SPEC_B = JSON.stringify({
  openapi: "3.1.0",
  info: { title: "API B", version: "1.0.0" },
  paths: {
    "/users": {
      get: {
        operationId: "getUsers",
        responses: { "200": { description: "ok" } },
      },
    },
    "/posts": {
      get: {
        operationId: "getPosts",
        responses: { "200": { description: "ok" } },
      },
    },
  },
});

describe("CLI Spec Loader & Diff Additional Tests", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "chainmcp-cli-spec-diff-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("isUrlSource", () => {
    it("identifies http and https URLs", () => {
      expect(isUrlSource("http://example.com/spec.yaml")).toBe(true);
      expect(isUrlSource("https://example.com/spec.yaml")).toBe(true);
    });

    it("rejects non-http/https URL schemes with descriptive error", () => {
      expect(() => isUrlSource("ftp://example.com/spec.yaml")).toThrow(
        "Unsupported URL scheme 'ftp:'. Only HTTP and HTTPS are supported",
      );
      expect(() => isUrlSource("file:///path/to/spec.yaml")).toThrow(
        "Unsupported URL scheme 'file:'. Only HTTP and HTTPS are supported",
      );
    });

    it("returns false for local file paths", () => {
      expect(isUrlSource("relative/spec.yaml")).toBe(false);
      expect(isUrlSource("/absolute/path/spec.json")).toBe(false);
      expect(isUrlSource("./spec.yaml")).toBe(false);
    });
  });

  describe("loadSpec for local files", () => {
    it("throws descriptive error when file is missing", async () => {
      await expect(
        loadSpec({ source: join(tempDir, "nonexistent.yaml") }),
      ).rejects.toThrow("OpenAPI specification file was not found");
    });

    it("throws when file size exceeds maxBytes limit", async () => {
      const specPath = join(tempDir, "large.yaml");
      await writeFile(
        specPath,
        "openapi: 3.1.0\ninfo:\n  title: Large\n  version: 1.0.0\npaths: {}",
      );

      await expect(
        loadSpec({ source: specPath, maxBytes: 10 }),
      ).rejects.toThrow("Spec size exceeds limit of 10 bytes");
    });

    it("loads local file specification successfully", async () => {
      const specPath = join(tempDir, "spec.json");
      await writeFile(specPath, VALID_SPEC_A, "utf8");

      const loaded = await loadSpec({ source: specPath });
      expect(loaded.sourceKind).toBe("file");
      expect(loaded.resolvedSource).toBe(specPath);
      expect(loaded.bytes).toBe(Buffer.byteLength(VALID_SPEC_A, "utf8"));
      expect(loaded.content).toBe(VALID_SPEC_A);
    });
  });

  describe("diffCommand edge cases", () => {
    it("reports error when target comparison file does not exist", async () => {
      const currentSpec = join(tempDir, "current.json");
      await writeFile(currentSpec, VALID_SPEC_A, "utf8");

      const result = await diffCommand({
        spec: currentSpec,
        against: join(tempDir, "nonexistent-baseline.json"),
        cwd: tempDir,
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("Failed to load comparison target");
    });

    it("reports error when target comparison spec fails compilation", async () => {
      const currentSpec = join(tempDir, "current.json");
      const badBaseline = join(tempDir, "bad-baseline.yaml");
      await writeFile(currentSpec, VALID_SPEC_A, "utf8");
      await writeFile(badBaseline, "not a valid openapi specification", "utf8");

      const result = await diffCommand({
        spec: currentSpec,
        against: badBaseline,
        cwd: tempDir,
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain(
        "Target comparison contract failed to compile",
      );
    });

    it("returns all current tools as added when no baseline is found", async () => {
      const currentSpec = join(tempDir, "current.json");
      await writeFile(currentSpec, VALID_SPEC_A, "utf8");

      const result = await diffCommand({
        spec: currentSpec,
        cwd: tempDir,
      });

      expect(result.ok).toBe(true);
      expect(result.hasChanges).toBe(false);
      expect(result.addedTools).toEqual(["getUsers"]);
      expect(result.removedTools).toHaveLength(0);
    });

    it("diffs against another OpenAPI specification successfully", async () => {
      const baselineSpec = join(tempDir, "baseline.json");
      const currentSpec = join(tempDir, "current.json");
      await writeFile(baselineSpec, VALID_SPEC_A, "utf8");
      await writeFile(currentSpec, VALID_SPEC_B, "utf8");

      const result = await diffCommand({
        spec: currentSpec,
        against: baselineSpec,
        cwd: tempDir,
      });

      expect(result.ok).toBe(true);
      expect(result.hasChanges).toBe(true);
      expect(result.addedTools).toEqual(["getPosts"]);
      expect(result.unchangedTools).toEqual(["getUsers"]);
      expect(result.removedTools).toHaveLength(0);
    });

    it("diffs against a raw JSON tools array target", async () => {
      const currentSpec = join(tempDir, "current.json");
      const toolsBaseline = join(tempDir, "tools.json");
      await writeFile(currentSpec, VALID_SPEC_B, "utf8");
      await writeFile(
        toolsBaseline,
        JSON.stringify([{ name: "getUsers" }, { name: "oldTool" }]),
        "utf8",
      );

      const result = await diffCommand({
        spec: currentSpec,
        against: toolsBaseline,
        cwd: tempDir,
      });

      expect(result.ok).toBe(true);
      expect(result.hasChanges).toBe(true);
      expect(result.addedTools).toContain("getPosts");
      expect(result.removedTools).toContain("oldTool");
      expect(result.changedTools).toContain("getUsers");
    });
  });
});

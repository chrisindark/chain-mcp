#!/usr/bin/env node
// Tests for scripts/check-schema-snapshots.mjs. Run with: node --test scripts/
//
// Asserts that the MCP tool declaration snapshot gate detects drift,
// passes when synchronized, and handles --update, --json, and custom paths.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SCRIPT = join(__dirname, "check-schema-snapshots.mjs");
const REPO_SNAPSHOT = join(
  ROOT,
  "snapshots/mcp-tool-declarations.snapshot.json",
);

function run(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: "utf8",
  });
}

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "chainmcp-snapshot-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("repo snapshot file exists and passes verification", () => {
  assert.ok(existsSync(REPO_SNAPSHOT), "Repo snapshot file must exist");
  const result = run(["--check"]);
  assert.equal(
    result.status,
    0,
    `Snapshot check should pass: ${result.stderr}`,
  );
  assert.match(result.stdout, /All MCP tool declarations.*match snapshot/);
});

test("repo snapshot check supports --json flag", () => {
  const result = run(["--json"]);
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.status, "ok");
  assert.equal(typeof parsed.toolCount, "number");
  assert.ok(parsed.toolCount >= 10);
});

test("detects schema drift when snapshot contains modified tool schema", () => {
  withTempDir((tempDir) => {
    const tempSnapshot = join(tempDir, "test.snapshot.json");
    // Copy real snapshot
    const original = JSON.parse(readFileSync(REPO_SNAPSHOT, "utf8"));

    // Introduce artificial schema drift
    const modified = JSON.parse(JSON.stringify(original));
    modified.tools.json_navigation[0].description = "Tampered description";

    writeFileSync(tempSnapshot, JSON.stringify(modified, null, 2), "utf8");

    const result = run(["--snapshot", tempSnapshot]);
    assert.equal(result.status, 1, "Should fail when schema drifts");
    assert.match(
      result.stderr,
      /MCP tool declarations or schemas have drifted/,
    );
    assert.match(result.stderr, /Tampered description/);
  });
});

test("detects schema drift with --json output", () => {
  withTempDir((tempDir) => {
    const tempSnapshot = join(tempDir, "test.snapshot.json");
    const original = JSON.parse(readFileSync(REPO_SNAPSHOT, "utf8"));
    const modified = JSON.parse(JSON.stringify(original));
    modified.admin_routes.push("DELETE /api/v1/unexpected");

    writeFileSync(tempSnapshot, JSON.stringify(modified, null, 2), "utf8");

    const result = run(["--snapshot", tempSnapshot, "--json"]);
    assert.equal(result.status, 1);
    const parsed = JSON.parse(result.stderr);
    assert.equal(parsed.status, "drift");
    assert.ok(parsed.diffCount > 0);
    assert.ok(parsed.diffs.some((d) => d.path === "admin_routes"));
  });
});

test("fails when snapshot file does not exist", () => {
  withTempDir((tempDir) => {
    const missing = join(tempDir, "missing.json");
    const result = run(["--snapshot", missing]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Snapshot file missing/);
  });
});

test("fails when snapshot file contains invalid JSON", () => {
  withTempDir((tempDir) => {
    const corrupted = join(tempDir, "corrupted.json");
    writeFileSync(corrupted, "{ not valid json ", "utf8");
    const result = run(["--snapshot", corrupted]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /corrupted JSON/);
  });
});

test("--update creates a new valid snapshot file", () => {
  withTempDir((tempDir) => {
    const tempSnapshot = join(tempDir, "new.snapshot.json");
    const updateResult = run(["--snapshot", tempSnapshot, "--update"]);
    assert.equal(updateResult.status, 0);
    assert.ok(existsSync(tempSnapshot));

    // And then check passes on that newly updated snapshot
    const checkResult = run(["--snapshot", tempSnapshot]);
    assert.equal(checkResult.status, 0);
  });
});

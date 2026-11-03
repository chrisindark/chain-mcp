#!/usr/bin/env node
// Tests for scripts/generate-sbom.mjs. Run with: node --test scripts/
//
// Asserts that the generated CycloneDX SBOM covers every workspace package,
// that output is deterministic apart from the serial number and timestamp,
// and that `--check` validates workspace metadata.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SCRIPT = join(__dirname, "generate-sbom.mjs");

function run(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: "utf8",
  });
}

function generate(outPath) {
  const result = run(["--out", outPath]);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(readFileSync(outPath, "utf8"));
}

function workspacePackageNames() {
  const packagesDir = join(ROOT, "packages");
  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join("packages", entry.name, "package.json"))
    .filter((relPath) => existsSync(join(ROOT, relPath)))
    .map(
      (relPath) => JSON.parse(readFileSync(join(ROOT, relPath), "utf8")).name,
    );
}

function withTempDir(run_) {
  const directory = mkdtempSync(join(tmpdir(), "chainmcp-sbom-test-"));
  try {
    return run_(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("SBOM covers every workspace package with license and purl", () => {
  withTempDir((directory) => {
    const sbom = generate(join(directory, "sbom.json"));

    assert.equal(sbom.bomFormat, "CycloneDX");
    assert.equal(sbom.specVersion, "1.5");
    assert.ok(Array.isArray(sbom.components));
    assert.ok(sbom.components.length > 0);

    const workspaceNames = workspacePackageNames();
    const byName = new Map(
      sbom.components.map((component) => [component.name, component]),
    );
    for (const name of workspaceNames) {
      const component = byName.get(name);
      assert.ok(component, `SBOM is missing workspace package ${name}`);
      assert.equal(component.licenses?.[0]?.license?.id, "Apache-2.0");
      assert.ok(
        component.purl.startsWith("pkg:npm/"),
        `component ${name} has no npm purl`,
      );
      assert.ok(component.version, `component ${name} has no version`);
    }

    assert.equal(sbom.metadata.component.name, "chainmcp");
    assert.equal(sbom.metadata.tools[0].name, "chainmcp-sbom-generator");

    // Every workspace package appears in the dependency graph. Transitive
    // components may have no outgoing edge, so only workspace refs count.
    const workspacePurls = workspaceNames.map(
      (name) =>
        `pkg:npm/${encodeURIComponent(name)}@${byName.get(name).version}`,
    );
    const referenced = new Set(sbom.dependencies.map((edge) => edge.ref));
    for (const purl of workspacePurls) {
      assert.ok(referenced.has(purl), `dependency graph misses ${purl}`);
    }
  });
});

test("SBOM output is deterministic apart from serial number and timestamp", () => {
  withTempDir((directory) => {
    const first = generate(join(directory, "first.json"));
    const second = generate(join(directory, "second.json"));

    delete first.serialNumber;
    delete second.serialNumber;
    delete first.metadata.timestamp;
    delete second.metadata.timestamp;
    assert.deepEqual(second, first);
  });
});

test("--check validates workspace package metadata", () => {
  const result = run(["--check"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /SBOM check:/);
});

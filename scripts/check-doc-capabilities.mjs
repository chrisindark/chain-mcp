#!/usr/bin/env node
// Validates that documented ChainMcp capabilities each point to a real test file
// and/or real exported API, and that the README core-capability bullets are all
// covered. Wired into `pnpm docs:check` and `pnpm check`.
//
// Source of truth: docs/capability-evidence.json

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REGISTRY_PATH = resolve(ROOT, "docs/capability-evidence.json");
const README_PATH = resolve(ROOT, "README.md");

const machine = process.argv.includes("--json");
let errors = [];

function fail(reason) {
  if (machine) {
    errors.push(reason);
  } else {
    console.error(`[docs:check] ${reason}`);
    process.exitCode = 1;
  }
}

function assert(condition, message) {
  if (!condition) {
    fail(message);
    return false;
  }
  return true;
}

function repoPath(relative) {
  return resolve(ROOT, relative);
}

function loadRegistry() {
  assert(existsSync(REGISTRY_PATH), "docs/capability-evidence.json is missing");
  let registry;
  try {
    registry = JSON.parse(readFileSync(REGISTRY_PATH, "utf8"));
  } catch (err) {
    fail(`docs/capability-evidence.json is not valid JSON: ${err.message}`);
    return [];
  }
  assert(
    Array.isArray(registry.capabilities),
    'docs/capability-evidence.json must expose a "capabilities" array',
  );
  return registry.capabilities;
}

function readmeCapabilityBullets() {
  assert(existsSync(README_PATH), "README.md is missing");
  const text = readFileSync(README_PATH, "utf8");

  const startMarker = "## Core capabilities";
  const startIndex = text.indexOf(startMarker);
  assert(
    startIndex !== -1,
    'README.md is missing the "## Core capabilities" heading',
  );

  const afterStart = text.slice(startIndex + startMarker.length);
  const endIndex = afterStart.indexOf("\n## ");
  const section = endIndex === -1 ? afterStart : afterStart.slice(0, endIndex);

  const bullets = [];
  const bulletRe = /^\s*-\s+\*\*(.+?)\*\*/gm;
  let match;
  while ((match = bulletRe.exec(section)) !== null) {
    bullets.push(match[1].trim());
  }

  assert(
    bullets.length > 0,
    'README.md "## Core capabilities" section contains no bullet list',
  );
  return bullets;
}

function sourceExportsSymbol(sourcePath, symbol) {
  if (!existsSync(sourcePath)) {
    return { ok: false, reason: `source file missing: ${sourcePath}` };
  }
  const text = readFileSync(sourcePath, "utf8");
  const escSymbol = String(symbol || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // Named export lists: export { Foo } or export { Foo, Bar } or export type { Foo }
  // or export { Foo } from "./other.js" — all share the same scan.
  const namedRe = new RegExp(
    "\\bexport\\s*(?:type\\s+)?\\{[^}]*\\b" +
      escSymbol +
      "\\b[^}]*\\}(?:\\s*from\\s+)?",
  );
  if (namedRe.test(text)) return { ok: true };

  // Declaration exports: export function/async function/class/const/interface/type.
  const declRe = new RegExp(
    "\\bexport\\s+(?:async\\s+)?(?:function|class|const|let|var|interface|type|enum)\\s+" +
      escSymbol +
      "\\b",
  );
  if (declRe.test(text)) return { ok: true };

  return {
    ok: false,
    reason: `source ${sourcePath} does not export a symbol named "${symbol}"`,
  };
}

function evidenceExists(entry) {
  const testPath = repoPath(entry.test);
  if (!existsSync(testPath)) {
    return { ok: false, reason: `test evidence file missing: ${entry.test}` };
  }

  const text = readFileSync(testPath, "utf8");
  if (!text.includes(entry.testNeedle)) {
    return {
      ok: false,
      reason: `${entry.test} does not contain the evidence phrase "${entry.testNeedle}"`,
    };
  }
  return { ok: true };
}

function validateEntry(entry, readmeBullets) {
  const local = [];

  if (typeof entry.id !== "string" || entry.id.length === 0) {
    local.push('capability (unsigned): missing or empty "id"');
  }
  if (typeof entry.doc !== "string" || entry.doc.length === 0) {
    local.push(
      `capability "${entry.id ?? "(unsigned)"}": missing or empty "doc"`,
    );
  }
  const requiresCodeEvidence = !entry.docOnly;
  if (typeof entry.source !== "string" || entry.source.length === 0) {
    if (requiresCodeEvidence && (entry.export || entry.test)) {
      local.push(
        `capability "${entry.id ?? "(unsigned)"}": missing or empty "source"`,
      );
    }
  }
  if (typeof entry.export !== "string" || entry.export.length === 0) {
    if (requiresCodeEvidence && (entry.source || entry.test)) {
      local.push(
        `capability "${entry.id ?? "(unsigned)"}": missing or empty "export"`,
      );
    }
  }
  if (typeof entry.test !== "string" || entry.test.length === 0) {
    local.push(
      `capability "${entry.id ?? "(unsigned)"}": missing or empty "test"`,
    );
  }
  if (typeof entry.testNeedle !== "string" || entry.testNeedle.length === 0) {
    local.push(
      `capability "${entry.id ?? "(unsigned)"}": missing or empty "testNeedle"`,
    );
  }

  if (entry.doc && entry.claim) {
    const docPath = repoPath(entry.doc);
    if (!existsSync(docPath)) {
      local.push(`capability "${entry.id}": doc file missing: ${entry.doc}`);
    } else {
      const docText = readFileSync(docPath, "utf8");
      if (!docText.includes(entry.claim)) {
        local.push(
          `capability "${entry.id}" (${entry.doc}): claim phrase not found:\n    "${entry.claim}"`,
        );
      }
    }
  }

  if (entry.source && requiresCodeEvidence) {
    const srcPath = repoPath(entry.source);
    const result = sourceExportsSymbol(srcPath, entry.export);
    if (!result.ok) local.push(`capability "${entry.id}": ${result.reason}`);
  }

  {
    const result = evidenceExists(entry);
    if (!result.ok) local.push(`capability "${entry.id}": ${result.reason}`);
  }

  if (entry.readmeCapability) {
    if (!readmeBullets.includes(entry.readmeCapability)) {
      local.push(
        `capability "${entry.id}": readmeCapability "${entry.readmeCapability}" is not a bolded bullet in README.md "Core capabilities"`,
      );
    }
  }

  return local;
}

const monitor = () => {
  if (!machine) {
    console.error("[docs:check] reading registry and README...");
  }

  const capabilities = loadRegistry();
  const readmeBullets = readmeCapabilityBullets();

  for (const bullet of readmeBullets) {
    const match = capabilities.find((c) => c.readmeCapability === bullet);
    if (!match) {
      errors.push(
        `README "Core capabilities" bullet not covered by a registry entry:\n    "${bullet}"`,
      );
    }
  }

  const registeredBullets = new Set(
    capabilities
      .map((c) => c.readmeCapability)
      .filter((s) => typeof s === "string" && s.length > 0),
  );
  for (const bullet of registeredBullets) {
    if (!readmeBullets.includes(bullet)) {
      errors.push(
        `registry entry references a README capability not present in "Core capabilities":\n    "${bullet}"`,
      );
    }
  }

  for (const entry of capabilities) {
    errors.push(...validateEntry(entry, readmeBullets));
  }

  const seen = new Set();
  for (const entry of capabilities) {
    if (seen.has(entry.id)) {
      errors.push(`duplicate capability id "${entry.id}"`);
    }
    seen.add(entry.id);
  }

  const readmeMap = new Map();
  for (const entry of capabilities) {
    if (entry.readmeCapability) {
      if (readmeMap.has(entry.readmeCapability)) {
        errors.push(
          `duplicate readmeCapability "${entry.readmeCapability}" on entries "${readmeMap.get(entry.readmeCapability)}" and "${entry.id}"`,
        );
      } else {
        readmeMap.set(entry.readmeCapability, entry.id);
      }
    }
  }

  if (machine) {
    const status = errors.length === 0 ? "ok" : "fail";
    console.log(
      JSON.stringify({ status, errorCount: errors.length, errors }, null, 2),
    );
    process.exit(errors.length === 0 ? 0 : 1);
  }

  if (errors.length === 0) {
    console.log(
      `[docs:check] ${capabilities.length} documented capabilities checked; all point to real tests or exported APIs; README "Core capabilities" fully covered.`,
    );
  } else {
    console.error(
      `[docs:check] ${errors.length} documented capability drift(s) found:`,
    );
    for (const err of errors) {
      console.error(`  - ${err}`);
    }
  }
};

monitor();

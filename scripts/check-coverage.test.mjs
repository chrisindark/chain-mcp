import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { COVERAGE_THRESHOLDS } from "./coverage-thresholds.mjs";
import {
  evaluateCoverage,
  packageCoverage,
  renderSummaryReport,
  runCoverageGate,
  thresholdShortfalls,
} from "./check-coverage.mjs";

function entry(lines, statements, functions, branches) {
  const stat = (pct) => ({ covered: pct, total: 100, skipped: 0, pct });
  return {
    lines: stat(lines),
    statements: stat(statements),
    functions: stat(functions),
    branches: stat(branches),
  };
}

/** Build a coverage-summary object where every known package reads as pct%. */
function summaryAt(pct) {
  const summary = { total: entry(pct, pct, pct, pct) };
  for (const pkg of Object.keys(COVERAGE_THRESHOLDS.packages)) {
    summary[join(process.cwd(), "packages", pkg, "src", "index.ts")] = entry(
      pct,
      pct,
      pct,
      pct,
    );
  }
  return summary;
}

test("thresholdShortfalls flags metrics below the threshold", () => {
  assert.deepEqual(
    thresholdShortfalls(
      "core",
      { lines: 89.9, statements: 95, functions: 100, branches: 90 },
      { lines: 90, statements: 90, functions: 90, branches: 90 },
    ),
    ["core: lines 89.90% < 90%"],
  );
  assert.deepEqual(
    thresholdShortfalls(
      "core",
      { lines: 90, statements: 90, functions: 90, branches: 90 },
      { lines: 90, statements: 90, functions: 90, branches: 90 },
    ),
    [],
  );
});

test("thresholdShortfalls reports missing metrics instead of silently passing", () => {
  const failures = thresholdShortfalls("cli", undefined, { lines: 73 });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /cli: lines missing < 73%/);
});

test("packageCoverage aggregates only the requested package directory", () => {
  const summary = {
    total: entry(50, 50, 50, 50),
    "/repo/packages/core/src/index.ts": {
      lines: { covered: 8, total: 10, pct: 80 },
      statements: { covered: 8, total: 10, pct: 80 },
      functions: { covered: 4, total: 5, pct: 80 },
      branches: { covered: 1, total: 2, pct: 50 },
    },
    "/repo/packages/core/src/other.ts": {
      lines: { covered: 2, total: 10, pct: 20 },
      statements: { covered: 2, total: 10, pct: 20 },
      functions: { covered: 5, total: 5, pct: 100 },
      branches: { covered: 1, total: 2, pct: 50 },
    },
    "/repo/packages/cli/src/index.ts": entry(100, 100, 100, 100),
  };
  const core = packageCoverage(summary, "core");
  assert.equal(core.lines, 50);
  assert.equal(core.functions, 90);
  assert.equal(core.branches, 50);
});

test("packageCoverage returns null when a package has no covered files", () => {
  assert.equal(packageCoverage({ total: entry(80, 80, 80, 80) }, "core"), null);
});

test("evaluateCoverage passes when every package meets its floor", () => {
  const { passed, failures } = evaluateCoverage(summaryAt(100));
  assert.equal(passed, true);
  assert.deepEqual(failures, []);
});

test("evaluateCoverage fails a package below its floor (regression)", () => {
  const summary = summaryAt(100);
  summary[join(process.cwd(), "packages", "core", "src", "index.ts")] = entry(
    50,
    50,
    50,
    50,
  );
  const { passed, failures } = evaluateCoverage(summary);
  assert.equal(passed, false);
  assert.match(failures.join("\n"), /core: lines 50/);
});

test("evaluateCoverage fails a package with no covered files", () => {
  const summary = summaryAt(100);
  delete summary[join(process.cwd(), "packages", "gateway", "src", "index.ts")];
  const { passed, failures } = evaluateCoverage(summary);
  assert.equal(passed, false);
  assert.match(failures.join("\n"), /gateway: no covered files/);
});

test("renderSummaryReport includes per-scope numbers and the verdict", () => {
  const evaluated = evaluateCoverage(summaryAt(100));
  const markdown = renderSummaryReport(evaluated);
  assert.match(markdown, /## Coverage gate/);
  assert.match(markdown, /global/);
  assert.match(markdown, /core/);
  assert.match(markdown, /passed/);
  assert.doesNotMatch(markdown, /failed/);
});

test("runCoverageGate returns 1 and writes nothing when the report is missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "cov-gate-"));
  assert.equal(runCoverageGate({ cwd: dir }), 1);
  assert.equal(existsSync(join(dir, "coverage", "coverage-gate.json")), false);
});

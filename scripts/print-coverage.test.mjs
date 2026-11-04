import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { formatLineRanges, printCoverageReport } from "./print-coverage.mjs";

test("formatLineRanges formats contiguous ranges and isolated line numbers", () => {
  assert.equal(formatLineRanges([]), "none");
  assert.equal(formatLineRanges([5]), "5");
  assert.equal(formatLineRanges([1, 2, 3]), "1-3");
  assert.equal(formatLineRanges([1, 2, 3, 5, 7, 8, 9]), "1-3, 5, 7-9");
  assert.equal(formatLineRanges([9, 1, 8, 2, 3, 2]), "1-3, 8-9");
});

test("printCoverageReport returns hasReport: false when no coverage exists", () => {
  const tempDir = join(tmpdir(), `test-cov-none-${Date.now()}`);
  mkdirSync(tempDir, { recursive: true });
  try {
    const result = printCoverageReport({ cwd: tempDir, silentOnMissing: true });
    assert.equal(result.hasReport, false);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("printCoverageReport parses summary and details correctly", () => {
  const tempDir = join(tmpdir(), `test-cov-${Date.now()}`);
  const covDir = join(tempDir, "coverage");
  mkdirSync(covDir, { recursive: true });

  const mockSummary = {
    total: {
      lines: { total: 100, covered: 90, skipped: 0, pct: 90 },
      statements: { total: 100, covered: 90, skipped: 0, pct: 90 },
      functions: { total: 10, covered: 9, skipped: 0, pct: 90 },
      branches: { total: 20, covered: 18, skipped: 0, pct: 90 },
    },
    [join(tempDir, "src/test.ts")]: {
      lines: { total: 50, covered: 40, skipped: 0, pct: 80 },
      statements: { total: 50, covered: 40, skipped: 0, pct: 80 },
      functions: { total: 5, covered: 4, skipped: 0, pct: 80 },
      branches: { total: 10, covered: 8, skipped: 0, pct: 80 },
    },
  };

  const mockDetails = {
    [join(tempDir, "src/test.ts")]: {
      path: join(tempDir, "src/test.ts"),
      statementMap: {
        0: { start: { line: 10, column: 0 }, end: { line: 12, column: 5 } },
        1: { start: { line: 20, column: 0 }, end: { line: 20, column: 10 } },
      },
      s: {
        0: 0, // uncovered
        1: 5, // covered
      },
    },
  };

  writeFileSync(
    join(covDir, "coverage-summary.json"),
    JSON.stringify(mockSummary),
  );
  writeFileSync(
    join(covDir, "coverage-final.json"),
    JSON.stringify(mockDetails),
  );

  try {
    const result = printCoverageReport({ cwd: tempDir });
    assert.equal(result.hasReport, true);
    assert.equal(result.summary?.lines?.pct, 90);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

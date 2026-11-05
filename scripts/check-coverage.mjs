import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { COVERAGE_THRESHOLDS } from "./coverage-thresholds.mjs";

const METRICS = ["lines", "statements", "functions", "branches"];

/**
 * Aggregate per-file coverage entries of one package (directory name under
 * `packages/<name>/src/`), mirroring the paths Vitest's coverage-summary.json
 * records (absolute file paths).
 *
 * @param {Record<string, any>} summary Vitest coverage-summary.json contents
 * @param {string} pkg Package directory name (e.g. "core", "cache-redis")
 * @returns {{ lines: number, statements: number, functions: number, branches: number } | null}
 */
export function packageCoverage(summary, pkg) {
  const prefix = `packages/${pkg}/src/`;
  const totals = {
    lines: { covered: 0, total: 0 },
    statements: { covered: 0, total: 0 },
    functions: { covered: 0, total: 0 },
    branches: { covered: 0, total: 0 },
  };
  let seen = false;
  for (const [filePath, stats] of Object.entries(summary)) {
    if (filePath === "total") continue;
    if (!filePath.replace(/\\/g, "/").includes(prefix)) continue;
    seen = true;
    for (const metric of METRICS) {
      totals[metric].covered += stats[metric]?.covered ?? 0;
      totals[metric].total += stats[metric]?.total ?? 0;
    }
  }
  if (!seen) return null;
  const result = {};
  for (const metric of METRICS) {
    const { covered, total } = totals[metric];
    result[metric] = total === 0 ? 100 : (covered / total) * 100;
  }
  return result;
}

/**
 * Compare measured percentages against thresholds.
 *
 * @param {Record<string, any>} measured metric -> percentage
 * @param {Partial<Record<string, number>>} thresholds metric -> minimum %
 * @returns {string[]} human-readable shortfall lines (empty when passing)
 */
export function thresholdShortfalls(name, measured, thresholds) {
  const failures = [];
  for (const metric of METRICS) {
    const threshold = thresholds?.[metric];
    if (threshold === undefined) continue;
    const pct = measured?.[metric];
    if (pct === undefined || pct < threshold) {
      failures.push(
        `${name}: ${metric} ${pct === undefined ? "missing" : `${pct.toFixed(2)}%`} < ${threshold}%`,
      );
    }
  }
  return failures;
}

/**
 * Evaluate every gate against a Vitest coverage-summary.json object.
 * Pure (no filesystem access) so it can be unit-tested with fixtures.
 *
 * @param {Record<string, any>} summary Vitest coverage-summary.json contents
 * @param {typeof COVERAGE_THRESHOLDS} config
 * @returns {{ failures: string[], report: Record<string, any>, passed: boolean }}
 */
export function evaluateCoverage(summary, config = COVERAGE_THRESHOLDS) {
  const failures = [];
  failures.push(
    ...thresholdShortfalls(
      "global",
      {
        lines: summary.total?.lines?.pct,
        statements: summary.total?.statements?.pct,
        functions: summary.total?.functions?.pct,
        branches: summary.total?.branches?.pct,
      },
      config.global,
    ),
  );

  const report = { global: {}, packages: {} };
  const measuredGlobal = {
    lines: summary.total?.lines?.pct,
    statements: summary.total?.statements?.pct,
    functions: summary.total?.functions?.pct,
    branches: summary.total?.branches?.pct,
  };
  for (const metric of METRICS) {
    report.global[metric] = {
      pct: measuredGlobal[metric],
      threshold: config.global[metric],
    };
  }

  for (const [pkg, thresholds] of Object.entries(config.packages)) {
    const measured = packageCoverage(summary, pkg);
    if (!measured) {
      failures.push(`${pkg}: no covered files found in coverage summary`);
      report.packages[pkg] = { measured: null, thresholds };
      continue;
    }
    failures.push(...thresholdShortfalls(pkg, measured, thresholds));
    report.packages[pkg] = { measured, thresholds };
  }

  return { failures, report, passed: failures.length === 0 };
}

export function renderSummaryReport(evaluated) {
  const lines = ["## Coverage gate", ""];
  lines.push("| Scope | Lines | Statements | Functions | Branches |");
  lines.push("| --- | ---: | ---: | ---: | ---: |");
  const row = (name, measured, thresholds) =>
    `| ${name} | ${fmt(measured?.lines?.pct ?? measured?.lines, thresholds?.lines)} | ${fmt(measured?.statements?.pct ?? measured?.statements, thresholds?.statements)} | ${fmt(measured?.functions?.pct ?? measured?.functions, thresholds?.functions)} | ${fmt(measured?.branches?.pct ?? measured?.branches, thresholds?.branches)} |`;
  lines.push(
    row("global", evaluated.report.global, COVERAGE_THRESHOLDS.global),
  );
  for (const [pkg, entry] of Object.entries(evaluated.report.packages)) {
    lines.push(row(pkg, entry.measured, entry.thresholds));
  }
  lines.push("");
  if (evaluated.passed) {
    lines.push("Coverage gate: **passed**.");
  } else {
    lines.push("Coverage gate: **failed**.");
    lines.push("");
    lines.push("```");
    lines.push(...evaluated.failures);
    lines.push("```");
  }
  return lines.join("\n") + "\n";
}

function fmt(pct, threshold) {
  if (pct === undefined || pct === null) return "n/a";
  const value = `${pct.toFixed(1)}%`;
  if (threshold === undefined) return value;
  return `${value} / ${threshold}%`;
}

/**
 * Read coverage/coverage-summary.json, evaluate the gate, write
 * coverage/coverage-gate.json and (optionally) a Markdown summary.
 * Returns the process exit code: 0 when passing, 1 when failing.
 */
export function runCoverageGate(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const coverageDir = resolve(cwd, "coverage");
  const summaryPath = resolve(coverageDir, "coverage-summary.json");

  if (!existsSync(summaryPath)) {
    console.error(
      '[coverage-gate] No coverage report found. Run "pnpm test:coverage" first.',
    );
    return 1;
  }

  let summary;
  try {
    summary = JSON.parse(readFileSync(summaryPath, "utf8"));
  } catch (err) {
    console.error("[coverage-gate] Failed to parse coverage report:", err);
    return 1;
  }

  const evaluated = evaluateCoverage(summary);
  const gateReport = {
    passed: evaluated.passed,
    failures: evaluated.failures,
    ...evaluated.report,
  };
  try {
    writeFileSync(
      resolve(coverageDir, "coverage-gate.json"),
      JSON.stringify(gateReport, null, 2) + "\n",
    );
  } catch {
    // Gating result is still reported on stdout; artifact is best-effort.
  }

  const markdown = renderSummaryReport(evaluated);
  if (options.summaryPath) {
    writeFileSync(resolve(cwd, options.summaryPath), markdown);
  }
  process.stdout.write(markdown);

  if (!evaluated.passed) {
    console.error("[coverage-gate] Coverage below threshold.");
    return 1;
  }
  return 0;
}

if (
  process.argv[1] &&
  (process.argv[1].endsWith("check-coverage.mjs") ||
    import.meta.url === pathToFileURL(process.argv[1]).href)
) {
  process.exitCode = runCoverageGate(
    process.argv.slice(2).includes("--summary")
      ? { summaryPath: "coverage/coverage-summary.md" }
      : {},
  );
}

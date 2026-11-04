import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Compact sorted line numbers into readable ranges (e.g. [12, 13, 14, 20] -> "12-14, 20").
 * @param {number[]} lines
 * @returns {string}
 */
export function formatLineRanges(lines) {
  if (!lines || lines.length === 0) return "none";
  const sorted = Array.from(new Set(lines)).sort((a, b) => a - b);
  const ranges = [];
  let start = sorted[0];
  let end = start;

  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === end + 1) {
      end = sorted[i];
    } else {
      ranges.push(start === end ? `${start}` : `${start}-${end}`);
      start = sorted[i];
      end = start;
    }
  }
  ranges.push(start === end ? `${start}` : `${start}-${end}`);
  return ranges.join(", ");
}

/**
 * Reads existing coverage reports from disk and renders summary metrics
 * without triggering a test run.
 *
 * @param {object} [options]
 * @param {string} [options.cwd]
 * @param {boolean} [options.silentOnMissing]
 * @param {number} [options.threshold]
 * @returns {{ hasReport: boolean, summary?: object }}
 */
export function printCoverageReport(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const summaryPath = resolve(cwd, "coverage/coverage-summary.json");
  const detailsPath = resolve(cwd, "coverage/coverage-final.json");

  if (!existsSync(summaryPath)) {
    if (!options.silentOnMissing) {
      console.log(
        '\x1b[33m[coverage]\x1b[0m No coverage report found. Run "pnpm test:coverage" to generate one.\n',
      );
    }
    return { hasReport: false };
  }

  try {
    const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
    let details = {};
    if (existsSync(detailsPath)) {
      try {
        details = JSON.parse(readFileSync(detailsPath, "utf8"));
      } catch {
        // Details file parse error fallback
      }
    }

    const total = summary.total;
    if (!total) {
      return { hasReport: false };
    }

    const colorPct = (pct, threshold = 80) =>
      pct >= threshold ? `\x1b[32m${pct}%\x1b[0m` : `\x1b[31m${pct}%\x1b[0m`;

    console.log("\n\x1b[1m=== Last Cached Test Coverage ===\x1b[0m");
    console.log(
      `Lines:      ${colorPct(total.lines.pct)} (${total.lines.covered}/${total.lines.total}) | ` +
        `Statements: ${colorPct(total.statements.pct)} (${total.statements.covered}/${total.statements.total}) | ` +
        `Branches:   ${colorPct(total.branches.pct, 70)} (${total.branches.covered}/${total.branches.total}) | ` +
        `Functions:  ${colorPct(total.functions.pct)} (${total.functions.covered}/${total.functions.total})`,
    );

    const fileEntries = Object.entries(summary).filter(([k]) => k !== "total");
    if (fileEntries.length > 0) {
      console.log("\n\x1b[1mCovered / Uncovered Files & Lines:\x1b[0m");

      // Sort files: lowest coverage first to highlight files needing attention
      fileEntries.sort((a, b) => a[1].lines.pct - b[1].lines.pct);

      for (const [filePath, stats] of fileEntries) {
        const relPath = relative(cwd, filePath);
        const uncoveredLines = [];
        const fileDetail = details[filePath];

        if (fileDetail?.statementMap && fileDetail?.s) {
          for (const [key, count] of Object.entries(fileDetail.s)) {
            if (count === 0) {
              const range = fileDetail.statementMap[key];
              if (range) {
                for (let l = range.start.line; l <= range.end.line; l++) {
                  uncoveredLines.push(l);
                }
              }
            }
          }
        }

        const pct = stats.lines.pct;
        const linePct = `${pct}%`.padStart(6);
        const isComplete = pct === 100;
        const color = isComplete
          ? "\x1b[32m"
          : pct >= 80
            ? "\x1b[33m"
            : "\x1b[31m";
        const linesInfo = isComplete
          ? "\x1b[90m(all lines covered)\x1b[0m"
          : `\x1b[31muncovered lines: ${formatLineRanges(uncoveredLines)}\x1b[0m`;

        console.log(`  ${color}${linePct}\x1b[0m  ${relPath}  ${linesInfo}`);
      }
    }
    console.log("=================================\n");

    return { hasReport: true, summary: total };
  } catch (err) {
    console.warn(
      "\x1b[33m[coverage]\x1b[0m Failed to parse coverage report:",
      err,
    );
    return { hasReport: false };
  }
}

// Execute directly if run as a script
if (
  process.argv[1] &&
  (process.argv[1].endsWith("print-coverage.mjs") ||
    import.meta.url === pathToFileURL(process.argv[1]).href)
) {
  printCoverageReport();
}

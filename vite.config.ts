import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";

import { COVERAGE_THRESHOLDS } from "./scripts/coverage-thresholds.mjs";
import { printCoverageReport } from "./scripts/print-coverage.mjs";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

/**
 * Vite plugin that prints the existing test coverage summary when the
 * dev server starts, and serves the static HTML coverage report at /coverage.
 */
export function coverageViewerPlugin(): Plugin {
  return {
    name: "chainmcp-coverage-viewer",
    apply(config, { command, mode }) {
      // Only apply this plugin during dev server, not during vitest or build
      return command === "serve" && !process.env.VITEST && mode !== "test";
    },
    configureServer(server) {
      if (process.env.VITEST) {
        return;
      }

      // 1. Print terminal summary of existing coverage (never runs vitest itself)
      printCoverageReport();

      // 2. Serve static coverage report assets at /coverage
      const coverageDir = resolve(process.cwd(), "coverage");
      if (existsSync(coverageDir)) {
        server.middlewares.use("/coverage", (req, res, next) => {
          let reqPath = req.url?.split("?")[0] || "/";
          if (reqPath === "" || reqPath === "/") {
            reqPath = "/index.html";
          }
          const filePath = resolve(coverageDir, "." + reqPath);

          // Prevent directory traversal outside coverage directory
          if (!filePath.startsWith(coverageDir) || !existsSync(filePath)) {
            return next();
          }

          if (statSync(filePath).isDirectory()) {
            const indexHtml = resolve(filePath, "index.html");
            if (existsSync(indexHtml)) {
              res.setHeader("Content-Type", "text/html; charset=utf-8");
              return createReadStream(indexHtml).pipe(res);
            }
            return next();
          }

          const ext = extname(filePath).toLowerCase();
          res.setHeader(
            "Content-Type",
            MIME_TYPES[ext] || "application/octet-stream",
          );
          createReadStream(filePath).pipe(res);
        });

        server.httpServer?.once("listening", () => {
          const address = server.httpServer?.address();
          const port =
            typeof address === "object" && address ? address.port : 5173;
          console.log(
            `\x1b[36m[coverage]\x1b[0m Detailed report served at: http://localhost:${port}/coverage\n`,
          );
        });
      }
    },
  };
}

export default defineConfig({
  plugins: [coverageViewerPlugin()],
  server: {
    port: 5173,
  },
  test: {
    include: [
      "packages/*/tests/**/*.test.ts",
      "packages/*/src/**/*.{test,spec}.ts",
      // Package-level `vitest run` (pnpm -r test) uses the package as root.
      "tests/**/*.{test,spec}.ts",
      "src/**/*.{test,spec}.{ts,tsx,js,jsx}",
    ],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "scripts/**",
      "eslint-rules/**",
      "**/.next/**",
    ],
    coverage: {
      enabled: false,
      provider: "v8",
      reporter: [
        "text",
        "text-summary",
        "html",
        "lcov",
        "json-summary",
        "json",
      ],
      include: [
        "src/**/*.{ts,tsx,js,jsx}",
        "packages/*/src/**/*.{ts,tsx,js,jsx}",
      ],
      exclude: [
        "**/*.test.*",
        "**/*.spec.*",
        "**/*.config.*",
        "**/node_modules/**",
        "**/dist/**",
        "**/.next/**",
      ],
      // Per-package floors (P1-4): single source of truth is
      // scripts/coverage-thresholds.mjs, shared with scripts/check-coverage.mjs.
      // Vitest enforces these on the root run; the gate script enforces them
      // in CI from the exported summary, including package renames.
      thresholds: {
        ...COVERAGE_THRESHOLDS.global,
        ...Object.fromEntries(
          Object.entries(COVERAGE_THRESHOLDS.packages).map(([pkg, value]) => [
            `packages/${pkg}/src/**`,
            value,
          ]),
        ),
      },
    },
  },
});

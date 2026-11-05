/**
 * Coverage thresholds for P1-4 (measure coverage and gate it in CI).
 *
 * These are floors, not targets: each package starts just below the
 * coverage measured on 2026-11-05 so the gate catches regressions
 * without failing on the current tree. Ratchet a number upward in
 * the same change that raises the package's measured coverage.
 *
 * Measured baselines (lines / functions / branches, %):
 * admin 79.2/91.8/71.2, analytics 88.5/88.6/74.9, auth 81.5/94.8/72.2,
 * authoring 92.2/100/92.1, cache-redis 81.7/93.0/81.3, cli 74.8/89.6/65.9,
 * compiler 78.3/98.5/81.1, config 88.3/91.4/77.1, core 91.0/96.1/87.8,
 * declarative 71.0/92.5/74.8, executor 84.1/93.8/77.0, gateway 80.3/82.1/67.1,
 * json-navigation 80.8/96.4/65.1, rate-limit 75.7/95.7/72.8,
 * server 87.6/96.6/81.0. Global: 81.3/93.3/76.5.
 */
export const COVERAGE_THRESHOLDS = {
  global: {
    lines: 80,
    statements: 80,
    functions: 92,
    branches: 74,
  },
  packages: {
    admin: { lines: 78, statements: 78, functions: 90, branches: 69 },
    analytics: { lines: 87, statements: 87, functions: 87, branches: 72 },
    auth: { lines: 80, statements: 80, functions: 93, branches: 70 },
    authoring: { lines: 91, statements: 91, functions: 99, branches: 90 },
    "cache-redis": { lines: 80, statements: 80, functions: 92, branches: 79 },
    cli: { lines: 73, statements: 73, functions: 88, branches: 63 },
    compiler: { lines: 77, statements: 77, functions: 97, branches: 79 },
    config: { lines: 87, statements: 87, functions: 90, branches: 75 },
    core: { lines: 90, statements: 90, functions: 95, branches: 85 },
    declarative: { lines: 70, statements: 70, functions: 91, branches: 72 },
    executor: { lines: 83, statements: 83, functions: 92, branches: 75 },
    gateway: { lines: 79, statements: 79, functions: 81, branches: 65 },
    "json-navigation": {
      lines: 79,
      statements: 79,
      functions: 95,
      branches: 63,
    },
    "rate-limit": { lines: 74, statements: 74, functions: 94, branches: 70 },
    server: { lines: 86, statements: 86, functions: 95, branches: 79 },
  },
};

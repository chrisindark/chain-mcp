#!/usr/bin/env node
// Keeps the private root package version in lockstep with the published
// workspace packages. Changesets versions the workspace packages; this script
// mirrors that version onto the root package so the repository has one version.
//
// Usage:
//   node scripts/sync-version.mjs           # write the root version
//   node scripts/sync-version.mjs --check   # fail if they are out of sync

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const WORKSPACE_PACKAGES = [
  "packages/analytics/package.json",
  "packages/auth/package.json",
  "packages/authoring/package.json",
  "packages/cache-redis/package.json",
  "packages/cli/package.json",
  "packages/compiler/package.json",
  "packages/core/package.json",
  "packages/config/package.json",
  "packages/executor/package.json",
  "packages/json-navigation/package.json",
  "packages/rate-limit/package.json",
  "packages/server/package.json",
];
const ROOT_PACKAGE = "package.json";
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const checkOnly = process.argv.includes("--check");

function fail(message) {
  console.error(`sync-version: ${message}`);
  process.exit(1);
}

function readPackage(relativePath) {
  const url = new URL(`../${relativePath}`, import.meta.url);
  return {
    path: fileURLToPath(url),
    url,
    data: JSON.parse(readFileSync(url, "utf8")),
  };
}

const packages = WORKSPACE_PACKAGES.map(readPackage);
const versions = new Set(packages.map(({ data }) => data.version));

if (versions.size !== 1) {
  fail(
    `workspace packages must share one version, found: ${[...versions].join(", ")}`,
  );
}

const [version] = versions;
if (typeof version !== "string" || !SEMVER.test(version)) {
  fail(`workspace packages have an invalid version: ${String(version)}`);
}

const root = readPackage(ROOT_PACKAGE);
if (root.data.version === version) {
  console.log(`sync-version: root and workspace packages are at ${version}`);
  process.exit(0);
}

if (checkOnly) {
  fail(
    `root package is at ${String(root.data.version)} but workspace packages are at ${version}`,
  );
}

root.data.version = version;
writeFileSync(root.url, `${JSON.stringify(root.data, null, 2)}\n`);
console.log(`sync-version: set root version to ${version}`);

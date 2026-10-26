#!/usr/bin/env node
// Generates a CycloneDX 1.5 compliant Software Bill of Materials (SBOM) for the
// ChainMcp workspace packages and their production dependencies.
//
// Usage:
//   node scripts/generate-sbom.mjs             # write dist/sbom.cdx.json
//   node scripts/generate-sbom.mjs --out <file> # write to specific file
//   node scripts/generate-sbom.mjs --check      # validate package metadata

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(__dirname, "..");

const WORKSPACE_PACKAGES = [
  "packages/analytics/package.json",
  "packages/auth/package.json",
  "packages/authoring/package.json",
  "packages/cache-redis/package.json",
  "packages/cli/package.json",
  "packages/compiler/package.json",
  "packages/config/package.json",
  "packages/core/package.json",
  "packages/executor/package.json",
  "packages/gateway/package.json",
  "packages/json-navigation/package.json",
  "packages/rate-limit/package.json",
  "packages/server/package.json",
];

const checkOnly = process.argv.includes("--check");
const outArgIndex = process.argv.indexOf("--out");
const outputPath =
  outArgIndex !== -1 && process.argv[outArgIndex + 1]
    ? resolve(process.cwd(), process.argv[outArgIndex + 1])
    : resolve(ROOT_DIR, "dist/sbom.cdx.json");

function readJson(relPath) {
  const fullPath = resolve(ROOT_DIR, relPath);
  return JSON.parse(readFileSync(fullPath, "utf8"));
}

const rootPkg = readJson("package.json");
const packageDataList = WORKSPACE_PACKAGES.map((pkgRelPath) => {
  const data = readJson(pkgRelPath);
  return {
    relativePath: pkgRelPath,
    data,
  };
});

// Verification step
for (const { relativePath, data } of packageDataList) {
  if (!data.name || !data.version) {
    console.error(
      `SBOM validation error: ${relativePath} is missing name or version`,
    );
    process.exit(1);
  }
  if (data.license !== "Apache-2.0") {
    console.error(
      `SBOM validation error: ${relativePath} license is ${data.license}, expected Apache-2.0`,
    );
    process.exit(1);
  }
}

if (checkOnly) {
  console.log(
    "SBOM check: all workspace package metadata and licenses are valid (Apache-2.0).",
  );
  process.exit(0);
}

// Build CycloneDX 1.5 JSON representation
const components = [];
const dependencies = [];

for (const { data } of packageDataList) {
  const purl = `pkg:npm/${encodeURIComponent(data.name)}@${data.version}`;
  const bomRef = purl;

  components.push({
    type: "library",
    "bom-ref": bomRef,
    name: data.name,
    version: data.version,
    description: data.description ?? "",
    licenses: [
      {
        license: {
          id: data.license ?? "Apache-2.0",
        },
      },
    ],
    purl,
    externalReferences: [
      {
        type: "vcs",
        url:
          typeof data.repository === "object"
            ? data.repository.url
            : "https://github.com/chrisindark/chain-mcp",
      },
    ],
  });

  const depRefs = [];
  if (data.dependencies) {
    for (const [depName, depVer] of Object.entries(data.dependencies)) {
      const depPurl = `pkg:npm/${encodeURIComponent(depName)}@${depVer.replace(/^workspace:\*?/, data.version)}`;
      depRefs.push(depPurl);
    }
  }

  dependencies.push({
    ref: bomRef,
    dependsOn: depRefs,
  });
}

const sbom = {
  bomFormat: "CycloneDX",
  specVersion: "1.5",
  serialNumber: `urn:uuid:${randomUUID()}`,
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    tools: [
      {
        vendor: "ChainMcp",
        name: "chainmcp-sbom-generator",
        version: rootPkg.version,
      },
    ],
    component: {
      type: "application",
      "bom-ref": `pkg:npm/chainmcp@${rootPkg.version}`,
      name: "chainmcp",
      version: rootPkg.version,
      description:
        "Model Context Protocol tools generated from OpenAPI contracts",
      licenses: [
        {
          license: {
            id: "Apache-2.0",
          },
        },
      ],
    },
  },
  components,
  dependencies,
};

const outputDir = dirname(outputPath);
if (!existsSync(outputDir)) {
  mkdirSync(outputDir, { recursive: true });
}

writeFileSync(outputPath, `${JSON.stringify(sbom, null, 2)}\n`, "utf8");
console.log(`Generated CycloneDX SBOM at: ${outputPath}`);

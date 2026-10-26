#!/usr/bin/env node
// Generates a CycloneDX 1.5 compliant Software Bill of Materials (SBOM) for the
// ChainMcp workspace packages and their transitive dependencies.
//
// Usage:
//   node scripts/generate-sbom.mjs             # write dist/sbom.cdx.json
//   node scripts/generate-sbom.mjs --out <file> # write to specific file
//   node scripts/generate-sbom.mjs --check      # validate package and lockfile metadata

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

// Verification step for workspace packages
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

// Parse transitive lockfile components
function parseLockfilePackages() {
  const lockfilePath = resolve(ROOT_DIR, "pnpm-lock.yaml");
  if (!existsSync(lockfilePath)) return [];

  const content = readFileSync(lockfilePath, "utf8");
  const lines = content.split("\n");
  let inPackages = false;
  const packages = [];
  let currentPkg = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === "packages:") {
      inPackages = true;
      continue;
    }
    if (
      inPackages &&
      line.length > 0 &&
      !line.startsWith(" ") &&
      !line.startsWith("#")
    ) {
      break;
    }
    if (
      inPackages &&
      line.startsWith("  ") &&
      !line.startsWith("    ") &&
      line.includes("@") &&
      line.endsWith(":")
    ) {
      if (currentPkg) {
        packages.push(currentPkg);
      }
      const raw = line
        .trim()
        .replace(/^['"]|['"]:?$/g, "")
        .replace(/:$/, "");
      const lastAt = raw.lastIndexOf("@");
      if (lastAt > 0) {
        const name = raw.slice(0, lastAt);
        const versionPart = raw.slice(lastAt + 1);
        const version = versionPart.split("(")[0];
        currentPkg = {
          rawKey: raw,
          name,
          version,
          integrity: null,
          dependencies: [],
        };
      } else {
        currentPkg = null;
      }
      continue;
    }

    if (currentPkg) {
      const trimmed = line.trim();
      if (trimmed.startsWith("integrity:")) {
        const match = trimmed.match(
          /integrity:\s*(?:\{)?\s*([a-zA-Z0-9+/=_-]+)/,
        );
        if (match) {
          currentPkg.integrity = match[1];
        }
      } else if (
        trimmed === "dependencies:" ||
        trimmed === "optionalDependencies:"
      ) {
        let j = i + 1;
        while (j < lines.length && lines[j].startsWith("      ")) {
          const depLine = lines[j].trim();
          const depMatch = depLine.match(
            /^['"]?(@?[^'":\s]+)['"]?:\s*['"]?([^\s'"]+)['"]?/,
          );
          if (depMatch) {
            currentPkg.dependencies.push({
              name: depMatch[1],
              version: depMatch[2].split("(")[0],
            });
          }
          j++;
        }
      }
    }
  }

  if (currentPkg) {
    packages.push(currentPkg);
  }

  return packages;
}

const transitivePackages = parseLockfilePackages();

if (transitivePackages.length === 0) {
  console.error(
    "SBOM error: Could not parse transitive packages from pnpm-lock.yaml",
  );
  process.exit(1);
}

if (checkOnly) {
  console.log(
    `SBOM check: all workspace package metadata and licenses are valid (Apache-2.0), and ${transitivePackages.length} transitive lockfile components verified.`,
  );
  process.exit(0);
}

// Build CycloneDX 1.5 JSON representation
const components = [];
const dependencies = [];
const knownComponentPurls = new Set();

// 1. Workspace components
for (const { data } of packageDataList) {
  const purl = `pkg:npm/${encodeURIComponent(data.name)}@${data.version}`;
  const bomRef = purl;
  knownComponentPurls.add(purl);

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

// 2. Transitive lockfile components
for (const pkg of transitivePackages) {
  const purl = `pkg:npm/${encodeURIComponent(pkg.name)}@${pkg.version}`;
  if (knownComponentPurls.has(purl)) continue;
  knownComponentPurls.add(purl);

  const comp = {
    type: "library",
    "bom-ref": purl,
    name: pkg.name,
    version: pkg.version,
    purl,
  };

  if (pkg.integrity) {
    if (pkg.integrity.startsWith("sha512-")) {
      comp.hashes = [
        {
          alg: "SHA-512",
          content: pkg.integrity.slice("sha512-".length).replace(/,$/, ""),
        },
      ];
    } else if (pkg.integrity.startsWith("sha1-")) {
      comp.hashes = [
        {
          alg: "SHA-1",
          content: pkg.integrity.slice("sha1-".length).replace(/,$/, ""),
        },
      ];
    }
  }

  components.push(comp);

  if (pkg.dependencies.length > 0) {
    const depRefs = pkg.dependencies.map(
      (d) => `pkg:npm/${encodeURIComponent(d.name)}@${d.version}`,
    );
    dependencies.push({
      ref: purl,
      dependsOn: depRefs,
    });
  }
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
console.log(
  `Generated CycloneDX SBOM at: ${outputPath} (${components.length} components, ${dependencies.length} dependency edges)`,
);

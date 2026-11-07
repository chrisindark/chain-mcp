#!/usr/bin/env node
// Validates that exported ChainMcp tool declarations, input schemas, and gateway
// management endpoints match the frozen snapshot in snapshots/mcp-tool-declarations.snapshot.json.
// Prevents unintended schema drift, breaking argument changes, and contract drift.
//
// Usage:
//   node scripts/check-schema-snapshots.mjs [--check]
//   node scripts/check-schema-snapshots.mjs --update
//   node scripts/check-schema-snapshots.mjs --json

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_SNAPSHOT_PATH = resolve(
  ROOT,
  "snapshots/mcp-tool-declarations.snapshot.json",
);

function parseArgs() {
  const args = process.argv.slice(2);
  let snapshotPath = DEFAULT_SNAPSHOT_PATH;
  let isUpdate = false;
  let isJson = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--update") {
      isUpdate = true;
    } else if (arg === "--json") {
      isJson = true;
    } else if (arg === "--snapshot" && i + 1 < args.length) {
      snapshotPath = resolve(ROOT, args[++i]);
    }
  }

  return { isUpdate, isJson, snapshotPath };
}

export async function generateDeclarationsSnapshot() {
  const { createJsonNavigationTools, ResultHandleRegistry } = await import(
    resolve(ROOT, "packages/json-navigation/dist/index.js")
  );
  const { compileOpenApi } = await import(
    resolve(ROOT, "packages/compiler/dist/index.js")
  );
  const { parseDeclarativeToolDescriptor } = await import(
    resolve(ROOT, "packages/declarative/dist/index.js")
  );
  const { calculatorTool, textAnalyzerTool } = await import(
    resolve(ROOT, "examples/code-first/dist/tools.js")
  );

  // 1. Built-in JSON navigation tools
  const navTools = createJsonNavigationTools(new ResultHandleRegistry())
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  // 2. Canonical compiled OpenAPI tools (Petstore)
  const petstoreYaml = readFileSync(
    resolve(ROOT, "examples/petstore/openapi.yaml"),
    "utf8",
  );
  const compiled = compileOpenApi(petstoreYaml, {
    format: "yaml",
    allowManifestDrift: true,
  })
    .tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  // 3. Code-first TypeScript authoring tools
  const codeFirstTools = [calculatorTool, textAnalyzerTool]
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  // 4. Canonical declarative HTTP tool
  const declarativeParsed = parseDeclarativeToolDescriptor({
    descriptorVersion: 1,
    name: "get_user",
    description: "Fetches one user",
    request: {
      method: "GET",
      path: "/users/{userId}",
      parameters: [
        { name: "userId", in: "path", required: true },
        { name: "limit", in: "query" },
      ],
    },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["userId"],
      properties: {
        userId: { type: "string", minLength: 1 },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
    },
  });
  const declarativeTools = [
    {
      name: declarativeParsed.operation.name,
      description: declarativeParsed.operation.description,
      inputSchema: declarativeParsed.operation.inputSchema,
    },
  ];

  // 5. Gateway and Admin API management routes
  const adminRoutes = [
    "GET /health",
    "GET /api/v1/contracts",
    "POST /api/v1/tenants/:tenant/contracts/:contract/validate",
    "POST /api/v1/tenants/:tenant/contracts/:contract/preview",
    "POST /api/v1/tenants/:tenant/contracts/:contract/publish",
    "POST /api/v1/tenants/:tenant/contracts/:contract/rollback",
  ];

  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    version: 1,
    description:
      "Frozen snapshot of ChainMcp tool declarations, schemas, and contract signatures to detect contract drift.",
    tools: {
      code_first: codeFirstTools,
      compiled_petstore: compiled,
      declarative_http: declarativeTools,
      json_navigation: navTools,
    },
    admin_routes: adminRoutes,
  };
}

function canonicalJson(obj) {
  if (obj === null || typeof obj !== "object") {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return "[" + obj.map(canonicalJson).join(",") + "]";
  }
  const keys = Object.keys(obj).sort();
  return (
    "{" +
    keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(obj[k])).join(",") +
    "}"
  );
}

export function diffSnapshots(actual, expected) {
  const diffs = [];
  if (canonicalJson(actual) === canonicalJson(expected)) {
    return diffs;
  }

  // Check top-level tool categories
  const actualToolCategories = Object.keys(actual.tools || {}).sort();
  const expectedToolCategories = Object.keys(expected.tools || {}).sort();
  if (
    JSON.stringify(actualToolCategories) !==
    JSON.stringify(expectedToolCategories)
  ) {
    diffs.push({
      path: "tools",
      message: `Tool categories changed: actual [${actualToolCategories.join(", ")}], expected [${expectedToolCategories.join(", ")}]`,
    });
  }

  for (const category of actualToolCategories) {
    if (!expected.tools?.[category]) continue;
    const actualList = actual.tools[category];
    const expectedList = expected.tools[category];

    const actualNames = actualList.map((t) => t.name);
    const expectedNames = expectedList.map((t) => t.name);
    if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
      diffs.push({
        path: `tools.${category}`,
        message: `Tools in category '${category}' changed: [${actualNames.join(", ")}] vs expected [${expectedNames.join(", ")}]`,
      });
      continue;
    }

    for (let i = 0; i < actualList.length; i++) {
      const a = actualList[i];
      const e = expectedList[i];
      if (a.description !== e.description) {
        diffs.push({
          path: `tools.${category}.${a.name}.description`,
          message: `Description changed for tool '${a.name}'`,
          actual: a.description,
          expected: e.description,
        });
      }
      const aSchema = JSON.stringify(a.inputSchema);
      const eSchema = JSON.stringify(e.inputSchema);
      if (aSchema !== eSchema) {
        diffs.push({
          path: `tools.${category}.${a.name}.inputSchema`,
          message: `Input schema signature changed for tool '${a.name}'`,
          actual: a.inputSchema,
          expected: e.inputSchema,
        });
      }
    }
  }

  // Check admin routes
  if (
    JSON.stringify(actual.admin_routes) !==
    JSON.stringify(expected.admin_routes)
  ) {
    diffs.push({
      path: "admin_routes",
      message: "Admin/Gateway route signatures changed",
      actual: actual.admin_routes,
      expected: expected.admin_routes,
    });
  }

  if (diffs.length === 0) {
    diffs.push({
      path: "$root",
      message: "Snapshot JSON differs in metadata or formatting",
    });
  }

  return diffs;
}

async function runCli() {
  const { isUpdate, isJson, snapshotPath } = parseArgs();
  const currentSnapshot = await generateDeclarationsSnapshot();
  const formattedJson = JSON.stringify(currentSnapshot, null, 2) + "\n";

  if (isUpdate) {
    writeFileSync(snapshotPath, formattedJson, "utf8");
    if (isJson) {
      console.log(
        JSON.stringify({
          status: "updated",
          snapshotPath,
          toolCount: Object.values(currentSnapshot.tools).reduce(
            (acc, t) => acc + t.length,
            0,
          ),
        }),
      );
    } else {
      console.log(
        `[snapshot:check] Updated MCP tool declarations snapshot at ${snapshotPath}`,
      );
    }
    process.exit(0);
  }

  if (!existsSync(snapshotPath)) {
    if (isJson) {
      console.error(
        JSON.stringify({
          status: "error",
          message: `Snapshot file missing at ${snapshotPath}. Run with --update to generate.`,
        }),
      );
    } else {
      console.error(
        `[snapshot:check] Snapshot file missing at ${snapshotPath}. Run with --update to generate.`,
      );
    }
    process.exit(1);
  }

  const existingRaw = readFileSync(snapshotPath, "utf8");
  let existingSnapshot;
  try {
    existingSnapshot = JSON.parse(existingRaw);
  } catch (err) {
    if (isJson) {
      console.error(
        JSON.stringify({
          status: "error",
          message: `Snapshot file is corrupted JSON: ${err.message}`,
        }),
      );
    } else {
      console.error(
        `[snapshot:check] Snapshot file is corrupted JSON: ${err.message}`,
      );
    }
    process.exit(1);
  }

  const diffs = diffSnapshots(currentSnapshot, existingSnapshot);
  if (diffs.length > 0) {
    if (isJson) {
      console.error(
        JSON.stringify({
          status: "drift",
          diffCount: diffs.length,
          diffs,
        }),
      );
    } else {
      console.error(
        `[snapshot:check] Error: MCP tool declarations or schemas have drifted from snapshot!`,
      );
      for (const d of diffs) {
        if (typeof d.expected === "string" && typeof d.actual === "string") {
          console.error(
            `  - ${d.path}: ${d.message} (expected: "${d.expected}", actual: "${d.actual}")`,
          );
        } else {
          console.error(`  - ${d.path}: ${d.message}`);
        }
      }
      console.error(`\nIf this change was intentional, accept it by running:`);
      console.error(`  node scripts/check-schema-snapshots.mjs --update\n`);
    }
    process.exit(1);
  }

  if (isJson) {
    console.log(
      JSON.stringify({
        status: "ok",
        toolCount: Object.values(currentSnapshot.tools).reduce(
          (acc, t) => acc + t.length,
          0,
        ),
      }),
    );
  } else {
    console.log(
      `[snapshot:check] All MCP tool declarations, schemas, and contract signatures match snapshot (${Object.values(currentSnapshot.tools).reduce((acc, t) => acc + t.length, 0)} tools verified).`,
    );
  }
}

const isDirectExecution =
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isDirectExecution) {
  runCli().catch((err) => {
    console.error(`[snapshot:check] Fatal error: ${err.stack || err.message}`);
    process.exit(1);
  });
}

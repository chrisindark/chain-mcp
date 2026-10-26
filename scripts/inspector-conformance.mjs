import { spawn, spawnSync } from "node:child_process";
import { InMemoryToolRuntime } from "../packages/core/dist/index.js";
import {
  createBearerTokenVerifier,
  serveHttp,
} from "../packages/server/dist/index.js";

const serverPath = process.argv[2] ?? "examples/petstore/dist/server.js";
const npx = process.platform === "win32" ? "npx.cmd" : "npx";

// ==========================================
// 1. STDIO Transport Conformance
// ==========================================
console.log("Testing stdio transport conformance with MCP Inspector...");

function runStdio(method, extra = []) {
  const result = spawnSync(
    npx,
    [
      "--yes",
      "@modelcontextprotocol/inspector@2.11.0",
      "--cli",
      "node",
      serverPath,
      "--method",
      method,
      ...extra,
      "--format",
      "json",
    ],
    { encoding: "utf8" },
  );
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `Inspector stdio ${method} failed with status ${result.status}: ${result.stderr}`,
    );
  }
  return JSON.parse(result.stdout);
}

const stdioListed = runStdio("tools/list");
const stdioNames = stdioListed.result.tools.map((tool) => tool.name).sort();
if (stdioNames.join(",") !== "createItem,getItem") {
  throw new Error(`Unexpected stdio tool list: ${stdioNames.join(", ")}`);
}

const stdioRead = runStdio("tools/call", [
  "--tool-name",
  "getItem",
  "--tool-args-json",
  '{"id":"42"}',
]);
const stdioText = stdioRead.result.content[0]?.text;
const stdioItem =
  typeof stdioText === "string" ? JSON.parse(stdioText) : undefined;
if (stdioItem?.id !== "42" || stdioItem?.name !== "Demo item 42") {
  throw new Error(`Unexpected getItem result: ${String(stdioText)}`);
}

const stdioCreated = runStdio("tools/call", [
  "--tool-name",
  "createItem",
  "--tool-args-json",
  '{"body":{"name":"Widget","quantity":2}}',
]);
const stdioCreatedText = stdioCreated.result.content[0]?.text;
const stdioCreatedItem =
  typeof stdioCreatedText === "string"
    ? JSON.parse(stdioCreatedText)
    : undefined;
if (
  stdioCreatedItem?.id !== "item-1" ||
  stdioCreatedItem?.name !== "Widget" ||
  stdioCreatedItem?.quantity !== 2
) {
  throw new Error(`Unexpected createItem result: ${String(stdioCreatedText)}`);
}

console.log("✓ Stdio transport conformance verified.");

// ==========================================
// 2. Streamable HTTP Transport Conformance
// ==========================================
console.log(
  "Testing Streamable HTTP transport conformance with MCP Inspector...",
);

const runtime = new InMemoryToolRuntime();
runtime.register({
  name: "getItem",
  description: "Get item by ID",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
  },
  async execute(input, context) {
    const { id } = input;
    return {
      id,
      name: `Demo item ${id}`,
      tenantId: context.tenantId,
      principalId: context.principal.id,
    };
  },
});
runtime.register({
  name: "createItem",
  description: "Create an item",
  inputSchema: {
    type: "object",
    properties: {
      body: {
        type: "object",
        properties: {
          name: { type: "string" },
          quantity: { type: "number" },
        },
        required: ["name"],
      },
    },
    required: ["body"],
  },
  async execute(input) {
    const { body } = input;
    return {
      id: "item-1",
      name: body.name,
      quantity: body.quantity ?? 1,
    };
  },
});

const bearerVerifier = createBearerTokenVerifier({
  tokens: {
    "test-conformance-token": {
      tenantId: "tenant-conformance",
      principalId: "inspector-client",
      scopes: ["read", "write"],
    },
  },
});

const httpHandle = await serveHttp(
  runtime,
  {
    name: "http-conformance-server",
    version: "1.0.0",
    createContext: (request) => {
      const auth = request.authInfo;
      return {
        requestId: "http-req-1",
        tenantId: auth?.extra?.tenantId ?? "default",
        principal: {
          id: auth?.clientId ?? "anonymous",
          scopes: auth?.scopes ?? [],
        },
      };
    },
  },
  {
    port: 0,
    verifier: bearerVerifier,
    requireAuth: true,
  },
);

const httpUrl = httpHandle.url.toString();

function runHttpAsync(method, extra = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(npx, [
      "--yes",
      "@modelcontextprotocol/inspector@2.11.0",
      "--cli",
      "--transport",
      "http",
      "--server-url",
      httpUrl,
      "--header",
      "Authorization: Bearer test-conformance-token",
      "--method",
      method,
      ...extra,
      "--format",
      "json",
    ]);

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `Inspector HTTP ${method} failed with status ${code}: ${stderr}`,
          ),
        );
      } else {
        resolve(JSON.parse(stdout));
      }
    });

    child.on("error", reject);
  });
}

try {
  const httpListed = await runHttpAsync("tools/list");
  const httpNames = httpListed.result.tools.map((tool) => tool.name).sort();
  if (httpNames.join(",") !== "createItem,getItem") {
    throw new Error(`Unexpected HTTP tool list: ${httpNames.join(", ")}`);
  }

  const httpRead = await runHttpAsync("tools/call", [
    "--tool-name",
    "getItem",
    "--tool-args-json",
    '{"id":"42"}',
  ]);
  const httpText = httpRead.result.content[0]?.text;
  const httpItem =
    typeof httpText === "string" ? JSON.parse(httpText) : undefined;
  if (httpItem?.id !== "42" || httpItem?.tenantId !== "tenant-conformance") {
    throw new Error(`Unexpected HTTP getItem result: ${String(httpText)}`);
  }

  console.log(
    "✓ Streamable HTTP transport conformance verified with inbound auth.",
  );
} finally {
  await httpHandle.close();
}

console.log(
  "All Inspector conformance tests passed: stdio and streamable HTTP transports verified.",
);

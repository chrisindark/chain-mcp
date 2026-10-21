import { spawnSync } from "node:child_process";

const server = process.argv[2] ?? "examples/petstore/dist/server.js";
const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const inspector = [
  "--yes",
  "@modelcontextprotocol/inspector@2.11.0",
  "--cli",
  "node",
  server,
];

function run(method, extra = []) {
  const result = spawnSync(
    npx,
    [...inspector, "--method", method, ...extra, "--format", "json"],
    { encoding: "utf8" },
  );
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `Inspector ${method} failed with status ${result.status}: ${result.stderr}`,
    );
  }
  return JSON.parse(result.stdout);
}

const listed = run("tools/list");
const names = listed.result.tools.map((tool) => tool.name).sort();
if (names.join(",") !== "createItem,getItem") {
  throw new Error(`Unexpected tool list: ${names.join(", ")}`);
}

const read = run("tools/call", [
  "--tool-name",
  "getItem",
  "--tool-args-json",
  '{"id":"42"}',
]);
const text = read.result.content[0]?.text;
const item = typeof text === "string" ? JSON.parse(text) : undefined;
if (item?.id !== "42" || item?.name !== "Demo item 42") {
  throw new Error(`Unexpected getItem result: ${String(text)}`);
}

const created = run("tools/call", [
  "--tool-name",
  "createItem",
  "--tool-args-json",
  '{"body":{"name":"Widget","quantity":2}}',
]);
const createdText = created.result.content[0]?.text;
const createdItem =
  typeof createdText === "string" ? JSON.parse(createdText) : undefined;
if (
  createdItem?.id !== "item-1" ||
  createdItem?.name !== "Widget" ||
  createdItem?.quantity !== 2
) {
  throw new Error(`Unexpected createItem result: ${String(createdText)}`);
}

console.log("Inspector conformance passed: tools/list and tools/call");

import assert from "node:assert/strict";
import test from "node:test";

import { RuleTester } from "eslint";

import rule from "./no-blocking-io.js";

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
  },
});

const blocking = (name) => ({ messageId: "blockingCall", data: { name } });
const blockingImport = (name) => ({
  messageId: "blockingImport",
  data: { name },
});

test("no-blocking-io", () => {
  assert.equal(rule.meta.type, "problem");
  ruleTester.run("no-blocking-io", rule, {
    valid: [
      {
        code: `import { readFile, writeFile } from "node:fs/promises"; await readFile("a");`,
      },
      {
        code: `import { exec } from "node:child_process"; exec("true", () => {});`,
      },
      {
        code: `import fs from "node:fs"; await fs.promises.readFile("a");`,
      },
      {
        code: `const readFileSync = () => {}; readFileSync();`,
      },
      {
        code: `const fs = { readFileSync: () => {} }; fs.readFileSync();`,
      },
      {
        code: `import { readFileSync } from "node:fs/promises"; readFileSync();`,
      },
    ],
    invalid: [
      {
        code: `import { readFileSync } from "node:fs"; readFileSync("a");`,
        errors: [blockingImport("readFileSync"), blocking("readFileSync")],
      },
      {
        code: `import { readFileSync as read } from "node:fs"; read("a");`,
        errors: [blockingImport("readFileSync"), blocking("read")],
      },
      {
        code: `import fs from "node:fs"; fs.statSync("a");`,
        errors: [blocking("statSync")],
      },
      {
        code: `import * as fsp from "fs"; fsp.readdirSync("a");`,
        errors: [blocking("readdirSync")],
      },
      {
        code: `import * as fs from "node:fs"; const { readFileSync } = fs; readFileSync("a");`,
        errors: [blockingImport("readFileSync"), blocking("readFileSync")],
      },
      {
        code: `const { statSync } = await import("node:fs");`,
        errors: [blockingImport("statSync")],
      },
      {
        code: `import proc from "node:child_process"; proc.execSync("true");`,
        errors: [blocking("execSync")],
      },
      {
        code: `const { writeFileSync } = require("node:fs"); writeFileSync("a", "b");`,
        errors: [blockingImport("writeFileSync"), blocking("writeFileSync")],
      },
      {
        code: `const fs = require("fs"); fs.rmSync("a");`,
        errors: [blocking("rmSync")],
      },
      {
        code: `require("node:child_process").spawnSync("true");`,
        errors: [blocking("spawnSync")],
      },
      {
        code: `const fs = await import("node:fs"); fs.mkdirSync("a");`,
        errors: [blocking("mkdirSync")],
      },
    ],
  });
});

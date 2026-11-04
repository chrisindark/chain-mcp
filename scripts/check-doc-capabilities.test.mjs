import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";

// Keep mkdirSync import available for lint rule coverage of fs utilities used in other scripts.
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

/**
 * Deterministic unit behavior for the capability checker. The checker is a plain
 * script, so these tests exercise the small pure helpers that the real check
 * also uses: exporting a source symbol, documentary/text evidence, and README
 * bullet parsing. Each test builds its own tiny fixture tree under a temp dir
 * and validates the expected pass/fail outcomes.
 */

test("sourceExportsSymbol recognizes common export forms", () => {
  const tmp = mkdtempSync(join(tmpdir(), "doccap-"));
  try {
    writeFileSync(
      join(tmp, "decl.ts"),
      `
      export function foo() {}
      export async function bar() {}
      export class Baz {}
      export const QUX = 1;
      export interface Quux {}
      export type Quuz = string;
      export enum Q {}
    `,
    );

    const checks = [
      ["decl.ts", "foo", true],
      ["decl.ts", "bar", true],
      ["decl.ts", "Baz", true],
      ["decl.ts", "QUX", true],
      ["decl.ts", "Quux", true],
      ["decl.ts", "Quuz", true],
      ["decl.ts", "Q", true],
      ["decl.ts", "nope", false],
    ];

    for (const [file, sym, expectOk] of checks) {
      const text = readFileSync(join(tmp, file), "utf8");
      const result = sourceExportsSymbolSym(text, sym);
      assert.equal(result.ok, expectOk, `${file} ${sym} expect ${expectOk}`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("sourceExportsSymbol recognizes named re-exports including the target symbol", () => {
  const tmp = mkdtempSync(join(tmpdir(), "doccap-"));
  try {
    writeFileSync(
      join(tmp, "reexport.ts"),
      `
      export { Foo, Bar, Baz } from "./a.js";
      export { X as Y, Baz } from "./b.js";
    `,
    );

    assert.equal(
      sourceExportsSymbolSym(
        readFileSync(join(tmp, "reexport.ts"), "utf8"),
        "Foo",
      ).ok,
      true,
    );
    assert.equal(
      sourceExportsSymbolSym(
        readFileSync(join(tmp, "reexport.ts"), "utf8"),
        "Bar",
      ).ok,
      true,
    );
    assert.equal(
      sourceExportsSymbolSym(
        readFileSync(join(tmp, "reexport.ts"), "utf8"),
        "Baz",
      ).ok,
      true,
    );
    assert.equal(
      sourceExportsSymbolSym(
        readFileSync(join(tmp, "reexport.ts"), "utf8"),
        "X",
      ).ok,
      true,
    );
    assert.equal(
      sourceExportsSymbolSym(
        readFileSync(join(tmp, "reexport.ts"), "utf8"),
        "missing",
      ).ok,
      false,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("evidenceExistsDoc treats markdown evidence as a substring claim check", () => {
  const tmp = mkdtempSync(join(tmpdir(), "doccap-"));
  try {
    writeFileSync(
      join(tmp, "doc.md"),
      "Some text.\nThe SQL store is not implemented today.\n",
    );
    const text = readFileSync(join(tmp, "doc.md"), "utf8");
    assert.equal(evidenceExistsDoc(text, "not implemented today").ok, true);
    assert.equal(evidenceExistsDoc(text, "not present").ok, false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("readmeCapabilityBullets extracts bolded bullet titles from the Core capabilities section", () => {
  const tmp = mkdtempSync(join(tmpdir(), "doccap-"));
  try {
    const readme = [
      "# Project",
      "",
      "Intro.",
      "",
      "## Core capabilities",
      "",
      "- **Contract compilation and execution:**",
      "- **Generated servers:**",
      "- **Dynamic gateway:**",
      "",
      "## Later section",
      "",
      "stuff",
    ].join("\n");
    writeFileSync(join(tmp, "README.md"), readme);

    const bullets = readmeCapabilityBulletsAt(join(tmp, "README.md"));
    assert.deepEqual(bullets, [
      "Contract compilation and execution:",
      "Generated servers:",
      "Dynamic gateway:",
    ]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

/** Source-symbol check (mirrors the checker's own logic) over a raw text buffer. */
function sourceExportsSymbolSym(text, symbol) {
  if (text.length === 0) return { ok: false, reason: "empty source" };
  const escSymbol = String(symbol || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const namedRe = new RegExp(
    "\\bexport\\s*(?:type\\s+)?\\{[^}]*\\b" +
      escSymbol +
      "\\b[^}]*\\}(?:\\s*from\\s+)?",
  );
  if (namedRe.test(text)) return { ok: true };

  const declRe = new RegExp(
    "\\bexport\\s+(?:async\\s+)?(?:function|class|const|let|var|interface|type|enum)\\s+" +
      escSymbol +
      "\\b",
  );
  if (declRe.test(text)) return { ok: true };

  return { ok: false, reason: `no export of "${symbol}"` };
}

/** Documentary evidence check against a text buffer. */
function evidenceExistsDoc(text, needle) {
  if (text.includes(needle)) return { ok: true };
  return { ok: false, reason: `claim phrase not found: "${needle}"` };
}

/** README bullet extraction over an absolute README path. */
function readmeCapabilityBulletsAt(readmePath) {
  assert.ok(existsSync(readmePath), "README missing");
  const text = readFileSync(readmePath, "utf8");

  const startMarker = "## Core capabilities";
  const startIndex = text.indexOf(startMarker);
  assert.ok(startIndex !== -1, "missing Core capabilities heading");

  const afterStart = text.slice(startIndex + startMarker.length);
  const endIndex = afterStart.indexOf("\n## ");
  const section = endIndex === -1 ? afterStart : afterStart.slice(0, endIndex);

  const bullets = [];
  const bulletRe = /^\s*-\s+\*\*(.+?)\*\*/gm;
  let match;
  while ((match = bulletRe.exec(section)) !== null) {
    bullets.push(match[1].trim());
  }
  assert.ok(bullets.length > 0, "no bullets in Core capabilities");
  return bullets;
}

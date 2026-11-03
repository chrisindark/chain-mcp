import { describe, expect, it } from "vitest";
import { compileOpenApi, COMPILER_VERSION } from "@chainmcp/compiler";

import {
  buildProjectManifest,
  sha256,
  verifyProjectManifest,
} from "../src/manifest.js";
const GENERATOR_VERSION = "9.9.9";

const VALID_SPEC = `
openapi: "3.1.0"
info:
  title: Test API
  version: "1.0.0"
paths:
  /items:
    get:
      operationId: getItems
      responses:
        "200":
          description: OK
`;

describe("Manifest creation and verification", () => {
  it("computes deterministic SHA-256 hashes", () => {
    const hash1 = sha256("hello chainmcp");
    const hash2 = sha256("hello chainmcp");
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64);
  });

  it("builds a project manifest from compile result", () => {
    const compiled = compileOpenApi(VALID_SPEC);
    expect(compiled.ok).toBe(true);

    const manifest = buildProjectManifest("test-api", compiled, {
      generatorVersion: GENERATOR_VERSION,
    });
    expect(manifest.manifestVersion).toBe(1);
    expect(manifest.generatorVersion).toBe(GENERATOR_VERSION);
    expect(manifest.compilerVersion).toBe(COMPILER_VERSION);
    expect(manifest.projectName).toBe("test-api");
    expect(manifest.contractRevision).toBe(compiled.contractRevision);
    expect(manifest.sourceHash).toBe(compiled.sourceHash);
    expect(manifest.toolsetHash).toBe(compiled.manifest.toolsetHash);
    expect(manifest.toolCount).toBe(1);
    expect(manifest.tools[0]?.name).toBe("getItems");
  });

  it("verifies matching manifests as reproducible", () => {
    const compiled1 = compileOpenApi(VALID_SPEC);
    const compiled2 = compileOpenApi(VALID_SPEC);

    const m1 = buildProjectManifest("test-api", compiled1, {
      generatorVersion: GENERATOR_VERSION,
    });
    const m2 = buildProjectManifest("test-api", compiled2, {
      generatorVersion: GENERATOR_VERSION,
    });

    const result = verifyProjectManifest(m1, m2);
    expect(result.match).toBe(true);
    expect(result.mismatches).toHaveLength(0);
  });

  it("detects source hash mismatches", () => {
    const compiled1 = compileOpenApi(VALID_SPEC);
    const compiled2 = compileOpenApi(VALID_SPEC + "\n# comment");

    const m1 = buildProjectManifest("test-api", compiled1, {
      generatorVersion: GENERATOR_VERSION,
    });
    const m2 = buildProjectManifest("test-api", compiled2, {
      generatorVersion: GENERATOR_VERSION,
    });

    const result = verifyProjectManifest(m1, m2);
    expect(result.match).toBe(false);
    expect(
      result.mismatches.some((m) => m.includes("Source hash mismatch")),
    ).toBe(true);
  });

  it("detects tool mismatches", () => {
    const compiled = compileOpenApi(VALID_SPEC);
    const m1 = buildProjectManifest("test-api", compiled, {
      generatorVersion: GENERATOR_VERSION,
    });
    const m2 = {
      ...m1,
      tools: [{ name: "getItems", hash: "tampered_hash" }],
    };

    const result = verifyProjectManifest(m1, m2);
    expect(result.match).toBe(false);
    expect(result.mismatches.some((m) => m.includes("hash mismatch"))).toBe(
      true,
    );
  });
});

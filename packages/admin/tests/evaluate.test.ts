import { describe, expect, it } from "vitest";

import { DeclarativeAdminError, evaluateDescriptorSet } from "../src/index.js";
import { authSchemes, makeDescriptor } from "./fixtures.js";

describe("evaluateDescriptorSet", () => {
  it("validates descriptors and assigns deterministic revisions", () => {
    const first = evaluateDescriptorSet({
      descriptors: [makeDescriptor()],
      authSchemes,
    });
    const second = evaluateDescriptorSet({
      descriptors: [makeDescriptor()],
      authSchemes,
    });

    expect(first.evaluation.valid).toBe(true);
    expect(first.evaluation.diagnostics).toEqual([]);
    expect(first.evaluation.tools).toHaveLength(1);
    expect(first.evaluation.tools[0]?.name).toBe("get_user");
    expect(first.evaluation.tools[0]?.revision).toMatch(
      /^sha256:[0-9a-f]{64}$/,
    );
    expect(first.evaluation.tools[0]?.revision).toBe(
      second.evaluation.tools[0]?.revision,
    );
    expect(first.parsed).toHaveLength(1);
  });

  it("lowers a static request preview without network access", () => {
    const { preview } = evaluateDescriptorSet({
      descriptors: [makeDescriptor()],
      authSchemes,
    });

    expect(preview.valid).toBe(true);
    expect(preview.tools[0]).toMatchObject({
      index: 0,
      name: "get_user",
      method: "GET",
      path: "/users/{userId}",
      parameters: [
        { name: "limit", in: "query", required: false },
        { name: "userId", in: "path", required: true },
      ],
      authentication: {
        allowsAnonymous: false,
        alternatives: [["api_key"]],
      },
      policy: {
        requiredScopes: ["users:read"],
        cacheTtlSeconds: 30,
        timeoutMs: 5_000,
      },
    });
    expect(preview.tools[0]?.body).toBeUndefined();
  });

  it("reports duplicate tool names with the conflicting index", () => {
    const { evaluation } = evaluateDescriptorSet({
      descriptors: [makeDescriptor(), makeDescriptor()],
      authSchemes,
    });

    expect(evaluation.valid).toBe(false);
    expect(evaluation.tools).toHaveLength(1);
    expect(evaluation.diagnostics).toEqual([
      expect.objectContaining({ index: 1, code: "NAME_DUPLICATE" }),
    ]);
  });

  it("rejects patterns the runtime cannot enforce", () => {
    const { evaluation } = evaluateDescriptorSet({
      descriptors: [
        makeDescriptor({
          name: "delete_user",
          request: {
            method: "DELETE",
            path: "/users/{userId}",
            parameters: [{ name: "userId", in: "path", required: true }],
          },
          inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["userId"],
            properties: { userId: { type: "string" } },
          },
          policy: { cacheTtlSeconds: 60 },
        }),
      ],
      authSchemes,
    });

    expect(evaluation.valid).toBe(false);
    expect(evaluation.diagnostics[0]).toMatchObject({
      index: 0,
      code: "POLICY_INVALID",
    });
    expect(evaluation.diagnostics[0]?.message).toContain(
      "only allowed on read methods",
    );
  });

  it("rejects auth references the deployment has not configured", () => {
    const { evaluation } = evaluateDescriptorSet({
      descriptors: [
        makeDescriptor({
          authentication: {
            alternatives: [{ schemes: [{ name: "not_configured" }] }],
          },
        }),
      ],
      authSchemes,
    });

    expect(evaluation.valid).toBe(false);
    expect(evaluation.diagnostics[0]?.code).toBe("AUTH_SCHEME_UNKNOWN");
    expect(evaluation.diagnostics[0]?.issues[0]?.path).toContain(
      "authentication",
    );
  });

  it("rejects empty, non-array, and oversized sets before parsing", () => {
    expect(() =>
      evaluateDescriptorSet({ descriptors: [], authSchemes }),
    ).toThrowError(DeclarativeAdminError);
    expect(() =>
      evaluateDescriptorSet({
        descriptors: null as unknown as readonly unknown[],
        authSchemes,
      }),
    ).toThrowError(/non-empty 'descriptors' array/);

    try {
      evaluateDescriptorSet({
        descriptors: [makeDescriptor(), makeDescriptor({ name: "second" })],
        authSchemes,
        maxDescriptors: 1,
      });
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(DeclarativeAdminError);
      expect((error as DeclarativeAdminError).status).toBe(400);
      expect((error as DeclarativeAdminError).message).toContain("At most 1");
    }
  });
});

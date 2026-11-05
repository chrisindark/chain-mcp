import { describe, expect, it } from "vitest";
import {
  DEFAULT_SCHEMA_VALIDATION_LIMITS,
  auditInputSchema,
  isAssertedFormat,
  isJsonObject,
  isValidPattern,
  matchesFormat,
  patternMatches,
  stableValueKey,
} from "../src/schema.js";
import { validateJsonSchema } from "../src/index.js";

describe("Core Schema Auditing & Validation", () => {
  describe("auditInputSchema", () => {
    it("rejects non-object root schema with SCHEMA_NOT_OBJECT", () => {
      const res = auditInputSchema(
        "not-a-schema" as unknown as Record<string, unknown>,
      );
      expect(res.supported).toBe(false);
      expect(res.diagnostics[0]?.code).toBe("SCHEMA_NOT_OBJECT");
    });

    it("audits additionalProperties (boolean, object schema, invalid)", () => {
      const validBool = auditInputSchema({
        type: "object",
        additionalProperties: true,
      });
      expect(validBool.supported).toBe(true);

      const validObj = auditInputSchema({
        type: "object",
        additionalProperties: { type: "string" },
      });
      expect(validObj.supported).toBe(true);

      const invalid = auditInputSchema({
        type: "object",
        additionalProperties: "invalid-type",
      });
      expect(invalid.supported).toBe(false);
      expect(invalid.diagnostics[0]?.code).toBe(
        "SCHEMA_INVALID_ADDITIONAL_PROPERTIES",
      );
    });

    it("audits items and prefixItems (object, array tuple, invalid)", () => {
      const validObj = auditInputSchema({
        type: "array",
        items: { type: "number" },
      });
      expect(validObj.supported).toBe(true);

      const validTuple = auditInputSchema({
        type: "array",
        items: [{ type: "string" }, { type: "number" }],
      });
      expect(validTuple.supported).toBe(true);

      const invalidItems = auditInputSchema({
        type: "array",
        items: 12345,
      });
      expect(invalidItems.supported).toBe(false);
      expect(invalidItems.diagnostics[0]?.code).toBe("SCHEMA_INVALID_ITEMS");

      const validPrefix = auditInputSchema({
        type: "array",
        prefixItems: [{ type: "string" }],
      });
      expect(validPrefix.supported).toBe(true);

      const invalidPrefix = auditInputSchema({
        type: "array",
        prefixItems: "not-array",
      });
      expect(invalidPrefix.supported).toBe(false);
      expect(invalidPrefix.diagnostics[0]?.code).toBe("SCHEMA_INVALID_ITEMS");
    });

    it("audits anyOf, oneOf, allOf, not, if/then/else", () => {
      const valid = auditInputSchema({
        anyOf: [{ type: "string" }, { type: "number" }],
        oneOf: [{ minimum: 1 }, { maximum: 10 }],
        allOf: [{ type: "object" }],
        not: { type: "null" },
        if: { properties: { a: { const: 1 } } },
        then: { properties: { b: { type: "string" } } },
        else: { properties: { c: { type: "number" } } },
      });
      expect(valid.supported).toBe(true);

      const emptyAnyOf = auditInputSchema({ anyOf: [] });
      expect(emptyAnyOf.supported).toBe(false);
      expect(emptyAnyOf.diagnostics[0]?.code).toBe("SCHEMA_INVALID_CONSTRAINT");

      const excessBranches = auditInputSchema(
        { anyOf: Array.from({ length: 25 }, () => ({ type: "string" })) },
        { ...DEFAULT_SCHEMA_VALIDATION_LIMITS, maxUnionBranches: 20 },
      );
      expect(excessBranches.supported).toBe(false);
      expect(excessBranches.diagnostics[0]?.code).toBe(
        "SCHEMA_INVALID_CONSTRAINT",
      );
    });

    it("audits dependentRequired and dependentSchemas", () => {
      const valid = auditInputSchema({
        type: "object",
        dependentRequired: { creditCard: ["billingZip"] },
        dependentSchemas: {
          creditCard: { properties: { cvv: { type: "string" } } },
        },
      });
      expect(valid.supported).toBe(true);

      const invalidDepReq = auditInputSchema({
        type: "object",
        dependentRequired: "not-object",
      });
      expect(invalidDepReq.supported).toBe(false);
      expect(invalidDepReq.diagnostics[0]?.code).toBe(
        "SCHEMA_INVALID_CONSTRAINT",
      );

      const invalidDepReqEntry = auditInputSchema({
        type: "object",
        dependentRequired: { creditCard: [123] }, // items must be string
      });
      expect(invalidDepReqEntry.supported).toBe(false);
      expect(invalidDepReqEntry.diagnostics[0]?.code).toBe(
        "SCHEMA_INVALID_CONSTRAINT",
      );

      const invalidDepSchemas = auditInputSchema({
        type: "object",
        dependentSchemas: "not-object",
      });
      expect(invalidDepSchemas.supported).toBe(false);
      expect(invalidDepSchemas.diagnostics[0]?.code).toBe(
        "SCHEMA_INVALID_CONSTRAINT",
      );
    });

    it("audits propertyNames, contains, minContains, maxContains", () => {
      const valid = auditInputSchema({
        type: "array",
        contains: { type: "string" },
        minContains: 1,
        maxContains: 3,
        propertyNames: { pattern: "^[a-z]+$" },
      });
      expect(valid.supported).toBe(true);

      const invalidMinContains = auditInputSchema({
        type: "array",
        minContains: -1,
      });
      expect(invalidMinContains.supported).toBe(false);
      expect(invalidMinContains.diagnostics[0]?.code).toBe(
        "SCHEMA_INVALID_CONSTRAINT",
      );
    });

    it("audits patternProperties (valid, non-object, invalid regex key)", () => {
      const valid = auditInputSchema({
        type: "object",
        patternProperties: {
          "^[a-z]+$": { type: "string" },
        },
      });
      expect(valid.supported).toBe(true);

      const nonObject = auditInputSchema({
        type: "object",
        patternProperties: "not-an-object",
      });
      expect(nonObject.supported).toBe(false);
      expect(nonObject.diagnostics[0]?.code).toBe("SCHEMA_INVALID_PROPERTIES");

      const invalidPattern = auditInputSchema({
        type: "object",
        patternProperties: {
          "(?<=lookbehind)": { type: "string" },
        },
      });
      expect(invalidPattern.supported).toBe(false);
      expect(invalidPattern.diagnostics[0]?.code).toBe(
        "SCHEMA_INVALID_PATTERN",
      );
    });

    it("audits pattern keyword (non-string, length exceeded, invalid regex)", () => {
      const nonString = auditInputSchema({
        type: "string",
        pattern: 12345,
      });
      expect(nonString.supported).toBe(false);
      expect(nonString.diagnostics[0]?.code).toBe("SCHEMA_INVALID_PATTERN");

      const tooLong = auditInputSchema({
        type: "string",
        pattern: "a".repeat(4097),
      });
      expect(tooLong.supported).toBe(false);
      expect(tooLong.diagnostics[0]?.code).toBe("SCHEMA_INVALID_PATTERN");

      const invalidRegex = auditInputSchema({
        type: "string",
        pattern: "(?<=abc)def",
      });
      expect(invalidRegex.supported).toBe(false);
      expect(invalidRegex.diagnostics[0]?.code).toBe("SCHEMA_INVALID_PATTERN");
    });

    it("audits numeric constraints (multipleOf, uniqueItems, format)", () => {
      const invalidMultipleOf = auditInputSchema({
        type: "number",
        multipleOf: 0, // must be > 0
      });
      expect(invalidMultipleOf.supported).toBe(false);
      expect(invalidMultipleOf.diagnostics[0]?.code).toBe(
        "SCHEMA_INVALID_CONSTRAINT",
      );

      const invalidUnique = auditInputSchema({
        type: "array",
        uniqueItems: "not-a-boolean",
      });
      expect(invalidUnique.supported).toBe(false);
      expect(invalidUnique.diagnostics[0]?.code).toBe(
        "SCHEMA_INVALID_CONSTRAINT",
      );

      const invalidFormat = auditInputSchema({
        type: "string",
        format: 1234,
      });
      expect(invalidFormat.supported).toBe(false);
      expect(invalidFormat.diagnostics[0]?.code).toBe(
        "SCHEMA_INVALID_CONSTRAINT",
      );
    });
  });

  describe("Format and pattern utilities", () => {
    it("isAssertedFormat and matchesFormat validate supported formats", () => {
      expect(isAssertedFormat("date-time")).toBe(true);
      expect(isAssertedFormat("ipv4")).toBe(true);
      expect(isAssertedFormat("ipv6")).toBe(true);
      expect(isAssertedFormat("uuid")).toBe(true);
      expect(isAssertedFormat("unknown-custom-format")).toBe(false);

      expect(matchesFormat("date-time", "2026-11-06T00:00:00Z")).toBe(true);
      expect(matchesFormat("date-time", "not-a-date")).toBe(false);

      expect(matchesFormat("date", "2026-11-06")).toBe(true);
      expect(matchesFormat("date", "2026-13-40")).toBe(false);

      expect(matchesFormat("time", "12:30:45Z")).toBe(true);
      expect(matchesFormat("time", "invalid-time")).toBe(false);

      expect(matchesFormat("hostname", "api.example.com")).toBe(true);
      expect(matchesFormat("hostname", "-invalid-.host")).toBe(false);

      expect(matchesFormat("uri", "https://example.com/api")).toBe(true);
      expect(matchesFormat("uri", "not a uri")).toBe(false);

      expect(matchesFormat("custom-unasserted", "any-value")).toBe(true);

      expect(matchesFormat("ipv4", "192.168.1.1")).toBe(true);
      expect(matchesFormat("ipv4", "999.999.999.999")).toBe(false);

      expect(matchesFormat("ipv6", "::1")).toBe(true);
      expect(matchesFormat("ipv6", "not:ipv6")).toBe(false);

      expect(
        matchesFormat("uuid", "123e4567-e89b-12d3-a456-426614174000"),
      ).toBe(true);
      expect(matchesFormat("uuid", "not-a-uuid")).toBe(false);
    });

    it("patternMatches and isValidPattern handle RE2 regex", () => {
      expect(isValidPattern("^[a-z]+$")).toBe(true);
      expect(isValidPattern("(?<=lookbehind)")).toBe(false);

      expect(patternMatches("^[0-9]+$", "12345")).toBe(true);
      expect(patternMatches("^[0-9]+$", "abc")).toBe(false);
    });

    it("stableValueKey and isJsonObject helper utilities", () => {
      expect(isJsonObject({})).toBe(true);
      expect(isJsonObject([])).toBe(false);
      expect(isJsonObject(null)).toBe(false);

      const k1 = stableValueKey({ b: 2, a: 1 });
      const k2 = stableValueKey({ a: 1, b: 2 });
      expect(k1).toBe(k2);

      // cycle in object returns undefined
      const cycleObj: Record<string, unknown> = { a: 1 };
      cycleObj.self = cycleObj;
      expect(stableValueKey(cycleObj)).toBeUndefined();
    });
  });

  describe("validateJsonSchema runtime validations", () => {
    it("validates anyOf constraint", () => {
      const schema = {
        anyOf: [{ type: "string" }, { type: "number" }],
      };
      expect(validateJsonSchema(schema, "hello").valid).toBe(true);
      expect(validateJsonSchema(schema, 42).valid).toBe(true);
      const invalid = validateJsonSchema(schema, true);
      expect(invalid.valid).toBe(false);
      expect(invalid.issues[0]).toContain(
        "must match at least one schema in anyOf",
      );
    });

    it("validates oneOf constraint", () => {
      const schema = {
        oneOf: [
          { type: "number", maximum: 10 },
          { type: "number", minimum: 5 },
        ],
      };
      // 2 matches only first -> valid
      expect(validateJsonSchema(schema, 2).valid).toBe(true);
      // 15 matches only second -> valid
      expect(validateJsonSchema(schema, 15).valid).toBe(true);
      // 7 matches both -> invalid
      const both = validateJsonSchema(schema, 7);
      expect(both.valid).toBe(false);
      expect(both.issues[0]).toContain(
        "must match exactly one schema in oneOf (matched 2)",
      );
    });

    it("validates allOf constraint", () => {
      const schema = {
        allOf: [
          {
            type: "object",
            properties: { a: { type: "string" } },
            required: ["a"],
          },
          {
            type: "object",
            properties: { b: { type: "number" } },
            required: ["b"],
          },
        ],
      };
      expect(validateJsonSchema(schema, { a: "ok", b: 1 }).valid).toBe(true);
      const missingB = validateJsonSchema(schema, { a: "ok" });
      expect(missingB.valid).toBe(false);
    });

    it("validates propertyNames constraint on objects", () => {
      const schema = {
        type: "object",
        propertyNames: { pattern: "^[a-z_]+$" },
      };
      expect(validateJsonSchema(schema, { valid_key: 1 }).valid).toBe(true);
      const invalid = validateJsonSchema(schema, { "INVALID-KEY": 1 });
      expect(invalid.valid).toBe(false);
    });

    it("validates const constraint", () => {
      const schema = { const: "expected-value" };
      expect(validateJsonSchema(schema, "expected-value").valid).toBe(true);
      const invalid = validateJsonSchema(schema, "wrong-value");
      expect(invalid.valid).toBe(false);
      expect(invalid.issues[0]).toContain("must equal the constant value");
    });

    it("validates not constraint", () => {
      const schema = { not: { type: "string" } };
      expect(validateJsonSchema(schema, 123).valid).toBe(true);
      const invalid = validateJsonSchema(schema, "string-not-allowed");
      expect(invalid.valid).toBe(false);
      expect(invalid.issues[0]).toContain("must not match the schema in 'not'");
    });

    it("validates if / then / else conditional logic", () => {
      const schema = {
        if: { properties: { role: { const: "admin" } } },
        then: {
          properties: { adminPin: { type: "string" } },
          required: ["adminPin"],
        },
        else: {
          properties: { userEmail: { type: "string" } },
          required: ["userEmail"],
        },
      };

      // Admin branch passing
      expect(
        validateJsonSchema(schema, { role: "admin", adminPin: "1234" }).valid,
      ).toBe(true);
      // Admin branch missing pin
      expect(validateJsonSchema(schema, { role: "admin" }).valid).toBe(false);

      // User branch passing
      expect(
        validateJsonSchema(schema, { role: "user", userEmail: "a@b.com" })
          .valid,
      ).toBe(true);
      // User branch missing email
      expect(validateJsonSchema(schema, { role: "user" }).valid).toBe(false);
    });

    it("validates dependentRequired and dependentSchemas", () => {
      const schema = {
        type: "object",
        dependentRequired: { creditCard: ["cvv"] },
        dependentSchemas: {
          creditCard: { properties: { cvv: { type: "string", minLength: 3 } } },
        },
      };

      expect(validateJsonSchema(schema, { other: "field" }).valid).toBe(true);
      expect(
        validateJsonSchema(schema, { creditCard: "1234", cvv: "999" }).valid,
      ).toBe(true);

      const missingDep = validateJsonSchema(schema, { creditCard: "1234" });
      expect(missingDep.valid).toBe(false);
      expect(missingDep.issues[0]).toContain(
        "is required when 'creditCard' is present",
      );

      const invalidSubschema = validateJsonSchema(schema, {
        creditCard: "1234",
        cvv: "9",
      });
      expect(invalidSubschema.valid).toBe(false);
    });

    it("validates contains, minContains, and maxContains in array", () => {
      const schema = {
        type: "array",
        contains: { type: "number" },
        minContains: 1,
        maxContains: 2,
      };

      expect(validateJsonSchema(schema, ["a", 1, "b"]).valid).toBe(true);
      expect(validateJsonSchema(schema, [1, 2]).valid).toBe(true);

      // 0 numbers -> invalid
      expect(validateJsonSchema(schema, ["a", "b"]).valid).toBe(false);
      // 3 numbers -> exceeds maxContains
      expect(validateJsonSchema(schema, [1, 2, 3]).valid).toBe(false);
    });
  });
});

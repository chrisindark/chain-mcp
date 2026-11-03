import {
  DeclarativeDescriptorError,
  type DeclarativeAuthScheme,
  type DeclarativeAuthSchemeMap,
} from "./types.js";

const SCHEME_NAME = /^[A-Za-z0-9_.-]{1,64}$/;
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const MAX_PARAMETER_NAME_LENGTH = 64;
const RESERVED_KEYS = new Set(["__proto__", "prototype", "constructor"]);

/**
 * Validates a deployment-supplied scheme map. The map describes credential
 * *shape* only and must never contain credential values. Unreferenced entries
 * are validated too, so a typo cannot hide until a descriptor is published.
 */
export function normalizeAuthSchemeMap(
  input: unknown,
): DeclarativeAuthSchemeMap {
  if (input === undefined) return Object.freeze({});
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new DeclarativeDescriptorError(
      "AUTH_SCHEME_INVALID",
      "Auth scheme map must be a plain object",
    );
  }
  const output: Record<string, DeclarativeAuthScheme> = Object.create(null);
  for (const [name, value] of Object.entries(input)) {
    if (!SCHEME_NAME.test(name) || RESERVED_KEYS.has(name)) {
      throw new DeclarativeDescriptorError(
        "AUTH_SCHEME_INVALID",
        `Auth scheme name '${name}' is invalid`,
      );
    }
    output[name] = normalizeScheme(name, value);
  }
  return Object.freeze(output);
}

function normalizeScheme(name: string, value: unknown): DeclarativeAuthScheme {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw schemeError(name, "must be an object");
  }
  const record = value as Record<string, unknown>;
  const type = record.type;
  if (type === "apiKey") {
    assertKeys(name, record, ["type", "parameterName", "parameterLocation"]);
    const parameterName = record.parameterName;
    const parameterLocation = record.parameterLocation;
    if (
      parameterLocation !== "query" &&
      parameterLocation !== "header" &&
      parameterLocation !== "cookie"
    ) {
      throw schemeError(
        name,
        "apiKey schemes require parameterLocation 'query', 'header', or 'cookie'",
      );
    }
    if (typeof parameterName !== "string") {
      throw schemeError(name, "apiKey schemes require a parameterName");
    }
    if (parameterLocation === "header") {
      if (
        !HEADER_NAME.test(parameterName) ||
        RESERVED_KEYS.has(parameterName)
      ) {
        throw schemeError(name, "apiKey parameterName is not a valid header");
      }
    } else if (!isSafeParameterName(parameterName)) {
      throw schemeError(
        name,
        `apiKey parameterName is not a valid ${parameterLocation} name`,
      );
    }
    return {
      type: "apiKey",
      parameterName,
      parameterLocation,
    };
  }
  if (type === "http") {
    assertKeys(name, record, ["type", "httpScheme", "bearerFormat"]);
    const httpScheme = record.httpScheme;
    if (httpScheme !== "basic" && httpScheme !== "bearer") {
      throw schemeError(
        name,
        "http schemes require httpScheme 'basic' or 'bearer'",
      );
    }
    if (record.bearerFormat !== undefined) {
      if (
        typeof record.bearerFormat !== "string" ||
        record.bearerFormat.trim().length === 0 ||
        record.bearerFormat.length > 64
      ) {
        throw schemeError(
          name,
          "bearerFormat must be a short non-empty string",
        );
      }
      if (httpScheme !== "bearer") {
        throw schemeError(name, "bearerFormat applies only to bearer schemes");
      }
    }
    return {
      type: "http",
      httpScheme,
      ...(record.bearerFormat === undefined
        ? {}
        : { bearerFormat: record.bearerFormat }),
    };
  }
  if (type === "oauth2") {
    assertKeys(name, record, ["type"]);
    return { type: "oauth2" };
  }
  throw schemeError(name, "type must be 'apiKey', 'http', or 'oauth2'");
}

function assertKeys(
  name: string,
  record: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const permitted = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (!permitted.has(key)) {
      throw schemeError(name, `contains unknown property '${key}'`);
    }
  }
}

function isSafeParameterName(value: string): boolean {
  if (value.length === 0 || value.length > MAX_PARAMETER_NAME_LENGTH) {
    return false;
  }
  if (RESERVED_KEYS.has(value)) return false;
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x20 || code === 0x7f) return false;
    if (
      character === "&" ||
      character === "=" ||
      character === ";" ||
      character === "," ||
      character === "#" ||
      character === "?" ||
      character === "/"
    ) {
      return false;
    }
  }
  return true;
}

function schemeError(name: string, detail: string): DeclarativeDescriptorError {
  return new DeclarativeDescriptorError(
    "AUTH_SCHEME_INVALID",
    `Auth scheme '${name}' ${detail}`,
  );
}

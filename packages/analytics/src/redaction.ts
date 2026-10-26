export const DEFAULT_SENSITIVE_KEYS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "apikey",
  "password",
  "passwd",
  "secret",
  "token",
  "access_token",
  "refresh_token",
  "client_secret",
  "private_key",
  "proxy-authorization",
  "credential",
  "credentials",
]);

export const DEFAULT_BODY_KEYS = new Set([
  "body",
  "rawbody",
  "requestbody",
  "responsebody",
  "payload",
]);

const BEARER_REGEX = /Bearer\s+[a-zA-Z0-9._~+/=-]+/gi;
const BASIC_REGEX = /Basic\s+[a-zA-Z0-9+/=]+/gi;
const JWT_REGEX =
  /eyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g;

export const REDACTED_MARKER = "[REDACTED]";
export const EXCLUDED_BODY_MARKER = "[EXCLUDED_BODY]";

export interface RedactionOptions {
  /** Additional case-insensitive keys to redact. */
  additionalSensitiveKeys?: readonly string[];
  /**
   * If true, allows request and response bodies to be included in output (still redacted for secrets).
   * Defaults to false: body keys are excluded.
   */
  includeBodies?: boolean;
  /** Maximum recursion depth for object redaction. Defaults to 8. */
  maxDepth?: number;
}

export function redactString(input: string): string {
  if (typeof input !== "string" || input.length === 0) return input;
  let out = input.replace(BEARER_REGEX, `Bearer ${REDACTED_MARKER}`);
  out = out.replace(BASIC_REGEX, `Basic ${REDACTED_MARKER}`);
  out = out.replace(JWT_REGEX, REDACTED_MARKER);
  return out;
}

export function redactValue(
  value: unknown,
  options?: RedactionOptions,
): unknown {
  const sensitiveKeys = new Set(DEFAULT_SENSITIVE_KEYS);
  if (options?.additionalSensitiveKeys) {
    for (const k of options.additionalSensitiveKeys) {
      sensitiveKeys.add(k.toLowerCase());
    }
  }

  const includeBodies = options?.includeBodies ?? false;
  const maxDepth = Math.max(1, options?.maxDepth ?? 8);
  const seen = new Set<object>();

  function walk(val: unknown, depth: number): unknown {
    if (depth > maxDepth) {
      return "[MAX_DEPTH_REACHED]";
    }

    if (val === null || val === undefined) return val;

    if (typeof val === "string") {
      return redactString(val);
    }

    if (
      typeof val === "number" ||
      typeof val === "boolean" ||
      typeof val === "bigint"
    ) {
      return val;
    }

    if (typeof val === "object") {
      if (seen.has(val)) {
        return "[CIRCULAR]";
      }
      seen.add(val);

      try {
        if (Array.isArray(val)) {
          return val.map((item) => walk(item, depth + 1));
        }

        const out: Record<string, unknown> = {};
        const record = val as Record<string, unknown>;

        for (const [key, propVal] of Object.entries(record)) {
          const lowerKey = key.toLowerCase();

          if (
            lowerKey === "__proto__" ||
            lowerKey === "prototype" ||
            lowerKey === "constructor"
          ) {
            continue;
          }

          if (sensitiveKeys.has(lowerKey)) {
            out[key] = REDACTED_MARKER;
            continue;
          }

          if (!includeBodies && DEFAULT_BODY_KEYS.has(lowerKey)) {
            out[key] = EXCLUDED_BODY_MARKER;
            continue;
          }

          out[key] = walk(propVal, depth + 1);
        }

        return out;
      } finally {
        seen.delete(val);
      }
    }

    return String(val);
  }

  return walk(value, 1);
}

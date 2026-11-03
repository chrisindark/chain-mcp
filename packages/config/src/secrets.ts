/**
 * Credential-source support for configuration files.
 *
 * ChainMcp uses a single, explicit mechanism instead of shipping multiple
 * implicit ones: designated secret fields accept `${VAR}` and
 * `${VAR:-default}` environment references. Non-secret fields are never
 * interpolated, so a typo in a hostname or tool name cannot silently read from
 * the process environment.
 *
 * Only fields that hold credentials are candidates:
 *
 * - `auth.inbound.tokens` and `auth.inbound.apiKeys` record keys
 * - `auth.inbound.jwt.secret`
 * - `auth.upstream.providers[].credentials.*` for `static` providers
 * - `auth.upstream.providers[].clientSecret` for `oauth` providers
 * - `auth.upstream.providers[].keys.*` for `secretStore` providers
 * - `cache.redis.url`, `rateLimit.redis.url`, and their `redis.tls.key`
 *
 * Interpolation is not recursive: a resolved value that itself contains
 * `${...}` is used verbatim.
 */

const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type SecretResolutionFailure = "missing-variable" | "invalid-template";

/**
 * Raised when a designated secret field cannot be resolved. The message names
 * the field and (when applicable) the environment variable, but never includes
 * a resolved or literal secret value.
 */
export class SecretResolutionError extends Error {
  readonly code = "SECRET_UNRESOLVED";
  readonly field: string;
  readonly failure: SecretResolutionFailure;
  readonly variable: string | undefined;

  constructor(
    field: string,
    failure: SecretResolutionFailure,
    variable?: string,
  ) {
    super(buildMessage(field, failure, variable));
    this.name = "SecretResolutionError";
    this.field = field;
    this.failure = failure;
    this.variable = variable;
  }
}

function buildMessage(
  field: string,
  failure: SecretResolutionFailure,
  variable: string | undefined,
): string {
  if (failure === "missing-variable") {
    const name = variable ?? "(unknown)";
    return `Secret field "${field}" references environment variable "${name}", which is not set and has no default. Set ${name} or use \${${name}:-<default>}.`;
  }
  return `Secret field "${field}" contains an invalid secret reference. Only \${VAR} and \${VAR:-default} are supported, where VAR is a valid environment variable name.`;
}

/** Where the value of one designated secret field came from. */
export interface SecretResolutionSource {
  /** Stable, value-free path such as `auth.inbound.tokens[#1]`. */
  readonly field: string;
  /** Environment variables referenced by the field, in order. Empty when literal. */
  readonly variables: readonly string[];
  /** True when at least one reference used the `${VAR:-default}` form. */
  readonly usesDefault: boolean;
  /** True when the configured value contained no environment reference. */
  readonly literal: boolean;
}

export interface ResolvedConfigSecrets<T = unknown> {
  /** Deep copy of the input with designated secret fields resolved. */
  readonly config: T;
  readonly sources: readonly SecretResolutionSource[];
}

export interface ResolveConfigSecretsOptions {
  /** Environment source. Defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/**
 * Resolve `${VAR}` / `${VAR:-default}` references in designated secret fields.
 *
 * Throws {@link SecretResolutionError} when a referenced variable is unset and
 * has no default, or when a reference is malformed. The returned `config` is a
 * separate value; the input is never mutated.
 */
export function resolveConfigSecrets<T = unknown>(
  input: T,
  options?: ResolveConfigSecretsOptions,
): ResolvedConfigSecrets<T> {
  const env = options?.env ?? process.env;
  const config = cloneValue(input);
  const sources: SecretResolutionSource[] = [];

  for (const target of collectSecretTargets(config)) {
    const expanded = expandSecret(target.value, target.field, env);
    if (!expanded.literal) {
      target.write(expanded.value);
    }
    sources.push({
      field: target.field,
      variables: expanded.variables,
      usesDefault: expanded.usesDefault,
      literal: expanded.literal,
    });
  }

  return { config, sources };
}

/**
 * Return a deep copy of the input with every designated secret field replaced
 * by a redaction placeholder. Safe to print, log, or serialize.
 */
export function redactConfigSecrets<T = unknown>(input: T): T {
  const config = cloneValue(input);
  let index = 0;

  for (const target of collectSecretTargets(config)) {
    index += 1;
    target.write(
      target.kind === "map-key" ? `[REDACTED:${index}]` : "[REDACTED]",
    );
  }

  return config;
}

interface SecretTarget {
  readonly field: string;
  readonly kind: "value" | "map-key";
  readonly value: string;
  write(next: string): void;
}

interface ExpandedSecret {
  readonly value: string;
  readonly variables: readonly string[];
  readonly usesDefault: boolean;
  readonly literal: boolean;
}

function expandSecret(
  raw: string,
  field: string,
  env: Readonly<Record<string, string | undefined>>,
): ExpandedSecret {
  if (!raw.includes("${")) {
    return { value: raw, variables: [], usesDefault: false, literal: true };
  }

  let result = "";
  let index = 0;
  const variables: string[] = [];
  let usesDefault = false;

  while (index < raw.length) {
    const start = raw.indexOf("${", index);
    if (start === -1) {
      result += raw.slice(index);
      break;
    }

    result += raw.slice(index, start);

    const end = raw.indexOf("}", start + 2);
    if (end === -1) {
      throw new SecretResolutionError(field, "invalid-template");
    }

    const expression = raw.slice(start + 2, end);
    const separator = expression.indexOf(":-");
    const variable =
      separator === -1 ? expression : expression.slice(0, separator);
    const defaultValue =
      separator === -1 ? undefined : expression.slice(separator + 2);

    if (!VARIABLE_NAME.test(variable)) {
      throw new SecretResolutionError(field, "invalid-template");
    }

    variables.push(variable);

    const envValue = env[variable];
    if (envValue !== undefined && envValue.length > 0) {
      result += envValue;
    } else if (defaultValue !== undefined) {
      usesDefault = true;
      result += defaultValue;
    } else {
      throw new SecretResolutionError(field, "missing-variable", variable);
    }

    index = end + 1;
  }

  return { value: result, variables, usesDefault, literal: false };
}

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function addStringTarget(
  targets: SecretTarget[],
  container: Record<string, unknown>,
  key: string,
  field: string,
): void {
  const value = container[key];
  if (typeof value !== "string") {
    return;
  }
  targets.push({
    field,
    kind: "value",
    value,
    write(next) {
      container[key] = next;
    },
  });
}

function addRecordKeyTargets(
  targets: SecretTarget[],
  container: Record<string, unknown>,
  key: string,
  field: string,
): void {
  const record = asRecord(container[key]);
  if (!record) {
    return;
  }

  Object.entries(record).forEach(([entryKey, entryValue], index) => {
    targets.push({
      field: `${field}[#${index + 1}]`,
      kind: "map-key",
      value: entryKey,
      write(next) {
        if (next === entryKey) {
          return;
        }
        delete record[entryKey];
        record[next] = entryValue;
      },
    });
  });
}

function collectStaticCredentialTargets(
  targets: SecretTarget[],
  credentials: Record<string, unknown>,
  baseField: string,
): void {
  for (const [name, credential] of Object.entries(credentials)) {
    const field = `${baseField}.${name}`;

    if (typeof credential === "string") {
      targets.push({
        field,
        kind: "value",
        value: credential,
        write(next) {
          credentials[name] = next;
        },
      });
      continue;
    }

    if (!isRecord(credential)) {
      continue;
    }

    switch (credential.type) {
      case "apiKey": {
        addStringTarget(targets, credential, "value", `${field}.value`);
        break;
      }
      case "http": {
        if (credential.scheme === "bearer") {
          addStringTarget(targets, credential, "token", `${field}.token`);
        } else if (credential.scheme === "basic") {
          addStringTarget(targets, credential, "username", `${field}.username`);
          addStringTarget(targets, credential, "password", `${field}.password`);
        }
        break;
      }
      case "oauth2": {
        addStringTarget(targets, credential, "token", `${field}.token`);
        break;
      }
      default: {
        break;
      }
    }
  }
}

function collectProviderTargets(
  targets: SecretTarget[],
  providers: readonly unknown[],
): void {
  providers.forEach((provider, index) => {
    if (!isRecord(provider)) {
      return;
    }

    const base = `auth.upstream.providers[${index}]`;

    switch (provider.type) {
      case "static": {
        const credentials = asRecord(provider.credentials);
        if (credentials) {
          collectStaticCredentialTargets(targets, credentials, base);
        }
        break;
      }
      case "secretStore": {
        const keys = asRecord(provider.keys);
        if (keys) {
          for (const [name, value] of Object.entries(keys)) {
            if (typeof value !== "string") {
              continue;
            }
            targets.push({
              field: `${base}.keys.${name}`,
              kind: "value",
              value,
              write(next) {
                keys[name] = next;
              },
            });
          }
        }
        break;
      }
      case "oauth": {
        addStringTarget(
          targets,
          provider,
          "clientSecret",
          `${base}.clientSecret`,
        );
        break;
      }
      default: {
        break;
      }
    }
  });
}

function collectRedisTargets(
  targets: SecretTarget[],
  section: Record<string, unknown> | undefined,
  base: string,
): void {
  if (!section) {
    return;
  }

  const redis = asRecord(section.redis);
  if (!redis) {
    return;
  }

  addStringTarget(targets, redis, "url", `${base}.redis.url`);

  const tls = asRecord(redis.tls);
  if (tls) {
    addStringTarget(targets, tls, "key", `${base}.redis.tls.key`);
  }
}

function collectSecretTargets(root: unknown): SecretTarget[] {
  const targets: SecretTarget[] = [];
  const record = asRecord(root);
  if (!record) {
    return targets;
  }

  const auth = asRecord(record.auth);
  const inbound = asRecord(auth?.inbound);
  if (inbound) {
    addRecordKeyTargets(targets, inbound, "tokens", "auth.inbound.tokens");
    addRecordKeyTargets(targets, inbound, "apiKeys", "auth.inbound.apiKeys");

    const jwt = asRecord(inbound.jwt);
    if (jwt) {
      addStringTarget(targets, jwt, "secret", "auth.inbound.jwt.secret");
    }
  }

  const upstream = asRecord(auth?.upstream);
  if (upstream && Array.isArray(upstream.providers)) {
    collectProviderTargets(targets, upstream.providers);
  }

  collectRedisTargets(targets, asRecord(record.cache), "cache");
  collectRedisTargets(targets, asRecord(record.rateLimit), "rateLimit");

  return targets;
}

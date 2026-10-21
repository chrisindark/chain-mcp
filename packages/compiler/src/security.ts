import { isPlainObject } from "./document.js";
import type {
  CompileDiagnostic,
  CompiledAuthenticationAlternative,
  CompiledAuthenticationPolicy,
  CompiledAuthenticationScheme,
  CompiledSecurityScheme,
  OpenApiVersion,
  SecurityRequirement,
  SecuritySchemeType,
} from "./types.js";

const API_KEY_LOCATIONS = new Set(["query", "header", "cookie"]);

export function parseSecuritySchemes(
  document: Record<string, unknown>,
  version: OpenApiVersion,
  diagnostics: CompileDiagnostic[],
): Readonly<Record<string, CompiledSecurityScheme>> {
  const components = document.components;
  if (components === undefined) return {};
  if (!isPlainObject(components)) {
    diagnostics.push({
      severity: "error",
      code: "DOCUMENT_INVALID",
      message: "OpenAPI 'components' must be an object",
      location: "#/components",
    });
    return {};
  }
  const rawSchemes = components.securitySchemes;
  if (rawSchemes === undefined) return {};
  if (!isPlainObject(rawSchemes)) {
    diagnostics.push({
      severity: "error",
      code: "DOCUMENT_INVALID",
      message: "OpenAPI 'components.securitySchemes' must be an object",
      location: "#/components/securitySchemes",
    });
    return {};
  }

  const schemeEntries: Array<[string, CompiledSecurityScheme]> = [];
  for (const [name, raw] of Object.entries(rawSchemes)) {
    const location = `#/components/securitySchemes/${name}`;
    if (name.trim().length === 0) {
      diagnostics.push({
        severity: "error",
        code: "SECURITY_SCHEME_INVALID",
        message: "Security scheme names must be non-empty",
        location,
      });
      continue;
    }
    if (!isPlainObject(raw)) {
      diagnostics.push({
        severity: "error",
        code: "SECURITY_SCHEME_INVALID",
        message: `Security scheme '${name}' must be an object`,
        location,
      });
      continue;
    }
    const type = raw.type;
    const allowedTypes: readonly SecuritySchemeType[] =
      version === "3.1"
        ? ["apiKey", "http", "oauth2", "openIdConnect", "mutualTLS"]
        : ["apiKey", "http", "oauth2", "openIdConnect"];
    if (
      typeof type !== "string" ||
      !allowedTypes.includes(type as SecuritySchemeType)
    ) {
      diagnostics.push({
        severity: "error",
        code: "SECURITY_SCHEME_INVALID",
        message: `Security scheme '${name}' has unsupported type '${String(type)}' for OpenAPI ${version}`,
        location,
      });
      continue;
    }

    const scheme: {
      name: string;
      type: SecuritySchemeType;
      description?: string;
      parameterName?: string;
      parameterLocation?: "query" | "header" | "cookie";
      scheme?: string;
      bearerFormat?: string;
      openIdConnectUrl?: string;
      flows?: Readonly<Record<string, unknown>>;
    } = { name, type: type as SecuritySchemeType };

    if (raw.description !== undefined) {
      if (typeof raw.description !== "string") {
        diagnostics.push({
          severity: "error",
          code: "SECURITY_SCHEME_INVALID",
          message: `Security scheme '${name}' description must be a string`,
          location,
        });
      } else {
        scheme.description = raw.description;
      }
    }

    if (type === "apiKey") {
      if (typeof raw.name !== "string" || raw.name.trim().length === 0) {
        diagnostics.push({
          severity: "error",
          code: "SECURITY_SCHEME_INVALID",
          message: `apiKey scheme '${name}' requires a non-empty name`,
          location,
        });
        continue;
      }
      if (typeof raw.in !== "string" || !API_KEY_LOCATIONS.has(raw.in)) {
        diagnostics.push({
          severity: "error",
          code: "SECURITY_SCHEME_INVALID",
          message: `apiKey scheme '${name}' requires 'in' to be query, header, or cookie`,
          location,
        });
        continue;
      }
      scheme.parameterName = raw.name;
      scheme.parameterLocation = raw.in as "query" | "header" | "cookie";
    } else if (type === "http") {
      if (typeof raw.scheme !== "string" || raw.scheme.trim().length === 0) {
        diagnostics.push({
          severity: "error",
          code: "SECURITY_SCHEME_INVALID",
          message: `http scheme '${name}' requires a non-empty scheme`,
          location,
        });
        continue;
      }
      scheme.scheme = raw.scheme;
      if (raw.bearerFormat !== undefined) {
        if (typeof raw.bearerFormat !== "string") {
          diagnostics.push({
            severity: "error",
            code: "SECURITY_SCHEME_INVALID",
            message: `http scheme '${name}' bearerFormat must be a string`,
            location,
          });
        } else {
          scheme.bearerFormat = raw.bearerFormat;
        }
      }
    } else if (type === "oauth2") {
      if (!isPlainObject(raw.flows) || Object.keys(raw.flows).length === 0) {
        diagnostics.push({
          severity: "error",
          code: "SECURITY_SCHEME_INVALID",
          message: `oauth2 scheme '${name}' requires a non-empty flows object`,
          location,
        });
        continue;
      }
      for (const [flowName, flow] of Object.entries(raw.flows)) {
        if (!isPlainObject(flow) || !isPlainObject(flow.scopes)) {
          diagnostics.push({
            severity: "error",
            code: "SECURITY_SCHEME_INVALID",
            message: `oauth2 scheme '${name}' flow '${flowName}' requires a scopes object`,
            location,
          });
          continue;
        }
      }
      scheme.flows = raw.flows;
    } else if (type === "openIdConnect") {
      if (
        typeof raw.openIdConnectUrl !== "string" ||
        raw.openIdConnectUrl.trim().length === 0
      ) {
        diagnostics.push({
          severity: "error",
          code: "SECURITY_SCHEME_INVALID",
          message: `openIdConnect scheme '${name}' requires a non-empty openIdConnectUrl`,
          location,
        });
        continue;
      }
      scheme.openIdConnectUrl = raw.openIdConnectUrl;
    }

    schemeEntries.push([name, scheme]);
  }
  // Object.fromEntries defines own data properties, so a scheme named
  // `__proto__` cannot mutate the result's prototype.
  return Object.fromEntries(schemeEntries);
}

export function parseSecurityRequirements(
  value: unknown,
  schemes: Readonly<Record<string, CompiledSecurityScheme>>,
  diagnostics: CompileDiagnostic[],
  location: string,
): readonly SecurityRequirement[] | undefined {
  if (!Array.isArray(value)) {
    diagnostics.push({
      severity: "error",
      code: "SECURITY_INVALID",
      message: "Security requirements must be an array",
      location,
    });
    return undefined;
  }
  const requirements: SecurityRequirement[] = [];
  for (const [index, raw] of value.entries()) {
    const itemLocation = `${location}/${index}`;
    if (!isPlainObject(raw)) {
      diagnostics.push({
        severity: "error",
        code: "SECURITY_INVALID",
        message: "Each security requirement must be an object",
        location: itemLocation,
      });
      return undefined;
    }
    const requirementEntries: Array<[string, readonly string[]]> = [];
    for (const [name, scopes] of Object.entries(raw)) {
      if (!Object.hasOwn(schemes, name)) {
        diagnostics.push({
          severity: "error",
          code: "SECURITY_INVALID",
          message: `Security requirement references unknown scheme '${name}'`,
          location: itemLocation,
        });
        return undefined;
      }
      if (
        !Array.isArray(scopes) ||
        !scopes.every((scope) => typeof scope === "string")
      ) {
        diagnostics.push({
          severity: "error",
          code: "SECURITY_INVALID",
          message: `Security requirement scopes for '${name}' must be an array of strings`,
          location: itemLocation,
        });
        return undefined;
      }
      requirementEntries.push([name, scopes]);
    }
    requirements.push(
      Object.freeze(
        Object.fromEntries(requirementEntries),
      ) as SecurityRequirement,
    );
  }
  return Object.freeze(requirements);
}

/**
 * Builds an explicit OR/AND policy from validated requirements. Each array
 * element is an OR alternative; schemes inside one element are ANDed. An empty
 * requirement object is preserved as an anonymous alternative rather than
 * dropped.
 */
export function buildAuthenticationPolicy(
  requirements: readonly SecurityRequirement[],
  schemes: Readonly<Record<string, CompiledSecurityScheme>>,
  strict: boolean,
  diagnostics: CompileDiagnostic[],
  location: string,
): CompiledAuthenticationPolicy | undefined {
  const alternatives: CompiledAuthenticationAlternative[] = [];

  for (const [index, requirement] of requirements.entries()) {
    const alternativeLocation = `${location}/${index}`;
    const policySchemes: CompiledAuthenticationScheme[] = [];
    for (const name of Object.keys(requirement).sort(compareCodeUnits)) {
      const scheme = schemes[name];
      if (scheme === undefined) {
        // parseSecurityRequirements rejects unknown names; keep this guard so
        // a future caller cannot produce a policy that silently drops one.
        diagnostics.push({
          severity: "error",
          code: "SECURITY_INVALID",
          message: `Security requirement references unknown scheme '${name}'`,
          location: alternativeLocation,
        });
        return undefined;
      }
      const scopes = [...new Set(requirement[name] ?? [])].sort(
        compareCodeUnits,
      );

      if (scheme.type === "oauth2") {
        const declared = collectOAuth2Scopes(scheme);
        const undeclared = scopes.filter((scope) => !declared.has(scope));
        if (undeclared.length > 0) {
          diagnostics.push({
            severity: strict ? "error" : "warning",
            code: "SECURITY_REQUIREMENT_INVALID",
            message: `Security requirement for oauth2 scheme '${name}' uses undeclared scopes: ${undeclared.join(", ")}`,
            location: alternativeLocation,
          });
          if (strict) return undefined;
        }
      } else if (scheme.type !== "openIdConnect" && scopes.length > 0) {
        // OpenAPI only defines requirement scopes for oauth2 and
        // openIdConnect; accepting them for apiKey/http/mutualTLS would
        // imply a scope check that cannot exist.
        diagnostics.push({
          severity: "error",
          code: "SECURITY_REQUIREMENT_INVALID",
          message: `Security scheme '${name}' of type '${scheme.type}' must not declare scopes`,
          location: alternativeLocation,
        });
        return undefined;
      }

      policySchemes.push(toPolicyScheme(scheme, scopes));
    }
    alternatives.push({ schemes: policySchemes });
  }

  return {
    alternatives,
    allowsAnonymous:
      alternatives.length === 0 ||
      alternatives.some((alternative) => alternative.schemes.length === 0),
  };
}

function collectOAuth2Scopes(
  scheme: CompiledSecurityScheme,
): ReadonlySet<string> {
  const scopes = new Set<string>();
  if (scheme.flows === undefined) return scopes;
  for (const flow of Object.values(scheme.flows)) {
    if (!isPlainObject(flow) || !isPlainObject(flow.scopes)) continue;
    for (const scope of Object.keys(flow.scopes)) scopes.add(scope);
  }
  return scopes;
}

function toPolicyScheme(
  scheme: CompiledSecurityScheme,
  scopes: readonly string[],
): CompiledAuthenticationScheme {
  return {
    name: scheme.name,
    type: scheme.type,
    scopes,
    ...(scheme.parameterName === undefined
      ? {}
      : { parameterName: scheme.parameterName }),
    ...(scheme.parameterLocation === undefined
      ? {}
      : { parameterLocation: scheme.parameterLocation }),
    ...(scheme.scheme === undefined ? {} : { httpScheme: scheme.scheme }),
    ...(scheme.bearerFormat === undefined
      ? {}
      : { bearerFormat: scheme.bearerFormat }),
    ...(scheme.openIdConnectUrl === undefined
      ? {}
      : { openIdConnectUrl: scheme.openIdConnectUrl }),
    ...(scheme.flows === undefined ? {} : { flows: scheme.flows }),
  };
}

/** Locale-independent ordering so policy output is identical on every host. */
function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

import { isPlainObject } from "./document.js";
import type {
  CompileDiagnostic,
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

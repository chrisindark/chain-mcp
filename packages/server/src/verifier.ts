import { timingSafeEqual, createHmac, createVerify } from "node:crypto";
import type { ToolContext } from "@chainmcp/core";
import type { AuthInfo } from "@modelcontextprotocol/server";

export interface InboundAuthResult {
  context: ToolContext;
  authInfo?: AuthInfo | undefined;
}

export interface InboundAuthRequest {
  headers: Record<string, string | string[] | undefined>;
  url?: URL | undefined;
  method?: string | undefined;
}

export interface InboundAuthVerifier {
  readonly headerNames?: readonly string[] | undefined;
  verify(
    request: InboundAuthRequest,
  ): Promise<InboundAuthResult | undefined> | InboundAuthResult | undefined;
}

export interface InboundPrincipalConfig {
  tenantId: string;
  principalId: string;
  scopes?: string[] | undefined;
}

export interface BearerTokenVerifierOptions {
  tokens?: Record<string, InboundPrincipalConfig> | undefined;
  verifyToken?: (
    token: string,
  ) =>
    | Promise<InboundPrincipalConfig | undefined>
    | InboundPrincipalConfig
    | undefined;
}

/**
 * Validates that a candidate principal has the required non-empty tenant and principal
 * identifiers, and optional string array scopes. Returns undefined if validation fails.
 */
function validatePrincipal(
  principal: unknown,
): InboundPrincipalConfig | undefined {
  if (!principal || typeof principal !== "object" || Array.isArray(principal)) {
    return undefined;
  }
  const candidate = principal as Record<string, unknown>;
  if (
    typeof candidate.tenantId !== "string" ||
    candidate.tenantId.trim().length === 0
  ) {
    return undefined;
  }
  if (
    typeof candidate.principalId !== "string" ||
    candidate.principalId.trim().length === 0
  ) {
    return undefined;
  }
  let scopes: string[] | undefined;
  if (candidate.scopes !== undefined) {
    if (!Array.isArray(candidate.scopes)) {
      return undefined;
    }
    for (const scope of candidate.scopes) {
      if (typeof scope !== "string") {
        return undefined;
      }
    }
    scopes = candidate.scopes as string[];
  }
  return {
    tenantId: candidate.tenantId,
    principalId: candidate.principalId,
    scopes,
  };
}

/**
 * Creates an inbound verifier that parses `Authorization: Bearer <token>`
 * and maps the token to a ToolContext and AuthInfo.
 */
export function createBearerTokenVerifier(
  options: BearerTokenVerifierOptions,
): InboundAuthVerifier {
  return {
    headerNames: ["Authorization"],
    async verify(request) {
      const authHeader = getHeader(request.headers, "authorization");
      if (typeof authHeader !== "string" || !authHeader.startsWith("Bearer ")) {
        return undefined;
      }
      const token = authHeader.slice(7).trim();
      if (!token) return undefined;

      let matchedRaw: unknown;
      if (options.tokens && Object.hasOwn(options.tokens, token)) {
        matchedRaw = options.tokens[token];
      } else if (options.verifyToken) {
        matchedRaw = await options.verifyToken(token);
      }

      const matched = validatePrincipal(matchedRaw);
      if (!matched) return undefined;

      const scopes = matched.scopes ?? [];
      const context: ToolContext = {
        requestId: `inbound-${Date.now()}`,
        tenantId: matched.tenantId,
        principal: {
          id: matched.principalId,
          scopes,
        },
      };

      const authInfo: AuthInfo = {
        token,
        clientId: matched.principalId,
        scopes,
        extra: {
          tenantId: matched.tenantId,
          principalId: matched.principalId,
        },
      };

      return { context, authInfo };
    },
  };
}

export interface ApiKeyVerifierOptions {
  headerName?: string | undefined; // defaults to 'x-api-key'
  keys?: Record<string, InboundPrincipalConfig> | undefined;
  verifyKey?: (
    key: string,
  ) =>
    | Promise<InboundPrincipalConfig | undefined>
    | InboundPrincipalConfig
    | undefined;
}

/**
 * Creates an inbound verifier that inspects an API key header (e.g. `X-API-Key`)
 * and maps the key to a ToolContext and AuthInfo.
 */
export function createApiKeyVerifier(
  options: ApiKeyVerifierOptions,
): InboundAuthVerifier {
  const customHeader = options.headerName ?? "X-API-Key";
  const headerName = customHeader.toLowerCase();

  return {
    headerNames: [customHeader],
    async verify(request) {
      const apiKey = getHeader(request.headers, headerName);
      if (typeof apiKey !== "string") {
        return undefined;
      }
      const key = apiKey.trim();
      if (!key) {
        return undefined;
      }

      let matchedRaw: unknown;
      if (options.keys && Object.hasOwn(options.keys, key)) {
        matchedRaw = options.keys[key];
      } else if (options.verifyKey) {
        matchedRaw = await options.verifyKey(key);
      }

      const matched = validatePrincipal(matchedRaw);
      if (!matched) return undefined;

      const scopes = matched.scopes ?? [];
      const context: ToolContext = {
        requestId: `inbound-${Date.now()}`,
        tenantId: matched.tenantId,
        principal: {
          id: matched.principalId,
          scopes,
        },
      };

      const authInfo: AuthInfo = {
        token: key,
        clientId: matched.principalId,
        scopes,
        extra: {
          tenantId: matched.tenantId,
          principalId: matched.principalId,
        },
      };

      return { context, authInfo };
    },
  };
}

export interface JwtVerifierOptions {
  secret?: string | Buffer | undefined;
  publicKey?: string | Buffer | undefined;
  issuer?: string | undefined;
  audience?: string | undefined;
  clockToleranceSeconds?: number | undefined;
  mapClaims?: (
    payload: Record<string, unknown>,
  ) =>
    | Promise<InboundPrincipalConfig | undefined>
    | InboundPrincipalConfig
    | undefined;
}

/**
 * Creates an inbound verifier that validates signed JSON Web Tokens (HS256, RS256, ES256)
 * from `Authorization: Bearer <jwt>` without external dependencies.
 */
export function createJwtVerifier(
  options: JwtVerifierOptions,
): InboundAuthVerifier {
  const tolerance = options.clockToleranceSeconds ?? 30;

  return {
    headerNames: ["Authorization"],
    async verify(request) {
      const authHeader = getHeader(request.headers, "authorization");
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return undefined;
      }
      const token = authHeader.slice(7).trim();
      if (!token) return undefined;

      const parts = token.split(".");
      if (parts.length !== 3) return undefined;

      let header: Record<string, unknown>;
      let payload: Record<string, unknown>;
      try {
        header = JSON.parse(
          Buffer.from(parts[0]!, "base64url").toString("utf8"),
        );
        payload = JSON.parse(
          Buffer.from(parts[1]!, "base64url").toString("utf8"),
        );
      } catch {
        return undefined;
      }

      if (typeof header !== "object" || typeof payload !== "object") {
        return undefined;
      }

      const alg = header.alg;
      const signatureInput = `${parts[0]}.${parts[1]}`;

      if (alg === "HS256") {
        if (!options.secret) return undefined;
        const expectedSig = createHmac("sha256", options.secret)
          .update(signatureInput)
          .digest();
        const actualSig = Buffer.from(parts[2]!, "base64url");
        if (expectedSig.length !== actualSig.length) return undefined;
        if (!timingSafeEqual(expectedSig, actualSig)) return undefined;
      } else if (alg === "RS256" || alg === "ES256") {
        if (!options.publicKey) return undefined;
        const verifier = createVerify(
          alg === "RS256" ? "RSA-SHA256" : "SHA256",
        );
        verifier.update(signatureInput);
        const actualSig = Buffer.from(parts[2]!, "base64url");
        if (!verifier.verify(options.publicKey, actualSig)) return undefined;
      } else {
        return undefined;
      }

      // Check standard temporal claims
      const now = Math.floor(Date.now() / 1000);
      if (typeof payload.exp === "number" && now > payload.exp + tolerance) {
        return undefined;
      }
      if (typeof payload.nbf === "number" && now < payload.nbf - tolerance) {
        return undefined;
      }

      // Check issuer
      if (options.issuer && payload.iss !== options.issuer) {
        return undefined;
      }

      // Check audience
      if (options.audience) {
        const aud = payload.aud;
        const audMatches = Array.isArray(aud)
          ? aud.includes(options.audience)
          : aud === options.audience;
        if (!audMatches) return undefined;
      }

      let principal: InboundPrincipalConfig | undefined;
      if (options.mapClaims) {
        principal = validatePrincipal(await options.mapClaims(payload));
      } else {
        const tenantId =
          typeof payload.tenantId === "string"
            ? payload.tenantId
            : typeof payload.tid === "string"
              ? payload.tid
              : "default";
        const principalId =
          typeof payload.sub === "string"
            ? payload.sub
            : typeof payload.principalId === "string"
              ? payload.principalId
              : "jwt-caller";
        let scopes: string[] = [];
        if (Array.isArray(payload.scopes)) {
          scopes = payload.scopes.filter(
            (s): s is string => typeof s === "string",
          );
        } else if (Array.isArray(payload.scp)) {
          scopes = payload.scp.filter(
            (s): s is string => typeof s === "string",
          );
        } else if (typeof payload.scope === "string") {
          scopes = payload.scope.split(" ").filter(Boolean);
        }

        principal = validatePrincipal({ tenantId, principalId, scopes });
      }

      if (!principal) return undefined;

      const scopes = principal.scopes ?? [];
      const context: ToolContext = {
        requestId: `inbound-${Date.now()}`,
        tenantId: principal.tenantId,
        principal: {
          id: principal.principalId,
          scopes,
        },
      };

      const authInfo: AuthInfo = {
        token,
        clientId: principal.principalId,
        scopes,
        extra: {
          tenantId: principal.tenantId,
          principalId: principal.principalId,
        },
      };

      return { context, authInfo };
    },
  };
}

/**
 * Combines multiple verifiers, trying each in sequence until one succeeds.
 */
export function createCompositeVerifier(
  verifiers: InboundAuthVerifier[],
): InboundAuthVerifier {
  const allHeaders = verifiers.flatMap((v) => v.headerNames ?? []);
  const seen = new Set<string>();
  const headerNames: string[] = [];
  for (const h of allHeaders) {
    const trimmed = h.trim();
    if (trimmed && !seen.has(trimmed.toLowerCase())) {
      seen.add(trimmed.toLowerCase());
      headerNames.push(trimmed);
    }
  }

  return {
    headerNames,
    async verify(request) {
      for (const verifier of verifiers) {
        const result = await verifier.verify(request);
        if (result) return result;
      }
      return undefined;
    },
  };
}

export interface InboundVerifierFactoryOptions {
  tokens?: Record<string, InboundPrincipalConfig> | undefined;
  apiKeys?: Record<string, InboundPrincipalConfig> | undefined;
  apiKeyHeader?: string | undefined;
  jwt?: JwtVerifierOptions | undefined;
}

/**
 * Creates a composite verifier from configured token maps, API keys, or JWT options.
 */
export function createInboundVerifier(
  options: InboundVerifierFactoryOptions,
): InboundAuthVerifier | undefined {
  const verifiers: InboundAuthVerifier[] = [];
  if (options.tokens && Object.keys(options.tokens).length > 0) {
    verifiers.push(createBearerTokenVerifier({ tokens: options.tokens }));
  }
  if (options.apiKeys && Object.keys(options.apiKeys).length > 0) {
    verifiers.push(
      createApiKeyVerifier({
        headerName: options.apiKeyHeader,
        keys: options.apiKeys,
      }),
    );
  }
  if (options.jwt && (options.jwt.secret || options.jwt.publicKey)) {
    verifiers.push(createJwtVerifier(options.jwt));
  }
  if (verifiers.length === 0) return undefined;
  if (verifiers.length === 1) return verifiers[0];
  return createCompositeVerifier(verifiers);
}

function getHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) {
      if (Array.isArray(value)) return value[0];
      return value;
    }
  }
  return undefined;
}

import {
  createHmac,
  createSign,
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  createInboundVerifier,
  createJwtVerifier,
  isInboundAuthFailure,
  type InboundAuthOutcome,
  type InboundAuthResult,
} from "../src/index.js";

function expectSuccess(
  outcome: InboundAuthOutcome | undefined,
): InboundAuthResult {
  if (!outcome || isInboundAuthFailure(outcome)) {
    throw new Error("expected a successful authentication outcome");
  }
  return outcome;
}

const secret = "test-secret-at-least-32-chars-long!";

describe("createJwtVerifier claim validation and asymmetric keys", () => {
  it("rejects blank tenantClaim at construction", () => {
    expect(() => createJwtVerifier({ secret, tenantClaim: "   " })).toThrow(
      "JWT tenantClaim must be a non-empty claim name",
    );
  });

  it("validates issuer and audience claims", async () => {
    const verifier = createJwtVerifier({
      secret,
      issuer: "https://auth.example.com",
      audience: "mcp-service",
    });

    const now = Math.floor(Date.now() / 1000);

    // Matching issuer and string audience
    const validToken = signHs256(
      {
        sub: "user-1",
        tenantId: "t-1",
        iss: "https://auth.example.com",
        aud: "mcp-service",
        exp: now + 300,
        nbf: now - 10,
      },
      secret,
    );
    const validRes = await verifier.verify({
      headers: { authorization: `Bearer ${validToken}` },
    });
    expect(expectSuccess(validRes).context.tenantId).toBe("t-1");

    // Matching audience array
    const validAudArray = signHs256(
      {
        sub: "user-1",
        tenantId: "t-1",
        iss: "https://auth.example.com",
        aud: ["mcp-service", "other-service"],
        exp: now + 300,
      },
      secret,
    );
    const validAudRes = await verifier.verify({
      headers: { authorization: `Bearer ${validAudArray}` },
    });
    expect(expectSuccess(validAudRes).context.tenantId).toBe("t-1");

    // Mismatched issuer
    const badIssToken = signHs256(
      {
        sub: "user-1",
        tenantId: "t-1",
        iss: "https://evil.example.com",
        aud: "mcp-service",
        exp: now + 300,
      },
      secret,
    );
    expect(
      await verifier.verify({
        headers: { authorization: `Bearer ${badIssToken}` },
      }),
    ).toBeUndefined();

    // Mismatched audience string
    const badAudToken = signHs256(
      {
        sub: "user-1",
        tenantId: "t-1",
        iss: "https://auth.example.com",
        aud: "wrong-service",
        exp: now + 300,
      },
      secret,
    );
    expect(
      await verifier.verify({
        headers: { authorization: `Bearer ${badAudToken}` },
      }),
    ).toBeUndefined();

    // Mismatched audience array
    const badAudArrayToken = signHs256(
      {
        sub: "user-1",
        tenantId: "t-1",
        iss: "https://auth.example.com",
        aud: ["other-1", "other-2"],
        exp: now + 300,
      },
      secret,
    );
    expect(
      await verifier.verify({
        headers: { authorization: `Bearer ${badAudArrayToken}` },
      }),
    ).toBeUndefined();
  });

  it("enforces expiration and not-before claims", async () => {
    const verifier = createJwtVerifier({ secret, clockToleranceSeconds: 5 });
    const now = Math.floor(Date.now() / 1000);

    // Expired token (exp 100s in past)
    const expiredToken = signHs256(
      { sub: "user-1", tenantId: "t-1", exp: now - 100 },
      secret,
    );
    expect(
      await verifier.verify({
        headers: { authorization: `Bearer ${expiredToken}` },
      }),
    ).toBeUndefined();

    // Not-before in future (nbf 100s in future)
    const futureToken = signHs256(
      { sub: "user-1", tenantId: "t-1", nbf: now + 100, exp: now + 300 },
      secret,
    );
    expect(
      await verifier.verify({
        headers: { authorization: `Bearer ${futureToken}` },
      }),
    ).toBeUndefined();
  });

  it("extracts principalId and scopes from alternative claims (scp, scope)", async () => {
    const verifier = createJwtVerifier({ secret });
    const now = Math.floor(Date.now() / 1000);

    // Using principalId claim and scp array claim
    const token1 = signHs256(
      {
        principalId: "p-custom",
        tenantId: "t-1",
        scp: ["read", "write", 123 as unknown as string], // non-string filtered out
        exp: now + 300,
      },
      secret,
    );
    const res1 = await verifier.verify({
      headers: { authorization: `Bearer ${token1}` },
    });
    const s1 = expectSuccess(res1);
    expect(s1.context.principal.id).toBe("p-custom");
    expect(s1.context.principal.scopes).toEqual(["read", "write"]);

    // Using space-delimited scope string
    const token2 = signHs256(
      {
        sub: "user-2",
        tenantId: "t-1",
        scope: "read:all write:all",
        exp: now + 300,
      },
      secret,
    );
    const res2 = await verifier.verify({
      headers: { authorization: `Bearer ${token2}` },
    });
    const s2 = expectSuccess(res2);
    expect(s2.context.principal.scopes).toEqual(["read:all", "write:all"]);
  });

  it("verifies RS256 tokens using a static publicKey", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    });
    const publicPem = publicKey
      .export({ type: "spki", format: "pem" })
      .toString();

    const verifier = createJwtVerifier({ publicKey: publicPem });
    const now = Math.floor(Date.now() / 1000);

    const token = signRs256(
      { sub: "user-rsa", tenantId: "t-rsa", exp: now + 300 },
      privateKey,
    );

    const res = await verifier.verify({
      headers: { authorization: `Bearer ${token}` },
    });
    expect(expectSuccess(res).context.principal.id).toBe("user-rsa");

    // Invalid signature rejection
    const tampered = token.slice(0, -5) + "abcde";
    expect(
      await verifier.verify({
        headers: { authorization: `Bearer ${tampered}` },
      }),
    ).toBeUndefined();
  });

  it("verifies RS256 tokens using simulated JWKS fetching and cache refresh", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    });
    const jwk = publicKey.export({ format: "jwk" });
    jwk.kid = "key-current";

    let fetchCount = 0;
    const fetchJwks = async () => {
      fetchCount++;
      return { keys: [jwk] };
    };

    const verifier = createJwtVerifier({
      jwksUri: "https://auth.example.com/.well-known/jwks.json",
      fetchJwks,
      jwksCacheTtlMs: 50_000,
    });

    const now = Math.floor(Date.now() / 1000);
    const token = signRs256(
      { sub: "user-jwks", tenantId: "t-jwks", exp: now + 300 },
      privateKey,
      "key-current",
    );

    // First call fetches JWKS
    const res1 = await verifier.verify({
      headers: { authorization: `Bearer ${token}` },
    });
    expect(expectSuccess(res1).context.principal.id).toBe("user-jwks");
    expect(fetchCount).toBe(1);

    // Second call uses cached JWKS
    const res2 = await verifier.verify({
      headers: { authorization: `Bearer ${token}` },
    });
    expect(expectSuccess(res2).context.principal.id).toBe("user-jwks");
    expect(fetchCount).toBe(1);

    // Unknown kid forces refresh
    const unknownKidToken = signRs256(
      { sub: "user-jwks", tenantId: "t-jwks", exp: now + 300 },
      privateKey,
      "key-non-existent",
    );
    const resUnknown = await verifier.verify({
      headers: { authorization: `Bearer ${unknownKidToken}` },
    });
    expect(resUnknown).toBeUndefined();
    expect(fetchCount).toBe(2);
  });
});

describe("createInboundVerifier wiring coverage", () => {
  it("wires tokens, apiKeys, and jwt into composite verifiers", () => {
    // Only tokens
    const tokensOnly = createInboundVerifier({
      tokens: { "tok-1": { tenantId: "t1", principalId: "p1" } },
    });
    expect(tokensOnly).toBeDefined();
    expect(tokensOnly?.headerNames).toContain("Authorization");

    // Only apiKeys
    const apiKeysOnly = createInboundVerifier({
      apiKeys: { "key-1": { tenantId: "t1", principalId: "p1" } },
      apiKeyHeader: "X-Custom-Key",
    });
    expect(apiKeysOnly).toBeDefined();
    expect(apiKeysOnly?.headerNames).toContain("X-Custom-Key");

    // Combined composite
    const composite = createInboundVerifier({
      tokens: { "tok-1": { tenantId: "t1", principalId: "p1" } },
      apiKeys: { "key-1": { tenantId: "t1", principalId: "p1" } },
      jwt: { secret },
    });
    expect(composite).toBeDefined();
    expect(composite?.headerNames).toEqual(
      expect.arrayContaining(["Authorization", "X-API-Key"]),
    );
  });
});

function signHs256(
  payload: Record<string, unknown>,
  secretKey: string,
): string {
  const header = { alg: "HS256", typ: "JWT" };
  const b64Header = Buffer.from(JSON.stringify(header)).toString("base64url");
  const b64Payload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secretKey)
    .update(`${b64Header}.${b64Payload}`)
    .digest("base64url");
  return `${b64Header}.${b64Payload}.${signature}`;
}

function signRs256(
  payload: Record<string, unknown>,
  privateKey: KeyObject,
  kid = "key-1",
): string {
  const header = { alg: "RS256", typ: "JWT", kid };
  const b64Header = Buffer.from(JSON.stringify(header)).toString("base64url");
  const b64Payload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sign = createSign("RSA-SHA256");
  sign.update(`${b64Header}.${b64Payload}`);
  const signature = sign.sign(privateKey).toString("base64url");
  return `${b64Header}.${b64Payload}.${signature}`;
}

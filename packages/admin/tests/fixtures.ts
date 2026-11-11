import type { DeclarativeAuthSchemeMap } from "@chainmcp/declarative";
import type {
  UpstreamTransport,
  UpstreamTransportRequest,
  UpstreamTransportResponse,
} from "@chainmcp/executor";
import { DynamicGateway } from "@chainmcp/gateway";

import {
  DeclarativeAdmin,
  type DeclarativeAdminAuditEvent,
  type DeclarativeAdminContractBinding,
  type DeclarativeAdminOptions,
} from "../src/index.js";

export const ADMIN_TOKEN = "admin-token-0123456789";
export const SCOPED_TOKEN = "scoped-token-0123456789";

export const authSchemes: DeclarativeAuthSchemeMap = {
  api_key: {
    type: "apiKey",
    parameterName: "X-API-Key",
    parameterLocation: "header",
  },
};

export function makeDescriptor(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    descriptorVersion: 1,
    name: "get_user",
    description: "Fetches one user",
    request: {
      method: "GET",
      path: "/users/{userId}",
      parameters: [
        { name: "userId", in: "path", required: true },
        { name: "limit", in: "query" },
      ],
    },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["userId"],
      properties: {
        userId: { type: "string", minLength: 1 },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
    },
    authentication: { alternatives: [{ schemes: [{ name: "api_key" }] }] },
    policy: {
      requiredScopes: ["users:read"],
      cacheTtlSeconds: 30,
      timeoutMs: 5_000,
    },
    ...overrides,
  };
}

export function makeBinding(
  overrides: Partial<DeclarativeAdminContractBinding> = {},
): DeclarativeAdminContractBinding {
  return {
    tenantId: "tenant-a",
    contractName: "users",
    destinationPolicy: {
      baseUrl: "https://api.example.com",
      allowedHosts: ["api.example.com"],
    },
    authSchemes,
    resolveHost: async () => ["8.8.8.8"],
    ...overrides,
  };
}

export interface AdminFixture {
  readonly gateway: DynamicGateway;
  readonly admin: DeclarativeAdmin;
  readonly audit: DeclarativeAdminAuditEvent[];
}

export function makeAdmin(
  overrides: Partial<DeclarativeAdminOptions> = {},
): AdminFixture {
  const gateway = new DynamicGateway();
  const audit: DeclarativeAdminAuditEvent[] = [];
  const admin = new DeclarativeAdmin({
    gateway,
    tokens: [
      { id: "operator", token: ADMIN_TOKEN, tenants: "*" },
      { id: "tenant-b-operator", token: SCOPED_TOKEN, tenants: ["tenant-b"] },
    ],
    contracts: [makeBinding()],
    auditSink: (event) => {
      audit.push(event);
    },
    ...overrides,
  });
  return { gateway, admin, audit };
}

export interface RequestOptions {
  readonly token?: string | null;
  readonly body?: unknown;
  readonly rawBody?: string;
  readonly contentType?: string | null;
}

export function adminRequest(
  path: string,
  method = "GET",
  options: RequestOptions = {},
): Request {
  const headers = new Headers();
  if (options.token !== null) {
    headers.set("authorization", `Bearer ${options.token ?? ADMIN_TOKEN}`);
  }
  const payload =
    options.rawBody ??
    (options.body === undefined ? undefined : JSON.stringify(options.body));
  if (options.contentType !== null) {
    headers.set("content-type", options.contentType ?? "application/json");
  }
  return new Request(`http://127.0.0.1:3341${path}`, {
    method,
    headers,
    ...(payload === undefined ? {} : { body: payload }),
  });
}

export const CONTRACT_PATH = "/api/v1/tenants/tenant-a/contracts/users";

export class FakeTransport implements UpstreamTransport {
  readonly requests: UpstreamTransportRequest[] = [];
  responder: (
    request: UpstreamTransportRequest,
  ) => UpstreamTransportResponse | Promise<UpstreamTransportResponse> = () =>
    jsonResponse({ ok: true });

  async request(
    request: UpstreamTransportRequest,
  ): Promise<UpstreamTransportResponse> {
    this.requests.push(request);
    return await this.responder(request);
  }
}

export function jsonResponse(
  body: unknown,
  status = 200,
): UpstreamTransportResponse {
  return {
    status,
    headers: { "content-type": "application/json" },
    body: new TextEncoder().encode(JSON.stringify(body)),
  };
}

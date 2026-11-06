import { describe, expect, it } from "vitest";
import { InvalidResponseError, UpstreamStatusError } from "../src/errors.js";
import { createTokenEndpointFetcher } from "../src/oauth-egress.js";
import type {
  HostResolver,
  UpstreamTransport,
  UpstreamTransportRequest,
  UpstreamTransportResponse,
} from "../src/types.js";

describe("OAuth Egress (createTokenEndpointFetcher)", () => {
  const publicResolver: HostResolver = async () => ["93.184.216.34"]; // Public IPv4 address

  function createMockTransport(
    responseOrHandler:
      | Partial<UpstreamTransportResponse>
      | ((req: UpstreamTransportRequest) => Promise<UpstreamTransportResponse>),
  ): UpstreamTransport {
    return {
      request: async (req: UpstreamTransportRequest) => {
        if (typeof responseOrHandler === "function") {
          return responseOrHandler(req);
        }
        return {
          status: responseOrHandler.status ?? 200,
          headers: responseOrHandler.headers ?? {
            "content-type": "application/json",
          },
          body:
            responseOrHandler.body ??
            Buffer.from(
              JSON.stringify({
                access_token: "test_token_123",
                token_type: "Bearer",
                expires_in: 3600,
              }),
              "utf8",
            ),
        };
      },
    };
  }

  it("rejects invalid URLs and URLs containing credentials", async () => {
    const fetcher = createTokenEndpointFetcher({
      resolver: publicResolver,
      transport: createMockTransport({}),
    });

    const body = new URLSearchParams({ grant_type: "client_credentials" });

    await expect(
      fetcher("invalid-url-not-http", body, {}),
    ).rejects.toThrowError(InvalidResponseError);

    await expect(
      fetcher("https://user:pass@oauth.example.com/token", body, {}),
    ).rejects.toThrowError("OAuth token URL must not contain credentials");
  });

  it("fetches and parses a valid OAuth token response", async () => {
    let capturedRequest: UpstreamTransportRequest | undefined;
    const transport: UpstreamTransport = {
      request: async (req) => {
        capturedRequest = req;
        return {
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8" },
          body: Buffer.from(
            JSON.stringify({
              access_token: "tok_abc_xyz",
              token_type: "Bearer",
              expires_in: 7200,
              scope: "read write",
            }),
            "utf8",
          ),
        };
      },
    };

    const fetcher = createTokenEndpointFetcher({
      resolver: publicResolver,
      transport,
    });

    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: "client123",
    });

    const result = await fetcher(
      "https://oauth.example.com/oauth/token",
      body,
      {
        authorization: "Basic dXNlcjpwYXNz",
      },
    );

    expect(result).toEqual({
      access_token: "tok_abc_xyz",
      token_type: "Bearer",
      expires_in: 7200,
      scope: "read write",
    });

    expect(capturedRequest?.method).toBe("POST");
    expect(capturedRequest?.hostname).toBe("oauth.example.com");
    expect(capturedRequest?.headers.authorization).toBe("Basic dXNlcjpwYXNz");
  });

  it("refuses token endpoint redirects (3xx status)", async () => {
    const transport = createMockTransport({
      status: 302,
      headers: { location: "https://evil.example.com/token" },
    });

    const fetcher = createTokenEndpointFetcher({
      resolver: publicResolver,
      transport,
    });

    await expect(
      fetcher("https://oauth.example.com/token", new URLSearchParams(), {}),
    ).rejects.toThrowError("OAuth token endpoint redirects are not followed");
  });

  it("throws UpstreamStatusError on non-2xx responses", async () => {
    const transport = createMockTransport({
      status: 401,
      headers: { "content-type": "application/json" },
    });

    const fetcher = createTokenEndpointFetcher({
      resolver: publicResolver,
      transport,
    });

    await expect(
      fetcher("https://oauth.example.com/token", new URLSearchParams(), {}),
    ).rejects.toThrowError(UpstreamStatusError);
  });

  it("rejects non-JSON content types", async () => {
    const transport = createMockTransport({
      status: 200,
      headers: { "content-type": "text/html" },
      body: Buffer.from("<html><body>Error</body></html>", "utf8"),
    });

    const fetcher = createTokenEndpointFetcher({
      resolver: publicResolver,
      transport,
    });

    await expect(
      fetcher("https://oauth.example.com/token", new URLSearchParams(), {}),
    ).rejects.toThrowError("OAuth token endpoint returned a non-JSON response");
  });

  it("rejects invalid JSON response body", async () => {
    const transport = createMockTransport({
      status: 200,
      headers: { "content-type": "application/json" },
      body: Buffer.from("{ not valid json", "utf8"),
    });

    const fetcher = createTokenEndpointFetcher({
      resolver: publicResolver,
      transport,
    });

    await expect(
      fetcher("https://oauth.example.com/token", new URLSearchParams(), {}),
    ).rejects.toThrowError("OAuth token response was not valid JSON");
  });

  it("rejects non-object JSON response body", async () => {
    const transport = createMockTransport({
      status: 200,
      headers: { "content-type": "application/json" },
      body: Buffer.from(JSON.stringify("just a string primitive"), "utf8"),
    });

    const fetcher = createTokenEndpointFetcher({
      resolver: publicResolver,
      transport,
    });

    await expect(
      fetcher("https://oauth.example.com/token", new URLSearchParams(), {}),
    ).rejects.toThrowError("OAuth token response was not a JSON object");
  });

  it("supports +json content types such as application/jwt+json", async () => {
    const transport = createMockTransport({
      status: 200,
      headers: { "content-type": "application/jwt+json" },
      body: Buffer.from(JSON.stringify({ access_token: "jwt_token" }), "utf8"),
    });

    const fetcher = createTokenEndpointFetcher({
      resolver: publicResolver,
      transport,
    });

    const res = await fetcher(
      "https://oauth.example.com/token",
      new URLSearchParams(),
      {},
    );
    expect(res.access_token).toBe("jwt_token");
  });
});

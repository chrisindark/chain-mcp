import type {
  UpstreamTransport,
  UpstreamTransportRequest,
  UpstreamTransportResponse,
} from "@chainmcp/executor";

/**
 * A deterministic in-process upstream for the example. It deliberately
 * implements `UpstreamTransport` instead of listening on loopback, because the
 * production destination policy rejects loopback, private, and metadata
 * addresses even when they are allowlisted.
 */
export function createMockUpstreamTransport(): UpstreamTransport {
  return {
    async request(
      request: UpstreamTransportRequest,
    ): Promise<UpstreamTransportResponse> {
      if (request.address !== "93.184.216.34") {
        throw new Error(
          "Example transport received an unexpected pinned address",
        );
      }

      if (
        request.method === "GET" &&
        request.url.pathname.startsWith("/items/")
      ) {
        const id = decodeURIComponent(
          request.url.pathname.slice("/items/".length),
        );
        if (id.length === 0) return json(404, { error: "Item not found" });
        return json(200, {
          id,
          name: `Demo item ${id}`,
          quantity: 3,
        });
      }

      if (request.method === "POST" && request.url.pathname === "/items") {
        const input =
          request.body === undefined
            ? {}
            : (JSON.parse(new TextDecoder().decode(request.body)) as Record<
                string,
                unknown
              >);
        return json(201, {
          id: "item-1",
          name: input.name,
          quantity: input.quantity,
        });
      }

      return json(404, { error: "Route not found" });
    },
  };
}

function json(
  status: number,
  value: Record<string, unknown>,
): UpstreamTransportResponse {
  return {
    status,
    headers: { "content-type": "application/json" },
    body: new TextEncoder().encode(JSON.stringify(value)),
  };
}

import { describe, expect, it, vi } from "vitest";
import {
  CircuitBreakerOpenError,
  createCircuitBreakerTransport,
  createResilientUpstreamTransport,
  createRetryTransport,
  type UpstreamTransport,
  type UpstreamTransportRequest,
  type UpstreamTransportResponse,
} from "../src/index.js";

function mockRequest(
  method = "GET",
  hostname = "api.example.com",
  signal?: AbortSignal,
): UpstreamTransportRequest {
  const url = new URL(`https://${hostname}/test`);
  return {
    method,
    url,
    hostname,
    address: "93.184.216.34",
    family: 4,
    headers: {},
    maxResponseBytes: 1_000_000,
    signal: signal ?? new AbortController().signal,
  };
}

function mockResponse(status = 200, body = "ok"): UpstreamTransportResponse {
  return {
    status,
    headers: { "content-type": "text/plain" },
    body: Buffer.from(body),
  };
}

describe("Resilient Upstream Transport & Circuit Breaker", () => {
  it("exposes CircuitBreakerOpenError with correct name and host message", () => {
    const error = new CircuitBreakerOpenError("api.example.com");
    expect(error.name).toBe("CircuitBreakerOpenError");
    expect(error.message).toContain("api.example.com");
    expect(error instanceof Error).toBe(true);
  });

  it("exports createRetryTransport and createCircuitBreakerTransport aliases", () => {
    expect(createRetryTransport).toBe(createResilientUpstreamTransport);
    expect(createCircuitBreakerTransport).toBe(
      createResilientUpstreamTransport,
    );
  });

  it("passes through successful idempotent requests on first attempt", async () => {
    const base: UpstreamTransport = {
      request: vi.fn().mockResolvedValue(mockResponse(200, "success")),
    };
    const resilient = createResilientUpstreamTransport({
      transport: base,
      maxAttempts: 3,
      baseDelayMs: 1,
    });

    const res = await resilient.request(mockRequest("GET"));
    expect(res.status).toBe(200);
    expect(base.request).toHaveBeenCalledTimes(1);
  });

  it("retries idempotent methods (GET) on retryable statuses and succeeds", async () => {
    let calls = 0;
    const base: UpstreamTransport = {
      request: vi.fn().mockImplementation(async () => {
        calls++;
        if (calls === 1) return mockResponse(503, "Service Unavailable");
        if (calls === 2) return mockResponse(429, "Too Many Requests");
        return mockResponse(200, "Success");
      }),
    };

    const resilient = createResilientUpstreamTransport({
      transport: base,
      maxAttempts: 3,
      baseDelayMs: 2,
      maxDelayMs: 10,
    });

    const res = await resilient.request(mockRequest("GET"));
    expect(res.status).toBe(200);
    expect(calls).toBe(3);
  });

  it("retries other idempotent methods (PUT, DELETE, HEAD, OPTIONS)", async () => {
    for (const method of ["PUT", "DELETE", "HEAD", "OPTIONS"]) {
      let attempts = 0;
      const base: UpstreamTransport = {
        request: vi.fn().mockImplementation(async () => {
          attempts++;
          return attempts === 1 ? mockResponse(502) : mockResponse(200);
        }),
      };
      const resilient = createResilientUpstreamTransport({
        transport: base,
        maxAttempts: 2,
        baseDelayMs: 1,
      });

      const res = await resilient.request(mockRequest(method));
      expect(res.status).toBe(200);
      expect(attempts).toBe(2);
    }
  });

  it("does not retry non-idempotent methods (POST, PATCH)", async () => {
    for (const method of ["POST", "PATCH"]) {
      let attempts = 0;
      const base: UpstreamTransport = {
        request: vi.fn().mockImplementation(async () => {
          attempts++;
          return mockResponse(503, "Server Error");
        }),
      };
      const resilient = createResilientUpstreamTransport({
        transport: base,
        maxAttempts: 3,
        baseDelayMs: 1,
      });

      const res = await resilient.request(mockRequest(method));
      expect(res.status).toBe(503);
      expect(attempts).toBe(1);
    }
  });

  it("fails non-idempotent requests on network exceptions without retry", async () => {
    const base: UpstreamTransport = {
      request: vi
        .fn()
        .mockRejectedValue(new Error("Network connection dropped")),
    };
    const resilient = createResilientUpstreamTransport({
      transport: base,
      maxAttempts: 3,
      baseDelayMs: 1,
    });

    await expect(resilient.request(mockRequest("POST"))).rejects.toThrow(
      "Network connection dropped",
    );
    expect(base.request).toHaveBeenCalledTimes(1);
  });

  it("retries on network exceptions for idempotent requests until maxAttempts exhausted", async () => {
    const base: UpstreamTransport = {
      request: vi.fn().mockRejectedValue(new Error("Connection reset")),
    };
    const resilient = createResilientUpstreamTransport({
      transport: base,
      maxAttempts: 3,
      baseDelayMs: 1,
    });

    await expect(resilient.request(mockRequest("GET"))).rejects.toThrow(
      "Connection reset",
    );
    expect(base.request).toHaveBeenCalledTimes(3);
  });

  it("handles non-Error thrown values", async () => {
    const base: UpstreamTransport = {
      request: vi.fn().mockRejectedValue("raw string exception"),
    };
    const resilient = createResilientUpstreamTransport({
      transport: base,
      maxAttempts: 1,
      baseDelayMs: 1,
    });

    await expect(resilient.request(mockRequest("POST"))).rejects.toThrow(
      "raw string exception",
    );
  });

  it("returns the 503 response when retry attempts are exhausted without network errors", async () => {
    const base: UpstreamTransport = {
      request: vi.fn().mockResolvedValue(mockResponse(503, "Unavailable")),
    };
    const resilient = createResilientUpstreamTransport({
      transport: base,
      maxAttempts: 2,
      baseDelayMs: 1,
    });

    const res = await resilient.request(mockRequest("GET"));
    expect(res.status).toBe(503);
    expect(base.request).toHaveBeenCalledTimes(2);
  });

  it("supports custom retryableStatuses", async () => {
    let count = 0;
    const base: UpstreamTransport = {
      request: vi.fn().mockImplementation(async () => {
        count++;
        return count === 1 ? mockResponse(418) : mockResponse(200);
      }),
    };
    const resilient = createResilientUpstreamTransport({
      transport: base,
      maxAttempts: 2,
      baseDelayMs: 1,
      retryableStatuses: new Set([418]),
    });

    const res = await resilient.request(mockRequest("GET"));
    expect(res.status).toBe(200);
    expect(count).toBe(2);
  });

  it("trips circuit breaker when failureThreshold is reached and rejects immediately", async () => {
    const base: UpstreamTransport = {
      request: vi.fn().mockRejectedValue(new Error("Outage")),
    };
    const resilient = createResilientUpstreamTransport({
      transport: base,
      maxAttempts: 1,
      failureThreshold: 2,
      cooldownMs: 5000,
    });

    // 1st failure
    await expect(resilient.request(mockRequest("POST"))).rejects.toThrow(
      "Outage",
    );
    expect(base.request).toHaveBeenCalledTimes(1);

    // 2nd failure -> trips circuit
    await expect(resilient.request(mockRequest("POST"))).rejects.toThrow(
      "Outage",
    );
    expect(base.request).toHaveBeenCalledTimes(2);

    // 3rd call -> circuit is open, rejects immediately with CircuitBreakerOpenError without calling base
    await expect(resilient.request(mockRequest("POST"))).rejects.toThrow(
      CircuitBreakerOpenError,
    );
    expect(base.request).toHaveBeenCalledTimes(2);
  });

  it("circuit breaker cools down after cooldownMs", async () => {
    let fail = true;
    const base: UpstreamTransport = {
      request: vi.fn().mockImplementation(async () => {
        if (fail) throw new Error("Temporary outage");
        return mockResponse(200, "recovered");
      }),
    };

    const resilient = createResilientUpstreamTransport({
      transport: base,
      maxAttempts: 1,
      failureThreshold: 1,
      cooldownMs: 20, // 20ms cooldown
    });

    // Trip circuit
    await expect(resilient.request(mockRequest("GET"))).rejects.toThrow(
      "Temporary outage",
    );

    // Immediately open
    await expect(resilient.request(mockRequest("GET"))).rejects.toThrow(
      CircuitBreakerOpenError,
    );

    // Wait for cooldown
    await new Promise((resolve) => setTimeout(resolve, 35));
    fail = false;

    // Next request succeeds
    const res = await resilient.request(mockRequest("GET"));
    expect(res.status).toBe(200);
  });

  it("aborts sleep when signal is aborted during backoff delay", async () => {
    const base: UpstreamTransport = {
      request: vi.fn().mockResolvedValue(mockResponse(503)),
    };
    const controller = new AbortController();
    const resilient = createResilientUpstreamTransport({
      transport: base,
      maxAttempts: 3,
      baseDelayMs: 100, // delay long enough to abort
    });

    const req = mockRequest("GET", "api.example.com", controller.signal);
    const promise = resilient.request(req);

    // Abort shortly after first failed attempt
    setTimeout(() => {
      controller.abort();
    }, 15);

    await expect(promise).rejects.toThrow();
  });

  it("rejects immediately if signal is already aborted before sleep", async () => {
    const base: UpstreamTransport = {
      request: vi.fn().mockResolvedValue(mockResponse(503)),
    };
    const controller = new AbortController();
    const resilient = createResilientUpstreamTransport({
      transport: base,
      maxAttempts: 2,
      baseDelayMs: 50,
    });

    const req = mockRequest("GET", "api.example.com", controller.signal);
    // Let first attempt fail and abort right away
    let firstCall = true;
    base.request = vi.fn().mockImplementation(async () => {
      if (firstCall) {
        firstCall = false;
        controller.abort();
        return mockResponse(503);
      }
      return mockResponse(200);
    });

    await expect(resilient.request(req)).rejects.toThrow();
  });

  it("initializes default node upstream transport when none is passed", () => {
    const resilient = createResilientUpstreamTransport();
    expect(typeof resilient.request).toBe("function");
  });
});

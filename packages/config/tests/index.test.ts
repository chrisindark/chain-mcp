import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/index.js";

describe("configuration schema", () => {
  it("applies conservative defaults to a minimal configuration", () => {
    expect(parseConfig({ version: 1, name: "catalog" })).toMatchObject({
      version: 1,
      server: {
        transport: "stdio",
        host: "127.0.0.1",
        port: 3333,
        requestTimeoutMs: 15_000,
        maxResponseBytes: 1_000_000,
      },
      security: {
        requireInboundAuth: false,
        allowedUpstreamHosts: [],
        redactHeaders: ["authorization", "cookie", "x-api-key"],
      },
    });
  });

  it("applies field defaults to empty or partial nested objects", () => {
    expect(
      parseConfig({
        version: 1,
        name: "catalog",
        server: {},
        security: {},
      }),
    ).toMatchObject({
      server: {
        transport: "stdio",
        host: "127.0.0.1",
        port: 3333,
        requestTimeoutMs: 15_000,
        maxResponseBytes: 1_000_000,
      },
      security: {
        requireInboundAuth: false,
        allowedUpstreamHosts: [],
        redactHeaders: ["authorization", "cookie", "x-api-key"],
      },
    });

    expect(
      parseConfig({
        version: 1,
        name: "catalog",
        server: { port: 4444 },
        security: { requireInboundAuth: true },
      }),
    ).toMatchObject({
      server: {
        transport: "stdio",
        host: "127.0.0.1",
        port: 4444,
        requestTimeoutMs: 15_000,
        maxResponseBytes: 1_000_000,
      },
      security: {
        requireInboundAuth: true,
        allowedUpstreamHosts: [],
        redactHeaders: ["authorization", "cookie", "x-api-key"],
      },
    });
  });

  it("rejects unknown fields, invalid ports, and unsupported versions", () => {
    expect(() => parseConfig({ version: 2, name: "catalog" })).toThrow();
    expect(() =>
      parseConfig({ version: 1, name: "catalog", unknown: true }),
    ).toThrow();
    expect(() =>
      parseConfig({ version: 1, name: "catalog", server: { port: 70_000 } }),
    ).toThrow();
  });
});

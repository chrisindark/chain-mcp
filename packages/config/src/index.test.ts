import { describe, expect, it } from "vitest";
import { parseConfig } from "./index.js";

describe("configuration schema", () => {
  it("applies conservative defaults to a minimal configuration", () => {
    expect(parseConfig({ version: 1, name: "catalog" })).toMatchObject({
      version: 1,
      server: {
        transport: "stdio",
        host: "127.0.0.1",
        port: 3333,
        requestTimeoutMs: 15_000,
      },
      security: { requireInboundAuth: false, allowedUpstreamHosts: [] },
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

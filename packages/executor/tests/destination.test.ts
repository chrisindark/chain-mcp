import { describe, expect, it } from "vitest";

import {
  assertDestinationUrl,
  canonicalizeIp,
  classifyAddress,
  isSameAddress,
  normalizeAllowedHost,
  normalizeHostname,
  resolveDestination,
  type DestinationPolicy,
} from "../src/destination.js";
import { DestinationPolicyError } from "../src/errors.js";

function policy(overrides: Partial<DestinationPolicy> = {}): DestinationPolicy {
  return {
    allowedHosts: new Set(["api.example.com"]),
    protocol: "https:",
    port: 443,
    allowInsecureHttp: false,
    maxUrlLength: 8_192,
    ...overrides,
  };
}

describe("destination policy", () => {
  it("normalizes allowlist hostnames and rejects ambiguous entries", () => {
    expect(normalizeAllowedHost("API.Example.COM.")).toBe("api.example.com");
    expect(normalizeAllowedHost("localhost")).toBe("localhost");
    expect(normalizeAllowedHost("::1")).toBe("0:0:0:0:0:0:0:1");

    for (const invalid of [
      "*.example.com",
      "https://api.example.com",
      "api.example.com:443",
      "api.example.com/path",
      "user@example.com",
      "",
      " api.example.com",
    ]) {
      expect(() => normalizeAllowedHost(invalid)).toThrow(TypeError);
    }
  });

  it("normalizes URL hostnames including trailing dots and IPv4-mapped forms", () => {
    expect(normalizeHostname("API.EXAMPLE.COM.")).toBe("api.example.com");
    expect(normalizeHostname("[::1]")).toBe("0:0:0:0:0:0:0:1");
    expect(canonicalizeIp("::ffff:127.0.0.1")).toBe("127.0.0.1");
    expect(isSameAddress("::ffff:8.8.8.8", "8.8.8.8")).toBe(true);
  });

  it.each([
    ["8.8.8.8", "public"],
    ["1.1.1.1", "public"],
    ["127.0.0.1", "loopback"],
    ["10.1.2.3", "private"],
    ["172.16.0.1", "private"],
    ["172.31.255.255", "private"],
    ["192.168.1.1", "private"],
    ["100.64.0.1", "shared"],
    ["100.100.100.200", "metadata"],
    ["169.254.169.254", "metadata"],
    ["169.254.1.1", "link-local"],
    ["192.0.0.192", "metadata"],
    ["192.0.2.1", "documentation"],
    ["198.18.0.1", "reserved"],
    ["198.51.100.1", "documentation"],
    ["203.0.113.1", "documentation"],
    ["224.0.0.1", "multicast"],
    ["255.255.255.255", "reserved"],
    ["0.0.0.0", "unspecified"],
    ["::1", "loopback"],
    ["::", "unspecified"],
    ["fc00::1", "private"],
    ["fd00:ec2::254", "private"],
    ["fe80::1", "link-local"],
    ["ff02::1", "multicast"],
    ["2001:db8::1", "documentation"],
    ["2002:7f00:1::1", "reserved"],
    ["::ffff:127.0.0.1", "loopback"],
    ["::ffff:8.8.8.8", "public"],
    ["2606:4700:4700::1111", "public"],
    ["not-an-ip", "invalid"],
  ])("classifies %s as %s", (address, expected) => {
    expect(classifyAddress(address)).toBe(expected);
  });

  it("enforces scheme, port, credentials, and allowlist", () => {
    const allowed = policy();
    expect(() =>
      assertDestinationUrl("https://api.example.com/v1", allowed),
    ).not.toThrow();
    expect(() =>
      assertDestinationUrl("https://other.example.com/v1", allowed),
    ).toThrow(DestinationPolicyError);
    expect(() =>
      assertDestinationUrl("https://api.example.com:8443/v1", allowed),
    ).toThrow(DestinationPolicyError);
    expect(() =>
      assertDestinationUrl("http://api.example.com/v1", allowed),
    ).toThrow(DestinationPolicyError);
    expect(() =>
      assertDestinationUrl("https://user:pass@api.example.com/v1", allowed),
    ).toThrow(DestinationPolicyError);
    expect(() => assertDestinationUrl("file:///etc/passwd", allowed)).toThrow(
      DestinationPolicyError,
    );
  });

  it("resolves and pins the first public address", async () => {
    const resolver = async (): Promise<readonly string[]> => [
      "8.8.8.8",
      "2606:4700:4700::1111",
    ];
    const destination = await resolveDestination(
      "https://API.EXAMPLE.COM./v1",
      policy(),
      resolver,
    );

    expect(destination.hostname).toBe("api.example.com");
    expect(destination.address).toBe("8.8.8.8");
    expect(destination.family).toBe(4);
    expect(destination.url.href).toBe("https://api.example.com/v1");
  });

  it("rejects a DNS answer containing any unsafe address", async () => {
    const resolver = async (): Promise<readonly string[]> => [
      "8.8.8.8",
      "10.0.0.1",
    ];
    await expect(
      resolveDestination("https://api.example.com/", policy(), resolver),
    ).rejects.toBeInstanceOf(DestinationPolicyError);
  });

  it("bounds the number of resolver answers", async () => {
    await expect(
      resolveDestination("https://api.example.com/", policy(), async () =>
        Array<string>(33).fill("8.8.8.8"),
      ),
    ).rejects.toBeInstanceOf(DestinationPolicyError);
  });

  it("rejects empty, invalid, and lookup-failed resolutions", async () => {
    await expect(
      resolveDestination("https://api.example.com/", policy(), async () => []),
    ).rejects.toBeInstanceOf(DestinationPolicyError);
    await expect(
      resolveDestination("https://api.example.com/", policy(), async () => [
        "not-an-ip",
      ]),
    ).rejects.toBeInstanceOf(DestinationPolicyError);
    await expect(
      resolveDestination("https://api.example.com/", policy(), async () => {
        throw new Error("ENOTFOUND");
      }),
    ).rejects.toBeInstanceOf(DestinationPolicyError);
  });

  it("supports allowlisted IP literals without DNS", async () => {
    const destination = await resolveDestination(
      "https://8.8.8.8/",
      policy({ allowedHosts: new Set(["8.8.8.8"]) }),
      async () => {
        throw new Error("resolver must not be called");
      },
    );
    expect(destination.address).toBe("8.8.8.8");
    expect(destination.family).toBe(4);
  });
});

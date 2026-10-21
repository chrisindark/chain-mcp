import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import { DestinationPolicyError } from "./errors.js";
import type { HostResolver, ResolvedDestination } from "./types.js";

export const DEFAULT_MAX_URL_LENGTH = 8_192;
export const MAX_RESOLVED_ADDRESSES = 32;

export interface DestinationPolicy {
  allowedHosts: ReadonlySet<string>;
  protocol: "http:" | "https:";
  /** Effective port (default 80/443 resolved at construction). */
  port: number;
  allowInsecureHttp: boolean;
  maxUrlLength: number;
}

export const systemHostResolver: HostResolver = async (hostname) => {
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  return addresses.map((entry) => entry.address);
};

/**
 * Normalizes an operator-provided allowlist entry. Ports, schemes, paths,
 * credentials, wildcards, and whitespace are rejected rather than guessed at.
 */
export function normalizeAllowedHost(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0 || raw !== raw.trim()) {
    throw new TypeError("Allowed hosts must be non-empty hostnames");
  }
  if (raw.includes("*")) {
    throw new TypeError("Allowed hosts do not support wildcards");
  }
  if (
    raw.includes(":") &&
    isIP(raw) !== 6 &&
    !(raw.startsWith("[") && raw.endsWith("]"))
  ) {
    // `new URL` drops an explicit default port, so detect it before parsing.
    throw new TypeError("Allowed hosts must not include a port");
  }
  let parsed: URL;
  try {
    parsed = new URL(
      `https://${raw.includes(":") && isIP(raw) === 6 ? `[${raw}]` : raw}`,
    );
  } catch {
    throw new TypeError(`Allowed host '${raw}' is not a valid hostname`);
  }
  if (
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.port.length > 0 ||
    parsed.pathname !== "/" ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw new TypeError(
      `Allowed host '${raw}' must not include a scheme, port, path, query, or credentials`,
    );
  }
  return normalizeHostname(parsed.hostname);
}

/** Normalizes a URL hostname for allowlist comparison and DNS resolution. */
export function normalizeHostname(raw: string): string {
  let host = raw.toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (host.length === 0 || host.length > 253) {
    throw new TypeError("Hostname must be between 1 and 253 characters");
  }
  const version = isIP(host);
  if (version === 4 || version === 6) {
    const canonical = canonicalizeIp(host);
    if (canonical === undefined) {
      throw new TypeError("Hostname IP address is invalid");
    }
    return canonical;
  }
  if (!/^[a-z0-9._-]+$/.test(host)) {
    throw new TypeError("Hostname contains invalid characters");
  }
  for (const label of host.split(".")) {
    if (label.length === 0 || label.length > 63) {
      throw new TypeError("Hostname contains an empty or oversized label");
    }
  }
  return host;
}

/** Canonical text form used for pin comparisons and allowlist entries. */
export function canonicalizeIp(raw: string): string | undefined {
  const withoutZone = raw.split("%")[0] ?? raw;
  const version = isIP(withoutZone);
  if (version === 4) {
    const bytes = parseIpv4(withoutZone);
    return bytes === undefined ? undefined : bytes.join(".");
  }
  if (version !== 6) return undefined;
  const bytes = parseIpv6(withoutZone);
  if (bytes === undefined) return undefined;
  if (isIpv4Mapped(bytes)) {
    return [bytes[12], bytes[13], bytes[14], bytes[15]].join(".");
  }
  return Array.from({ length: 8 }, (_, index) =>
    (((bytes[index * 2] ?? 0) << 8) | (bytes[index * 2 + 1] ?? 0)).toString(16),
  ).join(":");
}

export function isSameAddress(left: string, right: string): boolean {
  const canonicalLeft = canonicalizeIp(left);
  const canonicalRight = canonicalizeIp(right);
  return canonicalLeft !== undefined && canonicalLeft === canonicalRight;
}

export type AddressClass =
  | "public"
  | "loopback"
  | "private"
  | "shared"
  | "link-local"
  | "metadata"
  | "multicast"
  | "documentation"
  | "reserved"
  | "unspecified"
  | "invalid";

/** Classifies both IPv4 and IPv6 forms, including IPv4-mapped addresses. */
export function classifyAddress(raw: string): AddressClass {
  const withoutZone = raw.split("%")[0] ?? raw;
  if (isIP(withoutZone) === 4) {
    const bytes = parseIpv4(withoutZone);
    return bytes === undefined ? "invalid" : classifyIpv4(bytes);
  }
  if (isIP(withoutZone) === 6) {
    const bytes = parseIpv6(withoutZone);
    return bytes === undefined ? "invalid" : classifyIpv6(bytes);
  }
  return "invalid";
}

/**
 * Applies protocol, origin, allowlist, credential, and length constraints.
 * Redirects call this again, so every hop is checked independently.
 */
export function assertDestinationUrl(
  input: URL | string,
  policy: DestinationPolicy,
): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new DestinationPolicyError("Upstream URL is not valid");
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new DestinationPolicyError(
      "Upstream URL must not contain credentials",
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new DestinationPolicyError("Upstream URL must use HTTP or HTTPS");
  }
  if (url.protocol === "http:" && !policy.allowInsecureHttp) {
    throw new DestinationPolicyError("Plain HTTP upstream URLs are disabled");
  }
  if (url.protocol !== policy.protocol) {
    throw new DestinationPolicyError(
      "Upstream redirects must not change protocol",
    );
  }
  if (effectivePort(url) !== policy.port) {
    throw new DestinationPolicyError("Upstream redirects must not change port");
  }
  let hostname: string;
  try {
    hostname = normalizeHostname(url.hostname);
  } catch {
    throw new DestinationPolicyError("Upstream URL host is invalid");
  }
  if (!policy.allowedHosts.has(hostname)) {
    throw new DestinationPolicyError("Upstream host is not allowlisted");
  }
  url.hash = "";
  if (url.href.length > policy.maxUrlLength) {
    throw new DestinationPolicyError("Upstream URL is too long");
  }
  // Rebuild the host so a trailing dot and equivalent IP spelling do not
  // produce a different Host header than the one that was checked.
  url.hostname = hostname.includes(":") ? `[${hostname}]` : hostname;
  if (url.href.length > policy.maxUrlLength) {
    throw new DestinationPolicyError("Upstream URL is too long");
  }
  return url;
}

/** Resolves and pins one allowed destination, rejecting if any A/AAAA is unsafe. */
export async function resolveDestination(
  input: URL | string,
  policy: DestinationPolicy,
  resolver: HostResolver,
): Promise<ResolvedDestination> {
  const url = assertDestinationUrl(input, policy);
  const hostname = normalizeHostname(url.hostname);
  const literalVersion = isIP(hostname);
  let candidates: readonly string[];
  if (literalVersion === 4 || literalVersion === 6) {
    candidates = [hostname];
  } else {
    try {
      candidates = await resolver(hostname);
    } catch (error) {
      throw new DestinationPolicyError("Upstream host could not be resolved", {
        cause: error,
      });
    }
    if (!Array.isArray(candidates) || candidates.length === 0) {
      throw new DestinationPolicyError(
        "Upstream host resolved to no addresses",
      );
    }
    if (candidates.length > MAX_RESOLVED_ADDRESSES) {
      throw new DestinationPolicyError(
        "Upstream host resolved to too many addresses",
      );
    }
  }

  const canonical = candidates.map((candidate) => {
    if (typeof candidate !== "string") {
      throw new DestinationPolicyError(
        "Resolver returned a non-string address",
      );
    }
    const address = canonicalizeIp(candidate);
    if (address === undefined) {
      throw new DestinationPolicyError("Resolver returned an invalid address");
    }
    return address;
  });

  // Reject the whole answer if any candidate is unsafe. Accepting a public
  // address while a private one is also present would leave the choice to DNS
  // ordering and make rebinding harder to reason about.
  for (const address of canonical) {
    if (classifyAddress(address) !== "public") {
      throw new DestinationPolicyError(
        "Upstream host resolves to a non-public address",
      );
    }
  }

  const [address] = canonical;
  const family = address === undefined ? undefined : isIP(address);
  if (address === undefined || (family !== 4 && family !== 6)) {
    throw new DestinationPolicyError("Upstream host resolved to no address");
  }
  return { url, hostname, address, family };
}

export function effectivePort(url: URL): number {
  if (url.port.length > 0) return Number(url.port);
  return url.protocol === "https:" ? 443 : 80;
}

function classifyIpv4(bytes: readonly number[]): AddressClass {
  const [a = 0, b = 0, c = 0, d = 0] = bytes;
  if (a === 0) return "unspecified";
  if (a === 127) return "loopback";
  if (a === 10) return "private";
  if (a === 172 && b >= 16 && b <= 31) return "private";
  if (a === 192 && b === 168) return "private";
  if (a === 100 && b >= 64 && b <= 127) {
    return a === 100 && b === 100 && c === 100 && d === 200
      ? "metadata"
      : "shared";
  }
  if (a === 169 && b === 254) {
    return c === 169 && d === 254 ? "metadata" : "link-local";
  }
  if (a === 192 && b === 0 && c === 0) {
    return d === 192 ? "metadata" : "reserved";
  }
  if (a === 192 && b === 0 && c === 2) return "documentation";
  if (a === 192 && b === 88 && c === 99) return "reserved";
  if (a === 198 && (b === 18 || b === 19)) return "reserved";
  if (a === 198 && b === 51 && c === 100) return "documentation";
  if (a === 203 && b === 0 && c === 113) return "documentation";
  if (a >= 224 && a <= 239) return "multicast";
  if (a >= 240) return "reserved";
  return "public";
}

function classifyIpv6(bytes: readonly number[]): AddressClass {
  if (isIpv4Mapped(bytes)) {
    return classifyIpv4(bytes.slice(12, 16));
  }
  if (bytes.every((byte) => byte === 0)) return "unspecified";
  if (bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1) {
    return "loopback";
  }
  const b0 = bytes[0] ?? 0;
  const b1 = bytes[1] ?? 0;
  const b2 = bytes[2] ?? 0;
  const b3 = bytes[3] ?? 0;
  if ((b0 & 0xfe) === 0xfc) return "private";
  if (b0 === 0xfe && (b1 & 0xc0) === 0x80) return "link-local";
  if (b0 === 0xfe && (b1 & 0xc0) === 0xc0) return "reserved";
  if (b0 === 0xff) return "multicast";
  if (b0 === 0x20 && b1 === 0x01 && b2 === 0x0d && b3 === 0xb8) {
    return "documentation";
  }
  if (b0 === 0x3f && (b1 & 0xf0) === 0xf0) return "documentation";
  if (b0 === 0x20 && b1 === 0x01 && b2 === 0x00 && b3 === 0x00) {
    return "reserved"; // Teredo
  }
  if (b0 === 0x20 && b1 === 0x01 && b2 === 0x00 && b3 === 0x02) {
    return "reserved"; // benchmarking
  }
  if (
    b0 === 0x20 &&
    b1 === 0x01 &&
    b2 === 0x00 &&
    ((b3 >= 0x10 && b3 <= 0x1f) || (b3 >= 0x20 && b3 <= 0x2f))
  ) {
    return "reserved"; // ORCHID and ORCHIDv2
  }
  if (b0 === 0x20 && b1 === 0x02) return "reserved"; // 6to4
  if (
    b0 === 0x00 &&
    b1 === 0x64 &&
    b2 === 0xff &&
    b3 === 0x9b &&
    bytes.slice(4, 12).every((byte) => byte === 0)
  ) {
    return "reserved"; // NAT64
  }
  if ((b0 & 0xe0) === 0x20) return "public"; // 2000::/3 global unicast
  return "reserved";
}

function isIpv4Mapped(bytes: readonly number[]): boolean {
  return (
    bytes.slice(0, 10).every((byte) => byte === 0) &&
    bytes[10] === 0xff &&
    bytes[11] === 0xff
  );
}

function parseIpv4(raw: string): number[] | undefined {
  const parts = raw.split(".");
  if (parts.length !== 4) return undefined;
  const bytes: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined;
    const value = Number(part);
    if (value > 255) return undefined;
    bytes.push(value);
  }
  return bytes;
}

function parseIpv6(raw: string): number[] | undefined {
  let address = raw;
  if (address.includes(".")) {
    const lastColon = address.lastIndexOf(":");
    if (lastColon < 0) return undefined;
    const ipv4 = parseIpv4(address.slice(lastColon + 1));
    if (ipv4 === undefined) return undefined;
    const high = ((ipv4[0] ?? 0) << 8) | (ipv4[1] ?? 0);
    const low = ((ipv4[2] ?? 0) << 8) | (ipv4[3] ?? 0);
    address = `${address.slice(0, lastColon + 1)}${high.toString(16)}:${low.toString(16)}`;
  }
  const halves = address.split("::");
  if (halves.length > 2) return undefined;
  const left = halves[0] === "" ? [] : (halves[0] ?? "").split(":");
  const right =
    halves.length === 1 || halves[1] === "" ? [] : (halves[1] ?? "").split(":");
  const missing = 8 - left.length - right.length;
  if (halves.length === 1 && missing !== 0) return undefined;
  if (missing < 0) return undefined;
  const parts = [...left, ...Array<string>(missing).fill("0"), ...right];
  if (parts.length !== 8) return undefined;
  const bytes: number[] = [];
  for (const part of parts) {
    if (!/^[0-9a-f]{1,4}$/i.test(part)) return undefined;
    const value = Number.parseInt(part, 16);
    bytes.push((value >> 8) & 0xff, value & 0xff);
  }
  return bytes;
}

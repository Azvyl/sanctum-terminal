import { Log } from "../logger.ts";

const TAG = "SSRF";

export class SsrfBlockedError extends Error {
  public readonly target: string;
  public readonly restrictedIp?: string;

  constructor(target: string, restrictedIp?: string) {
    super(`Target '${target}' is or resolves to a restricted address '${restrictedIp ?? target}'.`);
    this.name = "SsrfBlockedError";
    this.target = target;
    this.restrictedIp = restrictedIp;
  }
}

/**
 * Checks if an IPv4 address belongs to a restricted/private range:
 * - Loopback (127.0.0.0/8)
 * - Current/unspecified network (0.0.0.0/8)
 * - Private LAN (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16)
 * - Link-local & Cloud Metadata (169.254.0.0/16)
 * - Broadcast (255.255.255.255)
 */
export function isPrivateOrRestrictedIpv4(ip: string): boolean {
  const parts = ip.split(".");
  if (parts.length !== 4) return false;
  const octets = parts.map((p) => {
    if (!/^\d{1,3}$/.test(p)) return -1;
    const n = parseInt(p, 10);
    return n >= 0 && n <= 255 ? n : -1;
  });
  if (octets.some((o) => o === -1)) return false;

  const [a, b, c, d] = octets;

  if (a === 0) return true;

  if (a === 127) return true;

  if (a === 10) return true;

  if (a === 172 && b >= 16 && b <= 31) return true;

  if (a === 192 && b === 168) return true;

  if (a === 169 && b === 254) return true;

  if (a === 255 && b === 255 && c === 255 && d === 255) return true;

  return false;
}

/**
 * Expands an IPv6 address string into 8 16-bit words.
 */
export function parseIpv6Words(ip: string): number[] | null {
  let clean = ip.trim().toLowerCase();
  if (clean.startsWith("[") && clean.endsWith("]")) {
    clean = clean.slice(1, -1);
  }

  const lastColon = clean.lastIndexOf(":");
  if (lastColon !== -1) {
    const possibleIpv4 = clean.slice(lastColon + 1);
    if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(possibleIpv4)) {
      const octets = possibleIpv4.split(".").map((n) => parseInt(n, 10));
      if (octets.some((o) => isNaN(o) || o < 0 || o > 255)) return null;
      const part1 = ((octets[0] << 8) | octets[1]).toString(16);
      const part2 = ((octets[2] << 8) | octets[3]).toString(16);
      clean = clean.slice(0, lastColon) + ":" + part1 + ":" + part2;
    }
  }

  const doubleColonCount = (clean.match(/::/g) || []).length;
  if (doubleColonCount > 1) return null;

  let parts: string[];
  if (clean.includes("::")) {
    const [head, tail] = clean.split("::");
    const headParts = head ? head.split(":") : [];
    const tailParts = tail ? tail.split(":") : [];
    const missing = 8 - (headParts.length + tailParts.length);
    if (missing < 0) return null;
    parts = [...headParts, ...Array(missing).fill("0"), ...tailParts];
  } else {
    parts = clean.split(":");
  }

  if (parts.length !== 8) return null;
  const words: number[] = [];
  for (const p of parts) {
    if (!/^[0-9a-f]{1,4}$/.test(p)) return null;
    words.push(parseInt(p, 16));
  }
  return words;
}

/**
 * Checks if an IPv6 address belongs to a restricted/private range:
 * - Unspecified (::)
 * - Loopback (::1)
 * - IPv4-mapped IPv6 (::ffff:x.x.x.x) checking IPv4 rules
 * - Link-local (fe80::/10)
 * - Unique Local Address / ULA (fc00::/7)
 */
export function isPrivateOrRestrictedIpv6(ip: string): boolean {
  const words = parseIpv6Words(ip);
  if (!words) return false;

  if (words.every((w) => w === 0)) return true;

  if (words.slice(0, 7).every((w) => w === 0) && words[7] === 1) return true;

  if (words.slice(0, 5).every((w) => w === 0) && words[5] === 0xffff) {
    const a = words[6] >> 8;
    const b = words[6] & 0xff;
    const c = words[7] >> 8;
    const d = words[7] & 0xff;
    return isPrivateOrRestrictedIpv4(`${a}.${b}.${c}.${d}`);
  }

  if ((words[0] & 0xffc0) === 0xfe80) return true;

  if ((words[0] & 0xfe00) === 0xfc00) return true;

  return false;
}

/**
 * Checks whether an IP literal (IPv4 or IPv6) is within private/restricted ranges.
 */
export function isPrivateOrRestrictedIp(ip: string): boolean {
  const clean = ip.trim().replace(/^\[|\]$/g, "");
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(clean)) {
    return isPrivateOrRestrictedIpv4(clean);
  }
  if (clean.includes(":")) {
    return isPrivateOrRestrictedIpv6(clean);
  }
  return false;
}

/**
 * Validates a target host or IP before opening sockets.
 * Ensures that loopback, LAN subnets, link-local, and cloud metadata are blocked,
 * while allowing public IPs and legitimate public DNS resolutions.
 *
 * @throws {SsrfBlockedError} if target is restricted or resolves to a restricted IP.
 */
export async function validateTargetHost(host: string): Promise<string> {
  const cleanHost = host.trim().replace(/^\[|\]$/g, "");
  const lower = cleanHost.toLowerCase();

  if (
    lower === "localhost" ||
    lower.endsWith(".localhost") ||
    lower.endsWith(".local") ||
    lower.endsWith(".internal")
  ) {
    Log.warn(TAG, `Blocked connection attempt to internal host: ${host}`);
    throw new SsrfBlockedError(host, cleanHost);
  }

  if (isPrivateOrRestrictedIp(cleanHost)) {
    Log.warn(TAG, `Blocked connection attempt to restricted IP literal: ${host}`);
    throw new SsrfBlockedError(host, cleanHost);
  }

  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(cleanHost) || cleanHost.includes(":")) {
    return cleanHost;
  }

  const resolvedIps: string[] = [];
  try {
    const aRecords = await Deno.resolveDns(cleanHost, "A");
    if (aRecords && aRecords.length > 0) {
      resolvedIps.push(...aRecords);
    }
  } catch {
    // DNS A resolution failure ignored (will fail naturally at socket connect)
  }

  try {
    const aaaaRecords = await Deno.resolveDns(cleanHost, "AAAA");
    if (aaaaRecords && aaaaRecords.length > 0) {
      resolvedIps.push(...aaaaRecords);
    }
  } catch {
    // DNS AAAA resolution failure ignored
  }

  for (const ip of resolvedIps) {
    if (isPrivateOrRestrictedIp(ip)) {
      Log.warn(TAG, `Blocked DNS rebinding / private resolution for ${host} -> ${ip}`);
      throw new SsrfBlockedError(host, ip);
    }
  }

  return cleanHost;
}


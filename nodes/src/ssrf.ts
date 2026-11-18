import dns from 'node:dns/promises';
import net from 'node:net';

export interface ParsedConnectTarget {
  host: string;
  port: number;
}

export interface TargetResolutionResult {
  allowed: boolean;
  reason?: string;
  resolvedIp?: string;
  family?: 4 | 6;
}

/**
 * Parses an HTTP CONNECT authority target (`host:port` or `[ipv6]:port`).
 */
export function parseConnectAuthority(authority: string | undefined): ParsedConnectTarget | null {
  if (!authority || typeof authority !== 'string') {
    return null;
  }
  const trimmed = authority.trim();
  if (!trimmed || /\s/.test(trimmed)) {
    return null;
  }

  let host: string;
  let portStr: string;

  if (trimmed.startsWith('[')) {
    const closeBracket = trimmed.indexOf(']');
    if (closeBracket === -1 || trimmed[closeBracket + 1] !== ':') {
      return null;
    }
    host = trimmed.slice(1, closeBracket);
    portStr = trimmed.slice(closeBracket + 2);
  } else {
    const lastColon = trimmed.lastIndexOf(':');
    if (lastColon <= 0 || trimmed.indexOf(':') !== lastColon) {
      return null;
    }
    host = trimmed.slice(0, lastColon);
    portStr = trimmed.slice(lastColon + 1);
  }

  if (!host || !/^\d+$/.test(portStr)) {
    return null;
  }

  const port = Number(portStr);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return null;
  }

  return { host: host.toLowerCase(), port };
}

/**
 * Returns true if an IPv4 address belongs to loopback, RFC1918 private,
 * link-local / Cloud IMDS (169.254.0.0/16, Alibaba 100.100.100.200, Oracle 192.0.0.192),
 * CGNAT/Tailscale (100.64.0.0/10), multicast, documentation/benchmark, or reserved space.
 */
export function isPrivateOrReservedIpv4(ip: string): boolean {
  const parts = ip.split('.');
  if (parts.length !== 4) {
    return true;
  }
  const octets = parts.map((p) => (p !== '' && /^\d+$/.test(p) ? Number(p) : NaN));
  if (octets.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return true;
  }

  const [a, b, c, d] = octets as [number, number, number, number];

  // 0.0.0.0/8 ("this" network)
  if (a === 0) return true;
  // 10.0.0.0/8 (RFC 1918)
  if (a === 10) return true;
  // 100.100.100.200/32 (Alibaba Cloud IMDS — explicit guard in addition to 100.64.0.0/10)
  if (a === 100 && b === 100 && c === 100 && d === 200) return true;
  // 100.64.0.0/10 (CGNAT / Tailscale mesh)
  if (a === 100 && b >= 64 && b <= 127) return true;
  // 127.0.0.0/8 (Loopback)
  if (a === 127) return true;
  // 169.254.0.0/16 (Link-local / AWS, GCP, Azure, DigitalOcean IMDS)
  if (a === 169 && b === 254) return true;
  // 172.16.0.0/12 (RFC 1918)
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.0.0.0/24 (IETF Protocol Assignments incl. Oracle IMDS 192.0.0.192) & 192.0.2.0/24 (TEST-NET-1)
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
  // 192.88.99.0/24 (Deprecated 6to4 Relay Anycast, RFC 7526)
  if (a === 192 && b === 88 && c === 99) return true;
  // 192.168.0.0/16 (RFC 1918)
  if (a === 192 && b === 168) return true;
  // 198.18.0.0/15 (Benchmarking)
  if (a === 198 && (b === 18 || b === 19)) return true;
  // 198.51.100.0/24 (TEST-NET-2)
  if (a === 198 && b === 51 && c === 100) return true;
  // 203.0.113.0/24 (TEST-NET-3)
  if (a === 203 && b === 0 && c === 113) return true;
  // 224.0.0.0/4 (Multicast) & 240.0.0.0/4 (Reserved / Broadcast)
  if (a >= 224) return true;

  return false;
}

/**
 * Expands a valid IPv6 address into 8 16-bit numeric groups.
 */
function expandIpv6Groups(ip: string): number[] | null {
  let working = ip.toLowerCase();
  const zoneIdx = working.indexOf('%');
  if (zoneIdx !== -1) {
    working = working.slice(0, zoneIdx);
  }

  // Handle embedded dotted-quad IPv4 suffix (e.g. ::ffff:127.0.0.1 or ::ffff:0:127.0.0.1)
  const lastColon = working.lastIndexOf(':');
  if (lastColon !== -1 && working.slice(lastColon + 1).includes('.')) {
    const v4Part = working.slice(lastColon + 1);
    if (net.isIP(v4Part) !== 4) {
      return null;
    }
    const [o0, o1, o2, o3] = v4Part.split('.').map(Number) as [number, number, number, number];
    const hi = ((o0 << 8) | o1).toString(16);
    const lo = ((o2 << 8) | o3).toString(16);
    working = `${working.slice(0, lastColon)}:${hi}:${lo}`;
  }

  const halves = working.split('::');
  if (halves.length > 2) {
    return null;
  }

  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];

  const missing = 8 - (left.length + right.length);
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) {
    return null;
  }

  const full = [...left, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...right];
  if (full.length !== 8) {
    return null;
  }

  const nums = full.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return nums.some(Number.isNaN) ? null : nums;
}

/**
 * Returns true if an IPv6 address is loopback, unspecified, link-local,
 * unique-local (ULA, incl. AWS IPv6 IMDS fd00:ec2::254), multicast,
 * transition/tunneling (6to4 `2002::/16`, Teredo `2001:0000::/32`, `2001:0002::/32`,
 * NAT64 `64:ff9b::/96` & `64:ff9b:1::/48`, SIIT `::ffff:0:0:0/96`, deprecated `::/96`),
 * or embeds a private/reserved IPv4 address.
 */
export function isPrivateOrReservedIpv6(ip: string): boolean {
  if (ip.includes('%')) {
    // Zone-scoped IPv6 addresses are always local to an interface.
    return true;
  }

  const groups = expandIpv6Groups(ip);
  if (!groups) {
    return true;
  }

  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];

  // ::/128 (Unspecified)
  if (groups.every((g) => g === 0)) return true;
  // ::1/128 (Loopback)
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && g7 === 1) {
    return true;
  }
  // ::/96 (Deprecated IPv4-compatible IPv6, RFC 4291)
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return true;
  }
  // ::ffff:0:0/96 (IPv4-mapped IPv6)
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    const v4 = `${(g6 >> 8) & 0xff}.${g6 & 0xff}.${(g7 >> 8) & 0xff}.${g7 & 0xff}`;
    return isPrivateOrReservedIpv4(v4);
  }
  // ::ffff:0:0:0/96 (SIIT IPv4-translated IPv6, RFC 2765)
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0xffff && g5 === 0) {
    return true;
  }
  // 64:ff9b::/96 (Well-Known NAT64) and 64:ff9b:1::/48 (Local-Use NAT64, RFC 8215)
  if (
    g0 === 0x0064 &&
    g1 === 0xff9b &&
    ((g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) || g2 === 0x0001)
  ) {
    return true;
  }
  // 100::/64 (Discard-only, RFC 6666)
  if (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) return true;
  // 2001:0000::/32 (Teredo tunneling, RFC 4380), 2001:0002::/32 (BMWG Benchmarking, RFC 5180),
  // and 2001:db8::/32 (Documentation, RFC 3849)
  if (g0 === 0x2001 && (g1 === 0x0000 || g1 === 0x0002 || g1 === 0x0db8)) {
    return true;
  }
  // 2002::/16 (6to4 tunneling embedding arbitrary IPv4 in g1:g2, e.g. 2002:a9fe:a9fe:: -> 169.254.169.254)
  if (g0 === 0x2002) {
    return true;
  }
  // fd00:ec2::254 (AWS EC2 IPv6 IMDS — explicit guard, also covered by fc00::/7 ULA below)
  if (
    g0 === 0xfd00 &&
    g1 === 0x0ec2 &&
    g2 === 0 &&
    g3 === 0 &&
    g4 === 0 &&
    g5 === 0 &&
    g6 === 0 &&
    g7 === 0x0254
  ) {
    return true;
  }
  // fc00::/7 (Unique Local Address fc00:: - fdff::)
  if ((g0 & 0xfe00) === 0xfc00) return true;
  // fe80::/10 (Link-local fe80:: - febf::)
  if ((g0 & 0xffc0) === 0xfe80) return true;
  // ff00::/8 (Multicast)
  if ((g0 & 0xff00) === 0xff00) return true;

  return false;
}

export function isPrivateOrReservedIp(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) {
    return isPrivateOrReservedIpv4(ip);
  }
  if (family === 6) {
    return isPrivateOrReservedIpv6(ip);
  }
  return true;
}

/**
 * Validates and resolves an upstream CONNECT target, blocking SSRF to private,
 * loopback, link-local, transition IPv6, or non-allowlisted ports unless explicitly allowed.
 */
export async function validateAndResolveTarget(
  target: ParsedConnectTarget,
  options: {
    allowedPorts: ReadonlySet<number>;
    allowPrivateTargets: boolean;
  },
): Promise<TargetResolutionResult> {
  if (!options.allowedPorts.has(target.port)) {
    return {
      allowed: false,
      reason: `Target port ${target.port} is not permitted`,
    };
  }

  const hostLower = target.host.toLowerCase();
  if (!options.allowPrivateTargets) {
    if (
      hostLower === 'localhost' ||
      hostLower === 'metadata.google.internal' ||
      hostLower === 'metadata' ||
      hostLower === 'instance-data' ||
      hostLower.endsWith('.localhost') ||
      hostLower.endsWith('.local') ||
      hostLower.endsWith('.internal')
    ) {
      return {
        allowed: false,
        reason: `Target host "${target.host}" is blocked by SSRF policy`,
      };
    }
  }

  const literalFamily = net.isIP(hostLower);
  if (literalFamily === 4 || literalFamily === 6) {
    if (!options.allowPrivateTargets && isPrivateOrReservedIp(hostLower)) {
      return {
        allowed: false,
        reason: `Target IP "${hostLower}" is blocked by SSRF policy`,
      };
    }
    return {
      allowed: true,
      resolvedIp: hostLower,
      family: literalFamily,
    };
  }

  let records: Array<{ address: string; family: number }>;
  try {
    records = await dns.lookup(hostLower, { all: true, verbatim: true });
  } catch {
    return {
      allowed: false,
      reason: `Unable to resolve host "${target.host}"`,
    };
  }

  if (!records || records.length === 0) {
    return {
      allowed: false,
      reason: `No DNS records returned for "${target.host}"`,
    };
  }

  if (!options.allowPrivateTargets) {
    for (const rec of records) {
      if (isPrivateOrReservedIp(rec.address)) {
        return {
          allowed: false,
          reason: `Resolved IP "${rec.address}" for "${target.host}" is blocked by SSRF policy`,
        };
      }
    }
  }

  const primary = records.find((r) => r.family === 4) ?? records[0]!;
  return {
    allowed: true,
    resolvedIp: primary.address,
    family: primary.family === 6 ? 6 : 4,
  };
}

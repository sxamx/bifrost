import dns from 'node:dns/promises';
import net from 'node:net';

export type UpstreamUrlMode = 'official-json' | 'experimental-adapter';

export interface ValidateUpstreamUrlOptions {
  /**
   * Validation mode:
   * - `'official-json'` (default): requires `https://` to a public routable host/IP.
   *   Loopback (`127.0.0.1`, `::1`, `localhost`) is blocked unless `allowLocalhost` / `allowLocalhostForTests` is `true`.
   * - `'experimental-adapter'`: permits `http://` or `https://` to explicit local sidecars
   *   (`127.0.0.1`, `::1`, `localhost`, unless `allowAdapterLoopback === false`) or `https://` to public hosts,
   *   while still blocking RFC1918 LAN, Tailscale CGNAT, Cloud IMDS, link-local, and IPv6 transition ranges.
   */
  mode?: UpstreamUrlMode;
  /**
   * Explicit opt-in flag for local unit/integration tests running mock HTTP servers on `127.0.0.1` / `::1` / `localhost`.
   * NEVER bypasses Cloud IMDS (`169.254.0.0/16`, `100.100.100.200`, `fd00:ec2::254`), `0.0.0.0/8`,
   * IPv6 link-local (`fe80::/10`), ULA (`fc00::/7`), IPv6 transition ranges (`2002::/16`, `2001:0000::/32`,
   * `64:ff9b::/96`, `64:ff9b:1::/48`, `::ffff:0:0:0/96`), or RFC1918 LAN (`10/8`, `172.16/12`, `192.168/16`).
   */
  allowLocalhost?: boolean;
  /** Alias for `allowLocalhost` for readability in test suites. */
  allowLocalhostForTests?: boolean;
  /** Whether `experimental-adapter` mode permits loopback sidecar URLs (default: `true`). */
  allowAdapterLoopback?: boolean;
  /** Whether `validateSafeUpstreamUrl` resolves DNS records to prevent DNS rebinding (default: `true`). */
  resolveDns?: boolean;
  /** Injectable DNS lookup function for deterministic unit tests. */
  lookupFn?: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
}

export interface UpstreamUrlValidationResult {
  allowed: boolean;
  normalizedUrl?: string;
  hostname?: string;
  resolvedIps?: string[];
  reason?: string;
}

export class UpstreamSsrfError extends Error {
  public readonly status = 400;
  public readonly code = 'ssrf_blocked';

  constructor(message: string) {
    super(message);
    this.name = 'UpstreamSsrfError';
  }
}

const BLOCKED_METADATA_HOSTNAMES = new Set([
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
  'instance-data.ec2.internal',
]);

function parseIpv4Octets(ip: string): [number, number, number, number] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) {
    return null;
  }
  const octets = parts.map((p) => (p !== '' && /^\d+$/.test(p) ? Number(p) : NaN));
  if (octets.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return null;
  }
  return octets as [number, number, number, number];
}

function expandIpv6Groups(ip: string): number[] | null {
  let working = ip.toLowerCase();
  const zoneIdx = working.indexOf('%');
  if (zoneIdx !== -1) {
    working = working.slice(0, zoneIdx);
  }

  const lastColon = working.lastIndexOf(':');
  if (lastColon !== -1 && working.slice(lastColon + 1).includes('.')) {
    const v4Part = working.slice(lastColon + 1);
    const v4Octets = parseIpv4Octets(v4Part);
    if (!v4Octets) {
      return null;
    }
    const [o0, o1, o2, o3] = v4Octets;
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
 * Returns `true` ONLY for standard IPv4 loopback (`127.0.0.0/8`) or IPv6 loopback (`::1`).
 * Transition/mapped forms (`2002:7f00::`, `::ffff:0:127.0.0.1`, `::127.0.0.1`) are NOT treated as safe loopback.
 */
export function isStrictLoopbackIp(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) {
    const octets = parseIpv4Octets(ip);
    return octets !== null && octets[0] === 127;
  }
  if (family === 6) {
    if (ip.includes('%')) return false;
    const groups = expandIpv6Groups(ip);
    if (!groups) return false;
    return (
      groups[0] === 0 &&
      groups[1] === 0 &&
      groups[2] === 0 &&
      groups[3] === 0 &&
      groups[4] === 0 &&
      groups[5] === 0 &&
      groups[6] === 0 &&
      groups[7] === 1
    );
  }
  return false;
}

/**
 * Returns `true` for IPs that MUST NEVER be contacted in ANY mode (even when `allowLocalhost` is enabled for tests):
 * - `0.0.0.0/8`, `169.254.0.0/16` (AWS/GCP/Azure IMDS), `100.100.100.200` (Alibaba IMDS), `192.0.0.0/24` (Oracle IMDS),
 *   `192.88.99.0/24` (6to4 relay), multicast/broadcast (`224.0.0.0/4`, `240.0.0.0/4`).
 * - IPv6 unspecified (`::`), zone-scoped (`%`), link-local (`fe80::/10`), ULA (`fc00::/7` incl. `fd00:ec2::254`),
 *   multicast (`ff00::/8`), and ALL IPv6 transition/tunneling prefixes (`2002::/16`, `2001:0000::/32`, `2001:0002::/32`,
 *   `64:ff9b::/96`, `64:ff9b:1::/48`, `::ffff:0:0:0/96`, `::/96` except `::1`, and `::ffff:0:0/96` mapped to blocked IPv4).
 */
export function isUnconditionallyBlockedIp(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) {
    const octets = parseIpv4Octets(ip);
    if (!octets) return true;
    const [a, b, c, d] = octets;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b === 100 && c === 100 && d === 200) return true;
    if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
    if (a === 192 && b === 88 && c === 99) return true;
    if (a >= 224) return true;
    return false;
  }

  if (family === 6) {
    if (ip.includes('%')) return true;
    const groups = expandIpv6Groups(ip);
    if (!groups) return true;
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
    // ::1/128 is loopback (handled separately by mode/allowLocalhost policy)
    if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && g7 === 1) {
      return false;
    }
    // ::/96 (Deprecated IPv4-compatible IPv6)
    if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
      return true;
    }
    // ::ffff:0:0/96 (IPv4-mapped IPv6 — block all mapped private/loopback/IMDS)
    if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
      const v4 = `${(g6 >> 8) & 0xff}.${g6 & 0xff}.${(g7 >> 8) & 0xff}.${g7 & 0xff}`;
      return isPrivateOrReservedIpv4(v4);
    }
    // ::ffff:0:0:0/96 (SIIT IPv4-translated)
    if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0xffff && g5 === 0) {
      return true;
    }
    // 64:ff9b::/96 & 64:ff9b:1::/48 (NAT64)
    if (
      g0 === 0x0064 &&
      g1 === 0xff9b &&
      ((g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) || g2 === 0x0001)
    ) {
      return true;
    }
    // 100::/64 (Discard-only)
    if (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) return true;
    // 2001:0000::/32 (Teredo), 2001:0002::/32 (Benchmarking), 2001:db8::/32 (Documentation)
    if (g0 === 0x2001 && (g1 === 0x0000 || g1 === 0x0002 || g1 === 0x0db8)) return true;
    // 2002::/16 (6to4)
    if (g0 === 0x2002) return true;
    // fd00:ec2::254 (AWS IPv6 IMDS) & fc00::/7 (ULA)
    if ((g0 & 0xfe00) === 0xfc00) return true;
    // fe80::/10 (Link-local)
    if ((g0 & 0xffc0) === 0xfe80) return true;
    // ff00::/8 (Multicast)
    if ((g0 & 0xff00) === 0xff00) return true;

    return false;
  }

  return true;
}

export function isPrivateOrReservedIpv4(ip: string): boolean {
  const octets = parseIpv4Octets(ip);
  if (!octets) return true;
  const [a, b, c] = octets;

  if (isUnconditionallyBlockedIp(ip)) return true;
  if (a === 10) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 127) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;

  return false;
}

export function isPrivateOrReservedIp(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) {
    return isPrivateOrReservedIpv4(ip);
  }
  if (family === 6) {
    return isStrictLoopbackIp(ip) || isUnconditionallyBlockedIp(ip);
  }
  return true;
}

function normalizeUrlHostname(rawHostname: string): string {
  const lower = rawHostname.toLowerCase();
  if (lower.startsWith('[') && lower.endsWith(']')) {
    return lower.slice(1, -1);
  }
  return lower.replace(/\.$/, '');
}

function isLoopbackPermitted(options: ValidateUpstreamUrlOptions): boolean {
  const mode = options.mode ?? 'official-json';
  const testFlag = options.allowLocalhost === true || options.allowLocalhostForTests === true;
  if (testFlag) {
    return true;
  }
  if (mode === 'experimental-adapter') {
    return options.allowAdapterLoopback !== false;
  }
  return false;
}

/**
 * Synchronous URL structure, protocol, hostname, and IP-literal SSRF validator.
 * Ideal for synchronous schema/manifest/backup validation (`schema.ts`, `marketplace.ts`, `validation.ts`).
 */
export function validateSafeUpstreamUrlSync(
  rawUrl: unknown,
  options: ValidateUpstreamUrlOptions = {},
): UpstreamUrlValidationResult {
  if (typeof rawUrl !== 'string') {
    return { allowed: false, reason: 'URL must be a non-empty string.' };
  }
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.length > 2048 || /[\u0000-\u001f\u007f\s]/.test(trimmed)) {
    return { allowed: false, reason: 'URL is empty, oversized, or contains control/whitespace characters.' };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { allowed: false, reason: 'Malformed URL.' };
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return {
      allowed: false,
      reason: `Unsupported URL protocol "${parsed.protocol}". Expected https: (or http: for local sidecars).`,
    };
  }

  if (parsed.username !== '' || parsed.password !== '') {
    return {
      allowed: false,
      reason: 'Embedded credentials in upstream URLs are forbidden.',
    };
  }

  const host = normalizeUrlHostname(parsed.hostname);
  if (!host) {
    return { allowed: false, reason: 'URL hostname is empty.' };
  }

  // Unconditionally block cloud metadata & mDNS/internal suffixes regardless of mode or test flags
  if (
    BLOCKED_METADATA_HOSTNAMES.has(host) ||
    host.endsWith('.internal') ||
    host.endsWith('.local') ||
    host.includes('%')
  ) {
    return {
      allowed: false,
      reason: `Upstream hostname "${host}" is blocked by SSRF policy.`,
    };
  }

  const loopbackAllowed = isLoopbackPermitted(options);
  const literalFamily = net.isIP(host);

  if (host === 'localhost' || host.endsWith('.localhost')) {
    if (!loopbackAllowed) {
      return {
        allowed: false,
        reason: `Loopback hostname "${host}" is not permitted in ${options.mode ?? 'official-json'} mode.`,
      };
    }
    return {
      allowed: true,
      normalizedUrl: parsed.toString(),
      hostname: host,
    };
  }

  if (literalFamily === 4 || literalFamily === 6) {
    // 1. Unconditional block: Cloud IMDS (169.254.0.0/16, 100.100.100.200, fd00:ec2::254),
    //    0.0.0.0/8, IPv6 link-local (fe80::/10), ULA, and IPv6 transition ranges ALWAYS fail!
    if (isUnconditionallyBlockedIp(host)) {
      return {
        allowed: false,
        reason: `Upstream IP "${host}" is unconditionally blocked by SSRF policy (IMDS / link-local / transition range).`,
      };
    }

    // 2. Strict loopback (127.0.0.0/8 or ::1)
    if (isStrictLoopbackIp(host)) {
      if (!loopbackAllowed) {
        return {
          allowed: false,
          reason: `Loopback IP "${host}" is not permitted in ${options.mode ?? 'official-json'} mode.`,
        };
      }
      return {
        allowed: true,
        normalizedUrl: parsed.toString(),
        hostname: host,
        resolvedIps: [host],
      };
    }

    // 3. Remaining private/CGNAT ranges (10/8, 172.16/12, 192.168/16, 100.64/10) -> ALWAYS blocked
    if (isPrivateOrReservedIp(host)) {
      return {
        allowed: false,
        reason: `Private or reserved IP "${host}" is blocked by SSRF policy.`,
      };
    }

    // 4. Public IP literal must use HTTPS
    if (parsed.protocol !== 'https:') {
      return {
        allowed: false,
        reason: `Non-loopback upstream URL "${host}" must use https://.`,
      };
    }

    return {
      allowed: true,
      normalizedUrl: parsed.toString(),
      hostname: host,
      resolvedIps: [host],
    };
  }

  // Non-loopback domain names must always use HTTPS
  if (parsed.protocol !== 'https:') {
    return {
      allowed: false,
      reason: `Public upstream domain "${host}" must use https://.`,
    };
  }

  return {
    allowed: true,
    normalizedUrl: parsed.toString(),
    hostname: host,
  };
}

/**
 * Full async SSRF validator with DNS resolution check (prevents DNS rebinding / nip.io to IMDS or LAN).
 * Ready for `core/src/app.ts`, `core/src/router.ts`, and `core/src/models-sync.ts`.
 */
export async function validateSafeUpstreamUrl(
  rawUrl: unknown,
  options: ValidateUpstreamUrlOptions = {},
): Promise<UpstreamUrlValidationResult> {
  const syncCheck = validateSafeUpstreamUrlSync(rawUrl, options);
  if (!syncCheck.allowed || !syncCheck.hostname) {
    return syncCheck;
  }

  const host = syncCheck.hostname;
  if (options.resolveDns === false || net.isIP(host) !== 0) {
    return syncCheck;
  }

  const loopbackAllowed = isLoopbackPermitted(options);
  if (host === 'localhost' || host.endsWith('.localhost')) {
    return {
      ...syncCheck,
      resolvedIps: ['127.0.0.1'],
    };
  }

  const lookup =
    options.lookupFn ?? ((h: string) => dns.lookup(h, { all: true, verbatim: true }));

  let records: Array<{ address: string; family: number }>;
  try {
    records = await lookup(host);
  } catch {
    return {
      allowed: false,
      hostname: host,
      reason: `Unable to resolve upstream hostname "${host}".`,
    };
  }

  if (!records || records.length === 0) {
    return {
      allowed: false,
      hostname: host,
      reason: `No DNS records returned for upstream hostname "${host}".`,
    };
  }

  const resolvedIps: string[] = [];
  for (const rec of records) {
    const ip = rec.address;
    resolvedIps.push(ip);

    if (isUnconditionallyBlockedIp(ip)) {
      return {
        allowed: false,
        hostname: host,
        resolvedIps,
        reason: `Hostname "${host}" resolved to unconditionally blocked IP "${ip}" (IMDS / link-local / transition range).`,
      };
    }

    if (isStrictLoopbackIp(ip)) {
      if (!loopbackAllowed) {
        return {
          allowed: false,
          hostname: host,
          resolvedIps,
          reason: `Hostname "${host}" resolved to loopback IP "${ip}", which is blocked by SSRF policy.`,
        };
      }
      continue;
    }

    if (isPrivateOrReservedIp(ip)) {
      return {
        allowed: false,
        hostname: host,
        resolvedIps,
        reason: `Hostname "${host}" resolved to private/reserved IP "${ip}", which is blocked by SSRF policy.`,
      };
    }
  }

  return {
    ...syncCheck,
    resolvedIps,
  };
}

export async function assertSafeUpstreamUrl(
  rawUrl: unknown,
  options: ValidateUpstreamUrlOptions = {},
): Promise<string> {
  const check = await validateSafeUpstreamUrl(rawUrl, options);
  if (!check.allowed || !check.normalizedUrl) {
    throw new UpstreamSsrfError(check.reason ?? 'Upstream URL blocked by SSRF policy.');
  }
  return check.normalizedUrl;
}

export function assertSafeUpstreamUrlSync(
  rawUrl: unknown,
  options: ValidateUpstreamUrlOptions = {},
): string {
  const check = validateSafeUpstreamUrlSync(rawUrl, options);
  if (!check.allowed || !check.normalizedUrl) {
    throw new UpstreamSsrfError(check.reason ?? 'Upstream URL blocked by SSRF policy.');
  }
  return check.normalizedUrl;
}

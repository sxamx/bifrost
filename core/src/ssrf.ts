import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import zlib from 'node:zlib';

export type UpstreamUrlMode = 'official-json' | 'experimental-adapter';

export type DnsLookupFn = (
  hostname: string,
) => Promise<Array<{ address: string; family: number }>>;

export interface SafeFetchTlsOptions {
  ca?: string | Buffer | Array<string | Buffer>;
  rejectUnauthorized?: boolean;
  pinnedFingerprintSha256?: string;
}

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
   * NEVER bypasses Cloud IMDS (`169.254.0.0/16`, `192.0.0.192/32`, `100.100.100.200`, `fd00:ec2::254`), `0.0.0.0/8`,
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
  lookupFn?: DnsLookupFn;
  /** Alias for `lookupFn` for readability in test suites. */
  dnsLookup?: DnsLookupFn;
}

export interface SafeFetchOptions extends ValidateUpstreamUrlOptions {
  /** Optional fetch implementation (when a mocked function is passed in tests, DNS resolution is skipped unless `dnsLookup`/`lookupFn` is also passed). */
  fetchImpl?: typeof fetch;
  /** Optional TLS options (e.g. custom CA or fingerprint pinning). */
  upstreamTls?: SafeFetchTlsOptions;
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
  'metadata.azure.internal',
  'metadata.tencentyun.com',
]);

export function isBlockedMetadataHostname(rawHostname: string): boolean {
  const host = normalizeUrlHostname(rawHostname);
  if (!host) return true;
  return (
    BLOCKED_METADATA_HOSTNAMES.has(host) ||
    host.endsWith('.internal') ||
    host.endsWith('.local') ||
    host.includes('%')
  );
}

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
    // Oracle Cloud IMDS (192.0.0.192/32) and IETF protocol assignments (192.0.0.0/24) / TEST-NET-1 (192.0.2.0/24)
    if (a === 192 && b === 0 && c === 0 && d === 192) return true;
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

export function isTailscaleCgnatIpv4(ip: string): boolean {
  if (net.isIP(ip) !== 4) return false;
  const octets = parseIpv4Octets(ip);
  if (!octets) return false;
  const [a, b, c, d] = octets;
  // Exclude Alibaba Cloud IMDS (100.100.100.200) inside 100.64.0.0/10
  if (a === 100 && b === 100 && c === 100 && d === 200) return false;
  return a === 100 && b >= 64 && b <= 127;
}

export function isExactAdapterLoopbackHost(rawHost: string): boolean {
  const host = normalizeUrlHostname(rawHost);
  if (host === 'localhost') return true;
  if (host === '127.0.0.1') return true;
  if (net.isIP(host) === 6 && isStrictLoopbackIp(host)) return true;
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
  return lower.replace(/\.+$/, '');
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

  const rawHostNoBrackets =
    parsed.hostname.startsWith('[') && parsed.hostname.endsWith(']')
      ? parsed.hostname.slice(1, -1)
      : parsed.hostname;
  if (rawHostNoBrackets.includes('..') || rawHostNoBrackets.startsWith('.')) {
    return {
      allowed: false,
      reason: `Upstream hostname "${parsed.hostname}" contains empty DNS labels and is blocked by SSRF policy.`,
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

  // Reject numeric/hex IP obfuscation and single-label hostnames (e.g. Docker service names like "watchtower", "redis", "postgres")
  if (/^(0x[0-9a-f]+|\d+)$/i.test(host)) {
    return {
      allowed: false,
      reason: `Numeric/hex IP obfuscation hostname "${host}" is blocked by SSRF policy.`,
    };
  }

  if (!host.includes('.')) {
    return {
      allowed: false,
      reason: `Single-label hostname "${host}" is blocked by SSRF policy.`,
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
 * Ready for `core/src/app.ts`, `core/src/router.ts`, `core/src/marketplace.ts`, and `core/src/models-sync.ts`.
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
  const customLookup = options.lookupFn ?? options.dnsLookup;
  if (host === 'localhost' || host.endsWith('.localhost')) {
    if (customLookup) {
      let localRecords: Array<{ address: string; family: number }>;
      try {
        localRecords = await customLookup(host);
      } catch {
        return {
          allowed: false,
          hostname: host,
          reason: `Unable to resolve upstream hostname "${host}".`,
        };
      }
      const validLoopbacks = localRecords
        .map((r) => r.address)
        .filter((ip) => isStrictLoopbackIp(ip));
      if (validLoopbacks.length === 0 || validLoopbacks.length !== localRecords.length) {
        return {
          allowed: false,
          hostname: host,
          resolvedIps: localRecords.map((r) => r.address),
          reason: `Loopback hostname "${host}" resolved to a non-loopback address.`,
        };
      }
      return {
        ...syncCheck,
        resolvedIps: validLoopbacks,
      };
    }
    return {
      ...syncCheck,
      resolvedIps: ['127.0.0.1', '::1'],
    };
  }

  const lookup =
    customLookup ?? ((h: string) => dns.lookup(h, { all: true, verbatim: true }));

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

function normalizeTlsFingerprint(fp: string): string {
  return fp.replace(/:/g, '').replace(/\s+/g, '').toUpperCase();
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function bodyInitToBuffer(body: RequestInit['body']): Promise<Buffer | undefined> {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  if (Buffer.isBuffer(body)) return body;
  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  }
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (body instanceof URLSearchParams) {
    return Buffer.from(body.toString(), 'utf8');
  }
  if (typeof Blob !== 'undefined' && body instanceof Blob) {
    return Buffer.from(await body.arrayBuffer());
  }
  throw new TypeError('Unsupported request body type for safeFetch.');
}

export interface PinnedAddressRecord {
  address: string;
  family: 4 | 6;
}

export function createPinnedLookup(
  pinnedIps: ReadonlyArray<string | PinnedAddressRecord>,
): NonNullable<http.RequestOptions['lookup']> {
  const normalized: PinnedAddressRecord[] = [];
  const seen = new Set<string>();
  for (const entry of pinnedIps) {
    const address = typeof entry === 'string' ? entry : entry.address;
    if (seen.has(address)) continue;
    const detected = net.isIP(address);
    const family: 4 | 6 | 0 =
      typeof entry === 'string'
        ? detected === 6
          ? 6
          : detected === 4
            ? 4
            : 0
        : entry.family;
    if (family !== 4 && family !== 6) continue;
    seen.add(address);
    normalized.push({ address, family });
  }

  return (hostname, opts, callback) => {
    const optsObj = typeof opts === 'object' && opts !== null ? opts : undefined;
    const requestedFamily =
      typeof opts === 'number'
        ? opts
        : typeof optsObj?.family === 'number'
          ? optsObj.family
          : 0;
    const matching =
      requestedFamily === 4 || requestedFamily === 6
        ? normalized.filter((r) => r.family === requestedFamily)
        : normalized;

    if (matching.length === 0) {
      const err = new Error(
        `No pinned IP address available for "${hostname}" (family=${requestedFamily}).`,
      ) as NodeJS.ErrnoException;
      err.code = 'ENOTFOUND';
      callback(err, '', 0);
      return;
    }

    if (optsObj?.all === true) {
      (callback as (err: NodeJS.ErrnoException | null, addresses: PinnedAddressRecord[]) => void)(
        null,
        matching.map((r) => ({ address: r.address, family: r.family })),
      );
      return;
    }

    const first = matching[0]!;
    callback(null, first.address, first.family);
  };
}

/**
 * Executes an HTTP/HTTPS request strictly pinned to pre-validated IP addresses
 * (mitigating DNS rebinding / TOCTOU while preserving Happy Eyeballs fallback,
 * original Host header, and TLS SNI).
 */
async function pinnedHttpFetch(
  normalizedUrl: string,
  pinnedIps: ReadonlyArray<string>,
  init: RequestInit | undefined,
  upstreamTls?: SafeFetchTlsOptions,
): Promise<Response> {
  const parsed = new URL(normalizedUrl);
  const isHttps = parsed.protocol === 'https:';
  const rawHost = parsed.hostname.replace(/^\[|\]$/g, '');
  const targetPort = parsed.port ? Number(parsed.port) : isHttps ? 443 : 80;
  const method = (init?.method ?? 'GET').toUpperCase();

  const reqHeaders: Record<string, string> = {};
  const seenLower = new Set<string>();
  if (init?.headers) {
    const h = new Headers(init.headers);
    h.forEach((value, key) => {
      const lower = key.toLowerCase();
      if (lower === 'host') return;
      seenLower.add(lower);
      reqHeaders[key] = value;
    });
  }
  if (!seenLower.has('connection')) {
    reqHeaders.Connection = 'close';
  }

  const bodyBuffer = await bodyInitToBuffer(init?.body);
  if (bodyBuffer !== undefined && !seenLower.has('content-length')) {
    reqHeaders['Content-Length'] = String(bodyBuffer.byteLength);
  }

  const pathWithQuery = `${parsed.pathname || '/'}${parsed.search || ''}`;
  const pinnedLookup = createPinnedLookup(pinnedIps);
  const redirectMode = init?.redirect ?? 'error';

  const getAbortError = (): Error =>
    init?.signal?.reason instanceof Error
      ? init.signal.reason
      : new Error('The operation was aborted.');

  if (init?.signal?.aborted) {
    throw getAbortError();
  }

  return new Promise<Response>((resolve, reject) => {
    let headersResolved = false;
    let clientReq: http.ClientRequest;
    let bodyAbortHandler: ((reason: Error) => void) | null = null;

    const cleanupAbort = () => {
      if (init?.signal) {
        init.signal.removeEventListener('abort', onAbort);
      }
    };

    const failEarly = (err: Error) => {
      cleanupAbort();
      if (!headersResolved) {
        headersResolved = true;
        reject(err);
      }
    };

    const onAbort = () => {
      const reason = getAbortError();
      if (bodyAbortHandler) {
        bodyAbortHandler(reason);
        return;
      }
      clientReq?.destroy(reason);
      failEarly(reason);
    };

    const onIncomingResponse = (res: http.IncomingMessage) => {
      const status = res.statusCode ?? 502;

      if (redirectMode === 'error' && isRedirectStatus(status)) {
        res.destroy();
        failEarly(new Error(`Upstream returned redirect HTTP ${status} (redirect: error).`));
        return;
      }

      headersResolved = true;

      // Return early for bodyless responses BEFORE instantiating any zlib transform
      // so an empty body with Content-Encoding never triggers an uncaught zlib error.
      if (status === 204 || status === 205 || status === 304 || method === 'HEAD') {
        cleanupAbort();
        const emptyHeaders = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          if (v === undefined) continue;
          if (Array.isArray(v)) {
            for (const item of v) emptyHeaders.append(k, item);
          } else {
            emptyHeaders.set(k, v);
          }
        }
        res.resume();
        resolve(new Response(null, { status, headers: emptyHeaders }));
        return;
      }

      const rawEncoding = String(res.headers['content-encoding'] ?? '')
        .trim()
        .toLowerCase();
      let zlibStream: zlib.Gunzip | zlib.Inflate | zlib.BrotliDecompress | null = null;
      let decodedStream: NodeJS.ReadableStream = res;
      let decompressed = false;
      if (rawEncoding === 'gzip' || rawEncoding === 'x-gzip') {
        zlibStream = zlib.createGunzip();
        res.pipe(zlibStream);
        decodedStream = zlibStream;
        decompressed = true;
      } else if (rawEncoding === 'deflate') {
        zlibStream = zlib.createInflate();
        res.pipe(zlibStream);
        decodedStream = zlibStream;
        decompressed = true;
      } else if (rawEncoding === 'br') {
        zlibStream = zlib.createBrotliDecompress();
        res.pipe(zlibStream);
        decodedStream = zlibStream;
        decompressed = true;
      }

      const responseHeaders = new Headers();
      for (const [k, v] of Object.entries(res.headers)) {
        if (v === undefined) continue;
        const lower = k.toLowerCase();
        if (decompressed && (lower === 'content-encoding' || lower === 'content-length')) {
          continue;
        }
        if (Array.isArray(v)) {
          for (const item of v) responseHeaders.append(k, item);
        } else {
          responseHeaders.set(k, v);
        }
      }

      const destroyStreams = (err?: Error) => {
        if (zlibStream && !zlibStream.destroyed) {
          zlibStream.destroy(err);
        }
        if (!res.destroyed) {
          res.destroy(err);
        }
        if (!clientReq.destroyed) {
          clientReq.destroy(err);
        }
      };

      let streamClosed = false;
      const webStream = new ReadableStream<Uint8Array>({
        start(controller) {
          const finishError = (err: Error) => {
            if (streamClosed) return;
            streamClosed = true;
            bodyAbortHandler = null;
            cleanupAbort();
            try {
              controller.error(err);
            } catch {
              // Ignore already closed controller
            }
            destroyStreams();
          };

          bodyAbortHandler = (reason: Error) => {
            finishError(reason);
          };

          if (init?.signal?.aborted) {
            finishError(getAbortError());
            return;
          }

          const onData = (chunk: Buffer | string) => {
            if (streamClosed) return;
            try {
              const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
              controller.enqueue(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
            } catch {
              streamClosed = true;
              bodyAbortHandler = null;
              cleanupAbort();
              destroyStreams();
            }
          };
          const onEnd = () => {
            if (streamClosed) return;
            streamClosed = true;
            bodyAbortHandler = null;
            cleanupAbort();
            try {
              controller.close();
            } catch {
              // Ignore already closed controller
            }
          };
          const onErr = (err: Error) => {
            finishError(err);
          };
          const onClose = () => {
            if (!streamClosed && !res.complete) {
              finishError(new Error('Upstream stream closed prematurely'));
            }
          };
          decodedStream.on('data', onData);
          decodedStream.once('end', onEnd);
          decodedStream.once('error', onErr);
          res.once('error', onErr);
          res.once('close', onClose);
        },
        cancel() {
          streamClosed = true;
          bodyAbortHandler = null;
          cleanupAbort();
          destroyStreams();
        },
      });

      resolve(new Response(webStream, { status, headers: responseHeaders }));
    };

    if (isHttps) {
      const pinnedTargetFp = upstreamTls?.pinnedFingerprintSha256
        ? normalizeTlsFingerprint(upstreamTls.pinnedFingerprintSha256)
        : null;
      const shouldVerifyCa =
        pinnedTargetFp !== null ? false : (upstreamTls?.rejectUnauthorized ?? true);

      clientReq = https.request(
        {
          hostname: rawHost,
          port: targetPort,
          path: pathWithQuery,
          method,
          headers: reqHeaders,
          agent: false,
          lookup: pinnedLookup,
          servername: net.isIP(rawHost) ? undefined : rawHost,
          ca: upstreamTls?.ca,
          rejectUnauthorized: shouldVerifyCa,
        },
        onIncomingResponse,
      );

      if (pinnedTargetFp !== null) {
        clientReq.once('socket', (sock) => {
          sock.setNoDelay(true);
          if (sock instanceof tls.TLSSocket) {
            sock.once('secureConnect', () => {
              const peer = sock.getPeerCertificate();
              const actualFp = peer?.fingerprint256
                ? normalizeTlsFingerprint(peer.fingerprint256)
                : '';
              if (!actualFp || actualFp !== pinnedTargetFp) {
                sock.destroy(new Error('Upstream TLS certificate fingerprint mismatch'));
              }
            });
          }
        });
      } else {
        clientReq.once('socket', (sock) => {
          sock.setNoDelay(true);
        });
      }
    } else {
      clientReq = http.request(
        {
          hostname: rawHost,
          port: targetPort,
          path: pathWithQuery,
          method,
          headers: reqHeaders,
          agent: false,
          lookup: pinnedLookup,
        },
        onIncomingResponse,
      );
      clientReq.once('socket', (sock) => {
        sock.setNoDelay(true);
      });
    }

    if (init?.signal) {
      init.signal.addEventListener('abort', onAbort, { once: true });
    }

    clientReq.on('error', failEarly);
    if (bodyBuffer) {
      clientReq.write(bodyBuffer);
    }
    clientReq.end();
  });
}

/**
 * SSRF-hardened `fetch` wrapper with DNS validation and resolved IP pinning.
 * - Always validates the target URL against `ssrf.ts` policy before any outbound request.
 * - When `fetchImpl` is a mocked function injected by tests (and no `dnsLookup`/`lookupFn` is provided),
 *   runs synchronous SSRF validation and delegates to the mocked `fetchImpl` without real OS DNS.
 * - When `dnsLookup`/`lookupFn` is injected OR when executing a real network request (`globalThis.fetch`),
 *   runs full async DNS validation (`validateSafeUpstreamUrl`), and for real network requests pins the
 *   TCP/TLS connection directly to the approved IPs (preserving Happy Eyeballs fallback) to prevent DNS rebinding.
 */
export async function safeFetch(
  rawUrl: string,
  init?: RequestInit,
  options: SafeFetchOptions = {},
): Promise<Response> {
  const customFetch =
    options.fetchImpl && options.fetchImpl !== globalThis.fetch ? options.fetchImpl : undefined;
  const effectiveLookup = options.lookupFn ?? options.dnsLookup;

  if (customFetch && !effectiveLookup) {
    const normalizedUrl = assertSafeUpstreamUrlSync(rawUrl, options);
    return customFetch(normalizedUrl, { ...init, redirect: 'error' });
  }

  const check = await validateSafeUpstreamUrl(rawUrl, {
    ...options,
    lookupFn: effectiveLookup,
  });
  if (!check.allowed || !check.normalizedUrl) {
    throw new UpstreamSsrfError(check.reason ?? 'Upstream URL blocked by SSRF policy.');
  }

  if (customFetch) {
    return customFetch(check.normalizedUrl, { ...init, redirect: 'error' });
  }

  const pinnedIps = check.resolvedIps ?? [];
  if (pinnedIps.length === 0) {
    throw new UpstreamSsrfError(
      `Unable to pin resolved IP for upstream "${check.hostname ?? rawUrl}".`,
    );
  }

  return pinnedHttpFetch(check.normalizedUrl, pinnedIps, init, options.upstreamTls);
}

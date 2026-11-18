import net from 'node:net';
import type { ProviderPackageType } from './schema.js';

const FORBIDDEN_HOSTNAMES = new Set<string>([
  'metadata.google.internal',
  'metadata.goog',
  'metadata',
  'instance-data',
  'metadata.azure.internal',
  'metadata.tencentyun.com',
]);

export interface UrlSecurityValidationResult {
  valid: boolean;
  normalizedUrl?: string;
  error?: string;
}

function parseIpv4Uint32(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let acc = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    acc = ((acc << 8) | n) >>> 0;
  }
  return acc >>> 0;
}

function parseIpv6Groups(rawHost: string): number[] | null {
  let addr = rawHost.toLowerCase();
  if (addr.includes('%')) {
    return null;
  }

  const lastColon = addr.lastIndexOf(':');
  if (lastColon !== -1 && addr.slice(lastColon + 1).includes('.')) {
    const ipv4Part = addr.slice(lastColon + 1);
    const ipv4Num = parseIpv4Uint32(ipv4Part);
    if (ipv4Num === null) return null;
    const hi = ((ipv4Num >>> 16) & 0xffff).toString(16);
    const lo = (ipv4Num & 0xffff).toString(16);
    const prefix = addr.slice(0, lastColon);
    addr = prefix.endsWith(':') ? `${prefix}${hi}:${lo}` : `${prefix}:${hi}:${lo}`;
  }

  const doubleColonParts = addr.split('::');
  if (doubleColonParts.length > 2) return null;

  const parseSegmentList = (seg: string): number[] | null => {
    if (seg === '') return [];
    const tokens = seg.split(':');
    const out: number[] = [];
    for (const tok of tokens) {
      if (!/^[0-9a-f]{1,4}$/.test(tok)) return null;
      out.push(Number.parseInt(tok, 16));
    }
    return out;
  };

  if (doubleColonParts.length === 2) {
    const left = parseSegmentList(doubleColonParts[0]!);
    const right = parseSegmentList(doubleColonParts[1]!);
    if (!left || !right) return null;
    const missing = 8 - (left.length + right.length);
    if (missing < 1) return null;
    return [...left, ...new Array<number>(missing).fill(0), ...right];
  }

  const full = parseSegmentList(addr);
  if (!full || full.length !== 8) return null;
  return full;
}

type HostClassification =
  | { kind: 'forbidden'; reason: string }
  | { kind: 'rfc1918'; reason: string }
  | { kind: 'loopback'; exactLoopbackAdapterAllowed: boolean }
  | { kind: 'public' };

function classifyIpv4(ip: number): HostClassification {
  if ((ip >>> 24) === 0) {
    return { kind: 'forbidden', reason: 'unspecified range 0.0.0.0/8 is forbidden' };
  }
  if ((ip >>> 16) === 0xa9fe) {
    return {
      kind: 'forbidden',
      reason: 'cloud metadata / link-local range 169.254.0.0/16 is forbidden',
    };
  }
  if (((ip & 0xffc00000) >>> 0) === 0x64400000) {
    return {
      kind: 'forbidden',
      reason: 'CGNAT / Tailscale / cloud metadata range 100.64.0.0/10 is forbidden',
    };
  }
  if (((ip & 0xe0000000) >>> 0) === 0xe0000000) {
    return {
      kind: 'forbidden',
      reason: 'multicast / reserved IPv4 range 224.0.0.0/3 is forbidden',
    };
  }
  if (
    ((ip & 0xffffff00) >>> 0) === 0xc0000000 ||
    ((ip & 0xffffff00) >>> 0) === 0xc0000200 ||
    ((ip & 0xfffe0000) >>> 0) === 0xc6120000 ||
    ((ip & 0xffffff00) >>> 0) === 0xc6336400 ||
    ((ip & 0xffffff00) >>> 0) === 0xcb007100
  ) {
    return { kind: 'forbidden', reason: 'reserved IANA special-purpose IPv4 range is forbidden' };
  }
  if ((ip >>> 24) === 127) {
    return { kind: 'loopback', exactLoopbackAdapterAllowed: ip === 0x7f000001 };
  }
  if (
    (ip >>> 24) === 10 ||
    ((ip & 0xfff00000) >>> 0) === 0xac100000 ||
    (ip >>> 16) === 0xc0a8
  ) {
    return { kind: 'rfc1918', reason: 'RFC1918 private network addresses are forbidden' };
  }
  return { kind: 'public' };
}

function classifyHostname(rawHostname: string): HostClassification {
  if (rawHostname.includes('%')) {
    return { kind: 'forbidden', reason: 'IPv6 zone identifiers are forbidden' };
  }

  let host = rawHostname.trim().toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) {
    host = host.slice(1, -1);
  }
  host = host.replace(/\.+$/, '');

  if (!host) {
    return { kind: 'forbidden', reason: 'empty hostname' };
  }

  if (FORBIDDEN_HOSTNAMES.has(host) || host.endsWith('.internal')) {
    return { kind: 'forbidden', reason: `metadata/internal hostname "${host}" is forbidden` };
  }

  if (host === 'localhost' || host.endsWith('.localhost')) {
    return { kind: 'loopback', exactLoopbackAdapterAllowed: host === 'localhost' };
  }

  const ipVersion = net.isIP(host);
  if (ipVersion === 4) {
    const num = parseIpv4Uint32(host);
    if (num === null) {
      return { kind: 'forbidden', reason: 'malformed IPv4 literal' };
    }
    return classifyIpv4(num);
  }

  if (ipVersion === 6) {
    const g = parseIpv6Groups(host);
    if (!g) {
      return { kind: 'forbidden', reason: 'malformed IPv6 literal' };
    }

    if (g.every((x) => x === 0)) {
      return { kind: 'forbidden', reason: 'unspecified IPv6 address :: is forbidden' };
    }

    if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) {
      return { kind: 'loopback', exactLoopbackAdapterAllowed: true };
    }

    if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
      const mappedIpv4 = ((g[6]! << 16) | g[7]!) >>> 0;
      return classifyIpv4(mappedIpv4);
    }

    if (g.slice(0, 6).every((x) => x === 0)) {
      return { kind: 'forbidden', reason: 'deprecated IPv4-compatible IPv6 address is forbidden' };
    }

    if (g[0] === 0x0064 && g[1] === 0xff9b) {
      return { kind: 'forbidden', reason: 'NAT64 translation prefix 64:ff9b:: is forbidden' };
    }

    if (g[0] === 0x2002) {
      return { kind: 'forbidden', reason: '6to4 tunnel prefix 2002::/16 is forbidden' };
    }

    if (g[0] === 0x2001 && g[1] === 0x0000) {
      return { kind: 'forbidden', reason: 'Teredo tunnel prefix 2001:0000::/32 is forbidden' };
    }

    if (g[0] === 0x2001 && g[1] === 0x0db8) {
      return { kind: 'forbidden', reason: 'documentation IPv6 prefix 2001:db8::/32 is forbidden' };
    }

    if ((g[0]! & 0xffc0) === 0xfe80) {
      return { kind: 'forbidden', reason: 'IPv6 link-local range fe80::/10 is forbidden' };
    }

    if ((g[0]! & 0xfe00) === 0xfc00) {
      return {
        kind: 'forbidden',
        reason:
          'IPv6 unique-local / cloud metadata range fc00::/7 (including fd00:ec2::254) is forbidden',
      };
    }

    if ((g[0]! & 0xff00) === 0xff00) {
      return { kind: 'forbidden', reason: 'IPv6 multicast range ff00::/8 is forbidden' };
    }

    return { kind: 'public' };
  }

  if (/^(0x[0-9a-f]+|\d+)$/i.test(host)) {
    return { kind: 'forbidden', reason: 'numeric/hex IP obfuscation hostname is forbidden' };
  }

  return { kind: 'public' };
}

function allowLocalOfficialUpstreams(): boolean {
  if (process.env.BIFROST_ALLOW_LOCAL_UPSTREAMS === '0') {
    return false;
  }
  return (
    process.env.BIFROST_ALLOW_LOCAL_UPSTREAMS === '1' ||
    process.env.NODE_ENV === 'test' ||
    Boolean(process.env.NODE_TEST_CONTEXT)
  );
}

function allowLocalExperimentalAdapters(): boolean {
  return process.env.BIFROST_ALLOW_LOCAL_ADAPTERS !== '0';
}

export function validateProviderTargetUrl(
  rawUrl: string,
  packageType: ProviderPackageType,
  fieldLabel: 'baseUrl' | 'adapterUrl' = 'baseUrl',
): UrlSecurityValidationResult {
  if (typeof rawUrl !== 'string' || rawUrl.trim().length === 0 || /\s/.test(rawUrl)) {
    return { valid: false, error: `${fieldLabel} must be a non-empty URL without whitespace.` };
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { valid: false, error: `${fieldLabel} is not a valid URL.` };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { valid: false, error: `${fieldLabel} must use http:// or https:// protocol.` };
  }

  if (parsed.username || parsed.password) {
    return {
      valid: false,
      error: `${fieldLabel} must not contain embedded userinfo credentials (username/password).`,
    };
  }

  const hostClass = classifyHostname(parsed.hostname);
  if (hostClass.kind === 'forbidden' || hostClass.kind === 'rfc1918') {
    return {
      valid: false,
      error: `${fieldLabel} rejected (SSRF protection): ${hostClass.reason}.`,
    };
  }

  if (packageType === 'official-json') {
    if (hostClass.kind === 'loopback') {
      if (!allowLocalOfficialUpstreams()) {
        return {
          valid: false,
          error: `${fieldLabel} for official-json providers cannot target loopback addresses in production.`,
        };
      }
      return { valid: true, normalizedUrl: parsed.href.replace(/\/+$/, '') };
    }

    if (parsed.protocol !== 'https:') {
      return {
        valid: false,
        error: `${fieldLabel} for official-json providers must use https://.`,
      };
    }

    return { valid: true, normalizedUrl: parsed.href.replace(/\/+$/, '') };
  }

  if (hostClass.kind === 'loopback') {
    if (!allowLocalExperimentalAdapters() || !hostClass.exactLoopbackAdapterAllowed) {
      return {
        valid: false,
        error: `${fieldLabel} loopback target is disabled or not an explicit loopback host (127.0.0.1, ::1, localhost).`,
      };
    }
    return { valid: true, normalizedUrl: parsed.href.replace(/\/+$/, '') };
  }

  if (parsed.protocol !== 'https:') {
    return {
      valid: false,
      error: `${fieldLabel} for remote experimental-adapter endpoints must use https://.`,
    };
  }

  return { valid: true, normalizedUrl: parsed.href.replace(/\/+$/, '') };
}

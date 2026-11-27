import type { ProviderPackageType } from './schema.js';
import {
  isExactAdapterLoopbackHost,
  isStrictLoopbackIp,
  validateSafeUpstreamUrlSync,
} from './ssrf.js';

export interface UrlSecurityValidationResult {
  valid: boolean;
  normalizedUrl?: string;
  error?: string;
}

export function allowLocalOfficialUpstreams(): boolean {
  if (process.env.BIFROST_ALLOW_LOCAL_UPSTREAMS === '0') {
    return false;
  }
  return (
    process.env.BIFROST_ALLOW_LOCAL_UPSTREAMS === '1' ||
    process.env.NODE_ENV === 'test' ||
    Boolean(process.env.NODE_TEST_CONTEXT)
  );
}

export function allowLocalExperimentalAdapters(): boolean {
  return process.env.BIFROST_ALLOW_LOCAL_ADAPTERS !== '0';
}

export function validateProviderTargetUrl(
  rawUrl: string,
  packageType: ProviderPackageType,
  fieldLabel: 'baseUrl' | 'adapterUrl' = 'baseUrl',
  options?: { allowLoopback?: boolean },
): UrlSecurityValidationResult {
  if (typeof rawUrl !== 'string' || rawUrl.trim().length === 0 || /\s/.test(rawUrl)) {
    return { valid: false, error: `${fieldLabel} must be a non-empty URL without whitespace.` };
  }

  if (packageType === 'official-json') {
    const loopbackAllowed =
      options?.allowLoopback !== undefined ? options.allowLoopback : allowLocalOfficialUpstreams();
    const check = validateSafeUpstreamUrlSync(rawUrl, {
      mode: 'official-json',
      allowLocalhost: loopbackAllowed,
    });
    if (!check.allowed || !check.normalizedUrl) {
      return {
        valid: false,
        error: `${fieldLabel} rejected (SSRF protection): ${check.reason ?? 'forbidden target URL'}`,
      };
    }
    return { valid: true, normalizedUrl: check.normalizedUrl.replace(/\/+$/, '') };
  }

  const adapterLoopbackAllowed = allowLocalExperimentalAdapters();
  const check = validateSafeUpstreamUrlSync(rawUrl, {
    mode: 'experimental-adapter',
    allowAdapterLoopback: adapterLoopbackAllowed,
    allowLocalhost: options?.allowLoopback === true,
  });
  if (!check.allowed || !check.normalizedUrl) {
    return {
      valid: false,
      error: `${fieldLabel} rejected (SSRF protection): ${check.reason ?? 'forbidden target URL'}`,
    };
  }

  const host = check.hostname ?? '';
  const isLoopback =
    host === 'localhost' || host.endsWith('.localhost') || isStrictLoopbackIp(host);
  if (isLoopback && options?.allowLoopback !== true && !isExactAdapterLoopbackHost(host)) {
    return {
      valid: false,
      error: `${fieldLabel} loopback target is disabled or not an explicit loopback host (127.0.0.1, ::1, localhost).`,
    };
  }

  return { valid: true, normalizedUrl: check.normalizedUrl.replace(/\/+$/, '') };
}

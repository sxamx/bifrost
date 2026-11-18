import type { DatabaseSync } from 'node:sqlite';
import {
  BIFROST_USER_AGENT,
  type FetchLike,
  readExternalCache,
  writeExternalCache,
} from './cache.js';

export const MODELS_DEV_LOGOS_BASE_URL = 'https://models.dev/logos';
export const LOGO_CACHE_TTL_SEC = 7 * 86400; // 7 days (persisted offline in SQLite)

export type ProviderLogoResult =
  | {
      hasLogo: true;
      slug: string;
      svg: string;
    }
  | {
      hasLogo: false;
      slug: string;
      initial: string;
    };

export function deriveFallbackInitial(nameOrSlug: string): string {
  const match = /[A-Za-z0-9]/.exec(nameOrSlug.trim());
  return match ? match[0]!.toUpperCase() : '?';
}

/**
 * Strictly sanitizes an untrusted SVG string against XSS / external network leaks
 * and normalizes all visible fill/stroke colors to `currentColor` so Bifrost's UI
 * renders logos uniformly in `--sub`.
 */
export function sanitizeAndMonochromeSvg(rawSvg: string): string | null {
  if (typeof rawSvg !== 'string' || rawSvg.length === 0 || rawSvg.length > 256 * 1024) {
    return null;
  }

  const svgMatch = /<svg\b[\s\S]*?<\/svg>/i.exec(rawSvg);
  if (!svgMatch) {
    return null;
  }

  let svg = svgMatch[0]!;

  // 1. Remove dangerous paired elements and their contents completely
  const forbiddenTags = [
    'script',
    'foreignObject',
    'iframe',
    'object',
    'embed',
    'applet',
    'audio',
    'video',
    'style',
    'link',
    'meta',
  ];
  for (const tag of forbiddenTags) {
    const pairedRe = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi');
    const selfClosingRe = new RegExp(`<${tag}\\b[^>]*\\/?>`, 'gi');
    svg = svg.replace(pairedRe, '').replace(selfClosingRe, '');
  }

  // 2. Remove <image> tags and external <use> references to prevent tracking/SSRF
  svg = svg.replace(/<image\b[^>]*>[\s\S]*?<\/image>/gi, '');
  svg = svg.replace(/<image\b[^>]*\/?>/gi, '');
  svg = svg.replace(
    /\s(?:xlink:)?href\s*=\s*(?:"(?!#)[^"]*"|'(?!#)[^']*'|[^\s>#][^\s>]*)/gi,
    '',
  );

  // 3. Strip all inline event handlers (onload, onclick, onerror, onmouseover, etc.)
  svg = svg.replace(/\son[a-z0-9_-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');

  // 4. Strip any remaining javascript: or data: URIs in attributes
  svg = svg.replace(
    /\s[a-z0-9:_-]+\s*=\s*(?:"\s*(?:javascript|data):[^"]*"|'\s*(?:javascript|data):[^']*'|(?:\s*(?:javascript|data):[^\s>]+))/gi,
    '',
  );

  // 5. Strip inline style="..." attributes that could force third-party colors or url(...)
  svg = svg.replace(/\sstyle\s*=\s*(?:"[^"]*"|'[^']*')/gi, '');

  // 6. Normalize non-"none"/"transparent" fill and stroke attributes to "currentColor"
  svg = svg.replace(
    /\b(fill|stroke)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi,
    (_full, attrName: string, dqVal?: string, sqVal?: string) => {
      const val = (dqVal ?? sqVal ?? '').trim().toLowerCase();
      if (val === 'none' || val === 'transparent') {
        return `${attrName}="${val}"`;
      }
      return `${attrName}="currentColor"`;
    },
  );

  // 7. Ensure root <svg> tag defaults to fill="currentColor" if no fill attribute is set on it
  svg = svg.replace(/^<svg\b([^>]*)>/i, (_full, attrs: string) => {
    if (/\bfill\s*=/i.test(attrs)) {
      return `<svg${attrs}>`;
    }
    return `<svg${attrs} fill="currentColor">`;
  });

  return svg.trim();
}

export function normalizeLogoSlug(slug: string): string | null {
  const cleaned = slug.trim().toLowerCase().replace(/\.svg$/i, '');
  if (cleaned === 'nvidia-nim') return 'nvidia';
  if (cleaned === 'opencode-zen') return 'opencode';
  if (!/^[a-z0-9-]+$/.test(cleaned)) {
    return null;
  }
  return cleaned;
}

/**
 * HU-14b: Retrieves a sanitized, `currentColor`-normalized SVG logo for a provider
 * or benchmark source, caching it in SQLite (`external_cache` key `logo:{slug}`)
 * so logos work 100% offline after initial fetch, or returning an initial badge fallback.
 */
export async function getProviderLogo(
  db: DatabaseSync,
  providerSlug: string,
  options: {
    displayName?: string;
    fetchFn?: FetchLike;
    nowSec?: number;
    ttlSec?: number;
    forceRefresh?: boolean;
  } = {},
): Promise<ProviderLogoResult> {
  const initial = deriveFallbackInitial(options.displayName ?? providerSlug);
  const normalizedSlug = normalizeLogoSlug(providerSlug);
  if (!normalizedSlug) {
    return { hasLogo: false, slug: providerSlug, initial };
  }

  const cacheKey = `logo:${normalizedSlug}`;
  const nowSec = options.nowSec ?? Math.floor(Date.now() / 1000);
  const ttlSec = options.ttlSec ?? LOGO_CACHE_TTL_SEC;
  const fetchFn = options.fetchFn ?? globalThis.fetch;

  const cached = readExternalCache<ProviderLogoResult>(db, cacheKey);
  if (cached && !options.forceRefresh && nowSec - cached.fetchedAt < ttlSec) {
    if (!cached.data.hasLogo) {
      return { hasLogo: false, slug: normalizedSlug, initial };
    }
    return cached.data;
  }

  try {
    const url = `${MODELS_DEV_LOGOS_BASE_URL}/${normalizedSlug}.svg`;
    const res = await fetchFn(url, {
      headers: {
        'User-Agent': BIFROST_USER_AGENT,
        Accept: 'image/svg+xml,text/plain,*/*',
      },
      signal: AbortSignal.timeout(3000),
    });

    if (res.status === 404) {
      const notFoundResult: ProviderLogoResult = {
        hasLogo: false,
        slug: normalizedSlug,
        initial,
      };
      writeExternalCache(db, cacheKey, notFoundResult, null, nowSec);
      return notFoundResult;
    }

    if (!res.ok) {
      if (cached) return cached.data;
      return { hasLogo: false, slug: normalizedSlug, initial };
    }

    const rawText = await res.text();
    const sanitized = sanitizeAndMonochromeSvg(rawText);
    if (!sanitized) {
      const invalidResult: ProviderLogoResult = {
        hasLogo: false,
        slug: normalizedSlug,
        initial,
      };
      writeExternalCache(db, cacheKey, invalidResult, null, nowSec);
      return invalidResult;
    }

    const okResult: ProviderLogoResult = {
      hasLogo: true,
      slug: normalizedSlug,
      svg: sanitized,
    };
    writeExternalCache(db, cacheKey, okResult, res.headers.get('etag'), nowSec);
    return okResult;
  } catch {
    // Offline-first fallback: serve cached SVG regardless of TTL when network is unreachable
    if (cached) {
      return cached.data;
    }
    return { hasLogo: false, slug: normalizedSlug, initial };
  }
}

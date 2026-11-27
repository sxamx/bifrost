import type { DatabaseSync } from 'node:sqlite';
import {
  BIFROST_USER_AGENT,
  type FetchLike,
  readExternalCache,
  readResponseBufferWithLimit,
  touchExternalCacheTimestamp,
  writeExternalCache,
} from './cache.js';

export const MODELS_DEV_LOGOS_BASE_URL = 'https://models.dev/logos';
export const LOGO_CACHE_TTL_SEC = 7 * 86400; // 7 days (persisted offline in SQLite)
export const MAX_LOGO_DOWNLOAD_BYTES = 256 * 1024;

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
 * Strict allowlist of geometric/structural SVG elements mapped to their canonical XML case.
 * Active, scripting, animation, hyperlink, foreign, filter-image, and external-resource tags
 * (`script`, `foreignObject`, `style`, `image`, `feImage`, `set`, `animate*`, `a`, `iframe`, etc.)
 * are excluded completely.
 */
const CANONICAL_SVG_TAGS: Readonly<Record<string, string>> = {
  svg: 'svg',
  g: 'g',
  path: 'path',
  circle: 'circle',
  ellipse: 'ellipse',
  line: 'line',
  polyline: 'polyline',
  polygon: 'polygon',
  rect: 'rect',
  defs: 'defs',
  lineargradient: 'linearGradient',
  radialgradient: 'radialGradient',
  stop: 'stop',
  clippath: 'clipPath',
  mask: 'mask',
  symbol: 'symbol',
  use: 'use',
};

/**
 * Strict allowlist of safe geometric and monochrome-compatible presentation attributes
 * mapped to canonical SVG case. Event handlers (`on*`), `style`, `filter`, and arbitrary
 * attributes are excluded.
 */
const CANONICAL_SVG_ATTRS: Readonly<Record<string, string>> = {
  xmlns: 'xmlns',
  viewbox: 'viewBox',
  width: 'width',
  height: 'height',
  fill: 'fill',
  stroke: 'stroke',
  'stroke-width': 'stroke-width',
  'stroke-linecap': 'stroke-linecap',
  'stroke-linejoin': 'stroke-linejoin',
  'stroke-miterlimit': 'stroke-miterlimit',
  'stroke-dasharray': 'stroke-dasharray',
  'stroke-dashoffset': 'stroke-dashoffset',
  'stroke-opacity': 'stroke-opacity',
  'fill-opacity': 'fill-opacity',
  'fill-rule': 'fill-rule',
  'clip-rule': 'clip-rule',
  opacity: 'opacity',
  d: 'd',
  cx: 'cx',
  cy: 'cy',
  r: 'r',
  rx: 'rx',
  ry: 'ry',
  x: 'x',
  y: 'y',
  x1: 'x1',
  y1: 'y1',
  x2: 'x2',
  y2: 'y2',
  fx: 'fx',
  fy: 'fy',
  fr: 'fr',
  points: 'points',
  transform: 'transform',
  id: 'id',
  gradientunits: 'gradientUnits',
  gradienttransform: 'gradientTransform',
  spreadmethod: 'spreadMethod',
  offset: 'offset',
  'stop-color': 'stop-color',
  'stop-opacity': 'stop-opacity',
  clippathunits: 'clipPathUnits',
  maskunits: 'maskUnits',
  maskcontentunits: 'maskContentUnits',
  preserveaspectratio: 'preserveAspectRatio',
  'clip-path': 'clip-path',
  mask: 'mask',
  href: 'href',
  'xlink:href': 'href',
};

const DANGEROUS_PAIRED_TAG_RE =
  /<(script|foreignObject|style|iframe|object|embed|applet|audio|video|link|meta|image|feImage|animate|animateMotion|animateTransform|animateColor|set|a|title|desc|text|tspan|switch)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;

const DANGEROUS_SELF_CLOSING_TAG_RE =
  /<(script|foreignObject|style|iframe|object|embed|applet|audio|video|link|meta|image|feImage|animate|animateMotion|animateTransform|animateColor|set|a|title|desc|text|tspan|switch)\b[^>]*\/?>/gi;

const LOCAL_URL_REF_RE = /^url\(\s*#([A-Za-z0-9_.-]+)\s*\)$/i;
const LOCAL_HASH_REF_RE = /^#([A-Za-z0-9_.-]+)$/;

function decodeXmlEntities(input: string): string {
  return input
    .replace(/&#x([0-9a-f]{1,6});?/gi, (_m, hex: string) => {
      const cp = parseInt(hex, 16);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
    })
    .replace(/&#([0-9]{1,7});?/g, (_m, dec: string) => {
      const cp = parseInt(dec, 10);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
    })
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    // Strip ASCII control characters / zero-width chars used to obfuscate scheme names
    .replace(/[\u0000-\u001f\u007f\u200b-\u200d\ufeff]+/g, '');
}

/**
 * Strictly sanitizes an untrusted SVG string against XSS / external network leaks
 * using an explicit tag & attribute allowlist, and normalizes all visible fill/stroke/stop
 * colors to `currentColor` (preserving `none`, `transparent`, and local `#id` gradient refs)
 * so Bifrost's UI renders logos uniformly in `--sub`.
 */
export function sanitizeAndMonochromeSvg(rawSvg: string): string | null {
  if (typeof rawSvg !== 'string' || rawSvg.length === 0 || rawSvg.length > 256 * 1024) {
    return null;
  }

  // Match root <svg ...>...</svg> even when attributes are slash-separated (<svg/onload=...>)
  const svgMatch = /<svg(?=[\s/>])[\s\S]*<\/svg\s*>/i.exec(rawSvg);
  if (!svgMatch) {
    return null;
  }

  let svg = svgMatch[0]!;

  // 1. Strip XML comments, CDATA sections, DOCTYPE/ENTITY declarations, and processing instructions
  svg = svg
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/gi, '')
    .replace(/<![^>]*>/g, '')
    .replace(/<\?[\s\S]*?\?>/g, '');

  // 2. Iteratively strip dangerous paired & self-closing elements until fixed point
  //    (prevents nested tag reconstruction such as `<scr<script>x</script>ipt>`)
  let previous: string;
  do {
    previous = svg;
    svg = svg
      .replace(DANGEROUS_PAIRED_TAG_RE, '')
      .replace(DANGEROUS_SELF_CLOSING_TAG_RE, '');
  } while (svg !== previous);

  // 3. Parse and rebuild ONLY allowlisted SVG tags and allowlisted safe attributes
  const TAG_RE = /<\/?([A-Za-z][A-Za-z0-9:_-]*)([^<>]*?)\/?>/g;
  const ATTR_RE =
    /([A-Za-z_:][A-Za-z0-9_.:-]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

  const outTokens: string[] = [];
  const openStack: string[] = [];
  let rootSvgOpened = false;
  let rootSvgClosed = false;
  let ignoredNestedSvgDepth = 0;

  let tagMatch: RegExpExecArray | null;
  while ((tagMatch = TAG_RE.exec(svg)) !== null) {
    if (rootSvgClosed) {
      break;
    }

    const fullTag = tagMatch[0]!;
    const rawTagName = tagMatch[1]!;
    const attrSegment = tagMatch[2] ?? '';
    const isClosing = fullTag.startsWith('</');
    const isSelfClosing = !isClosing && fullTag.endsWith('/>');

    const canonicalTag = CANONICAL_SVG_TAGS[rawTagName.toLowerCase()];
    if (!canonicalTag) {
      continue;
    }

    if (canonicalTag === 'svg') {
      if (!isClosing) {
        if (rootSvgOpened) {
          // Ignore nested <svg> openings without letting their matching </svg> close the root
          if (!isSelfClosing) {
            ignoredNestedSvgDepth += 1;
          }
          continue;
        }
        rootSvgOpened = true;
      } else {
        if (!rootSvgOpened) {
          return null;
        }
        if (ignoredNestedSvgDepth > 0) {
          ignoredNestedSvgDepth -= 1;
          continue;
        }
        while (openStack.length > 1) {
          const dangling = openStack.pop()!;
          outTokens.push(`</${dangling}>`);
        }
        openStack.pop();
        outTokens.push('</svg>');
        rootSvgClosed = true;
        break;
      }
    } else if (!rootSvgOpened) {
      continue;
    }

    if (isClosing) {
      const idx = openStack.lastIndexOf(canonicalTag);
      if (idx <= 0) {
        // Ignore unmatched closing tag (index 0 is root <svg>)
        continue;
      }
      while (openStack.length - 1 >= idx) {
        const popped = openStack.pop()!;
        outTokens.push(`</${popped}>`);
      }
      continue;
    }

    const seenAttrs = new Set<string>();
    const rebuiltAttrs: string[] = [];
    let hasFillAttr = false;
    let hasValidLocalHref = false;

    ATTR_RE.lastIndex = 0;
    let attrMatch: RegExpExecArray | null;
    while ((attrMatch = ATTR_RE.exec(attrSegment)) !== null) {
      const rawAttrName = attrMatch[1]!.toLowerCase();
      const canonicalAttr = CANONICAL_SVG_ATTRS[rawAttrName];
      if (!canonicalAttr || seenAttrs.has(canonicalAttr)) {
        continue;
      }

      const rawVal = attrMatch[2] ?? attrMatch[3] ?? attrMatch[4] ?? '';
      const decodedVal = decodeXmlEntities(rawVal).trim();

      // Block dangerous URI schemes anywhere (even after entity decoding)
      if (/(?:javascript|data|vbscript|file|blob)\s*:/i.test(decodedVal)) {
        continue;
      }

      if (canonicalAttr === 'xmlns') {
        if (canonicalTag !== 'svg' || decodedVal !== 'http://www.w3.org/2000/svg') {
          continue;
        }
        seenAttrs.add('xmlns');
        rebuiltAttrs.push('xmlns="http://www.w3.org/2000/svg"');
        continue;
      }

      if (canonicalAttr === 'href') {
        if (
          canonicalTag !== 'use' &&
          canonicalTag !== 'linearGradient' &&
          canonicalTag !== 'radialGradient'
        ) {
          continue;
        }
        const hashMatch = LOCAL_HASH_REF_RE.exec(decodedVal);
        if (!hashMatch) {
          continue;
        }
        seenAttrs.add('href');
        hasValidLocalHref = true;
        rebuiltAttrs.push(`href="#${hashMatch[1]!}"`);
        continue;
      }

      if (canonicalAttr === 'clip-path' || canonicalAttr === 'mask') {
        const urlMatch = LOCAL_URL_REF_RE.exec(decodedVal);
        if (!urlMatch) {
          continue;
        }
        seenAttrs.add(canonicalAttr);
        rebuiltAttrs.push(`${canonicalAttr}="url(#${urlMatch[1]!})"`);
        continue;
      }

      if (
        canonicalAttr === 'fill' ||
        canonicalAttr === 'stroke' ||
        canonicalAttr === 'stop-color'
      ) {
        const lowerVal = decodedVal.toLowerCase();
        let normalizedPaint = 'currentColor';
        if (lowerVal === 'none' || lowerVal === 'transparent') {
          normalizedPaint = lowerVal;
        } else if (canonicalAttr !== 'stop-color') {
          const urlMatch = LOCAL_URL_REF_RE.exec(decodedVal);
          if (urlMatch) {
            normalizedPaint = `url(#${urlMatch[1]!})`;
          }
        }
        if (canonicalAttr === 'fill') {
          hasFillAttr = true;
        }
        seenAttrs.add(canonicalAttr);
        rebuiltAttrs.push(`${canonicalAttr}="${normalizedPaint}"`);
        continue;
      }

      // Reject any `url(...)` or external HTTP(S)/protocol-relative reference in all other attributes
      if (/url\s*\(/i.test(decodedVal) || /(?:https?:)?\/\//i.test(decodedVal)) {
        continue;
      }

      if (canonicalAttr === 'id' && !/^[A-Za-z0-9_.-]+$/.test(decodedVal)) {
        continue;
      }

      const safeEscaped = decodedVal.replace(/["<>]/g, '').trim();
      if (!safeEscaped) {
        continue;
      }
      seenAttrs.add(canonicalAttr);
      rebuiltAttrs.push(`${canonicalAttr}="${safeEscaped}"`);
    }

    // Drop <use> elements whose external/malicious href was stripped and have no local #id target
    if (canonicalTag === 'use' && !hasValidLocalHref) {
      continue;
    }

    if (canonicalTag === 'svg' && !hasFillAttr) {
      rebuiltAttrs.push('fill="currentColor"');
    }

    const attrSuffix = rebuiltAttrs.length > 0 ? ` ${rebuiltAttrs.join(' ')}` : '';
    if (isSelfClosing && canonicalTag !== 'svg') {
      outTokens.push(`<${canonicalTag}${attrSuffix}/>`);
    } else {
      outTokens.push(`<${canonicalTag}${attrSuffix}>`);
      openStack.push(canonicalTag);
    }
  }

  if (!rootSvgOpened) {
    return null;
  }

  if (!rootSvgClosed) {
    while (openStack.length > 0) {
      const popped = openStack.pop()!;
      outTokens.push(`</${popped}>`);
    }
  }

  const sanitized = outTokens.join('');
  return /^<svg(?=[\s>])[\s\S]*<\/svg>$/.test(sanitized) ? sanitized : null;
}

export const MAX_LOGO_SLUG_LENGTH = 64;

export function normalizeLogoSlug(slug: string): string | null {
  const cleaned = slug.trim().toLowerCase().replace(/\.svg$/i, '');
  if (cleaned.length === 0 || cleaned.length > MAX_LOGO_SLUG_LENGTH) {
    return null;
  }
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
    allowRemoteFetch?: boolean;
  } = {},
): Promise<ProviderLogoResult> {
  const initial = deriveFallbackInitial(options.displayName ?? providerSlug);
  const normalizedSlug = normalizeLogoSlug(providerSlug);
  if (!normalizedSlug) {
    return { hasLogo: false, slug: providerSlug.slice(0, MAX_LOGO_SLUG_LENGTH), initial };
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

  if (options.allowRemoteFetch === false) {
    if (cached && cached.data.hasLogo) {
      return cached.data;
    }
    return { hasLogo: false, slug: normalizedSlug, initial };
  }

  try {
    const url = `${MODELS_DEV_LOGOS_BASE_URL}/${normalizedSlug}.svg`;
    const headers: Record<string, string> = {
      'User-Agent': BIFROST_USER_AGENT,
      Accept: 'image/svg+xml,text/plain,*/*',
    };
    if (cached?.etag) {
      headers['If-None-Match'] = cached.etag;
    }

    const res = await fetchFn(url, {
      headers,
      signal: AbortSignal.timeout(3000),
    });

    if (res.status === 304 && cached) {
      touchExternalCacheTimestamp(db, cacheKey, nowSec);
      if (!cached.data.hasLogo) {
        return { hasLogo: false, slug: normalizedSlug, initial };
      }
      return cached.data;
    }

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

    const rawBuf = await readResponseBufferWithLimit(res, MAX_LOGO_DOWNLOAD_BYTES);
    const rawText = rawBuf.toString('utf8');
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

import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  type ProviderManifest,
  loadSeedManifests,
  validateProviderManifest,
} from './schema.js';
import {
  type UrlSecurityValidationResult,
  validateProviderTargetUrl,
} from './url-security.js';

export { type UrlSecurityValidationResult, validateProviderTargetUrl };

const SAFE_MANIFEST_PATH_RE = /^providers\/[a-z0-9-]+\.json$/;

export interface MarketplaceCatalogManifest extends ProviderManifest {
  description?: string;
  approved?: boolean;
}

const MARKETPLACE_WRAPPER_KEYS = new Set<string>([
  'description',
  'approved',
  'manifestPath',
  'installed',
]);

export function stripMarketplaceWrapperFields(
  candidate: Record<string, unknown>,
): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(candidate)) {
    if (!MARKETPLACE_WRAPPER_KEYS.has(k)) {
      clean[k] = v;
    }
  }
  return clean;
}

export function isSafeMarketplaceManifestPath(manifestPath: unknown): manifestPath is string {
  return typeof manifestPath === 'string' && SAFE_MANIFEST_PATH_RE.test(manifestPath);
}

/**
 * Loads approved manifests from the local bundled `schemas/marketplace-repo/index.json`
 * (with strict regex + `path.resolve` confinement against path traversal), falling back to
 * `schemas/examples/*.provider.json`.
 */
export function loadBundledMarketplaceCatalog(schemasDir: string): MarketplaceCatalogManifest[] {
  const repoDir = path.resolve(schemasDir, 'marketplace-repo');
  const indexPath = path.join(repoDir, 'index.json');

  if (fs.existsSync(indexPath)) {
    try {
      const rawIndex = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as Record<string, unknown>;
      const entries = Array.isArray(rawIndex.providers) ? rawIndex.providers : [];
      const loaded: MarketplaceCatalogManifest[] = [];

      for (const entry of entries) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
        const rec = entry as Record<string, unknown>;
        if (rec.approved !== true) continue;
        if (!isSafeMarketplaceManifestPath(rec.manifestPath)) continue;

        const resolvedFile = path.resolve(repoDir, rec.manifestPath);
        const relative = path.relative(repoDir, resolvedFile);
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
          continue;
        }
        if (!fs.existsSync(resolvedFile)) continue;

        const rawManifest = JSON.parse(fs.readFileSync(resolvedFile, 'utf8')) as unknown;
        const check = validateProviderManifest(rawManifest, schemasDir);
        if (check.valid && check.manifest) {
          loaded.push({
            ...check.manifest,
            ...(typeof rec.description === 'string' ? { description: rec.description } : {}),
            approved: true,
          });
        }
      }

      if (loaded.length > 0) {
        return loaded;
      }
    } catch {
      // Fall back to seed example manifests
    }
  }

  return loadSeedManifests(schemasDir).map((m) => ({ ...m, approved: true }));
}

export function readCachedOrBundledMarketplaceCatalog(
  db: DatabaseSync,
  schemasDir: string,
): MarketplaceCatalogManifest[] {
  const cachedRow = db
    .prepare(`SELECT payload_json FROM external_cache WHERE cache_key = 'marketplace:index'`)
    .get() as { payload_json: string } | undefined;

  if (cachedRow?.payload_json) {
    try {
      const parsed = JSON.parse(cachedRow.payload_json) as unknown[];
      if (Array.isArray(parsed) && parsed.length > 0) {
        const validCached: MarketplaceCatalogManifest[] = [];
        for (const item of parsed) {
          if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
          const rec = item as Record<string, unknown>;
          if (rec.approved === false) continue;
          const check = validateProviderManifest(stripMarketplaceWrapperFields(rec), schemasDir);
          if (check.valid && check.manifest) {
            validCached.push({
              ...check.manifest,
              ...(typeof rec.description === 'string' ? { description: rec.description } : {}),
              approved: true,
            });
          }
        }
        if (validCached.length > 0) {
          return validCached;
        }
      }
    } catch {
      // Fall through to bundled catalog
    }
  }

  return loadBundledMarketplaceCatalog(schemasDir);
}

/**
 * Fetches and validates the remote Marketplace catalog (`index.json` with `manifestPath`
 * entries OR direct array of manifests), strictly filtering `approved !== false` and
 * blocking path traversal on `manifestPath`.
 */
export async function fetchRemoteMarketplaceCatalog(options: {
  db: DatabaseSync;
  marketplaceUrl: string;
  schemasDir: string;
  fetchImpl: typeof fetch;
  nowSec: number;
}): Promise<{
  manifests: MarketplaceCatalogManifest[];
  unapprovedIds: string[];
}> {
  const { db, marketplaceUrl, schemasDir, fetchImpl, nowSec } = options;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  let res: Response;
  try {
    res = await fetchImpl(marketplaceUrl, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      redirect: 'error',
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new Error(`Marketplace HTTP ${res.status}`);
  }

  const rawJson = (await res.json()) as unknown;
  let rawItems: unknown[] = [];
  if (Array.isArray(rawJson)) {
    rawItems = rawJson;
  } else if (rawJson && typeof rawJson === 'object') {
    const rec = rawJson as Record<string, unknown>;
    if (Array.isArray(rec.providers)) rawItems = rec.providers;
    else if (Array.isArray(rec.manifests)) rawItems = rec.manifests;
    else if (Array.isArray(rec.items)) rawItems = rec.items;
    else if (Array.isArray(rec.catalog)) rawItems = rec.catalog;
  }

  const validManifests: MarketplaceCatalogManifest[] = [];
  const unapprovedIds: string[] = [];
  const baseCatalogUrl = new URL(marketplaceUrl);

  for (const item of rawItems) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;

    if (rec.approved === false) {
      if (typeof rec.id === 'string' && rec.id.trim()) {
        unapprovedIds.push(rec.id.trim());
      }
      continue;
    }

    if ('manifestPath' in rec && rec.manifestPath !== undefined) {
      if (rec.approved !== true) {
        if (typeof rec.id === 'string' && rec.id.trim()) {
          unapprovedIds.push(rec.id.trim());
        }
        continue;
      }
      if (!isSafeMarketplaceManifestPath(rec.manifestPath)) {
        continue;
      }

      const resolvedUrl = new URL(rec.manifestPath, baseCatalogUrl);
      if (resolvedUrl.origin !== baseCatalogUrl.origin) {
        continue;
      }
      const baseDirPath = path.posix.dirname(baseCatalogUrl.pathname);
      const expectedPrefix = baseDirPath === '/' ? '/providers/' : `${baseDirPath}/providers/`;
      if (!resolvedUrl.pathname.startsWith(expectedPrefix)) {
        continue;
      }

      try {
        const mRes = await fetchImpl(resolvedUrl.href, {
          method: 'GET',
          headers: { Accept: 'application/json' },
          redirect: 'error',
        });
        if (!mRes.ok) continue;
        const rawManifest = (await mRes.json()) as unknown;
        if (
          rawManifest &&
          typeof rawManifest === 'object' &&
          !Array.isArray(rawManifest) &&
          (rawManifest as Record<string, unknown>).approved === false
        ) {
          continue;
        }
        const cleaned =
          rawManifest && typeof rawManifest === 'object' && !Array.isArray(rawManifest)
            ? stripMarketplaceWrapperFields(rawManifest as Record<string, unknown>)
            : rawManifest;
        const check = validateProviderManifest(cleaned, schemasDir);
        if (check.valid && check.manifest) {
          if (typeof rec.id === 'string' && rec.id !== check.manifest.id) {
            continue;
          }
          validManifests.push({
            ...check.manifest,
            ...(typeof rec.description === 'string' ? { description: rec.description } : {}),
            approved: true,
          });
        }
      } catch {
        // Skip unreachable individual manifest without crashing catalog
      }
      continue;
    }

    const cleaned = stripMarketplaceWrapperFields(rec);
    const check = validateProviderManifest(cleaned, schemasDir);
    if (check.valid && check.manifest) {
      validManifests.push({
        ...check.manifest,
        ...(typeof rec.description === 'string' ? { description: rec.description } : {}),
        approved: true,
      });
    }
  }

  db.prepare(
    `INSERT INTO external_cache (cache_key, payload_json, etag, fetched_at)
     VALUES ('marketplace:index', ?, ?, ?)
     ON CONFLICT(cache_key) DO UPDATE SET
       payload_json = excluded.payload_json,
       etag = excluded.etag,
       fetched_at = excluded.fetched_at`,
  ).run(JSON.stringify(validManifests), res.headers.get('etag'), nowSec);

  db.prepare(
    `INSERT INTO external_cache (cache_key, payload_json, etag, fetched_at)
     VALUES ('marketplace:unapproved', ?, NULL, ?)
     ON CONFLICT(cache_key) DO UPDATE SET
       payload_json = excluded.payload_json,
       fetched_at = excluded.fetched_at`,
  ).run(JSON.stringify(unapprovedIds), nowSec);

  return { manifests: validManifests, unapprovedIds };
}

export function isKnownUnapprovedMarketplaceId(db: DatabaseSync, providerId: string): boolean {
  const row = db
    .prepare(`SELECT payload_json FROM external_cache WHERE cache_key = 'marketplace:unapproved'`)
    .get() as { payload_json: string } | undefined;
  if (!row?.payload_json) return false;
  try {
    const ids = JSON.parse(row.payload_json) as unknown;
    return Array.isArray(ids) && ids.includes(providerId);
  } catch {
    return false;
  }
}

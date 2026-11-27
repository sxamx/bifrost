import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  LEGACY_OFFICIAL_MARKETPLACE_SOURCE_URL,
  OFFICIAL_MARKETPLACE_SOURCE_URL,
  redactSecretsInText,
} from './db.js';
import {
  type ProviderManifest,
  loadSeedManifests,
  validateProviderManifest,
} from './schema.js';
import {
  type DnsLookupFn,
  safeFetch,
  validateSafeUpstreamUrl,
  validateSafeUpstreamUrlSync,
} from './ssrf.js';
import {
  type UrlSecurityValidationResult,
  allowLocalOfficialUpstreams,
  validateProviderTargetUrl,
} from './url-security.js';

export { type UrlSecurityValidationResult, validateProviderTargetUrl };

const SAFE_MANIFEST_PATH_RE = /^providers\/[a-z0-9-]+\.json$/;
const MARKETPLACE_SOURCE_CACHE_TTL_SEC = 15 * 60; // 15 minutes

export interface MarketplaceCatalogManifest extends ProviderManifest {
  description?: string;
  approved?: boolean;
  sourceId?: string;
}

export interface MarketplaceSourceRecord {
  id: string;
  name: string;
  url: string;
  isOfficial: boolean;
  enabled: boolean;
  catalogVersion: string | null;
  lastCheckedAt: number | null;
  lastError: string | null;
  createdAt: number;
}

export interface EnrichedMarketplaceManifest
  extends Omit<MarketplaceCatalogManifest, 'privacy' | 'rateLimitKind' | 'rateLimitWindows'> {
  privacy: ProviderManifest['privacy'] | null;
  rateLimitKind: ProviderManifest['rateLimitKind'] | null;
  rateLimitWindows: NonNullable<ProviderManifest['rateLimitWindows']>;
  sourceId: string;
  sourceName: string;
  isOfficial: boolean;
  manifestHash: string;
  manifestVersion: string;
  installed: boolean;
  installedHash: string | null;
  updateAvailable: boolean;
}

export interface MergedMarketplaceCatalogResult {
  online: boolean;
  offline: boolean;
  providers: EnrichedMarketplaceManifest[];
  manifests: EnrichedMarketplaceManifest[];
  sources: MarketplaceSourceRecord[];
  catalogVersion: string | null;
  updatedAt: string | null;
  checkedAt: number;
  updatesAvailableCount: number;
  enabledSourcesCount: number;
  source: string;
  notice?: string;
  error?: string;
  partialErrors?: Array<{ sourceId: string; sourceName: string; error: string }>;
}

const MARKETPLACE_WRAPPER_KEYS = new Set<string>([
  'description',
  'approved',
  'manifestPath',
  'installed',
  'installedHash',
  'updateAvailable',
  'sourceId',
  'sourceName',
  'isOfficial',
  'manifestHash',
  'manifestVersion',
]);

export function stripMarketplaceWrapperFields(
  candidate: Record<string, unknown>,
): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(candidate)) {
    if (MARKETPLACE_WRAPPER_KEYS.has(k)) continue;
    if ((k === 'privacy' || k === 'rateLimitKind') && v === null) continue;
    if (k === 'rateLimitWindows' && Array.isArray(v) && v.length === 0) continue;
    clean[k] = v;
  }
  return clean;
}

export function isSafeMarketplaceManifestPath(manifestPath: unknown): manifestPath is string {
  return typeof manifestPath === 'string' && SAFE_MANIFEST_PATH_RE.test(manifestPath);
}

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeJson);
  }
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) {
        sorted[key] = canonicalizeJson(v);
      }
    }
    return sorted;
  }
  return value;
}

/**
 * Deterministic SHA-256 hex prefix (16 chars) of canonical sorted JSON.
 */
export function computeManifestHash(manifest: unknown): string {
  const canonical = JSON.stringify(canonicalizeJson(manifest));
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

export interface MarketplaceSsrfOptions {
  allowLocalhostForTests?: boolean;
  dnsLookup?: DnsLookupFn;
  resolveDns?: boolean;
}

/**
 * Synchronous Marketplace repository index URL validator with strict SSRF protection
 * (`official-json` mode: strict HTTPS, blocks RFC1918/loopback/CGNAT/IMDS/single-label/IPv6 transition/userinfo).
 */
function finalizeNormalizedMarketplaceUrl(rawInput: string, normalizedUrl: string): string {
  let finalUrl = normalizeMarketplaceSourceUrl(normalizedUrl);
  try {
    const parsedInput = new URL(rawInput);
    if (
      parsedInput.pathname.length > 1 &&
      parsedInput.pathname.endsWith('/') &&
      !parsedInput.search &&
      !parsedInput.hash &&
      !finalUrl.endsWith('/')
    ) {
      finalUrl = `${finalUrl}/`;
    }
  } catch {
    // Keep normalizedUrl as-is
  }
  return finalUrl;
}

export function validateMarketplaceSourceUrlSync(
  rawUrl: string,
  ssrfOpts?: MarketplaceSsrfOptions,
): { ok: true; url: string } | { ok: false; error: string } {
  const allowLoopback = Boolean(ssrfOpts?.allowLocalhostForTests);
  const normalizedInput = normalizeMarketplaceSourceUrl(rawUrl);
  const check = validateSafeUpstreamUrlSync(normalizedInput, {
    mode: 'official-json',
    allowLocalhostForTests: allowLoopback,
  });
  if (!check.allowed || !check.normalizedUrl) {
    return { ok: false, error: check.reason ?? 'Invalid marketplace source URL.' };
  }
  return { ok: true, url: finalizeNormalizedMarketplaceUrl(normalizedInput, check.normalizedUrl) };
}

export function normalizeMarketplaceSourceUrl(rawUrl: string): string {
  const trimmed = typeof rawUrl === 'string' ? rawUrl.trim() : '';
  if (trimmed === LEGACY_OFFICIAL_MARKETPLACE_SOURCE_URL) {
    return OFFICIAL_MARKETPLACE_SOURCE_URL;
  }
  return trimmed;
}

/**
 * Validates a Marketplace repository index URL with strict SSRF protection
 * (`official-json` mode: strict HTTPS, blocks RFC1918/loopback/CGNAT/IMDS/single-label/IPv6 transition/userinfo,
 * plus DNS validation when `dnsLookup` or `resolveDns: true` is provided).
 */
export async function validateMarketplaceSourceUrl(
  rawUrl: string,
  ssrfOpts?: MarketplaceSsrfOptions,
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const normalizedInput = normalizeMarketplaceSourceUrl(rawUrl);
  const syncCheck = validateMarketplaceSourceUrlSync(normalizedInput, ssrfOpts);
  if (!syncCheck.ok) {
    return syncCheck;
  }

  if (ssrfOpts?.dnsLookup || ssrfOpts?.resolveDns === true) {
    const dnsCheck = await validateSafeUpstreamUrl(syncCheck.url, {
      mode: 'official-json',
      allowLocalhostForTests: Boolean(ssrfOpts.allowLocalhostForTests),
      dnsLookup: ssrfOpts.dnsLookup,
      resolveDns: true,
    });
    if (!dnsCheck.allowed || !dnsCheck.normalizedUrl) {
      return { ok: false, error: dnsCheck.reason ?? 'Invalid marketplace source URL.' };
    }
    return {
      ok: true,
      url: finalizeNormalizedMarketplaceUrl(normalizedInput, dnsCheck.normalizedUrl),
    };
  }

  return syncCheck;
}

function mapSourceRow(row: Record<string, unknown>): MarketplaceSourceRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    url: String(row.url),
    isOfficial: Number(row.is_official ?? 0) === 1,
    enabled: Number(row.enabled ?? 0) === 1,
    catalogVersion:
      row.catalog_version === null || row.catalog_version === undefined
        ? null
        : String(row.catalog_version),
    lastCheckedAt:
      row.last_checked_at === null || row.last_checked_at === undefined
        ? null
        : Number(row.last_checked_at),
    lastError:
      row.last_error === null || row.last_error === undefined ? null : String(row.last_error),
    createdAt: Number(row.created_at),
  };
}

export function listMarketplaceSources(db: DatabaseSync): MarketplaceSourceRecord[] {
  const rows = db
    .prepare(
      `SELECT id, name, url, is_official, enabled, catalog_version, last_checked_at, last_error, created_at
       FROM marketplace_sources
       ORDER BY is_official DESC, created_at ASC, id ASC`,
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map(mapSourceRow);
}

export async function addMarketplaceSource(
  db: DatabaseSync,
  input: { name: string; url: string; enabled?: boolean },
  nowSec: number,
  ssrfOpts?: MarketplaceSsrfOptions,
): Promise<
  | { ok: true; source: MarketplaceSourceRecord }
  | { ok: false; status: 400 | 409; error: string }
> {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name || name.length > 120) {
    return { ok: false, status: 400, error: 'Source name must be between 1 and 120 characters.' };
  }

  const urlCheck = await validateMarketplaceSourceUrl(
    normalizeMarketplaceSourceUrl(input.url),
    ssrfOpts,
  );
  if (!urlCheck.ok) {
    return { ok: false, status: 400, error: urlCheck.error };
  }
  const normalizedUrl = normalizeMarketplaceSourceUrl(urlCheck.url);

  const duplicate = db
    .prepare(`SELECT id FROM marketplace_sources WHERE url = ?`)
    .get(normalizedUrl) as { id: string } | undefined;
  if (duplicate) {
    return { ok: false, status: 409, error: 'A marketplace source with this URL already exists.' };
  }

  const id = `src_${crypto.randomBytes(6).toString('hex')}`;
  const enabledInt = input.enabled === false ? 0 : 1;

  db.prepare(
    `INSERT INTO marketplace_sources (
       id, name, url, is_official, enabled, catalog_version, last_checked_at, last_error, created_at
     ) VALUES (?, ?, ?, 0, ?, NULL, NULL, NULL, ?)`,
  ).run(id, name, normalizedUrl, enabledInt, nowSec);

  db.prepare(`DELETE FROM external_cache WHERE cache_key = 'marketplace:index'`).run();

  const row = db
    .prepare(`SELECT * FROM marketplace_sources WHERE id = ?`)
    .get(id) as Record<string, unknown>;
  return { ok: true, source: mapSourceRow(row) };
}

export function updateMarketplaceSource(
  db: DatabaseSync,
  id: string,
  input: { name?: string; enabled?: boolean },
):
  | { ok: true; source: MarketplaceSourceRecord }
  | { ok: false; status: 400 | 404; error: string } {
  const existing = db
    .prepare(`SELECT * FROM marketplace_sources WHERE id = ?`)
    .get(id) as Record<string, unknown> | undefined;
  if (!existing) {
    return { ok: false, status: 404, error: `Marketplace source "${id}" not found.` };
  }

  let nextName = String(existing.name);
  if (input.name !== undefined) {
    const trimmed = typeof input.name === 'string' ? input.name.trim() : '';
    if (!trimmed || trimmed.length > 120) {
      return { ok: false, status: 400, error: 'Source name must be between 1 and 120 characters.' };
    }
    nextName = trimmed;
  }

  let nextEnabled = Number(existing.enabled ?? 0);
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== 'boolean') {
      return { ok: false, status: 400, error: 'enabled must be a boolean.' };
    }
    nextEnabled = input.enabled ? 1 : 0;
  }

  db.prepare(`UPDATE marketplace_sources SET name = ?, enabled = ? WHERE id = ?`).run(
    nextName,
    nextEnabled,
    id,
  );

  if (nextEnabled !== Number(existing.enabled ?? 0)) {
    db.prepare(`DELETE FROM external_cache WHERE cache_key = 'marketplace:index'`).run();
  }

  const updated = db
    .prepare(`SELECT * FROM marketplace_sources WHERE id = ?`)
    .get(id) as Record<string, unknown>;
  return { ok: true, source: mapSourceRow(updated) };
}

export function deleteMarketplaceSource(
  db: DatabaseSync,
  id: string,
): { ok: true; id: string } | { ok: false; status: 400 | 404; error: string } {
  const existing = db
    .prepare(`SELECT id, is_official FROM marketplace_sources WHERE id = ?`)
    .get(id) as { id: string; is_official: number } | undefined;
  if (!existing) {
    return { ok: false, status: 404, error: `Marketplace source "${id}" not found.` };
  }
  if (Number(existing.is_official) === 1) {
    return {
      ok: false,
      status: 400,
      error: 'The official marketplace source cannot be deleted; disable it instead.',
    };
  }

  db.prepare(`DELETE FROM marketplace_sources WHERE id = ?`).run(id);
  db.prepare(`DELETE FROM external_cache WHERE cache_key IN (?, 'marketplace:index')`).run(
    `marketplace_source:${id}`,
  );
  return { ok: true, id };
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
              ...(typeof rec.sourceId === 'string' ? { sourceId: rec.sourceId } : {}),
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

type SingleSourceFetchOutput =
  | {
      notModified: true;
      etag: string | null;
    }
  | {
      notModified: false;
      manifests: MarketplaceCatalogManifest[];
      unapprovedIds: string[];
      catalogVersion: string;
      updatedAt: string | null;
      etag: string | null;
    };

async function fetchSingleSourceCatalog(options: {
  marketplaceUrl: string;
  schemasDir: string;
  fetchImpl: typeof fetch;
  allowLocalhost?: boolean;
  dnsLookup?: DnsLookupFn;
  etag?: string | null;
}): Promise<SingleSourceFetchOutput> {
  const { schemasDir, fetchImpl, allowLocalhost, dnsLookup, etag } = options;
  const marketplaceUrl = normalizeMarketplaceSourceUrl(options.marketplaceUrl);
  const effectiveAllowLocalhost =
    allowLocalhost !== undefined ? allowLocalhost : allowLocalOfficialUpstreams();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  let res: Response;
  try {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (etag) {
      headers['If-None-Match'] = etag;
    }
    res = await safeFetch(
      marketplaceUrl,
      {
        method: 'GET',
        headers,
        redirect: 'error',
        signal: controller.signal,
      },
      {
        mode: 'official-json',
        allowLocalhost: effectiveAllowLocalhost,
        fetchImpl,
        dnsLookup,
      },
    );
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 304) {
    return {
      notModified: true,
      etag: res.headers.get('etag') ?? etag ?? null,
    };
  }

  if (!res.ok) {
    throw new Error(`Marketplace HTTP ${res.status}`);
  }

  const rawText = await res.text();
  const rawJson = JSON.parse(rawText) as unknown;

  let rawItems: unknown[] = [];
  let updatedAt: string | null = null;
  if (Array.isArray(rawJson)) {
    rawItems = rawJson;
  } else if (rawJson && typeof rawJson === 'object') {
    const rec = rawJson as Record<string, unknown>;
    if (typeof rec.updatedAt === 'string' && rec.updatedAt.trim().length > 0) {
      updatedAt = rec.updatedAt.trim();
    }
    if (Array.isArray(rec.providers)) rawItems = rec.providers;
    else if (Array.isArray(rec.manifests)) rawItems = rec.manifests;
    else if (Array.isArray(rec.items)) rawItems = rec.items;
    else if (Array.isArray(rec.catalog)) rawItems = rec.catalog;
  }

  const catalogVersion =
    updatedAt ?? crypto.createHash('sha256').update(rawText).digest('hex').slice(0, 16);

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
      const baseDirPath = baseCatalogUrl.pathname.endsWith('/')
        ? baseCatalogUrl.pathname.replace(/\/+$/, '') || '/'
        : path.posix.dirname(baseCatalogUrl.pathname);
      const expectedPrefix = baseDirPath === '/' ? '/providers/' : `${baseDirPath}/providers/`;
      if (!resolvedUrl.pathname.startsWith(expectedPrefix)) {
        continue;
      }

      try {
        const mRes = await safeFetch(
          resolvedUrl.href,
          {
            method: 'GET',
            headers: { Accept: 'application/json' },
            redirect: 'error',
            signal: AbortSignal.timeout(4000),
          },
          {
            mode: 'official-json',
            allowLocalhost: effectiveAllowLocalhost,
            fetchImpl,
            dnsLookup,
          },
        );
        if (!mRes.ok) continue;
        const rawManifest = (await mRes.json()) as unknown;
        if (
          rawManifest &&
          typeof rawManifest === 'object' &&
          !Array.isArray(rawManifest) &&
          (rawManifest as Record<string, unknown>).approved === false
        ) {
          const manifestObj = rawManifest as Record<string, unknown>;
          const unapprovedId =
            typeof rec.id === 'string' && rec.id.trim()
              ? rec.id.trim()
              : typeof manifestObj.id === 'string' && manifestObj.id.trim()
                ? manifestObj.id.trim()
                : null;
          if (unapprovedId) {
            unapprovedIds.push(unapprovedId);
          }
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

  return {
    notModified: false,
    manifests: validManifests,
    unapprovedIds,
    catalogVersion,
    updatedAt,
    etag: res.headers.get('etag'),
  };
}

/**
 * Fetches and validates a single remote Marketplace catalog (`index.json` with `manifestPath`
 * entries OR direct array of manifests), strictly filtering `approved !== false` and
 * blocking path traversal on `manifestPath`.
 */
export async function fetchRemoteMarketplaceCatalog(options: {
  db: DatabaseSync;
  marketplaceUrl: string;
  schemasDir: string;
  fetchImpl: typeof fetch;
  allowLocalhost?: boolean;
  dnsLookup?: DnsLookupFn;
  nowSec: number;
}): Promise<{
  manifests: MarketplaceCatalogManifest[];
  unapprovedIds: string[];
}> {
  const { db, marketplaceUrl, schemasDir, fetchImpl, allowLocalhost, dnsLookup, nowSec } = options;
  const result = await fetchSingleSourceCatalog({
    marketplaceUrl,
    schemasDir,
    fetchImpl,
    allowLocalhost,
    dnsLookup,
  });
  if (result.notModified) {
    return { manifests: [], unapprovedIds: [] };
  }

  db.prepare(
    `INSERT INTO external_cache (cache_key, payload_json, etag, fetched_at)
     VALUES ('marketplace:index', ?, ?, ?)
     ON CONFLICT(cache_key) DO UPDATE SET
       payload_json = excluded.payload_json,
       etag = excluded.etag,
       fetched_at = excluded.fetched_at`,
  ).run(JSON.stringify(result.manifests), result.etag, nowSec);

  db.prepare(
    `INSERT INTO external_cache (cache_key, payload_json, etag, fetched_at)
     VALUES ('marketplace:unapproved', ?, NULL, ?)
     ON CONFLICT(cache_key) DO UPDATE SET
       payload_json = excluded.payload_json,
       fetched_at = excluded.fetched_at`,
  ).run(JSON.stringify(result.unapprovedIds), nowSec);

  return { manifests: result.manifests, unapprovedIds: result.unapprovedIds };
}

function loadInstalledProviderHashes(db: DatabaseSync): Map<string, string> {
  const rows = db
    .prepare(`SELECT id, schema_json, manifest_hash FROM providers`)
    .all() as Array<{ id: string; schema_json: string; manifest_hash: string | null }>;

  const map = new Map<string, string>();
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.schema_json) as unknown;
      map.set(row.id, computeManifestHash(parsed));
    } catch {
      if (row.manifest_hash) {
        map.set(row.id, row.manifest_hash);
      }
    }
  }
  return map;
}

function enrichManifestEntry(
  manifest: MarketplaceCatalogManifest,
  meta: {
    sourceId: string;
    sourceName: string;
    isOfficial: boolean;
    indexUpdatedAt: string | null;
  },
  installedHashes: Map<string, string>,
): EnrichedMarketplaceManifest {
  const cleanForHash = stripMarketplaceWrapperFields(
    manifest as unknown as Record<string, unknown>,
  );
  const manifestHash = computeManifestHash(cleanForHash);
  const manifestVersion =
    manifest.publishedAt ?? meta.indexUpdatedAt ?? manifestHash.slice(0, 8);
  const installedHash = installedHashes.get(manifest.id) ?? null;
  const installed = installedHash !== null;
  const updateAvailable = installed && installedHash !== manifestHash;

  return {
    ...manifest,
    privacy: manifest.privacy ?? null,
    rateLimitKind: manifest.rateLimitKind ?? null,
    rateLimitWindows: manifest.rateLimitWindows ?? [],
    sourceId: meta.sourceId,
    sourceName: meta.sourceName,
    isOfficial: meta.isOfficial,
    manifestHash,
    manifestVersion,
    installed,
    installedHash,
    updateAvailable,
  };
}

/**
 * Fetches all enabled marketplace sources in parallel (with 15-min per-source cache unless
 * `forceRefresh === true`), merges approved manifests with collision priority
 * (official first, then earliest `created_at`), and computes `installed` + `updateAvailable`
 * against installed providers in SQLite.
 */
export async function fetchAndMergeMarketplaceCatalog(
  db: DatabaseSync,
  options: {
    fetchImpl: typeof fetch;
    allowLocalhost?: boolean;
    dnsLookup?: DnsLookupFn;
    forceRefresh?: boolean;
    nowSec: number;
    bundledDir: string;
  },
): Promise<MergedMarketplaceCatalogResult> {
  const {
    fetchImpl,
    allowLocalhost,
    dnsLookup,
    forceRefresh = false,
    nowSec,
    bundledDir,
  } = options;

  const allSources = listMarketplaceSources(db);
  const enabledSources = allSources.filter((s) => s.enabled);

  if (enabledSources.length === 0) {
    return {
      online: true,
      offline: false,
      providers: [],
      manifests: [],
      sources: allSources,
      catalogVersion: null,
      updatedAt: null,
      checkedAt: nowSec,
      updatesAvailableCount: 0,
      enabledSourcesCount: 0,
      source: 'none',
    };
  }

  interface CachedSourcePayload {
    manifests: MarketplaceCatalogManifest[];
    unapprovedIds: string[];
    catalogVersion: string;
    updatedAt: string | null;
  }

  type SourceFetchOutcome =
    | {
        ok: true;
        source: MarketplaceSourceRecord;
        manifests: MarketplaceCatalogManifest[];
        unapprovedIds: string[];
        catalogVersion: string;
        updatedAt: string | null;
      }
    | {
        ok: false;
        source: MarketplaceSourceRecord;
        error: string;
        staleCache: CachedSourcePayload | null;
      };

  const outcomes: SourceFetchOutcome[] = await Promise.all(
    enabledSources.map(async (src): Promise<SourceFetchOutcome> => {
      const cacheKey = `marketplace_source:${src.id}`;

      const cachedRow = db
        .prepare(`SELECT payload_json, etag, fetched_at FROM external_cache WHERE cache_key = ?`)
        .get(cacheKey) as
        | { payload_json: string; etag: string | null; fetched_at: number }
        | undefined;

      let cachedPayload: CachedSourcePayload | null = null;
      if (cachedRow) {
        try {
          const parsed = JSON.parse(cachedRow.payload_json) as {
            manifests?: MarketplaceCatalogManifest[];
            unapprovedIds?: string[];
            catalogVersion?: string;
            updatedAt?: string | null;
          };
          if (Array.isArray(parsed.manifests)) {
            cachedPayload = {
              manifests: parsed.manifests,
              unapprovedIds: Array.isArray(parsed.unapprovedIds) ? parsed.unapprovedIds : [],
              catalogVersion: parsed.catalogVersion ?? src.catalogVersion ?? '',
              updatedAt: parsed.updatedAt ?? null,
            };
          }
        } catch {
          // Cache corrupted; ignore and fetch live
        }
      }

      if (
        !forceRefresh &&
        cachedPayload &&
        cachedRow &&
        nowSec - Number(cachedRow.fetched_at) < MARKETPLACE_SOURCE_CACHE_TTL_SEC
      ) {
        return {
          ok: true,
          source: src,
          manifests: cachedPayload.manifests,
          unapprovedIds: cachedPayload.unapprovedIds,
          catalogVersion: cachedPayload.catalogVersion,
          updatedAt: cachedPayload.updatedAt,
        };
      }

      try {
        const fetched = await fetchSingleSourceCatalog({
          marketplaceUrl: src.url,
          schemasDir: bundledDir,
          fetchImpl,
          allowLocalhost,
          dnsLookup,
          etag: cachedPayload ? cachedRow?.etag ?? null : null,
        });

        if (fetched.notModified && cachedPayload) {
          db.prepare(`UPDATE external_cache SET fetched_at = ? WHERE cache_key = ?`).run(
            nowSec,
            cacheKey,
          );
          db.prepare(
            `UPDATE marketplace_sources
             SET last_checked_at = ?, last_error = NULL
             WHERE id = ?`,
          ).run(nowSec, src.id);

          return {
            ok: true,
            source: src,
            manifests: cachedPayload.manifests,
            unapprovedIds: cachedPayload.unapprovedIds,
            catalogVersion: cachedPayload.catalogVersion,
            updatedAt: cachedPayload.updatedAt,
          };
        }

        if (fetched.notModified) {
          throw new Error('Marketplace returned HTTP 304 without cached payload.');
        }

        db.prepare(
          `INSERT INTO external_cache (cache_key, payload_json, etag, fetched_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(cache_key) DO UPDATE SET
             payload_json = excluded.payload_json,
             etag = excluded.etag,
             fetched_at = excluded.fetched_at`,
        ).run(
          cacheKey,
          JSON.stringify({
            manifests: fetched.manifests,
            unapprovedIds: fetched.unapprovedIds,
            catalogVersion: fetched.catalogVersion,
            updatedAt: fetched.updatedAt,
          }),
          fetched.etag,
          nowSec,
        );

        db.prepare(
          `UPDATE marketplace_sources
           SET catalog_version = ?, last_checked_at = ?, last_error = NULL
           WHERE id = ?`,
        ).run(fetched.catalogVersion, nowSec, src.id);

        return {
          ok: true,
          source: src,
          manifests: fetched.manifests,
          unapprovedIds: fetched.unapprovedIds,
          catalogVersion: fetched.catalogVersion,
          updatedAt: fetched.updatedAt,
        };
      } catch (err) {
        const errMsg = redactSecretsInText(
          err instanceof Error ? err.message : 'Unable to reach remote marketplace catalog.',
        );
        db.prepare(
          `UPDATE marketplace_sources
           SET last_checked_at = ?, last_error = ?
           WHERE id = ?`,
        ).run(nowSec, errMsg, src.id);

        return {
          ok: false,
          source: src,
          error: errMsg,
          staleCache: cachedPayload,
        };
      }
    }),
  );

  const updatedSources = listMarketplaceSources(db);
  const installedHashes = loadInstalledProviderHashes(db);
  const succeeded = outcomes.filter((o): o is Extract<SourceFetchOutcome, { ok: true }> => o.ok);
  const failed = outcomes.filter((o): o is Extract<SourceFetchOutcome, { ok: false }> => !o.ok);
  const partialErrors =
    failed.length > 0
      ? failed.map((f) => ({
          sourceId: f.source.id,
          sourceName: f.source.name,
          error: f.error,
        }))
      : undefined;

  if (succeeded.length === 0) {
    const fallbackRaw = readCachedOrBundledMarketplaceCatalog(db, bundledDir);
    const enrichedFallback = fallbackRaw.map((m) =>
      enrichManifestEntry(
        m,
        {
          sourceId: 'bundled',
          sourceName: 'Catálogo local verificado',
          isOfficial: true,
          indexUpdatedAt: null,
        },
        installedHashes,
      ),
    );
    const updatesAvailableCount = enrichedFallback.filter((m) => m.updateAvailable).length;

    return {
      online: false,
      offline: true,
      providers: enrichedFallback,
      manifests: enrichedFallback,
      sources: updatedSources,
      catalogVersion: null,
      updatedAt: null,
      checkedAt: nowSec,
      updatesAvailableCount,
      enabledSourcesCount: enabledSources.length,
      source: 'bundled',
      notice:
        'Catálogo remoto fuera de línea. Mostrando fichas locales verificadas; también puedes importar un archivo JSON local.',
      error: failed[0]?.error ?? 'Unable to reach remote marketplace catalog.',
      ...(partialErrors ? { partialErrors } : {}),
    };
  }

  // Merge in priority order (official first, then earliest created_at — already sorted),
  // falling back to per-source stale cache when a source fails partially.
  const seenIds = new Set<string>();
  const merged: EnrichedMarketplaceManifest[] = [];
  const unapprovedSet = new Set<string>();
  const updatedAts: string[] = [];
  const versionParts: string[] = [];

  for (const outcome of outcomes) {
    const payload = outcome.ok
      ? {
          manifests: outcome.manifests,
          unapprovedIds: outcome.unapprovedIds,
          catalogVersion: outcome.catalogVersion,
          updatedAt: outcome.updatedAt,
        }
      : outcome.staleCache;

    if (!payload) {
      continue;
    }

    if (payload.updatedAt) {
      updatedAts.push(payload.updatedAt);
    }
    if (payload.catalogVersion) {
      versionParts.push(`${outcome.source.id}:${payload.catalogVersion}`);
    }
    for (const uid of payload.unapprovedIds) {
      if (!seenIds.has(uid)) {
        unapprovedSet.add(uid);
      }
    }
    for (const manifest of payload.manifests) {
      if (seenIds.has(manifest.id)) {
        continue;
      }
      seenIds.add(manifest.id);
      merged.push(
        enrichManifestEntry(
          manifest,
          {
            sourceId: outcome.source.id,
            sourceName: outcome.source.name,
            isOfficial: outcome.source.isOfficial,
            indexUpdatedAt: payload.updatedAt,
          },
          installedHashes,
        ),
      );
    }
  }

  const unapprovedIds = [...unapprovedSet].filter((id) => !seenIds.has(id));

  // Persist merged index + unapproved IDs for backward compatibility & install-by-id lookup
  db.prepare(
    `INSERT INTO external_cache (cache_key, payload_json, etag, fetched_at)
     VALUES ('marketplace:index', ?, NULL, ?)
     ON CONFLICT(cache_key) DO UPDATE SET
       payload_json = excluded.payload_json,
       fetched_at = excluded.fetched_at`,
  ).run(JSON.stringify(merged), nowSec);

  db.prepare(
    `INSERT INTO external_cache (cache_key, payload_json, etag, fetched_at)
     VALUES ('marketplace:unapproved', ?, NULL, ?)
     ON CONFLICT(cache_key) DO UPDATE SET
       payload_json = excluded.payload_json,
       fetched_at = excluded.fetched_at`,
  ).run(JSON.stringify(unapprovedIds), nowSec);

  updatedAts.sort();
  const latestUpdatedAt = updatedAts.length > 0 ? updatedAts[updatedAts.length - 1]! : null;
  let catalogVersion: string | null = null;
  if (succeeded.length === 1 && failed.length === 0) {
    catalogVersion = succeeded[0]!.catalogVersion || latestUpdatedAt;
  } else if (latestUpdatedAt) {
    catalogVersion = latestUpdatedAt;
  } else if (versionParts.length > 0) {
    catalogVersion = crypto
      .createHash('sha256')
      .update(versionParts.sort().join('|'))
      .digest('hex')
      .slice(0, 16);
  }

  const updatesAvailableCount = merged.filter((m) => m.updateAvailable).length;

  return {
    online: true,
    offline: false,
    providers: merged,
    manifests: merged,
    sources: updatedSources,
    catalogVersion,
    updatedAt: latestUpdatedAt,
    checkedAt: nowSec,
    updatesAvailableCount,
    enabledSourcesCount: enabledSources.length,
    source: enabledSources.length === 1 ? enabledSources[0]!.id : 'merged',
    ...(partialErrors ? { partialErrors } : {}),
  };
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

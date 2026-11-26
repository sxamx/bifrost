import type { DatabaseSync } from 'node:sqlite';
import {
  BIFROST_USER_AGENT,
  DEFAULT_CACHE_TTL_SEC,
  type FetchLike,
  readExternalCache,
  touchExternalCacheTimestamp,
  writeExternalCache,
} from './cache.js';

export const MODELS_DEV_API_URL = 'https://models.dev/api.json';
export const MODELS_DEV_MODELS_URL = 'https://models.dev/models.json';
export const CACHE_KEY_MODELS_DEV_API = 'models_dev:api';
export const CACHE_KEY_MODELS_DEV_MODELS = 'models_dev:models';

export interface ModelsDevModelEntry {
  id: string;
  name?: string;
  description?: string;
  family?: string;
  attachment?: boolean;
  reasoning?: boolean;
  tool_call?: boolean;
  structured_output?: boolean;
  temperature?: boolean;
  release_date?: string;
  last_updated?: string;
  modalities?: {
    input?: string[];
    output?: string[];
  };
  open_weights?: boolean;
  limit?: {
    context?: number;
    output?: number;
  };
  cost?: {
    input?: number;
    output?: number;
    cache_read?: number;
    cache_write?: number;
  };
}

export interface ModelsDevProviderEntry {
  id?: string;
  name?: string;
  api?: string;
  env?: string[];
  models?: Record<string, ModelsDevModelEntry>;
}

export type ModelsDevApiCatalog = Record<string, ModelsDevProviderEntry>;
export type ModelsDevCanonicalCatalog = Record<string, ModelsDevModelEntry>;

export interface ModelsDevSnapshot {
  api: ModelsDevApiCatalog;
  canonical: ModelsDevCanonicalCatalog;
}

export interface EnrichedModelMetadata {
  canonicalModelId: string | null;
  name: string | null;
  description: string | null;
  family: string | null;
  modalities: {
    input: string[];
    output: string[];
  } | null;
  capabilities: {
    tools: boolean;
    reasoning: boolean;
    structuredOutput: boolean;
  } | null;
  priceUsdPerMillion: {
    input: number | null;
    output: number | null;
  };
  contextLength: number | null;
  maxOutput: number | null;
  releaseDate: string | null;
  lastUpdated: string | null;
  openWeights: boolean | null;
}

export const MODELS_DEV_FETCH_TIMEOUT_MS = 10_000;

const inFlightModelsDevByDb = new WeakMap<DatabaseSync, Map<string, Promise<unknown>>>();

function getInFlightMap(db: DatabaseSync): Map<string, Promise<unknown>> {
  let map = inFlightModelsDevByDb.get(db);
  if (!map) {
    map = new Map();
    inFlightModelsDevByDb.set(db, map);
  }
  return map;
}

async function fetchJsonCached<T>(
  db: DatabaseSync,
  cacheKey: string,
  url: string,
  options: {
    fetchFn?: FetchLike;
    nowSec?: number;
    ttlSec?: number;
    forceRefresh?: boolean;
  } = {},
): Promise<T | null> {
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const nowSec = options.nowSec ?? Math.floor(Date.now() / 1000);
  const ttlSec = options.ttlSec ?? DEFAULT_CACHE_TTL_SEC;

  const existing = readExternalCache<T>(db, cacheKey);
  if (existing && !options.forceRefresh && nowSec - existing.fetchedAt < ttlSec) {
    return existing.data;
  }

  const inFlightMap = getInFlightMap(db);
  const existingInFlight = inFlightMap.get(cacheKey);
  if (existingInFlight) {
    return existingInFlight as Promise<T | null>;
  }

  const work = (async (): Promise<T | null> => {
    try {
      const headers: Record<string, string> = {
        'User-Agent': BIFROST_USER_AGENT,
        Accept: 'application/json',
      };
      if (existing?.etag) {
        headers['If-None-Match'] = existing.etag;
      }

      const res = await fetchFn(url, {
        headers,
        signal: AbortSignal.timeout(MODELS_DEV_FETCH_TIMEOUT_MS),
      });
      if (res.status === 304 && existing) {
        touchExternalCacheTimestamp(db, cacheKey, nowSec);
        return existing.data;
      }
      if (!res.ok) {
        return existing ? existing.data : null;
      }

      const parsed = (await res.json()) as T;
      const etag = res.headers.get('etag');
      writeExternalCache(db, cacheKey, parsed, etag, nowSec);
      return parsed;
    } catch {
      // Graceful fallback to cached snapshot when offline or upstream unavailable
      return existing ? existing.data : null;
    }
  })();

  inFlightMap.set(cacheKey, work);
  try {
    return await work;
  } finally {
    if (inFlightMap.get(cacheKey) === work) {
      inFlightMap.delete(cacheKey);
    }
  }
}

/**
 * Fetches and caches models.dev/api.json and models.dev/models.json in SQLite external_cache,
 * with singleflight deduplication per database instance.
 */
export async function loadModelsDevSnapshot(
  db: DatabaseSync,
  options: {
    fetchFn?: FetchLike;
    nowSec?: number;
    ttlSec?: number;
    forceRefresh?: boolean;
  } = {},
): Promise<ModelsDevSnapshot> {
  const inFlightMap = getInFlightMap(db);
  const snapshotKey = 'models_dev:snapshot';
  const existingInFlight = inFlightMap.get(snapshotKey);
  if (existingInFlight) {
    return existingInFlight as Promise<ModelsDevSnapshot>;
  }

  const work = (async (): Promise<ModelsDevSnapshot> => {
    const [api, canonical] = await Promise.all([
      fetchJsonCached<ModelsDevApiCatalog>(db, CACHE_KEY_MODELS_DEV_API, MODELS_DEV_API_URL, options),
      fetchJsonCached<ModelsDevCanonicalCatalog>(
        db,
        CACHE_KEY_MODELS_DEV_MODELS,
        MODELS_DEV_MODELS_URL,
        options,
      ),
    ]);

    return {
      api: api ?? {},
      canonical: canonical ?? {},
    };
  })();

  inFlightMap.set(snapshotKey, work);
  try {
    return await work;
  } finally {
    if (inFlightMap.get(snapshotKey) === work) {
      inFlightMap.delete(snapshotKey);
    }
  }
}

export function readCachedModelsDevSnapshot(db: DatabaseSync): ModelsDevSnapshot {
  const api = readExternalCache<ModelsDevApiCatalog>(db, CACHE_KEY_MODELS_DEV_API)?.data ?? {};
  const canonical =
    readExternalCache<ModelsDevCanonicalCatalog>(db, CACHE_KEY_MODELS_DEV_MODELS)?.data ?? {};
  return { api, canonical };
}

function normalizeProviderAliases(providerId: string): string[] {
  const slug = providerId.toLowerCase();
  if (slug === 'nvidia-nim') return ['nvidia', 'nvidia-nim'];
  if (slug === 'opencode-zen') return ['opencode', 'opencode-go', 'opencode-zen'];
  if (slug === 'google-ai-studio') return ['google', 'google-ai-studio'];
  return [slug];
}

const TIER_QUALIFIER_RE = /\b(?:ultra|super|lightning|omni|pro|mini|flash)\b/i;
const MOE_SUFFIX_RE = /-\d+(?:\.\d+)?b(?:-a\d+(?:\.\d+)?b)?(?:-reasoning)?$/i;

function stripMoeSuffixIfTiered(id: string): string | null {
  const slashIdx = id.indexOf('/');
  const prefix = slashIdx > 0 ? id.slice(0, slashIdx + 1) : '';
  const slug = slashIdx > 0 ? id.slice(slashIdx + 1) : id;
  if (!TIER_QUALIFIER_RE.test(slug) || !MOE_SUFFIX_RE.test(slug)) {
    return null;
  }
  const strippedSlug = slug.replace(MOE_SUFFIX_RE, '');
  if (!strippedSlug || strippedSlug === slug) {
    return null;
  }
  return `${prefix}${strippedSlug}`;
}

function finiteNumberOrNull(val: unknown): number | null {
  return typeof val === 'number' && Number.isFinite(val) ? val : null;
}

export function stripFreeAndDateSuffix(rawId: string): string {
  return rawId
    .trim()
    .replace(/:free$/i, '')
    .replace(/-free$/i, '')
    .replace(/-\d{8}$/, '');
}

export const MIN_VALID_MODEL_TIMESTAMP_SEC = 1577836800; // 2020-01-01T00:00:00Z

export function parseReleaseDateToUtcSeconds(releaseDate: string | null | undefined): number | null {
  if (typeof releaseDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(releaseDate.trim())) {
    return null;
  }
  const ms = Date.parse(`${releaseDate.trim()}T00:00:00Z`);
  if (!Number.isFinite(ms) || ms <= 0) {
    return null;
  }
  const sec = Math.floor(ms / 1000);
  if (sec < MIN_VALID_MODEL_TIMESTAMP_SEC) {
    return null;
  }
  return sec;
}

/**
 * Resolves `canonical_model_id` and enriches model metadata strictly following
 * the verified Phase 4 lookup hierarchy:
 *  1. Direct provider match in `api.json[providerKey].models[modelId]` (with optional `models/` strip)
 *  2. Stripped ID (`:free` / `-free` removed) in `models.json[strippedId]` and `api.json[vendor]`
 *  3. Upstream `canonical_slug` fallback with `-YYYYMMDD` stripped and tiered MoE alias linking
 *  4. Preserves `null` when unmatched (never converts `null` into `0`).
 */
export function resolveCanonicalAndEnrichModel(
  providerId: string,
  modelId: string,
  snapshot: ModelsDevSnapshot,
  upstreamHints?: { canonicalSlug?: string | null },
): EnrichedModelMetadata {
  let providerHit: ModelsDevModelEntry | undefined;
  let canonicalHit: ModelsDevModelEntry | undefined;
  let canonicalModelId: string | null = null;

  const providerAliases = normalizeProviderAliases(providerId);
  const modelIdWithoutModelsPrefix = /^models\//i.test(modelId) ? modelId.slice(7) : null;

  // Step 1: Direct lookup under provider key(s) in models.dev/api.json
  for (const provKey of providerAliases) {
    const modelsMap = snapshot.api[provKey]?.models;
    if (!modelsMap) continue;
    const candidate =
      modelsMap[modelId] ??
      (modelIdWithoutModelsPrefix ? modelsMap[modelIdWithoutModelsPrefix] : undefined);
    if (candidate) {
      providerHit = candidate;
      break;
    }
  }

  // Step 2: Stripped ID lookup in models.json & vendor entry of api.json
  const strippedPrimary = modelId.replace(/:free$/i, '').replace(/-free$/i, '');
  const candidateCanonicalIds: string[] = [];
  const pushCandidate = (id: string | null | undefined) => {
    const cleaned = id?.trim();
    if (cleaned && !candidateCanonicalIds.includes(cleaned)) {
      candidateCanonicalIds.push(cleaned);
    }
  };

  pushCandidate(strippedPrimary);
  if (/^models\//i.test(strippedPrimary)) {
    const unprefixed = strippedPrimary.slice(7);
    pushCandidate(unprefixed);
    pushCandidate(stripFreeAndDateSuffix(unprefixed));
    if (!unprefixed.includes('/')) {
      for (const provKey of providerAliases) {
        pushCandidate(`${provKey}/${unprefixed}`);
        pushCandidate(`${provKey}/${stripFreeAndDateSuffix(unprefixed)}`);
      }
    }
  }

  if (upstreamHints?.canonicalSlug) {
    const cleanedSlug = stripFreeAndDateSuffix(upstreamHints.canonicalSlug);
    pushCandidate(cleanedSlug);
    if (/^models\//i.test(cleanedSlug)) {
      pushCandidate(cleanedSlug.slice(7));
    }
  }

  const strippedNoDate = stripFreeAndDateSuffix(strippedPrimary);
  pushCandidate(strippedNoDate);

  if (!strippedNoDate.includes('/')) {
    for (const provKey of providerAliases) {
      pushCandidate(`${provKey}/${strippedNoDate}`);
    }
  }

  // Add tiered MoE-stripped aliases AFTER exact candidates so exact matches always take priority
  const baseCandidatesSnapshot = [...candidateCanonicalIds];
  for (const cand of baseCandidatesSnapshot) {
    const moeStripped = stripMoeSuffixIfTiered(cand);
    if (moeStripped) {
      pushCandidate(moeStripped);
    }
  }

  for (const cand of candidateCanonicalIds) {
    if (!canonicalHit && snapshot.canonical[cand]) {
      canonicalHit = snapshot.canonical[cand];
      if (canonicalModelId === null) {
        canonicalModelId = cand;
      }
    }

    if (!providerHit) {
      const slashIdx = cand.indexOf('/');
      if (slashIdx > 0) {
        const vendor = cand.slice(0, slashIdx);
        const modelSlug = cand.slice(slashIdx + 1);
        const vendorDirect =
          snapshot.api[vendor]?.models?.[cand] ?? snapshot.api[vendor]?.models?.[modelSlug];
        if (vendorDirect) {
          providerHit = vendorDirect;
          if (canonicalModelId === null) {
            canonicalModelId = cand;
          }
          if (!canonicalHit && snapshot.canonical[`${vendor}/${modelSlug}`]) {
            canonicalHit = snapshot.canonical[`${vendor}/${modelSlug}`];
          }
        }
      } else {
        for (const provKey of providerAliases) {
          const direct =
            snapshot.api[provKey]?.models?.[cand] ??
            snapshot.api[provKey]?.models?.[`${provKey}/${cand}`];
          if (direct) {
            providerHit = direct;
            if (canonicalModelId === null) {
              canonicalModelId = cand;
            }
            break;
          }
        }
      }
    }

    if (providerHit && canonicalHit) {
      break;
    }
  }

  // Bidirectional tiered MoE alias link (e.g., `nemotron-3.5-super-vl` <-> `nemotron-3.5-super-vl-120b-a12b`)
  if (!canonicalHit || !providerHit) {
    const tieredLookupSet = new Set<string>();
    for (const cand of candidateCanonicalIds) {
      if (TIER_QUALIFIER_RE.test(cand)) {
        tieredLookupSet.add(cand.toLowerCase());
        const slashIdx = cand.indexOf('/');
        if (slashIdx > 0) {
          tieredLookupSet.add(cand.slice(slashIdx + 1).toLowerCase());
        }
      }
    }

    if (tieredLookupSet.size > 0) {
      if (!canonicalHit) {
        for (const [canonKey, canonEntry] of Object.entries(snapshot.canonical)) {
          const strippedKey = stripMoeSuffixIfTiered(canonKey);
          if (!strippedKey) continue;
          const lowerStripped = strippedKey.toLowerCase();
          const slashIdx = lowerStripped.indexOf('/');
          const slugOnly = slashIdx > 0 ? lowerStripped.slice(slashIdx + 1) : lowerStripped;
          if (tieredLookupSet.has(lowerStripped) || tieredLookupSet.has(slugOnly)) {
            canonicalHit = canonEntry;
            if (canonicalModelId === null) {
              canonicalModelId = canonKey;
            }
            break;
          }
        }
      }

      if (!providerHit) {
        const searchVendors = new Set<string>(providerAliases);
        for (const cand of candidateCanonicalIds) {
          const slashIdx = cand.indexOf('/');
          if (slashIdx > 0) {
            searchVendors.add(cand.slice(0, slashIdx).toLowerCase());
          }
        }
        outer: for (const vendor of searchVendors) {
          const modelsMap = snapshot.api[vendor]?.models;
          if (!modelsMap) continue;
          for (const [mKey, mEntry] of Object.entries(modelsMap)) {
            const strippedKey = stripMoeSuffixIfTiered(mKey);
            if (!strippedKey) continue;
            const lowerStripped = strippedKey.toLowerCase();
            const slashIdx = lowerStripped.indexOf('/');
            const slugOnly = slashIdx > 0 ? lowerStripped.slice(slashIdx + 1) : lowerStripped;
            if (tieredLookupSet.has(lowerStripped) || tieredLookupSet.has(slugOnly)) {
              providerHit = mEntry;
              if (canonicalModelId === null) {
                canonicalModelId = mKey;
              }
              break outer;
            }
          }
        }
      }
    }
  }

  if (canonicalModelId === null && providerHit) {
    canonicalModelId = stripFreeAndDateSuffix(providerHit.id || strippedPrimary);
  }

  const mergedModalities = providerHit?.modalities ?? canonicalHit?.modalities;
  const hasModalities =
    mergedModalities &&
    (Array.isArray(mergedModalities.input) || Array.isArray(mergedModalities.output));

  const hasCapabilitiesSource = Boolean(providerHit || canonicalHit);

  const costInput =
    finiteNumberOrNull(providerHit?.cost?.input) ?? finiteNumberOrNull(canonicalHit?.cost?.input);
  const costOutput =
    finiteNumberOrNull(providerHit?.cost?.output) ?? finiteNumberOrNull(canonicalHit?.cost?.output);

  const contextLength =
    finiteNumberOrNull(providerHit?.limit?.context) ??
    finiteNumberOrNull(canonicalHit?.limit?.context);

  const maxOutput =
    finiteNumberOrNull(providerHit?.limit?.output) ??
    finiteNumberOrNull(canonicalHit?.limit?.output);

  const openWeights =
    typeof providerHit?.open_weights === 'boolean'
      ? providerHit.open_weights
      : typeof canonicalHit?.open_weights === 'boolean'
        ? canonicalHit.open_weights
        : null;

  return {
    canonicalModelId,
    name: providerHit?.name ?? canonicalHit?.name ?? null,
    description: providerHit?.description ?? canonicalHit?.description ?? null,
    family: providerHit?.family ?? canonicalHit?.family ?? null,
    modalities: hasModalities
      ? {
          input: Array.isArray(mergedModalities?.input) ? [...mergedModalities.input] : ['text'],
          output: Array.isArray(mergedModalities?.output) ? [...mergedModalities.output] : ['text'],
        }
      : null,
    capabilities: hasCapabilitiesSource
      ? {
          tools: Boolean(providerHit?.tool_call ?? canonicalHit?.tool_call ?? false),
          reasoning: Boolean(providerHit?.reasoning ?? canonicalHit?.reasoning ?? false),
          structuredOutput: Boolean(
            providerHit?.structured_output ?? canonicalHit?.structured_output ?? false,
          ),
        }
      : null,
    priceUsdPerMillion: {
      input: costInput,
      output: costOutput,
    },
    contextLength,
    maxOutput,
    releaseDate: (() => {
      const rawRel = providerHit?.release_date ?? canonicalHit?.release_date ?? null;
      return parseReleaseDateToUtcSeconds(rawRel) !== null ? rawRel : null;
    })(),
    lastUpdated: providerHit?.last_updated ?? canonicalHit?.last_updated ?? null,
    openWeights,
  };
}

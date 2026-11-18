import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  BIFROST_USER_AGENT,
  DEFAULT_CACHE_TTL_SEC,
  type FetchLike,
  readExternalCache,
  touchExternalCacheTimestamp,
  writeExternalCache,
} from './cache.js';
import { readZipArchive } from './zip.js';

export const LMARENA_AGENT_URL =
  'https://datasets-server.huggingface.co/rows?dataset=lmarena-ai%2Fleaderboard-dataset&config=agent&split=latest&offset=0&length=100';
export const AW_BENCH_INDEX_URL = 'https://artificialwatch.com/data/bench-index.json';
export const AW_CODING_INDEX_URL = 'https://artificialwatch.com/data/coding-index.json';
export const EPOCH_AI_ZIP_URL = 'https://epoch.ai/data/benchmark_data.zip';
export const OPENCHARTS_RANKINGS_URL = 'https://www.opencharts.com/benchmarks/rankings.json';
export const OPENCHARTS_METHODOLOGY_URL = 'https://www.opencharts.com/benchmarks/methodology';

export const CACHE_KEY_LMARENA_AGENT = 'lmarena:agent';
export const CACHE_KEY_AW_BENCH = 'aw:bench';
export const CACHE_KEY_AW_CODING = 'aw:coding';
export const CACHE_KEY_EPOCH_INTERNAL = 'epoch:internal';
export const CACHE_KEY_OPENCHARTS = 'opencharts:rankings';

// ============================================================================
// 1. LMArena (lmarena-ai/leaderboard-dataset, agent/latest, CC BY 4.0)
// ============================================================================
export interface LmArenaAgentEntry {
  model: string;
  organization: string | null;
  license: string | null;
  /** Native LMArena agent leaderboard score (NOT Elo and NOT percentage) */
  score: number;
  confidenceInterval: {
    lower: number | null;
    upper: number | null;
  };
  sessions: number | null;
  votes: number | null;
  rank: number | null;
  category: string;
  medianCostPerTaskUsd: number | null;
  leaderboardPublishDate: string | null;
}

export interface LmArenaAgentSnapshot {
  source: 'lmarena';
  license: 'CC BY 4.0';
  attribution: string;
  sourceUrl: string;
  capturedAt: string;
  entries: LmArenaAgentEntry[];
}

export function filterLmArenaPayload(raw: unknown, capturedAtIso: string): LmArenaAgentSnapshot {
  const rowsRaw =
    raw &&
    typeof raw === 'object' &&
    'rows' in raw &&
    Array.isArray((raw as { rows: unknown[] }).rows)
      ? (raw as { rows: Array<{ row?: Record<string, unknown> }> }).rows
      : [];

  const entries: LmArenaAgentEntry[] = [];
  for (const wrapper of rowsRaw) {
    const r = wrapper?.row ?? (wrapper as unknown as Record<string, unknown>);
    if (!r || typeof r !== 'object') continue;
    const modelName =
      typeof r.model_name === 'string'
        ? r.model_name
        : typeof r.model === 'string'
          ? r.model
          : null;
    const score = typeof r.score === 'number' && Number.isFinite(r.score) ? r.score : null;
    if (!modelName || score === null) continue;

    entries.push({
      model: modelName,
      organization: typeof r.organization === 'string' ? r.organization : null,
      license: typeof r.license === 'string' ? r.license : null,
      score, // Preserved on native scale as-is
      confidenceInterval: {
        lower:
          typeof r.score_ci_lower === 'number' && Number.isFinite(r.score_ci_lower)
            ? r.score_ci_lower
            : null,
        upper:
          typeof r.score_ci_upper === 'number' && Number.isFinite(r.score_ci_upper)
            ? r.score_ci_upper
            : null,
      },
      sessions: typeof r.session_count === 'number' ? r.session_count : null,
      votes: typeof r.observation_count === 'number' ? r.observation_count : null,
      rank: typeof r.rank === 'number' ? r.rank : null,
      category: typeof r.category === 'string' ? r.category : 'overall',
      medianCostPerTaskUsd:
        typeof r.cost_per_task_p50 === 'number' && Number.isFinite(r.cost_per_task_p50)
          ? r.cost_per_task_p50
          : null,
      leaderboardPublishDate:
        typeof r.leaderboard_publish_date === 'string' ? r.leaderboard_publish_date : null,
    });
  }

  return {
    source: 'lmarena',
    license: 'CC BY 4.0',
    attribution:
      'LMArena Agent Leaderboard (lmarena-ai/leaderboard-dataset, CC BY 4.0) — https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset',
    sourceUrl: 'https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset',
    capturedAt: capturedAtIso,
    entries,
  };
}

// ============================================================================
// 2. ArtificialWatch (bench-index.json & coding-index.json, CC BY 4.0)
//    Fail-closed rule: strip `scores[board].raw` BEFORE saving to SQLite!
//    Recalculate `boards` and `rank` locally from licensed `index`/`percentile`.
// ============================================================================
export interface ArtificialWatchFilteredModel {
  id: string;
  name: string;
  vendor: string | null;
  index: number;
  rank: number;
  boards: number;
  scores: Record<string, { percentile: number }>;
  page: string | null;
}

export interface ArtificialWatchSnapshot {
  source: 'artificialwatch';
  kind: 'bench' | 'coding';
  license: string;
  attribution: string;
  sourceUrl: string;
  generatedAt: string | null;
  sources: Record<string, { name?: string }> | null;
  models: ArtificialWatchFilteredModel[];
}

export function filterArtificialWatchPayload(
  raw: unknown,
  kind: 'bench' | 'coding',
): ArtificialWatchSnapshot {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Invalid ArtificialWatch JSON payload.');
  }
  const obj = raw as Record<string, unknown>;
  const rawModels = Array.isArray(obj.models) ? obj.models : [];

  const preliminary: Array<Omit<ArtificialWatchFilteredModel, 'rank'>> = [];

  for (const item of rawModels) {
    if (!item || typeof item !== 'object') continue;
    const m = item as Record<string, unknown>;
    if (typeof m.id !== 'string' || typeof m.name !== 'string') continue;
    if (typeof m.index !== 'number' || !Number.isFinite(m.index)) continue;

    // Actively strip `raw` from every board score — keep ONLY `percentile`!
    const cleanScores: Record<string, { percentile: number }> = {};
    if (m.scores && typeof m.scores === 'object' && !Array.isArray(m.scores)) {
      for (const [boardKey, boardVal] of Object.entries(m.scores as Record<string, unknown>)) {
        if (boardVal && typeof boardVal === 'object') {
          const pct = (boardVal as Record<string, unknown>).percentile;
          if (typeof pct === 'number' && Number.isFinite(pct)) {
            cleanScores[boardKey] = { percentile: pct };
          }
        }
      }
    }

    preliminary.push({
      id: m.id,
      name: m.name,
      vendor: typeof m.vendor === 'string' ? m.vendor : null,
      index: m.index,
      boards: Object.keys(cleanScores).length,
      scores: cleanScores,
      page: typeof m.page === 'string' ? m.page : null,
    });
  }

  // Recalculate rank locally from licensed `index` descending (competition ranking on ties)
  preliminary.sort((a, b) => b.index - a.index || a.id.localeCompare(b.id));
  const models: ArtificialWatchFilteredModel[] = [];
  for (let i = 0; i < preliminary.length; i += 1) {
    const rank =
      i > 0 && preliminary[i]!.index === preliminary[i - 1]!.index ? models[i - 1]!.rank : i + 1;
    models.push({
      ...preliminary[i]!,
      rank,
    });
  }

  const defaultUrl =
    kind === 'coding' ? 'https://artificialwatch.com/coding' : 'https://artificialwatch.com';

  let cleanSources: Record<string, { name?: string }> | null = null;
  if (obj.sources && typeof obj.sources === 'object' && !Array.isArray(obj.sources)) {
    cleanSources = {};
    for (const [k, v] of Object.entries(obj.sources as Record<string, unknown>)) {
      if (v && typeof v === 'object') {
        const name = (v as Record<string, unknown>).name;
        cleanSources[k] = typeof name === 'string' ? { name } : {};
      }
    }
  }

  return {
    source: 'artificialwatch',
    kind,
    license: 'CC BY 4.0',
    attribution:
      typeof obj.attribution === 'string'
        ? obj.attribution
        : `ArtificialWatch ${kind === 'coding' ? 'Coding' : 'Bench'} Index (CC BY 4.0) — ${defaultUrl}`,
    sourceUrl: typeof obj.url === 'string' ? obj.url : defaultUrl,
    generatedAt: typeof obj.generatedAt === 'string' ? obj.generatedAt : null,
    sources: cleanSources,
    models,
  };
}

// ============================================================================
// 3. Epoch AI (benchmark_data.zip, CC BY 4.0)
//    Fail-closed rule: skip 100% of `*_external.csv` & `processed_data_for_eci.csv`;
//    require internal Inspect columns (`mean_score`, `Best score (across scorers)`,
//    `stderr`) and absence of `Source` / `Source link`; parse `eci_scores.csv`.
// ============================================================================
export interface EpochInternalRunScore {
  benchmark: string;
  modelVersion: string;
  meanScore: number | null;
  bestScore: number | null;
  stderr: number | null;
  organization: string | null;
  releaseDate: string | null;
  startedAt: string | null;
}

export interface EpochEciEntry {
  model: string;
  displayName: string | null;
  eci: number;
  eciCiLow: number | null;
  eciCiHigh: number | null;
  date: string | null;
  organization: string | null;
}

export interface EpochAiSnapshot {
  source: 'epoch_ai';
  license: 'CC BY 4.0';
  attribution: string;
  sourceUrl: string;
  capturedAt: string;
  includedBenchmarkFiles: string[];
  skippedExternalFilesCount: number;
  eciScores: EpochEciEntry[];
  internalRuns: EpochInternalRunScore[];
}

/**
 * RFC-4180 compliant CSV parser handling quoted fields, embedded commas/newlines, and `""` escapes.
 */
export function parseCsvRows(csvText: string): string[][] {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let field = '';
  let inQuotes = false;

  const normalized = csvText.replace(/^\uFEFF/, '');
  for (let i = 0; i < normalized.length; i += 1) {
    const ch = normalized[i]!;

    if (inQuotes) {
      if (ch === '"') {
        if (normalized[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      currentRow.push(field);
      field = '';
    } else if (ch === '\r') {
      if (normalized[i + 1] === '\n') {
        i += 1;
      }
      currentRow.push(field);
      field = '';
      if (currentRow.length > 1 || currentRow[0] !== '') {
        rows.push(currentRow);
      }
      currentRow = [];
    } else if (ch === '\n') {
      currentRow.push(field);
      field = '';
      if (currentRow.length > 1 || currentRow[0] !== '') {
        rows.push(currentRow);
      }
      currentRow = [];
    } else {
      field += ch;
    }
  }

  if (field.length > 0 || currentRow.length > 0) {
    currentRow.push(field);
    if (currentRow.length > 1 || currentRow[0] !== '') {
      rows.push(currentRow);
    }
  }

  return rows;
}

function parseOptionalNumber(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const num = Number(trimmed);
  return Number.isFinite(num) ? num : null;
}

export function parseAndFilterEpochZip(
  zipBuffer: Buffer,
  capturedAtIso: string = new Date().toISOString(),
): EpochAiSnapshot {
  const entries = readZipArchive(zipBuffer);
  const includedBenchmarkFiles: string[] = [];
  let skippedExternalFilesCount = 0;
  const eciScores: EpochEciEntry[] = [];
  const internalRuns: EpochInternalRunScore[] = [];

  for (const entry of entries) {
    const normalizedPath = entry.filename.replace(/\\/g, '/');
    const baseName = path.posix.basename(normalizedPath);
    const lowerBase = baseName.toLowerCase();

    if (!lowerBase.endsWith('.csv')) {
      continue;
    }

    // 1. Fail-closed: unconditionally skip 100% of *_external.csv files
    if (lowerBase.endsWith('_external.csv')) {
      skippedExternalFilesCount += 1;
      continue;
    }

    // 2. Skip processed_data_for_eci.csv (contains mixed external rows with empty source)
    if (lowerBase === 'processed_data_for_eci.csv') {
      skippedExternalFilesCount += 1;
      continue;
    }

    // 3. Skip non-run metadata CSVs
    if (lowerBase === 'benchmark_metadata.csv' || lowerBase === 'model_metadata.csv') {
      continue;
    }

    // 4. Parse Epoch Capabilities Index (eci_scores.csv)
    if (lowerBase === 'eci_scores.csv') {
      const rows = parseCsvRows(entry.readText());
      if (rows.length < 2) continue;
      const headers = rows[0]!.map((h) => h.trim());
      const idxModel = headers.indexOf('Model');
      const idxDisplay = headers.indexOf('Display name');
      const idxEci = headers.indexOf('eci');
      const idxLow = headers.indexOf('eci_ci_low');
      const idxHigh = headers.indexOf('eci_ci_high');
      const idxDate = headers.indexOf('date');
      const idxOrg = headers.indexOf('Organization');

      if (idxModel === -1 || idxEci === -1) continue;

      for (let r = 1; r < rows.length; r += 1) {
        const cols = rows[r]!;
        const model = cols[idxModel]?.trim();
        const eci = parseOptionalNumber(cols[idxEci]);
        if (!model || eci === null) continue;
        eciScores.push({
          model,
          displayName:
            idxDisplay !== -1 && cols[idxDisplay]?.trim() ? cols[idxDisplay]!.trim() : null,
          eci,
          eciCiLow: idxLow !== -1 ? parseOptionalNumber(cols[idxLow]) : null,
          eciCiHigh: idxHigh !== -1 ? parseOptionalNumber(cols[idxHigh]) : null,
          date: idxDate !== -1 && cols[idxDate]?.trim() ? cols[idxDate]!.trim() : null,
          organization: idxOrg !== -1 && cols[idxOrg]?.trim() ? cols[idxOrg]!.trim() : null,
        });
      }
      continue;
    }

    // 5. Verify Inspect internal-run schema columns (and reject any file with external `Source` column!)
    const rows = parseCsvRows(entry.readText());
    if (rows.length < 2) continue;
    const headers = rows[0]!.map((h) => h.trim());
    const lowerHeaders = headers.map((h) => h.toLowerCase());

    if (lowerHeaders.includes('source') || lowerHeaders.includes('source link')) {
      skippedExternalFilesCount += 1;
      continue;
    }

    const idxModelVer = headers.indexOf('Model version');
    const idxMean = headers.indexOf('mean_score');
    const idxBest = headers.indexOf('Best score (across scorers)');
    const idxStderr = headers.indexOf('stderr');
    const idxOrg = headers.indexOf('Organization');
    const idxRelease = headers.indexOf('Release date');
    const idxStarted = headers.indexOf('Started at');

    if (idxModelVer === -1 || idxMean === -1 || idxBest === -1 || idxStderr === -1) {
      continue;
    }

    const benchmarkSlug = baseName.replace(/\.csv$/i, '');
    includedBenchmarkFiles.push(baseName);

    for (let r = 1; r < rows.length; r += 1) {
      const cols = rows[r]!;
      const modelVersion = cols[idxModelVer]?.trim();
      if (!modelVersion) continue;
      const meanScore = parseOptionalNumber(cols[idxMean]);
      const bestScore = parseOptionalNumber(cols[idxBest]);
      if (meanScore === null && bestScore === null) continue;

      internalRuns.push({
        benchmark: benchmarkSlug,
        modelVersion,
        meanScore,
        bestScore,
        stderr: parseOptionalNumber(cols[idxStderr]),
        organization: idxOrg !== -1 && cols[idxOrg]?.trim() ? cols[idxOrg]!.trim() : null,
        releaseDate:
          idxRelease !== -1 && cols[idxRelease]?.trim() ? cols[idxRelease]!.trim() : null,
        startedAt:
          idxStarted !== -1 && cols[idxStarted]?.trim() ? cols[idxStarted]!.trim() : null,
      });
    }
  }

  includedBenchmarkFiles.sort();

  return {
    source: 'epoch_ai',
    license: 'CC BY 4.0',
    attribution:
      "Epoch AI, 'Capabilities & benchmarking' (CC BY 4.0). Published online at epoch.ai. Retrieved from 'https://epoch.ai/benchmarks'.",
    sourceUrl: 'https://epoch.ai/benchmarks',
    capturedAt: capturedAtIso,
    includedBenchmarkFiles,
    skippedExternalFilesCount,
    eciScores,
    internalRuns,
  };
}

// ============================================================================
// 4. OpenCharts (https://www.opencharts.com/benchmarks/rankings.json)
//    Fail-closed rule: extract ONLY OpenCharts' own composite index, grade,
//    and rankRange bands + methodology link; strip third-party `scores[].value`!
// ============================================================================
export interface OpenChartsFilteredModel {
  slug: string;
  name: string;
  lab: string | null;
  index: number;
  indexRange: { min: number; max: number } | null;
  grade: string | null;
  rank: number | null;
  rankRange: { min: number; max: number } | null;
  url: string | null;
}

export interface OpenChartsSnapshot {
  source: 'opencharts';
  attribution: string;
  methodologyUrl: string;
  sourceUrl: string;
  generatedAt: string | null;
  models: OpenChartsFilteredModel[];
}

export function filterOpenChartsPayload(raw: unknown): OpenChartsSnapshot {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Invalid OpenCharts JSON payload.');
  }

  const root = Array.isArray(raw) ? { models: raw } : (raw as Record<string, unknown>);
  const rawList = Array.isArray(root.models)
    ? root.models
    : Array.isArray(root.rankings)
      ? root.rankings
      : [];

  const models: OpenChartsFilteredModel[] = [];
  for (const item of rawList) {
    if (!item || typeof item !== 'object') continue;
    const m = item as Record<string, unknown>;
    if (typeof m.slug !== 'string' || typeof m.name !== 'string') continue;
    const rawIdx = m.index ?? m.compositeIndex;
    if (typeof rawIdx !== 'number' || !Number.isFinite(rawIdx)) continue;

    const parseRange = (val: unknown): { min: number; max: number } | null => {
      if (!val || typeof val !== 'object') return null;
      const r = val as Record<string, unknown>;
      if (typeof r.min === 'number' && typeof r.max === 'number') {
        return { min: r.min, max: r.max };
      }
      return null;
    };

    // Explicitly extract ONLY OpenCharts' own composite index, grade, and rankRange;
    // `m.scores` (third-party benchmark values) and `m.categories` are NEVER copied!
    models.push({
      slug: m.slug,
      name: m.name,
      lab: typeof m.lab === 'string' ? m.lab : null,
      index: rawIdx,
      indexRange: parseRange(m.indexRange),
      grade: typeof m.grade === 'string' ? m.grade : null,
      rank: typeof m.rank === 'number' ? m.rank : null,
      rankRange: parseRange(m.rankRange),
      url: typeof m.url === 'string' ? m.url : null,
    });
  }

  return {
    source: 'opencharts',
    attribution:
      typeof root.attribution === 'string'
        ? root.attribution
        : 'OpenCharts Composite Index & Grade — https://www.opencharts.com/benchmarks',
    methodologyUrl: OPENCHARTS_METHODOLOGY_URL,
    sourceUrl: 'https://www.opencharts.com/benchmarks',
    generatedAt: typeof root.generatedAt === 'string' ? root.generatedAt : null,
    models,
  };
}

// ============================================================================
// Sync & Cache Orchestrators (filtering happens BEFORE SQLite persistence!)
// ============================================================================
async function syncFilteredJsonSource<T>(
  db: DatabaseSync,
  cacheKey: string,
  url: string,
  transform: (raw: unknown, nowIso: string) => T,
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
      signal: AbortSignal.timeout(4000),
    });
    if (res.status === 304 && existing) {
      touchExternalCacheTimestamp(db, cacheKey, nowSec);
      return existing.data;
    }
    if (!res.ok) {
      return existing ? existing.data : null;
    }

    const rawJson = (await res.json()) as unknown;
    const filtered = transform(rawJson, new Date(nowSec * 1000).toISOString());
    writeExternalCache(db, cacheKey, filtered, res.headers.get('etag'), nowSec);
    return filtered;
  } catch {
    return existing ? existing.data : null;
  }
}

export async function syncLmArenaAgentBenchmarks(
  db: DatabaseSync,
  options: { fetchFn?: FetchLike; nowSec?: number; ttlSec?: number; forceRefresh?: boolean } = {},
): Promise<LmArenaAgentSnapshot | null> {
  return syncFilteredJsonSource(
    db,
    CACHE_KEY_LMARENA_AGENT,
    LMARENA_AGENT_URL,
    (raw, nowIso) => filterLmArenaPayload(raw, nowIso),
    options,
  );
}

export async function syncArtificialWatchBenchmarks(
  db: DatabaseSync,
  options: { fetchFn?: FetchLike; nowSec?: number; ttlSec?: number; forceRefresh?: boolean } = {},
): Promise<{
  bench: ArtificialWatchSnapshot | null;
  coding: ArtificialWatchSnapshot | null;
}> {
  const [bench, coding] = await Promise.all([
    syncFilteredJsonSource(
      db,
      CACHE_KEY_AW_BENCH,
      AW_BENCH_INDEX_URL,
      (raw) => filterArtificialWatchPayload(raw, 'bench'),
      options,
    ),
    syncFilteredJsonSource(
      db,
      CACHE_KEY_AW_CODING,
      AW_CODING_INDEX_URL,
      (raw) => filterArtificialWatchPayload(raw, 'coding'),
      options,
    ),
  ]);
  return { bench, coding };
}

export async function syncEpochAiBenchmarks(
  db: DatabaseSync,
  options: { fetchFn?: FetchLike; nowSec?: number; ttlSec?: number; forceRefresh?: boolean } = {},
): Promise<EpochAiSnapshot | null> {
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const nowSec = options.nowSec ?? Math.floor(Date.now() / 1000);
  const ttlSec = options.ttlSec ?? DEFAULT_CACHE_TTL_SEC;

  const existing = readExternalCache<EpochAiSnapshot>(db, CACHE_KEY_EPOCH_INTERNAL);
  if (existing && !options.forceRefresh && nowSec - existing.fetchedAt < ttlSec) {
    return existing.data;
  }

  try {
    const headers: Record<string, string> = {
      'User-Agent': BIFROST_USER_AGENT,
    };
    if (existing?.etag) {
      headers['If-None-Match'] = existing.etag;
    }

    const res = await fetchFn(EPOCH_AI_ZIP_URL, {
      headers,
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 304 && existing) {
      touchExternalCacheTimestamp(db, CACHE_KEY_EPOCH_INTERNAL, nowSec);
      return existing.data;
    }
    if (!res.ok) {
      return existing ? existing.data : null;
    }

    const zipArrayBuf = await res.arrayBuffer();
    const filtered = parseAndFilterEpochZip(
      Buffer.from(zipArrayBuf),
      new Date(nowSec * 1000).toISOString(),
    );
    writeExternalCache(db, CACHE_KEY_EPOCH_INTERNAL, filtered, res.headers.get('etag'), nowSec);
    return filtered;
  } catch {
    return existing ? existing.data : null;
  }
}

export async function syncOpenChartsBenchmarks(
  db: DatabaseSync,
  options: { fetchFn?: FetchLike; nowSec?: number; ttlSec?: number; forceRefresh?: boolean } = {},
): Promise<OpenChartsSnapshot | null> {
  return syncFilteredJsonSource(
    db,
    CACHE_KEY_OPENCHARTS,
    OPENCHARTS_RANKINGS_URL,
    (raw) => filterOpenChartsPayload(raw),
    options,
  );
}

function normalizeMatchTokens(idOrName: string): string {
  return idOrName
    .toLowerCase()
    .replace(/\s*\(free\)\s*$/i, '')
    .replace(/:free$/i, '')
    .replace(/-free$/i, '')
    .replace(/^[^/]+\//, '')
    .replace(/[^a-z0-9]+/g, '');
}

function formatRankRangeText(range: { min: number; max: number } | null, rank: number | null): string | null {
  if (range) {
    return range.min === range.max ? `#${range.min}` : `#${range.min}–#${range.max}`;
  }
  if (rank !== null) {
    return `#${rank}`;
  }
  return null;
}

function formatBenchmarkDisplayName(slug: string): string {
  return slug
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) =>
      part.length <= 4 ? part.toUpperCase() : part[0]!.toUpperCase() + part.slice(1),
    )
    .join(' ');
}

function medianOf(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const val =
    sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  return Math.round(val * 100) / 100;
}

/**
 * Looks up cached public benchmark results for a model across all 4 licensed sources.
 * Never mixes scales across boards; returns `null` for sources without a match.
 */
export function getCachedModelBenchmarks(
  db: DatabaseSync,
  modelLookup: { canonicalModelId?: string | null; modelId: string; name?: string | null },
) {
  const keys = new Set<string>();
  for (const cand of [modelLookup.canonicalModelId, modelLookup.modelId, modelLookup.name]) {
    if (cand) {
      const norm = normalizeMatchTokens(cand);
      if (norm.length >= 3) keys.add(norm);
    }
  }

  const matchesKey = (...candidates: Array<string | null | undefined>): boolean => {
    for (const c of candidates) {
      if (!c) continue;
      if (keys.has(normalizeMatchTokens(c))) return true;
    }
    return false;
  };

  const lmarenaSnap = readExternalCache<LmArenaAgentSnapshot>(db, CACHE_KEY_LMARENA_AGENT)?.data;
  const awBenchSnap = readExternalCache<ArtificialWatchSnapshot>(db, CACHE_KEY_AW_BENCH)?.data;
  const awCodingSnap = readExternalCache<ArtificialWatchSnapshot>(db, CACHE_KEY_AW_CODING)?.data;
  const epochSnap = readExternalCache<EpochAiSnapshot>(db, CACHE_KEY_EPOCH_INTERNAL)?.data;
  const ocSnap = readExternalCache<OpenChartsSnapshot>(db, CACHE_KEY_OPENCHARTS)?.data;

  const lmarenaMatch = lmarenaSnap?.entries.find((e) => matchesKey(e.model)) ?? null;
  const awBenchMatch = awBenchSnap?.models.find((m) => matchesKey(m.id, m.name)) ?? null;
  const awCodingMatch = awCodingSnap?.models.find((m) => matchesKey(m.id, m.name)) ?? null;
  const epochEciMatch =
    epochSnap?.eciScores.find((e) => matchesKey(e.model, e.displayName)) ?? null;
  const epochRuns = epochSnap?.internalRuns.filter((r) => matchesKey(r.modelVersion)) ?? [];
  const openChartsMatch = ocSnap?.models.find((m) => matchesKey(m.slug, m.name)) ?? null;

  return {
    lmarenaSnap: lmarenaSnap ?? null,
    awBenchSnap: awBenchSnap ?? null,
    awCodingSnap: awCodingSnap ?? null,
    epochSnap: epochSnap ?? null,
    ocSnap: ocSnap ?? null,
    matchesKey,
    lmarena: lmarenaMatch
      ? {
          entry: lmarenaMatch,
          attribution: lmarenaSnap!.attribution,
          sourceUrl: lmarenaSnap!.sourceUrl,
          capturedAt: lmarenaSnap!.capturedAt,
        }
      : null,
    artificialWatch: {
      bench: awBenchMatch
        ? {
            model: awBenchMatch,
            attribution: awBenchSnap!.attribution,
            sourceUrl: awBenchSnap!.sourceUrl,
            generatedAt: awBenchSnap!.generatedAt,
          }
        : null,
      coding: awCodingMatch
        ? {
            model: awCodingMatch,
            attribution: awCodingSnap!.attribution,
            sourceUrl: awCodingSnap!.sourceUrl,
            generatedAt: awCodingSnap!.generatedAt,
          }
        : null,
    },
    epochAi:
      epochEciMatch || epochRuns.length > 0
        ? {
            eci: epochEciMatch,
            runs: epochRuns,
            attribution: epochSnap!.attribution,
            sourceUrl: epochSnap!.sourceUrl,
            capturedAt: epochSnap!.capturedAt,
          }
        : null,
    openCharts: openChartsMatch
      ? {
          model: openChartsMatch,
          methodologyUrl: ocSnap!.methodologyUrl,
          attribution: ocSnap!.attribution,
          sourceUrl: ocSnap!.sourceUrl,
          generatedAt: ocSnap!.generatedAt,
        }
      : null,
  };
}

/**
 * HU-14c: Ensures benchmark caches are loaded (or served offline from SQLite) and returns
 * the normalized 4-source payload for `GET /api/models/:fullId/benchmarks`.
 */
export async function resolveAndSyncModelBenchmarks(
  db: DatabaseSync,
  modelLookup: {
    fullId: string;
    canonicalModelId: string | null;
    modelId: string;
    name: string;
  },
  options: {
    fetchFn?: FetchLike;
    nowSec?: number;
    ttlSec?: number;
    forceRefresh?: boolean;
  } = {},
) {
  await Promise.all([
    syncLmArenaAgentBenchmarks(db, options),
    syncArtificialWatchBenchmarks(db, options),
    syncEpochAiBenchmarks(db, options),
    syncOpenChartsBenchmarks(db, options),
  ]);

  const cached = getCachedModelBenchmarks(db, modelLookup);

  // 1. LMArena block
  const lmaEntry = cached.lmarena?.entry ?? null;
  const lmaPeers = (cached.lmarenaSnap?.entries ?? []).slice(0, 15).map((e, idx) => ({
    modelId: e.model,
    displayName: e.model,
    score: e.score,
    ciLower: e.confidenceInterval.lower,
    ciUpper: e.confidenceInterval.upper,
    rank: e.rank ?? idx + 1,
    isCurrent: cached.matchesKey(e.model),
  }));
  const lmarenaBlock = {
    available: lmaEntry !== null,
    score: lmaEntry?.score ?? null,
    ciLower: lmaEntry?.confidenceInterval.lower ?? null,
    ciUpper: lmaEntry?.confidenceInterval.upper ?? null,
    sessions: lmaEntry?.sessions ?? null,
    votes: lmaEntry?.votes ?? null,
    sessionsOrVotes: lmaEntry?.sessions ?? lmaEntry?.votes ?? null,
    category: 'agent/latest',
    medianCostPerTaskUsd: lmaEntry?.medianCostPerTaskUsd ?? null,
    rank: lmaEntry?.rank ?? null,
    totalRanked: cached.lmarenaSnap?.entries.length ?? null,
    rankingPeers: lmaEntry ? lmaPeers : [],
    license: 'CC BY 4.0',
    attribution:
      cached.lmarenaSnap?.attribution ??
      'LMArena Agent Leaderboard (lmarena-ai/leaderboard-dataset, CC BY 4.0)',
    sourceUrl:
      cached.lmarenaSnap?.sourceUrl ??
      'https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset',
    capturedAt: cached.lmarenaSnap?.capturedAt ?? null,
  };

  // 2. ArtificialWatch block (ONLY index & percentile; ZERO raw scores)
  const awBenchModel = cached.artificialWatch.bench?.model ?? null;
  const awCodingModel = cached.artificialWatch.coding?.model ?? null;
  const primaryAwModel = awBenchModel ?? awCodingModel;
  const primaryAwSnap = awBenchModel ? cached.awBenchSnap : cached.awCodingSnap;

  const awAxes: Array<{
    axisKey: string;
    label: string;
    percentile: number;
    index: number | null;
    sourceBoard: string;
  }> = [];
  const seenBoards = new Set<string>();

  if (awBenchModel) {
    for (const [boardKey, scoreObj] of Object.entries(awBenchModel.scores)) {
      seenBoards.add(boardKey);
      const boardName = cached.awBenchSnap?.sources?.[boardKey]?.name ?? boardKey;
      awAxes.push({
        axisKey: boardKey,
        label: boardName,
        percentile: scoreObj.percentile,
        index: awBenchModel.index,
        sourceBoard: boardName,
      });
    }
  }
  if (awCodingModel) {
    for (const [boardKey, scoreObj] of Object.entries(awCodingModel.scores)) {
      const axisKey = seenBoards.has(boardKey) ? `coding:${boardKey}` : boardKey;
      const boardName = cached.awCodingSnap?.sources?.[boardKey]?.name ?? boardKey;
      awAxes.push({
        axisKey,
        label: seenBoards.has(boardKey) ? `${boardName} (Coding)` : boardName,
        percentile: scoreObj.percentile,
        index: awCodingModel.index,
        sourceBoard: boardName,
      });
    }
  }

  const medianPct = medianOf(awAxes.map((a) => a.percentile));
  const awPeers =
    primaryAwModel && primaryAwSnap
      ? primaryAwSnap.models.slice(0, 15).map((m) => {
          const pcts = Object.values(m.scores).map((s) => s.percentile);
          return {
            modelId: m.id,
            displayName: m.name,
            percentile: medianOf(pcts) ?? m.index,
            index: m.index,
            rank: m.rank,
            isCurrent: cached.matchesKey(m.id, m.name),
          };
        })
      : [];

  const artificialWatchBlock = {
    available: primaryAwModel !== null,
    globalIndex: primaryAwModel?.index ?? null,
    index: primaryAwModel?.index ?? null,
    medianPercentile: medianPct,
    percentile: medianPct,
    axes: awAxes,
    rankingPeers: awPeers,
    bench: awBenchModel
      ? {
          id: awBenchModel.id,
          name: awBenchModel.name,
          index: awBenchModel.index,
          rank: awBenchModel.rank,
          boards: awBenchModel.boards,
          scores: awBenchModel.scores,
        }
      : null,
    coding: awCodingModel
      ? {
          id: awCodingModel.id,
          name: awCodingModel.name,
          index: awCodingModel.index,
          rank: awCodingModel.rank,
          boards: awCodingModel.boards,
          scores: awCodingModel.scores,
        }
      : null,
    license: 'CC BY 4.0',
    attribution:
      primaryAwSnap?.attribution ??
      'ArtificialWatch Index & Percentiles (CC BY 4.0) — https://artificialwatch.com',
    sourceUrl: primaryAwSnap?.sourceUrl ?? 'https://artificialwatch.com',
    capturedAt: primaryAwSnap?.generatedAt ?? null,
  };

  // 3. Epoch AI block (ONLY internal Inspect runs + ECI; ZERO *_external.csv or Source rows)
  const epochRunsFormatted = (cached.epochAi?.runs ?? []).map((r) => ({
    benchmarkId: r.benchmark,
    benchmarkName: formatBenchmarkDisplayName(r.benchmark),
    score: r.meanScore ?? r.bestScore ?? 0,
    meanScore: r.meanScore,
    bestScore: r.bestScore,
    stderr: r.stderr,
    evaluatedAt: r.startedAt ?? r.releaseDate,
    harness: 'Inspect (Epoch AI internal run)',
  }));

  const epochBlock = {
    available: epochRunsFormatted.length > 0 || Boolean(cached.epochAi?.eci),
    runs: epochRunsFormatted,
    eci: cached.epochAi?.eci ?? null,
    license: 'CC BY 4.0',
    attribution:
      cached.epochSnap?.attribution ??
      "Epoch AI, 'Capabilities & benchmarking' (CC BY 4.0) — https://epoch.ai/benchmarks",
    sourceUrl: cached.epochSnap?.sourceUrl ?? 'https://epoch.ai/benchmarks',
    capturedAt: cached.epochSnap?.capturedAt ?? null,
  };

  // 4. OpenCharts block (ONLY compositeIndex, grade, rankRange + methodologyUrl)
  const ocModel = cached.openCharts?.model ?? null;
  const ocRankRangeText = ocModel ? formatRankRangeText(ocModel.rankRange, ocModel.rank) : null;
  const ocPeers =
    ocModel && cached.ocSnap
      ? cached.ocSnap.models.slice(0, 15).map((m) => ({
          modelId: m.slug,
          displayName: m.name,
          compositeIndex: m.index,
          grade: m.grade,
          rankRange: formatRankRangeText(m.rankRange, m.rank),
          isCurrent: cached.matchesKey(m.slug, m.name),
        }))
      : [];

  const openChartsBlock = {
    available: ocModel !== null,
    compositeIndex: ocModel?.index ?? null,
    index: ocModel?.index ?? null,
    grade: ocModel?.grade ?? null,
    rank: ocModel?.rank ?? null,
    rankRange: ocRankRangeText,
    rankRangeBand: ocModel?.rankRange ?? null,
    rankingPeers: ocPeers,
    methodologyUrl: cached.ocSnap?.methodologyUrl ?? OPENCHARTS_METHODOLOGY_URL,
    license: 'CC BY 4.0',
    attribution:
      cached.ocSnap?.attribution ??
      'OpenCharts Composite Index & Grade — https://www.opencharts.com/benchmarks',
    sourceUrl: cached.ocSnap?.sourceUrl ?? 'https://www.opencharts.com/benchmarks',
    capturedAt: cached.ocSnap?.generatedAt ?? null,
  };

  return {
    fullId: modelLookup.fullId,
    canonicalModelId: modelLookup.canonicalModelId,
    lmarena: lmarenaBlock,
    artificialwatch: artificialWatchBlock,
    artificialWatch: artificialWatchBlock,
    epoch: epochBlock,
    epochAi: epochBlock,
    opencharts: openChartsBlock,
    openCharts: openChartsBlock,
  };
}

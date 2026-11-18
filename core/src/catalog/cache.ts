import type { DatabaseSync } from 'node:sqlite';

export const DEFAULT_CACHE_TTL_SEC = 6 * 3600; // 6 hours
export const BIFROST_USER_AGENT = 'Bifrost/0.4 (+https://github.com/sxamx/bifrost)';

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface ExternalCacheRow {
  cache_key: string;
  payload_json: string;
  etag: string | null;
  fetched_at: number;
}

export function readExternalCache<T>(
  db: DatabaseSync,
  cacheKey: string,
): {
  data: T;
  etag: string | null;
  fetchedAt: number;
} | null {
  const row = db
    .prepare(
      'SELECT cache_key, payload_json, etag, fetched_at FROM external_cache WHERE cache_key = ?',
    )
    .get(cacheKey) as ExternalCacheRow | undefined;

  if (!row) {
    return null;
  }

  return {
    data: JSON.parse(row.payload_json) as T,
    etag: row.etag,
    fetchedAt: Number(row.fetched_at),
  };
}

export function writeExternalCache(
  db: DatabaseSync,
  cacheKey: string,
  payload: unknown,
  etag: string | null,
  nowSec: number,
): void {
  const payloadJson = JSON.stringify(payload);
  db.prepare(
    `INSERT INTO external_cache (cache_key, payload_json, etag, fetched_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(cache_key) DO UPDATE SET
       payload_json = excluded.payload_json,
       etag = excluded.etag,
       fetched_at = excluded.fetched_at`,
  ).run(cacheKey, payloadJson, etag, nowSec);
}

export function touchExternalCacheTimestamp(
  db: DatabaseSync,
  cacheKey: string,
  nowSec: number,
): void {
  db.prepare('UPDATE external_cache SET fetched_at = ? WHERE cache_key = ?').run(nowSec, cacheKey);
}

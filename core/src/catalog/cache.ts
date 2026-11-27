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

  try {
    return {
      data: JSON.parse(row.payload_json) as T,
      etag: row.etag,
      fetchedAt: Number(row.fetched_at),
    };
  } catch {
    return null;
  }
}

export async function readResponseBufferWithLimit(
  res: Response,
  maxBytes = 64 * 1024 * 1024,
): Promise<Buffer> {
  const contentLengthHeader = res.headers.get('content-length');
  if (contentLengthHeader !== null) {
    const declaredBytes = Number(contentLengthHeader);
    if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
      if (res.body) {
        await res.body.cancel().catch(() => {});
      }
      throw new Error(
        `Response Content-Length (${declaredBytes} bytes) exceeds maximum allowed (${maxBytes} bytes).`,
      );
    }
  }

  if (!res.body) {
    const ab = await res.arrayBuffer();
    if (ab.byteLength > maxBytes) {
      throw new Error(
        `Response body (${ab.byteLength} bytes) exceeds maximum allowed (${maxBytes} bytes).`,
      );
    }
    return Buffer.from(ab);
  }

  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(
          `Streamed response body exceeded maximum allowed size (${maxBytes} bytes).`,
        );
      }
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks, totalBytes);
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

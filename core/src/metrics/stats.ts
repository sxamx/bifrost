export interface Percentiles {
  p50: number | null;
  p75: number | null;
  p90: number | null;
  p95: number | null;
  p99: number | null;
}

export const EMPTY_PERCENTILES: Percentiles = Object.freeze({
  p50: null,
  p75: null,
  p90: null,
  p95: null,
  p99: null,
});

export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function interpolateSorted(sortedAsc: readonly number[], p: number): number {
  const n = sortedAsc.length;
  if (n === 1) {
    return round2(sortedAsc[0]!);
  }
  const rank = (p / 100) * (n - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) {
    return round2(sortedAsc[lo]!);
  }
  const weight = rank - lo;
  return round2(sortedAsc[lo]! + (sortedAsc[hi]! - sortedAsc[lo]!) * weight);
}

/**
 * Computes P50, P75, P90, P95, and P99 together using standard linear interpolation (PERCENTILE_CONT).
 * Preserves `null` for all percentiles when the sample set is empty — NEVER substitutes `0`.
 */
export function computePercentiles(values: readonly number[]): Percentiles {
  const finite = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (finite.length === 0) {
    return { ...EMPTY_PERCENTILES };
  }
  const sorted = [...finite].sort((a, b) => a - b);
  return {
    p50: interpolateSorted(sorted, 50),
    p75: interpolateSorted(sorted, 75),
    p90: interpolateSorted(sorted, 90),
    p95: interpolateSorted(sorted, 95),
    p99: interpolateSorted(sorted, 99),
  };
}

export function utcStartOfDaySec(unixSec: number): number {
  return Math.floor(unixSec / 86400) * 86400;
}

export function utcNextMidnightSec(unixSec: number): number {
  return utcStartOfDaySec(unixSec) + 86400;
}

export function utcStartOfHourSec(unixSec: number): number {
  return Math.floor(unixSec / 3600) * 3600;
}

export function formatUtcDate(unixSec: number): string {
  return new Date(unixSec * 1000).toISOString().slice(0, 10);
}

export function formatIsoUtc(unixSec: number): string {
  return new Date(unixSec * 1000).toISOString();
}

export type MetricsRange = 'today' | '24h' | '7d' | '30d';

export interface TimeBucketSpec {
  granularity: 'hour' | 'day';
  rangeStartSec: number;
  rangeEndSec: number;
  buckets: Array<{
    bucketStartSec: number;
    label: string;
  }>;
}

/**
 * Builds contiguous UTC hour (`today` / `24h`) or UTC day (`7d` / `30d`) buckets
 * anchored strictly to the server's UTC clock (`nowSec`).
 */
export function buildTimeBuckets(nowSec: number, range: MetricsRange): TimeBucketSpec {
  if (range === 'today') {
    const startSec = utcStartOfDaySec(nowSec);
    const currentHourSec = utcStartOfHourSec(nowSec);
    const buckets: Array<{ bucketStartSec: number; label: string }> = [];
    for (let ts = startSec; ts <= currentHourSec; ts += 3600) {
      buckets.push({
        bucketStartSec: ts,
        label: formatIsoUtc(ts),
      });
    }
    return {
      granularity: 'hour',
      rangeStartSec: startSec,
      rangeEndSec: nowSec,
      buckets,
    };
  }

  if (range === '24h') {
    const currentHourSec = utcStartOfHourSec(nowSec);
    const startSec = currentHourSec - 23 * 3600;
    const buckets: Array<{ bucketStartSec: number; label: string }> = [];
    for (let ts = startSec; ts <= currentHourSec; ts += 3600) {
      buckets.push({
        bucketStartSec: ts,
        label: formatIsoUtc(ts),
      });
    }
    return {
      granularity: 'hour',
      rangeStartSec: startSec,
      rangeEndSec: nowSec,
      buckets,
    };
  }

  const days = range === '7d' ? 7 : 30;
  const todayStart = utcStartOfDaySec(nowSec);
  const startSec = todayStart - (days - 1) * 86400;
  const buckets: Array<{ bucketStartSec: number; label: string }> = [];
  for (let ts = startSec; ts <= todayStart; ts += 86400) {
    buckets.push({
      bucketStartSec: ts,
      label: formatUtcDate(ts),
    });
  }
  return {
    granularity: 'day',
    rangeStartSec: startSec,
    rangeEndSec: nowSec,
    buckets,
  };
}

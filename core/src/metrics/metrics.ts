import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { redactSecretsInText } from '../db.js';
import { computeAdaptiveFreeQuotas } from './adaptive-quota.js';
import { parseAndScrubMetaJson, scrubSecretsFromText } from './redact.js';
import {
  buildTimeBuckets,
  computePercentiles,
  formatIsoUtc,
  formatUtcDate,
  round2,
  utcNextMidnightSec,
  utcStartOfDaySec,
  utcStartOfHourSec,
} from './stats.js';
import type {
  LatencyBucket,
  LatencyMetricsOptions,
  LatencyMetricsResult,
  ModelSpeedMetrics,
  ProviderCacheMetrics,
  ProviderErrorRateItem,
  ProviderErrorRates7dOptions,
  ProviderErrorRates7dResult,
  ProviderUptime60Days,
  QuerySystemLogsOptions,
  QuerySystemLogsResult,
  QuotaResetMode,
  SpeedAndCacheMetricsOptions,
  SpeedAndCacheMetricsResult,
  SummaryMetricsOptions,
  SummaryMetricsResult,
  SystemLogCategory,
  SystemLogLevel,
  TokenActivityBreakdownRow,
  TokenActivityOptions,
  TokenActivityResult,
  TokenActivitySeriesBucket,
  TokenVolumeTotals,
  Uptime60DaysOptions,
  Uptime60DaysResult,
  UptimeDayCell,
  UptimeDayState,
} from './types.js';

function classifyUptimeState(totalRequests: number, okRequests: number): {
  uptimePct: number | null;
  state: UptimeDayState;
} {
  if (totalRequests === 0) {
    return { uptimePct: null, state: 'no_data' };
  }
  const uptimePct = round2((okRequests / totalRequests) * 100);
  if (okRequests * 100 >= totalRequests * 99) {
    return { uptimePct, state: 'ok' };
  }
  if (okRequests * 100 >= totalRequests * 95) {
    return { uptimePct, state: 'partial' };
  }
  return { uptimePct, state: 'error' };
}

/**
 * HU-17: Computes "Cuota gratuita de hoy" + reset countdown + summary counters
 * anchored strictly to the server's UTC clock.
 */
export function getSummaryMetrics(
  db: DatabaseSync,
  options: SummaryMetricsOptions,
): SummaryMetricsResult {
  const nowSec = options.nowSec ?? Math.floor(Date.now() / 1000);

  const userRow = db
    .prepare('SELECT daily_token_limit, quota_reset_mode FROM users WHERE id = ?')
    .get(options.userId) as
    | { daily_token_limit: number | null; quota_reset_mode: QuotaResetMode }
    | undefined;

  const quotaResetMode: QuotaResetMode = userRow?.quota_reset_mode ?? 'utc_midnight';
  const windowStartSec =
    quotaResetMode === 'rolling_24h' ? nowSec - 86400 : utcStartOfDaySec(nowSec);

  if (options.role === 'guest') {
    const usageRow = db
      .prepare(
        `SELECT COALESCE(SUM(prompt_tokens + completion_tokens + reasoning_tokens), 0) AS used_tokens,
                MIN(CASE WHEN (prompt_tokens + completion_tokens + reasoning_tokens) > 0 THEN created_at END) AS earliest_ts
         FROM usage_logs
         WHERE user_id = ? AND created_at >= ? AND created_at <= ?`,
      )
      .get(options.userId, windowStartSec, nowSec) as {
      used_tokens: number;
      earliest_ts: number | null;
    };

    const usedTokensToday = Number(usageRow?.used_tokens ?? 0);
    const configuredDailyLimit =
      userRow?.daily_token_limit === null || userRow?.daily_token_limit === undefined
        ? null
        : Number(userRow.daily_token_limit);
    const remainingTokensToday =
      configuredDailyLimit !== null ? Math.max(0, configuredDailyLimit - usedTokensToday) : null;
    const usedPct =
      configuredDailyLimit !== null && configuredDailyLimit > 0
        ? round2((usedTokensToday / configuredDailyLimit) * 100)
        : null;

    const nextResetAt =
      quotaResetMode === 'rolling_24h'
        ? formatIsoUtc((usageRow?.earliest_ts ?? nowSec) + 86400)
        : formatIsoUtc(utcNextMidnightSec(nowSec));

    const counts = db
      .prepare(
        `SELECT COUNT(DISTINCT m.full_id) AS models_cnt,
                COUNT(DISTINCT m.provider_id) AS providers_cnt
         FROM user_model_access uma
         JOIN models m
           ON (uma.model_full_id = m.full_id OR uma.model_full_id = '*' OR uma.model_full_id = m.provider_id || '/*')
         JOIN providers p ON p.id = m.provider_id
         WHERE uma.user_id = ? AND m.active = 1 AND p.enabled = 1`,
      )
      .get(options.userId) as { models_cnt: number; providers_cnt: number };

    return {
      quotaToday: {
        configuredDailyLimit,
        providerRateLimitRemaining: null,
        usedTokensToday,
        remainingTokensToday,
        usedPct,
        quotaResetMode,
        nextResetAt,
        earliestProviderResetAt: null,
        activeWindow: 'day',
        windowSeconds: 86400,
        windowLabel: '24h',
        confidence: 'configured',
        effectiveLimit: configuredDailyLimit,
        adaptiveAdjusted: false,
      },
      providersCount: Number(counts?.providers_cnt ?? 0),
      activeModelsCount: Number(counts?.models_cnt ?? 0),
      onlineNodesCount: 0,
    };
  }

  // Admin view: global provider_keys quota pool + x-ratelimit-* signals + UTC usage
  const keyPoolRow = db
    .prepare(
      `SELECT COUNT(pk.daily_quota_limit) AS keys_with_limit,
              SUM(pk.daily_quota_limit) AS total_daily_limit,
              COUNT(CASE WHEN pk.ratelimit_remaining IS NOT NULL AND (pk.ratelimit_reset_at IS NULL OR pk.ratelimit_reset_at > ?) THEN 1 END) AS keys_with_rl,
              SUM(CASE WHEN pk.ratelimit_remaining IS NOT NULL AND (pk.ratelimit_reset_at IS NULL OR pk.ratelimit_reset_at > ?) THEN pk.ratelimit_remaining ELSE 0 END) AS total_rl_remaining,
              MIN(CASE WHEN pk.ratelimit_reset_at IS NOT NULL AND pk.ratelimit_reset_at > ? THEN pk.ratelimit_reset_at END) AS earliest_rl_reset
       FROM provider_keys pk
       JOIN providers p ON p.id = pk.provider_id
       WHERE p.enabled = 1 AND pk.status IN ('active', 'rate_limited')`,
    )
    .get(nowSec, nowSec, nowSec) as {
    keys_with_limit: number;
    total_daily_limit: number | null;
    keys_with_rl: number;
    total_rl_remaining: number | null;
    earliest_rl_reset: number | null;
  };

  const userDailyLimit =
    userRow?.daily_token_limit !== null && userRow?.daily_token_limit !== undefined
      ? Number(userRow.daily_token_limit)
      : null;

  const poolDailyLimit =
    Number(keyPoolRow?.keys_with_limit ?? 0) > 0 ? Number(keyPoolRow.total_daily_limit ?? 0) : null;

  const configuredDailyLimit = poolDailyLimit ?? userDailyLimit;
  const providerRateLimitRemaining =
    Number(keyPoolRow?.keys_with_rl ?? 0) > 0 ? Number(keyPoolRow.total_rl_remaining ?? 0) : null;
  const earliestProviderResetAt =
    keyPoolRow?.earliest_rl_reset !== null && keyPoolRow?.earliest_rl_reset !== undefined
      ? formatIsoUtc(Number(keyPoolRow.earliest_rl_reset))
      : null;

  const todayStartSec = utcStartOfDaySec(nowSec);
  const usageRow = db
    .prepare(
      `SELECT COALESCE(SUM(prompt_tokens + completion_tokens + reasoning_tokens), 0) AS used_tokens
       FROM usage_logs
       WHERE created_at >= ? AND created_at <= ?`,
    )
    .get(todayStartSec, nowSec) as { used_tokens: number };

  const usedTokensToday = Number(usageRow?.used_tokens ?? 0);
  const remainingTokensToday =
    configuredDailyLimit !== null
      ? Math.max(0, configuredDailyLimit - usedTokensToday)
      : providerRateLimitRemaining;
  const usedPct =
    configuredDailyLimit !== null && configuredDailyLimit > 0
      ? round2((usedTokensToday / configuredDailyLimit) * 100)
      : null;

  const providersCount = Number(
    (
      db.prepare('SELECT COUNT(*) AS c FROM providers WHERE enabled = 1').get() as {
        c: number;
      }
    )?.c ?? 0,
  );
  const activeModelsCount = Number(
    (
      db
        .prepare(
          `SELECT COUNT(*) AS c
           FROM models m
           JOIN providers p ON p.id = m.provider_id
           WHERE m.active = 1 AND p.enabled = 1`,
        )
        .get() as { c: number }
    )?.c ?? 0,
  );
  const onlineNodesCount = Number(
    (
      db.prepare("SELECT COUNT(*) AS c FROM nodes WHERE status = 'online'").get() as {
        c: number;
      }
    )?.c ?? 0,
  );

  const adaptive = computeAdaptiveFreeQuotas(db, nowSec);
  const effectiveLimit = adaptive.effectiveLimit ?? configuredDailyLimit;

  return {
    quotaToday: {
      configuredDailyLimit,
      providerRateLimitRemaining,
      usedTokensToday,
      remainingTokensToday,
      usedPct,
      quotaResetMode: 'utc_midnight',
      nextResetAt: formatIsoUtc(utcNextMidnightSec(nowSec)),
      earliestProviderResetAt,
      activeWindow: adaptive.activeWindow,
      windowSeconds: adaptive.windowSeconds,
      windowLabel: adaptive.windowLabel,
      confidence: adaptive.confidence,
      effectiveLimit,
      adaptiveAdjusted: adaptive.adaptiveAdjusted,
    },
    providersCount,
    activeModelsCount,
    onlineNodesCount,
    providerQuotas: adaptive.providers,
  };
}

/**
 * HU-18: Computes grouped duration_ms percentiles (P50, P75, P90, P95, P99)
 * bucketed by UTC hour (`today` / `24h`) or UTC day (`7d` / `30d`).
 * Preserves `null` for buckets with 0 samples.
 */
export function getLatencyMetrics(
  db: DatabaseSync,
  options: LatencyMetricsOptions,
): LatencyMetricsResult {
  const nowSec = options.nowSec ?? Math.floor(Date.now() / 1000);
  const spec = buildTimeBuckets(nowSec, options.range);

  const clauses: string[] = ['created_at >= ?', 'created_at <= ?'];
  const params: SQLInputValue[] = [spec.rangeStartSec, spec.rangeEndSec];

  if (options.providerId) {
    clauses.push('provider_id = ?');
    params.push(options.providerId);
  }
  if (options.modelFullId) {
    clauses.push('model_full_id = ?');
    params.push(options.modelFullId);
  }
  if (options.userId) {
    clauses.push('user_id = ?');
    params.push(options.userId);
  }

  const rows = db
    .prepare(
      `SELECT created_at, duration_ms
       FROM usage_logs
       WHERE ${clauses.join(' AND ')}`,
    )
    .all(...params) as Array<{ created_at: number; duration_ms: number }>;

  const bucketSamples = new Map<number, number[]>();
  for (const b of spec.buckets) {
    bucketSamples.set(b.bucketStartSec, []);
  }

  const allSamples: number[] = [];
  for (const r of rows) {
    if (typeof r.duration_ms !== 'number' || !Number.isFinite(r.duration_ms)) {
      continue;
    }
    allSamples.push(r.duration_ms);
    const key =
      spec.granularity === 'hour'
        ? utcStartOfHourSec(r.created_at)
        : utcStartOfDaySec(r.created_at);
    const arr = bucketSamples.get(key);
    if (arr) {
      arr.push(r.duration_ms);
    }
  }

  const buckets: LatencyBucket[] = spec.buckets.map((b) => {
    const samples = bucketSamples.get(b.bucketStartSec) ?? [];
    const pcts = computePercentiles(samples);
    return {
      bucketStartSec: b.bucketStartSec,
      timestamp: b.bucketStartSec,
      label: b.label,
      sampleCount: samples.length,
      count: samples.length,
      ...pcts,
    };
  });

  const overallPcts = computePercentiles(allSamples);

  return {
    range: options.range,
    granularity: spec.granularity,
    overall: {
      sampleCount: allSamples.length,
      percentiles: overallPcts,
      ...overallPcts,
    },
    buckets,
  };
}

/**
 * HU-18b: Computes TTFT and tokens/sec percentiles (P50..P99) per active model
 * and prompt cache hit rate (%) per provider.
 */
export function getSpeedAndCacheMetrics(
  db: DatabaseSync,
  options: SpeedAndCacheMetricsOptions,
): SpeedAndCacheMetricsResult {
  const nowSec = options.nowSec ?? Math.floor(Date.now() / 1000);
  const spec = buildTimeBuckets(nowSec, options.range);

  const activeModels = db
    .prepare(
      `SELECT m.full_id, m.name, m.provider_id
       FROM models m
       JOIN providers p ON p.id = m.provider_id
       WHERE m.active = 1 AND p.enabled = 1
       ORDER BY m.full_id ASC`,
    )
    .all() as Array<{ full_id: string; name: string; provider_id: string }>;

  const modelLogs = db
    .prepare(
      `SELECT model_full_id, ttft_ms, tokens_per_sec
       FROM usage_logs
       WHERE created_at >= ? AND created_at <= ?`,
    )
    .all(spec.rangeStartSec, spec.rangeEndSec) as Array<{
    model_full_id: string;
    ttft_ms: number | null;
    tokens_per_sec: number | null;
  }>;

  const perModelSamples = new Map<
    string,
    { count: number; ttft: number[]; tps: number[] }
  >();
  for (const m of activeModels) {
    perModelSamples.set(m.full_id, { count: 0, ttft: [], tps: [] });
  }

  for (const row of modelLogs) {
    const bucket = perModelSamples.get(row.model_full_id);
    if (!bucket) continue;
    bucket.count += 1;
    if (typeof row.ttft_ms === 'number' && Number.isFinite(row.ttft_ms)) {
      bucket.ttft.push(row.ttft_ms);
    }
    if (typeof row.tokens_per_sec === 'number' && Number.isFinite(row.tokens_per_sec)) {
      bucket.tps.push(row.tokens_per_sec);
    }
  }

  const models: ModelSpeedMetrics[] = activeModels
    .map((m) => {
      const entry = perModelSamples.get(m.full_id) ?? { count: 0, ttft: [], tps: [] };
      return {
        modelFullId: m.full_id,
        modelName: m.name,
        providerId: m.provider_id,
        sampleCount: entry.count,
        ttftMs: computePercentiles(entry.ttft),
        tokensPerSec: computePercentiles(entry.tps),
      };
    })
    .filter((m) => m.sampleCount > 0);

  const providerRows = db
    .prepare(
      `SELECT p.id AS provider_id,
              p.name AS provider_name,
              COUNT(u.id) AS req_count,
              COALESCE(SUM(u.prompt_tokens), 0) AS prompt_tokens,
              COALESCE(SUM(u.cached_tokens), 0) AS cached_tokens
       FROM providers p
       LEFT JOIN usage_logs u
         ON u.provider_id = p.id
        AND u.created_at >= ?
        AND u.created_at <= ?
       GROUP BY p.id, p.name
       ORDER BY p.id ASC`,
    )
    .all(spec.rangeStartSec, spec.rangeEndSec) as Array<{
    provider_id: string;
    provider_name: string;
    req_count: number;
    prompt_tokens: number;
    cached_tokens: number;
  }>;

  const providers: ProviderCacheMetrics[] = providerRows.map((row) => {
    const promptTokens = Number(row.prompt_tokens ?? 0);
    const cachedTokens = Number(row.cached_tokens ?? 0);
    return {
      providerId: row.provider_id,
      providerName: row.provider_name,
      requestCount: Number(row.req_count ?? 0),
      promptTokens,
      cachedTokens,
      cacheHitRate: promptTokens > 0 ? round2((cachedTokens / promptTokens) * 100) : null,
    };
  });

  return {
    range: options.range,
    models,
    providers,
    cacheByProvider: providers,
  };
}

/**
 * HU-19: Computes 60-day daily uptime per provider strictly from real usage_logs
 * (`ok`: >= 99%, `partial`: 95%..<99%, `error`: < 95%, `no_data`: 0 requests -> uptimePct: null).
 */
export function getUptime60Days(
  db: DatabaseSync,
  options: Uptime60DaysOptions = {},
): Uptime60DaysResult {
  const nowSec = options.nowSec ?? Math.floor(Date.now() / 1000);
  const todayStartSec = utcStartOfDaySec(nowSec);
  const startDaySec = todayStartSec - 59 * 86400;

  const dayStarts: number[] = [];
  for (let ts = startDaySec; ts <= todayStartSec; ts += 86400) {
    dayStarts.push(ts);
  }

  const providerList = db
    .prepare('SELECT id, name FROM providers ORDER BY id ASC')
    .all() as Array<{ id: string; name: string }>;

  const groupedTraffic = db
    .prepare(
      `SELECT provider_id,
              (created_at / 86400) * 86400 AS day_start_sec,
              COUNT(*) AS total_reqs,
              SUM(CASE WHEN status IN ('ok', 'resumed') THEN 1 ELSE 0 END) AS ok_reqs
       FROM usage_logs
       WHERE created_at >= ? AND created_at <= ?
       GROUP BY provider_id, day_start_sec`,
    )
    .all(startDaySec, nowSec) as Array<{
    provider_id: string;
    day_start_sec: number;
    total_reqs: number;
    ok_reqs: number;
  }>;

  const trafficMap = new Map<string, { total: number; ok: number }>();
  for (const r of groupedTraffic) {
    trafficMap.set(`${r.provider_id}::${r.day_start_sec}`, {
      total: Number(r.total_reqs ?? 0),
      ok: Number(r.ok_reqs ?? 0),
    });
  }

  const providers: ProviderUptime60Days[] = providerList.map((prov) => {
    let total60d = 0;
    let ok60d = 0;

    const days: UptimeDayCell[] = dayStarts.map((daySec) => {
      const hit = trafficMap.get(`${prov.id}::${daySec}`);
      const totalRequests = hit?.total ?? 0;
      const okRequests = hit?.ok ?? 0;
      total60d += totalRequests;
      ok60d += okRequests;

      const { uptimePct, state } = classifyUptimeState(totalRequests, okRequests);
      return {
        date: formatUtcDate(daySec),
        dayStartSec: daySec,
        totalRequests,
        okRequests,
        errorRequests: Math.max(0, totalRequests - okRequests),
        uptimePct,
        state,
      };
    });

    const overall = classifyUptimeState(total60d, ok60d);
    return {
      providerId: prov.id,
      providerName: prov.name,
      totalRequests60d: total60d,
      okRequests60d: ok60d,
      overallUptimePct: overall.uptimePct,
      overallState: overall.state,
      days,
    };
  });

  return {
    windowDays: 60,
    fromDate: formatUtcDate(startDaySec),
    toDate: formatUtcDate(todayStartSec),
    providers,
  };
}

/**
 * HU-20: Computes 7-day tool_error and structured_error rates (%) per provider.
 */
export function getProviderErrorRates7d(
  db: DatabaseSync,
  options: ProviderErrorRates7dOptions = {},
): ProviderErrorRates7dResult {
  const nowSec = options.nowSec ?? Math.floor(Date.now() / 1000);
  const todayStartSec = utcStartOfDaySec(nowSec);
  const startDaySec = todayStartSec - 6 * 86400;

  const rows = db
    .prepare(
      `SELECT p.id AS provider_id,
              p.name AS provider_name,
              COUNT(u.id) AS total_reqs,
              COALESCE(SUM(CASE WHEN u.error_type = 'tool_error' THEN 1 ELSE 0 END), 0) AS tool_errors,
              COALESCE(SUM(CASE WHEN u.error_type = 'structured_error' THEN 1 ELSE 0 END), 0) AS structured_errors
       FROM providers p
       LEFT JOIN usage_logs u
         ON u.provider_id = p.id
        AND u.created_at >= ?
        AND u.created_at <= ?
       GROUP BY p.id, p.name
       ORDER BY p.id ASC`,
    )
    .all(startDaySec, nowSec) as Array<{
    provider_id: string;
    provider_name: string;
    total_reqs: number;
    tool_errors: number;
    structured_errors: number;
  }>;

  const providers: ProviderErrorRateItem[] = rows.map((r) => {
    const totalRequests = Number(r.total_reqs ?? 0);
    const toolErrors = Number(r.tool_errors ?? 0);
    const structuredErrors = Number(r.structured_errors ?? 0);

    return {
      providerId: r.provider_id,
      providerName: r.provider_name,
      totalRequests,
      toolErrors,
      structuredErrors,
      toolErrorRate: totalRequests > 0 ? round2((toolErrors / totalRequests) * 100) : null,
      structuredErrorRate:
        totalRequests > 0 ? round2((structuredErrors / totalRequests) * 100) : null,
    };
  });

  return {
    windowDays: 7,
    fromDate: formatUtcDate(startDaySec),
    toDate: formatUtcDate(todayStartSec),
    providers,
  };
}

/**
 * HU-20b: Computes prompt, completion, and reasoning token volume across time buckets
 * and grouped breakdown by `model`, `provider`, or `user`.
 */
export function getTokenActivity(
  db: DatabaseSync,
  options: TokenActivityOptions,
): TokenActivityResult {
  const nowSec = options.nowSec ?? Math.floor(Date.now() / 1000);
  const spec = buildTimeBuckets(nowSec, options.range);

  const clauses: string[] = ['u.created_at >= ?', 'u.created_at <= ?'];
  const params: SQLInputValue[] = [spec.rangeStartSec, spec.rangeEndSec];

  if (options.userIdScope) {
    clauses.push('u.user_id = ?');
    params.push(options.userIdScope);
  }

  if (options.filterId) {
    if (options.groupBy === 'model') {
      clauses.push('u.model_full_id = ?');
      params.push(options.filterId);
    } else if (options.groupBy === 'provider') {
      clauses.push('u.provider_id = ?');
      params.push(options.filterId);
    } else if (options.groupBy === 'apiKey') {
      if (options.filterId === 'session') {
        clauses.push('u.internal_api_key_id IS NULL');
      } else {
        clauses.push('u.internal_api_key_id = ?');
        params.push(options.filterId);
      }
    } else {
      clauses.push('u.user_id = ?');
      params.push(options.filterId);
    }
  }

  const whereSql = clauses.join(' AND ');
  const bucketExpr =
    spec.granularity === 'hour'
      ? '(u.created_at / 3600) * 3600'
      : '(u.created_at / 86400) * 86400';

  const seriesRows = db
    .prepare(
      `SELECT ${bucketExpr} AS bucket_sec,
              COALESCE(SUM(u.prompt_tokens), 0) AS prompt_tokens,
              COALESCE(SUM(u.completion_tokens), 0) AS completion_tokens,
              COALESCE(SUM(u.reasoning_tokens), 0) AS reasoning_tokens,
              COALESCE(SUM(u.cached_tokens), 0) AS cached_tokens,
              COUNT(*) AS req_count
       FROM usage_logs u
       WHERE ${whereSql}
       GROUP BY bucket_sec`,
    )
    .all(...params) as Array<{
    bucket_sec: number;
    prompt_tokens: number;
    completion_tokens: number;
    reasoning_tokens: number;
    cached_tokens: number;
    req_count: number;
  }>;

  const seriesMap = new Map<number, (typeof seriesRows)[number]>();
  for (const r of seriesRows) {
    seriesMap.set(Number(r.bucket_sec), r);
  }

  const totals: TokenVolumeTotals = {
    promptTokens: 0,
    completionTokens: 0,
    reasoningTokens: 0,
    cachedTokens: 0,
    totalTokens: 0,
    requestCount: 0,
  };

  const series: TokenActivitySeriesBucket[] = spec.buckets.map((b) => {
    const hit = seriesMap.get(b.bucketStartSec);
    const promptTokens = Number(hit?.prompt_tokens ?? 0);
    const completionTokens = Number(hit?.completion_tokens ?? 0);
    const reasoningTokens = Number(hit?.reasoning_tokens ?? 0);
    const cachedTokens = Number(hit?.cached_tokens ?? 0);
    const requestCount = Number(hit?.req_count ?? 0);
    const totalTokens = promptTokens + completionTokens + reasoningTokens;

    totals.promptTokens += promptTokens;
    totals.completionTokens += completionTokens;
    totals.reasoningTokens += reasoningTokens;
    totals.cachedTokens += cachedTokens;
    totals.totalTokens += totalTokens;
    totals.requestCount += requestCount;

    return {
      bucketStartSec: b.bucketStartSec,
      label: b.label,
      promptTokens,
      completionTokens,
      reasoningTokens,
      cachedTokens,
      totalTokens,
      requestCount,
    };
  });

  let breakdownSql: string;
  if (options.groupBy === 'model') {
    breakdownSql = `
      SELECT u.model_full_id AS group_id,
             COALESCE(m.name, u.model_full_id) AS group_label,
             COALESCE(SUM(u.prompt_tokens), 0) AS prompt_tokens,
             COALESCE(SUM(u.completion_tokens), 0) AS completion_tokens,
             COALESCE(SUM(u.reasoning_tokens), 0) AS reasoning_tokens,
             COALESCE(SUM(u.cached_tokens), 0) AS cached_tokens,
             COUNT(*) AS req_count
      FROM usage_logs u
      LEFT JOIN models m ON m.full_id = u.model_full_id
      WHERE ${whereSql}
      GROUP BY u.model_full_id, group_label
    `;
  } else if (options.groupBy === 'provider') {
    breakdownSql = `
      SELECT u.provider_id AS group_id,
             COALESCE(p.name, u.provider_id) AS group_label,
             COALESCE(SUM(u.prompt_tokens), 0) AS prompt_tokens,
             COALESCE(SUM(u.completion_tokens), 0) AS completion_tokens,
             COALESCE(SUM(u.reasoning_tokens), 0) AS reasoning_tokens,
             COALESCE(SUM(u.cached_tokens), 0) AS cached_tokens,
             COUNT(*) AS req_count
      FROM usage_logs u
      LEFT JOIN providers p ON p.id = u.provider_id
      WHERE ${whereSql}
      GROUP BY u.provider_id, group_label
    `;
  } else if (options.groupBy === 'apiKey') {
    breakdownSql = `
      SELECT COALESCE(u.internal_api_key_id, 'session') AS group_id,
             CASE
               WHEN u.internal_api_key_id IS NULL THEN 'Panel / Sesión'
               WHEN k.name IS NOT NULL THEN k.name || ' (' || k.key_prefix || '…)'
               ELSE u.internal_api_key_id
             END AS group_label,
             COALESCE(SUM(u.prompt_tokens), 0) AS prompt_tokens,
             COALESCE(SUM(u.completion_tokens), 0) AS completion_tokens,
             COALESCE(SUM(u.reasoning_tokens), 0) AS reasoning_tokens,
             COALESCE(SUM(u.cached_tokens), 0) AS cached_tokens,
             COUNT(*) AS req_count
      FROM usage_logs u
      LEFT JOIN internal_api_keys k ON k.id = u.internal_api_key_id
      WHERE ${whereSql}
      GROUP BY COALESCE(u.internal_api_key_id, 'session'), group_label
    `;
  } else {
    breakdownSql = `
      SELECT u.user_id AS group_id,
             COALESCE(usr.username, u.user_id) AS group_label,
             COALESCE(SUM(u.prompt_tokens), 0) AS prompt_tokens,
             COALESCE(SUM(u.completion_tokens), 0) AS completion_tokens,
             COALESCE(SUM(u.reasoning_tokens), 0) AS reasoning_tokens,
             COALESCE(SUM(u.cached_tokens), 0) AS cached_tokens,
             COUNT(*) AS req_count
      FROM usage_logs u
      LEFT JOIN users usr ON usr.id = u.user_id
      WHERE ${whereSql}
      GROUP BY u.user_id, group_label
    `;
  }

  const rawBreakdown = db.prepare(breakdownSql).all(...params) as Array<{
    group_id: string;
    group_label: string;
    prompt_tokens: number;
    completion_tokens: number;
    reasoning_tokens: number;
    cached_tokens: number;
    req_count: number;
  }>;

  const breakdown: TokenActivityBreakdownRow[] = rawBreakdown
    .map((r) => {
      const promptTokens = Number(r.prompt_tokens ?? 0);
      const completionTokens = Number(r.completion_tokens ?? 0);
      const reasoningTokens = Number(r.reasoning_tokens ?? 0);
      const cachedTokens = Number(r.cached_tokens ?? 0);
      const requestCount = Number(r.req_count ?? 0);
      return {
        id: r.group_id,
        key: r.group_id,
        label: r.group_label,
        promptTokens,
        completionTokens,
        reasoningTokens,
        cachedTokens,
        totalTokens: promptTokens + completionTokens + reasoningTokens,
        requestCount,
        requestsCount: requestCount,
      };
    })
    .sort((a, b) => b.totalTokens - a.totalTokens || a.id.localeCompare(b.id));

  return {
    range: options.range,
    granularity: spec.granularity,
    groupBy: options.groupBy,
    totals,
    series,
    breakdown,
    items: breakdown,
  };
}

/**
 * HU-20c: Paginated admin query over `system_logs` with level/category/search filters
 * and defense-in-depth secret redaction.
 */
export function querySystemLogs(
  db: DatabaseSync,
  options: QuerySystemLogsOptions = {},
): QuerySystemLogsResult {
  const limit = Math.min(500, Math.max(1, Math.trunc(options.limit ?? 50)));
  const offset = Math.max(0, Math.trunc(options.offset ?? 0));

  const clauses: string[] = [];
  const params: SQLInputValue[] = [];

  if (options.level) {
    clauses.push('level = ?');
    params.push(options.level);
  }

  if (options.category) {
    clauses.push('category = ?');
    params.push(options.category);
  }

  if (options.q && options.q.trim().length > 0) {
    const escaped = options.q
      .trim()
      .replace(/\\/g, '\\\\')
      .replace(/%/g, '\\%')
      .replace(/_/g, '\\_');
    const pattern = `%${escaped}%`;
    clauses.push("(message LIKE ? ESCAPE '\\' OR COALESCE(meta_json, '') LIKE ? ESCAPE '\\')");
    params.push(pattern, pattern);
  }

  const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

  const countRow = db
    .prepare(`SELECT COUNT(*) AS total FROM system_logs ${whereSql}`)
    .get(...params) as { total: number };
  const total = Number(countRow?.total ?? 0);

  const rows = db
    .prepare(
      `SELECT id, level, category, message, meta_json, created_at
       FROM system_logs
       ${whereSql}
       ORDER BY created_at DESC, id DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as Array<{
    id: number;
    level: SystemLogLevel;
    category: SystemLogCategory;
    message: string;
    meta_json: string | null;
    created_at: number;
  }>;

  const items = rows.map((row) => ({
    id: Number(row.id),
    level: row.level,
    category: row.category,
    message: redactSecretsInText(scrubSecretsFromText(row.message)),
    meta: parseAndScrubMetaJson(row.meta_json),
    createdAt: Number(row.created_at),
  }));

  return {
    total,
    limit,
    offset,
    items,
    logs: items,
  };
}

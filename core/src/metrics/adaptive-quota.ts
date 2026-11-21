import type { DatabaseSync } from 'node:sqlite';
import type {
  ProviderManifest,
  ProviderRateLimitKind,
  ProviderRateLimitWindow,
} from '../schema.js';
import { formatIsoUtc, round2 } from './stats.js';

export type QuotaConfidence = 'header_exact' | 'configured' | 'inferred';

export interface ProviderAdaptiveQuota {
  providerId: string;
  providerName: string;
  rateLimitKind: ProviderRateLimitKind | null;
  supportedWindows: ProviderRateLimitWindow[];
  activeWindow: ProviderRateLimitWindow;
  confidence: QuotaConfidence;
  configuredLimit: number | null;
  inferredLimit: number | null;
  effectiveLimit: number | null;
  usedInWindow: number;
  remainingInWindow: number | null;
  headerRemaining: number | null;
  earliestResetAt: string | null;
  recent429Count7d: number;
  adaptiveAdjusted: boolean;
}

export interface AdaptiveFreeQuotaSummary {
  activeWindow: ProviderRateLimitWindow;
  confidence: QuotaConfidence;
  configuredLimit: number | null;
  effectiveLimit: number | null;
  usedInWindow: number;
  remainingInWindow: number | null;
  quotaPercentageRemaining: number | null;
  adaptiveAdjusted: boolean;
  providers: ProviderAdaptiveQuota[];
}

function windowDurationSec(win: ProviderRateLimitWindow): number {
  if (win === 'hour') return 3600;
  if (win === 'week') return 604800;
  return 86400;
}

function windowOrderRank(win: ProviderRateLimitWindow): number {
  if (win === 'hour') return 0;
  if (win === 'day') return 1;
  return 2;
}

function inferWindowFromResetDelta(deltaSec: number | null): ProviderRateLimitWindow | null {
  if (deltaSec === null || !Number.isFinite(deltaSec)) return null;
  if (deltaSec <= 3600) return 'hour';
  if (deltaSec <= 86400) return 'day';
  return 'week';
}

function parseManifestRateLimit(schemaJson: string): {
  rateLimitKind: ProviderRateLimitKind | null;
  supportedWindows: ProviderRateLimitWindow[];
} {
  try {
    const manifest = JSON.parse(schemaJson) as ProviderManifest;
    const rateLimitKind =
      manifest.rateLimitKind === 'none' ||
      manifest.rateLimitKind === 'requests' ||
      manifest.rateLimitKind === 'tokens'
        ? manifest.rateLimitKind
        : null;
    const supportedWindows = Array.isArray(manifest.rateLimitWindows)
      ? manifest.rateLimitWindows.filter(
          (w): w is ProviderRateLimitWindow =>
            w === 'hour' || w === 'day' || w === 'week',
        )
      : [];
    return { rateLimitKind, supportedWindows };
  } catch {
    return { rateLimitKind: null, supportedWindows: [] };
  }
}

export function computeAdaptiveFreeQuotas(
  db: DatabaseSync,
  nowSec: number,
): AdaptiveFreeQuotaSummary {
  const providerRows = db
    .prepare(
      `SELECT id, name, schema_json
       FROM providers
       WHERE enabled = 1
       ORDER BY created_at ASC`,
    )
    .all() as Array<{ id: string; name: string; schema_json: string }>;

  const providers: ProviderAdaptiveQuota[] = [];

  for (const prov of providerRows) {
    const { rateLimitKind, supportedWindows } = parseManifestRateLimit(prov.schema_json);
    const manifestDefaultWindow: ProviderRateLimitWindow = supportedWindows[0] ?? 'day';

    const keyStats = db
      .prepare(
        `SELECT COUNT(daily_quota_limit) AS keys_with_limit,
                SUM(daily_quota_limit) AS total_daily_limit,
                COUNT(CASE WHEN ratelimit_remaining IS NOT NULL AND (ratelimit_reset_at IS NULL OR ratelimit_reset_at > ?) THEN 1 END) AS keys_with_rl,
                SUM(CASE WHEN ratelimit_remaining IS NOT NULL AND (ratelimit_reset_at IS NULL OR ratelimit_reset_at > ?) THEN ratelimit_remaining ELSE 0 END) AS total_rl_remaining,
                MIN(CASE WHEN ratelimit_reset_at IS NOT NULL AND ratelimit_reset_at > ? THEN ratelimit_reset_at END) AS earliest_rl_reset
         FROM provider_keys
         WHERE provider_id = ? AND status != 'error'`,
      )
      .get(nowSec, nowSec, nowSec, prov.id) as {
      keys_with_limit: number;
      total_daily_limit: number | null;
      keys_with_rl: number;
      total_rl_remaining: number | null;
      earliest_rl_reset: number | null;
    };

    const configuredLimit =
      Number(keyStats?.keys_with_limit ?? 0) > 0
        ? Number(keyStats.total_daily_limit ?? 0)
        : null;
    const hasHeaderSignal = Number(keyStats?.keys_with_rl ?? 0) > 0;
    const headerRemaining = hasHeaderSignal
      ? Number(keyStats.total_rl_remaining ?? 0)
      : null;
    const earliestResetSec =
      keyStats?.earliest_rl_reset !== null && keyStats?.earliest_rl_reset !== undefined
        ? Number(keyStats.earliest_rl_reset)
        : null;
    const earliestResetAt = earliestResetSec !== null ? formatIsoUtc(earliestResetSec) : null;

    const rlCacheRow = db
      .prepare(`SELECT payload_json FROM external_cache WHERE cache_key = ?`)
      .get(`adaptive_rl:${prov.id}`) as { payload_json: string } | undefined;

    let rlEvents: Array<{
      window_hint: ProviderRateLimitWindow | null;
      observed_tokens: number;
      observed_requests: number;
      reset_delta_sec: number | null;
      created_at: number;
    }> = [];

    if (rlCacheRow?.payload_json) {
      try {
        const parsed = JSON.parse(rlCacheRow.payload_json) as unknown;
        if (Array.isArray(parsed)) {
          rlEvents = parsed
            .filter((e): e is Record<string, unknown> => Boolean(e && typeof e === 'object'))
            .map((e) => ({
              window_hint:
                e.windowHint === 'hour' || e.windowHint === 'day' || e.windowHint === 'week'
                  ? (e.windowHint as ProviderRateLimitWindow)
                  : null,
              observed_tokens: Number(e.observedTokens ?? 0),
              observed_requests: Number(e.observedRequests ?? 0),
              reset_delta_sec:
                typeof e.resetDeltaSec === 'number' ? e.resetDeltaSec : null,
              created_at: Number(e.createdAt ?? 0),
            }))
            .filter((e) => e.created_at >= nowSec - 604800 && e.created_at <= nowSec)
            .sort((a, b) => b.created_at - a.created_at)
            .slice(0, 50);
        }
      } catch {
        rlEvents = [];
      }
    }

    let inferredCeiling: number | null = null;
    for (const evt of rlEvents) {
      const val =
        rateLimitKind === 'requests'
          ? Number(evt.observed_requests ?? 0)
          : Number(evt.observed_tokens ?? 0);
      if (val > 0 && (inferredCeiling === null || val < inferredCeiling)) {
        inferredCeiling = val;
      }
    }

    let inferredWindow: ProviderRateLimitWindow = manifestDefaultWindow;
    if (rlEvents.length > 0) {
      const latest = rlEvents[0]!;
      if (
        latest.window_hint === 'hour' ||
        latest.window_hint === 'day' ||
        latest.window_hint === 'week'
      ) {
        inferredWindow = latest.window_hint;
      } else if (rlEvents.length >= 2) {
        const span = Math.abs(rlEvents[0]!.created_at - rlEvents[1]!.created_at);
        if (span <= 3600) inferredWindow = 'hour';
        else if (span <= 86400) inferredWindow = 'day';
        else inferredWindow = 'week';
      }
    }

    let activeWindow: ProviderRateLimitWindow = manifestDefaultWindow;
    let confidence: QuotaConfidence = 'inferred';
    let effectiveLimit: number | null = configuredLimit;
    let remainingInWindow: number | null = null;
    let adaptiveAdjusted = false;

    if (rateLimitKind === 'none') {
      activeWindow = 'day';
      confidence = 'configured';
      effectiveLimit = null;
      remainingInWindow = null;
      adaptiveAdjusted = false;
    } else if (hasHeaderSignal) {
      confidence = 'header_exact';
      const headerDelta =
        earliestResetSec !== null ? Math.max(0, earliestResetSec - nowSec) : null;
      activeWindow = inferWindowFromResetDelta(headerDelta) ?? manifestDefaultWindow;
      if (
        inferredCeiling !== null &&
        (configuredLimit === null || inferredCeiling < configuredLimit)
      ) {
        effectiveLimit = inferredCeiling;
        adaptiveAdjusted = configuredLimit !== null && inferredCeiling < configuredLimit;
      } else {
        effectiveLimit = configuredLimit;
      }
      remainingInWindow = headerRemaining;
    } else if (rlEvents.length > 0) {
      const ceilingLowerThanConfigured =
        inferredCeiling !== null &&
        (configuredLimit === null || inferredCeiling < configuredLimit);
      const windowShifted = inferredWindow !== manifestDefaultWindow;

      if (ceilingLowerThanConfigured || windowShifted || configuredLimit === null) {
        confidence = 'inferred';
        activeWindow = inferredWindow;
        effectiveLimit = ceilingLowerThanConfigured ? inferredCeiling : configuredLimit;
        adaptiveAdjusted =
          (configuredLimit !== null &&
            inferredCeiling !== null &&
            inferredCeiling < configuredLimit) ||
          windowShifted;
      } else {
        confidence = 'configured';
        activeWindow = manifestDefaultWindow;
        effectiveLimit = configuredLimit;
      }
    } else if (
      configuredLimit !== null ||
      rateLimitKind !== null ||
      supportedWindows.length > 0
    ) {
      confidence = 'configured';
      activeWindow = manifestDefaultWindow;
      effectiveLimit = configuredLimit;
    } else {
      confidence = 'inferred';
      activeWindow = 'day';
      effectiveLimit = null;
    }

    const windowStartSec = nowSec - windowDurationSec(activeWindow);
    const usageRow = db
      .prepare(
        `SELECT COALESCE(SUM(prompt_tokens + completion_tokens + reasoning_tokens), 0) AS used_tokens,
                COUNT(*) AS used_requests
         FROM usage_logs
         WHERE provider_id = ?
           AND status IN ('ok', 'resumed')
           AND created_at >= ?
           AND created_at <= ?`,
      )
      .get(prov.id, windowStartSec, nowSec) as
      | { used_tokens: number | bigint; used_requests: number | bigint }
      | undefined;

    const usedInWindow =
      rateLimitKind === 'requests'
        ? Number(usageRow?.used_requests ?? 0)
        : Number(usageRow?.used_tokens ?? 0);

    if (remainingInWindow === null && effectiveLimit !== null) {
      remainingInWindow = Math.max(0, effectiveLimit - usedInWindow);
    }

    providers.push({
      providerId: prov.id,
      providerName: prov.name,
      rateLimitKind,
      supportedWindows,
      activeWindow,
      confidence,
      configuredLimit,
      inferredLimit: inferredCeiling,
      effectiveLimit,
      usedInWindow,
      remainingInWindow,
      headerRemaining,
      earliestResetAt,
      recent429Count7d: rlEvents.length,
      adaptiveAdjusted,
    });
  }

  // Aggregate overall signal by reliability order: header_exact > inferred (with 429s) > configured > fallback inferred
  const headerProviders = providers.filter((p) => p.confidence === 'header_exact');
  const inferred429Providers = providers.filter(
    (p) => p.confidence === 'inferred' && p.recent429Count7d > 0,
  );
  const configuredProviders = providers.filter((p) => p.confidence === 'configured');

  let globalConfidence: QuotaConfidence = 'inferred';
  let globalWindow: ProviderRateLimitWindow = 'day';

  const pickSmallestWindow = (list: ProviderAdaptiveQuota[]): ProviderRateLimitWindow => {
    const sorted = [...list].sort(
      (a, b) => windowOrderRank(a.activeWindow) - windowOrderRank(b.activeWindow),
    );
    return sorted[0]?.activeWindow ?? 'day';
  };

  if (headerProviders.length > 0) {
    globalConfidence = 'header_exact';
    globalWindow = pickSmallestWindow(headerProviders);
  } else if (inferred429Providers.length > 0) {
    globalConfidence = 'inferred';
    globalWindow = pickSmallestWindow(inferred429Providers);
  } else if (configuredProviders.length > 0) {
    globalConfidence = 'configured';
    globalWindow = pickSmallestWindow(configuredProviders);
  }

  const configuredLimits = providers
    .map((p) => p.configuredLimit)
    .filter((v): v is number => v !== null);
  const effectiveLimits = providers
    .map((p) => p.effectiveLimit)
    .filter((v): v is number => v !== null);
  const remainingValues = providers
    .map((p) => p.remainingInWindow)
    .filter((v): v is number => v !== null);

  const totalConfiguredLimit =
    configuredLimits.length > 0 ? configuredLimits.reduce((a, b) => a + b, 0) : null;
  const totalEffectiveLimit =
    effectiveLimits.length > 0 ? effectiveLimits.reduce((a, b) => a + b, 0) : null;
  const totalUsedInWindow = providers.reduce((sum, p) => sum + p.usedInWindow, 0);
  const totalRemainingInWindow =
    remainingValues.length > 0
      ? remainingValues.reduce((a, b) => a + b, 0)
      : totalEffectiveLimit !== null
        ? Math.max(0, totalEffectiveLimit - totalUsedInWindow)
        : null;

  const quotaPercentageRemaining =
    totalEffectiveLimit !== null && totalEffectiveLimit > 0 && totalRemainingInWindow !== null
      ? round2(
          Math.max(0, Math.min(100, (totalRemainingInWindow / totalEffectiveLimit) * 100)),
        )
      : null;

  return {
    activeWindow: globalWindow,
    confidence: globalConfidence,
    configuredLimit: totalConfiguredLimit,
    effectiveLimit: totalEffectiveLimit,
    usedInWindow: totalUsedInWindow,
    remainingInWindow: totalRemainingInWindow,
    quotaPercentageRemaining,
    adaptiveAdjusted: providers.some((p) => p.adaptiveAdjusted),
    providers,
  };
}

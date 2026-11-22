import type { DatabaseSync } from 'node:sqlite';
import type {
  ProviderManifest,
  ProviderRateLimitKind,
  ProviderRateLimitWindow,
} from '../schema.js';
import { formatIsoUtc, round2 } from './stats.js';

export type QuotaConfidence = 'header_exact' | 'configured' | 'inferred';
export type QuotaUnit = 'tokens' | 'requests' | 'none';

export interface ProviderAdaptiveQuota {
  providerId: string;
  providerName: string;
  rateLimitKind: ProviderRateLimitKind | null;
  unit: QuotaUnit;
  usableKeysCount: number;
  supportedWindows: ProviderRateLimitWindow[];
  activeWindow: ProviderRateLimitWindow;
  windowSeconds: number;
  windowLabel: string;
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
  windowSeconds: number;
  windowLabel: string;
  confidence: QuotaConfidence;
  configuredLimit: number | null;
  effectiveLimit: number | null;
  usedInWindow: number;
  remainingInWindow: number | null;
  quotaPercentageRemaining: number | null;
  adaptiveAdjusted: boolean;
  providers: ProviderAdaptiveQuota[];
}

export function windowDurationSec(win: ProviderRateLimitWindow): number {
  if (win === 'hour') return 3600;
  if (win === 'week') return 604800;
  return 86400;
}

export function activeWindowFromSeconds(windowSeconds: number): ProviderRateLimitWindow {
  if (windowSeconds <= 3600) return 'hour';
  if (windowSeconds <= 86400) return 'day';
  return 'week';
}

export function formatWindowLabel(windowSeconds: number): string {
  if (!Number.isFinite(windowSeconds) || windowSeconds <= 0) return '24h';
  if (windowSeconds >= 172800) {
    return `${Math.round(windowSeconds / 86400)}d`;
  }
  if (windowSeconds >= 3600) {
    if (windowSeconds % 3600 === 0) {
      return `${windowSeconds / 3600}h`;
    }
    if (windowSeconds < 7200 && windowSeconds % 60 === 0) {
      return `${windowSeconds / 60}m`;
    }
    return `${Math.round(windowSeconds / 3600)}h`;
  }
  if (windowSeconds >= 60) {
    return `${Math.round(windowSeconds / 60)}m`;
  }
  return `${Math.max(1, Math.round(windowSeconds))}s`;
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
      manifest.rateLimitKind === 'tokens' ||
      manifest.rateLimitKind === 'concurrency'
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

interface UsableKeyRow {
  id: string;
  daily_quota_limit: number | bigint | null;
  ratelimit_remaining: number | bigint | null;
  ratelimit_reset_at: number | bigint | null;
  status: string;
}

interface ParsedRlEvent {
  keyId: string | null;
  kind: 'burst' | 'quota';
  windowSeconds: number | null;
  observedTokens: number;
  observedRequests: number;
  resetDeltaSec: number | null;
  createdAt: number;
}

function isRealHeaderSignal(key: UsableKeyRow, nowSec: number): boolean {
  if (key.ratelimit_remaining === null || key.ratelimit_remaining === undefined) {
    return false;
  }
  const resetAt =
    key.ratelimit_reset_at !== null && key.ratelimit_reset_at !== undefined
      ? Number(key.ratelimit_reset_at)
      : null;
  if (resetAt !== null && resetAt <= nowSec) {
    return false;
  }
  // Ignore short-term (<= 120s) burst backoff markers set by markKeyFailure on 429
  if (
    key.status === 'rate_limited' &&
    Number(key.ratelimit_remaining) === 0 &&
    resetAt !== null &&
    resetAt - nowSec <= 120
  ) {
    return false;
  }
  return true;
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
    const manifestWindowSeconds = windowDurationSec(manifestDefaultWindow);

    const unit: QuotaUnit =
      rateLimitKind === 'none' || rateLimitKind === 'concurrency'
        ? 'none'
        : rateLimitKind === 'requests'
          ? 'requests'
          : 'tokens';

    // Fix #3: Query ONLY usable keys ('active', 'rate_limited') — NEVER disabled, no_node, or error
    const usableKeys = db
      .prepare(
        `SELECT id, daily_quota_limit, ratelimit_remaining, ratelimit_reset_at, status
         FROM provider_keys
         WHERE provider_id = ? AND status IN ('active', 'rate_limited')
         ORDER BY created_at ASC`,
      )
      .all(prov.id) as unknown as UsableKeyRow[];

    const usableKeysCount = usableKeys.length;

    const keysWithConfig = usableKeys.filter(
      (k) => k.daily_quota_limit !== null && k.daily_quota_limit !== undefined,
    );
    const configuredLimit =
      keysWithConfig.length > 0
        ? keysWithConfig.reduce((sum, k) => sum + Number(k.daily_quota_limit ?? 0), 0)
        : null;

    const keysWithHeader = usableKeys.filter((k) => isRealHeaderSignal(k, nowSec));
    const hasHeaderSignal = keysWithHeader.length > 0;
    const headerRemaining = hasHeaderSignal
      ? keysWithHeader.reduce((sum, k) => sum + Number(k.ratelimit_remaining ?? 0), 0)
      : null;

    let earliestResetSec: number | null = null;
    for (const k of keysWithHeader) {
      if (k.ratelimit_reset_at !== null && k.ratelimit_reset_at !== undefined) {
        const ts = Number(k.ratelimit_reset_at);
        if (ts > nowSec && (earliestResetSec === null || ts < earliestResetSec)) {
          earliestResetSec = ts;
        }
      }
    }
    const earliestResetAt = earliestResetSec !== null ? formatIsoUtc(earliestResetSec) : null;

    const rlCacheRow = db
      .prepare(`SELECT payload_json FROM external_cache WHERE cache_key = ?`)
      .get(`adaptive_rl:${prov.id}`) as { payload_json: string } | undefined;

    let rlEvents: ParsedRlEvent[] = [];

    if (rlCacheRow?.payload_json) {
      try {
        const parsed = JSON.parse(rlCacheRow.payload_json) as unknown;
        if (Array.isArray(parsed)) {
          rlEvents = parsed
            .filter((e): e is Record<string, unknown> => Boolean(e && typeof e === 'object'))
            .map((e): ParsedRlEvent => {
              const keyId =
                typeof e.keyId === 'string' && e.keyId.length > 0
                  ? e.keyId
                  : typeof e.providerKeyId === 'string' && e.providerKeyId.length > 0
                    ? e.providerKeyId
                    : null;
              const resetDeltaSec =
                typeof e.resetDeltaSec === 'number' && Number.isFinite(e.resetDeltaSec)
                  ? e.resetDeltaSec
                  : null;
              const kind: 'burst' | 'quota' =
                e.kind === 'burst'
                  ? 'burst'
                  : e.kind === 'quota'
                    ? 'quota'
                    : resetDeltaSec !== null && resetDeltaSec <= 120
                      ? 'burst'
                      : 'quota';
              const winHint =
                e.windowHint === 'hour' || e.windowHint === 'day' || e.windowHint === 'week'
                  ? (e.windowHint as ProviderRateLimitWindow)
                  : null;
              const windowSeconds =
                typeof e.windowSeconds === 'number' &&
                Number.isFinite(e.windowSeconds) &&
                e.windowSeconds > 0
                  ? e.windowSeconds
                  : resetDeltaSec !== null && resetDeltaSec > 120
                    ? resetDeltaSec
                    : winHint !== null
                      ? windowDurationSec(winHint)
                      : null;
              return {
                keyId,
                kind,
                windowSeconds,
                observedTokens: Number(e.observedTokens ?? 0),
                observedRequests: Number(e.observedRequests ?? 0),
                resetDeltaSec,
                createdAt: Number(e.createdAt ?? 0),
              };
            })
            .filter((e) => e.createdAt >= nowSec - 604800 && e.createdAt <= nowSec)
            .sort((a, b) => b.createdAt - a.createdAt)
            .slice(0, 50);
        }
      } catch {
        rlEvents = [];
      }
    }

    // Fix #1: 'none' and 'concurrency' providers never infer an exhausted daily quota
    if (rateLimitKind === 'none' || rateLimitKind === 'concurrency') {
      providers.push({
        providerId: prov.id,
        providerName: prov.name,
        rateLimitKind,
        unit: 'none',
        usableKeysCount,
        supportedWindows,
        activeWindow: activeWindowFromSeconds(manifestWindowSeconds),
        windowSeconds: manifestWindowSeconds,
        windowLabel: formatWindowLabel(manifestWindowSeconds),
        confidence: 'configured',
        configuredLimit: null,
        inferredLimit: null,
        effectiveLimit: null,
        usedInWindow: 0,
        remainingInWindow: null,
        headerRemaining: null,
        earliestResetAt: null,
        recent429Count7d: rlEvents.length,
        adaptiveAdjusted: false,
      });
      continue;
    }

    // Fix #1: Ignore 'burst' events when computing inferred quota ceilings & windows
    const quotaEvents = rlEvents.filter((e) => e.kind === 'quota');

    const headerDelta =
      earliestResetSec !== null ? Math.max(0, earliestResetSec - nowSec) : null;
    const headerWindowSeconds =
      hasHeaderSignal && headerDelta !== null && headerDelta > 120 ? headerDelta : null;

    let inferredWindowSeconds: number | null = null;
    if (quotaEvents.length > 0) {
      const latest = quotaEvents[0]!;
      if (latest.windowSeconds !== null && latest.windowSeconds > 120) {
        inferredWindowSeconds = latest.windowSeconds;
      } else if (quotaEvents.length >= 2) {
        const span = Math.abs(quotaEvents[0]!.createdAt - quotaEvents[1]!.createdAt);
        if (span <= 3600) inferredWindowSeconds = 3600;
        else if (span <= 86400) inferredWindowSeconds = 86400;
        else inferredWindowSeconds = 604800;
      } else {
        inferredWindowSeconds = manifestWindowSeconds;
      }
    }

    let windowSeconds =
      headerWindowSeconds ?? inferredWindowSeconds ?? manifestWindowSeconds;

    const queryUsageByKey = (winSec: number): {
      byKey: Map<string, number>;
      unattributed: number;
    } => {
      const rows = db
        .prepare(
          `SELECT provider_key_id,
                  COALESCE(SUM(prompt_tokens + completion_tokens + reasoning_tokens), 0) AS used_tokens,
                  COUNT(*) AS used_requests
           FROM usage_logs
           WHERE provider_id = ?
             AND status IN ('ok', 'resumed')
             AND created_at >= ?
             AND created_at <= ?
           GROUP BY provider_key_id`,
        )
        .all(prov.id, nowSec - winSec, nowSec) as Array<{
        provider_key_id: string | null;
        used_tokens: number | bigint;
        used_requests: number | bigint;
      }>;

      const byKey = new Map<string, number>();
      let unattributed = 0;
      for (const r of rows) {
        const val =
          unit === 'requests' ? Number(r.used_requests ?? 0) : Number(r.used_tokens ?? 0);
        if (r.provider_key_id) {
          byKey.set(r.provider_key_id, val);
        } else {
          unattributed += val;
        }
      }
      return { byKey, unattributed };
    };

    let usageSnapshot = queryUsageByKey(windowSeconds);

    // Fix #4 + Auto-healing upward: evaluate each usable key's ceiling individually
    const ownCeilingsByKey = new Map<string, number | null>();
    for (const k of usableKeys) {
      const keyUsed = usageSnapshot.byKey.get(k.id) ?? 0;
      const keyEvents = quotaEvents.filter(
        (e) => e.keyId === k.id || e.keyId === null,
      );

      let ownCeiling: number | null = null;
      for (const evt of keyEvents) {
        const val =
          unit === 'requests'
            ? Number(evt.observedRequests ?? 0)
            : Number(evt.observedTokens ?? 0);
        // Auto-healing upward: ignore stale inferred ceilings that are below proven successful usage
        if (val > 0 && keyUsed <= val && (ownCeiling === null || val < ownCeiling)) {
          ownCeiling = val;
        }
      }
      ownCeilingsByKey.set(k.id, ownCeiling);
    }

    // Representative per-key inferred ceiling from usable keys with an active (non-healed) ceiling
    const activeOwnCeilings = Array.from(ownCeilingsByKey.values()).filter(
      (v): v is number => v !== null,
    );
    const fallbackPerKeyCeiling =
      activeOwnCeilings.length > 0 ? Math.min(...activeOwnCeilings) : null;

    // If all previously inferred quota ceilings healed upward, revert inferred window shift
    if (fallbackPerKeyCeiling === null && headerWindowSeconds === null) {
      if (windowSeconds !== manifestWindowSeconds) {
        windowSeconds = manifestWindowSeconds;
        usageSnapshot = queryUsageByKey(windowSeconds);
      }
    }

    let providerInferredSum = 0;
    let hasAnyInferred = false;
    let providerEffectiveSum = 0;
    let hasAnyEffective = false;
    let providerRemainingSum = 0;
    let hasAnyRemaining = false;
    let usedInWindow = usageSnapshot.unattributed;

    for (const k of usableKeys) {
      const keyUsed = usageSnapshot.byKey.get(k.id) ?? 0;
      usedInWindow += keyUsed;

      const keyConfigured =
        k.daily_quota_limit !== null && k.daily_quota_limit !== undefined
          ? Number(k.daily_quota_limit)
          : null;

      let keyInferred = ownCeilingsByKey.get(k.id) ?? null;
      if (keyInferred === null && fallbackPerKeyCeiling !== null) {
        // Inherit provider per-key ceiling unless this key already proved higher usage
        if (keyUsed <= fallbackPerKeyCeiling) {
          keyInferred = fallbackPerKeyCeiling;
        }
      }

      if (keyInferred !== null) {
        providerInferredSum += keyInferred;
        hasAnyInferred = true;
      }

      const keyHasLowerInferred =
        keyInferred !== null && (keyConfigured === null || keyInferred < keyConfigured);
      const keyEffective = keyHasLowerInferred ? keyInferred : keyConfigured;

      if (keyEffective !== null) {
        providerEffectiveSum += keyEffective;
        hasAnyEffective = true;
      }

      const keyHasHeader = isRealHeaderSignal(k, nowSec);
      const keyRemaining = keyHasHeader
        ? Number(k.ratelimit_remaining ?? 0)
        : keyEffective !== null
          ? Math.max(0, keyEffective - keyUsed)
          : null;

      if (keyRemaining !== null) {
        providerRemainingSum += keyRemaining;
        hasAnyRemaining = true;
      }
    }

    const inferredLimit = hasAnyInferred ? providerInferredSum : null;
    const effectiveLimit = hasAnyEffective ? providerEffectiveSum : null;
    const remainingInWindow = hasAnyRemaining
      ? providerRemainingSum
      : effectiveLimit !== null
        ? Math.max(0, effectiveLimit - usedInWindow)
        : null;

    const activeWindow = activeWindowFromSeconds(windowSeconds);
    const windowLabel = formatWindowLabel(windowSeconds);
    const windowShifted =
      inferredWindowSeconds !== null &&
      hasAnyInferred &&
      windowSeconds !== manifestWindowSeconds;

    let confidence: QuotaConfidence = 'inferred';
    let adaptiveAdjusted = false;

    if (hasHeaderSignal) {
      confidence = 'header_exact';
      adaptiveAdjusted =
        configuredLimit !== null &&
        inferredLimit !== null &&
        effectiveLimit !== null &&
        effectiveLimit < configuredLimit;
    } else if (hasAnyInferred) {
      const ceilingLowerThanConfigured =
        configuredLimit === null ||
        (effectiveLimit !== null && effectiveLimit < configuredLimit);
      if (ceilingLowerThanConfigured || windowShifted) {
        confidence = 'inferred';
        adaptiveAdjusted =
          (configuredLimit !== null &&
            effectiveLimit !== null &&
            effectiveLimit < configuredLimit) ||
          windowShifted;
      } else {
        confidence = 'configured';
        adaptiveAdjusted = false;
      }
    } else if (
      configuredLimit !== null ||
      rateLimitKind !== null ||
      supportedWindows.length > 0
    ) {
      confidence = 'configured';
      adaptiveAdjusted = false;
    } else {
      confidence = 'inferred';
      adaptiveAdjusted = false;
    }

    providers.push({
      providerId: prov.id,
      providerName: prov.name,
      rateLimitKind,
      unit,
      usableKeysCount,
      supportedWindows,
      activeWindow,
      windowSeconds,
      windowLabel,
      confidence,
      configuredLimit,
      inferredLimit,
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
  const countableProviders = providers.filter((p) => p.unit !== 'none');
  const signalPool = countableProviders.length > 0 ? countableProviders : providers;

  const headerProviders = signalPool.filter((p) => p.confidence === 'header_exact');
  const inferred429Providers = signalPool.filter(
    (p) => p.confidence === 'inferred' && p.inferredLimit !== null,
  );
  const configuredProviders = signalPool.filter((p) => p.confidence === 'configured');

  let globalConfidence: QuotaConfidence = 'inferred';
  let globalWindowSeconds = 86400;

  const pickSmallestWindowSec = (list: ProviderAdaptiveQuota[]): number => {
    const sorted = [...list].sort((a, b) => a.windowSeconds - b.windowSeconds);
    return sorted[0]?.windowSeconds ?? 86400;
  };

  if (headerProviders.length > 0) {
    globalConfidence = 'header_exact';
    globalWindowSeconds = pickSmallestWindowSec(headerProviders);
  } else if (inferred429Providers.length > 0) {
    globalConfidence = 'inferred';
    globalWindowSeconds = pickSmallestWindowSec(inferred429Providers);
  } else if (configuredProviders.length > 0) {
    globalConfidence = 'configured';
    globalWindowSeconds = pickSmallestWindowSec(configuredProviders);
  }

  const globalWindow = activeWindowFromSeconds(globalWindowSeconds);
  const globalWindowLabel = formatWindowLabel(globalWindowSeconds);

  // Fix #2: Never mix units ('tokens' + 'requests') into meaningless summed totals
  const tokenProviders = countableProviders.filter((p) => p.unit === 'tokens');
  const requestProviders = countableProviders.filter((p) => p.unit === 'requests');
  const hasMixedUnits = tokenProviders.length > 0 && requestProviders.length > 0;

  let totalConfiguredLimit: number | null = null;
  let totalEffectiveLimit: number | null = null;
  let totalUsedInWindow = 0;
  let totalRemainingInWindow: number | null = null;
  let quotaPercentageRemaining: number | null = null;

  if (hasMixedUnits) {
    // Mixed units: do NOT sum tokens + requests; report health percentage as average across providers with known limits
    const providerPcts = countableProviders
      .filter(
        (p) =>
          p.effectiveLimit !== null &&
          p.effectiveLimit > 0 &&
          p.remainingInWindow !== null,
      )
      .map((p) =>
        Math.max(0, Math.min(100, (p.remainingInWindow! / p.effectiveLimit!) * 100)),
      );
    quotaPercentageRemaining =
      providerPcts.length > 0
        ? round2(providerPcts.reduce((a, b) => a + b, 0) / providerPcts.length)
        : null;
  } else {
    const configuredLimits = countableProviders
      .map((p) => p.configuredLimit)
      .filter((v): v is number => v !== null);
    const effectiveLimits = countableProviders
      .map((p) => p.effectiveLimit)
      .filter((v): v is number => v !== null);
    const remainingValues = countableProviders
      .map((p) => p.remainingInWindow)
      .filter((v): v is number => v !== null);

    totalConfiguredLimit =
      configuredLimits.length > 0
        ? configuredLimits.reduce((a, b) => a + b, 0)
        : null;
    totalEffectiveLimit =
      effectiveLimits.length > 0
        ? effectiveLimits.reduce((a, b) => a + b, 0)
        : null;
    totalUsedInWindow = countableProviders.reduce((sum, p) => sum + p.usedInWindow, 0);
    totalRemainingInWindow =
      remainingValues.length > 0
        ? remainingValues.reduce((a, b) => a + b, 0)
        : totalEffectiveLimit !== null
          ? Math.max(0, totalEffectiveLimit - totalUsedInWindow)
          : null;

    quotaPercentageRemaining =
      totalEffectiveLimit !== null &&
      totalEffectiveLimit > 0 &&
      totalRemainingInWindow !== null
        ? round2(
            Math.max(
              0,
              Math.min(100, (totalRemainingInWindow / totalEffectiveLimit) * 100),
            ),
          )
        : null;
  }

  return {
    activeWindow: globalWindow,
    windowSeconds: globalWindowSeconds,
    windowLabel: globalWindowLabel,
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

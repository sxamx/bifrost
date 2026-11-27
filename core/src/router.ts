import type { DatabaseSync } from 'node:sqlite';
import { decryptSecret } from './crypto.js';
import { writeSystemLog } from './db.js';
import { isEarlyRequest429Burst } from './metrics/adaptive-quota.js';
import { scrubSecretsFromText } from './metrics/redact.js';
import {
  type NodeMode,
  type UpstreamTlsOptions,
  fetchViaExitNode,
} from './nodes.js';
import {
  type ProviderManifest,
  buildProviderAuthHeaders,
  mergeHeadersCaseInsensitive,
} from './schema.js';
import {
  type DnsLookupFn,
  UpstreamSsrfError,
  assertSafeUpstreamUrlSync,
  safeFetch,
} from './ssrf.js';
import { allowLocalOfficialUpstreams } from './url-security.js';

export class DrainingRegistry {
  private readonly drainingKeys = new Set<string>();
  private readonly drainingProviders = new Set<string>();
  private readonly keyInFlight = new Map<string, number>();
  private readonly providerInFlight = new Map<string, number>();
  private readonly keyFinalizers = new Map<string, () => void>();
  private readonly providerFinalizers = new Map<string, () => void>();

  public isKeyDraining(keyId: string): boolean {
    return this.drainingKeys.has(keyId);
  }

  public isProviderDraining(providerId: string): boolean {
    return this.drainingProviders.has(providerId);
  }

  public getDrainingKeys(): ReadonlySet<string> {
    return this.drainingKeys;
  }

  public getDrainingProviders(): ReadonlySet<string> {
    return this.drainingProviders;
  }

  public getKeyInFlightCount(keyId: string): number {
    return this.keyInFlight.get(keyId) ?? 0;
  }

  public getProviderInFlightCount(providerId: string): number {
    return this.providerInFlight.get(providerId) ?? 0;
  }

  public acquireLease(providerId: string, keyId: string): () => void {
    this.providerInFlight.set(providerId, (this.providerInFlight.get(providerId) ?? 0) + 1);
    this.keyInFlight.set(keyId, (this.keyInFlight.get(keyId) ?? 0) + 1);

    let released = false;
    return () => {
      if (released) return;
      released = true;

      let keyFinalizer: (() => void) | undefined;
      const nextKeyCount = Math.max(0, (this.keyInFlight.get(keyId) ?? 1) - 1);
      if (nextKeyCount === 0) {
        this.keyInFlight.delete(keyId);
        keyFinalizer = this.keyFinalizers.get(keyId);
        if (keyFinalizer) {
          this.keyFinalizers.delete(keyId);
          this.drainingKeys.delete(keyId);
        }
      } else {
        this.keyInFlight.set(keyId, nextKeyCount);
      }

      let provFinalizer: (() => void) | undefined;
      const nextProvCount = Math.max(0, (this.providerInFlight.get(providerId) ?? 1) - 1);
      if (nextProvCount === 0) {
        this.providerInFlight.delete(providerId);
        provFinalizer = this.providerFinalizers.get(providerId);
        if (provFinalizer) {
          this.providerFinalizers.delete(providerId);
          this.drainingProviders.delete(providerId);
        }
      } else {
        this.providerInFlight.set(providerId, nextProvCount);
      }

      if (keyFinalizer) {
        try {
          keyFinalizer();
        } catch {
          // Isolate key finalizer failure so provider counters and finalizers are never leaked
        }
      }

      if (provFinalizer) {
        try {
          provFinalizer();
        } catch {
          // Isolate provider finalizer failure
        }
      }
    };
  }

  public drainAndRemoveKey(keyId: string, finalizeDelete: () => void): { draining: boolean } {
    this.drainingKeys.add(keyId);
    if (this.getKeyInFlightCount(keyId) === 0) {
      this.drainingKeys.delete(keyId);
      finalizeDelete();
      return { draining: false };
    }
    this.keyFinalizers.set(keyId, finalizeDelete);
    return { draining: true };
  }

  public drainAndRemoveProvider(
    providerId: string,
    keyIds: string[],
    finalizeDelete: () => void,
  ): { draining: boolean } {
    this.drainingProviders.add(providerId);
    for (const kId of keyIds) {
      this.drainingKeys.add(kId);
    }

    if (this.getProviderInFlightCount(providerId) === 0) {
      this.drainingProviders.delete(providerId);
      for (const kId of keyIds) {
        this.drainingKeys.delete(kId);
        this.keyFinalizers.delete(kId);
      }
      finalizeDelete();
      return { draining: false };
    }

    this.providerFinalizers.set(providerId, () => {
      for (const kId of keyIds) {
        this.drainingKeys.delete(kId);
        this.keyFinalizers.delete(kId);
      }
      finalizeDelete();
    });
    return { draining: true };
  }
}

interface ProviderKeyRecord {
  id: string;
  provider_id: string;
  label: string;
  encrypted_secret: Uint8Array;
  last4: string;
  node_id: string | null;
  status: string;
  node_name: string | null;
  node_mode: NodeMode | null;
  node_endpoint: string | null;
  node_encrypted_token: Uint8Array | null;
  node_tls_fingerprint: string | null;
  node_status: string | null;
}

const DEFAULT_UPSTREAM_HEADERS_TIMEOUT_MS = 60_000;
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 90_000;
const MAX_SSE_LINE_BUFFER_CHARS = 1_048_576; // 1 MiB safety cap against OOM
const MAX_RESUME_ACCUMULATOR_CHARS = 512_000;

const CHAT_COMPLETIONS_ALLOWED_FIELDS = new Set<string>([
  'messages',
  'temperature',
  'top_p',
  'max_tokens',
  'max_completion_tokens',
  'stop',
  'presence_penalty',
  'frequency_penalty',
  'seed',
  'tools',
  'tool_choice',
  'parallel_tool_calls',
  'functions',
  'function_call',
  'response_format',
  'reasoning_effort',
  'reasoning',
  'chat_template_kwargs',
  'stream_options',
  'user',
  'logprobs',
  'top_logprobs',
  'logit_bias',
  'metadata',
  'modalities',
  'audio',
  'prediction',
  'service_tier',
  'store',
  'web_search_options',
]);

const inFlightReservedTokensByUser = new Map<string, number>();

export function getInFlightReservedTokens(userId: string): number {
  return inFlightReservedTokensByUser.get(userId) ?? 0;
}

export function resetInFlightQuotaReservationsForTests(): void {
  inFlightReservedTokensByUser.clear();
}

function reserveInFlightTokens(userId: string, tokens: number): () => void {
  const amount = toSafeNonNegInt(tokens);
  if (amount <= 0) {
    return () => {};
  }
  inFlightReservedTokensByUser.set(
    userId,
    (inFlightReservedTokensByUser.get(userId) ?? 0) + amount,
  );
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = Math.max(0, (inFlightReservedTokensByUser.get(userId) ?? 0) - amount);
    if (next === 0) {
      inFlightReservedTokensByUser.delete(userId);
    } else {
      inFlightReservedTokensByUser.set(userId, next);
    }
  };
}

export function toSafeNonNegInt(val: unknown): number {
  if (typeof val === 'boolean' || val === null || val === undefined || val === '') {
    return 0;
  }
  const n = Number(val);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

export function computeTokensPerSec(
  completionTokens: number,
  reasoningTokens: number,
  durationMs: number,
): number | null {
  const safeComp = toSafeNonNegInt(completionTokens);
  const safeReas = toSafeNonNegInt(reasoningTokens);
  const outputTokens = safeComp > 0 ? safeComp : safeReas;
  if (!Number.isFinite(durationMs) || durationMs <= 0 || outputTokens <= 0) {
    return null;
  }
  return Math.round(((outputTokens * 1000) / durationMs) * 100) / 100;
}

function redactWithRawSecret(text: string, rawSecret?: string | null): string {
  return scrubSecretsFromText(text, rawSecret ? [rawSecret] : undefined);
}

function parseResetValueToUnixSec(rawValue: string, nowSec: number): number | null {
  const trimmed = rawValue.trim();
  if (!trimmed) return null;

  // 1. Plain numeric value (ms epoch, sec epoch, or delta seconds)
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed) && parsed > 0) {
      if (parsed > 1_000_000_000_000) {
        return Math.floor(parsed / 1000);
      }
      if (parsed > 1_000_000_000) {
        return Math.floor(parsed);
      }
      return nowSec + Math.ceil(parsed);
    }
    return null;
  }

  // 2. Go-style durations (e.g., "1m30s", "6s", "500ms", "2h", "1h2m3.5s", "1d12h")
  const goDurationMatch =
    /^(?:(\d+(?:\.\d+)?)d)?(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m(?!s))?(?:(\d+(?:\.\d+)?)s)?(?:(\d+(?:\.\d+)?)ms)?$/i.exec(
      trimmed,
    );
  if (
    goDurationMatch &&
    (goDurationMatch[1] !== undefined ||
      goDurationMatch[2] !== undefined ||
      goDurationMatch[3] !== undefined ||
      goDurationMatch[4] !== undefined ||
      goDurationMatch[5] !== undefined)
  ) {
    const days = goDurationMatch[1] ? Number(goDurationMatch[1]) : 0;
    const hours = goDurationMatch[2] ? Number(goDurationMatch[2]) : 0;
    const mins = goDurationMatch[3] ? Number(goDurationMatch[3]) : 0;
    const secs = goDurationMatch[4] ? Number(goDurationMatch[4]) : 0;
    const ms = goDurationMatch[5] ? Number(goDurationMatch[5]) : 0;
    const totalSec = days * 86400 + hours * 3600 + mins * 60 + secs + ms / 1000;
    if (Number.isFinite(totalSec) && totalSec > 0) {
      return nowSec + Math.max(1, Math.ceil(totalSec));
    }
    return null;
  }

  // 3. RFC 7231 HTTP-date or ISO-8601 date string
  const parsedDateMs = Date.parse(trimmed);
  if (Number.isFinite(parsedDateMs)) {
    const tsSec = Math.floor(parsedDateMs / 1000);
    if (tsSec > 0) {
      return tsSec;
    }
  }

  return null;
}

export function parseRateLimitHeaders(
  headers: Headers,
  nowSec: number,
  rateLimitKind?: ProviderManifest['rateLimitKind'] | null,
): { remaining: number | null; resetAt: number | null } {
  const remainingHeaderOrder =
    rateLimitKind === 'tokens'
      ? ['x-ratelimit-remaining-tokens', 'x-ratelimit-remaining']
      : rateLimitKind === 'requests'
        ? ['x-ratelimit-remaining-requests', 'x-ratelimit-remaining']
        : [
            'x-ratelimit-remaining',
            'x-ratelimit-remaining-requests',
            'x-ratelimit-remaining-tokens',
          ];

  let remaining: number | null = null;
  for (const name of remainingHeaderOrder) {
    const raw = headers.get(name);
    if (raw !== null && raw.trim() !== '') {
      const parsed = Number(raw.trim());
      if (Number.isFinite(parsed) && parsed >= 0) {
        remaining = Math.floor(parsed);
        break;
      }
    }
  }

  const resetHeaderOrder =
    rateLimitKind === 'tokens'
      ? ['x-ratelimit-reset-tokens', 'x-ratelimit-reset', 'retry-after']
      : rateLimitKind === 'requests'
        ? ['x-ratelimit-reset-requests', 'x-ratelimit-reset', 'retry-after']
        : [
            'x-ratelimit-reset',
            'x-ratelimit-reset-requests',
            'x-ratelimit-reset-tokens',
            'retry-after',
          ];

  let resetAt: number | null = null;
  for (const name of resetHeaderOrder) {
    const raw = headers.get(name);
    if (raw !== null && raw.trim() !== '') {
      const parsed = parseResetValueToUnixSec(raw, nowSec);
      if (parsed !== null) {
        resetAt = parsed;
        break;
      }
    }
  }

  return { remaining, resetAt };
}

export function updateKeyHealthy(
  db: DatabaseSync,
  keyId: string,
  headers: Headers,
  nowSec: number,
  rateLimitKind?: ProviderManifest['rateLimitKind'] | null,
): void {
  const { remaining, resetAt } = parseRateLimitHeaders(headers, nowSec, rateLimitKind);
  db.prepare(
    `UPDATE provider_keys
     SET status = 'active',
         last_error = NULL,
         ratelimit_remaining = CASE
           WHEN ? IS NOT NULL THEN ?
           WHEN status = 'rate_limited' AND ratelimit_remaining = 0 THEN NULL
           ELSE ratelimit_remaining
         END,
         ratelimit_reset_at = CASE
           WHEN ? IS NOT NULL THEN ?
           WHEN status = 'rate_limited' AND ratelimit_remaining = 0 THEN NULL
           ELSE ratelimit_reset_at
         END
     WHERE id = ?
       AND status NOT IN ('disabled', 'no_node')`,
  ).run(remaining, remaining, resetAt, resetAt, keyId);
}

function inferWindowFromResetDelta(resetDeltaSec: number | null): 'hour' | 'day' | 'week' | null {
  if (resetDeltaSec === null || !Number.isFinite(resetDeltaSec)) return null;
  if (resetDeltaSec <= 3600) return 'hour';
  if (resetDeltaSec <= 86400) return 'day';
  return 'week';
}

function windowDurationSec(window: 'hour' | 'day' | 'week'): number {
  if (window === 'hour') return 3600;
  if (window === 'week') return 604800;
  return 86400;
}

function formatAdaptiveWindowLabel(windowSeconds: number): string {
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

interface StoredAdaptiveRlEvent {
  keyId: string;
  providerKeyId?: string;
  kind: 'burst' | 'quota';
  windowSeconds: number;
  windowHint?: 'hour' | 'day' | 'week';
  observedTokens: number;
  observedRequests: number;
  resetDeltaSec: number | null;
  createdAt: number;
}

function recordRateLimitEvent(
  db: DatabaseSync,
  keyId: string,
  headers: Headers | null,
  nowSec: number,
): void {
  const keyRow = db
    .prepare(
      `SELECT pk.provider_id, pk.daily_quota_limit, p.schema_json
       FROM provider_keys pk
       JOIN providers p ON p.id = pk.provider_id
       WHERE pk.id = ?`,
    )
    .get(keyId) as
    | {
        provider_id: string;
        daily_quota_limit: number | bigint | null;
        schema_json: string;
      }
    | undefined;

  if (!keyRow) return;

  let manifestWindow: 'hour' | 'day' | 'week' | null = null;
  let manifestRateLimitKind: ProviderManifest['rateLimitKind'] | null = null;
  try {
    const manifest = JSON.parse(keyRow.schema_json) as ProviderManifest;
    const firstWin = manifest.rateLimitWindows?.[0];
    if (firstWin === 'hour' || firstWin === 'day' || firstWin === 'week') {
      manifestWindow = firstWin;
    }
    if (
      manifest.rateLimitKind === 'none' ||
      manifest.rateLimitKind === 'requests' ||
      manifest.rateLimitKind === 'tokens' ||
      manifest.rateLimitKind === 'concurrency'
    ) {
      manifestRateLimitKind = manifest.rateLimitKind;
    }
  } catch {
    // Ignore malformed manifest JSON
  }

  const parsed = headers
    ? parseRateLimitHeaders(headers, nowSec, manifestRateLimitKind)
    : { remaining: null, resetAt: null };
  const resetDeltaSec =
    parsed.resetAt !== null ? Math.max(0, parsed.resetAt - nowSec) : null;

  const cacheKey = `adaptive_rl:${keyRow.provider_id}`;
  const existingRow = db
    .prepare(`SELECT payload_json FROM external_cache WHERE cache_key = ?`)
    .get(cacheKey) as { payload_json: string } | undefined;

  let events: StoredAdaptiveRlEvent[] = [];

  if (existingRow?.payload_json) {
    try {
      const parsedCache = JSON.parse(existingRow.payload_json) as unknown;
      if (Array.isArray(parsedCache)) {
        events = parsedCache
          .filter(
            (e): e is Record<string, unknown> =>
              Boolean(
                e &&
                  typeof e === 'object' &&
                  typeof (e as { createdAt?: unknown }).createdAt === 'number',
              ),
          )
          .map((e) => {
            const evKeyId =
              typeof e.keyId === 'string'
                ? e.keyId
                : typeof e.providerKeyId === 'string'
                  ? e.providerKeyId
                  : '';
            const evResetDelta =
              typeof e.resetDeltaSec === 'number' && Number.isFinite(e.resetDeltaSec)
                ? e.resetDeltaSec
                : null;
            const evKind: 'burst' | 'quota' =
              e.kind === 'burst'
                ? 'burst'
                : e.kind === 'quota'
                  ? 'quota'
                  : evResetDelta !== null && evResetDelta <= 120
                    ? 'burst'
                    : 'quota';
            const evWinHint =
              e.windowHint === 'hour' || e.windowHint === 'day' || e.windowHint === 'week'
                ? (e.windowHint as 'hour' | 'day' | 'week')
                : undefined;
            const evWindowSec =
              typeof e.windowSeconds === 'number' &&
              Number.isFinite(e.windowSeconds) &&
              e.windowSeconds > 0
                ? e.windowSeconds
                : evResetDelta !== null && evResetDelta > 120
                  ? evResetDelta
                  : windowDurationSec(evWinHint ?? 'day');
            return {
              keyId: evKeyId,
              providerKeyId: evKeyId,
              kind: evKind,
              windowSeconds: evWindowSec,
              windowHint: evWinHint,
              observedTokens: Number(e.observedTokens ?? 0),
              observedRequests: Number(e.observedRequests ?? 0),
              resetDeltaSec: evResetDelta,
              createdAt: Number(e.createdAt ?? 0),
            };
          });
      }
    } catch {
      events = [];
    }
  }

  const defaultWindowSec = windowDurationSec(manifestWindow ?? 'day');
  let kind: 'burst' | 'quota';
  let windowSeconds: number;

  if (resetDeltaSec !== null && resetDeltaSec <= 120) {
    kind = 'burst';
    windowSeconds = Math.max(1, resetDeltaSec);
  } else if (resetDeltaSec !== null && resetDeltaSec > 120) {
    kind = 'quota';
    windowSeconds = resetDeltaSec;
  } else {
    // No reset header: classify isolated first 429 as 'burst'; repeated 429 for same keyId
    // within last 10 minutes (> 30s ago) as sustained 'quota' exhaustion.
    const hasRecentRepeat = events.some(
      (e) =>
        e.keyId === keyId &&
        nowSec - e.createdAt > 30 &&
        nowSec - e.createdAt <= 600,
    );
    kind = hasRecentRepeat ? 'quota' : 'burst';
    windowSeconds = defaultWindowSec;
  }

  const windowHint: 'hour' | 'day' | 'week' =
    inferWindowFromResetDelta(windowSeconds) ?? manifestWindow ?? 'day';
  const lookbackSec = windowSeconds > 120 ? windowSeconds : defaultWindowSec;

  const usageRow = db
    .prepare(
      `SELECT COALESCE(SUM(prompt_tokens + completion_tokens + reasoning_tokens), 0) AS observed_tokens,
              COUNT(*) AS observed_requests
       FROM usage_logs
       WHERE provider_key_id = ?
         AND status IN ('ok', 'resumed')
         AND created_at >= ?
         AND created_at <= ?`,
    )
    .get(keyId, nowSec - lookbackSec, nowSec) as
    | { observed_tokens: number | bigint; observed_requests: number | bigint }
    | undefined;

  const observedTokens = Number(usageRow?.observed_tokens ?? 0);
  const observedRequests = Number(usageRow?.observed_requests ?? 0);

  // Cold-start / upstream saturation burst guard for request-limited providers:
  // Do not infer a daily quota ceiling from early 429s (< 5 successful requests on the key)
  // unless upstream explicitly sends a long reset header (resetDeltaSec > 3600s).
  if (
    manifestRateLimitKind === 'requests' &&
    isEarlyRequest429Burst('requests', observedRequests, resetDeltaSec)
  ) {
    kind = 'burst';
  }

  events.unshift({
    keyId,
    providerKeyId: keyId,
    kind,
    windowSeconds,
    windowHint,
    observedTokens,
    observedRequests,
    resetDeltaSec,
    createdAt: nowSec,
  });
  const cutoffSec = nowSec - 604800;
  events = events.filter((e) => e.createdAt >= cutoffSec).slice(0, 50);

  db.prepare(
    `INSERT INTO external_cache (cache_key, payload_json, etag, fetched_at)
     VALUES (?, ?, NULL, ?)
     ON CONFLICT(cache_key) DO UPDATE SET
       payload_json = excluded.payload_json,
       fetched_at = excluded.fetched_at`,
  ).run(cacheKey, JSON.stringify(events), nowSec);

  const configuredLimit =
    keyRow.daily_quota_limit !== null && keyRow.daily_quota_limit !== undefined
      ? Number(keyRow.daily_quota_limit)
      : null;

  if (
    kind === 'quota' &&
    manifestRateLimitKind !== 'none' &&
    manifestRateLimitKind !== 'concurrency' &&
    configuredLimit !== null
  ) {
    const observedVal =
      manifestRateLimitKind === 'requests' ? observedRequests : observedTokens;
    const unitLabel = manifestRateLimitKind === 'requests' ? 'requests' : 'tokens';
    if (observedVal > 0 && observedVal < configuredLimit) {
      writeSystemLog(
        db,
        'warn',
        'system',
        `Adaptive quota ceiling adjusted for "${keyRow.provider_id}": HTTP 429 observed at ${observedVal} ${unitLabel} (${formatAdaptiveWindowLabel(windowSeconds)} window), below configured limit ${configuredLimit}.`,
        {
          providerId: keyRow.provider_id,
          keyId,
          kind,
          windowSeconds,
          windowHint,
          observedTokens,
          observedRequests,
          configuredLimit,
        },
        nowSec,
      );
    }
  }
}

export function markKeyFailure(
  db: DatabaseSync,
  keyId: string,
  httpStatus: number | null,
  reason: string,
  headers: Headers | null,
  nowSec: number,
  rateLimitKind?: ProviderManifest['rateLimitKind'] | null,
  rawSecret?: string | null,
): void {
  const safeReason = redactWithRawSecret(reason, rawSecret).slice(0, 300);
  const isTransientFailure =
    httpStatus === 429 ||
    httpStatus === null ||
    (httpStatus >= 500 && httpStatus <= 599);

  if (isTransientFailure) {
    if (httpStatus === 429) {
      recordRateLimitEvent(db, keyId, headers, nowSec);
    }
    const parsed = headers
      ? parseRateLimitHeaders(headers, nowSec, rateLimitKind)
      : { remaining: 0, resetAt: null };
    const resetAt = parsed.resetAt ?? nowSec + 60;
    db.prepare(
      `UPDATE provider_keys
       SET status = 'rate_limited',
           ratelimit_remaining = 0,
           ratelimit_reset_at = ?,
           last_error = ?
       WHERE id = ?
         AND status NOT IN ('disabled', 'no_node')`,
    ).run(resetAt, safeReason, keyId);
  } else {
    db.prepare(
      `UPDATE provider_keys
       SET status = 'error',
           last_error = ?
       WHERE id = ?
         AND status NOT IN ('disabled', 'no_node')`,
    ).run(safeReason, keyId);
  }
}

interface UsageLogEntryInput {
  userId: string;
  providerId: string;
  providerKeyId: string | null;
  internalApiKeyId?: string | null;
  modelFullId: string;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  ttftMs: number | null;
  durationMs: number;
  status: 'ok' | 'error' | 'resumed';
  errorType: string | null;
  createdAt: number;
}

function recordUsageLog(db: DatabaseSync, entry: UsageLogEntryInput): void {
  const promptTokens = toSafeNonNegInt(entry.promptTokens);
  const completionTokens = toSafeNonNegInt(entry.completionTokens);
  const reasoningTokens = toSafeNonNegInt(entry.reasoningTokens);
  const cachedTokens = toSafeNonNegInt(entry.cachedTokens);
  const durationMs = Number.isFinite(entry.durationMs)
    ? Math.max(1, Math.round(entry.durationMs))
    : 1;
  const ttftMs =
    entry.ttftMs !== null && Number.isFinite(entry.ttftMs)
      ? Math.max(1, Math.round(entry.ttftMs))
      : null;
  const tokensPerSec = computeTokensPerSec(completionTokens, reasoningTokens, durationMs);

  db.prepare(
    `INSERT INTO usage_logs (
       user_id, provider_id, provider_key_id, internal_api_key_id, model_full_id,
       prompt_tokens, completion_tokens, reasoning_tokens, cached_tokens,
       ttft_ms, duration_ms, tokens_per_sec, status, error_type, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    entry.userId,
    entry.providerId,
    entry.providerKeyId,
    entry.internalApiKeyId ?? null,
    entry.modelFullId,
    promptTokens,
    completionTokens,
    reasoningTokens,
    cachedTokens,
    ttftMs,
    durationMs,
    tokensPerSec,
    entry.status,
    entry.errorType,
    toSafeNonNegInt(entry.createdAt),
  );
}

function safeRecordUsageLog(db: DatabaseSync, entry: UsageLogEntryInput): void {
  try {
    recordUsageLog(db, entry);
  } catch {
    // Isolate SQLite / FK errors (e.g., user deleted mid-stream) to prevent Node 24 crashes
  }
}

function safeUpdateKeyHealthy(
  db: DatabaseSync,
  keyId: string,
  headers: Headers,
  nowSec: number,
  rateLimitKind?: ProviderManifest['rateLimitKind'] | null,
): void {
  try {
    updateKeyHealthy(db, keyId, headers, nowSec, rateLimitKind);
  } catch {
    // Isolate SQLite errors during stream completion
  }
}

function safeMarkKeyFailure(
  db: DatabaseSync,
  keyId: string,
  httpStatus: number | null,
  reason: string,
  headers: Headers | null,
  nowSec: number,
  rateLimitKind?: ProviderManifest['rateLimitKind'] | null,
  rawSecret?: string | null,
): void {
  try {
    markKeyFailure(db, keyId, httpStatus, reason, headers, nowSec, rateLimitKind, rawSecret);
  } catch {
    // Isolate SQLite errors during stream failover
  }
}

function safeWriteSystemLog(
  db: DatabaseSync,
  level: 'info' | 'warn' | 'error',
  category: 'failover' | 'stream_resume' | 'node' | 'sync' | 'auth' | 'backup' | 'system',
  message: string,
  meta: Record<string, unknown> | undefined,
  createdAtSec: number,
): void {
  try {
    writeSystemLog(db, level, category, message, meta, createdAtSec);
  } catch {
    // Isolate SQLite errors during background stream logging
  }
}

function buildQuotaExceededResponse(
  usedTokens: number,
  dailyTokenLimit: number,
  resetAtIso: string,
  retryAfterSec: number,
): Response {
  const safeRetryAfter = Math.max(1, Math.ceil(retryAfterSec));
  const message = `Daily token quota exceeded (${usedTokens}/${dailyTokenLimit} tokens used). Quota resets at ${resetAtIso}.`;

  return new Response(
    JSON.stringify({
      error: {
        message,
        type: 'quota_exceeded',
        param: null,
        code: 'daily_quota_exceeded',
        reset_at: resetAtIso,
      },
      reset_at: resetAtIso,
    }),
    {
      status: 429,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Retry-After': String(safeRetryAfter),
      },
    },
  );
}

function estimateEmbeddingsInputTokens(input: unknown): number {
  if (typeof input === 'string') {
    return input.length > 0 ? Math.max(1, Math.ceil(input.length / 4)) : 0;
  }
  if (Array.isArray(input)) {
    if (input.length === 0) return 0;
    if (typeof input[0] === 'number') {
      return input.length;
    }
    let total = 0;
    for (const item of input) {
      if (typeof item === 'string') {
        total += item.length > 0 ? Math.max(1, Math.ceil(item.length / 4)) : 0;
      } else if (Array.isArray(item)) {
        total += item.length;
      }
    }
    return total;
  }
  return 0;
}

function extractNonStreamingOutputChars(data: Record<string, unknown>): {
  contentChars: number;
  reasoningChars: number;
  toolCallChars: number;
} {
  const choices = Array.isArray(data.choices) ? data.choices : [];
  const choice0 =
    choices.length > 0 && choices[0] && typeof choices[0] === 'object'
      ? (choices[0] as Record<string, unknown>)
      : null;
  const message =
    choice0?.message && typeof choice0.message === 'object'
      ? (choice0.message as Record<string, unknown>)
      : null;
  if (!message) {
    return { contentChars: 0, reasoningChars: 0, toolCallChars: 0 };
  }

  let contentChars = 0;
  if (typeof message.content === 'string') {
    contentChars = message.content.length;
  } else if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (part && typeof part === 'object') {
        const text = (part as Record<string, unknown>).text;
        if (typeof text === 'string') contentChars += text.length;
      }
    }
  }

  let reasoningChars = 0;
  if (typeof message.reasoning_content === 'string') {
    reasoningChars = message.reasoning_content.length;
  } else if (typeof message.reasoning === 'string') {
    reasoningChars = message.reasoning.length;
  }

  let toolCallChars = 0;
  if (Array.isArray(message.tool_calls)) {
    for (const tc of message.tool_calls) {
      if (tc && typeof tc === 'object') {
        const fn = (tc as Record<string, unknown>).function;
        if (fn && typeof fn === 'object') {
          const fnObj = fn as Record<string, unknown>;
          if (typeof fnObj.name === 'string') toolCallChars += fnObj.name.length;
          if (typeof fnObj.arguments === 'string') {
            toolCallChars += fnObj.arguments.length;
          } else if (fnObj.arguments !== undefined && fnObj.arguments !== null) {
            toolCallChars += JSON.stringify(fnObj.arguments).length;
          }
        }
      }
    }
  } else if (message.function_call && typeof message.function_call === 'object') {
    const fc = message.function_call as Record<string, unknown>;
    if (typeof fc.name === 'string') toolCallChars += fc.name.length;
    if (typeof fc.arguments === 'string') toolCallChars += fc.arguments.length;
  }

  return { contentChars, reasoningChars, toolCallChars };
}

function applySelectiveTokenFallbacks(params: {
  promptTokens: unknown;
  completionTokens: unknown;
  reasoningTokens: unknown;
  cachedTokens: unknown;
  estimatedPromptTokens: number;
  contentChars: number;
  reasoningChars: number;
  toolCallChars: number;
  wasHttp200: boolean;
}): {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  zeroUsageWarn: boolean;
} {
  const rawPrompt = toSafeNonNegInt(params.promptTokens);
  const rawCompletion = toSafeNonNegInt(params.completionTokens);
  const rawReasoning = toSafeNonNegInt(params.reasoningTokens);
  const cachedTokens = toSafeNonNegInt(params.cachedTokens);

  let promptTokens = rawPrompt;
  let completionTokens = rawCompletion;
  let reasoningTokens = rawReasoning;

  // Never overwrite any real non-zero value reported by the provider
  if (promptTokens === 0 && params.estimatedPromptTokens > 0) {
    promptTokens = toSafeNonNegInt(params.estimatedPromptTokens);
  }
  const completionAndToolChars = params.contentChars + params.toolCallChars;
  if (completionTokens === 0 && completionAndToolChars > 0) {
    completionTokens = Math.max(1, Math.ceil(completionAndToolChars / 4));
  }
  if (reasoningTokens === 0 && params.reasoningChars > 0) {
    reasoningTokens = Math.max(1, Math.ceil(params.reasoningChars / 4));
  }

  let zeroUsageWarn = false;
  const rawAllZero = rawPrompt + rawCompletion + rawReasoning === 0;
  const outputCharsAllZero = completionAndToolChars + params.reasoningChars === 0;
  if (params.wasHttp200 && (promptTokens + completionTokens + reasoningTokens === 0 || (rawAllZero && outputCharsAllZero))) {
    if (promptTokens === 0) {
      promptTokens = Math.max(1, toSafeNonNegInt(params.estimatedPromptTokens));
    }
    zeroUsageWarn = true;
  }

  return {
    promptTokens,
    completionTokens,
    reasoningTokens,
    cachedTokens,
    zeroUsageWarn,
  };
}

function filterChatCompletionsBody(
  requestBody: Record<string, unknown>,
  isStream: boolean,
): Record<string, unknown> {
  const filtered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(requestBody)) {
    if (!CHAT_COMPLETIONS_ALLOWED_FIELDS.has(key)) {
      continue;
    }
    if (key === 'stream_options') {
      if (isStream && value && typeof value === 'object' && !Array.isArray(value)) {
        filtered.stream_options = value;
      }
      continue;
    }
    filtered[key] = value;
  }
  return filtered;
}

function isStreamOptionsUnsupportedError(errorText: string): boolean {
  return /stream_options|include_usage|unrecognized|unknown\s+(field|parameter|property)|extra_forbidden|additional\s+properties|not\s+supported|unsupported\s+(field|parameter)/i.test(
    errorText,
  );
}

function buildUpstreamSignal(
  clientSignal: AbortSignal | undefined,
  timeoutMs: number,
): AbortSignal {
  const safeTimeout = Math.max(1, Math.floor(timeoutMs));
  const timeoutSignal = AbortSignal.timeout(safeTimeout);
  return clientSignal ? AbortSignal.any([clientSignal, timeoutSignal]) : timeoutSignal;
}

async function readChunkWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleTimeoutMs: number,
): Promise<Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>>> {
  const safeIdleMs = Math.max(1, Math.floor(idleTimeoutMs));
  const readPromise = reader.read();
  // Prevent unhandled rejection if reader.cancel() rejects after timeout already won the race
  readPromise.catch(() => {});

  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      readPromise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`Upstream SSE stream idle timeout after ${safeIdleMs}ms`));
        }, safeIdleMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
    }
  }
}

export function estimateMessagesPromptTokens(messages: Array<Record<string, unknown>>): number {
  let chars = 0;
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue;
    const content = msg.content;
    if (typeof content === 'string') {
      chars += content.length + 12;
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (part && typeof part === 'object') {
          const p = part as Record<string, unknown>;
          if (typeof p.text === 'string') {
            chars += p.text.length;
          }
        }
      }
      chars += 16;
    } else {
      chars += 12;
    }
  }
  return chars > 0 ? Math.max(1, Math.ceil(chars / 4)) : 0;
}

/**
 * HU-17 & HU-05: Enforces daily token quota strictly using the server's UTC clock
 * (`utc_midnight` or `rolling_24h`), 100% immune to any client Date/Timezone headers.
 */
export function checkUserDailyQuotaUtc(
  db: DatabaseSync,
  userId: string,
  nowMs: number,
):
  | {
      exceeded: false;
      usedTokens: number;
      dailyTokenLimit: number | null;
      remainingTokens: number | null;
      enforceStrictQuota: boolean;
      resetAtIso: string | null;
    }
  | {
      exceeded: true;
      usedTokens: number;
      dailyTokenLimit: number;
      resetAtIso: string;
      retryAfterSec: number;
      response: Response;
    } {
  const userRow = db
    .prepare(
      `SELECT daily_token_limit, quota_reset_mode, enforce_strict_quota FROM users WHERE id = ?`,
    )
    .get(userId) as
    | {
        daily_token_limit: number | bigint | null;
        quota_reset_mode: string | null;
        enforce_strict_quota?: number | bigint | null;
      }
    | undefined;

  const enforceStrictQuota =
    userRow?.enforce_strict_quota === undefined || userRow?.enforce_strict_quota === null
      ? true
      : Number(userRow.enforce_strict_quota) !== 0;

  if (
    !userRow ||
    userRow.daily_token_limit === null ||
    userRow.daily_token_limit === undefined
  ) {
    return {
      exceeded: false,
      usedTokens: 0,
      dailyTokenLimit: null,
      remainingTokens: null,
      enforceStrictQuota,
      resetAtIso: null,
    };
  }

  const dailyTokenLimit = Number(userRow.daily_token_limit);
  const nowSec = Math.floor(nowMs / 1000);
  let windowStartSec: number;
  let resetAtMs: number;

  if (userRow.quota_reset_mode === 'rolling_24h') {
    windowStartSec = nowSec - 86400;
    const oldestRow = db
      .prepare(
        `SELECT MIN(created_at) AS oldest_created_at
         FROM usage_logs
         WHERE user_id = ? AND created_at >= ?
           AND (prompt_tokens + completion_tokens + reasoning_tokens) > 0`,
      )
      .get(userId, windowStartSec) as { oldest_created_at: number | bigint | null } | undefined;

    const oldestSec =
      oldestRow?.oldest_created_at !== null && oldestRow?.oldest_created_at !== undefined
        ? Number(oldestRow.oldest_created_at)
        : nowSec;
    resetAtMs = (oldestSec + 86400) * 1000;
  } else {
    const startOfUtcDaySec = Math.floor(nowSec / 86400) * 86400;
    windowStartSec = startOfUtcDaySec;
    resetAtMs = (startOfUtcDaySec + 86400) * 1000;
  }

  const usageRow = db
    .prepare(
      `SELECT COALESCE(SUM(prompt_tokens + completion_tokens + reasoning_tokens), 0) AS used_tokens
       FROM usage_logs
       WHERE user_id = ? AND created_at >= ?`,
    )
    .get(userId, windowStartSec) as { used_tokens: number | bigint } | undefined;

  const usedTokens = Number(usageRow?.used_tokens ?? 0);
  const resetAtIso = new Date(resetAtMs).toISOString();
  if (usedTokens < dailyTokenLimit) {
    return {
      exceeded: false,
      usedTokens,
      dailyTokenLimit,
      remainingTokens: Math.max(0, dailyTokenLimit - usedTokens),
      enforceStrictQuota,
      resetAtIso,
    };
  }

  const retryAfterSec = Math.max(1, Math.ceil((resetAtMs - nowMs) / 1000));
  const response = buildQuotaExceededResponse(
    usedTokens,
    dailyTokenLimit,
    resetAtIso,
    retryAfterSec,
  );

  return {
    exceeded: true,
    usedTokens,
    dailyTokenLimit,
    resetAtIso,
    retryAfterSec,
    response,
  };
}

function detectRequestContractFlags(requestBody: Record<string, unknown>): {
  usesTools: boolean;
  requiresToolCall: boolean;
  usesStructuredOutput: boolean;
} {
  const usesTools =
    (Array.isArray(requestBody.tools) && requestBody.tools.length > 0) ||
    (Array.isArray(requestBody.functions) && requestBody.functions.length > 0);
  const tc = requestBody.tool_choice;
  const requiresToolCall =
    usesTools && (tc === 'required' || (tc !== null && typeof tc === 'object'));

  const rf = requestBody.response_format;
  const rfType =
    rf !== null && typeof rf === 'object' ? (rf as Record<string, unknown>).type : undefined;
  const usesStructuredOutput = rfType === 'json_object' || rfType === 'json_schema';

  return { usesTools, requiresToolCall, usesStructuredOutput };
}

function classifyFailureErrorType(
  baseErrorType: string,
  flags: { usesTools: boolean; usesStructuredOutput: boolean },
): string {
  if (baseErrorType === 'rate_limit') {
    return 'rate_limit';
  }
  if (flags.usesTools) {
    return 'tool_error';
  }
  if (flags.usesStructuredOutput) {
    return 'structured_error';
  }
  return baseErrorType;
}

function isValidJsonText(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

function classifyPayloadContractError(
  data: Record<string, unknown>,
  flags: { usesTools: boolean; requiresToolCall: boolean; usesStructuredOutput: boolean },
): 'tool_error' | 'structured_error' | null {
  const choices = Array.isArray(data.choices) ? data.choices : [];
  const choice0 =
    choices.length > 0 && choices[0] && typeof choices[0] === 'object'
      ? (choices[0] as Record<string, unknown>)
      : null;
  const message =
    choice0?.message && typeof choice0.message === 'object'
      ? (choice0.message as Record<string, unknown>)
      : null;

  const toolCalls = Array.isArray(message?.tool_calls)
    ? (message.tool_calls as Array<Record<string, unknown>>)
    : [];

  if (toolCalls.length > 0) {
    for (const tc of toolCalls) {
      const fn =
        tc && typeof tc.function === 'object' && tc.function !== null
          ? (tc.function as Record<string, unknown>)
          : null;
      const fnName = typeof fn?.name === 'string' ? fn.name.trim() : '';
      const fnArgs = fn?.arguments;
      if (!fnName || typeof fnArgs !== 'string' || !isValidJsonText(fnArgs)) {
        return 'tool_error';
      }
    }
  } else if (message?.function_call && typeof message.function_call === 'object') {
    const fc = message.function_call as Record<string, unknown>;
    const fnName = typeof fc.name === 'string' ? fc.name.trim() : '';
    const fnArgs = fc.arguments;
    if (!fnName || typeof fnArgs !== 'string' || !isValidJsonText(fnArgs)) {
      return 'tool_error';
    }
  } else if (flags.requiresToolCall) {
    return 'tool_error';
  }

  if (flags.usesStructuredOutput && toolCalls.length === 0) {
    const content = typeof message?.content === 'string' ? message.content : '';
    if (!isValidJsonText(content)) {
      return 'structured_error';
    }
  }

  return null;
}

function loadCandidateKeys(
  db: DatabaseSync,
  providerId: string,
  registry: DrainingRegistry,
  nowSec: number,
): ProviderKeyRecord[] {
  // Recover rate-limited keys whose reset timestamp has passed (only if node is online or unassigned)
  db.prepare(
    `UPDATE provider_keys
     SET status = 'active', last_error = NULL
     WHERE provider_id = ?
       AND status = 'rate_limited'
       AND ratelimit_reset_at IS NOT NULL
       AND ratelimit_reset_at <= ?
       AND (node_id IS NULL OR node_id IN (SELECT id FROM nodes WHERE status = 'online'))`,
  ).run(providerId, nowSec);

  const rows = db
    .prepare(
      `SELECT pk.id, pk.provider_id, pk.label, pk.encrypted_secret, pk.last4, pk.node_id, pk.status,
              n.name AS node_name, n.mode AS node_mode, n.endpoint AS node_endpoint,
              n.encrypted_token AS node_encrypted_token, n.tls_fingerprint AS node_tls_fingerprint,
              n.status AS node_status
       FROM provider_keys pk
       LEFT JOIN nodes n ON n.id = pk.node_id
       WHERE pk.provider_id = ?
         AND pk.status = 'active'
         AND (pk.node_id IS NULL OR n.status = 'online')
       ORDER BY
         CASE WHEN pk.ratelimit_remaining = 0 THEN 1 ELSE 0 END ASC,
         pk.created_at ASC`,
    )
    .all(providerId) as unknown as ProviderKeyRecord[];

  return rows.filter((r) => !registry.isKeyDraining(r.id));
}

function openAiErrorJson(
  message: string,
  type: string,
  code: string,
  status: number,
): Response {
  return new Response(
    JSON.stringify({
      error: {
        message,
        type,
        param: null,
        code,
      },
    }),
    {
      status,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    },
  );
}

function isRetryableKeyFailureStatus(status: number): boolean {
  return status === 429 || status >= 500 || status === 401 || status === 403;
}

export async function executeChatCompletions(options: {
  db: DatabaseSync;
  masterKey: Buffer;
  registry: DrainingRegistry;
  fetchImpl: typeof fetch;
  allowLocalhost?: boolean;
  dnsLookup?: DnsLookupFn;
  upstreamTls?: UpstreamTlsOptions;
  now: () => number;
  userId: string;
  internalApiKeyId?: string | null;
  modelFullId: string;
  modelId: string;
  providerRow: Record<string, unknown>;
  requestBody: Record<string, unknown>;
  signal?: AbortSignal;
  headersTimeoutMs?: number;
  requestTimeoutMs?: number;
  streamIdleTimeoutMs?: number;
}): Promise<Response> {
  const {
    db,
    masterKey,
    registry,
    fetchImpl,
    allowLocalhost,
    dnsLookup,
    upstreamTls,
    now,
    userId,
    internalApiKeyId = null,
    modelFullId,
    modelId,
    providerRow,
    requestBody,
    signal: clientSignal,
    streamIdleTimeoutMs = DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  } = options;
  const effectiveHeadersTimeoutMs =
    options.headersTimeoutMs ?? options.requestTimeoutMs ?? DEFAULT_UPSTREAM_HEADERS_TIMEOUT_MS;

  const startMs = now();
  const nowSec = Math.floor(startMs / 1000);

  // Reject any non-1 or non-numeric `n` (including n: true, n: "1", n: 2)
  if (requestBody.n !== undefined && requestBody.n !== null) {
    if (
      typeof requestBody.n !== 'number' ||
      !Number.isInteger(requestBody.n) ||
      requestBody.n !== 1
    ) {
      return openAiErrorJson(
        'Parameter "n" must be 1; multiple completions (n > 1) are not supported.',
        'invalid_request_error',
        'unsupported_parameter',
        400,
      );
    }
  }

  // Enforce server-side UTC daily token quota before any upstream execution (HU-17, HU-05)
  const quotaCheck = checkUserDailyQuotaUtc(db, userId, startMs);
  if (quotaCheck.exceeded) {
    return quotaCheck.response;
  }

  const providerId = String(providerRow.id);
  if (registry.isProviderDraining(providerId)) {
    return openAiErrorJson(
      `Provider "${providerId}" is currently being removed.`,
      'service_unavailable',
      'provider_unavailable',
      503,
    );
  }

  const isStream = requestBody.stream === true;
  const sanitizedBody = filterChatCompletionsBody(requestBody, isStream);
  const originalMessages = Array.isArray(sanitizedBody.messages)
    ? (sanitizedBody.messages as Array<Record<string, unknown>>)
    : [];

  const contractFlags = detectRequestContractFlags(sanitizedBody);

  const manifest = JSON.parse(String(providerRow.schema_json)) as ProviderManifest;
  const upstreamMode =
    providerRow.package_type === 'experimental-adapter'
      ? ('experimental-adapter' as const)
      : ('official-json' as const);
  const effectiveAllowLocalhost =
    allowLocalhost !== undefined ? allowLocalhost : allowLocalOfficialUpstreams();
  const effectiveBaseUrl =
    providerRow.package_type === 'experimental-adapter' &&
    typeof providerRow.adapter_url === 'string' &&
    providerRow.adapter_url.length > 0
      ? providerRow.adapter_url
      : manifest.baseUrl;

  const rawChatUrl = `${effectiveBaseUrl.replace(/\/+$/, '')}/chat/completions`;
  let chatUrl: string;
  try {
    chatUrl = assertSafeUpstreamUrlSync(rawChatUrl, {
      mode: upstreamMode,
      allowLocalhost: effectiveAllowLocalhost,
    });
  } catch (err) {
    return openAiErrorJson(
      err instanceof Error ? err.message : 'Upstream URL blocked by SSRF policy.',
      'invalid_request_error',
      'ssrf_blocked',
      400,
    );
  }

  const candidates = loadCandidateKeys(db, providerId, registry, nowSec);
  if (candidates.length === 0) {
    safeWriteSystemLog(
      db,
      'warn',
      'system',
      `Routing failed for "${modelFullId}": provider "${providerId}" has no active API keys with an online exit node available.`,
      { providerId, modelFullId, userId },
      nowSec,
    );
    return openAiErrorJson(
      `Provider "${providerId}" has no active API keys with an online exit node available.`,
      'service_unavailable',
      'no_provider_keys',
      503,
    );
  }

  const estimatedPromptTokens = estimateMessagesPromptTokens(originalMessages);
  const requestedMax =
    typeof sanitizedBody.max_tokens === 'number' &&
    Number.isFinite(sanitizedBody.max_tokens) &&
    sanitizedBody.max_tokens > 0
      ? Math.floor(sanitizedBody.max_tokens)
      : null;
  const requestedMaxComp =
    typeof sanitizedBody.max_completion_tokens === 'number' &&
    Number.isFinite(sanitizedBody.max_completion_tokens) &&
    sanitizedBody.max_completion_tokens > 0
      ? Math.floor(sanitizedBody.max_completion_tokens)
      : null;
  const explicitRequestedMaxOutput =
    requestedMax !== null && requestedMaxComp !== null
      ? Math.min(requestedMax, requestedMaxComp)
      : (requestedMaxComp ?? requestedMax);

  // Anti-TOCTOU in-flight reservation ONLY for accounts with daily_token_limit != null && enforce_strict_quota = 1
  const isStrictLimitedUser =
    quotaCheck.dailyTokenLimit !== null &&
    quotaCheck.enforceStrictQuota === true &&
    quotaCheck.remainingTokens !== null;

  let strictRemainingTokens: number | null = null;
  let strictMaxOutputTokens: number | null = null;
  let releaseQuotaReservation: () => void = () => {};

  if (isStrictLimitedUser) {
    const alreadyReserved = getInFlightReservedTokens(userId);
    const effectiveRemaining = Math.max(0, quotaCheck.remainingTokens! - alreadyReserved);
    if (effectiveRemaining <= 0 || estimatedPromptTokens >= effectiveRemaining) {
      const resetAtIso = quotaCheck.resetAtIso ?? new Date(startMs + 86400_000).toISOString();
      const parsedResetMs = Date.parse(resetAtIso);
      const retryAfterSec = Number.isFinite(parsedResetMs)
        ? Math.max(1, Math.ceil((parsedResetMs - startMs) / 1000))
        : 60;
      return buildQuotaExceededResponse(
        quotaCheck.usedTokens + alreadyReserved,
        quotaCheck.dailyTokenLimit!,
        resetAtIso,
        retryAfterSec,
      );
    }

    strictRemainingTokens = effectiveRemaining;
    strictMaxOutputTokens = Math.max(1, strictRemainingTokens - estimatedPromptTokens);

    const expectedMaxOut =
      explicitRequestedMaxOutput !== null
        ? Math.min(explicitRequestedMaxOutput, strictMaxOutputTokens)
        : Math.min(strictMaxOutputTokens, Math.max(estimatedPromptTokens, 512));

    const reserveAmount = Math.min(
      strictRemainingTokens,
      Math.max(1, estimatedPromptTokens + expectedMaxOut),
    );
    releaseQuotaReservation = reserveInFlightTokens(userId, reserveAmount);
  }

  let reservationTransferredToStream = false;

  try {
    const extractSafeUpstreamErrorMessage = async (
      res: Response,
      rawSecret?: string | null,
    ): Promise<{ safeMessage: string; rawText: string }> => {
      const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
      const rawBody = await res.text().catch(() => '');
      const redactedRaw = redactWithRawSecret(rawBody, rawSecret);
      if (contentType.includes('application/json') && rawBody.trim().length > 0) {
        try {
          const parsed = JSON.parse(rawBody) as Record<string, unknown>;
          const errField = parsed.error;
          const candidate =
            errField && typeof errField === 'object' && !Array.isArray(errField)
              ? (errField as Record<string, unknown>).message
              : typeof errField === 'string'
                ? errField
                : parsed.message;
          if (typeof candidate === 'string' && candidate.trim().length > 0) {
            return {
              safeMessage: redactWithRawSecret(candidate.trim(), rawSecret).slice(0, 300),
              rawText: redactedRaw,
            };
          }
        } catch {
          // Ignore malformed JSON body and return generic HTTP status message
        }
      }
      return {
        safeMessage: `Upstream provider returned HTTP ${res.status}.`,
        rawText: redactedRaw,
      };
    };

    const dispatchRequestForKey = async (
      key: ProviderKeyRecord,
      init: RequestInit,
      mode: 'stream' | 'buffered' = 'buffered',
    ): Promise<Response> => {
      if (mode === 'stream') {
        // B1: Dedicated AbortController for HTTP response headers timeout only;
        // cleared immediately once headers resolve so long-running active SSE streams
        // are governed solely by clientSignal and readChunkWithIdleTimeout.
        const headersAbortController = new AbortController();
        const safeTimeoutMs = Math.max(1, Math.floor(effectiveHeadersTimeoutMs));
        const headersTimer = setTimeout(() => {
          headersAbortController.abort(
            new Error(`Upstream response headers timed out after ${safeTimeoutMs}ms`),
          );
        }, safeTimeoutMs);
        headersTimer.unref?.();

        const combinedSignal = clientSignal
          ? AbortSignal.any([clientSignal, headersAbortController.signal])
          : headersAbortController.signal;
        const initWithSignal: RequestInit = {
          ...init,
          signal: combinedSignal,
        };

        try {
          if (key.node_id) {
            if (!key.node_encrypted_token || !key.node_endpoint) {
              throw new Error(`Assigned exit node "${key.node_id}" is missing tunnel credentials`);
            }
            const nodeRawToken = decryptSecret(key.node_encrypted_token, masterKey);
            return await fetchViaExitNode(
              chatUrl,
              initWithSignal,
              {
                id: key.node_id,
                name: key.node_name ?? key.node_id,
                mode: key.node_mode === 'public_ip' ? 'public_ip' : 'tailscale',
                endpoint: key.node_endpoint,
                rawToken: nodeRawToken,
                tlsFingerprint: key.node_tls_fingerprint,
              },
              upstreamTls,
            );
          }
          return await safeFetch(
            chatUrl,
            { ...initWithSignal, redirect: 'error' },
            {
              mode: upstreamMode,
              allowLocalhost: effectiveAllowLocalhost,
              fetchImpl,
              dnsLookup,
              upstreamTls,
            },
          );
        } finally {
          clearTimeout(headersTimer);
        }
      }

      const combinedSignal = buildUpstreamSignal(clientSignal, effectiveHeadersTimeoutMs);
      const initWithSignal: RequestInit = {
        ...init,
        signal: combinedSignal,
      };
      if (key.node_id) {
        if (!key.node_encrypted_token || !key.node_endpoint) {
          throw new Error(`Assigned exit node "${key.node_id}" is missing tunnel credentials`);
        }
        const nodeRawToken = decryptSecret(key.node_encrypted_token, masterKey);
        return fetchViaExitNode(
          chatUrl,
          initWithSignal,
          {
            id: key.node_id,
            name: key.node_name ?? key.node_id,
            mode: key.node_mode === 'public_ip' ? 'public_ip' : 'tailscale',
            endpoint: key.node_endpoint,
            rawToken: nodeRawToken,
            tlsFingerprint: key.node_tls_fingerprint,
          },
          upstreamTls,
        );
      }
      return safeFetch(
        chatUrl,
        { ...initWithSignal, redirect: 'error' },
        {
          mode: upstreamMode,
          allowLocalhost: effectiveAllowLocalhost,
          fetchImpl,
          dnsLookup,
          upstreamTls,
        },
      );
    };

    const applyStrictMaxTokens = (
      body: Record<string, unknown>,
      capOverride?: number | null,
    ): Record<string, unknown> => {
      const effectiveCap =
        capOverride !== undefined && capOverride !== null
          ? Math.max(1, Math.floor(capOverride))
          : strictMaxOutputTokens;
      if (effectiveCap === null) return body;
      const out: Record<string, unknown> = { ...body };
      const existingMax =
        typeof out.max_tokens === 'number' && Number.isFinite(out.max_tokens) && out.max_tokens > 0
          ? Math.floor(out.max_tokens)
          : null;
      const existingMaxComp =
        typeof out.max_completion_tokens === 'number' &&
        Number.isFinite(out.max_completion_tokens) &&
        out.max_completion_tokens > 0
          ? Math.floor(out.max_completion_tokens)
          : null;

      if (existingMaxComp !== null) {
        out.max_completion_tokens = Math.min(existingMaxComp, effectiveCap);
      }
      if (existingMax !== null) {
        out.max_tokens = Math.min(existingMax, effectiveCap);
      }
      if (existingMaxComp === null && existingMax === null) {
        out.max_tokens = effectiveCap;
      }
      return out;
    };

    // =========================================================================
    // Mode 1: Non-Streaming (stream: false) with HU-09 Failover + Exit Node Tunnel
    // =========================================================================
    if (!isStream) {
      const triedKeyIds = new Set<string>();
      let lastStatus: number | null = null;
      let lastErrorMsg = 'Upstream provider request failed.';
      let lastKeyId: string | null = null;
      let lastWasNetwork = false;

      for (let i = 0; i < candidates.length; i++) {
        const key = candidates[i]!;
        if (registry.isKeyDraining(key.id) || triedKeyIds.has(key.id)) {
          continue;
        }
        triedKeyIds.add(key.id);
        lastKeyId = key.id;

        const releaseLease = registry.acquireLease(providerId, key.id);
        try {
          const rawSecret = decryptSecret(key.encrypted_secret, masterKey);
          const headers = mergeHeadersCaseInsensitive(
            buildProviderAuthHeaders(manifest.auth, rawSecret),
            { 'Content-Type': 'application/json' },
          );
          const upstreamBody = applyStrictMaxTokens({
            ...sanitizedBody,
            model: modelId,
            stream: false,
          });

          let res: Response;
          try {
            res = await dispatchRequestForKey(key, {
              method: 'POST',
              headers,
              body: JSON.stringify(upstreamBody),
            });
          } catch (err) {
            if (err instanceof UpstreamSsrfError) {
              return openAiErrorJson(
                redactWithRawSecret(err.message, rawSecret),
                'invalid_request_error',
                'ssrf_blocked',
                400,
              );
            }
            if (clientSignal?.aborted) {
              return openAiErrorJson(
                'Client closed the request before upstream completed.',
                'invalid_request_error',
                'client_aborted',
                499,
              );
            }
            const msg = err instanceof Error ? err.message : String(err);
            lastStatus = null;
            lastWasNetwork = true;
            lastErrorMsg = redactWithRawSecret(`Network/tunnel error: ${msg}`, rawSecret).slice(
              0,
              300,
            );
            safeMarkKeyFailure(
              db,
              key.id,
              null,
              lastErrorMsg,
              null,
              Math.floor(now() / 1000),
              manifest.rateLimitKind,
              rawSecret,
            );

            const nextKey = candidates.slice(i + 1).find((k) => !registry.isKeyDraining(k.id));
            if (nextKey) {
              safeWriteSystemLog(
                db,
                'warn',
                'failover',
                `Key "${key.label}" (…${key.last4}) failed with network/tunnel error on "${providerId}"; failing over to "${nextKey.label}" (…${nextKey.last4})`,
                {
                  providerId,
                  failedKeyId: key.id,
                  failedKeyLast4: key.last4,
                  nodeId: key.node_id,
                  nextKeyId: nextKey.id,
                  reason: lastErrorMsg,
                },
                Math.floor(now() / 1000),
              );
              continue;
            }
            break;
          }

          if (isRetryableKeyFailureStatus(res.status)) {
            lastStatus = res.status;
            lastWasNetwork = false;
            const { safeMessage: safeErr } = await extractSafeUpstreamErrorMessage(res, rawSecret);
            lastErrorMsg = redactWithRawSecret(`HTTP ${res.status}: ${safeErr}`, rawSecret).slice(
              0,
              180,
            );
            safeMarkKeyFailure(
              db,
              key.id,
              res.status,
              lastErrorMsg,
              res.headers,
              Math.floor(now() / 1000),
              manifest.rateLimitKind,
              rawSecret,
            );

            const nextKey = candidates.slice(i + 1).find((k) => !registry.isKeyDraining(k.id));
            if (nextKey) {
              safeWriteSystemLog(
                db,
                'warn',
                'failover',
                `Key "${key.label}" (…${key.last4}) returned HTTP ${res.status} on "${providerId}"; failing over to "${nextKey.label}" (…${nextKey.last4})`,
                {
                  providerId,
                  failedKeyId: key.id,
                  failedKeyLast4: key.last4,
                  nodeId: key.node_id,
                  nextKeyId: nextKey.id,
                  httpStatus: res.status,
                },
                Math.floor(now() / 1000),
              );
              continue;
            }
            break;
          }

          if (!res.ok) {
            const { safeMessage: safeErr } = await extractSafeUpstreamErrorMessage(res, rawSecret);
            const endMs = now();
            const endSec = Math.floor(endMs / 1000);
            safeWriteSystemLog(
              db,
              'error',
              'system',
              `Upstream HTTP ${res.status} on "${modelFullId}" (${providerId}): ${safeErr}`,
              { providerId, modelFullId, keyId: key.id, httpStatus: res.status },
              endSec,
            );
            safeRecordUsageLog(db, {
              userId,
              providerId,
              providerKeyId: key.id,
              internalApiKeyId,
              modelFullId,
              promptTokens: 0,
              completionTokens: 0,
              reasoningTokens: 0,
              cachedTokens: 0,
              ttftMs: null,
              durationMs: Math.max(1, endMs - startMs),
              status: 'error',
              errorType: classifyFailureErrorType('upstream', contractFlags),
              createdAt: endSec,
            });
            return openAiErrorJson(
              safeErr,
              'invalid_request_error',
              'upstream_error',
              res.status,
            );
          }

          const ttftMs = Math.max(1, now() - startMs);
          let data: Record<string, unknown>;
          try {
            data = (await res.json()) as Record<string, unknown>;
          } catch {
            const endMs = now();
            const endSec = Math.floor(endMs / 1000);
            safeWriteSystemLog(
              db,
              'error',
              'system',
              `Upstream provider "${providerId}" returned malformed JSON on "${modelFullId}"`,
              { providerId, modelFullId, keyId: key.id },
              endSec,
            );
            safeRecordUsageLog(db, {
              userId,
              providerId,
              providerKeyId: key.id,
              internalApiKeyId,
              modelFullId,
              promptTokens: 0,
              completionTokens: 0,
              reasoningTokens: 0,
              cachedTokens: 0,
              ttftMs,
              durationMs: Math.max(1, endMs - startMs),
              status: 'error',
              errorType: classifyFailureErrorType('upstream', contractFlags),
              createdAt: endSec,
            });
            return openAiErrorJson(
              'Upstream provider returned malformed JSON response.',
              'server_error',
              'malformed_upstream_json',
              502,
            );
          }

          const endMs = now();
          const durationMs = Math.max(1, endMs - startMs);
          const endSec = Math.floor(endMs / 1000);

          safeUpdateKeyHealthy(db, key.id, res.headers, endSec, manifest.rateLimitKind);

          const usage =
            data.usage && typeof data.usage === 'object'
              ? (data.usage as Record<string, unknown>)
              : {};
          const compDetails =
            usage.completion_tokens_details && typeof usage.completion_tokens_details === 'object'
              ? (usage.completion_tokens_details as Record<string, unknown>)
              : {};
          const promptDetails =
            usage.prompt_tokens_details && typeof usage.prompt_tokens_details === 'object'
              ? (usage.prompt_tokens_details as Record<string, unknown>)
              : {};

          const { contentChars, reasoningChars, toolCallChars } =
            extractNonStreamingOutputChars(data);
          const resolvedTokens = applySelectiveTokenFallbacks({
            promptTokens: usage.prompt_tokens,
            completionTokens: usage.completion_tokens,
            reasoningTokens: compDetails.reasoning_tokens ?? usage.reasoning_tokens,
            cachedTokens: promptDetails.cached_tokens ?? usage.cached_tokens,
            estimatedPromptTokens,
            contentChars,
            reasoningChars,
            toolCallChars,
            wasHttp200: true,
          });

          if (resolvedTokens.zeroUsageWarn) {
            safeWriteSystemLog(
              db,
              'warn',
              'system',
              `Upstream HTTP 200 on "${modelFullId}" (${providerId}) returned zero usage and empty output; charging fallback prompt tokens (${resolvedTokens.promptTokens}).`,
              {
                providerId,
                modelFullId,
                keyId: key.id,
                fallbackPromptTokens: resolvedTokens.promptTokens,
              },
              endSec,
            );
          }

          const contractError = classifyPayloadContractError(data, contractFlags);

          safeRecordUsageLog(db, {
            userId,
            providerId,
            providerKeyId: key.id,
            internalApiKeyId,
            modelFullId,
            promptTokens: resolvedTokens.promptTokens,
            completionTokens: resolvedTokens.completionTokens,
            reasoningTokens: resolvedTokens.reasoningTokens,
            cachedTokens: resolvedTokens.cachedTokens,
            ttftMs,
            durationMs,
            status: contractError ? 'error' : 'ok',
            errorType: contractError,
            createdAt: endSec,
          });

          const responsePayload = {
            ...data,
            model: modelFullId,
          };

          const tps = computeTokensPerSec(
            resolvedTokens.completionTokens,
            resolvedTokens.reasoningTokens,
            durationMs,
          );
          const responseHeaders: Record<string, string> = {
            'Content-Type': 'application/json; charset=utf-8',
            'X-Bifrost-TTFT-Ms': String(ttftMs),
          };
          if (tps !== null) {
            responseHeaders['X-Bifrost-Tokens-Per-Sec'] = String(tps);
          }

          return new Response(JSON.stringify(responsePayload), {
            status: 200,
            headers: responseHeaders,
          });
        } finally {
          releaseLease();
        }
      }

      const failEndMs = now();
      const failSec = Math.floor(failEndMs / 1000);
      safeWriteSystemLog(
        db,
        'error',
        'failover',
        `All candidate keys exhausted for provider "${providerId}": ${lastErrorMsg}`,
        { providerId, triedKeysCount: triedKeyIds.size, lastStatus },
        failSec,
      );

      const baseFailType =
        lastStatus === 429 ? 'rate_limit' : lastWasNetwork ? 'network' : 'upstream';

      safeRecordUsageLog(db, {
        userId,
        providerId,
        providerKeyId: lastKeyId,
        internalApiKeyId,
        modelFullId,
        promptTokens: 0,
        completionTokens: 0,
        reasoningTokens: 0,
        cachedTokens: 0,
        ttftMs: null,
        durationMs: Math.max(1, failEndMs - startMs),
        status: 'error',
        errorType: classifyFailureErrorType(baseFailType, contractFlags),
        createdAt: failSec,
      });

      return openAiErrorJson(
        `All configured keys for provider "${providerId}" failed (${lastErrorMsg}).`,
        lastStatus === 429 ? 'rate_limit_error' : 'service_unavailable',
        lastStatus === 429 ? 'upstream_rate_limited' : 'upstream_unavailable',
        lastStatus === 429 ? 429 : 502,
      );
    }

    // =========================================================================
    // Mode 2: Streaming SSE (stream: true) with Pre-Token Failover + Mid-Stream Resume
    // =========================================================================

    const triedKeyIds = new Set<string>();
    let lastStreamOpenKeyId: string | null = null;
    let lastStreamOpenStatus: number | null = null;
    let nonRetryableStreamFailure: { status: number; message: string; keyId: string } | null = null;
    let clientAbortedBeforeOpen = false;
    let omitStreamOptions = false;

    const effectiveInitialMaxOutput =
      explicitRequestedMaxOutput !== null && strictMaxOutputTokens !== null
        ? Math.min(explicitRequestedMaxOutput, strictMaxOutputTokens)
        : (explicitRequestedMaxOutput ?? strictMaxOutputTokens);

    interface ActiveStreamConnection {
      key: ProviderKeyRecord;
      response: Response;
      releaseLease: () => void;
      rawSecret: string;
    }

    const openStreamWithNextKey = async (
      messagesToSend: Array<Record<string, unknown>>,
      logCategoryOnRetry: 'failover' | 'stream_resume',
      maxOutputCapOverride?: number | null,
    ): Promise<ActiveStreamConnection | null> => {
      for (const key of candidates) {
        if (clientSignal?.aborted) {
          clientAbortedBeforeOpen = true;
          return null;
        }
        if (triedKeyIds.has(key.id) || registry.isKeyDraining(key.id)) {
          continue;
        }
        triedKeyIds.add(key.id);
        lastStreamOpenKeyId = key.id;

        const releaseLease = registry.acquireLease(providerId, key.id);
        try {
          const rawSecret = decryptSecret(key.encrypted_secret, masterKey);
          const headers = mergeHeadersCaseInsensitive(
            buildProviderAuthHeaders(manifest.auth, rawSecret),
            {
              'Content-Type': 'application/json',
              Accept: 'text/event-stream',
              'Accept-Encoding': 'identity',
            },
          );

          const baseStreamBody: Record<string, unknown> = {
            ...sanitizedBody,
            model: modelId,
            messages: messagesToSend,
            stream: true,
          };
          let injectedStreamOptions = false;
          if (!omitStreamOptions) {
            const existingStreamOpts =
              baseStreamBody.stream_options &&
              typeof baseStreamBody.stream_options === 'object' &&
              !Array.isArray(baseStreamBody.stream_options)
                ? (baseStreamBody.stream_options as Record<string, unknown>)
                : {};
            baseStreamBody.stream_options = {
              ...existingStreamOpts,
              include_usage: true,
            };
            injectedStreamOptions = true;
          } else {
            delete baseStreamBody.stream_options;
          }

          let upstreamBody = applyStrictMaxTokens(baseStreamBody, maxOutputCapOverride);

          const sendAttempt = async (bodyObj: Record<string, unknown>): Promise<Response | null> => {
            try {
              return await dispatchRequestForKey(
                key,
                {
                  method: 'POST',
                  headers,
                  body: JSON.stringify(bodyObj),
                },
                'stream',
              );
            } catch (err) {
              if (err instanceof UpstreamSsrfError) {
                nonRetryableStreamFailure = {
                  status: 400,
                  message: redactWithRawSecret(err.message, rawSecret),
                  keyId: key.id,
                };
                return null;
              }
              if (clientSignal?.aborted) {
                clientAbortedBeforeOpen = true;
                return null;
              }
              lastStreamOpenStatus = null;
              const msg = err instanceof Error ? err.message : String(err);
              const safeMsg = redactWithRawSecret(`Network/tunnel error: ${msg}`, rawSecret).slice(
                0,
                300,
              );
              safeMarkKeyFailure(
                db,
                key.id,
                null,
                safeMsg,
                null,
                Math.floor(now() / 1000),
                manifest.rateLimitKind,
                rawSecret,
              );

              const hasMore = candidates.some(
                (k) => !triedKeyIds.has(k.id) && !registry.isKeyDraining(k.id),
              );
              if (hasMore) {
                safeWriteSystemLog(
                  db,
                  'warn',
                  logCategoryOnRetry,
                  `Key "${key.label}" (…${key.last4}) failed with network/tunnel error on "${providerId}"; trying next available key`,
                  { providerId, failedKeyId: key.id, nodeId: key.node_id, reason: safeMsg },
                  Math.floor(now() / 1000),
                );
              }
              return null;
            }
          };

          let res = await sendAttempt(upstreamBody);
          if (res === null) {
            releaseLease();
            if (clientAbortedBeforeOpen || nonRetryableStreamFailure) return null;
            continue;
          }

          // Transparent single retry on the SAME key without stream_options if upstream rejects it with HTTP 400
          let preReadError: { safeMessage: string; rawText: string } | null = null;
          if (res.status === 400 && injectedStreamOptions) {
            preReadError = await extractSafeUpstreamErrorMessage(res, rawSecret);
            if (
              isStreamOptionsUnsupportedError(preReadError.safeMessage) ||
              isStreamOptionsUnsupportedError(preReadError.rawText)
            ) {
              omitStreamOptions = true;
              const retryBase = { ...upstreamBody };
              delete retryBase.stream_options;
              upstreamBody = retryBase;
              preReadError = null;
              res = await sendAttempt(upstreamBody);
              if (res === null) {
                releaseLease();
                if (clientAbortedBeforeOpen || nonRetryableStreamFailure) return null;
                continue;
              }
            }
          }

          if (isRetryableKeyFailureStatus(res.status) || !res.body) {
            const status = res.status;
            const hasBody = Boolean(res.body);
            lastStreamOpenStatus = hasBody ? status : null;
            const safeErr =
              preReadError?.safeMessage ??
              (await extractSafeUpstreamErrorMessage(res, rawSecret)).safeMessage;
            releaseLease();
            const safeMsg = redactWithRawSecret(`HTTP ${status}: ${safeErr}`, rawSecret).slice(
              0,
              180,
            );
            // STB-13: pass null status when body is missing (e.g. HTTP 200 with null body) so key is not permanently marked 'error'
            safeMarkKeyFailure(
              db,
              key.id,
              hasBody ? status : null,
              safeMsg,
              res.headers,
              Math.floor(now() / 1000),
              manifest.rateLimitKind,
              rawSecret,
            );

            const hasMore = candidates.some(
              (k) => !triedKeyIds.has(k.id) && !registry.isKeyDraining(k.id),
            );
            if (hasMore) {
              safeWriteSystemLog(
                db,
                'warn',
                logCategoryOnRetry,
                `Key "${key.label}" (…${key.last4}) returned HTTP ${status} on "${providerId}"; failing over to next key`,
                { providerId, failedKeyId: key.id, nodeId: key.node_id, httpStatus: status },
                Math.floor(now() / 1000),
              );
            }
            continue;
          }

          if (!res.ok) {
            const safeErr =
              preReadError?.safeMessage ??
              (await extractSafeUpstreamErrorMessage(res, rawSecret)).safeMessage;
            releaseLease();
            nonRetryableStreamFailure = {
              status: res.status,
              message: safeErr,
              keyId: key.id,
            };
            return null;
          }

          return { key, response: res, releaseLease, rawSecret };
        } catch (err) {
          releaseLease();
          throw err;
        }
      }

      return null;
    };

    const initialConnection = await openStreamWithNextKey(originalMessages, 'failover');
    if (!initialConnection) {
      if (clientAbortedBeforeOpen) {
        return openAiErrorJson(
          'Client closed the request before stream opened.',
          'invalid_request_error',
          'client_aborted',
          499,
        );
      }
      const failEndMs = now();
      const failSec = Math.floor(failEndMs / 1000);
      if (nonRetryableStreamFailure !== null) {
        const nrf: { status: number; message: string; keyId: string } = nonRetryableStreamFailure;
        safeWriteSystemLog(
          db,
          'error',
          'system',
          `Upstream HTTP ${nrf.status} on SSE stream "${modelFullId}" (${providerId}): ${nrf.message}`,
          { providerId, modelFullId, keyId: nrf.keyId, httpStatus: nrf.status },
          failSec,
        );
        safeRecordUsageLog(db, {
          userId,
          providerId,
          providerKeyId: nrf.keyId,
          internalApiKeyId,
          modelFullId,
          promptTokens: 0,
          completionTokens: 0,
          reasoningTokens: 0,
          cachedTokens: 0,
          ttftMs: null,
          durationMs: Math.max(1, failEndMs - startMs),
          status: 'error',
          errorType: classifyFailureErrorType('upstream', contractFlags),
          createdAt: failSec,
        });
        return openAiErrorJson(
          nrf.message,
          'invalid_request_error',
          'upstream_error',
          nrf.status,
        );
      }

      safeWriteSystemLog(
        db,
        'error',
        'failover',
        `All candidate keys failed before starting SSE stream on provider "${providerId}"`,
        { providerId, triedKeysCount: triedKeyIds.size, lastStatus: lastStreamOpenStatus },
        failSec,
      );
      const baseOpenErr = lastStreamOpenStatus === 429 ? 'rate_limit' : 'upstream';
      safeRecordUsageLog(db, {
        userId,
        providerId,
        providerKeyId: lastStreamOpenKeyId,
        internalApiKeyId,
        modelFullId,
        promptTokens: 0,
        completionTokens: 0,
        reasoningTokens: 0,
        cachedTokens: 0,
        ttftMs: null,
        durationMs: Math.max(1, failEndMs - startMs),
        status: 'error',
        errorType: classifyFailureErrorType(baseOpenErr, contractFlags),
        createdAt: failSec,
      });
      return openAiErrorJson(
        `All configured keys for provider "${providerId}" failed to open stream.`,
        lastStreamOpenStatus === 429 ? 'rate_limit_error' : 'service_unavailable',
        lastStreamOpenStatus === 429 ? 'upstream_rate_limited' : 'upstream_unavailable',
        lastStreamOpenStatus === 429 ? 429 : 502,
      );
    }

    const encoder = new TextEncoder();

    let clientAborted = false;
    let activeReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    const cancelActiveReader = () => {
      const readerToCancel = activeReader;
      activeReader = null;
      if (readerToCancel) {
        void readerToCancel.cancel().catch(() => {
          // Ignore upstream reader cancel errors
        });
      }
    };

    const onClientSignalAbort = () => {
      clientAborted = true;
      cancelActiveReader();
    };
    if (clientSignal) {
      if (clientSignal.aborted) {
        clientAborted = true;
      } else {
        clientSignal.addEventListener('abort', onClientSignalAbort, { once: true });
      }
    }

    reservationTransferredToStream = true;

    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        clientAborted = true;
        cancelActiveReader();
      },
      start(controller) {
        const safeEnqueue = (chunk: Uint8Array): boolean => {
          if (clientAborted) return false;
          try {
            controller.enqueue(chunk);
            return true;
          } catch {
            clientAborted = true;
            return false;
          }
        };
        const safeClose = (): void => {
          try {
            controller.close();
          } catch {
            // Ignore already closed/errored controller
          }
        };

        void (async () => {
          let activeConn: ActiveStreamConnection | null = initialConnection;

          let contentAccumulated = '';
          let contentCharsTotal = 0;
          let reasoningAccumulated = '';
          let reasoningCharsTotal = 0;
          let toolCallCharsAccumulated = 0;
          const toolCallsAccumulated = new Map<number, { name: string; args: string }>();
          let ttftMs: number | null = null;
          let totalPromptTokens = 0;
          let totalCompletionTokens = 0;
          let totalReasoningTokens = 0;
          let totalCachedTokens = 0;
          let wasResumed = false;
          let quotaCutMidStream = false;
          let lastKeyUsedId = initialConnection.key.id;
          let lastRawSecret: string | null = initialConnection.rawSecret;

          try {
            while (activeConn !== null && !clientAborted) {
              const currentKey = activeConn.key;
              const currentRes = activeConn.response;
              const releaseCurrent = activeConn.releaseLease;
              const currentRawSecret = activeConn.rawSecret;
              lastKeyUsedId = currentKey.id;
              lastRawSecret = currentRawSecret;

              let sawDone = false;
              let sawFinishReason = false;
              let streamFailureReason: string | null = null;

              // Per-connection usage counters (DEEP-08): cumulative usage chunks use Math.max
              // and are added to running totals ONCE when this connection finishes.
              let connPromptTokens = 0;
              let connCompletionTokens = 0;
              let connReasoningTokens = 0;
              let connCachedTokens = 0;
              let connContentChars = 0;
              let connReasoningChars = 0;
              let connToolCallChars = 0;

              const reader = currentRes.body!.getReader();
              activeReader = reader;
              const decoder = new TextDecoder();
              let buffer = '';
              let eventDataLines: string[] = [];
              let eventDataChars = 0;

              const processEventPayload = (payload: string): boolean => {
                if (clientAborted) {
                  return false;
                }
                const trimmed = payload.trim();
                if (!trimmed) {
                  return true;
                }
                if (trimmed === '[DONE]') {
                  sawDone = true;
                  return false;
                }

                let parsed: Record<string, unknown>;
                try {
                  const candidate = JSON.parse(trimmed) as unknown;
                  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
                    // Discard malformed non-object SSE JSON payloads
                    return true;
                  }
                  parsed = candidate as Record<string, unknown>;
                } catch {
                  // DEEP-09: Discard truncated/unparseable JSON fragments; never forward broken JSON to client
                  return true;
                }

                if (parsed.error) {
                  streamFailureReason = redactWithRawSecret(
                    JSON.stringify(parsed.error),
                    currentRawSecret,
                  ).slice(0, 300);
                  return false;
                }

                if (ttftMs === null) {
                  ttftMs = Math.max(1, now() - startMs);
                }

                if (parsed.usage && typeof parsed.usage === 'object') {
                  const u = parsed.usage as Record<string, unknown>;
                  connPromptTokens = Math.max(connPromptTokens, toSafeNonNegInt(u.prompt_tokens));
                  connCompletionTokens = Math.max(
                    connCompletionTokens,
                    toSafeNonNegInt(u.completion_tokens),
                  );
                  const compDet =
                    u.completion_tokens_details && typeof u.completion_tokens_details === 'object'
                      ? (u.completion_tokens_details as Record<string, unknown>)
                      : {};
                  connReasoningTokens = Math.max(
                    connReasoningTokens,
                    toSafeNonNegInt(compDet.reasoning_tokens ?? u.reasoning_tokens),
                  );
                  const promptDet =
                    u.prompt_tokens_details && typeof u.prompt_tokens_details === 'object'
                      ? (u.prompt_tokens_details as Record<string, unknown>)
                      : {};
                  connCachedTokens = Math.max(
                    connCachedTokens,
                    toSafeNonNegInt(promptDet.cached_tokens ?? u.cached_tokens),
                  );
                }

                if (Array.isArray(parsed.choices) && parsed.choices.length > 0) {
                  const choice0 = parsed.choices[0] as Record<string, unknown>;
                  const delta =
                    choice0.delta && typeof choice0.delta === 'object'
                      ? (choice0.delta as Record<string, unknown>)
                      : null;
                  if (delta) {
                    if (typeof delta.content === 'string' && delta.content.length > 0) {
                      connContentChars += delta.content.length;
                      contentCharsTotal += delta.content.length;
                      if (contentAccumulated.length < MAX_RESUME_ACCUMULATOR_CHARS) {
                        const room = MAX_RESUME_ACCUMULATOR_CHARS - contentAccumulated.length;
                        contentAccumulated += delta.content.slice(0, room);
                      }
                    }
                    const deltaReasoning =
                      typeof delta.reasoning_content === 'string'
                        ? delta.reasoning_content
                        : typeof delta.reasoning === 'string'
                          ? delta.reasoning
                          : '';
                    if (deltaReasoning.length > 0) {
                      connReasoningChars += deltaReasoning.length;
                      reasoningCharsTotal += deltaReasoning.length;
                      if (reasoningAccumulated.length < MAX_RESUME_ACCUMULATOR_CHARS) {
                        const room = MAX_RESUME_ACCUMULATOR_CHARS - reasoningAccumulated.length;
                        reasoningAccumulated += deltaReasoning.slice(0, room);
                      }
                    }
                    if (Array.isArray(delta.tool_calls)) {
                      for (let tcIdx = 0; tcIdx < delta.tool_calls.length; tcIdx++) {
                        const tcRaw = delta.tool_calls[tcIdx];
                        if (tcRaw && typeof tcRaw === 'object') {
                          const tcObj = tcRaw as Record<string, unknown>;
                          const slot = typeof tcObj.index === 'number' ? tcObj.index : tcIdx;
                          const existing = toolCallsAccumulated.get(slot) ?? { name: '', args: '' };
                          const fn =
                            tcObj.function && typeof tcObj.function === 'object'
                              ? (tcObj.function as Record<string, unknown>)
                              : null;
                          if (typeof fn?.name === 'string') {
                            connToolCallChars += fn.name.length;
                            toolCallCharsAccumulated += fn.name.length;
                            if (existing.name.length < MAX_RESUME_ACCUMULATOR_CHARS) {
                              existing.name += fn.name.slice(
                                0,
                                MAX_RESUME_ACCUMULATOR_CHARS - existing.name.length,
                              );
                            }
                          }
                          if (typeof fn?.arguments === 'string') {
                            connToolCallChars += fn.arguments.length;
                            toolCallCharsAccumulated += fn.arguments.length;
                            if (existing.args.length < MAX_RESUME_ACCUMULATOR_CHARS) {
                              existing.args += fn.arguments.slice(
                                0,
                                MAX_RESUME_ACCUMULATOR_CHARS - existing.args.length,
                              );
                            }
                          }
                          toolCallsAccumulated.set(slot, existing);
                        }
                      }
                    }
                  }
                  if (
                    choice0.finish_reason !== null &&
                    choice0.finish_reason !== undefined &&
                    choice0.finish_reason !== ''
                  ) {
                    sawFinishReason = true;
                  }
                }

                if (strictRemainingTokens !== null) {
                  const combinedCompletion = totalCompletionTokens + connCompletionTokens;
                  const combinedReasoning = totalReasoningTokens + connReasoningTokens;
                  const combinedPrompt = totalPromptTokens + connPromptTokens;
                  const liveOutputTokens = Math.max(
                    combinedCompletion + combinedReasoning,
                    Math.ceil(
                      (contentCharsTotal + reasoningCharsTotal + toolCallCharsAccumulated) / 4,
                    ),
                  );
                  const livePromptTokens =
                    combinedPrompt > 0 ? combinedPrompt : estimatedPromptTokens;

                  if (livePromptTokens + liveOutputTokens >= strictRemainingTokens) {
                    quotaCutMidStream = true;
                    sawFinishReason = true;
                    const cutChoices =
                      Array.isArray(parsed.choices) && parsed.choices.length > 0
                        ? parsed.choices.map((ch, idx) =>
                            idx === 0 && ch && typeof ch === 'object'
                              ? { ...(ch as Record<string, unknown>), finish_reason: 'length' }
                              : ch,
                          )
                        : [{ index: 0, delta: {}, finish_reason: 'length' }];

                    const cutChunk = {
                      ...parsed,
                      model: modelFullId,
                      choices: cutChoices,
                      bifrost_quota_cut: true,
                    };
                    safeEnqueue(encoder.encode(`data: ${JSON.stringify(cutChunk)}\n\n`));
                    return false;
                  }
                }

                const forwardedChunk = {
                  ...parsed,
                  model: modelFullId,
                };
                return safeEnqueue(encoder.encode(`data: ${JSON.stringify(forwardedChunk)}\n\n`));
              };

              const flushEventData = (): boolean => {
                if (eventDataLines.length === 0) return true;
                const payload = eventDataLines.join('\n');
                eventDataLines = [];
                eventDataChars = 0;
                return processEventPayload(payload);
              };

              const processRawLine = (rawLine: string): boolean => {
                if (clientAborted) return false;
                if (rawLine === '') {
                  return flushEventData();
                }
                if (rawLine.startsWith(':')) {
                  return true;
                }
                if (!rawLine.startsWith('data:')) {
                  return true;
                }

                const dataPart = rawLine.slice(5).replace(/^ /, '');
                // Handle providers that emit back-to-back `data:` lines without blank-line separators
                if (eventDataLines.length > 0) {
                  const buffered = eventDataLines.join('\n').trim();
                  if (buffered === '[DONE]' || isValidJsonText(buffered)) {
                    const keepGoing = flushEventData();
                    if (!keepGoing) return false;
                  }
                }

                if (eventDataChars + dataPart.length > MAX_SSE_LINE_BUFFER_CHARS) {
                  streamFailureReason = 'Upstream SSE event exceeded maximum allowed buffer size';
                  eventDataLines = [];
                  eventDataChars = 0;
                  return false;
                }

                eventDataLines.push(dataPart);
                eventDataChars += dataPart.length;

                if (eventDataLines.length === 1 && dataPart.trim() === '[DONE]') {
                  return flushEventData();
                }
                return true;
              };

              try {
                while (!clientAborted) {
                  const { value, done } = await readChunkWithIdleTimeout(
                    reader,
                    streamIdleTimeoutMs,
                  );
                  if (done || clientAborted) {
                    if (!clientAborted) {
                      buffer += decoder.decode();
                    }
                    break;
                  }
                  buffer += decoder.decode(value, { stream: true });

                  if (buffer.length > MAX_SSE_LINE_BUFFER_CHARS) {
                    streamFailureReason = 'Upstream SSE line exceeded maximum allowed buffer size';
                    break;
                  }

                  let newlineIdx: number;
                  while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
                    const rawLine = buffer.slice(0, newlineIdx).replace(/\r$/, '');
                    buffer = buffer.slice(newlineIdx + 1);
                    const keepGoing = processRawLine(rawLine);
                    if (!keepGoing) {
                      break;
                    }
                  }

                  if (
                    clientAborted ||
                    sawDone ||
                    quotaCutMidStream ||
                    streamFailureReason !== null
                  ) {
                    break;
                  }
                }

                if (
                  !clientAborted &&
                  !sawDone &&
                  !quotaCutMidStream &&
                  streamFailureReason === null
                ) {
                  if (buffer.trim().length > 0) {
                    for (const remainingLine of buffer.split('\n')) {
                      if (!processRawLine(remainingLine.replace(/\r$/, ''))) {
                        break;
                      }
                    }
                  }
                  if (!sawDone && !quotaCutMidStream && streamFailureReason === null) {
                    flushEventData();
                  }
                }
              } catch (err) {
                if (!clientAborted) {
                  const msg = err instanceof Error ? err.message : String(err);
                  streamFailureReason = redactWithRawSecret(
                    `Stream interrupted: ${msg}`,
                    currentRawSecret,
                  ).slice(0, 300);
                }
              } finally {
                // Merge per-connection usage once when this connection ends, applying per-segment
                // selective fallback so a resumed segment with real usage never hides output emitted
                // in an earlier segment that dropped before emitting a usage chunk.
                const segCompAndToolChars = connContentChars + connToolCallChars;
                const effectiveConnCompletion =
                  connCompletionTokens > 0
                    ? connCompletionTokens
                    : segCompAndToolChars > 0
                      ? Math.max(1, Math.ceil(segCompAndToolChars / 4))
                      : 0;
                const effectiveConnReasoning =
                  connReasoningTokens > 0
                    ? connReasoningTokens
                    : connReasoningChars > 0
                      ? Math.max(1, Math.ceil(connReasoningChars / 4))
                      : 0;

                totalPromptTokens += connPromptTokens;
                totalCompletionTokens += effectiveConnCompletion;
                totalReasoningTokens += effectiveConnReasoning;
                totalCachedTokens += connCachedTokens;

                if (activeReader === reader) {
                  activeReader = null;
                }
                try {
                  await reader.cancel();
                } catch {
                  // Ignore reader cancel errors
                }
                try {
                  reader.releaseLock();
                } catch {
                  // Ignore releaseLock errors
                }
                releaseCurrent();
                activeConn = null;
              }

              if (clientAborted) {
                const abortEndMs = now();
                const abortSec = Math.floor(abortEndMs / 1000);
                const resolvedAborted = applySelectiveTokenFallbacks({
                  promptTokens: totalPromptTokens,
                  completionTokens: totalCompletionTokens,
                  reasoningTokens: totalReasoningTokens,
                  cachedTokens: totalCachedTokens,
                  estimatedPromptTokens,
                  contentChars: contentCharsTotal,
                  reasoningChars: reasoningCharsTotal,
                  toolCallChars: toolCallCharsAccumulated,
                  wasHttp200: true,
                });

                safeRecordUsageLog(db, {
                  userId,
                  providerId,
                  providerKeyId: currentKey.id,
                  internalApiKeyId,
                  modelFullId,
                  promptTokens: resolvedAborted.promptTokens,
                  completionTokens: resolvedAborted.completionTokens,
                  reasoningTokens: resolvedAborted.reasoningTokens,
                  cachedTokens: resolvedAborted.cachedTokens,
                  ttftMs,
                  durationMs: Math.max(1, abortEndMs - startMs),
                  status: 'error',
                  errorType: 'client_aborted',
                  createdAt: abortSec,
                });
                break;
              }

              const completedCleanly =
                streamFailureReason === null && (sawDone || sawFinishReason || quotaCutMidStream);

              if (completedCleanly) {
                const endMs = now();
                const endSec = Math.floor(endMs / 1000);
                safeUpdateKeyHealthy(db, currentKey.id, currentRes.headers, endSec, manifest.rateLimitKind);

                const resolvedFinal = applySelectiveTokenFallbacks({
                  promptTokens: totalPromptTokens,
                  completionTokens: totalCompletionTokens,
                  reasoningTokens: totalReasoningTokens,
                  cachedTokens: totalCachedTokens,
                  estimatedPromptTokens,
                  contentChars: contentCharsTotal,
                  reasoningChars: reasoningCharsTotal,
                  toolCallChars: toolCallCharsAccumulated,
                  wasHttp200: true,
                });

                if (resolvedFinal.zeroUsageWarn) {
                  safeWriteSystemLog(
                    db,
                    'warn',
                    'system',
                    `Upstream HTTP 200 SSE stream on "${modelFullId}" (${providerId}) returned zero usage and empty output; charging fallback prompt tokens (${resolvedFinal.promptTokens}).`,
                    {
                      providerId,
                      modelFullId,
                      keyId: currentKey.id,
                      fallbackPromptTokens: resolvedFinal.promptTokens,
                    },
                    endSec,
                  );
                }

                let streamContractError: 'tool_error' | 'structured_error' | null = null;
                if (toolCallsAccumulated.size > 0) {
                  for (const tc of toolCallsAccumulated.values()) {
                    if (!tc.name.trim() || !isValidJsonText(tc.args)) {
                      streamContractError = 'tool_error';
                      break;
                    }
                  }
                } else if (contractFlags.requiresToolCall) {
                  streamContractError = 'tool_error';
                }

                if (
                  streamContractError === null &&
                  contractFlags.usesStructuredOutput &&
                  toolCallsAccumulated.size === 0 &&
                  !isValidJsonText(contentAccumulated)
                ) {
                  streamContractError = 'structured_error';
                }

                safeEnqueue(encoder.encode('data: [DONE]\n\n'));

                safeRecordUsageLog(db, {
                  userId,
                  providerId,
                  providerKeyId: currentKey.id,
                  internalApiKeyId,
                  modelFullId,
                  promptTokens: resolvedFinal.promptTokens,
                  completionTokens: resolvedFinal.completionTokens,
                  reasoningTokens: resolvedFinal.reasoningTokens,
                  cachedTokens: resolvedFinal.cachedTokens,
                  ttftMs,
                  durationMs: Math.max(1, endMs - startMs),
                  status: streamContractError ? 'error' : wasResumed ? 'resumed' : 'ok',
                  errorType: streamContractError,
                  createdAt: endSec,
                });

                break;
              }

              const dropReason =
                streamFailureReason ?? 'Premature EOF before [DONE] on SSE stream';
              const dropSec = Math.floor(now() / 1000);
              safeMarkKeyFailure(
                db,
                currentKey.id,
                null,
                dropReason,
                null,
                dropSec,
                manifest.rateLimitKind,
                currentRawSecret,
              );

              // DEEP-09: Never restart from scratch or resume when partial tool_calls or reasoning-only
              // chunks were already streamed (prevents duplicate index: 0 tool calls / duplicated reasoning).
              const hasPartialToolCalls = toolCallsAccumulated.size > 0;
              const hasReasoningWithoutContent =
                reasoningCharsTotal > 0 && contentCharsTotal === 0;
              const isMidStreamContinuation = contentCharsTotal > 0;

              let nextConn: ActiveStreamConnection | null = null;
              if (!hasPartialToolCalls && !hasReasoningWithoutContent) {
                let continuationMaxOutput: number | null = effectiveInitialMaxOutput;
                let canContinueWithinBudget = true;

                if (isMidStreamContinuation && effectiveInitialMaxOutput !== null) {
                  const emittedOutputTokens = Math.max(
                    totalCompletionTokens + totalReasoningTokens,
                    Math.ceil(
                      (contentCharsTotal + reasoningCharsTotal + toolCallCharsAccumulated) / 4,
                    ),
                  );
                  const remainingCap = effectiveInitialMaxOutput - emittedOutputTokens;
                  if (remainingCap <= 0) {
                    canContinueWithinBudget = false;
                  } else {
                    continuationMaxOutput = remainingCap;
                  }
                }

                if (canContinueWithinBudget) {
                  const continuationMessages = isMidStreamContinuation
                    ? [
                        ...originalMessages,
                        { role: 'assistant', content: contentAccumulated },
                        {
                          role: 'user',
                          content:
                            'Continue seamlessly from the exact character where your previous message was cut off. Output ONLY the remaining continuation text without repeating anything already written.',
                        },
                      ]
                    : originalMessages;

                  nextConn = await openStreamWithNextKey(
                    continuationMessages,
                    isMidStreamContinuation ? 'stream_resume' : 'failover',
                    continuationMaxOutput,
                  );
                }
              }

              if (nextConn) {
                if (isMidStreamContinuation) {
                  wasResumed = true;
                  safeWriteSystemLog(
                    db,
                    'warn',
                    'stream_resume',
                    `SSE stream interrupted after ${contentCharsTotal} chars on key "${currentKey.label}" (…${currentKey.last4}); resuming transparently with key "${nextConn.key.label}" (…${nextConn.key.last4})`,
                    {
                      providerId,
                      modelFullId,
                      failedKeyId: currentKey.id,
                      failedKeyLast4: currentKey.last4,
                      resumedKeyId: nextConn.key.id,
                      resumedKeyLast4: nextConn.key.last4,
                      charsAccumulated: contentCharsTotal,
                      reason: dropReason,
                    },
                    Math.floor(now() / 1000),
                  );
                } else {
                  safeWriteSystemLog(
                    db,
                    'warn',
                    'failover',
                    `SSE stream failed before first token on key "${currentKey.label}" (…${currentKey.last4}); failing over to key "${nextConn.key.label}" (…${nextConn.key.last4})`,
                    {
                      providerId,
                      modelFullId,
                      failedKeyId: currentKey.id,
                      nextKeyId: nextConn.key.id,
                      reason: dropReason,
                    },
                    Math.floor(now() / 1000),
                  );
                }
                activeConn = nextConn;
                continue;
              }

              const errEndMs = now();
              const errSec = Math.floor(errEndMs / 1000);
              const abortLogDetail = hasPartialToolCalls
                ? 'partial tool_calls already emitted (cannot safely resume without duplication)'
                : hasReasoningWithoutContent
                  ? 'partial reasoning already emitted without content (cannot safely restart)'
                  : 'no healthy backup key remaining';
              safeWriteSystemLog(
                db,
                'error',
                isMidStreamContinuation || hasPartialToolCalls || hasReasoningWithoutContent
                  ? 'stream_resume'
                  : 'failover',
                `SSE stream aborted on provider "${providerId}" (${abortLogDetail}): ${dropReason}`,
                {
                  providerId,
                  modelFullId,
                  failedKeyId: currentKey.id,
                  charsAccumulated: contentCharsTotal,
                  hasPartialToolCalls,
                  hasReasoningWithoutContent,
                },
                errSec,
              );

              const hasAnyPartialOutput =
                contentCharsTotal > 0 || reasoningCharsTotal > 0 || toolCallCharsAccumulated > 0;
              const resolvedErr = applySelectiveTokenFallbacks({
                promptTokens: totalPromptTokens,
                completionTokens: totalCompletionTokens,
                reasoningTokens: totalReasoningTokens,
                cachedTokens: totalCachedTokens,
                estimatedPromptTokens: hasAnyPartialOutput ? estimatedPromptTokens : 0,
                contentChars: contentCharsTotal,
                reasoningChars: reasoningCharsTotal,
                toolCallChars: toolCallCharsAccumulated,
                wasHttp200: false,
              });

              safeRecordUsageLog(db, {
                userId,
                providerId,
                providerKeyId: lastKeyUsedId,
                internalApiKeyId,
                modelFullId,
                promptTokens: resolvedErr.promptTokens,
                completionTokens: resolvedErr.completionTokens,
                reasoningTokens: resolvedErr.reasoningTokens,
                cachedTokens: resolvedErr.cachedTokens,
                ttftMs,
                durationMs: Math.max(1, errEndMs - startMs),
                status: 'error',
                errorType: classifyFailureErrorType('network', contractFlags),
                createdAt: errSec,
              });

              const errFrame = {
                error: {
                  message: hasPartialToolCalls
                    ? 'Upstream stream interrupted during tool call emission.'
                    : 'Upstream stream interrupted and no backup key is available.',
                  type: 'server_error',
                  code: 'stream_interrupted',
                },
              };
              safeEnqueue(encoder.encode(`data: ${JSON.stringify(errFrame)}\n\n`));
              safeEnqueue(encoder.encode('data: [DONE]\n\n'));
              break;
            }
          } catch (err) {
            // CRIT-02: Never let an unhandled rejection escape this background SSE IIFE in Node 24
            const rawErrMsg = err instanceof Error ? err.message : String(err);
            const safeErrMsg = redactWithRawSecret(rawErrMsg, lastRawSecret).slice(0, 300);
            safeWriteSystemLog(
              db,
              'error',
              'system',
              `Unexpected SSE stream error on "${modelFullId}" (${providerId}): ${safeErrMsg}`,
              { providerId, modelFullId, keyId: lastKeyUsedId },
              Math.floor(now() / 1000),
            );
            if (!clientAborted) {
              const errFrame = {
                error: {
                  message: 'Internal streaming error while reading upstream response.',
                  type: 'server_error',
                  code: 'stream_internal_error',
                },
              };
              safeEnqueue(encoder.encode(`data: ${JSON.stringify(errFrame)}\n\n`));
              safeEnqueue(encoder.encode('data: [DONE]\n\n'));
            }
          } finally {
            if (clientSignal) {
              clientSignal.removeEventListener('abort', onClientSignalAbort);
            }
            if (activeConn !== null) {
              const bodyToCancel = activeConn.response.body;
              if (bodyToCancel && !bodyToCancel.locked) {
                void bodyToCancel.cancel().catch(() => {
                  // Ignore body cancel errors
                });
              }
              activeConn.releaseLease();
              activeConn = null;
            }
            releaseQuotaReservation();
            safeClose();
          }
        })();
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  } finally {
    if (!reservationTransferredToStream) {
      releaseQuotaReservation();
    }
  }
}

export async function executeEmbeddings(options: {
  db: DatabaseSync;
  masterKey: Buffer;
  registry: DrainingRegistry;
  fetchImpl: typeof fetch;
  allowLocalhost?: boolean;
  dnsLookup?: DnsLookupFn;
  upstreamTls?: UpstreamTlsOptions;
  now: () => number;
  userId: string;
  internalApiKeyId?: string | null;
  modelFullId: string;
  modelId: string;
  providerRow: Record<string, unknown>;
  requestBody: Record<string, unknown>;
  signal?: AbortSignal;
  headersTimeoutMs?: number;
}): Promise<Response> {
  const {
    db,
    masterKey,
    registry,
    fetchImpl,
    allowLocalhost,
    dnsLookup,
    upstreamTls,
    now,
    userId,
    internalApiKeyId = null,
    modelFullId,
    modelId,
    providerRow,
    requestBody,
    signal: clientSignal,
    headersTimeoutMs = DEFAULT_UPSTREAM_HEADERS_TIMEOUT_MS,
  } = options;

  const startMs = now();
  const nowSec = Math.floor(startMs / 1000);

  const quotaCheck = checkUserDailyQuotaUtc(db, userId, startMs);
  if (quotaCheck.exceeded) {
    return quotaCheck.response;
  }

  const providerId = String(providerRow.id);
  if (registry.isProviderDraining(providerId)) {
    return openAiErrorJson(
      `Provider "${providerId}" is currently being removed.`,
      'service_unavailable',
      'provider_unavailable',
      503,
    );
  }

  const manifest = JSON.parse(String(providerRow.schema_json)) as ProviderManifest;
  const upstreamMode =
    providerRow.package_type === 'experimental-adapter'
      ? ('experimental-adapter' as const)
      : ('official-json' as const);
  const effectiveAllowLocalhost =
    allowLocalhost !== undefined ? allowLocalhost : allowLocalOfficialUpstreams();
  const effectiveBaseUrl =
    providerRow.package_type === 'experimental-adapter' &&
    typeof providerRow.adapter_url === 'string' &&
    providerRow.adapter_url.length > 0
      ? providerRow.adapter_url
      : manifest.baseUrl;

  const rawEmbeddingsUrl = `${effectiveBaseUrl.replace(/\/+$/, '')}/embeddings`;
  let embeddingsUrl: string;
  try {
    embeddingsUrl = assertSafeUpstreamUrlSync(rawEmbeddingsUrl, {
      mode: upstreamMode,
      allowLocalhost: effectiveAllowLocalhost,
    });
  } catch (err) {
    return openAiErrorJson(
      err instanceof Error ? err.message : 'Upstream URL blocked by SSRF policy.',
      'invalid_request_error',
      'ssrf_blocked',
      400,
    );
  }

  const candidates = loadCandidateKeys(db, providerId, registry, nowSec);
  if (candidates.length === 0) {
    safeWriteSystemLog(
      db,
      'warn',
      'system',
      `Embeddings routing failed for "${modelFullId}": provider "${providerId}" has no active API keys with an online exit node available.`,
      { providerId, modelFullId, userId },
      nowSec,
    );
    return openAiErrorJson(
      `Provider "${providerId}" has no active API keys with an online exit node available.`,
      'service_unavailable',
      'no_provider_keys',
      503,
    );
  }

  const estimatedInputTokens = estimateEmbeddingsInputTokens(requestBody.input);
  let releaseQuotaReservation: () => void = () => {};

  if (
    quotaCheck.dailyTokenLimit !== null &&
    quotaCheck.enforceStrictQuota === true &&
    quotaCheck.remainingTokens !== null
  ) {
    const alreadyReserved = getInFlightReservedTokens(userId);
    const effectiveRemaining = Math.max(0, quotaCheck.remainingTokens - alreadyReserved);
    if (effectiveRemaining <= 0 || estimatedInputTokens > effectiveRemaining) {
      const resetAtIso = quotaCheck.resetAtIso ?? new Date(startMs + 86400_000).toISOString();
      const parsedResetMs = Date.parse(resetAtIso);
      const retryAfterSec = Number.isFinite(parsedResetMs)
        ? Math.max(1, Math.ceil((parsedResetMs - startMs) / 1000))
        : 60;
      return buildQuotaExceededResponse(
        quotaCheck.usedTokens + alreadyReserved,
        quotaCheck.dailyTokenLimit,
        resetAtIso,
        retryAfterSec,
      );
    }
    releaseQuotaReservation = reserveInFlightTokens(
      userId,
      Math.max(1, Math.min(effectiveRemaining, estimatedInputTokens)),
    );
  }

  try {
    const extractSafeUpstreamErrorMessage = async (
      res: Response,
      rawSecret?: string | null,
    ): Promise<string> => {
      const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
      const rawBody = await res.text().catch(() => '');
      if (contentType.includes('application/json') && rawBody.trim().length > 0) {
        try {
          const parsed = JSON.parse(rawBody) as Record<string, unknown>;
          const errField = parsed.error;
          const candidate =
            errField && typeof errField === 'object' && !Array.isArray(errField)
              ? (errField as Record<string, unknown>).message
              : typeof errField === 'string'
                ? errField
                : parsed.message;
          if (typeof candidate === 'string' && candidate.trim().length > 0) {
            return redactWithRawSecret(candidate.trim(), rawSecret).slice(0, 300);
          }
        } catch {
          // Ignore malformed JSON body
        }
      }
      return `Upstream provider returned HTTP ${res.status}.`;
    };

    const dispatchRequestForKey = async (
      key: ProviderKeyRecord,
      init: RequestInit,
    ): Promise<Response> => {
      const combinedSignal = buildUpstreamSignal(clientSignal, headersTimeoutMs);
      const initWithSignal: RequestInit = {
        ...init,
        signal: combinedSignal,
      };
      if (key.node_id) {
        if (!key.node_encrypted_token || !key.node_endpoint) {
          throw new Error(`Assigned exit node "${key.node_id}" is missing tunnel credentials`);
        }
        const nodeRawToken = decryptSecret(key.node_encrypted_token, masterKey);
        return fetchViaExitNode(
          embeddingsUrl,
          initWithSignal,
          {
            id: key.node_id,
            name: key.node_name ?? key.node_id,
            mode: key.node_mode === 'public_ip' ? 'public_ip' : 'tailscale',
            endpoint: key.node_endpoint,
            rawToken: nodeRawToken,
            tlsFingerprint: key.node_tls_fingerprint,
          },
          upstreamTls,
        );
      }
      return safeFetch(
        embeddingsUrl,
        { ...initWithSignal, redirect: 'error' },
        {
          mode: upstreamMode,
          allowLocalhost: effectiveAllowLocalhost,
          fetchImpl,
          dnsLookup,
          upstreamTls,
        },
      );
    };

    const triedKeyIds = new Set<string>();
    let lastStatus: number | null = null;
    let lastErrorMsg = 'Upstream provider request failed.';
    let lastKeyId: string | null = null;
    let lastWasNetwork = false;

    for (let i = 0; i < candidates.length; i++) {
      const key = candidates[i]!;
      if (registry.isKeyDraining(key.id) || triedKeyIds.has(key.id)) {
        continue;
      }
      triedKeyIds.add(key.id);
      lastKeyId = key.id;

      const releaseLease = registry.acquireLease(providerId, key.id);
      try {
        const rawSecret = decryptSecret(key.encrypted_secret, masterKey);
        const headers = mergeHeadersCaseInsensitive(
          buildProviderAuthHeaders(manifest.auth, rawSecret),
          { 'Content-Type': 'application/json' },
        );
        const upstreamBody: Record<string, unknown> = {
          ...requestBody,
          model: modelId,
        };

        let res: Response;
        try {
          res = await dispatchRequestForKey(key, {
            method: 'POST',
            headers,
            body: JSON.stringify(upstreamBody),
          });
        } catch (err) {
          if (err instanceof UpstreamSsrfError) {
            return openAiErrorJson(
              redactWithRawSecret(err.message, rawSecret),
              'invalid_request_error',
              'ssrf_blocked',
              400,
            );
          }
          if (clientSignal?.aborted) {
            return openAiErrorJson(
              'Client closed the request before upstream completed.',
              'invalid_request_error',
              'client_aborted',
              499,
            );
          }
          const msg = err instanceof Error ? err.message : String(err);
          lastStatus = null;
          lastWasNetwork = true;
          lastErrorMsg = redactWithRawSecret(`Network/tunnel error: ${msg}`, rawSecret).slice(
            0,
            300,
          );
          safeMarkKeyFailure(
            db,
            key.id,
            null,
            lastErrorMsg,
            null,
            Math.floor(now() / 1000),
            manifest.rateLimitKind,
            rawSecret,
          );

          const nextKey = candidates.slice(i + 1).find((k) => !registry.isKeyDraining(k.id));
          if (nextKey) {
            safeWriteSystemLog(
              db,
              'warn',
              'failover',
              `Key "${key.label}" (…${key.last4}) failed with network/tunnel error on "${providerId}" embeddings; failing over to "${nextKey.label}" (…${nextKey.last4})`,
              {
                providerId,
                failedKeyId: key.id,
                failedKeyLast4: key.last4,
                nodeId: key.node_id,
                nextKeyId: nextKey.id,
                reason: lastErrorMsg,
              },
              Math.floor(now() / 1000),
            );
            continue;
          }
          break;
        }

        if (isRetryableKeyFailureStatus(res.status)) {
          lastStatus = res.status;
          lastWasNetwork = false;
          const safeErr = await extractSafeUpstreamErrorMessage(res, rawSecret);
          lastErrorMsg = redactWithRawSecret(`HTTP ${res.status}: ${safeErr}`, rawSecret).slice(
            0,
            180,
          );
          safeMarkKeyFailure(
            db,
            key.id,
            res.status,
            lastErrorMsg,
            res.headers,
            Math.floor(now() / 1000),
            manifest.rateLimitKind,
            rawSecret,
          );

          const nextKey = candidates.slice(i + 1).find((k) => !registry.isKeyDraining(k.id));
          if (nextKey) {
            safeWriteSystemLog(
              db,
              'warn',
              'failover',
              `Key "${key.label}" (…${key.last4}) returned HTTP ${res.status} on "${providerId}" embeddings; failing over to "${nextKey.label}" (…${nextKey.last4})`,
              {
                providerId,
                failedKeyId: key.id,
                failedKeyLast4: key.last4,
                nodeId: key.node_id,
                nextKeyId: nextKey.id,
                httpStatus: res.status,
              },
              Math.floor(now() / 1000),
            );
            continue;
          }
          break;
        }

        if (!res.ok) {
          const safeErr = await extractSafeUpstreamErrorMessage(res, rawSecret);
          const endMs = now();
          const endSec = Math.floor(endMs / 1000);
          safeWriteSystemLog(
            db,
            'error',
            'system',
            `Upstream HTTP ${res.status} on "${modelFullId}" embeddings (${providerId}): ${safeErr}`,
            { providerId, modelFullId, keyId: key.id, httpStatus: res.status },
            endSec,
          );
          safeRecordUsageLog(db, {
            userId,
            providerId,
            providerKeyId: key.id,
            internalApiKeyId,
            modelFullId,
            promptTokens: 0,
            completionTokens: 0,
            reasoningTokens: 0,
            cachedTokens: 0,
            ttftMs: null,
            durationMs: Math.max(1, endMs - startMs),
            status: 'error',
            errorType: 'upstream',
            createdAt: endSec,
          });
          return openAiErrorJson(safeErr, 'invalid_request_error', 'upstream_error', res.status);
        }

        const ttftMs = Math.max(1, now() - startMs);
        let data: Record<string, unknown>;
        try {
          data = (await res.json()) as Record<string, unknown>;
        } catch {
          const endMs = now();
          const endSec = Math.floor(endMs / 1000);
          safeWriteSystemLog(
            db,
            'error',
            'system',
            `Upstream provider "${providerId}" returned malformed JSON on "${modelFullId}" embeddings`,
            { providerId, modelFullId, keyId: key.id },
            endSec,
          );
          safeRecordUsageLog(db, {
            userId,
            providerId,
            providerKeyId: key.id,
            internalApiKeyId,
            modelFullId,
            promptTokens: 0,
            completionTokens: 0,
            reasoningTokens: 0,
            cachedTokens: 0,
            ttftMs,
            durationMs: Math.max(1, endMs - startMs),
            status: 'error',
            errorType: 'upstream',
            createdAt: endSec,
          });
          return openAiErrorJson(
            'Upstream provider returned malformed JSON response.',
            'server_error',
            'malformed_upstream_json',
            502,
          );
        }
        const endMs = now();
        const durationMs = Math.max(1, endMs - startMs);
        const endSec = Math.floor(endMs / 1000);

        safeUpdateKeyHealthy(db, key.id, res.headers, endSec, manifest.rateLimitKind);

        const usage =
          data.usage && typeof data.usage === 'object'
            ? (data.usage as Record<string, unknown>)
            : {};
        const rawPrompt = toSafeNonNegInt(usage.prompt_tokens ?? usage.total_tokens);
        const promptTokens = rawPrompt > 0 ? rawPrompt : estimatedInputTokens;

        safeRecordUsageLog(db, {
          userId,
          providerId,
          providerKeyId: key.id,
          internalApiKeyId,
          modelFullId,
          promptTokens,
          completionTokens: 0,
          reasoningTokens: 0,
          cachedTokens: 0,
          ttftMs,
          durationMs,
          status: 'ok',
          errorType: null,
          createdAt: endSec,
        });

        const responsePayload = {
          ...data,
          model: modelFullId,
        };

        return new Response(JSON.stringify(responsePayload), {
          status: 200,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'X-Bifrost-TTFT-Ms': String(ttftMs),
          },
        });
      } finally {
        releaseLease();
      }
    }

    const failEndMs = now();
    const failSec = Math.floor(failEndMs / 1000);
    safeWriteSystemLog(
      db,
      'error',
      'failover',
      `All candidate keys exhausted for provider "${providerId}" embeddings: ${lastErrorMsg}`,
      { providerId, triedKeysCount: triedKeyIds.size, lastStatus },
      failSec,
    );

    const baseFailType =
      lastStatus === 429 ? 'rate_limit' : lastWasNetwork ? 'network' : 'upstream';

    safeRecordUsageLog(db, {
      userId,
      providerId,
      providerKeyId: lastKeyId,
      internalApiKeyId,
      modelFullId,
      promptTokens: 0,
      completionTokens: 0,
      reasoningTokens: 0,
      cachedTokens: 0,
      ttftMs: null,
      durationMs: Math.max(1, failEndMs - startMs),
      status: 'error',
      errorType: baseFailType,
      createdAt: failSec,
    });

    return openAiErrorJson(
      `All configured keys for provider "${providerId}" failed (${lastErrorMsg}).`,
      lastStatus === 429 ? 'rate_limit_error' : 'service_unavailable',
      lastStatus === 429 ? 'upstream_rate_limited' : 'upstream_unavailable',
      lastStatus === 429 ? 429 : 502,
    );
  } finally {
    releaseQuotaReservation();
  }
}

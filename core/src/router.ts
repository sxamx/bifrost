import type { DatabaseSync } from 'node:sqlite';
import { decryptSecret } from './crypto.js';
import { redactSecretsInText, writeSystemLog } from './db.js';
import {
  type NodeMode,
  type UpstreamTlsOptions,
  fetchViaExitNode,
} from './nodes.js';
import { type ProviderManifest, buildProviderAuthHeaders } from './schema.js';

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

      const nextKeyCount = Math.max(0, (this.keyInFlight.get(keyId) ?? 1) - 1);
      if (nextKeyCount === 0) {
        this.keyInFlight.delete(keyId);
        const keyFinalizer = this.keyFinalizers.get(keyId);
        if (keyFinalizer) {
          this.keyFinalizers.delete(keyId);
          this.drainingKeys.delete(keyId);
          keyFinalizer();
        }
      } else {
        this.keyInFlight.set(keyId, nextKeyCount);
      }

      const nextProvCount = Math.max(0, (this.providerInFlight.get(providerId) ?? 1) - 1);
      if (nextProvCount === 0) {
        this.providerInFlight.delete(providerId);
        const provFinalizer = this.providerFinalizers.get(providerId);
        if (provFinalizer) {
          this.providerFinalizers.delete(providerId);
          this.drainingProviders.delete(providerId);
          provFinalizer();
        }
      } else {
        this.providerInFlight.set(providerId, nextProvCount);
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

function parseRateLimitHeaders(
  headers: Headers,
  nowSec: number,
): { remaining: number | null; resetAt: number | null } {
  const rawRemaining =
    headers.get('x-ratelimit-remaining') ??
    headers.get('x-ratelimit-remaining-requests') ??
    headers.get('x-ratelimit-remaining-tokens');

  let remaining: number | null = null;
  if (rawRemaining !== null && rawRemaining.trim() !== '') {
    const parsed = Number(rawRemaining.trim());
    if (Number.isFinite(parsed) && parsed >= 0) {
      remaining = Math.floor(parsed);
    }
  }

  const rawReset =
    headers.get('x-ratelimit-reset') ??
    headers.get('x-ratelimit-reset-requests') ??
    headers.get('retry-after');

  let resetAt: number | null = null;
  if (rawReset !== null && rawReset.trim() !== '') {
    const parsed = Number(rawReset.trim());
    if (Number.isFinite(parsed) && parsed > 0) {
      if (parsed > 1_000_000_000_000) {
        resetAt = Math.floor(parsed / 1000);
      } else if (parsed > 1_000_000_000) {
        resetAt = Math.floor(parsed);
      } else {
        resetAt = nowSec + Math.ceil(parsed);
      }
    }
  }

  return { remaining, resetAt };
}

function updateKeyHealthy(
  db: DatabaseSync,
  keyId: string,
  headers: Headers,
  nowSec: number,
): void {
  const { remaining, resetAt } = parseRateLimitHeaders(headers, nowSec);
  db.prepare(
    `UPDATE provider_keys
     SET status = 'active',
         last_error = NULL,
         ratelimit_remaining = COALESCE(?, ratelimit_remaining),
         ratelimit_reset_at = COALESCE(?, ratelimit_reset_at)
     WHERE id = ?`,
  ).run(remaining, resetAt, keyId);
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

  const parsed = headers
    ? parseRateLimitHeaders(headers, nowSec)
    : { remaining: null, resetAt: null };
  const resetDeltaSec =
    parsed.resetAt !== null ? Math.max(0, parsed.resetAt - nowSec) : null;

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

function markKeyFailure(
  db: DatabaseSync,
  keyId: string,
  httpStatus: number | null,
  reason: string,
  headers: Headers | null,
  nowSec: number,
): void {
  const safeReason = redactSecretsInText(reason).slice(0, 300);
  const isTransientFailure =
    httpStatus === 429 ||
    httpStatus === null ||
    (httpStatus >= 500 && httpStatus <= 599);

  if (isTransientFailure) {
    if (httpStatus === 429) {
      recordRateLimitEvent(db, keyId, headers, nowSec);
    }
    const parsed = headers
      ? parseRateLimitHeaders(headers, nowSec)
      : { remaining: 0, resetAt: null };
    const resetAt = parsed.resetAt ?? nowSec + 60;
    db.prepare(
      `UPDATE provider_keys
       SET status = 'rate_limited',
           ratelimit_remaining = 0,
           ratelimit_reset_at = ?,
           last_error = ?
       WHERE id = ?`,
    ).run(resetAt, safeReason, keyId);
  } else {
    db.prepare(
      `UPDATE provider_keys
       SET status = 'error',
           last_error = ?
       WHERE id = ?`,
    ).run(safeReason, keyId);
  }
}

function recordUsageLog(
  db: DatabaseSync,
  entry: {
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
  },
): void {
  const outputTokens =
    entry.completionTokens > 0 ? entry.completionTokens : entry.reasoningTokens;
  const tokensPerSec =
    entry.durationMs > 0 && outputTokens > 0
      ? Number(((outputTokens * 1000) / entry.durationMs).toFixed(2))
      : null;

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
    entry.promptTokens,
    entry.completionTokens,
    entry.reasoningTokens,
    entry.cachedTokens,
    entry.ttftMs,
    Math.max(1, Math.round(entry.durationMs)),
    tokensPerSec,
    entry.status,
    entry.errorType,
    entry.createdAt,
  );
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
  const message = `Daily token quota exceeded (${usedTokens}/${dailyTokenLimit} tokens used). Quota resets at ${resetAtIso}.`;

  const response = new Response(
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
        'Retry-After': String(retryAfterSec),
      },
    },
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
  // Recover rate-limited keys whose reset timestamp has passed (only if node is not unresponsive)
  db.prepare(
    `UPDATE provider_keys
     SET status = 'active', last_error = NULL
     WHERE provider_id = ?
       AND status = 'rate_limited'
       AND ratelimit_reset_at IS NOT NULL
       AND ratelimit_reset_at <= ?`,
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
  upstreamTls?: UpstreamTlsOptions;
  now: () => number;
  userId: string;
  internalApiKeyId?: string | null;
  modelFullId: string;
  modelId: string;
  providerRow: Record<string, unknown>;
  requestBody: Record<string, unknown>;
}): Promise<Response> {
  const {
    db,
    masterKey,
    registry,
    fetchImpl,
    upstreamTls,
    now,
    userId,
    internalApiKeyId = null,
    modelFullId,
    modelId,
    providerRow,
    requestBody,
  } = options;

  const startMs = now();
  const nowSec = Math.floor(startMs / 1000);

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

  const contractFlags = detectRequestContractFlags(requestBody);

  const manifest = JSON.parse(String(providerRow.schema_json)) as ProviderManifest;
  const effectiveBaseUrl =
    providerRow.package_type === 'experimental-adapter' &&
    typeof providerRow.adapter_url === 'string' &&
    providerRow.adapter_url.length > 0
      ? providerRow.adapter_url
      : manifest.baseUrl;

  const chatUrl = `${effectiveBaseUrl.replace(/\/+$/, '')}/chat/completions`;

  const candidates = loadCandidateKeys(db, providerId, registry, nowSec);
  if (candidates.length === 0) {
    writeSystemLog(
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

  const extractSafeUpstreamErrorMessage = async (res: Response): Promise<string> => {
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
          return redactSecretsInText(candidate.trim().slice(0, 300));
        }
      } catch {
        // Ignore malformed JSON body and return generic HTTP status message
      }
    }
    return `Upstream provider returned HTTP ${res.status}.`;
  };

  const dispatchRequestForKey = async (
    key: ProviderKeyRecord,
    init: RequestInit,
  ): Promise<Response> => {
    if (key.node_id) {
      if (!key.node_encrypted_token || !key.node_endpoint) {
        throw new Error(`Assigned exit node "${key.node_id}" is missing tunnel credentials`);
      }
      const nodeRawToken = decryptSecret(key.node_encrypted_token, masterKey);
      return fetchViaExitNode(
        chatUrl,
        init,
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
    return fetchImpl(chatUrl, { ...init, redirect: 'error' });
  };

  const isStream = requestBody.stream === true;
  const originalMessages = Array.isArray(requestBody.messages)
    ? (requestBody.messages as Array<Record<string, unknown>>)
    : [];

  const strictRemainingTokens =
    quotaCheck.enforceStrictQuota && quotaCheck.remainingTokens !== null
      ? quotaCheck.remainingTokens
      : null;
  const estimatedPromptTokens = estimateMessagesPromptTokens(originalMessages);
  const strictMaxOutputTokens =
    strictRemainingTokens !== null
      ? Math.max(1, strictRemainingTokens - estimatedPromptTokens)
      : null;

  const applyStrictMaxTokens = (body: Record<string, unknown>): Record<string, unknown> => {
    if (strictMaxOutputTokens === null) return body;
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
      out.max_completion_tokens = Math.min(existingMaxComp, strictMaxOutputTokens);
    } else {
      out.max_tokens =
        existingMax !== null
          ? Math.min(existingMax, strictMaxOutputTokens)
          : strictMaxOutputTokens;
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
        const headers: Record<string, string> = {
          ...buildProviderAuthHeaders(manifest.auth, rawSecret),
          'Content-Type': 'application/json',
        };
        const upstreamBody = applyStrictMaxTokens({
          ...requestBody,
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
          const msg = err instanceof Error ? err.message : String(err);
          lastStatus = null;
          lastWasNetwork = true;
          lastErrorMsg = redactSecretsInText(`Network/tunnel error: ${msg}`);
          markKeyFailure(db, key.id, null, lastErrorMsg, null, Math.floor(now() / 1000));

          const nextKey = candidates.slice(i + 1).find((k) => !registry.isKeyDraining(k.id));
          if (nextKey) {
            writeSystemLog(
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
          const safeErr = await extractSafeUpstreamErrorMessage(res);
          lastErrorMsg = redactSecretsInText(`HTTP ${res.status}: ${safeErr.slice(0, 160)}`);
          markKeyFailure(
            db,
            key.id,
            res.status,
            lastErrorMsg,
            res.headers,
            Math.floor(now() / 1000),
          );

          const nextKey = candidates.slice(i + 1).find((k) => !registry.isKeyDraining(k.id));
          if (nextKey) {
            writeSystemLog(
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
          const safeErr = await extractSafeUpstreamErrorMessage(res);
          const endMs = now();
          const endSec = Math.floor(endMs / 1000);
          writeSystemLog(
            db,
            'error',
            'system',
            `Upstream HTTP ${res.status} on "${modelFullId}" (${providerId}): ${safeErr}`,
            { providerId, modelFullId, keyId: key.id, httpStatus: res.status },
            endSec,
          );
          recordUsageLog(db, {
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
          writeSystemLog(
            db,
            'error',
            'system',
            `Upstream provider "${providerId}" returned malformed JSON on "${modelFullId}"`,
            { providerId, modelFullId, keyId: key.id },
            endSec,
          );
          recordUsageLog(db, {
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

        updateKeyHealthy(db, key.id, res.headers, endSec);

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

        let promptTokens = Number(usage.prompt_tokens ?? 0);
        if ((!Number.isFinite(promptTokens) || promptTokens <= 0) && estimatedPromptTokens > 0) {
          promptTokens = estimatedPromptTokens;
        }
        const completionTokens = Number(usage.completion_tokens ?? 0);
        const reasoningTokens = Number(
          compDetails.reasoning_tokens ?? usage.reasoning_tokens ?? 0,
        );
        const cachedTokens = Number(promptDetails.cached_tokens ?? usage.cached_tokens ?? 0);

        const contractError = classifyPayloadContractError(data, contractFlags);

        recordUsageLog(db, {
          userId,
          providerId,
          providerKeyId: key.id,
          internalApiKeyId,
          modelFullId,
          promptTokens,
          completionTokens,
          reasoningTokens,
          cachedTokens,
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

        const outTokens = completionTokens > 0 ? completionTokens : reasoningTokens;
        const tps =
          durationMs > 0 && outTokens > 0
            ? Number(((outTokens * 1000) / durationMs).toFixed(2))
            : null;
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
    writeSystemLog(
      db,
      'error',
      'failover',
      `All candidate keys exhausted for provider "${providerId}": ${lastErrorMsg}`,
      { providerId, triedKeysCount: triedKeyIds.size, lastStatus },
      failSec,
    );

    const baseFailType =
      lastStatus === 429 ? 'rate_limit' : lastWasNetwork ? 'network' : 'upstream';

    recordUsageLog(db, {
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

  const openStreamWithNextKey = async (
    messagesToSend: Array<Record<string, unknown>>,
    logCategoryOnRetry: 'failover' | 'stream_resume',
  ): Promise<{
    key: ProviderKeyRecord;
    response: Response;
    releaseLease: () => void;
  } | null> => {
    for (const key of candidates) {
      if (triedKeyIds.has(key.id) || registry.isKeyDraining(key.id)) {
        continue;
      }
      triedKeyIds.add(key.id);
      lastStreamOpenKeyId = key.id;

      const releaseLease = registry.acquireLease(providerId, key.id);
      try {
        const rawSecret = decryptSecret(key.encrypted_secret, masterKey);
        const headers: Record<string, string> = {
          ...buildProviderAuthHeaders(manifest.auth, rawSecret),
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        };
        const upstreamBody = applyStrictMaxTokens({
          ...requestBody,
          model: modelId,
          messages: messagesToSend,
          stream: true,
        });

        let res: Response;
        try {
          res = await dispatchRequestForKey(key, {
            method: 'POST',
            headers,
            body: JSON.stringify(upstreamBody),
          });
        } catch (err) {
          releaseLease();
          lastStreamOpenStatus = null;
          const msg = err instanceof Error ? err.message : String(err);
          const safeMsg = redactSecretsInText(`Network/tunnel error: ${msg}`);
          markKeyFailure(db, key.id, null, safeMsg, null, Math.floor(now() / 1000));

          const hasMore = candidates.some(
            (k) => !triedKeyIds.has(k.id) && !registry.isKeyDraining(k.id),
          );
          if (hasMore) {
            writeSystemLog(
              db,
              'warn',
              logCategoryOnRetry,
              `Key "${key.label}" (…${key.last4}) failed with network/tunnel error on "${providerId}"; trying next available key`,
              { providerId, failedKeyId: key.id, nodeId: key.node_id, reason: safeMsg },
              Math.floor(now() / 1000),
            );
          }
          continue;
        }

        if (isRetryableKeyFailureStatus(res.status) || !res.body) {
          const status = res.status;
          lastStreamOpenStatus = status;
          const safeErr = await extractSafeUpstreamErrorMessage(res);
          releaseLease();
          const safeMsg = redactSecretsInText(`HTTP ${status}: ${safeErr.slice(0, 160)}`);
          markKeyFailure(db, key.id, status, safeMsg, res.headers, Math.floor(now() / 1000));

          const hasMore = candidates.some(
            (k) => !triedKeyIds.has(k.id) && !registry.isKeyDraining(k.id),
          );
          if (hasMore) {
            writeSystemLog(
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
          const safeErr = await extractSafeUpstreamErrorMessage(res);
          releaseLease();
          nonRetryableStreamFailure = {
            status: res.status,
            message: safeErr,
            keyId: key.id,
          };
          return null;
        }

        return { key, response: res, releaseLease };
      } catch (err) {
        releaseLease();
        throw err;
      }
    }

    return null;
  };

  const initialConnection = await openStreamWithNextKey(originalMessages, 'failover');
  if (!initialConnection) {
    const failEndMs = now();
    const failSec = Math.floor(failEndMs / 1000);
    if (nonRetryableStreamFailure !== null) {
      const nrf: { status: number; message: string; keyId: string } = nonRetryableStreamFailure;
      writeSystemLog(
        db,
        'error',
        'system',
        `Upstream HTTP ${nrf.status} on SSE stream "${modelFullId}" (${providerId}): ${nrf.message}`,
        { providerId, modelFullId, keyId: nrf.keyId, httpStatus: nrf.status },
        failSec,
      );
      recordUsageLog(db, {
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

    writeSystemLog(
      db,
      'error',
      'failover',
      `All candidate keys failed before starting SSE stream on provider "${providerId}"`,
      { providerId, triedKeysCount: triedKeyIds.size, lastStatus: lastStreamOpenStatus },
      failSec,
    );
    const baseOpenErr = lastStreamOpenStatus === 429 ? 'rate_limit' : 'upstream';
    recordUsageLog(db, {
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
  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      clientAborted = true;
    },
    async start(controller) {
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
        if (clientAborted) return;
        try {
          controller.close();
        } catch {
          // Ignore already closed controller
        }
      };
      let activeConn: {
        key: ProviderKeyRecord;
        response: Response;
        releaseLease: () => void;
      } | null = initialConnection;

      let contentAccumulated = '';
      let reasoningAccumulated = '';
      let toolCallCharsAccumulated = 0;
      const toolCallsAccumulated = new Map<number, { name: string; args: string }>();
      let ttftMs: number | null = null;
      let promptTokens = 0;
      let completionTokens = 0;
      let reasoningTokens = 0;
      let cachedTokens = 0;
      let wasResumed = false;
      let quotaCutMidStream = false;
      let lastKeyUsedId = initialConnection.key.id;

      try {
        while (activeConn !== null && !clientAborted) {
          const currentKey = activeConn.key;
          const currentRes = activeConn.response;
          const releaseCurrent = activeConn.releaseLease;
          lastKeyUsedId = currentKey.id;

          let sawDone = false;
          let sawFinishReason = false;
          let streamFailureReason: string | null = null;

          const reader = currentRes.body!.getReader();
          const decoder = new TextDecoder();
          let buffer = '';

          const processLine = (rawLine: string): boolean => {
            const line = rawLine.trim();
            if (!line || line.startsWith(':')) {
              return true;
            }
            if (!line.startsWith('data:')) {
              return true;
            }

            const payload = line.slice(5).trim();
            if (payload === '[DONE]') {
              sawDone = true;
              return false;
            }

            let parsed: Record<string, unknown>;
            try {
              parsed = JSON.parse(payload) as Record<string, unknown>;
            } catch {
              controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
              return true;
            }

            if (parsed.error) {
              streamFailureReason = redactSecretsInText(JSON.stringify(parsed.error));
              return false;
            }

            if (ttftMs === null) {
              ttftMs = Math.max(1, now() - startMs);
            }

            if (parsed.usage && typeof parsed.usage === 'object') {
              const u = parsed.usage as Record<string, unknown>;
              promptTokens += Number(u.prompt_tokens ?? 0);
              completionTokens += Number(u.completion_tokens ?? 0);
              const compDet =
                u.completion_tokens_details && typeof u.completion_tokens_details === 'object'
                  ? (u.completion_tokens_details as Record<string, unknown>)
                  : {};
              reasoningTokens += Number(compDet.reasoning_tokens ?? u.reasoning_tokens ?? 0);
              const promptDet =
                u.prompt_tokens_details && typeof u.prompt_tokens_details === 'object'
                  ? (u.prompt_tokens_details as Record<string, unknown>)
                  : {};
              cachedTokens += Number(promptDet.cached_tokens ?? u.cached_tokens ?? 0);
            }

            if (Array.isArray(parsed.choices) && parsed.choices.length > 0) {
              const choice0 = parsed.choices[0] as Record<string, unknown>;
              const delta =
                choice0.delta && typeof choice0.delta === 'object'
                  ? (choice0.delta as Record<string, unknown>)
                  : null;
              if (delta) {
                if (typeof delta.content === 'string' && delta.content.length > 0) {
                  contentAccumulated += delta.content;
                }
                const deltaReasoning =
                  typeof delta.reasoning_content === 'string'
                    ? delta.reasoning_content
                    : typeof delta.reasoning === 'string'
                      ? delta.reasoning
                      : '';
                if (deltaReasoning.length > 0) {
                  reasoningAccumulated += deltaReasoning;
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
                        existing.name += fn.name;
                        toolCallCharsAccumulated += fn.name.length;
                      }
                      if (typeof fn?.arguments === 'string') {
                        existing.args += fn.arguments;
                        toolCallCharsAccumulated += fn.arguments.length;
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
              const liveOutputTokens = Math.max(
                completionTokens + reasoningTokens,
                Math.ceil(
                  (contentAccumulated.length +
                    reasoningAccumulated.length +
                    toolCallCharsAccumulated) /
                    4,
                ),
              );
              const livePromptTokens = promptTokens > 0 ? promptTokens : estimatedPromptTokens;

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
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(cutChunk)}\n\n`));
                return false;
              }
            }

            const forwardedChunk = {
              ...parsed,
              model: modelFullId,
            };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(forwardedChunk)}\n\n`));
            return true;
          };

          try {
            while (true) {
              const { value, done } = await reader.read();
              if (done) {
                buffer += decoder.decode();
                break;
              }
              buffer += decoder.decode(value, { stream: true });

              let newlineIdx: number;
              while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
                const rawLine = buffer.slice(0, newlineIdx).replace(/\r$/, '');
                buffer = buffer.slice(newlineIdx + 1);
                const keepGoing = processLine(rawLine);
                if (!keepGoing) {
                  break;
                }
              }

              if (sawDone || quotaCutMidStream || streamFailureReason !== null) {
                break;
              }
            }

            if (
              !sawDone &&
              !quotaCutMidStream &&
              streamFailureReason === null &&
              buffer.trim().length > 0
            ) {
              for (const remainingLine of buffer.split('\n')) {
                if (!processLine(remainingLine.replace(/\r$/, ''))) {
                  break;
                }
              }
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            streamFailureReason = redactSecretsInText(`Stream interrupted: ${msg}`);
          } finally {
            try {
              await reader.cancel();
            } catch {
              // Ignore reader cancel errors
            }
            releaseCurrent();
          }

          const completedCleanly =
            streamFailureReason === null && (sawDone || sawFinishReason || quotaCutMidStream);

          if (completedCleanly) {
            const endMs = now();
            const endSec = Math.floor(endMs / 1000);
            updateKeyHealthy(db, currentKey.id, currentRes.headers, endSec);

            if (completionTokens === 0 && contentAccumulated.length > 0) {
              completionTokens = Math.max(1, Math.ceil(contentAccumulated.length / 4));
            }
            if (reasoningTokens === 0 && reasoningAccumulated.length > 0) {
              reasoningTokens = Math.max(1, Math.ceil(reasoningAccumulated.length / 4));
            }
            if (promptTokens === 0 && estimatedPromptTokens > 0) {
              promptTokens = estimatedPromptTokens;
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

            controller.enqueue(encoder.encode('data: [DONE]\n\n'));

            recordUsageLog(db, {
              userId,
              providerId,
              providerKeyId: currentKey.id,
              modelFullId,
              promptTokens,
              completionTokens,
              reasoningTokens,
              cachedTokens,
              ttftMs,
              durationMs: Math.max(1, endMs - startMs),
              status: streamContractError ? 'error' : wasResumed ? 'resumed' : 'ok',
              errorType: streamContractError,
              createdAt: endSec,
            });

            activeConn = null;
            break;
          }

          const dropReason =
            streamFailureReason ?? 'Premature EOF before [DONE] on SSE stream';
          const dropSec = Math.floor(now() / 1000);
          markKeyFailure(db, currentKey.id, null, dropReason, null, dropSec);

          const isMidStreamContinuation = contentAccumulated.length > 0;
          if (!isMidStreamContinuation) {
            toolCallsAccumulated.clear();
          }
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

          const nextConn = await openStreamWithNextKey(
            continuationMessages,
            isMidStreamContinuation ? 'stream_resume' : 'failover',
          );

          if (nextConn) {
            if (isMidStreamContinuation) {
              wasResumed = true;
              writeSystemLog(
                db,
                'warn',
                'stream_resume',
                `SSE stream interrupted after ${contentAccumulated.length} chars on key "${currentKey.label}" (…${currentKey.last4}); resuming transparently with key "${nextConn.key.label}" (…${nextConn.key.last4})`,
                {
                  providerId,
                  modelFullId,
                  failedKeyId: currentKey.id,
                  failedKeyLast4: currentKey.last4,
                  resumedKeyId: nextConn.key.id,
                  resumedKeyLast4: nextConn.key.last4,
                  charsAccumulated: contentAccumulated.length,
                  reason: dropReason,
                },
                Math.floor(now() / 1000),
              );
            } else {
              writeSystemLog(
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
          writeSystemLog(
            db,
            'error',
            isMidStreamContinuation ? 'stream_resume' : 'failover',
            `SSE stream aborted on provider "${providerId}" with no healthy backup key remaining: ${dropReason}`,
            {
              providerId,
              modelFullId,
              failedKeyId: currentKey.id,
              charsAccumulated: contentAccumulated.length,
            },
            errSec,
          );

          recordUsageLog(db, {
            userId,
            providerId,
            providerKeyId: lastKeyUsedId,
            internalApiKeyId,
            modelFullId,
            promptTokens:
              promptTokens > 0
                ? promptTokens
                : contentAccumulated.length > 0 || reasoningAccumulated.length > 0
                  ? estimatedPromptTokens
                  : 0,
            completionTokens:
              completionTokens ||
              (contentAccumulated.length > 0 ? Math.ceil(contentAccumulated.length / 4) : 0),
            reasoningTokens:
              reasoningTokens ||
              (reasoningAccumulated.length > 0 ? Math.ceil(reasoningAccumulated.length / 4) : 0),
            cachedTokens,
            ttftMs,
            durationMs: Math.max(1, errEndMs - startMs),
            status: 'error',
            errorType: classifyFailureErrorType('network', contractFlags),
            createdAt: errSec,
          });

          const errFrame = {
            error: {
              message: 'Upstream stream interrupted and no backup key is available.',
              type: 'server_error',
              code: 'stream_interrupted',
            },
          };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(errFrame)}\n\n`));
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          activeConn = null;
          break;
        }
      } finally {
        if (activeConn !== null) {
          activeConn.releaseLease();
        }
        safeClose();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}

export async function executeEmbeddings(options: {
  db: DatabaseSync;
  masterKey: Buffer;
  registry: DrainingRegistry;
  fetchImpl: typeof fetch;
  upstreamTls?: UpstreamTlsOptions;
  now: () => number;
  userId: string;
  internalApiKeyId?: string | null;
  modelFullId: string;
  modelId: string;
  providerRow: Record<string, unknown>;
  requestBody: Record<string, unknown>;
}): Promise<Response> {
  const {
    db,
    masterKey,
    registry,
    fetchImpl,
    upstreamTls,
    now,
    userId,
    internalApiKeyId = null,
    modelFullId,
    modelId,
    providerRow,
    requestBody,
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
  const effectiveBaseUrl =
    providerRow.package_type === 'experimental-adapter' &&
    typeof providerRow.adapter_url === 'string' &&
    providerRow.adapter_url.length > 0
      ? providerRow.adapter_url
      : manifest.baseUrl;

  const embeddingsUrl = `${effectiveBaseUrl.replace(/\/+$/, '')}/embeddings`;

  const candidates = loadCandidateKeys(db, providerId, registry, nowSec);
  if (candidates.length === 0) {
    writeSystemLog(
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

  const extractSafeUpstreamErrorMessage = async (res: Response): Promise<string> => {
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
          return redactSecretsInText(candidate.trim().slice(0, 300));
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
    if (key.node_id) {
      if (!key.node_encrypted_token || !key.node_endpoint) {
        throw new Error(`Assigned exit node "${key.node_id}" is missing tunnel credentials`);
      }
      const nodeRawToken = decryptSecret(key.node_encrypted_token, masterKey);
      return fetchViaExitNode(
        embeddingsUrl,
        init,
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
    return fetchImpl(embeddingsUrl, { ...init, redirect: 'error' });
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
      const headers: Record<string, string> = {
        ...buildProviderAuthHeaders(manifest.auth, rawSecret),
        'Content-Type': 'application/json',
      };
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
        const msg = err instanceof Error ? err.message : String(err);
        lastStatus = null;
        lastWasNetwork = true;
        lastErrorMsg = redactSecretsInText(`Network/tunnel error: ${msg}`);
        markKeyFailure(db, key.id, null, lastErrorMsg, null, Math.floor(now() / 1000));

        const nextKey = candidates.slice(i + 1).find((k) => !registry.isKeyDraining(k.id));
        if (nextKey) {
          writeSystemLog(
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
        const safeErr = await extractSafeUpstreamErrorMessage(res);
        lastErrorMsg = redactSecretsInText(`HTTP ${res.status}: ${safeErr.slice(0, 160)}`);
        markKeyFailure(
          db,
          key.id,
          res.status,
          lastErrorMsg,
          res.headers,
          Math.floor(now() / 1000),
        );

        const nextKey = candidates.slice(i + 1).find((k) => !registry.isKeyDraining(k.id));
        if (nextKey) {
          writeSystemLog(
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
        const safeErr = await extractSafeUpstreamErrorMessage(res);
        const endMs = now();
        const endSec = Math.floor(endMs / 1000);
        writeSystemLog(
          db,
          'error',
          'system',
          `Upstream HTTP ${res.status} on "${modelFullId}" embeddings (${providerId}): ${safeErr}`,
          { providerId, modelFullId, keyId: key.id, httpStatus: res.status },
          endSec,
        );
        recordUsageLog(db, {
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
        writeSystemLog(
          db,
          'error',
          'system',
          `Upstream provider "${providerId}" returned malformed JSON on "${modelFullId}" embeddings`,
          { providerId, modelFullId, keyId: key.id },
          endSec,
        );
        recordUsageLog(db, {
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

      updateKeyHealthy(db, key.id, res.headers, endSec);

      const usage =
        data.usage && typeof data.usage === 'object'
          ? (data.usage as Record<string, unknown>)
          : {};
      const promptTokens = Number(usage.prompt_tokens ?? usage.total_tokens ?? 0);

      recordUsageLog(db, {
        userId,
        providerId,
        providerKeyId: key.id,
        internalApiKeyId,
        modelFullId,
        promptTokens: Number.isFinite(promptTokens) && promptTokens > 0 ? Math.floor(promptTokens) : 0,
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
  writeSystemLog(
    db,
    'error',
    'failover',
    `All candidate keys exhausted for provider "${providerId}" embeddings: ${lastErrorMsg}`,
    { providerId, triedKeysCount: triedKeyIds.size, lastStatus },
    failSec,
  );

  const baseFailType =
    lastStatus === 429 ? 'rate_limit' : lastWasNetwork ? 'network' : 'upstream';

  recordUsageLog(db, {
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
}

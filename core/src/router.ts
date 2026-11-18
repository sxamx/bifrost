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

function markKeyFailure(
  db: DatabaseSync,
  keyId: string,
  httpStatus: number | null,
  reason: string,
  headers: Headers | null,
  nowSec: number,
): void {
  const safeReason = redactSecretsInText(reason).slice(0, 300);
  if (httpStatus === 429) {
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
  const tokensPerSec =
    entry.durationMs > 0 && entry.completionTokens > 0
      ? Number(((entry.completionTokens * 1000) / entry.durationMs).toFixed(2))
      : null;

  db.prepare(
    `INSERT INTO usage_logs (
       user_id, provider_id, provider_key_id, model_full_id,
       prompt_tokens, completion_tokens, reasoning_tokens, cached_tokens,
       ttft_ms, duration_ms, tokens_per_sec, status, error_type, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    entry.userId,
    entry.providerId,
    entry.providerKeyId,
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
    modelFullId,
    modelId,
    providerRow,
    requestBody,
  } = options;

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

  const chatUrl = `${effectiveBaseUrl.replace(/\/+$/, '')}/chat/completions`;
  const startMs = now();
  const nowSec = Math.floor(startMs / 1000);

  const candidates = loadCandidateKeys(db, providerId, registry, nowSec);
  if (candidates.length === 0) {
    return openAiErrorJson(
      `Provider "${providerId}" has no active API keys with an online exit node available.`,
      'service_unavailable',
      'no_provider_keys',
      503,
    );
  }

  const dispatchRequestForKey = async (
    key: ProviderKeyRecord,
    init: RequestInit,
  ): Promise<Response> => {
    if (key.node_id && key.node_encrypted_token && key.node_endpoint) {
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
    return fetchImpl(chatUrl, init);
  };

  const isStream = requestBody.stream === true;
  const originalMessages = Array.isArray(requestBody.messages)
    ? (requestBody.messages as Array<Record<string, unknown>>)
    : [];

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
        const upstreamBody = {
          ...requestBody,
          model: modelId,
          stream: false,
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
          const errSnippet = await res.text().catch(() => '');
          lastErrorMsg = redactSecretsInText(
            `HTTP ${res.status}${errSnippet ? `: ${errSnippet.slice(0, 160)}` : ''}`,
          );
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
          const errText = await res.text().catch(() => '');
          return openAiErrorJson(
            redactSecretsInText(errText || `Upstream returned HTTP ${res.status}`),
            'invalid_request_error',
            'upstream_error',
            res.status,
          );
        }

        const ttftMs = Math.max(1, now() - startMs);
        const data = (await res.json()) as Record<string, unknown>;
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

        const promptTokens = Number(usage.prompt_tokens ?? 0);
        const completionTokens = Number(usage.completion_tokens ?? 0);
        const reasoningTokens = Number(
          compDetails.reasoning_tokens ?? usage.reasoning_tokens ?? 0,
        );
        const cachedTokens = Number(promptDetails.cached_tokens ?? usage.cached_tokens ?? 0);

        recordUsageLog(db, {
          userId,
          providerId,
          providerKeyId: key.id,
          modelFullId,
          promptTokens,
          completionTokens,
          reasoningTokens,
          cachedTokens,
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
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
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

    recordUsageLog(db, {
      userId,
      providerId,
      providerKeyId: lastKeyId,
      modelFullId,
      promptTokens: 0,
      completionTokens: 0,
      reasoningTokens: 0,
      cachedTokens: 0,
      ttftMs: null,
      durationMs: Math.max(1, failEndMs - startMs),
      status: 'error',
      errorType: lastStatus === 429 ? 'rate_limit' : lastWasNetwork ? 'network' : 'upstream',
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

      const releaseLease = registry.acquireLease(providerId, key.id);
      try {
        const rawSecret = decryptSecret(key.encrypted_secret, masterKey);
        const headers: Record<string, string> = {
          ...buildProviderAuthHeaders(manifest.auth, rawSecret),
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        };
        const upstreamBody = {
          ...requestBody,
          model: modelId,
          messages: messagesToSend,
          stream: true,
        };

        let res: Response;
        try {
          res = await dispatchRequestForKey(key, {
            method: 'POST',
            headers,
            body: JSON.stringify(upstreamBody),
          });
        } catch (err) {
          releaseLease();
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
          const errSnippet = await res.text().catch(() => '');
          releaseLease();
          const safeMsg = redactSecretsInText(
            `HTTP ${status}${errSnippet ? `: ${errSnippet.slice(0, 160)}` : ''}`,
          );
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
          releaseLease();
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
    writeSystemLog(
      db,
      'error',
      'failover',
      `All candidate keys failed before starting SSE stream on provider "${providerId}"`,
      { providerId, triedKeysCount: triedKeyIds.size },
      failSec,
    );
    recordUsageLog(db, {
      userId,
      providerId,
      providerKeyId: null,
      modelFullId,
      promptTokens: 0,
      completionTokens: 0,
      reasoningTokens: 0,
      cachedTokens: 0,
      ttftMs: null,
      durationMs: Math.max(1, failEndMs - startMs),
      status: 'error',
      errorType: 'upstream',
      createdAt: failSec,
    });
    return openAiErrorJson(
      `All configured keys for provider "${providerId}" failed to open stream.`,
      'service_unavailable',
      'upstream_unavailable',
      502,
    );
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let activeConn: {
        key: ProviderKeyRecord;
        response: Response;
        releaseLease: () => void;
      } | null = initialConnection;

      let contentAccumulated = '';
      let ttftMs: number | null = null;
      let promptTokens = 0;
      let completionTokens = 0;
      let reasoningTokens = 0;
      let cachedTokens = 0;
      let wasResumed = false;
      let lastKeyUsedId = initialConnection.key.id;

      try {
        while (activeConn !== null) {
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
              if (delta && typeof delta.content === 'string' && delta.content.length > 0) {
                contentAccumulated += delta.content;
              }
              if (
                choice0.finish_reason !== null &&
                choice0.finish_reason !== undefined &&
                choice0.finish_reason !== ''
              ) {
                sawFinishReason = true;
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

              if (sawDone || streamFailureReason !== null) {
                break;
              }
            }

            if (!sawDone && streamFailureReason === null && buffer.trim().length > 0) {
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
            streamFailureReason === null && (sawDone || sawFinishReason);

          if (completedCleanly) {
            const endMs = now();
            const endSec = Math.floor(endMs / 1000);
            updateKeyHealthy(db, currentKey.id, currentRes.headers, endSec);

            if (completionTokens === 0 && contentAccumulated.length > 0) {
              completionTokens = Math.max(1, Math.ceil(contentAccumulated.length / 4));
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
              status: wasResumed ? 'resumed' : 'ok',
              errorType: null,
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
            modelFullId,
            promptTokens,
            completionTokens:
              completionTokens ||
              (contentAccumulated.length > 0 ? Math.ceil(contentAccumulated.length / 4) : 0),
            reasoningTokens,
            cachedTokens,
            ttftMs,
            durationMs: Math.max(1, errEndMs - startMs),
            status: 'error',
            errorType: 'network',
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
        controller.close();
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

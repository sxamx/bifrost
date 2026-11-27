import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterEach, describe, it } from 'node:test';

import { createApp } from '../core/src/app.js';
import { encryptSecret, generateInternalApiKey, hashPassword } from '../core/src/crypto.js';
import { openDatabase } from '../core/src/db.js';
import { computeAdaptiveFreeQuotas } from '../core/src/metrics/adaptive-quota.js';
import { getSummaryMetrics } from '../core/src/metrics/metrics.js';
import { syncProviderModels } from '../core/src/models-sync.js';
import {
  DrainingRegistry,
  executeChatCompletions,
  executeEmbeddings,
  getInFlightReservedTokens,
  markKeyFailure,
  parseRateLimitHeaders,
  resetInFlightQuotaReservationsForTests,
  updateKeyHealthy,
} from '../core/src/router.js';

function extractCookiePair(setCookieHeader: string | null): string {
  assert.ok(setCookieHeader, 'Expected Set-Cookie header');
  return setCookieHeader.split(';')[0]!;
}

afterEach(() => {
  resetInFlightQuotaReservationsForTests();
});

describe('Ola 3 — Rolling 24h quotas, anti-TOCTOU reservations, header units, metrics & disabled/no_node isolation', () => {
  it('1) rolling_24h + concurrent in-flight reservations block TOCTOU excess for strict guest without blocking fitting parallel requests or admin', async () => {
    const db = openDatabase(':memory:');
    const masterKey = randomBytes(32);
    const registry = new DrainingRegistry();
    let clockMs = Date.UTC(2026, 10, 26, 10, 0, 0);
    const nowSec = Math.floor(clockMs / 1000);

    try {
      const passHash = await hashPassword('QuotaPass123!');
      db.prepare(
        `INSERT INTO users (id, username, password_hash, role, daily_token_limit, quota_reset_mode, enforce_strict_quota, created_at)
         VALUES
           ('admin-u', 'admin', ?, 'admin', NULL, 'utc_midnight', 0, ?),
           ('guest-strict', 'guest_s', ?, 'guest', 600, 'rolling_24h', 1, ?)`,
      ).run(passHash, nowSec, passHash, nowSec);

      const manifest = {
        schemaVersion: '1.0',
        id: 'quota-prov',
        name: 'Quota Provider',
        packageType: 'official-json',
        baseUrl: 'https://quota.example.com/v1',
        auth: { type: 'bearer', header: 'Authorization', prefix: 'Bearer ' },
        modelsSource: 'static',
        rateLimitKind: 'tokens',
        rateLimitWindows: ['day'],
        staticModels: [{ id: 'q-model', name: 'Q Model' }],
      };
      db.prepare(
        `INSERT INTO providers (id, name, package_type, models_source, schema_json, enabled, created_at)
         VALUES ('quota-prov', 'Quota Provider', 'official-json', 'static', ?, 1, ?)`,
      ).run(JSON.stringify(manifest), nowSec);
      db.prepare(
        `INSERT INTO provider_keys (id, provider_id, label, encrypted_secret, last4, status, created_at)
         VALUES ('pk-q1', 'quota-prov', 'Q Key', ?, '1111', 'active', ?)`,
      ).run(encryptSecret('sk-quota-key-1111', masterKey), nowSec);

      const providerRow = db
        .prepare(`SELECT * FROM providers WHERE id = 'quota-prov'`)
        .get() as Record<string, unknown>;

      // Gate upstream so we can hold concurrent requests in flight
      const resolvers: Array<() => void> = [];
      const seenUpstreamBodies: Array<Record<string, unknown>> = [];

      const gatedFetch: typeof fetch = async (_input, init) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        seenUpstreamBodies.push(body);
        await new Promise<void>((resolve) => {
          resolvers.push(resolve);
        });
        return new Response(
          JSON.stringify({
            choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 90 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      };

      // Launch 2 parallel requests for guest-strict (limit=600) each with max_tokens=200 + ~10 prompt tokens (~210 each -> 420 <= 600)
      const p1 = executeChatCompletions({
        db,
        masterKey,
        registry,
        fetchImpl: gatedFetch,
        now: () => clockMs,
        userId: 'guest-strict',
        modelFullId: 'quota-prov/q-model',
        modelId: 'q-model',
        providerRow,
        requestBody: {
          model: 'quota-prov/q-model',
          max_tokens: 200,
          max_completion_tokens: 250,
          messages: [{ role: 'user', content: 'Parallel subagent task 1' }],
        },
      });
      const p2 = executeChatCompletions({
        db,
        masterKey,
        registry,
        fetchImpl: gatedFetch,
        now: () => clockMs,
        userId: 'guest-strict',
        modelFullId: 'quota-prov/q-model',
        modelId: 'q-model',
        providerRow,
        requestBody: {
          model: 'quota-prov/q-model',
          max_tokens: 200,
          messages: [{ role: 'user', content: 'Parallel subagent task 2' }],
        },
      });

      // Wait a tick for both to reach upstream fetch
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(seenUpstreamBodies.length, 2, 'Both fitting parallel requests must proceed concurrently');
      assert.ok(getInFlightReservedTokens('guest-strict') > 400);

      // 3rd concurrent request claims remaining budget (~180); its max_tokens & max_completion_tokens are BOTH clamped
      const p3 = executeChatCompletions({
        db,
        masterKey,
        registry,
        fetchImpl: gatedFetch,
        now: () => clockMs,
        userId: 'guest-strict',
        modelFullId: 'quota-prov/q-model',
        modelId: 'q-model',
        providerRow,
        requestBody: {
          model: 'quota-prov/q-model',
          max_tokens: 9999,
          max_completion_tokens: 8888,
          messages: [{ role: 'user', content: 'Task 3' }],
        },
      });
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(seenUpstreamBodies.length, 3);
      assert.equal(
        seenUpstreamBodies[2]!.max_tokens,
        seenUpstreamBodies[2]!.max_completion_tokens,
        'applyStrictMaxTokens must trim max_tokens and max_completion_tokens simultaneously',
      );
      assert.ok(Number(seenUpstreamBodies[2]!.max_tokens) < 200);

      // 4th concurrent request exceeds strict quota via in-flight reservation -> blocked 429 (anti-TOCTOU!)
      const res4 = await executeChatCompletions({
        db,
        masterKey,
        registry,
        fetchImpl: gatedFetch,
        now: () => clockMs,
        userId: 'guest-strict',
        modelFullId: 'quota-prov/q-model',
        modelId: 'q-model',
        providerRow,
        requestBody: {
          model: 'quota-prov/q-model',
          max_tokens: 100,
          messages: [{ role: 'user', content: 'TOCTOU overflow request' }],
        },
      });
      assert.equal(res4.status, 429);
      assert.equal(seenUpstreamBodies.length, 3, 'Blocked 4th request must never hit upstream');

      // Admin must NEVER be blocked or have in-flight reservations
      const adminP1 = executeChatCompletions({
        db,
        masterKey,
        registry,
        fetchImpl: gatedFetch,
        now: () => clockMs,
        userId: 'admin-u',
        modelFullId: 'quota-prov/q-model',
        modelId: 'q-model',
        providerRow,
        requestBody: {
          model: 'quota-prov/q-model',
          messages: [{ role: 'user', content: 'Admin parallel call' }],
        },
      });
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(getInFlightReservedTokens('admin-u'), 0);
      assert.equal(seenUpstreamBodies.length, 4);

      // Release all gated upstream calls -> reservations must drop to 0
      while (resolvers.length > 0) {
        resolvers.shift()!();
      }
      const [r1, r2, r3, rAdmin] = await Promise.all([p1, p2, p3, adminP1]);
      assert.equal(r1.status, 200);
      assert.equal(r2.status, 200);
      assert.equal(r3.status, 200);
      assert.equal(rAdmin.status, 200);
      assert.equal(getInFlightReservedTokens('guest-strict'), 0, 'Reservations must be released in finally');

      // Now guest-strict has used 3 * 100 = 300 tokens (300 remaining)
      // Prompt exceeding remaining (>= 300 tokens -> 1200+ chars) must be rejected 429 pre-flight
      const hugePromptRes = await executeChatCompletions({
        db,
        masterKey,
        registry,
        fetchImpl: async () => {
          throw new Error('Should not reach upstream when estimatedPromptTokens >= strictRemainingTokens');
        },
        now: () => clockMs,
        userId: 'guest-strict',
        modelFullId: 'quota-prov/q-model',
        modelId: 'q-model',
        providerRow,
        requestBody: {
          model: 'quota-prov/q-model',
          messages: [{ role: 'user', content: 'x'.repeat(1600) }],
        },
      });
      assert.equal(hugePromptRes.status, 429);

      // Embeddings input exceeding remaining 300 tokens must also be rejected 429 pre-flight
      const hugeEmbRes = await executeEmbeddings({
        db,
        masterKey,
        registry,
        fetchImpl: async () => {
          throw new Error('Should not reach upstream when embeddings input exceeds strict quota');
        },
        now: () => clockMs,
        userId: 'guest-strict',
        modelFullId: 'quota-prov/q-model',
        modelId: 'q-model',
        providerRow,
        requestBody: {
          model: 'quota-prov/q-model',
          input: 'z'.repeat(1600),
        },
      });
      assert.equal(hugeEmbRes.status, 429);

      // Advance clock past rolling_24h (+86401s) -> previous 300 tokens expire and full 600 quota is available again!
      clockMs += 86_401_000;
      const afterRolling = await executeChatCompletions({
        db,
        masterKey,
        registry,
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              choices: [{ index: 0, message: { role: 'assistant', content: 'rolled' }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 350, completion_tokens: 50 },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        now: () => clockMs,
        userId: 'guest-strict',
        modelFullId: 'quota-prov/q-model',
        modelId: 'q-model',
        providerRow,
        requestBody: {
          model: 'quota-prov/q-model',
          messages: [{ role: 'user', content: 'x'.repeat(1400) }], // ~353 tokens, fits in refreshed 600 limit
        },
      });
      assert.equal(afterRolling.status, 200);
    } finally {
      db.close();
    }
  });

  it('2) parseRateLimitHeaders honors rateLimitKind priority, Go durations (1m30s, 6s, 500ms, 2h), and RFC 7231 HTTP dates', () => {
    const nowSec = Math.floor(Date.UTC(2026, 10, 26, 10, 0, 0) / 1000);

    const mixedHeaders = new Headers({
      'x-ratelimit-remaining-requests': '12',
      'x-ratelimit-remaining-tokens': '45000',
      'x-ratelimit-reset-requests': '6s',
      'x-ratelimit-reset-tokens': '1m30s',
    });

    const asTokens = parseRateLimitHeaders(mixedHeaders, nowSec, 'tokens');
    assert.equal(asTokens.remaining, 45000);
    assert.equal(asTokens.resetAt, nowSec + 90);

    const asRequests = parseRateLimitHeaders(mixedHeaders, nowSec, 'requests');
    assert.equal(asRequests.remaining, 12);
    assert.equal(asRequests.resetAt, nowSec + 6);

    const msHeader = new Headers({ 'x-ratelimit-reset-tokens': '500ms' });
    assert.equal(parseRateLimitHeaders(msHeader, nowSec, 'tokens').resetAt, nowSec + 1);

    const hourHeader = new Headers({ 'x-ratelimit-reset-requests': '2h' });
    assert.equal(parseRateLimitHeaders(hourHeader, nowSec, 'requests').resetAt, nowSec + 7200);

    const rfcDate = 'Thu, 26 Nov 2026 11:30:00 GMT';
    const rfcHeaders = new Headers({ 'retry-after': rfcDate });
    assert.equal(
      parseRateLimitHeaders(rfcHeaders, nowSec, 'requests').resetAt,
      Math.floor(Date.parse(rfcDate) / 1000),
    );
  });

  it('3) getSummaryMetrics does not mix tokens & requests, excludes offline-node keys & disabled_by_admin models, and /api/auth/me excludes expired internal API keys', async () => {
    const db = openDatabase(':memory:');
    const masterKey = randomBytes(32);
    const clockMs = Date.UTC(2026, 10, 26, 12, 0, 0);
    const nowSec = Math.floor(clockMs / 1000);

    try {
      const app = createApp({ db, masterKey, now: () => clockMs });
      const setupRes = await app.request('http://localhost/api/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'AdminPassword123!' }),
      });
      assert.equal(setupRes.status, 201);
      const adminCookie = extractCookiePair(setupRes.headers.get('set-cookie'));
      const adminUserId = ((await setupRes.json()) as { user: { id: string } }).user.id;

      // Seed 1 online node + 1 offline node
      db.prepare(
        `INSERT INTO nodes (id, name, mode, endpoint, token_hash, last_rotated_at, status, created_at)
         VALUES
           ('node-online', 'Online Node', 'tailscale', '100.64.0.1:9443', 'h1', ?, 'online', ?),
           ('node-offline', 'Offline Node', 'tailscale', '100.64.0.2:9443', 'h2', ?, 'offline', ?)`,
      ).run(nowSec, nowSec, nowSec, nowSec);

      // Provider A: rateLimitKind = 'requests' (100 req/day on online key + 9999 req/day on offline-node key)
      db.prepare(
        `INSERT INTO providers (id, name, package_type, models_source, schema_json, enabled, created_at)
         VALUES ('prov-req', 'Req Prov', 'official-json', 'static', ?, 1, ?)`,
      ).run(
        JSON.stringify({
          schemaVersion: '1.0',
          id: 'prov-req',
          name: 'Req Prov',
          packageType: 'official-json',
          baseUrl: 'https://req.example.com/v1',
          auth: { type: 'bearer', header: 'Authorization', prefix: 'Bearer ' },
          modelsSource: 'static',
          rateLimitKind: 'requests',
          rateLimitWindows: ['day'],
        }),
        nowSec,
      );
      db.prepare(
        `INSERT INTO provider_keys (id, provider_id, label, encrypted_secret, last4, node_id, daily_quota_limit, status, created_at)
         VALUES
           ('pk-req-on', 'prov-req', 'On', ?, '1111', 'node-online', 100, 'active', ?),
           ('pk-req-off', 'prov-req', 'Off', ?, '2222', 'node-offline', 9999, 'active', ?)`,
      ).run(
        encryptSecret('sk-req-1111', masterKey),
        nowSec,
        encryptSecret('sk-req-2222', masterKey),
        nowSec,
      );

      // Log 1 request that consumed 5,000 tokens today
      db.prepare(
        `INSERT INTO usage_logs (user_id, provider_id, provider_key_id, model_full_id, prompt_tokens, completion_tokens, reasoning_tokens, cached_tokens, duration_ms, status, created_at)
         VALUES (?, 'prov-req', 'pk-req-on', 'prov-req/m1', 3000, 2000, 0, 0, 100, 'ok', ?)`,
      ).run(adminUserId, nowSec);

      // Models: 1 enabled, 1 disabled_by_admin
      db.prepare(
        `INSERT INTO models (full_id, provider_id, model_id, name, modalities_json, capabilities_json, is_free, first_seen_at, active, disabled_by_admin)
         VALUES
           ('prov-req/m1', 'prov-req', 'm1', 'M1', '{"input":["text"],"output":["text"]}', '{}', 1, ?, 1, 0),
           ('prov-req/m2', 'prov-req', 'm2', 'M2', '{"input":["text"],"output":["text"]}', '{}', 1, ?, 1, 1)`,
      ).run(nowSec, nowSec);

      // Requests-only summary: offline key (9999) excluded, limit = 100, remaining = 99 (NOT 100 - 5000 = 0!)
      const reqOnlyAdaptive = computeAdaptiveFreeQuotas(db, nowSec);
      assert.equal(reqOnlyAdaptive.providers[0]!.usableKeysCount, 1);
      assert.equal(reqOnlyAdaptive.configuredLimit, 100);
      const reqOnlySummary = getSummaryMetrics(db, { nowSec, userId: adminUserId, role: 'admin' });
      assert.equal(reqOnlySummary.quotaToday.configuredDailyLimit, 100);
      assert.equal(reqOnlySummary.quotaToday.remainingTokensToday, 99);
      assert.equal(reqOnlySummary.quotaToday.quotaPercentageRemaining, 99);
      assert.equal(reqOnlySummary.activeModelsCount, 1, 'disabled_by_admin model must be excluded from activeModelsCount');

      // Add Provider B: rateLimitKind = 'tokens' (50,000 tokens/day) -> mixed units must NOT sum 100 + 50000!
      db.prepare(
        `INSERT INTO providers (id, name, package_type, models_source, schema_json, enabled, created_at)
         VALUES ('prov-tok', 'Tok Prov', 'official-json', 'static', ?, 1, ?)`,
      ).run(
        JSON.stringify({
          schemaVersion: '1.0',
          id: 'prov-tok',
          name: 'Tok Prov',
          packageType: 'official-json',
          baseUrl: 'https://tok.example.com/v1',
          auth: { type: 'bearer', header: 'Authorization', prefix: 'Bearer ' },
          modelsSource: 'static',
          rateLimitKind: 'tokens',
          rateLimitWindows: ['day'],
        }),
        nowSec,
      );
      db.prepare(
        `INSERT INTO provider_keys (id, provider_id, label, encrypted_secret, last4, daily_quota_limit, status, created_at)
         VALUES ('pk-tok-1', 'prov-tok', 'Tok1', ?, '3333', 50000, 'active', ?)`,
      ).run(encryptSecret('sk-tok-3333', masterKey), nowSec);

      const mixedSummary = getSummaryMetrics(db, { nowSec, userId: adminUserId, role: 'admin' });
      assert.equal(mixedSummary.quotaToday.configuredDailyLimit, null, 'Mixed units must never sum tokens + requests');
      assert.equal(mixedSummary.quotaToday.effectiveLimit, null);
      assert.equal(mixedSummary.quotaToday.remainingTokensToday, null);

      // Internal API keys: 1 valid + 1 expired -> /api/auth/me must count only non-expired keys and non-disabled models
      const validKey = generateInternalApiKey();
      const expiredKey = generateInternalApiKey();
      db.prepare(
        `INSERT INTO internal_api_keys (id, user_id, name, key_prefix, key_hash, expires_at, created_at)
         VALUES
           ('ik-valid', ?, 'Valid', ?, ?, ?, ?),
           ('ik-expired', ?, 'Expired', ?, ?, ?, ?)`,
      ).run(
        adminUserId,
        validKey.keyPrefix,
        validKey.keyHash,
        nowSec + 3600,
        nowSec,
        adminUserId,
        expiredKey.keyPrefix,
        expiredKey.keyHash,
        nowSec - 10,
        nowSec - 100,
      );

      const meRes = await app.request('http://localhost/api/auth/me', {
        headers: { Cookie: adminCookie },
      });
      assert.equal(meRes.status, 200);
      const meBody = (await meRes.json()) as { stats: { modelsCount: number; keysCount: number } };
      assert.equal(meBody.stats.modelsCount, 1, '/api/auth/me must exclude disabled_by_admin models');
      assert.equal(meBody.stats.keysCount, 1, '/api/auth/me must exclude expired internal API keys');
    } finally {
      db.close();
    }
  });

  it('4) updateKeyHealthy/markKeyFailure never reactivate disabled/no_node keys, sync excludes disabled keys, node PATCH preserves disabled, and Test Key sets ratelimit_reset_at', async () => {
    const db = openDatabase(':memory:');
    const masterKey = randomBytes(32);
    const clockMs = Date.UTC(2026, 10, 26, 14, 0, 0);
    const nowSec = Math.floor(clockMs / 1000);

    try {
      const app = createApp({
        db,
        masterKey,
        now: () => clockMs,
        fetchImpl: async () =>
          new Response(JSON.stringify({ error: { message: 'Too many requests' } }), {
            status: 429,
            headers: {
              'Content-Type': 'application/json',
              'retry-after': '1m30s',
            },
          }),
      });

      const setupRes = await app.request('http://localhost/api/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'AdminPassword123!' }),
      });
      assert.equal(setupRes.status, 201);
      const adminCookie = extractCookiePair(setupRes.headers.get('set-cookie'));

      await app.request('http://localhost/api/providers', {
        method: 'POST',
        headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          schemaVersion: '1.0',
          id: 'iso-prov',
          name: 'Iso Prov',
          packageType: 'official-json',
          baseUrl: 'https://iso.example.com/v1',
          auth: { type: 'bearer', header: 'Authorization', prefix: 'Bearer ' },
          modelsSource: 'api',
          modelsEndpoint: '/models',
          rateLimitKind: 'requests',
          rateLimitWindows: ['day'],
        }),
      });

      const disabledKeyId = randomUUID();
      const noNodeKeyId = randomUUID();
      const activeKeyId = randomUUID();

      db.prepare(
        `INSERT INTO provider_keys (id, provider_id, label, encrypted_secret, last4, status, created_at)
         VALUES
           (?, 'iso-prov', 'Disabled', ?, '1111', 'disabled', ?),
           (?, 'iso-prov', 'NoNode', ?, '2222', 'no_node', ?),
           (?, 'iso-prov', 'Active', ?, '3333', 'active', ?)`,
      ).run(
        disabledKeyId,
        encryptSecret('sk-iso-1111', masterKey),
        nowSec,
        noNodeKeyId,
        encryptSecret('sk-iso-2222', masterKey),
        nowSec,
        activeKeyId,
        encryptSecret('sk-iso-3333', masterKey),
        nowSec,
      );

      // A) updateKeyHealthy & markKeyFailure must NEVER change status of disabled or no_node keys
      updateKeyHealthy(db, disabledKeyId, new Headers({ 'x-ratelimit-remaining': '50' }), nowSec, 'requests');
      updateKeyHealthy(db, noNodeKeyId, new Headers({ 'x-ratelimit-remaining': '50' }), nowSec, 'requests');
      markKeyFailure(db, disabledKeyId, 429, 'rate limit', new Headers({ 'retry-after': '30' }), nowSec, 'requests');
      markKeyFailure(db, noNodeKeyId, 401, 'bad key', null, nowSec, 'requests');

      const stDisabled = (
        db.prepare(`SELECT status FROM provider_keys WHERE id = ?`).get(disabledKeyId) as { status: string }
      ).status;
      const stNoNode = (
        db.prepare(`SELECT status FROM provider_keys WHERE id = ?`).get(noNodeKeyId) as { status: string }
      ).status;
      assert.equal(stDisabled, 'disabled');
      assert.equal(stNoNode, 'no_node');

      // B) PATCH /api/providers/:id/keys/:keyId/node preserves status='disabled' on offline node
      const nodeRes = await app.request('http://localhost/api/nodes', {
        method: 'POST',
        headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'OfflineIso',
          mode: 'tailscale',
          endpoint: '100.64.0.77:9443',
        }),
      });
      assert.equal(nodeRes.status, 201);
      const offlineNodeId = ((await nodeRes.json()) as { node: { id: string } }).node.id;

      const assignRes = await app.request(
        `http://localhost/api/providers/iso-prov/keys/${disabledKeyId}/node`,
        {
          method: 'PATCH',
          headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({ nodeId: offlineNodeId }),
        },
      );
      assert.equal(assignRes.status, 200);
      const assignedJson = (await assignRes.json()) as { key: { status: string; nodeId: string } };
      assert.equal(assignedJson.key.nodeId, offlineNodeId);
      assert.equal(assignedJson.key.status, 'disabled', 'Assigning offline node to disabled key must preserve disabled');

      // C) POST /api/providers/:id/keys/:keyId/test on 429 sets status='rate_limited' AND ratelimit_reset_at = nowSec + 90
      const testRes = await app.request(
        `http://localhost/api/providers/iso-prov/keys/${activeKeyId}/test`,
        { method: 'POST', headers: { Cookie: adminCookie } },
      );
      assert.equal(testRes.status, 200);
      const testJson = (await testRes.json()) as { ok: boolean; status: string };
      assert.equal(testJson.ok, false);
      assert.equal(testJson.status, 'rate_limited');
      const testedKeyRow = db
        .prepare(`SELECT status, ratelimit_remaining, ratelimit_reset_at FROM provider_keys WHERE id = ?`)
        .get(activeKeyId) as {
        status: string;
        ratelimit_remaining: number | null;
        ratelimit_reset_at: number | null;
      };
      assert.equal(testedKeyRow.status, 'rate_limited');
      assert.equal(testedKeyRow.ratelimit_remaining, 0);
      assert.equal(testedKeyRow.ratelimit_reset_at, nowSec + 90);

      // D) syncProviderModels excludes disabled keys (when only disabled/no_node keys remain, fails 502 without calling fetchImpl)
      db.prepare(`DELETE FROM provider_keys WHERE id = ?`).run(activeKeyId);
      let fetchCalled = false;
      await assert.rejects(
        () =>
          syncProviderModels({
            db,
            masterKey,
            providerId: 'iso-prov',
            drainingKeys: new Set(),
            drainingProviders: new Set(),
            fetchImpl: async () => {
              fetchCalled = true;
              return new Response(JSON.stringify({ data: [] }), { status: 200 });
            },
            nowSec,
            modelsDevSnapshot: {
              modelsByProvider: new Map(),
              modelsById: new Map(),
              fetchedAt: nowSec,
            } as never,
          }),
        /disabled|offline/i,
      );
      assert.equal(fetchCalled, false, 'syncProviderModels must never use disabled keys');
    } finally {
      db.close();
    }
  });
});

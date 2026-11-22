import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, it } from 'node:test';

import { createApp } from '../core/src/app.js';
import { encryptSecret } from '../core/src/crypto.js';
import { openDatabase } from '../core/src/db.js';
import { validateProviderManifest } from '../core/src/schema.js';

const openServers: http.Server[] = [];

async function startMockServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void | Promise<void>,
): Promise<{ url: string; server: http.Server }> {
  const server = http.createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch((err) => {
      if (!res.headersSent) {
        res.statusCode = 500;
      }
      res.end(String(err));
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  openServers.push(server);
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, server };
}

function extractCookiePair(setCookieHeader: string | null): string {
  assert.ok(setCookieHeader, 'Expected Set-Cookie header');
  return setCookieHeader.split(';')[0]!;
}

afterEach(async () => {
  while (openServers.length > 0) {
    const srv = openServers.pop()!;
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
});

function baseManifest(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: '1.0',
    id: 'test-provider',
    name: 'Test Provider',
    packageType: 'official-json',
    baseUrl: 'https://api.example.com/v1',
    auth: {
      type: 'bearer',
      header: 'Authorization',
      prefix: 'Bearer ',
    },
    modelsSource: 'static',
    reviewedAt: '2026-11-01',
    staticModels: [
      {
        id: 'test-model',
        name: 'Test Model',
      },
    ],
    ...overrides,
  };
}

describe('HU-38 & HU-39: Marketplace Rate-Limit Metadata & Adaptive Free-Tier Quotas', () => {
  describe('HU-38: validateProviderManifest rateLimitKind & rateLimitWindows', () => {
    it('accepts valid rateLimitKind and rateLimitWindows combinations', () => {
      const noneRes = validateProviderManifest(
        baseManifest({ rateLimitKind: 'none', rateLimitWindows: [] }),
      );
      assert.equal(noneRes.valid, true, noneRes.errors.join('; '));

      const tokensRes = validateProviderManifest(
        baseManifest({ rateLimitKind: 'tokens', rateLimitWindows: ['hour', 'day'] }),
      );
      assert.equal(tokensRes.valid, true, tokensRes.errors.join('; '));
      assert.equal(tokensRes.manifest?.rateLimitKind, 'tokens');
      assert.deepEqual(tokensRes.manifest?.rateLimitWindows, ['hour', 'day']);

      const requestsRes = validateProviderManifest(
        baseManifest({ rateLimitKind: 'requests', rateLimitWindows: ['week'] }),
      );
      assert.equal(requestsRes.valid, true, requestsRes.errors.join('; '));

      const concurrencyRes = validateProviderManifest(
        baseManifest({ rateLimitKind: 'concurrency', rateLimitWindows: [] }),
      );
      assert.equal(concurrencyRes.valid, true, concurrencyRes.errors.join('; '));
      assert.equal(concurrencyRes.manifest?.rateLimitKind, 'concurrency');
    });

    it('rejects invalid rateLimitKind, duplicate/invalid windows, and non-empty windows for kind=none', () => {
      const badKind = validateProviderManifest(
        baseManifest({ rateLimitKind: 'credits' }),
      );
      assert.equal(badKind.valid, false);

      const badWindow = validateProviderManifest(
        baseManifest({ rateLimitKind: 'requests', rateLimitWindows: ['month'] }),
      );
      assert.equal(badWindow.valid, false);

      const dupWindow = validateProviderManifest(
        baseManifest({ rateLimitKind: 'tokens', rateLimitWindows: ['day', 'day'] }),
      );
      assert.equal(dupWindow.valid, false);
      assert.ok(dupWindow.errors.some((e) => e.includes('duplicate window')));

      const noneWithWindows = validateProviderManifest(
        baseManifest({ rateLimitKind: 'none', rateLimitWindows: ['day'] }),
      );
      assert.equal(noneWithWindows.valid, false);
      assert.ok(noneWithWindows.errors.some((e) => e.includes('rateLimitKind is "none"')));
    });
  });

  describe('HU-38: /api/providers & /api/marketplace exposure', () => {
    it('exposes rateLimitKind and rateLimitWindows on /api/marketplace and /api/providers', async () => {
      const db = openDatabase(':memory:');
      const masterKey = randomBytes(32);

      try {
        const provA = baseManifest({
          id: 'rl-tokens-prov',
          name: 'Tokens Provider',
          rateLimitKind: 'tokens',
          rateLimitWindows: ['day', 'week'],
        });
        const provB = baseManifest({
          id: 'rl-none-prov',
          name: 'Unlimited Provider',
          rateLimitKind: 'none',
        });

        const mockCatalog = await startMockServer((req, res) => {
          if (req.url === '/index.json') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                providers: [
                  { ...provA, approved: true },
                  { ...provB, approved: true },
                ],
              }),
            );
            return;
          }
          res.writeHead(404);
          res.end();
        });

        const app = createApp({
          db,
          masterKey,
          marketplaceUrl: `${mockCatalog.url}/index.json`,
        });

        const setupRes = await app.request('http://localhost/api/setup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'admin', password: 'AdminPassword123!' }),
        });
        assert.equal(setupRes.status, 201);
        const adminCookie = extractCookiePair(setupRes.headers.get('set-cookie'));

        const mktRes = await app.request('http://localhost/api/marketplace', {
          headers: { Cookie: adminCookie },
        });
        assert.equal(mktRes.status, 200);
        const mktBody = (await mktRes.json()) as {
          manifests: Array<{
            id: string;
            rateLimitKind: string | null;
            rateLimitWindows: string[];
          }>;
        };
        const mktA = mktBody.manifests.find((m) => m.id === 'rl-tokens-prov');
        assert.ok(mktA, `Expected rl-tokens-prov in manifests, got: ${JSON.stringify(mktBody)}`);
        assert.equal(mktA.rateLimitKind, 'tokens');
        assert.deepEqual(mktA.rateLimitWindows, ['day', 'week']);

        const installRes = await app.request('http://localhost/api/providers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
          body: JSON.stringify(provA),
        });
        assert.equal(installRes.status, 201);

        const provsRes = await app.request('http://localhost/api/providers', {
          headers: { Cookie: adminCookie },
        });
        assert.equal(provsRes.status, 200);
        const provsBody = (await provsRes.json()) as {
          providers: Array<{
            id: string;
            rateLimitKind: string | null;
            rateLimitWindows: string[];
          }>;
        };
        const installedA = provsBody.providers.find((p) => p.id === 'rl-tokens-prov');
        assert.equal(installedA?.rateLimitKind, 'tokens');
        assert.deepEqual(installedA?.rateLimitWindows, ['day', 'week']);
      } finally {
        db.close();
      }
    });
  });

  describe('HU-39: 3-signal adaptive free-tier quota detection (hour | day | week)', () => {
    it('evaluates configured -> header_exact -> inferred 429 telemetry across sliding windows', async () => {
      const db = openDatabase(':memory:');
      const masterKey = randomBytes(32);
      let clockMs = Date.UTC(2026, 10, 21, 10, 0, 0);
      let upstreamMode: 'ok_headers' | 'rate_limit_429' = 'ok_headers';

      try {
        const mockUpstream = await startMockServer((_req, res) => {
          if (upstreamMode === 'ok_headers') {
            res.writeHead(200, {
              'Content-Type': 'application/json',
              'x-ratelimit-remaining': '42',
              'x-ratelimit-reset': '1800',
            });
            res.end(
              JSON.stringify({
                id: 'chatcmpl-1',
                object: 'chat.completion',
                choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 1000, completion_tokens: 4000, total_tokens: 5000 },
              }),
            );
            return;
          }

          res.writeHead(429, {
            'Content-Type': 'application/json',
            'retry-after': '1800',
          });
          res.end(JSON.stringify({ error: { message: 'Hourly rate limit reached' } }));
        });

        const app = createApp({
          db,
          masterKey,
          now: () => clockMs,
        });

        const setupRes = await app.request('http://localhost/api/setup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'admin', password: 'AdminPassword123!' }),
        });
        assert.equal(setupRes.status, 201);
        const adminCookie = extractCookiePair(setupRes.headers.get('set-cookie'));

        // Create internal API key for /v1/chat/completions
        const keyRes = await app.request('http://localhost/api/keys', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
          body: JSON.stringify({ name: 'quota-test-key' }),
        });
        assert.equal(keyRes.status, 201);
        const { rawKey } = (await keyRes.json()) as { rawKey: string };

        // Install experimental-adapter provider with manifest rateLimitKind='tokens', rateLimitWindows=['week']
        const manifest = {
          schemaVersion: '1.0',
          id: 'adaptive-prov',
          name: 'Adaptive Provider',
          packageType: 'experimental-adapter',
          baseUrl: `${mockUpstream.url}/v1`,
          auth: { type: 'bearer', header: 'Authorization', prefix: 'Bearer ' },
          modelsSource: 'static',
          reviewedAt: '2026-11-21',
          adapter: { defaultPort: 8080, healthPath: '/health' },
          staticModels: [{ id: 'fast-free', name: 'Fast Free' }],
          rateLimitKind: 'tokens',
          rateLimitWindows: ['week'],
        };

        const installRes = await app.request('http://localhost/api/providers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
          body: JSON.stringify(manifest),
        });
        assert.equal(installRes.status, 201);

        // Insert active provider key with manual daily_quota_limit = 100,000
        const nowSec = Math.floor(clockMs / 1000);
        const provKeyId = randomUUID();
        db.prepare(
          `INSERT INTO provider_keys (
             id, provider_id, label, encrypted_secret, last4,
             node_id, forced_node, daily_quota_limit, status, created_at
           ) VALUES (?, 'adaptive-prov', 'Main Key', ?, '9999', NULL, 0, 100000, 'active', ?)`,
        ).run(provKeyId, encryptSecret('sk-upstream-test', masterKey), nowSec);

        // Insert model so /v1/chat/completions resolves it
        db.prepare(
          `INSERT INTO models (
             full_id, provider_id, model_id, name, modalities_json, capabilities_json, is_free, first_seen_at, active
           ) VALUES ('adaptive-prov/fast-free', 'adaptive-prov', 'fast-free', 'Fast Free', '{"input":["text"],"output":["text"]}', '{}', 1, ?, 1)`,
        ).run(nowSec);

        // 1) Signal (b): Before any traffic, should reflect configured manifest window ('week') & confidence ('configured')
        const fqConfiguredRes = await app.request('http://localhost/api/metrics/free-quota', {
          headers: { Cookie: adminCookie },
        });
        assert.equal(fqConfiguredRes.status, 200);
        const fqConfigured = (await fqConfiguredRes.json()) as {
          activeWindow: string;
          confidence: string;
          configuredLimit: number | null;
          effectiveLimit: number | null;
        };
        assert.equal(fqConfigured.activeWindow, 'week');
        assert.equal(fqConfigured.confidence, 'configured');
        assert.equal(fqConfigured.configuredLimit, 100000);
        assert.equal(fqConfigured.effectiveLimit, 100000);

        // 2) Signal (a): Make a successful request returning x-ratelimit-remaining=42, x-ratelimit-reset=1800
        const chatOk = await app.request('http://localhost/v1/chat/completions', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${rawKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'adaptive-prov/fast-free',
            messages: [{ role: 'user', content: 'hi' }],
          }),
        });
        assert.equal(chatOk.status, 200);

        const summaryHeaderRes = await app.request('http://localhost/api/metrics/summary', {
          headers: { Cookie: adminCookie },
        });
        assert.equal(summaryHeaderRes.status, 200);
        const summaryHeader = (await summaryHeaderRes.json()) as {
          activeWindow: string;
          quotaConfidence: string;
          providerQuotas: Array<{
            providerId: string;
            activeWindow: string;
            confidence: string;
            remainingInWindow: number | null;
          }>;
        };
        assert.equal(summaryHeader.activeWindow, 'hour');
        assert.equal(summaryHeader.quotaConfidence, 'header_exact');
        assert.equal(summaryHeader.providerQuotas[0]?.remainingInWindow, 42);

        // 3) Signal (c): Advance clock 60s and trigger a 429 from upstream at 5,000 tokens (below configured 100,000!)
        clockMs += 60_000;
        upstreamMode = 'rate_limit_429';
        const chat429 = await app.request('http://localhost/v1/chat/completions', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${rawKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'adaptive-prov/fast-free',
            messages: [{ role: 'user', content: 'trigger 429' }],
          }),
        });
        assert.equal(chat429.status, 429);

        // Advance clock past retry-after (1801s) so header signal expires and Signal (c) takes over
        clockMs += 1_801_000;

        const fqInferredRes = await app.request('http://localhost/api/metrics/free-quota', {
          headers: { Cookie: adminCookie },
        });
        assert.equal(fqInferredRes.status, 200);
        const fqInferred = (await fqInferredRes.json()) as {
          activeWindow: string;
          confidence: string;
          configuredLimit: number | null;
          effectiveLimit: number | null;
          adaptiveAdjusted: boolean;
          providers: Array<{
            providerId: string;
            inferredLimit: number | null;
            recent429Count7d: number;
            adaptiveAdjusted: boolean;
          }>;
        };
        assert.equal(fqInferred.activeWindow, 'hour');
        assert.equal(fqInferred.confidence, 'inferred');
        assert.equal(fqInferred.configuredLimit, 100000);
        assert.equal(fqInferred.effectiveLimit, 5000);
        assert.equal(fqInferred.adaptiveAdjusted, true);
        assert.equal(fqInferred.providers[0]?.inferredLimit, 5000);
        assert.equal(fqInferred.providers[0]?.recent429Count7d, 1);

        // Verify adaptive adjustment was recorded in system_logs
        const logsRow = db
          .prepare(
            `SELECT message FROM system_logs WHERE message LIKE '%Adaptive quota ceiling adjusted%'`,
          )
          .get() as { message: string } | undefined;
        assert.ok(logsRow, 'Expected adaptive ceiling adjustment entry in system_logs');
      } finally {
        db.close();
      }
    });
  });

  describe('HU-39 v2: Adaptive Free-Tier Quota Engine', () => {
    it('1) RPM burst (retry-after: 60) does NOT lower or poison inferredLimit / effectiveLimit', async () => {
      const db = openDatabase(':memory:');
      const masterKey = randomBytes(32);
      let clockMs = Date.UTC(2026, 10, 21, 12, 0, 0);
      let upstreamMode: 'ok' | 'burst_429' = 'ok';

      try {
        const mockUpstream = await startMockServer((_req, res) => {
          if (upstreamMode === 'ok') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                id: 'chatcmpl-burst-1',
                object: 'chat.completion',
                choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 1000, completion_tokens: 4000, total_tokens: 5000 },
              }),
            );
            return;
          }
          res.writeHead(429, {
            'Content-Type': 'application/json',
            'retry-after': '60',
          });
          res.end(JSON.stringify({ error: { message: 'RPM burst limit' } }));
        });

        const app = createApp({ db, masterKey, now: () => clockMs });
        const setupRes = await app.request('http://localhost/api/setup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'admin', password: 'AdminPassword123!' }),
        });
        const adminCookie = extractCookiePair(setupRes.headers.get('set-cookie'));

        const keyRes = await app.request('http://localhost/api/keys', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
          body: JSON.stringify({ name: 'burst-key' }),
        });
        const { rawKey } = (await keyRes.json()) as { rawKey: string };

        await app.request('http://localhost/api/providers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
          body: JSON.stringify({
            schemaVersion: '1.0',
            id: 'burst-prov',
            name: 'Burst Provider',
            packageType: 'experimental-adapter',
            baseUrl: `${mockUpstream.url}/v1`,
            auth: { type: 'bearer', header: 'Authorization', prefix: 'Bearer ' },
            modelsSource: 'static',
            reviewedAt: '2026-11-21',
            adapter: { defaultPort: 8080, healthPath: '/health' },
            staticModels: [{ id: 'm1', name: 'M1' }],
            rateLimitKind: 'tokens',
            rateLimitWindows: ['day'],
          }),
        });

        const nowSec = Math.floor(clockMs / 1000);
        const provKeyId = randomUUID();
        db.prepare(
          `INSERT INTO provider_keys (
             id, provider_id, label, encrypted_secret, last4,
             node_id, forced_node, daily_quota_limit, status, created_at
           ) VALUES (?, 'burst-prov', 'Key 1', ?, '1111', NULL, 0, 100000, 'active', ?)`,
        ).run(provKeyId, encryptSecret('sk-burst-1', masterKey), nowSec);

        db.prepare(
          `INSERT INTO models (
             full_id, provider_id, model_id, name, modalities_json, capabilities_json, is_free, first_seen_at, active
           ) VALUES ('burst-prov/m1', 'burst-prov', 'm1', 'M1', '{"input":["text"],"output":["text"]}', '{}', 1, ?, 1)`,
        ).run(nowSec);

        // 1 successful request (5,000 tokens)
        const okRes = await app.request('http://localhost/v1/chat/completions', {
          method: 'POST',
          headers: { Authorization: `Bearer ${rawKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'burst-prov/m1', messages: [{ role: 'user', content: 'hi' }] }),
        });
        assert.equal(okRes.status, 200);

        // Trigger short-term RPM burst 429 with retry-after: 60
        clockMs += 10_000;
        upstreamMode = 'burst_429';
        const burstRes = await app.request('http://localhost/v1/chat/completions', {
          method: 'POST',
          headers: { Authorization: `Bearer ${rawKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'burst-prov/m1', messages: [{ role: 'user', content: 'burst' }] }),
        });
        assert.equal(burstRes.status, 429);

        // Check immediately during 60s burst AND after 65s: ceiling must NEVER be poisoned
        for (const advanceMs of [0, 65_000]) {
          clockMs += advanceMs;
          const fqRes = await app.request('http://localhost/api/metrics/free-quota', {
            headers: { Cookie: adminCookie },
          });
          assert.equal(fqRes.status, 200);
          const fq = (await fqRes.json()) as {
            confidence: string;
            configuredLimit: number | null;
            effectiveLimit: number | null;
            adaptiveAdjusted: boolean;
            providers: Array<{
              providerId: string;
              inferredLimit: number | null;
              effectiveLimit: number | null;
              adaptiveAdjusted: boolean;
            }>;
          };
          assert.equal(fq.configuredLimit, 100000);
          assert.equal(fq.effectiveLimit, 100000);
          assert.equal(fq.adaptiveAdjusted, false);
          assert.equal(fq.providers[0]?.inferredLimit, null);
          assert.equal(fq.providers[0]?.effectiveLimit, 100000);
          assert.equal(fq.providers[0]?.adaptiveAdjusted, false);
        }

        // Verify stored event was classified as 'burst'
        const cacheRow = db
          .prepare(`SELECT payload_json FROM external_cache WHERE cache_key = 'adaptive_rl:burst-prov'`)
          .get() as { payload_json: string };
        const events = JSON.parse(cacheRow.payload_json) as Array<{ kind: string; keyId: string }>;
        assert.equal(events[0]?.kind, 'burst');
        assert.equal(events[0]?.keyId, provKeyId);
      } finally {
        db.close();
      }
    });

    it('2) Multi-key provider: 3 active keys where 1 key hits quota at 50 req scales capacity to 150', async () => {
      const db = openDatabase(':memory:');
      const masterKey = randomBytes(32);
      const clockMs = Date.UTC(2026, 10, 21, 13, 0, 0);
      const nowSec = Math.floor(clockMs / 1000);

      try {
        const app = createApp({ db, masterKey, now: () => clockMs });
        const setupRes = await app.request('http://localhost/api/setup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'admin', password: 'AdminPassword123!' }),
        });
        const adminCookie = extractCookiePair(setupRes.headers.get('set-cookie'));
        const userRow = db.prepare(`SELECT id FROM users WHERE username = 'admin'`).get() as { id: string };

        await app.request('http://localhost/api/providers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
          body: JSON.stringify(
            baseManifest({
              id: 'multi-key-prov',
              name: 'Multi-Key Provider',
              rateLimitKind: 'requests',
              rateLimitWindows: ['day'],
            }),
          ),
        });

        const key1 = randomUUID();
        const key2 = randomUUID();
        const key3 = randomUUID();
        const insertKey = db.prepare(
          `INSERT INTO provider_keys (
             id, provider_id, label, encrypted_secret, last4,
             node_id, forced_node, daily_quota_limit, status, created_at
           ) VALUES (?, 'multi-key-prov', ?, ?, ?, NULL, 0, NULL, 'active', ?)`,
        );
        insertKey.run(key1, 'Key 1', encryptSecret('sk-1', masterKey), '0001', nowSec - 300);
        insertKey.run(key2, 'Key 2', encryptSecret('sk-2', masterKey), '0002', nowSec - 200);
        insertKey.run(key3, 'Key 3', encryptSecret('sk-3', masterKey), '0003', nowSec - 100);

        // Insert 50 successful requests for key1 in current window
        const insertUsage = db.prepare(
          `INSERT INTO usage_logs (
             user_id, provider_id, provider_key_id, model_full_id,
             prompt_tokens, completion_tokens, reasoning_tokens, cached_tokens,
             duration_ms, status, created_at
           ) VALUES (?, 'multi-key-prov', ?, 'multi-key-prov/test-model', 100, 100, 0, 0, 50, 'ok', ?)`,
        );
        for (let i = 0; i < 50; i++) {
          insertUsage.run(userRow.id, key1, nowSec - 1000 + i);
        }

        // Record a real quota 429 event on key1 at 50 requests
        db.prepare(
          `INSERT INTO external_cache (cache_key, payload_json, etag, fetched_at)
           VALUES ('adaptive_rl:multi-key-prov', ?, NULL, ?)`,
        ).run(
          JSON.stringify([
            {
              keyId: key1,
              kind: 'quota',
              windowSeconds: 86400,
              observedTokens: 10000,
              observedRequests: 50,
              resetDeltaSec: 86400,
              createdAt: nowSec - 10,
            },
          ]),
          nowSec - 10,
        );

        const fqRes = await app.request('http://localhost/api/metrics/free-quota', {
          headers: { Cookie: adminCookie },
        });
        assert.equal(fqRes.status, 200);
        const fq = (await fqRes.json()) as {
          effectiveLimit: number | null;
          usedInWindow: number;
          remainingInWindow: number | null;
          providers: Array<{
            providerId: string;
            unit: string;
            usableKeysCount: number;
            inferredLimit: number | null;
            effectiveLimit: number | null;
            usedInWindow: number;
            remainingInWindow: number | null;
          }>;
        };
        const prov = fq.providers[0]!;
        assert.equal(prov.unit, 'requests');
        assert.equal(prov.usableKeysCount, 3);
        assert.equal(prov.inferredLimit, 150);
        assert.equal(prov.effectiveLimit, 150);
        assert.equal(prov.usedInWindow, 50);
        assert.equal(prov.remainingInWindow, 100);
        assert.equal(fq.effectiveLimit, 150);
        assert.equal(fq.remainingInWindow, 100);
      } finally {
        db.close();
      }
    });

    it('3) Arbitrary windows: retry-after 1800 -> 30m, 14400 -> 4h, 18000 -> 5h', async () => {
      const cases = [
        { retryAfter: 1800, expectedLabel: '30m', expectedActive: 'hour' },
        { retryAfter: 14400, expectedLabel: '4h', expectedActive: 'day' },
        { retryAfter: 18000, expectedLabel: '5h', expectedActive: 'day' },
      ];

      for (const tc of cases) {
        const db = openDatabase(':memory:');
        const masterKey = randomBytes(32);
        const clockMs = Date.UTC(2026, 10, 21, 14, 0, 0);
        const nowSec = Math.floor(clockMs / 1000);

        try {
          const app = createApp({ db, masterKey, now: () => clockMs });
          const setupRes = await app.request('http://localhost/api/setup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'admin', password: 'AdminPassword123!' }),
          });
          const adminCookie = extractCookiePair(setupRes.headers.get('set-cookie'));

          await app.request('http://localhost/api/providers', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
            body: JSON.stringify(
              baseManifest({
                id: 'arb-win-prov',
                name: 'Arbitrary Window Provider',
                rateLimitKind: 'tokens',
                rateLimitWindows: ['day'],
              }),
            ),
          });

          const keyId = randomUUID();
          db.prepare(
            `INSERT INTO provider_keys (
               id, provider_id, label, encrypted_secret, last4,
               node_id, forced_node, daily_quota_limit, status, created_at
             ) VALUES (?, 'arb-win-prov', 'Key 1', ?, '2222', NULL, 0, 100000, 'active', ?)`,
          ).run(keyId, encryptSecret('sk-arb', masterKey), nowSec - 100);

          db.prepare(
            `INSERT INTO external_cache (cache_key, payload_json, etag, fetched_at)
             VALUES ('adaptive_rl:arb-win-prov', ?, NULL, ?)`,
          ).run(
            JSON.stringify([
              {
                keyId,
                kind: 'quota',
                windowSeconds: tc.retryAfter,
                observedTokens: 5000,
                observedRequests: 10,
                resetDeltaSec: tc.retryAfter,
                createdAt: nowSec - 30,
              },
            ]),
            nowSec - 30,
          );

          const fqRes = await app.request('http://localhost/api/metrics/free-quota', {
            headers: { Cookie: adminCookie },
          });
          assert.equal(fqRes.status, 200);
          const fq = (await fqRes.json()) as {
            activeWindow: string;
            windowSeconds: number;
            windowLabel: string;
            providers: Array<{
              activeWindow: string;
              windowSeconds: number;
              windowLabel: string;
            }>;
          };
          assert.equal(fq.windowSeconds, tc.retryAfter);
          assert.equal(fq.windowLabel, tc.expectedLabel);
          assert.equal(fq.activeWindow, tc.expectedActive);
          assert.equal(fq.providers[0]?.windowSeconds, tc.retryAfter);
          assert.equal(fq.providers[0]?.windowLabel, tc.expectedLabel);
          assert.equal(fq.providers[0]?.activeWindow, tc.expectedActive);
        } finally {
          db.close();
        }
      }
    });

    it('4) Excludes disabled, no_node, and error keys from configuredLimit and usableKeysCount', async () => {
      const db = openDatabase(':memory:');
      const masterKey = randomBytes(32);
      const clockMs = Date.UTC(2026, 10, 21, 15, 0, 0);
      const nowSec = Math.floor(clockMs / 1000);

      try {
        const app = createApp({ db, masterKey, now: () => clockMs });
        const setupRes = await app.request('http://localhost/api/setup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'admin', password: 'AdminPassword123!' }),
        });
        const adminCookie = extractCookiePair(setupRes.headers.get('set-cookie'));

        await app.request('http://localhost/api/providers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
          body: JSON.stringify(
            baseManifest({
              id: 'usable-keys-prov',
              name: 'Usable Keys Provider',
              rateLimitKind: 'tokens',
              rateLimitWindows: ['day'],
            }),
          ),
        });

        const insertKey = db.prepare(
          `INSERT INTO provider_keys (
             id, provider_id, label, encrypted_secret, last4,
             node_id, forced_node, daily_quota_limit, status, created_at
           ) VALUES (?, 'usable-keys-prov', ?, ?, ?, NULL, 0, 10000, ?, ?)`,
        );
        insertKey.run(randomUUID(), 'Active Key', encryptSecret('sk-a', masterKey), '0001', 'active', nowSec);
        insertKey.run(randomUUID(), 'Rate Limited Key', encryptSecret('sk-rl', masterKey), '0002', 'rate_limited', nowSec);
        insertKey.run(randomUUID(), 'Disabled Key', encryptSecret('sk-d', masterKey), '0003', 'disabled', nowSec);
        insertKey.run(randomUUID(), 'No Node Key', encryptSecret('sk-nn', masterKey), '0004', 'no_node', nowSec);
        insertKey.run(randomUUID(), 'Error Key', encryptSecret('sk-e', masterKey), '0005', 'error', nowSec);

        const fqRes = await app.request('http://localhost/api/metrics/free-quota', {
          headers: { Cookie: adminCookie },
        });
        assert.equal(fqRes.status, 200);
        const fq = (await fqRes.json()) as {
          configuredLimit: number | null;
          effectiveLimit: number | null;
          providers: Array<{
            usableKeysCount: number;
            configuredLimit: number | null;
            effectiveLimit: number | null;
          }>;
        };
        assert.equal(fq.providers[0]?.usableKeysCount, 2);
        assert.equal(fq.providers[0]?.configuredLimit, 20000);
        assert.equal(fq.providers[0]?.effectiveLimit, 20000);
        assert.equal(fq.configuredLimit, 20000);
        assert.equal(fq.effectiveLimit, 20000);
      } finally {
        db.close();
      }
    });

    it('5) Auto-healing upward: when a key later succeeds with usage > old inferred ceiling, stale ceiling is healed', async () => {
      const db = openDatabase(':memory:');
      const masterKey = randomBytes(32);
      const clockMs = Date.UTC(2026, 10, 21, 16, 0, 0);
      const nowSec = Math.floor(clockMs / 1000);

      try {
        const app = createApp({ db, masterKey, now: () => clockMs });
        const setupRes = await app.request('http://localhost/api/setup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'admin', password: 'AdminPassword123!' }),
        });
        const adminCookie = extractCookiePair(setupRes.headers.get('set-cookie'));
        const userRow = db.prepare(`SELECT id FROM users WHERE username = 'admin'`).get() as { id: string };

        await app.request('http://localhost/api/providers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
          body: JSON.stringify(
            baseManifest({
              id: 'heal-prov',
              name: 'Auto-Heal Provider',
              rateLimitKind: 'tokens',
              rateLimitWindows: ['day'],
            }),
          ),
        });

        const keyId = randomUUID();
        db.prepare(
          `INSERT INTO provider_keys (
             id, provider_id, label, encrypted_secret, last4,
             node_id, forced_node, daily_quota_limit, status, created_at
           ) VALUES (?, 'heal-prov', 'Key 1', ?, '3333', NULL, 0, 100000, 'active', ?)`,
        ).run(keyId, encryptSecret('sk-heal', masterKey), nowSec - 5000);

        // Old quota 429 inferred a ceiling of 5,000 tokens
        db.prepare(
          `INSERT INTO external_cache (cache_key, payload_json, etag, fetched_at)
           VALUES ('adaptive_rl:heal-prov', ?, NULL, ?)`,
        ).run(
          JSON.stringify([
            {
              keyId,
              kind: 'quota',
              windowSeconds: 86400,
              observedTokens: 5000,
              observedRequests: 5,
              resetDeltaSec: 86400,
              createdAt: nowSec - 3600,
            },
          ]),
          nowSec - 3600,
        );

        // Before exceeding 5,000 tokens, inferred ceiling is active at 5,000
        const beforeRes = await app.request('http://localhost/api/metrics/free-quota', {
          headers: { Cookie: adminCookie },
        });
        const before = (await beforeRes.json()) as {
          effectiveLimit: number | null;
          adaptiveAdjusted: boolean;
          providers: Array<{ inferredLimit: number | null }>;
        };
        assert.equal(before.effectiveLimit, 5000);
        assert.equal(before.adaptiveAdjusted, true);
        assert.equal(before.providers[0]?.inferredLimit, 5000);

        // Key now completes successful requests totaling 12,000 tokens (> 5,000!)
        db.prepare(
          `INSERT INTO usage_logs (
             user_id, provider_id, provider_key_id, model_full_id,
             prompt_tokens, completion_tokens, reasoning_tokens, cached_tokens,
             duration_ms, status, created_at
           ) VALUES (?, 'heal-prov', ?, 'heal-prov/test-model', 6000, 6000, 0, 0, 100, 'ok', ?)`,
        ).run(userRow.id, keyId, nowSec - 60);

        // Stale 5,000 ceiling must be healed upward -> falls back to configured 100,000
        const afterRes = await app.request('http://localhost/api/metrics/free-quota', {
          headers: { Cookie: adminCookie },
        });
        const after = (await afterRes.json()) as {
          confidence: string;
          configuredLimit: number | null;
          effectiveLimit: number | null;
          remainingInWindow: number | null;
          adaptiveAdjusted: boolean;
          providers: Array<{ inferredLimit: number | null; usedInWindow: number }>;
        };
        assert.equal(after.providers[0]?.inferredLimit, null);
        assert.equal(after.providers[0]?.usedInWindow, 12000);
        assert.equal(after.effectiveLimit, 100000);
        assert.equal(after.remainingInWindow, 88000);
        assert.equal(after.adaptiveAdjusted, false);
        assert.equal(after.confidence, 'configured');
      } finally {
        db.close();
      }
    });

    it('6) Mixed units (tokens + requests) are NOT summed into effectiveLimit, and concurrency providers never mark exhausted quota', async () => {
      const db = openDatabase(':memory:');
      const masterKey = randomBytes(32);
      const clockMs = Date.UTC(2026, 10, 21, 17, 0, 0);
      const nowSec = Math.floor(clockMs / 1000);

      try {
        const app = createApp({ db, masterKey, now: () => clockMs });
        const setupRes = await app.request('http://localhost/api/setup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'admin', password: 'AdminPassword123!' }),
        });
        const adminCookie = extractCookiePair(setupRes.headers.get('set-cookie'));
        const userRow = db.prepare(`SELECT id FROM users WHERE username = 'admin'`).get() as { id: string };

        // Provider 1: tokens (limit 100,000, used 20,000 -> 80% remaining)
        await app.request('http://localhost/api/providers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
          body: JSON.stringify(
            baseManifest({
              id: 'tok-prov',
              name: 'Tokens Prov',
              rateLimitKind: 'tokens',
              rateLimitWindows: ['day'],
            }),
          ),
        });
        const tokKey = randomUUID();
        db.prepare(
          `INSERT INTO provider_keys (
             id, provider_id, label, encrypted_secret, last4,
             node_id, forced_node, daily_quota_limit, status, created_at
           ) VALUES (?, 'tok-prov', 'Tok Key', ?, '4444', NULL, 0, 100000, 'active', ?)`,
        ).run(tokKey, encryptSecret('sk-tok', masterKey), nowSec);
        db.prepare(
          `INSERT INTO usage_logs (
             user_id, provider_id, provider_key_id, model_full_id,
             prompt_tokens, completion_tokens, reasoning_tokens, cached_tokens,
             duration_ms, status, created_at
           ) VALUES (?, 'tok-prov', ?, 'tok-prov/test-model', 10000, 10000, 0, 0, 100, 'ok', ?)`,
        ).run(userRow.id, tokKey, nowSec - 100);

        // Provider 2: requests (limit 100, used 50 -> 50% remaining)
        await app.request('http://localhost/api/providers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
          body: JSON.stringify(
            baseManifest({
              id: 'req-prov',
              name: 'Requests Prov',
              rateLimitKind: 'requests',
              rateLimitWindows: ['day'],
            }),
          ),
        });
        const reqKey = randomUUID();
        db.prepare(
          `INSERT INTO provider_keys (
             id, provider_id, label, encrypted_secret, last4,
             node_id, forced_node, daily_quota_limit, status, created_at
           ) VALUES (?, 'req-prov', 'Req Key', ?, '5555', NULL, 0, 100, 'active', ?)`,
        ).run(reqKey, encryptSecret('sk-req', masterKey), nowSec);
        const insReq = db.prepare(
          `INSERT INTO usage_logs (
             user_id, provider_id, provider_key_id, model_full_id,
             prompt_tokens, completion_tokens, reasoning_tokens, cached_tokens,
             duration_ms, status, created_at
           ) VALUES (?, 'req-prov', ?, 'req-prov/test-model', 10, 10, 0, 0, 50, 'ok', ?)`,
        );
        for (let i = 0; i < 50; i++) {
          insReq.run(userRow.id, reqKey, nowSec - 200 + i);
        }

        // Provider 3: concurrency (even if it had a 429 event, never marks exhausted quota!)
        await app.request('http://localhost/api/providers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
          body: JSON.stringify(
            baseManifest({
              id: 'conc-prov',
              name: 'Concurrency Prov',
              rateLimitKind: 'concurrency',
              rateLimitWindows: [],
            }),
          ),
        });
        const concKey = randomUUID();
        db.prepare(
          `INSERT INTO provider_keys (
             id, provider_id, label, encrypted_secret, last4,
             node_id, forced_node, daily_quota_limit, status, created_at
           ) VALUES (?, 'conc-prov', 'Conc Key', ?, '6666', NULL, 0, NULL, 'active', ?)`,
        ).run(concKey, encryptSecret('sk-conc', masterKey), nowSec);
        db.prepare(
          `INSERT INTO external_cache (cache_key, payload_json, etag, fetched_at)
           VALUES ('adaptive_rl:conc-prov', ?, NULL, ?)`,
        ).run(
          JSON.stringify([
            {
              keyId: concKey,
              kind: 'quota',
              windowSeconds: 3600,
              observedTokens: 500,
              observedRequests: 2,
              resetDeltaSec: 3600,
              createdAt: nowSec - 30,
            },
          ]),
          nowSec - 30,
        );

        const fqRes = await app.request('http://localhost/api/metrics/free-quota', {
          headers: { Cookie: adminCookie },
        });
        assert.equal(fqRes.status, 200);
        const fq = (await fqRes.json()) as {
          configuredLimit: number | null;
          effectiveLimit: number | null;
          remainingInWindow: number | null;
          quotaPercentageRemaining: number | null;
          providers: Array<{
            providerId: string;
            rateLimitKind: string | null;
            unit: string;
            confidence: string;
            inferredLimit: number | null;
            effectiveLimit: number | null;
            remainingInWindow: number | null;
            adaptiveAdjusted: boolean;
          }>;
        };

        // Mixed units MUST NOT sum 100,000 tokens + 100 requests = 100,100
        assert.equal(fq.configuredLimit, null);
        assert.equal(fq.effectiveLimit, null);
        assert.equal(fq.remainingInWindow, null);
        // Average health across tok-prov (80%) and req-prov (50%) = 65%
        assert.equal(fq.quotaPercentageRemaining, 65);

        const tokP = fq.providers.find((p) => p.providerId === 'tok-prov');
        const reqP = fq.providers.find((p) => p.providerId === 'req-prov');
        const concP = fq.providers.find((p) => p.providerId === 'conc-prov');

        assert.equal(tokP?.unit, 'tokens');
        assert.equal(tokP?.effectiveLimit, 100000);
        assert.equal(tokP?.remainingInWindow, 80000);

        assert.equal(reqP?.unit, 'requests');
        assert.equal(reqP?.effectiveLimit, 100);
        assert.equal(reqP?.remainingInWindow, 50);

        assert.equal(concP?.rateLimitKind, 'concurrency');
        assert.equal(concP?.unit, 'none');
        assert.equal(concP?.confidence, 'configured');
        assert.equal(concP?.inferredLimit, null);
        assert.equal(concP?.effectiveLimit, null);
        assert.equal(concP?.remainingInWindow, null);
        assert.equal(concP?.adaptiveAdjusted, false);
      } finally {
        db.close();
      }
    });
  });
});

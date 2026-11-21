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
});

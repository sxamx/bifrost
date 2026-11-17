import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, it } from 'node:test';

import { createApp } from '../core/src/app.js';
import { decryptSecret, hashPassword } from '../core/src/crypto.js';
import { openDatabase } from '../core/src/db.js';

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

function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? (JSON.parse(raw) as Record<string, unknown>) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function extractCookiePair(setCookieHeader: string | null): string {
  assert.ok(setCookieHeader, 'Expected Set-Cookie header');
  return setCookieHeader.split(';')[0]!;
}

function createDeferred<T = void>() {
  let resolve!: (val: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

afterEach(async () => {
  while (openServers.length > 0) {
    const srv = openServers.pop()!;
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
});

describe('Phase 2 Backend Acceptance Tests (HU-06, HU-06b, HU-06c, HU-07, HU-09, HU-10)', () => {
  describe('HU-06: Marketplace catalog, offline resilience, and strict manifest validation', () => {
    it('fetches online catalog, handles offline catalog gracefully without crashing, and validates manifests against provider.schema.json', async () => {
      const db = openDatabase(':memory:');
      const masterKey = randomBytes(32);

      try {
        const mockCatalog = await startMockServer((req, res) => {
          if (req.url === '/index.json') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                providers: [
                  {
                    schemaVersion: '1.0',
                    id: 'openrouter',
                    name: 'OpenRouter',
                    category: 'aggregator',
                    packageType: 'official-json',
                    verified: true,
                    publishedAt: '2026-11-17',
                    baseUrl: 'https://openrouter.ai/api/v1',
                    auth: { type: 'bearer', header: 'Authorization', prefix: 'Bearer ' },
                    modelsSource: 'api',
                    modelsEndpoint: '/models',
                    freeRule: {
                      priceZeroPaths: ['pricing.prompt', 'pricing.completion'],
                      requiredEndpoint: '/api/v1/chat/completions',
                      idSuffix: ':free',
                    },
                  },
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

        const setupRes = await app.request('/api/setup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'admin', password: 'admin-password-123' }),
        });
        const adminCookie = extractCookiePair(setupRes.headers.get('set-cookie'));

        // Never auto-installs providers on startup
        const initialProvRes = await app.request('/api/providers', {
          headers: { Cookie: adminCookie },
        });
        assert.deepEqual(await initialProvRes.json(), { providers: [] });

        // Online marketplace fetch
        const marketRes = await app.request('/api/marketplace', {
          headers: { Cookie: adminCookie },
        });
        assert.equal(marketRes.status, 200);
        const marketJson = (await marketRes.json()) as {
          online: boolean;
          offline: boolean;
          providers: Array<{ id: string }>;
        };
        assert.equal(marketJson.online, true);
        assert.equal(marketJson.offline, false);
        assert.equal(marketJson.providers.length, 1);
        assert.equal(marketJson.providers[0]!.id, 'openrouter');

        // Offline marketplace (unreachable port / connection refused on fresh DB) NEVER crashes
        const dbOffline = openDatabase(':memory:');
        try {
          const offlineApp = createApp({
            db: dbOffline,
            masterKey,
            marketplaceUrl: 'http://127.0.0.1:1/unreachable-catalog.json',
          });
          const sRes = await offlineApp.request('/api/setup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'admin', password: 'admin-password-123' }),
          });
          const offCookie = extractCookiePair(sRes.headers.get('set-cookie'));

          const offMarketRes = await offlineApp.request('/api/marketplace', {
            headers: { Cookie: offCookie },
          });
          assert.equal(offMarketRes.status, 200);
          const offBody = (await offMarketRes.json()) as {
            online: boolean;
            offline: boolean;
            providers: Array<{ id: string }>;
            error: string;
          };
          assert.equal(offBody.online, false);
          assert.equal(offBody.offline, true);
          assert.ok(Array.isArray(offBody.providers));
          assert.ok(offBody.providers.length >= 1, 'Includes local reference seed manifests');
          assert.ok(typeof offBody.error === 'string' && offBody.error.length > 0);
        } finally {
          dbOffline.close();
        }

        // Strict schema validation rejects invalid manifests (unknown field, missing reviewedAt on static)
        const invalidAdditionalRes = await app.request('/api/providers', {
          method: 'POST',
          headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            schemaVersion: '1.0',
            id: 'bad-provider',
            name: 'Bad Provider',
            packageType: 'official-json',
            baseUrl: 'https://example.com/v1',
            auth: { type: 'bearer', header: 'Authorization' },
            modelsSource: 'api',
            modelsEndpoint: '/models',
            unexpectedExtraField: true,
          }),
        });
        assert.equal(invalidAdditionalRes.status, 400);

        const invalidStaticRes = await app.request('/api/providers', {
          method: 'POST',
          headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            schemaVersion: '1.0',
            id: 'static-missing-date',
            name: 'Static Missing Date',
            packageType: 'official-json',
            baseUrl: 'https://example.com/v1',
            auth: { type: 'bearer', header: 'Authorization' },
            modelsSource: 'static',
            staticModels: [{ id: 'm1', name: 'M1' }],
          }),
        });
        assert.equal(invalidStaticRes.status, 400);

        // Install valid provider from marketplace
        const installRes = await app.request('/api/marketplace/install', {
          method: 'POST',
          headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: 'openrouter' }),
        });
        assert.equal(installRes.status, 201);
        const installBody = (await installRes.json()) as {
          provider: { id: string; modelsCount: number; keysCount: number };
        };
        assert.equal(installBody.provider.id, 'openrouter');
        assert.equal(installBody.provider.modelsCount, 0);
        assert.equal(installBody.provider.keysCount, 0);
      } finally {
        db.close();
      }
    });
  });

  describe('HU-07: Encrypted Provider Keys Vault & Node Auto-Assignment', () => {
    it('encrypts secrets with AES-256-GCM, exposes only last4 in API, blocks guest access, and balances keys across online nodes', async () => {
      const db = openDatabase(':memory:');
      const masterKey = randomBytes(32);

      try {
        const app = createApp({ db, masterKey });
        const setupRes = await app.request('/api/setup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'admin', password: 'admin-password-123' }),
        });
        const adminCookie = extractCookiePair(setupRes.headers.get('set-cookie'));

        // Seed 2 online nodes and 1 offline node
        const nowSec = Math.floor(Date.now() / 1000);
        db.prepare(
          `INSERT INTO nodes (id, name, mode, endpoint, token_hash, last_rotated_at, status, created_at)
           VALUES
             ('node-a', 'Tailscale VM 1', 'tailscale', '100.64.0.1:8443', 'h1', ?, 'online', ?),
             ('node-b', 'Tailscale VM 2', 'tailscale', '100.64.0.2:8443', 'h2', ?, 'online', ?),
             ('node-off', 'Offline VM', 'tailscale', '100.64.0.3:8443', 'h3', ?, 'offline', ?)`,
        ).run(nowSec, nowSec, nowSec, nowSec + 1, nowSec, nowSec + 2);

        // Install provider via local manifest POST /api/providers
        const provRes = await app.request('/api/providers', {
          method: 'POST',
          headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            schemaVersion: '1.0',
            id: 'openrouter',
            name: 'OpenRouter',
            packageType: 'official-json',
            baseUrl: 'https://openrouter.ai/api/v1',
            auth: { type: 'bearer', header: 'Authorization' },
            modelsSource: 'api',
            modelsEndpoint: '/models',
          }),
        });
        assert.equal(provRes.status, 201);

        // Add two keys and verify round-robin / least-loaded online node assignment
        const secret1 = 'sk-or-v1-ultra-confidential-key-alpha-7788';
        const secret2 = 'sk-or-v1-ultra-confidential-key-bravo-9900';

        const k1Res = await app.request('/api/providers/openrouter/keys', {
          method: 'POST',
          headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({ label: 'Cuenta Principal', secret: secret1, dailyQuotaLimit: 50000 }),
        });
        assert.equal(k1Res.status, 201);
        const k1Body = (await k1Res.json()) as { key: Record<string, unknown> };
        assert.equal(k1Body.key.last4, '7788');
        assert.equal(k1Body.key.nodeId, 'node-a');
        assert.equal('secret' in k1Body.key, false);
        assert.equal('encrypted_secret' in k1Body.key, false);

        const k2Res = await app.request('/api/providers/openrouter/keys', {
          method: 'POST',
          headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({ label: 'Cuenta Secundaria', secret: secret2 }),
        });
        assert.equal(k2Res.status, 201);
        const k2Body = (await k2Res.json()) as { key: Record<string, unknown> };
        assert.equal(k2Body.key.last4, '9900');
        assert.equal(k2Body.key.nodeId, 'node-b');

        // Verify GET /api/providers/openrouter/keys never leaks plaintext or encrypted blob
        const listRes = await app.request('/api/providers/openrouter/keys', {
          headers: { Cookie: adminCookie },
        });
        assert.equal(listRes.status, 200);
        const listRawText = await listRes.text();
        assert.ok(!listRawText.includes(secret1));
        assert.ok(!listRawText.includes(secret2));

        // Verify SQLite stores real AES-256-GCM ciphertext (not plaintext) and logs contain zero secrets
        const dbRow = db
          .prepare(`SELECT encrypted_secret FROM provider_keys WHERE id = ?`)
          .get(String(k1Body.key.id)) as { encrypted_secret: Uint8Array };
        assert.equal(Buffer.from(dbRow.encrypted_secret).includes(Buffer.from(secret1)), false);
        assert.equal(decryptSecret(dbRow.encrypted_secret, masterKey), secret1);

        const sysLogs = JSON.stringify(db.prepare(`SELECT * FROM system_logs`).all());
        assert.equal(sysLogs.includes(secret1), false);
        assert.equal(sysLogs.includes(secret2), false);

        // Verify guest cannot view or add provider keys (403)
        const guestPw = await hashPassword('guest-pass-1234');
        db.prepare(
          `INSERT INTO users (id, username, password_hash, role, daily_token_limit, quota_reset_mode, created_at)
           VALUES (?, 'guest1', ?, 'guest', 5000, 'utc_midnight', ?)`,
        ).run(randomUUID(), guestPw, nowSec);

        const guestLogin = await app.request('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'guest1', password: 'guest-pass-1234' }),
        });
        const guestCookie = extractCookiePair(guestLogin.headers.get('set-cookie'));

        const guestKeysRes = await app.request('/api/providers/openrouter/keys', {
          headers: { Cookie: guestCookie },
        });
        assert.equal(guestKeysRes.status, 403);
      } finally {
        db.close();
      }
    });
  });

  describe('HU-06b & HU-06c: Detect & Reload Models (OpenRouter freeRule + static reviewedAt + diff preserving history)', () => {
    it('filters free chat models via freeRule, reports "2 nuevos, 1 retirado" on reload, and preserves retired models with usage_logs history', async () => {
      const db = openDatabase(':memory:');
      const masterKey = randomBytes(32);

      let catalogPhase: 1 | 2 = 1;
      let receivedAuthHeader = '';

      try {
        const mockUpstream = await startMockServer((req, res) => {
          if (req.url === '/v1/models' && req.method === 'GET') {
            receivedAuthHeader = String(req.headers.authorization ?? '');
            const models =
              catalogPhase === 1
                ? [
                    // 1. Free chat model A (will have usage history, then be retired in phase 2)
                    {
                      id: 'deepseek/deepseek-r1:free',
                      name: 'DeepSeek R1 (free)',
                      created: 1737331200,
                      context_length: 65536,
                      pricing: { prompt: '0', completion: '0' },
                      endpoints: ['/api/v1/chat/completions'],
                      supported_parameters: ['reasoning', 'tools'],
                    },
                    // 2. Free chat model B (stays active in phase 2)
                    {
                      id: 'google/gemma-3-27b-it:free',
                      name: 'Gemma 3 27B (free)',
                      created: 1741000000,
                      context_length: 131072,
                      pricing: { prompt: '0', completion: '0' },
                      endpoints: ['/api/v1/chat/completions'],
                    },
                    // 3. Paid model -> must be excluded by priceZeroPaths & idSuffix
                    {
                      id: 'openai/gpt-4o',
                      name: 'GPT-4o',
                      pricing: { prompt: '0.0000025', completion: '0.00001' },
                      endpoints: ['/api/v1/chat/completions'],
                    },
                    // 4. Free embedding model -> must be excluded by requiredEndpoint
                    {
                      id: 'nomic/embed-text:free',
                      name: 'Nomic Embed (free)',
                      pricing: { prompt: '0', completion: '0' },
                      endpoints: ['/api/v1/embeddings'],
                    },
                    // 5. Router meta entry with 0 placeholder price but no :free suffix -> excluded by idSuffix
                    {
                      id: 'openrouter/auto',
                      name: 'Auto Router',
                      pricing: { prompt: '0', completion: '0' },
                      endpoints: ['/api/v1/chat/completions'],
                    },
                  ]
                : [
                    // deepseek-r1:free retired!
                    // gemma-3-27b-it:free remains!
                    {
                      id: 'google/gemma-3-27b-it:free',
                      name: 'Gemma 3 27B (free)',
                      created: 1741000000,
                      context_length: 131072,
                      pricing: { prompt: '0', completion: '0' },
                      endpoints: ['/api/v1/chat/completions'],
                    },
                    // 2 brand-new free chat models!
                    {
                      id: 'qwen/qwen3-32b:free',
                      name: 'Qwen 3 32B (free)',
                      created: 1745000000,
                      context_length: 32768,
                      pricing: { prompt: '0', completion: '0' },
                      endpoints: ['/api/v1/chat/completions'],
                    },
                    {
                      id: 'meta-llama/llama-4-scout:free',
                      name: 'Llama 4 Scout (free)',
                      created: 1746000000,
                      context_length: 131072,
                      pricing: { prompt: '0', completion: '0' },
                      endpoints: ['/api/v1/chat/completions'],
                    },
                  ];

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ data: models }));
            return;
          }
          res.writeHead(404);
          res.end();
        });

        let clockMs = Date.parse('2026-11-17T18:00:00.000Z');
        const app = createApp({ db, masterKey, now: () => clockMs });

        const setupRes = await app.request('/api/setup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'admin', password: 'admin-password-123' }),
        });
        const adminCookie = extractCookiePair(setupRes.headers.get('set-cookie'));
        const { user: adminUser } = (await setupRes.json()) as { user: { id: string } };

        // Install dynamic OpenRouter-like provider pointing to mockUpstream
        const installRes = await app.request('/api/providers', {
          method: 'POST',
          headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            schemaVersion: '1.0',
            id: 'openrouter',
            name: 'OpenRouter',
            category: 'aggregator',
            packageType: 'official-json',
            verified: true,
            baseUrl: `${mockUpstream.url}/v1`,
            auth: { type: 'bearer', header: 'Authorization', prefix: 'Bearer ' },
            modelsSource: 'api',
            modelsEndpoint: '/models',
            freeRule: {
              priceZeroPaths: ['pricing.prompt', 'pricing.completion'],
              requiredEndpoint: '/api/v1/chat/completions',
              idSuffix: ':free',
            },
          }),
        });
        assert.equal(installRes.status, 201);

        // Before adding a key: detect-models fails with 400, and models table is empty
        const detectNoKey = await app.request('/api/providers/openrouter/detect-models', {
          method: 'POST',
          headers: { Cookie: adminCookie },
        });
        assert.equal(detectNoKey.status, 400);

        const modelsBefore = await app.request('/api/models', {
          headers: { Cookie: adminCookie },
        });
        assert.deepEqual(await modelsBefore.json(), { models: [] });

        // Register provider key
        await app.request('/api/providers/openrouter/keys', {
          method: 'POST',
          headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({ label: 'OR Key 1', secret: 'sk-or-test-secret-1111' }),
        });

        // Initial detect-models (Phase 1 catalog)
        const detectRes = await app.request('/api/providers/openrouter/detect-models', {
          method: 'POST',
          headers: { Cookie: adminCookie },
        });
        assert.equal(detectRes.status, 200);
        assert.equal(receivedAuthHeader, 'Bearer sk-or-test-secret-1111');

        const detectDiff = (await detectRes.json()) as {
          addedCount: number;
          removedCount: number;
          totalActive: number;
          summary: string;
          models: Array<{
            fullId: string;
            firstSeenAt: number;
            capabilities: { tools: boolean; reasoning: boolean };
          }>;
        };
        assert.equal(detectDiff.addedCount, 2);
        assert.equal(detectDiff.removedCount, 0);
        assert.equal(detectDiff.totalActive, 2);
        assert.deepEqual(
          detectDiff.models.map((m) => m.fullId),
          ['openrouter/deepseek/deepseek-r1:free', 'openrouter/google/gemma-3-27b-it:free'],
        );
        const r1 = detectDiff.models.find((m) => m.fullId === 'openrouter/deepseek/deepseek-r1:free')!;
        assert.equal(r1.firstSeenAt, Math.floor(clockMs / 1000));
        assert.equal(r1.capabilities.reasoning, true);
        assert.equal(r1.capabilities.tools, true);

        // Insert historical usage_logs for deepseek-r1:free
        db.prepare(
          `INSERT INTO usage_logs (user_id, provider_id, model_full_id, prompt_tokens, completion_tokens, duration_ms, status, created_at)
           VALUES (?, 'openrouter', 'openrouter/deepseek/deepseek-r1:free', 120, 340, 800, 'ok', ?)`,
        ).run(adminUser.id, Math.floor(clockMs / 1000));

        // Switch upstream to Phase 2 catalog (2 added, 1 retired) and advance clock
        catalogPhase = 2;
        clockMs += 3600_000;

        const reloadRes = await app.request('/api/providers/openrouter/reload-models', {
          method: 'POST',
          headers: { Cookie: adminCookie },
        });
        assert.equal(reloadRes.status, 200);
        const reloadDiff = (await reloadRes.json()) as {
          addedCount: number;
          removedCount: number;
          totalActive: number;
          summary: string;
          models: Array<{ fullId: string }>;
        };
        assert.equal(reloadDiff.addedCount, 2);
        assert.equal(reloadDiff.removedCount, 1);
        assert.equal(reloadDiff.totalActive, 3);
        assert.equal(reloadDiff.summary, '2 nuevos, 1 retirado');
        assert.deepEqual(
          reloadDiff.models.map((m) => m.fullId),
          [
            'openrouter/google/gemma-3-27b-it:free',
            'openrouter/meta-llama/llama-4-scout:free',
            'openrouter/qwen/qwen3-32b:free',
          ],
        );

        // Verify retired model with usage_logs is preserved in SQLite with active = 0
        const retiredRow = db
          .prepare(`SELECT active, name FROM models WHERE full_id = 'openrouter/deepseek/deepseek-r1:free'`)
          .get() as { active: number; name: string } | undefined;
        assert.ok(retiredRow, 'Retired model with usage history must remain in DB');
        assert.equal(retiredRow.active, 0);
        assert.equal(retiredRow.name, 'DeepSeek R1 (free)');

        // Also test static models provider (experimental-adapter with reviewedAt)
        const staticInstall = await app.request('/api/providers', {
          method: 'POST',
          headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            schemaVersion: '1.0',
            id: 'local-adapter',
            name: 'Local Experimental Adapter',
            packageType: 'experimental-adapter',
            baseUrl: 'http://127.0.0.1:3999/v1',
            auth: { type: 'bearer', header: 'Authorization' },
            modelsSource: 'static',
            reviewedAt: '2026-11-17',
            staticModels: [
              { id: 'session-chat-v1', name: 'Session Chat v1', contextLength: 32768 },
            ],
            adapter: { defaultPort: 3999, healthPath: '/health' },
          }),
        });
        assert.equal(staticInstall.status, 201);

        await app.request('/api/providers/local-adapter/keys', {
          method: 'POST',
          headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({ label: 'Session 1', secret: 'sess-token-abcd' }),
        });

        const staticDetect = await app.request('/api/providers/local-adapter/detect-models', {
          method: 'POST',
          headers: { Cookie: adminCookie },
        });
        assert.equal(staticDetect.status, 200);
        const staticBody = (await staticDetect.json()) as {
          reviewedAt: string;
          addedCount: number;
          models: Array<{ fullId: string }>;
        };
        assert.equal(staticBody.reviewedAt, '2026-11-17');
        assert.equal(staticBody.addedCount, 1);
        assert.equal(staticBody.models[0]!.fullId, 'local-adapter/session-chat-v1');
      } finally {
        db.close();
      }
    });
  });

  describe('HU-09: Key Failover (429/5xx) & Mid-Stream SSE Interruption Resumption', () => {
    it('fails over transparently on 429 in non-streaming mode and resumes mid-stream dropped SSE responses with a second key', async () => {
      const db = openDatabase(':memory:');
      const masterKey = randomBytes(32);

      const receivedRequests: Array<{
        auth: string;
        stream: boolean;
        messages: Array<{ role: string; content: string }>;
      }> = [];

      try {
        const mockUpstream = await startMockServer(async (req, res) => {
          if (req.url === '/v1/models' && req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                data: [
                  {
                    id: 'deepseek-v3:free',
                    name: 'DeepSeek V3 Free',
                    pricing: { prompt: '0', completion: '0' },
                    endpoints: ['/api/v1/chat/completions'],
                  },
                ],
              }),
            );
            return;
          }

          if (req.url === '/v1/chat/completions' && req.method === 'POST') {
            const auth = String(req.headers.authorization ?? '');
            const body = await readJsonBody(req);
            const stream = Boolean(body.stream);
            const messages = (body.messages as Array<{ role: string; content: string }>) ?? [];
            receivedRequests.push({ auth, stream, messages });

            // Non-streaming test: Key 1 returns 429, Key 2 returns 200 OK
            if (!stream) {
              if (auth === 'Bearer sk-prov-key-rate-limited-1111') {
                res.writeHead(429, {
                  'Content-Type': 'application/json',
                  'x-ratelimit-remaining': '0',
                  'retry-after': '120',
                });
                res.end(JSON.stringify({ error: { message: 'Rate limit exceeded for key 1111' } }));
                return;
              }
              if (auth === 'Bearer sk-prov-key-healthy-2222') {
                res.writeHead(200, {
                  'Content-Type': 'application/json',
                  'x-ratelimit-remaining': '48',
                });
                res.end(
                  JSON.stringify({
                    id: 'chatcmpl-nonstream-ok',
                    object: 'chat.completion',
                    created: 1763420000,
                    model: 'deepseek-v3:free',
                    choices: [
                      {
                        index: 0,
                        message: { role: 'assistant', content: 'Respuesta desde clave de respaldo 2' },
                        finish_reason: 'stop',
                      },
                    ],
                    usage: {
                      prompt_tokens: 15,
                      completion_tokens: 9,
                      total_tokens: 24,
                    },
                  }),
                );
                return;
              }
            }

            // Streaming SSE test: Key 2 streams 2 partial tokens then abruptly drops TCP socket;
            // Key 3 receives continuation context and finishes the stream cleanly!
            if (stream) {
              if (auth === 'Bearer sk-prov-key-healthy-2222') {
                res.writeHead(200, {
                  'Content-Type': 'text/event-stream',
                  'Cache-Control': 'no-cache',
                  Connection: 'keep-alive',
                });
                res.write(
                  `data: ${JSON.stringify({
                    id: 'chatcmpl-stream-1',
                    object: 'chat.completion.chunk',
                    choices: [{ index: 0, delta: { role: 'assistant', content: 'Hola ' }, finish_reason: null }],
                  })}\n\n`,
                );
                res.write(
                  `data: ${JSON.stringify({
                    id: 'chatcmpl-stream-1',
                    object: 'chat.completion.chunk',
                    choices: [{ index: 0, delta: { content: 'mundo, ' }, finish_reason: null }],
                  })}\n\n`,
                );
                // Abruptly destroy underlying socket mid-generation without [DONE]!
                setTimeout(() => {
                  res.socket?.destroy();
                }, 15);
                return;
              }

              if (auth === 'Bearer sk-prov-key-backup-3333') {
                res.writeHead(200, {
                  'Content-Type': 'text/event-stream',
                  'Cache-Control': 'no-cache',
                  Connection: 'keep-alive',
                });
                res.write(
                  `data: ${JSON.stringify({
                    id: 'chatcmpl-stream-2',
                    object: 'chat.completion.chunk',
                    choices: [{ index: 0, delta: { content: 'reanudado ' }, finish_reason: null }],
                  })}\n\n`,
                );
                res.write(
                  `data: ${JSON.stringify({
                    id: 'chatcmpl-stream-2',
                    object: 'chat.completion.chunk',
                    choices: [{ index: 0, delta: { content: 'con éxito!' }, finish_reason: 'stop' }],
                    usage: { prompt_tokens: 30, completion_tokens: 12 },
                  })}\n\n`,
                );
                res.write('data: [DONE]\n\n');
                res.end();
                return;
              }
            }
          }

          res.writeHead(404);
          res.end();
        });

        const app = createApp({ db, masterKey });

        // Setup admin + internal API key sk-bf-...
        const setupRes = await app.request('/api/setup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'admin', password: 'admin-password-123' }),
        });
        const adminCookie = extractCookiePair(setupRes.headers.get('set-cookie'));

        const bfKeyRes = await app.request('/api/keys', {
          method: 'POST',
          headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Gateway Client' }),
        });
        const { rawKey: bfKey } = (await bfKeyRes.json()) as { rawKey: string };

        // Install provider + 3 keys + detect models
        await app.request('/api/providers', {
          method: 'POST',
          headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            schemaVersion: '1.0',
            id: 'openrouter',
            name: 'OpenRouter',
            packageType: 'official-json',
            baseUrl: `${mockUpstream.url}/v1`,
            auth: { type: 'bearer', header: 'Authorization', prefix: 'Bearer ' },
            modelsSource: 'api',
            modelsEndpoint: '/models',
            freeRule: {
              priceZeroPaths: ['pricing.prompt', 'pricing.completion'],
              requiredEndpoint: '/api/v1/chat/completions',
              idSuffix: ':free',
            },
          }),
        });

        await app.request('/api/providers/openrouter/keys', {
          method: 'POST',
          headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({ label: 'Key 1', secret: 'sk-prov-key-rate-limited-1111' }),
        });
        await app.request('/api/providers/openrouter/keys', {
          method: 'POST',
          headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({ label: 'Key 2', secret: 'sk-prov-key-healthy-2222' }),
        });
        await app.request('/api/providers/openrouter/keys', {
          method: 'POST',
          headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({ label: 'Key 3', secret: 'sk-prov-key-backup-3333' }),
        });

        const det = await app.request('/api/providers/openrouter/detect-models', {
          method: 'POST',
          headers: { Cookie: adminCookie },
        });
        assert.equal(det.status, 200);

        // 1. Test non-streaming 429 failover (Key 1 -> 429, Key 2 -> 200 OK)
        const chatRes = await app.request('/v1/chat/completions', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${bfKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'openrouter/deepseek-v3:free',
            stream: false,
            messages: [{ role: 'user', content: 'Hola Bifrost' }],
          }),
        });
        assert.equal(chatRes.status, 200);
        const chatJson = (await chatRes.json()) as {
          model: string;
          choices: Array<{ message: { content: string } }>;
        };
        assert.equal(chatJson.model, 'openrouter/deepseek-v3:free');
        assert.equal(chatJson.choices[0]!.message.content, 'Respuesta desde clave de respaldo 2');

        // Key 1 is now rate_limited (remaining=0), Key 2 has ratelimitRemaining=48
        const keysAfterFailoverRes = await app.request('/api/providers/openrouter/keys', {
          headers: { Cookie: adminCookie },
        });
        const keysAfterFailover = (await keysAfterFailoverRes.json()) as {
          keys: Array<{ label: string; status: string; ratelimitRemaining: number | null }>;
        };
        const k1State = keysAfterFailover.keys.find((k) => k.label === 'Key 1')!;
        const k2State = keysAfterFailover.keys.find((k) => k.label === 'Key 2')!;
        assert.equal(k1State.status, 'rate_limited');
        assert.equal(k1State.ratelimitRemaining, 0);
        assert.equal(k2State.status, 'active');
        assert.equal(k2State.ratelimitRemaining, 48);

        // 2. Test mid-stream SSE drop & transparent resumption (Key 2 drops after "Hola mundo, " -> Key 3 finishes!)
        const streamRes = await app.request('/v1/chat/completions', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${bfKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'openrouter/deepseek-v3:free',
            stream: true,
            messages: [{ role: 'user', content: 'Escribe un saludo en streaming' }],
          }),
        });
        assert.equal(streamRes.status, 200);
        assert.match(streamRes.headers.get('content-type') ?? '', /text\/event-stream/);

        const rawSse = await streamRes.text();
        assert.ok(rawSse.includes('data: [DONE]'), 'SSE stream must finish with [DONE]');

        // Reassemble delta content received by client
        let assembledContent = '';
        for (const line of rawSse.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const dataStr = trimmed.slice(5).trim();
          if (dataStr === '[DONE]') continue;
          const chunk = JSON.parse(dataStr) as {
            choices?: Array<{ delta?: { content?: string } }>;
          };
          const piece = chunk.choices?.[0]?.delta?.content ?? '';
          assembledContent += piece;
        }
        assert.equal(assembledContent, 'Hola mundo, reanudado con éxito!');

        // Verify Key 3 received the accumulated assistant prefix "Hola mundo, " in messages
        const key3Req = receivedRequests.find(
          (r) => r.auth === 'Bearer sk-prov-key-backup-3333',
        );
        assert.ok(key3Req, 'Backup Key 3 must have been called for stream resumption');
        assert.ok(
          key3Req.messages.some(
            (m) => m.role === 'assistant' && m.content === 'Hola mundo, ',
          ),
          'Continuation prompt must include accumulated assistant content',
        );

        // Verify usage_logs recorded status = 'resumed' and system_logs recorded 'failover' & 'stream_resume' with zero secrets
        const usageStatuses = (
          db.prepare(`SELECT status FROM usage_logs ORDER BY id ASC`).all() as Array<{
            status: string;
          }>
        ).map((u) => u.status);
        assert.deepEqual(usageStatuses, ['ok', 'resumed']);

        const sysLogs = db
          .prepare(`SELECT category, message, meta_json FROM system_logs`)
          .all() as Array<{ category: string; message: string; meta_json: string | null }>;
        assert.ok(sysLogs.some((l) => l.category === 'failover'));
        assert.ok(sysLogs.some((l) => l.category === 'stream_resume'));

        const serializedLogs = JSON.stringify(sysLogs);
        assert.equal(serializedLogs.includes('sk-prov-key-rate-limited-1111'), false);
        assert.equal(serializedLogs.includes('sk-prov-key-healthy-2222'), false);
        assert.equal(serializedLogs.includes('sk-prov-key-backup-3333'), false);
      } finally {
        db.close();
      }
    });
  });

  describe('HU-10: Graceful Key & Provider Removal While Requests Are In Flight', () => {
    it('allows in-flight requests to complete while immediately blocking new requests from using removed key or provider', async () => {
      const db = openDatabase(':memory:');
      const masterKey = randomBytes(32);

      const key1Started = createDeferred<void>();
      const releaseKey1 = createDeferred<void>();
      const provDeleteStarted = createDeferred<void>();
      const releaseProvReq = createDeferred<void>();
      const usedAuthHeaders: string[] = [];

      try {
        const mockUpstream = await startMockServer(async (req, res) => {
          if (req.url === '/v1/models') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                data: [
                  {
                    id: 'fast-chat:free',
                    name: 'Fast Chat',
                    pricing: { prompt: '0', completion: '0' },
                    endpoints: ['/api/v1/chat/completions'],
                  },
                ],
              }),
            );
            return;
          }

          if (req.url === '/v1/chat/completions' && req.method === 'POST') {
            const auth = String(req.headers.authorization ?? '');
            usedAuthHeaders.push(auth);
            const body = await readJsonBody(req);
            const msgs = (body.messages as Array<{ content: string }>) ?? [];
            const prompt = msgs[0]?.content ?? '';

            if (prompt === 'hold-key-1') {
              key1Started.resolve();
              await releaseKey1.promise;
            } else if (prompt === 'hold-provider') {
              provDeleteStarted.resolve();
              await releaseProvReq.promise;
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                id: 'chatcmpl-drain',
                object: 'chat.completion',
                choices: [
                  {
                    index: 0,
                    message: { role: 'assistant', content: `ack:${prompt}:${auth.slice(-4)}` },
                    finish_reason: 'stop',
                  },
                ],
                usage: { prompt_tokens: 5, completion_tokens: 5 },
              }),
            );
            return;
          }

          res.writeHead(404);
          res.end();
        });

        const app = createApp({ db, masterKey });

        const setupRes = await app.request('/api/setup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'admin', password: 'admin-password-123' }),
        });
        const adminCookie = extractCookiePair(setupRes.headers.get('set-cookie'));

        const bfKeyRes = await app.request('/api/keys', {
          method: 'POST',
          headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Drain Test Key' }),
        });
        const { rawKey: bfKey } = (await bfKeyRes.json()) as { rawKey: string };

        await app.request('/api/providers', {
          method: 'POST',
          headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            schemaVersion: '1.0',
            id: 'openrouter',
            name: 'OpenRouter',
            packageType: 'official-json',
            baseUrl: `${mockUpstream.url}/v1`,
            auth: { type: 'bearer', header: 'Authorization' },
            modelsSource: 'api',
            modelsEndpoint: '/models',
            freeRule: {
              priceZeroPaths: ['pricing.prompt', 'pricing.completion'],
              idSuffix: ':free',
            },
          }),
        });

        const k1Create = await app.request('/api/providers/openrouter/keys', {
          method: 'POST',
          headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({ label: 'DrainKey1', secret: 'sk-drain-first-AAAA' }),
        });
        const key1Id = ((await k1Create.json()) as { key: { id: string } }).key.id;

        await app.request('/api/providers/openrouter/keys', {
          method: 'POST',
          headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({ label: 'DrainKey2', secret: 'sk-drain-second-BBBB' }),
        });

        await app.request('/api/providers/openrouter/detect-models', {
          method: 'POST',
          headers: { Cookie: adminCookie },
        });

        // --- Part A: Delete Key 1 while Request 1 is in flight ---
        const req1Promise = app.request('/v1/chat/completions', {
          method: 'POST',
          headers: { Authorization: `Bearer ${bfKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'openrouter/fast-chat:free',
            messages: [{ role: 'user', content: 'hold-key-1' }],
          }),
        });

        await key1Started.promise;

        // Delete Key 1 while req1 is actively holding it
        const delKeyRes = await app.request(`/api/providers/openrouter/keys/${key1Id}`, {
          method: 'DELETE',
          headers: { Cookie: adminCookie },
        });
        assert.equal(delKeyRes.status, 200);
        const delKeyBody = (await delKeyRes.json()) as { ok: boolean; draining: boolean };
        assert.equal(delKeyBody.ok, true);
        assert.equal(delKeyBody.draining, true);

        // Key 1 immediately disappears from GET /api/providers/openrouter/keys
        const keysDuringDrain = await app.request('/api/providers/openrouter/keys', {
          headers: { Cookie: adminCookie },
        });
        const listedKeys = ((await keysDuringDrain.json()) as { keys: Array<{ id: string }> }).keys;
        assert.equal(listedKeys.some((k) => k.id === key1Id), false);

        // New concurrent Request 2 immediately routes to Key 2 (BBBB), NOT draining Key 1 (AAAA)
        const req2Res = await app.request('/v1/chat/completions', {
          method: 'POST',
          headers: { Authorization: `Bearer ${bfKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'openrouter/fast-chat:free',
            messages: [{ role: 'user', content: 'new-request' }],
          }),
        });
        assert.equal(req2Res.status, 200);
        const req2Json = (await req2Res.json()) as {
          choices: Array<{ message: { content: string } }>;
        };
        assert.equal(req2Json.choices[0]!.message.content, 'ack:new-request:BBBB');

        // Release Request 1 -> finishes cleanly with 200 OK, and Key 1 row is deleted from SQLite
        releaseKey1.resolve();
        const req1Res = await req1Promise;
        assert.equal(req1Res.status, 200);
        const req1Json = (await req1Res.json()) as {
          choices: Array<{ message: { content: string } }>;
        };
        assert.equal(req1Json.choices[0]!.message.content, 'ack:hold-key-1:AAAA');

        const key1InDb = db
          .prepare(`SELECT id FROM provider_keys WHERE id = ?`)
          .get(key1Id);
        assert.equal(key1InDb, undefined, 'Key 1 must be physically removed after draining');

        // --- Part B: Delete entire Provider while Request 3 is in flight ---
        const req3Promise = app.request('/v1/chat/completions', {
          method: 'POST',
          headers: { Authorization: `Bearer ${bfKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'openrouter/fast-chat:free',
            messages: [{ role: 'user', content: 'hold-provider' }],
          }),
        });

        await provDeleteStarted.promise;

        const delProvRes = await app.request('/api/providers/openrouter', {
          method: 'DELETE',
          headers: { Cookie: adminCookie },
        });
        assert.equal(delProvRes.status, 200);
        assert.deepEqual(await delProvRes.json(), { ok: true, draining: true });

        // Provider immediately disappears from GET /api/providers & GET /v1/models, and new requests get 404
        const provsDuringDrain = await app.request('/api/providers', {
          headers: { Cookie: adminCookie },
        });
        assert.deepEqual(await provsDuringDrain.json(), { providers: [] });

        const newChatAfterProvDel = await app.request('/v1/chat/completions', {
          method: 'POST',
          headers: { Authorization: `Bearer ${bfKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'openrouter/fast-chat:free',
            messages: [{ role: 'user', content: 'after-delete' }],
          }),
        });
        assert.equal(newChatAfterProvDel.status, 404);

        // Release in-flight Request 3 -> still finishes 200 OK!
        releaseProvReq.resolve();
        const req3Res = await req3Promise;
        assert.equal(req3Res.status, 200);
        const req3Json = (await req3Res.json()) as {
          choices: Array<{ message: { content: string } }>;
        };
        assert.equal(req3Json.choices[0]!.message.content, 'ack:hold-provider:BBBB');

        const provInDb = db.prepare(`SELECT id FROM providers WHERE id = 'openrouter'`).get();
        assert.equal(provInDb, undefined, 'Provider must be physically deleted after draining');

        // Historical usage_logs from all 3 completed requests remain preserved!
        const usageCount = db
          .prepare(`SELECT COUNT(*) AS count FROM usage_logs WHERE status = 'ok'`)
          .get() as { count: number };
        assert.equal(Number(usageCount.count), 3);
      } finally {
        db.close();
      }
    });
  });
});

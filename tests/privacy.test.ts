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

describe('Provider Privacy Schema & API Exposure', () => {
  describe('validateProviderManifest privacy validation', () => {
    it('accepts a manifest without privacy and manifests with valid privacy blocks', () => {
      const withoutPrivacy = validateProviderManifest(baseManifest());
      assert.equal(withoutPrivacy.valid, true, withoutPrivacy.errors.join('; '));

      const minimalPrivacy = validateProviderManifest(
        baseManifest({
          privacy: {
            retention: 'zero',
            training: 'never',
          },
        }),
      );
      assert.equal(minimalPrivacy.valid, true, minimalPrivacy.errors.join('; '));
      assert.deepEqual(minimalPrivacy.manifest?.privacy, {
        retention: 'zero',
        training: 'never',
      });

      const fullPrivacy = validateProviderManifest(
        baseManifest({
          privacy: {
            retention: 'retained',
            training: 'opt_out',
            retentionDays: 30,
            policyUrl: 'https://example.com/privacy',
            note: 'Prompts retained for 30 days for abuse monitoring.',
          },
        }),
      );
      assert.equal(fullPrivacy.valid, true, fullPrivacy.errors.join('; '));

      const zeroDaysPrivacy = validateProviderManifest(
        baseManifest({
          privacy: {
            retention: 'transient',
            training: 'unknown',
            retentionDays: 0,
            policyUrl: 'http://example.com/terms',
          },
        }),
      );
      assert.equal(zeroDaysPrivacy.valid, true, zeroDaysPrivacy.errors.join('; '));
    });

    it('rejects invalid privacy retention, training, retentionDays, policyUrl, note, and extra properties', () => {
      const badRetention = validateProviderManifest(
        baseManifest({ privacy: { retention: 'forever', training: 'never' } }),
      );
      assert.equal(badRetention.valid, false);

      const badTraining = validateProviderManifest(
        baseManifest({ privacy: { retention: 'zero', training: 'always' } }),
      );
      assert.equal(badTraining.valid, false);

      const negativeDays = validateProviderManifest(
        baseManifest({ privacy: { retention: 'retained', training: 'never', retentionDays: -1 } }),
      );
      assert.equal(negativeDays.valid, false);
      assert.ok(negativeDays.errors.some((e) => e.includes('retentionDays')));

      const floatDays = validateProviderManifest(
        baseManifest({ privacy: { retention: 'retained', training: 'never', retentionDays: 1.5 } }),
      );
      assert.equal(floatDays.valid, false);

      const ftpPolicyUrl = validateProviderManifest(
        baseManifest({
          privacy: { retention: 'zero', training: 'never', policyUrl: 'ftp://example.com/p' },
        }),
      );
      assert.equal(ftpPolicyUrl.valid, false);
      assert.ok(ftpPolicyUrl.errors.some((e) => e.includes('policyUrl')));

      const invalidPolicyUrl = validateProviderManifest(
        baseManifest({
          privacy: { retention: 'zero', training: 'never', policyUrl: 'not-a-url' },
        }),
      );
      assert.equal(invalidPolicyUrl.valid, false);

      const badNote = validateProviderManifest(
        baseManifest({
          privacy: { retention: 'zero', training: 'never', note: 123 },
        }),
      );
      assert.equal(badNote.valid, false);

      const extraProp = validateProviderManifest(
        baseManifest({
          privacy: { retention: 'zero', training: 'never', extraField: true },
        }),
      );
      assert.equal(extraProp.valid, false);
    });
  });

  describe('/api/providers, /api/marketplace, and /api/models privacy exposure', () => {
    it('exposes privacy on /api/providers and /api/marketplace and providerPrivacy on /api/models', async () => {
      const db = openDatabase(':memory:');
      const masterKey = randomBytes(32);

      try {
        const privacyManifest = baseManifest({
          id: 'priv-prov',
          name: 'Privacy Provider',
          privacy: {
            retention: 'zero',
            training: 'never',
            retentionDays: 0,
            policyUrl: 'https://priv.example.com/privacy',
            note: 'Zero data retention.',
          },
          staticModels: [{ id: 'priv-model', name: 'Priv Model' }],
        });

        const noPrivacyManifest = baseManifest({
          id: 'plain-prov',
          name: 'Plain Provider',
          staticModels: [{ id: 'plain-model', name: 'Plain Model' }],
        });

        const mockCatalog = await startMockServer((req, res) => {
          if (req.url === '/index.json') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                providers: [
                  { ...privacyManifest, approved: true },
                  { ...noPrivacyManifest, approved: true },
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

        // 1. Setup admin
        const setupRes = await app.request('/api/setup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'admin', password: 'password123' }),
        });
        assert.equal(setupRes.status, 201);
        const adminCookie = extractCookiePair(setupRes.headers.get('set-cookie'));

        // 2. Check /api/marketplace exposes privacy: manifest.privacy ?? null
        const mktRes = await app.request('/api/marketplace', {
          headers: { Cookie: adminCookie },
        });
        assert.equal(mktRes.status, 200);
        const mktBody = (await mktRes.json()) as {
          providers: Array<{ id: string; privacy: unknown }>;
          manifests: Array<{ id: string; privacy: unknown }>;
        };
        const mktPriv = mktBody.manifests.find((m) => m.id === 'priv-prov');
        const mktPlain = mktBody.manifests.find((m) => m.id === 'plain-prov');
        assert.deepEqual(mktPriv?.privacy, privacyManifest.privacy);
        assert.equal(mktPlain?.privacy, null);

        // 3. Install both providers
        const inst1 = await app.request('/api/providers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
          body: JSON.stringify(privacyManifest),
        });
        assert.equal(inst1.status, 201);

        const inst2 = await app.request('/api/providers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
          body: JSON.stringify(noPrivacyManifest),
        });
        assert.equal(inst2.status, 201);

        // Insert an active key for each provider so reload-models can run for static providers
        const nowSec = Math.floor(Date.now() / 1000);
        for (const pid of ['priv-prov', 'plain-prov']) {
          db.prepare(
            `INSERT INTO provider_keys (id, provider_id, label, last4, encrypted_secret, status, created_at)
             VALUES (?, ?, 'test-key', '1234', ?, 'active', ?)`,
          ).run(randomUUID(), pid, encryptSecret('sk-test-1234', masterKey), nowSec);
        }

        // Reload static models for both providers
        const reload1 = await app.request('/api/providers/priv-prov/reload-models', {
          method: 'POST',
          headers: { Cookie: adminCookie },
        });
        assert.equal(reload1.status, 200);

        const reload2 = await app.request('/api/providers/plain-prov/reload-models', {
          method: 'POST',
          headers: { Cookie: adminCookie },
        });
        assert.equal(reload2.status, 200);

        // 4. Verify /api/providers exposes privacy
        const provRes = await app.request('/api/providers', {
          headers: { Cookie: adminCookie },
        });
        assert.equal(provRes.status, 200);
        const provBody = (await provRes.json()) as {
          providers: Array<{ id: string; privacy: unknown }>;
        };
        const p1 = provBody.providers.find((p) => p.id === 'priv-prov');
        const p2 = provBody.providers.find((p) => p.id === 'plain-prov');
        assert.deepEqual(p1?.privacy, privacyManifest.privacy);
        assert.equal(p2?.privacy, null);

        // 5. Verify /api/models exposes providerPrivacy
        const modelsRes = await app.request('/api/models', {
          headers: { Cookie: adminCookie },
        });
        assert.equal(modelsRes.status, 200);
        const modelsBody = (await modelsRes.json()) as {
          models: Array<{ fullId: string; providerPrivacy: unknown }>;
        };
        const m1 = modelsBody.models.find((m) => m.fullId === 'priv-prov/priv-model');
        const m2 = modelsBody.models.find((m) => m.fullId === 'plain-prov/plain-model');
        assert.ok(m1);
        assert.ok(m2);
        assert.deepEqual(m1.providerPrivacy, privacyManifest.privacy);
        assert.equal(m2.providerPrivacy, null);

        // 6. Verify /api/models/:fullId exposes providerPrivacy
        const detailRes = await app.request('/api/models/priv-prov%2Fpriv-model', {
          headers: { Cookie: adminCookie },
        });
        assert.equal(detailRes.status, 200);
        const detailBody = (await detailRes.json()) as {
          providerPrivacy: unknown;
          model: { providerPrivacy: unknown };
        };
        assert.deepEqual(detailBody.providerPrivacy, privacyManifest.privacy);
        assert.deepEqual(detailBody.model.providerPrivacy, privacyManifest.privacy);

        // 7. Verify guest user also sees privacy on /api/providers and providerPrivacy on /api/models
        const invRes = await app.request('/api/invitations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
          body: JSON.stringify({
            dailyTokenLimit: 10000,
            quotaResetMode: 'utc_midnight',
            allowedModels: ['*'],
          }),
        });
        assert.equal(invRes.status, 201);
        const { token } = (await invRes.json()) as { token: string };

        const accRes = await app.request(`/api/invitations/${token}/accept`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: `guest-${randomUUID().slice(0, 6)}`,
            password: 'guestpassword123',
          }),
        });
        assert.equal(accRes.status, 201);
        const guestCookie = extractCookiePair(accRes.headers.get('set-cookie'));

        const guestProvRes = await app.request('/api/providers', {
          headers: { Cookie: guestCookie },
        });
        assert.equal(guestProvRes.status, 200);
        const guestProvBody = (await guestProvRes.json()) as {
          providers: Array<{ id: string; privacy: unknown }>;
        };
        assert.deepEqual(
          guestProvBody.providers.find((p) => p.id === 'priv-prov')?.privacy,
          privacyManifest.privacy,
        );
        assert.equal(guestProvBody.providers.find((p) => p.id === 'plain-prov')?.privacy, null);

        const guestModelsRes = await app.request('/api/models', {
          headers: { Cookie: guestCookie },
        });
        assert.equal(guestModelsRes.status, 200);
        const guestModelsBody = (await guestModelsRes.json()) as {
          models: Array<{ fullId: string; providerPrivacy: unknown }>;
        };
        assert.deepEqual(
          guestModelsBody.models.find((m) => m.fullId === 'priv-prov/priv-model')?.providerPrivacy,
          privacyManifest.privacy,
        );
      } finally {
        db.close();
      }
    });
  });
});

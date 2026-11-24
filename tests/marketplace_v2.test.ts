import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createApp } from '../core/src/app.js';
import { hashPassword, resolveMasterKey } from '../core/src/crypto.js';
import {
  OFFICIAL_MARKETPLACE_SOURCE_NAME,
  OFFICIAL_MARKETPLACE_SOURCE_URL,
  openDatabase,
} from '../core/src/db.js';
import { computeManifestHash } from '../core/src/marketplace.js';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-marketplace-v2-test-'));
}

function extractCookieHeader(res: Response): string {
  const raw = res.headers.get('set-cookie');
  assert.ok(raw, 'Expected Set-Cookie header');
  return raw.split(';')[0]!;
}

describe('HU-42 — Multi-Repo Marketplace, Versioning & In-Place Manifest Updates', () => {
  it('starts with official source disabled (opt-in) on fresh DB and returns empty catalog + recommended source', async () => {
    const tmpDir = makeTempDir();
    try {
      const { key: masterKey } = resolveMasterKey({ dataDir: tmpDir, envMasterKey: undefined });
      const db = openDatabase(path.join(tmpDir, 'bifrost.db'));
      let fetchCalled = false;

      const app = createApp({
        db,
        masterKey,
        fetchImpl: async () => {
          fetchCalled = true;
          throw new Error('Should not fetch when no sources are enabled');
        },
      });

      const setupRes = await app.request('http://localhost/api/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'adminpassword123' }),
      });
      assert.equal(setupRes.status, 201);
      const adminCookie = extractCookieHeader(setupRes);

      const mpRes = await app.request('http://localhost/api/marketplace', {
        headers: { Cookie: adminCookie },
      });
      assert.equal(mpRes.status, 200);
      assert.equal(fetchCalled, false, 'No outbound fetch should occur when enabledSourcesCount === 0');

      const body = (await mpRes.json()) as {
        online: boolean;
        offline: boolean;
        providers: unknown[];
        manifests: unknown[];
        enabledSourcesCount: number;
        updatesAvailableCount: number;
        sources: Array<{
          id: string;
          name: string;
          url: string;
          isOfficial: boolean;
          enabled: boolean;
        }>;
      };

      assert.equal(body.online, true);
      assert.equal(body.offline, false);
      assert.deepEqual(body.providers, []);
      assert.deepEqual(body.manifests, []);
      assert.equal(body.enabledSourcesCount, 0);
      assert.equal(body.updatesAvailableCount, 0);
      assert.equal(body.sources.length, 1);
      assert.equal(body.sources[0]!.id, 'official');
      assert.equal(body.sources[0]!.name, 'Catálogo Oficial (mazzapata/providers)');
      assert.equal(body.sources[0]!.isOfficial, true);
      assert.equal(body.sources[0]!.enabled, false);
      assert.equal(
        body.sources[0]!.url,
        'https://raw.githubusercontent.com/mazzapata/providers/main/index.json',
      );

      db.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('enforces admin-only 403 on all /api/marketplace/sources and /api/marketplace/update-installed routes', async () => {
    const tmpDir = makeTempDir();
    try {
      const { key: masterKey } = resolveMasterKey({ dataDir: tmpDir, envMasterKey: undefined });
      const db = openDatabase(path.join(tmpDir, 'bifrost.db'));
      const app = createApp({ db, masterKey });

      const setupRes = await app.request('http://localhost/api/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'adminpassword123' }),
      });
      assert.equal(setupRes.status, 201);

      const guestHash = await hashPassword('guestpass123');
      db.prepare(
        `INSERT INTO users (id, username, password_hash, role, daily_token_limit, quota_reset_mode, created_at)
         VALUES ('guest-1', 'guest_user', ?, 'guest', 1000, 'utc_midnight', 1700000000)`,
      ).run(guestHash);

      const loginRes = await app.request('http://localhost/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'guest_user', password: 'guestpass123' }),
      });
      assert.equal(loginRes.status, 200);
      const guestCookie = extractCookieHeader(loginRes);

      const getSources = await app.request('http://localhost/api/marketplace/sources', {
        headers: { Cookie: guestCookie },
      });
      assert.equal(getSources.status, 403);

      const postSource = await app.request('http://localhost/api/marketplace/sources', {
        method: 'POST',
        headers: { Cookie: guestCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Community Repo',
          url: 'https://community.example.com/index.json',
        }),
      });
      assert.equal(postSource.status, 403);

      const patchSource = await app.request('http://localhost/api/marketplace/sources/official', {
        method: 'PATCH',
        headers: { Cookie: guestCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      });
      assert.equal(patchSource.status, 403);

      const deleteSource = await app.request('http://localhost/api/marketplace/sources/official', {
        method: 'DELETE',
        headers: { Cookie: guestCookie },
      });
      assert.equal(deleteSource.status, 403);

      const updateInstalled = await app.request(
        'http://localhost/api/marketplace/update-installed',
        {
          method: 'POST',
          headers: { Cookie: guestCookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        },
      );
      assert.equal(updateInstalled.status, 403);

      db.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('enforces strict SSRF protection on POST /api/marketplace/sources and blocks deleting official source', async () => {
    const tmpDir = makeTempDir();
    try {
      const { key: masterKey } = resolveMasterKey({ dataDir: tmpDir, envMasterKey: undefined });
      const db = openDatabase(path.join(tmpDir, 'bifrost.db'));
      const app = createApp({ db, masterKey });

      const setupRes = await app.request('http://localhost/api/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'adminpassword123' }),
      });
      assert.equal(setupRes.status, 201);
      const adminCookie = extractCookieHeader(setupRes);

      const blockedUrls = [
        'http://example.com/index.json',
        'https://169.254.169.254/latest/meta-data',
        'http://127.0.0.1:8080/index.json',
        'https://127.0.0.1/index.json',
        'https://localhost/index.json',
        'https://10.0.0.1/index.json',
        'https://user:pass@example.com/index.json',
      ];

      for (const badUrl of blockedUrls) {
        const res = await app.request('http://localhost/api/marketplace/sources', {
          method: 'POST',
          headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Blocked Repo', url: badUrl }),
        });
        assert.equal(res.status, 400, `Expected 400 for blocked URL: ${badUrl}`);
      }

      // Deleting official source must be rejected with 400
      const delOfficial = await app.request('http://localhost/api/marketplace/sources/official', {
        method: 'DELETE',
        headers: { Cookie: adminCookie },
      });
      assert.equal(delOfficial.status, 400);

      db.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('merges multi-repo catalogs with official collision priority, detects updates, and updates installed manifests in place while preserving keys, models, and usage_logs', async () => {
    const tmpDir = makeTempDir();
    let clockMs = Date.UTC(2026, 10, 22, 12, 0, 0);

    try {
      const { key: masterKey } = resolveMasterKey({ dataDir: tmpDir, envMasterKey: undefined });
      const db = openDatabase(path.join(tmpDir, 'bifrost.db'));

      let groqVersion = 1;
      let officialFetches = 0;

      const makeGroqManifest = (version: number) => ({
        schemaVersion: '1.0' as const,
        id: 'groq',
        name: version === 1 ? 'Groq Cloud' : 'Groq Cloud v2',
        category: 'official-api' as const,
        packageType: 'official-json' as const,
        verified: true,
        publishedAt: version === 1 ? '2026-11-01' : '2026-11-22',
        baseUrl: 'https://api.groq.com/openai/v1',
        auth: { type: 'bearer' as const, header: 'Authorization', prefix: 'Bearer ' },
        modelsSource: 'api' as const,
        modelsEndpoint: '/models',
      });

      const communityGroqManifest = {
        schemaVersion: '1.0' as const,
        id: 'groq',
        name: 'Community Fork Groq (Should Lose Collision)',
        category: 'official-api' as const,
        packageType: 'official-json' as const,
        verified: false,
        publishedAt: '2026-11-20',
        baseUrl: 'https://fork.groq.example/v1',
        auth: { type: 'bearer' as const, header: 'Authorization', prefix: 'Bearer ' },
        modelsSource: 'api' as const,
        modelsEndpoint: '/models',
      };

      const communityUniqueManifest = {
        schemaVersion: '1.0' as const,
        id: 'community-llm',
        name: 'Community LLM',
        category: 'official-api' as const,
        packageType: 'official-json' as const,
        verified: false,
        publishedAt: '2026-11-15',
        reviewedAt: '2026-11-15',
        baseUrl: 'https://api.community-llm.example/v1',
        auth: { type: 'bearer' as const, header: 'Authorization', prefix: 'Bearer ' },
        modelsSource: 'static' as const,
        staticModels: [{ id: 'comm-1', name: 'Community 1' }],
      };

      const mockFetch: typeof fetch = async (input) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

        if (url === 'https://raw.githubusercontent.com/mazzapata/providers/main/index.json') {
          officialFetches += 1;
          return new Response(
            JSON.stringify({
              schemaVersion: '1.0',
              updatedAt: groqVersion === 1 ? '2026-11-01T00:00:00Z' : '2026-11-22T12:00:00Z',
              providers: [
                {
                  ...makeGroqManifest(groqVersion),
                  description: 'Official Groq manifest',
                  approved: true,
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }

        if (url === 'https://community.bifrost.example/index.json') {
          return new Response(
            JSON.stringify({
              schemaVersion: '1.0',
              updatedAt: '2026-11-20T00:00:00Z',
              providers: [
                { ...communityGroqManifest, approved: true },
                { ...communityUniqueManifest, approved: true },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }

        throw new Error(`Unexpected fetch URL: ${url}`);
      };

      const app = createApp({
        db,
        masterKey,
        fetchImpl: mockFetch,
        now: () => clockMs,
      });

      const setupRes = await app.request('http://localhost/api/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'adminpassword123' }),
      });
      assert.equal(setupRes.status, 201);
      const adminCookie = extractCookieHeader(setupRes);
      const adminUserRow = db
        .prepare(`SELECT id FROM users WHERE role = 'admin'`)
        .get() as { id: string };

      // 1) Enable official source via PATCH
      const enableOfficial = await app.request('http://localhost/api/marketplace/sources/official', {
        method: 'PATCH',
        headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      });
      assert.equal(enableOfficial.status, 200);

      // 2) Add custom community repo via POST
      const addCommunity = await app.request('http://localhost/api/marketplace/sources', {
        method: 'POST',
        headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Community Providers',
          url: 'https://community.bifrost.example/index.json',
          enabled: true,
        }),
      });
      assert.equal(addCommunity.status, 201);
      const addedBody = (await addCommunity.json()) as { source: { id: string; enabled: boolean } };
      const communitySourceId = addedBody.source.id;
      assert.equal(addedBody.source.enabled, true);

      // 3) GET /api/marketplace merges both repos with official collision priority
      const mpRes1 = await app.request('http://localhost/api/marketplace', {
        headers: { Cookie: adminCookie },
      });
      assert.equal(mpRes1.status, 200);
      const mp1 = (await mpRes1.json()) as {
        online: boolean;
        enabledSourcesCount: number;
        updatesAvailableCount: number;
        providers: Array<{
          id: string;
          name: string;
          sourceId: string;
          sourceName: string;
          isOfficial: boolean;
          manifestHash: string;
          manifestVersion: string;
          installed: boolean;
          updateAvailable: boolean;
        }>;
      };

      assert.equal(mp1.online, true);
      assert.equal(mp1.enabledSourcesCount, 2);
      assert.equal(mp1.updatesAvailableCount, 0);
      assert.equal(mp1.providers.length, 2);

      const groqItem = mp1.providers.find((p) => p.id === 'groq');
      const commItem = mp1.providers.find((p) => p.id === 'community-llm');
      assert.ok(groqItem);
      assert.ok(commItem);

      // Official wins collision on 'groq'
      assert.equal(groqItem.name, 'Groq Cloud');
      assert.equal(groqItem.sourceId, 'official');
      assert.equal(groqItem.isOfficial, true);
      assert.equal(groqItem.installed, false);
      assert.equal(groqItem.updateAvailable, false);
      assert.equal(groqItem.manifestHash, computeManifestHash(makeGroqManifest(1)));

      // Community provider tagged with community source
      assert.equal(commItem.sourceId, communitySourceId);
      assert.equal(commItem.sourceName, 'Community Providers');
      assert.equal(commItem.isOfficial, false);

      // 4) Install 'groq' from marketplace (records source_id and manifest_hash)
      const installRes = await app.request('http://localhost/api/marketplace/install', {
        method: 'POST',
        headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'groq' }),
      });
      assert.equal(installRes.status, 201);

      const installedRowBefore = db
        .prepare(`SELECT source_id, manifest_hash FROM providers WHERE id = 'groq'`)
        .get() as { source_id: string | null; manifest_hash: string | null };
      assert.equal(installedRowBefore.source_id, 'official');
      assert.equal(installedRowBefore.manifest_hash, computeManifestHash(makeGroqManifest(1)));

      // Add a provider_key, a model, and a usage_log for 'groq'
      const addKeyRes = await app.request('http://localhost/api/providers/groq/keys', {
        method: 'POST',
        headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: 'Primary Groq Key', secret: 'gsk_super_secret_1234' }),
      });
      assert.equal(addKeyRes.status, 201);
      const keyBody = (await addKeyRes.json()) as { key: { id: string; last4: string } };
      const keyId = keyBody.key.id;

      db.prepare(
        `INSERT INTO models (
           full_id, provider_id, model_id, name, modalities_json, capabilities_json, is_free, first_seen_at, active
         ) VALUES ('groq/llama-3.3-70b', 'groq', 'llama-3.3-70b', 'Llama 3.3 70B', '{"input":["text"],"output":["text"]}', '{"tools":true,"reasoning":false,"structuredOutput":true}', 1, ?, 1)`,
      ).run(Math.floor(clockMs / 1000));

      db.prepare(
        `INSERT INTO usage_logs (
           user_id, provider_id, provider_key_id, model_full_id, prompt_tokens, completion_tokens, duration_ms, status, created_at
         ) VALUES (?, 'groq', ?, 'groq/llama-3.3-70b', 120, 80, 450, 'ok', ?)`,
      ).run(adminUserRow.id, keyId, Math.floor(clockMs / 1000));

      // 5) Remote manifest changes to v2; cached fetch within 15 min still uses cache unless ?refresh=1
      groqVersion = 2;
      const fetchesBeforeCacheHit = officialFetches;
      const cachedMpRes = await app.request('http://localhost/api/marketplace', {
        headers: { Cookie: adminCookie },
      });
      assert.equal(cachedMpRes.status, 200);
      assert.equal(officialFetches, fetchesBeforeCacheHit, 'Should serve from 15-min cache without ?refresh=1');

      // Force refresh detects updateAvailable = true
      const refreshedMpRes = await app.request('http://localhost/api/marketplace?refresh=1', {
        headers: { Cookie: adminCookie },
      });
      assert.equal(refreshedMpRes.status, 200);
      assert.equal(officialFetches, fetchesBeforeCacheHit + 1);
      const mp2 = (await refreshedMpRes.json()) as {
        updatesAvailableCount: number;
        providers: Array<{
          id: string;
          name: string;
          installed: boolean;
          updateAvailable: boolean;
          manifestHash: string;
          installedHash: string | null;
        }>;
      };
      assert.equal(mp2.updatesAvailableCount, 1);
      const groqV2 = mp2.providers.find((p) => p.id === 'groq')!;
      assert.equal(groqV2.name, 'Groq Cloud v2');
      assert.equal(groqV2.installed, true);
      assert.equal(groqV2.updateAvailable, true);
      assert.equal(groqV2.installedHash, computeManifestHash(makeGroqManifest(1)));
      assert.equal(groqV2.manifestHash, computeManifestHash(makeGroqManifest(2)));

      // 6) POST /api/marketplace/update-installed updates in place WITHOUT touching provider_keys, models, or usage_logs
      const updateRes = await app.request('http://localhost/api/marketplace/update-installed', {
        method: 'POST',
        headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerId: 'groq' }),
      });
      assert.equal(updateRes.status, 200);
      const updateBody = (await updateRes.json()) as {
        ok: boolean;
        updated: string[];
        skipped: string[];
        providers: Array<{ id: string; name: string; keysCount: number; modelsCount: number }>;
      };
      assert.equal(updateBody.ok, true);
      assert.deepEqual(updateBody.updated, ['groq']);
      assert.deepEqual(updateBody.skipped, []);
      assert.equal(updateBody.providers[0]!.name, 'Groq Cloud v2');
      assert.equal(updateBody.providers[0]!.keysCount, 1);
      assert.equal(updateBody.providers[0]!.modelsCount, 1);

      // Verify DB rows directly: schema_json updated, keys/models/usage_logs 100% intact
      const providerAfter = db
        .prepare(`SELECT name, schema_json, manifest_hash FROM providers WHERE id = 'groq'`)
        .get() as { name: string; schema_json: string; manifest_hash: string };
      assert.equal(providerAfter.name, 'Groq Cloud v2');
      assert.equal(providerAfter.manifest_hash, computeManifestHash(makeGroqManifest(2)));
      assert.equal((JSON.parse(providerAfter.schema_json) as { publishedAt: string }).publishedAt, '2026-11-22');

      const keysAfter = db
        .prepare(`SELECT id, label, last4 FROM provider_keys WHERE provider_id = 'groq'`)
        .all() as Array<{ id: string; label: string; last4: string }>;
      assert.equal(keysAfter.length, 1);
      assert.equal(keysAfter[0]!.id, keyId);
      assert.equal(keysAfter[0]!.label, 'Primary Groq Key');

      const modelsAfter = db
        .prepare(`SELECT full_id FROM models WHERE provider_id = 'groq'`)
        .all() as Array<{ full_id: string }>;
      assert.equal(modelsAfter.length, 1);
      assert.equal(modelsAfter[0]!.full_id, 'groq/llama-3.3-70b');

      const usageAfter = db
        .prepare(`SELECT prompt_tokens, completion_tokens FROM usage_logs WHERE provider_id = 'groq'`)
        .all() as Array<{ prompt_tokens: number; completion_tokens: number }>;
      assert.equal(usageAfter.length, 1);
      assert.equal(usageAfter[0]!.prompt_tokens, 120);
      assert.equal(usageAfter[0]!.completion_tokens, 80);

      // After update, GET /api/marketplace reports updateAvailable = false & updatesAvailableCount = 0
      const mpRes3 = await app.request('http://localhost/api/marketplace', {
        headers: { Cookie: adminCookie },
      });
      const mp3 = (await mpRes3.json()) as {
        updatesAvailableCount: number;
        providers: Array<{ id: string; updateAvailable: boolean }>;
      };
      assert.equal(mp3.updatesAvailableCount, 0);
      assert.equal(mp3.providers.find((p) => p.id === 'groq')!.updateAvailable, false);

      // Delete custom community source succeeds
      const delCommunity = await app.request(
        `http://localhost/api/marketplace/sources/${communitySourceId}`,
        { method: 'DELETE', headers: { Cookie: adminCookie } },
      );
      assert.equal(delCommunity.status, 200);

      db.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('migrates legacy official marketplace URL cleanly to mazzapata/providers and handles UNIQUE(url) conflict safely', async () => {
    const tmpDir = makeTempDir();
    const dbPath = path.join(tmpDir, 'migrate-official.db');
    const legacyUrl = 'https://raw.githubusercontent.com/sxamx/bifrost-providers/main/index.json';
    try {
      // 1. Standard migration from legacy official URL -> new official URL + cache cleanup
      const db1 = openDatabase(dbPath);
      db1
        .prepare(
          `UPDATE marketplace_sources
           SET name = 'Legacy Official', url = ?, enabled = 1,
               catalog_version = '2026-11-01', last_checked_at = 1700000000, last_error = 'old err'
           WHERE id = 'official'`,
        )
        .run(legacyUrl);
      db1
        .prepare(
          `INSERT OR REPLACE INTO external_cache (cache_key, payload_json, etag, fetched_at)
           VALUES ('marketplace_source:official', '{}', NULL, 1700000000),
                  ('marketplace:index', '{}', NULL, 1700000000),
                  ('unrelated_cache', '{}', NULL, 1700000000)`,
        )
        .run();
      db1.close();

      // Re-opening runs ensureOfficialMarketplaceSource migration
      const db2 = openDatabase(dbPath);
      const migrated = db2
        .prepare(
          `SELECT id, name, url, is_official, enabled, catalog_version, last_checked_at, last_error
           FROM marketplace_sources WHERE id = 'official'`,
        )
        .get() as {
        id: string;
        name: string;
        url: string;
        is_official: number;
        enabled: number;
        catalog_version: string | null;
        last_checked_at: number | null;
        last_error: string | null;
      };
      assert.equal(migrated.name, OFFICIAL_MARKETPLACE_SOURCE_NAME);
      assert.equal(migrated.url, OFFICIAL_MARKETPLACE_SOURCE_URL);
      assert.equal(migrated.is_official, 1);
      assert.equal(migrated.enabled, 1);
      assert.equal(migrated.catalog_version, null);
      assert.equal(migrated.last_checked_at, null);
      assert.equal(migrated.last_error, null);

      const cacheKeys = (
        db2
          .prepare(`SELECT cache_key FROM external_cache ORDER BY cache_key`)
          .all() as Array<{ cache_key: string }>
      ).map((r) => r.cache_key);
      assert.deepEqual(cacheKeys, ['unrelated_cache']);

      // 2. Edge case: user already added mazzapata/providers as a custom source -> no UNIQUE(url) crash on startup
      db2
        .prepare(`UPDATE marketplace_sources SET url = ?, name = 'Legacy Official' WHERE id = 'official'`)
        .run(legacyUrl);
      db2
        .prepare(
          `INSERT INTO marketplace_sources (id, name, url, is_official, enabled, created_at)
           VALUES ('custom-mp', 'Mi Mazzapata', ?, 0, 1, 1700000001)`,
        )
        .run(OFFICIAL_MARKETPLACE_SOURCE_URL);
      db2.close();

      // Must open cleanly without throwing UNIQUE constraint error
      const db3 = openDatabase(dbPath);
      const rows = db3
        .prepare(`SELECT id, url FROM marketplace_sources ORDER BY id`)
        .all() as Array<{ id: string; url: string }>;
      assert.equal(rows.length, 2);
      assert.equal(rows.find((r) => r.id === 'custom-mp')?.url, OFFICIAL_MARKETPLACE_SOURCE_URL);
      assert.equal(rows.find((r) => r.id === 'official')?.url, legacyUrl);
      db3.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

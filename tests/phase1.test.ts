import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { createApp } from '../core/src/app.js';
import {
  MasterKeyError,
  decryptSecret,
  encryptSecret,
  generateInternalApiKey,
  hashPassword,
  resolveMasterKey,
  sha256Hex,
  verifyPassword,
} from '../core/src/crypto.js';
import { openDatabase, writeSystemLog } from '../core/src/db.js';

const tempDirs: string[] = [];

function makeTempDir(prefix = 'bifrost-phase1-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function extractCookiePair(setCookieHeader: string | null): string {
  assert.ok(setCookieHeader, 'Expected Set-Cookie header to be present');
  return setCookieHeader.split(';')[0]!;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('Phase 1 Backend Acceptance Tests', () => {
  describe('HU-01: Fresh install, master.key generation, SQLite schema, and empty state', () => {
    it('creates a 32-byte master.key with 0600 permissions on fresh install and initializes all tables', async () => {
      const dataDir = makeTempDir('bifrost-hu01-');

      const resolved = resolveMasterKey({ dataDir, envMasterKey: undefined });
      assert.equal(resolved.source, 'generated');
      assert.equal(resolved.key.length, 32);
      assert.ok(fs.existsSync(resolved.keyPath), 'master.key file must exist');

      const stat = fs.statSync(resolved.keyPath);
      assert.equal(stat.size, 32, 'master.key must be 32 raw bytes');
      assert.equal(stat.mode & 0o777, 0o600, 'master.key permissions must be 0600');

      const db = openDatabase(resolved.dbPath);
      try {
        const journalRow = db.prepare('PRAGMA journal_mode;').get() as { journal_mode: string };
        assert.equal(journalRow.journal_mode.toLowerCase(), 'wal');

        const fkRow = db.prepare('PRAGMA foreign_keys;').get() as { foreign_keys: number };
        assert.equal(fkRow.foreign_keys, 1);

        const tableRows = db
          .prepare(
            `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
          )
          .all() as Array<{ name: string }>;
        const tableNames = tableRows.map((t) => t.name);

        const expectedTables = [
          'external_cache',
          'internal_api_keys',
          'invitations',
          'models',
          'nodes',
          'provider_keys',
          'providers',
          'sessions',
          'system_logs',
          'usage_logs',
          'user_model_access',
          'users',
        ];
        assert.deepEqual(tableNames, expectedTables);

        const app = createApp({ db, masterKey: resolved.key });

        // Public health check
        const healthRes = await app.request('/api/health');
        assert.equal(healthRes.status, 200);
        assert.deepEqual(await healthRes.json(), { ok: true });

        // Setup initial admin to inspect HU-02 empty-state endpoints
        const setupRes = await app.request('/api/setup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'admin', password: 'strongpassword123' }),
        });
        assert.equal(setupRes.status, 201);
        const cookie = extractCookiePair(setupRes.headers.get('set-cookie'));

        // Empty providers list (HU-01 / HU-02)
        const provRes = await app.request('/api/providers', {
          headers: { Cookie: cookie },
        });
        assert.equal(provRes.status, 200);
        assert.deepEqual(await provRes.json(), { providers: [] });

        // Empty stats on /api/auth/me for onboarding wizard
        const meRes = await app.request('/api/auth/me', {
          headers: { Cookie: cookie },
        });
        assert.equal(meRes.status, 200);
        const meBody = (await meRes.json()) as {
          user: { username: string; role: string };
          stats: { providersCount: number; modelsCount: number; keysCount: number };
        };
        assert.deepEqual(meBody.stats, {
          providersCount: 0,
          modelsCount: 0,
          keysCount: 0,
        });

        // Create internal API key and check empty /v1/models
        const keyRes = await app.request('/api/keys', {
          method: 'POST',
          headers: { Cookie: cookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Default Key' }),
        });
        assert.equal(keyRes.status, 201);
        const { rawKey } = (await keyRes.json()) as { rawKey: string };

        const modelsRes = await app.request('/v1/models', {
          headers: { Authorization: `Bearer ${rawKey}` },
        });
        assert.equal(modelsRes.status, 200);
        assert.deepEqual(await modelsRes.json(), { object: 'list', data: [] });
      } finally {
        db.close();
      }
    });

    it('supports BIFROST_MASTER_KEY in hex (64 chars) and base64 (32 bytes), and redacts secrets in system_logs', async () => {
      const dataDir = makeTempDir('bifrost-envkey-');
      const raw = randomBytes(32);

      const fromHex = resolveMasterKey({ dataDir, envMasterKey: raw.toString('hex') });
      assert.equal(fromHex.source, 'env');
      assert.ok(fromHex.key.equals(raw));

      const fromBase64 = resolveMasterKey({ dataDir, envMasterKey: raw.toString('base64') });
      assert.equal(fromBase64.source, 'env');
      assert.ok(fromBase64.key.equals(raw));

      assert.throws(
        () => resolveMasterKey({ dataDir, envMasterKey: 'too-short' }),
        MasterKeyError,
      );

      // Verify AES-256-GCM round-trip & tamper failure
      const encrypted = encryptSecret('sk-or-v1-supersecret1234', raw);
      assert.ok(encrypted.length > 28);
      assert.equal(decryptSecret(encrypted, raw), 'sk-or-v1-supersecret1234');
      const tampered = Buffer.from(encrypted);
      tampered[tampered.length - 1] ^= 0xff;
      assert.throws(() => decryptSecret(tampered, raw));

      // Verify scrypt round-trip
      const pwHash = await hashPassword('correct-horse-battery-staple');
      assert.equal(await verifyPassword('correct-horse-battery-staple', pwHash), true);
      assert.equal(await verifyPassword('wrong-password', pwHash), false);

      // Verify secret redaction in writeSystemLog
      const db = openDatabase(':memory:');
      try {
        const generated = generateInternalApiKey();
        writeSystemLog(db, 'warn', 'auth', `Rejected token ${generated.rawKey}`, {
          rawKey: generated.rawKey,
          password: 'my-secret-password',
          safeField: 'visible-value',
        });
        const logRow = db.prepare('SELECT message, meta_json FROM system_logs LIMIT 1').get() as {
          message: string;
          meta_json: string;
        };
        assert.ok(!logRow.message.includes(generated.rawKey));
        assert.ok(logRow.message.includes('sk-bf-[REDACTED]'));
        assert.ok(!logRow.meta_json.includes(generated.rawKey));
        assert.ok(!logRow.meta_json.includes('my-secret-password'));
        assert.ok(logRow.meta_json.includes('visible-value'));
      } finally {
        db.close();
      }
    });
  });

  describe('HU-26: Restart with existing database & master.key validation', () => {
    it('restarts cleanly with existing bifrost.db and master.key without user intervention', () => {
      const dataDir = makeTempDir('bifrost-hu26-ok-');

      // First boot
      const boot1 = resolveMasterKey({ dataDir, envMasterKey: undefined });
      assert.equal(boot1.source, 'generated');
      const db1 = openDatabase(boot1.dbPath);
      const nowSec = Math.floor(Date.now() / 1000);
      db1.prepare(
        `INSERT INTO providers (id, name, package_type, models_source, schema_json, enabled, created_at)
         VALUES ('openrouter', 'OpenRouter', 'official-json', 'api', '{}', 1, ?)`,
      ).run(nowSec);
      const cipherBlob = encryptSecret('sk-or-real-secret-9876', boot1.key);
      db1.prepare(
        `INSERT INTO provider_keys (id, provider_id, label, encrypted_secret, last4, status, created_at)
         VALUES (?, 'openrouter', 'Account 1', ?, '9876', 'active', ?)`,
      ).run(randomUUID(), cipherBlob, nowSec);
      db1.close();

      // Simulated VM restart
      const boot2 = resolveMasterKey({ dataDir, envMasterKey: undefined });
      assert.equal(boot2.source, 'file');
      assert.ok(boot2.key.equals(boot1.key));

      const db2 = openDatabase(boot2.dbPath);
      try {
        const row = db2
          .prepare(`SELECT encrypted_secret FROM provider_keys WHERE provider_id = 'openrouter'`)
          .get() as { encrypted_secret: Uint8Array };
        assert.equal(decryptSecret(row.encrypted_secret, boot2.key), 'sk-or-real-secret-9876');
      } finally {
        db2.close();
      }
    });

    it('aborts with clear error and never regenerates master.key when bifrost.db exists and master.key is missing or invalid', () => {
      const dataDir = makeTempDir('bifrost-hu26-fail-');

      // Initial boot creates master.key + bifrost.db
      const boot1 = resolveMasterKey({ dataDir, envMasterKey: undefined });
      const db1 = openDatabase(boot1.dbPath);
      db1.close();

      // Remove master.key while bifrost.db still exists
      fs.unlinkSync(boot1.keyPath);
      assert.ok(fs.existsSync(boot1.dbPath));
      assert.ok(!fs.existsSync(boot1.keyPath));

      assert.throws(
        () => resolveMasterKey({ dataDir, envMasterKey: undefined }),
        (err: unknown) => {
          assert.ok(err instanceof MasterKeyError);
          assert.match(err.message, /Database already exists/i);
          return true;
        },
      );
      assert.equal(fs.existsSync(boot1.keyPath), false, 'Must NEVER regenerate master.key');

      // Verify server entrypoint process exits non-zero with clear stderr message
      const coreDir = path.resolve(import.meta.dirname, '../core');
      const tsxBin = path.join(coreDir, 'node_modules', '.bin', 'tsx');
      const entryPath = path.join(coreDir, 'src', 'index.ts');
      const proc = spawnSync(tsxBin, [entryPath], {
        cwd: coreDir,
        env: {
          ...process.env,
          DATA_DIR: dataDir,
          BIFROST_MASTER_KEY: '',
          PORT: '0',
        },
        encoding: 'utf8',
      });
      assert.notEqual(proc.status, 0, 'Server must exit with non-zero status');
      assert.match(proc.stderr, /\[Bifrost FATAL\].*master key/i);
      assert.equal(fs.existsSync(boot1.keyPath), false, 'Process must not create master.key');

      // Invalid master.key length (16 bytes instead of 32 bytes)
      fs.writeFileSync(boot1.keyPath, randomBytes(16), { mode: 0o600 });
      assert.throws(
        () => resolveMasterKey({ dataDir, envMasterKey: undefined }),
        (err: unknown) => {
          assert.ok(err instanceof MasterKeyError);
          assert.match(err.message, /expected exactly 32 bytes/i);
          return true;
        },
      );
    });
  });

  describe('HU-03: Initial Admin Setup and HttpOnly Cookie Authentication', () => {
    it('enforces uninitialized state, creates admin once, rejects second setup with 409, and supports login/logout/me', async () => {
      const db = openDatabase(':memory:');
      const masterKey = randomBytes(32);

      try {
        const app = createApp({ db, masterKey });

        // 1. Before setup: initialized === false, protected endpoints return 401
        const statusBefore = await app.request('/api/status');
        assert.equal(statusBefore.status, 200);
        assert.deepEqual(await statusBefore.json(), { initialized: false });

        for (const pathName of ['/api/auth/me', '/api/providers', '/api/keys']) {
          const res = await app.request(pathName);
          assert.equal(res.status, 401, `Expected 401 for ${pathName} before auth`);
        }

        // 2. Reject invalid username / password lengths
        const badUserRes = await app.request('/api/setup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'ab', password: 'validpassword123' }),
        });
        assert.equal(badUserRes.status, 400);

        const badPassRes = await app.request('/api/setup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'rootadmin', password: 'short' }),
        });
        assert.equal(badPassRes.status, 400);

        // 3. Valid setup creates admin and sets HttpOnly cookie
        const setupRes = await app.request('/api/setup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'rootadmin', password: 'super-secret-password' }),
        });
        assert.equal(setupRes.status, 201);
        const setCookie = setupRes.headers.get('set-cookie');
        assert.ok(setCookie);
        assert.match(setCookie, /bifrost_session=/);
        assert.match(setCookie, /HttpOnly/i);
        assert.match(setCookie, /SameSite=Lax/i);
        assert.match(setCookie, /Path=\//i);

        const setupJson = (await setupRes.json()) as {
          user: { id: string; username: string; role: string };
        };
        assert.equal(setupJson.user.username, 'rootadmin');
        assert.equal(setupJson.user.role, 'admin');

        // Status now initialized: true
        const statusAfter = await app.request('/api/status');
        assert.deepEqual(await statusAfter.json(), { initialized: true });

        // 4. Second POST /api/setup returns 409
        const secondSetup = await app.request('/api/setup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'attacker', password: 'another-password-123' }),
        });
        assert.equal(secondSetup.status, 409);

        // 5. Authenticated /api/auth/me works with session cookie
        const sessionCookie = extractCookiePair(setCookie);
        const meRes = await app.request('/api/auth/me', {
          headers: { Cookie: sessionCookie },
        });
        assert.equal(meRes.status, 200);
        const meBody = (await meRes.json()) as {
          user: { id: string; username: string; role: string; dailyTokenLimit: null };
        };
        assert.equal(meBody.user.username, 'rootadmin');
        assert.equal(meBody.user.role, 'admin');
        assert.equal(meBody.user.dailyTokenLimit, null);

        // 6. Logout destroys server session so replaying old cookie returns 401
        const logoutRes = await app.request('/api/auth/logout', {
          method: 'POST',
          headers: { Cookie: sessionCookie },
        });
        assert.equal(logoutRes.status, 200);

        const meAfterLogout = await app.request('/api/auth/me', {
          headers: { Cookie: sessionCookie },
        });
        assert.equal(meAfterLogout.status, 401);

        // 7. Login rejects wrong password and succeeds with right password
        const badLogin = await app.request('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'rootadmin', password: 'wrong-password' }),
        });
        assert.equal(badLogin.status, 401);

        const goodLogin = await app.request('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'rootadmin', password: 'super-secret-password' }),
        });
        assert.equal(goodLogin.status, 200);
        const newCookie = extractCookiePair(goodLogin.headers.get('set-cookie'));

        const meAfterLogin = await app.request('/api/auth/me', {
          headers: { Cookie: newCookie },
        });
        assert.equal(meAfterLogin.status, 200);
      } finally {
        db.close();
      }
    });
  });

  describe('HU-03b: Internal API Keys (sk-bf-...), /v1/* endpoints, and UTC quota enforcement', () => {
    it('shows full sk-bf-... key only once, stores only SHA-256 hash, validates /v1/* auth, and enforces UTC daily quota', async () => {
      const db = openDatabase(':memory:');
      const masterKey = randomBytes(32);
      // Fixed clock: 2026-11-17T15:30:00.000Z
      let currentTimeMs = Date.parse('2026-11-17T15:30:00.000Z');

      try {
        const app = createApp({
          db,
          masterKey,
          now: () => currentTimeMs,
        });

        // Setup admin
        const setupRes = await app.request('/api/setup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'admin', password: 'admin-password-123' }),
        });
        const adminCookie = extractCookiePair(setupRes.headers.get('set-cookie'));

        // Create internal API key
        const createKeyRes = await app.request('/api/keys', {
          method: 'POST',
          headers: {
            Cookie: adminCookie,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ name: 'Cursor IDE' }),
        });
        assert.equal(createKeyRes.status, 201);
        const createKeyJson = (await createKeyRes.json()) as {
          key: {
            id: string;
            name: string;
            keyPrefix: string;
            createdAt: number;
            lastUsedAt: number | null;
          };
          rawKey: string;
        };

        assert.match(createKeyJson.rawKey, /^sk-bf-[A-Za-z0-9_-]{40,}$/);
        assert.equal(createKeyJson.key.keyPrefix.length, 12);
        assert.equal(createKeyJson.key.keyPrefix, createKeyJson.rawKey.slice(0, 12));
        assert.equal(createKeyJson.key.lastUsedAt, null);

        // Verify SQLite stores ONLY key_prefix and SHA-256 hash (never rawKey)
        const dbKeyRow = db
          .prepare(`SELECT key_prefix, key_hash FROM internal_api_keys WHERE id = ?`)
          .get(createKeyJson.key.id) as { key_prefix: string; key_hash: string };
        assert.equal(dbKeyRow.key_prefix, createKeyJson.key.keyPrefix);
        assert.equal(dbKeyRow.key_hash, sha256Hex(createKeyJson.rawKey));
        assert.notEqual(dbKeyRow.key_hash, createKeyJson.rawKey);

        // GET /api/keys NEVER returns rawKey or keyHash
        const listKeysRes = await app.request('/api/keys', {
          headers: { Cookie: adminCookie },
        });
        assert.equal(listKeysRes.status, 200);
        const listKeysJson = (await listKeysRes.json()) as {
          keys: Array<Record<string, unknown>>;
        };
        assert.equal(listKeysJson.keys.length, 1);
        assert.equal(listKeysJson.keys[0]!.keyPrefix, createKeyJson.key.keyPrefix);
        assert.equal('rawKey' in listKeysJson.keys[0]!, false);
        assert.equal('keyHash' in listKeysJson.keys[0]!, false);
        assert.equal('key_hash' in listKeysJson.keys[0]!, false);

        // Missing or invalid key on /v1/models returns 401 OpenAI error
        const noAuthV1 = await app.request('/v1/models');
        assert.equal(noAuthV1.status, 401);
        const noAuthBody = (await noAuthV1.json()) as { error: { code: string } };
        assert.equal(noAuthBody.error.code, 'invalid_api_key');

        const badKeyV1 = await app.request('/v1/models', {
          headers: { Authorization: 'Bearer sk-bf-nonexistentkeyvalue1234567890' },
        });
        assert.equal(badKeyV1.status, 401);

        // Valid key works on /v1/models and updates lastUsedAt
        const validV1 = await app.request('/v1/models', {
          headers: { Authorization: `Bearer ${createKeyJson.rawKey}` },
        });
        assert.equal(validV1.status, 200);
        assert.deepEqual(await validV1.json(), { object: 'list', data: [] });

        const listAfterUse = await app.request('/api/keys', {
          headers: { Cookie: adminCookie },
        });
        const afterUseJson = (await listAfterUse.json()) as {
          keys: Array<{ lastUsedAt: number | null }>;
        };
        assert.equal(afterUseJson.keys[0]!.lastUsedAt, Math.floor(currentTimeMs / 1000));

        // POST /v1/chat/completions when no model is configured returns clean 404 OpenAI error
        const chatMissingRes = await app.request('/v1/chat/completions', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${createKeyJson.rawKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'openrouter/deepseek-r1:free',
            messages: [{ role: 'user', content: 'Hello' }],
          }),
        });
        assert.equal(chatMissingRes.status, 404);
        const chatMissingBody = (await chatMissingRes.json()) as {
          error: { message: string; code: string };
        };
        assert.equal(chatMissingBody.error.code, 'model_not_found');

        // Revoking key via DELETE /api/keys/:id blocks further /v1/* requests with 401
        const revokeRes = await app.request(`/api/keys/${createKeyJson.key.id}`, {
          method: 'DELETE',
          headers: { Cookie: adminCookie },
        });
        assert.equal(revokeRes.status, 200);

        const revokedV1 = await app.request('/v1/models', {
          headers: { Authorization: `Bearer ${createKeyJson.rawKey}` },
        });
        assert.equal(revokedV1.status, 401);

        // Guest user with daily_token_limit = 1000 and model access filtering + UTC quota enforcement
        const guestId = randomUUID();
        const guestPwHash = await hashPassword('guest-password-123');
        const nowSec = Math.floor(currentTimeMs / 1000);

        db.prepare(
          `INSERT INTO users (id, username, password_hash, role, daily_token_limit, quota_reset_mode, created_at)
           VALUES (?, 'alice', ?, 'guest', 1000, 'utc_midnight', ?)`,
        ).run(guestId, guestPwHash, nowSec);

        // Insert two models on an enabled provider, grant guest access to only one
        db.prepare(
          `INSERT INTO providers (id, name, package_type, models_source, schema_json, enabled, created_at)
           VALUES ('openrouter', 'OpenRouter', 'official-json', 'api', '{}', 1, ?)`,
        ).run(nowSec);
        db.prepare(
          `INSERT INTO models (full_id, provider_id, model_id, name, modalities_json, capabilities_json, is_free, first_seen_at, active)
           VALUES
             ('openrouter/model-allowed:free', 'openrouter', 'model-allowed:free', 'Allowed', '{}', '{}', 1, ?, 1),
             ('openrouter/model-secret:free', 'openrouter', 'model-secret:free', 'Secret', '{}', '{}', 1, ?, 1)`,
        ).run(nowSec, nowSec);
        db.prepare(
          `INSERT INTO user_model_access (user_id, model_full_id) VALUES (?, 'openrouter/model-allowed:free')`,
        ).run(guestId);

        const guestKey = generateInternalApiKey();
        db.prepare(
          `INSERT INTO internal_api_keys (id, user_id, name, key_prefix, key_hash, created_at)
           VALUES (?, ?, 'Guest Key', ?, ?, ?)`,
        ).run(randomUUID(), guestId, guestKey.keyPrefix, guestKey.keyHash, nowSec);

        // Guest sees ONLY allowed model in /v1/models
        const guestModelsRes = await app.request('/v1/models', {
          headers: { Authorization: `Bearer ${guestKey.rawKey}` },
        });
        assert.equal(guestModelsRes.status, 200);
        const guestModelsBody = (await guestModelsRes.json()) as {
          object: string;
          data: Array<{ id: string }>;
        };
        assert.deepEqual(
          guestModelsBody.data.map((m) => m.id),
          ['openrouter/model-allowed:free'],
        );

        // Guest gets 403 for disallowed model on /v1/chat/completions
        const forbiddenChat = await app.request('/v1/chat/completions', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${guestKey.rawKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'openrouter/model-secret:free',
            messages: [{ role: 'user', content: 'Hi' }],
          }),
        });
        assert.equal(forbiddenChat.status, 403);

        // Record 1000 tokens used today (2026-11-17 UTC)
        db.prepare(
          `INSERT INTO usage_logs (user_id, provider_id, model_full_id, prompt_tokens, completion_tokens, reasoning_tokens, duration_ms, status, created_at)
           VALUES (?, 'openrouter', 'openrouter/model-allowed:free', 600, 300, 100, 250, 'ok', ?)`,
        ).run(guestId, nowSec);

        // Quota is now exhausted -> 429 with ISO-8601 UTC reset_at, even if client sends spoofed Date header
        const quotaExceededRes = await app.request('/v1/models', {
          headers: {
            Authorization: `Bearer ${guestKey.rawKey}`,
            Date: 'Wed, 18 Nov 2026 12:00:00 GMT',
          },
        });
        assert.equal(quotaExceededRes.status, 429);
        const quotaBody = (await quotaExceededRes.json()) as {
          reset_at: string;
          error: { message: string; code: string; reset_at: string };
        };
        assert.equal(quotaBody.reset_at, '2026-11-18T00:00:00.000Z');
        assert.equal(quotaBody.error.reset_at, '2026-11-18T00:00:00.000Z');
        assert.equal(quotaBody.error.code, 'daily_quota_exceeded');

        // Advance server clock to 2026-11-18T00:00:01.000Z -> quota resets automatically!
        currentTimeMs = Date.parse('2026-11-18T00:00:01.000Z');
        const afterResetRes = await app.request('/v1/models', {
          headers: { Authorization: `Bearer ${guestKey.rawKey}` },
        });
        assert.equal(afterResetRes.status, 200);
      } finally {
        db.close();
      }
    });
  });

  describe('Static SPA serving fallback', () => {
    it('serves static files from panelDistDir and falls back to index.html for SPA routes', async () => {
      const distDir = makeTempDir('bifrost-spa-');
      fs.mkdirSync(path.join(distDir, 'assets'), { recursive: true });
      fs.writeFileSync(path.join(distDir, 'index.html'), '<!doctype html><title>Bifrost</title>');
      fs.writeFileSync(path.join(distDir, 'assets', 'app.js'), 'console.log("bifrost");');

      const db = openDatabase(':memory:');
      try {
        const app = createApp({ db, masterKey: randomBytes(32), panelDistDir: distDir });

        const assetRes = await app.request('/assets/app.js');
        assert.equal(assetRes.status, 200);
        assert.match(assetRes.headers.get('content-type') ?? '', /javascript/);
        assert.equal(await assetRes.text(), 'console.log("bifrost");');

        const spaRouteRes = await app.request('/settings/keys');
        assert.equal(spaRouteRes.status, 200);
        assert.match(spaRouteRes.headers.get('content-type') ?? '', /text\/html/);
        assert.equal(await spaRouteRes.text(), '<!doctype html><title>Bifrost</title>');

        const unknownApiRes = await app.request('/api/does-not-exist');
        assert.equal(unknownApiRes.status, 401); // Protected /api/* middleware runs first
      } finally {
        db.close();
      }
    });
  });
});

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  createApp,
  packBifrostEnvelope,
  unpackBifrostEnvelopeRaw,
} from '../core/src/app.js';
import { decryptSecret, sha256Hex } from '../core/src/crypto.js';
import { openDatabase } from '../core/src/db.js';

const tempDirs: string[] = [];

function makeTempDir(prefix = 'bifrost-phase8-'): string {
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

describe('Phase 8 Backend Acceptance & Red-Team Security Tests (HU-04, HU-05, HU-25, HU-25b)', () => {
  describe('HU-04 & HU-05: Single-use guest invitations, model whitelist, quota updates, and telemetry-preserving deletion', () => {
    it('enforces single-use invitations, guest model isolation across /v1 & Playground, quota updates, and safe user deletion', async () => {
      const dir = makeTempDir('bifrost-p8-users-');
      const db = openDatabase(path.join(dir, 'bifrost.db'));
      const masterKey = randomBytes(32);
      let clockMs = Date.UTC(2026, 10, 18, 12, 0, 0);

      const mockFetch: typeof fetch = async (input) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.endsWith('/models')) {
          return new Response(
            JSON.stringify({
              data: [
                {
                  id: 'meta-llama/llama-3.3-70b:free',
                  name: 'Llama 3.3 70B Free',
                  pricing: { prompt: '0', completion: '0' },
                },
                {
                  id: 'deepseek/deepseek-r1:free',
                  name: 'DeepSeek R1 Free',
                  pricing: { prompt: '0', completion: '0' },
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (url.endsWith('/chat/completions')) {
          return new Response(
            JSON.stringify({
              id: 'chatcmpl-p8-1',
              object: 'chat.completion',
              created: Math.floor(clockMs / 1000),
              model: 'meta-llama/llama-3.3-70b:free',
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: 'Hello allowed guest!' },
                  finish_reason: 'stop',
                },
              ],
              usage: {
                prompt_tokens: 20,
                completion_tokens: 15,
                total_tokens: 35,
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response('Not found', { status: 404 });
      };

      try {
        const app = createApp({
          db,
          masterKey,
          fetchImpl: mockFetch,
          now: () => clockMs,
        });

        // 1. Setup initial admin
        const setupRes = await app.request('http://localhost/api/setup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'admin', password: 'adminPassword123!' }),
        });
        assert.equal(setupRes.status, 201);
        const adminCookie = extractCookiePair(setupRes.headers.get('set-cookie'));
        const setupJson = (await setupRes.json()) as { user: { id: string } };
        const adminId = setupJson.user.id;

        // 2. Install OpenRouter, add key, and sync 2 free models
        const installRes = await app.request('http://localhost/api/marketplace/install', {
          method: 'POST',
          headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({ providerId: 'openrouter' }),
        });
        assert.equal(installRes.status, 201);

        const addKeyRes = await app.request('http://localhost/api/providers/openrouter/keys', {
          method: 'POST',
          headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({ label: 'Primary OR', secret: 'sk-or-v1-supersecretkey1234' }),
        });
        assert.equal(addKeyRes.status, 201);

        const syncRes = await app.request('http://localhost/api/providers/openrouter/detect-models', {
          method: 'POST',
          headers: { Cookie: adminCookie },
        });
        assert.equal(syncRes.status, 200);

        const allowedModel = 'openrouter/meta-llama/llama-3.3-70b:free';
        const restrictedModel = 'openrouter/deepseek/deepseek-r1:free';

        // 3. Admin creates a single-use guest invitation
        const invRes = await app.request('http://localhost/api/invitations', {
          method: 'POST',
          headers: {
            Cookie: adminCookie,
            Origin: 'https://bifrost.example.com',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            dailyTokenLimit: 500,
            quotaResetMode: 'rolling_24h',
            allowedModels: [allowedModel],
            expiresInHours: 12,
          }),
        });
        assert.equal(invRes.status, 201);
        const invBody = (await invRes.json()) as {
          token: string;
          inviteUrl: string;
          invitation: { id: string; status: string; allowedModels: string[] };
        };
        assert.ok(invBody.token.startsWith('bfi_'));
        assert.equal(
          invBody.inviteUrl,
          `https://bifrost.example.com/?invite=${encodeURIComponent(invBody.token)}`,
        );
        assert.equal(invBody.invitation.status, 'pending');
        assert.deepEqual(invBody.invitation.allowedModels, [allowedModel]);

        // Raw token must NEVER be stored in SQLite (only SHA-256 hash) nor leaked in GET /api/invitations
        const rawDbInvite = db
          .prepare(`SELECT token_hash FROM invitations WHERE id = ?`)
          .get(invBody.invitation.id) as { token_hash: string };
        assert.equal(rawDbInvite.token_hash, sha256Hex(invBody.token));

        const listInvRes = await app.request('http://localhost/api/invitations', {
          headers: { Cookie: adminCookie },
        });
        assert.equal(listInvRes.status, 200);
        const listInvText = await listInvRes.text();
        assert.ok(!listInvText.includes(invBody.token), 'GET /api/invitations must never leak raw token');
        assert.ok(!listInvText.includes(rawDbInvite.token_hash), 'GET /api/invitations must never leak token_hash');

        // 4. Public POST /api/invitations/:token/accept registers guest and sets session cookie
        const acceptRes = await app.request(
          `http://localhost/api/invitations/${encodeURIComponent(invBody.token)}/accept`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'guest_alice', password: 'alicePassword123!' }),
          },
        );
        assert.equal(acceptRes.status, 201);
        const guestCookie = extractCookiePair(acceptRes.headers.get('set-cookie'));
        const acceptJson = (await acceptRes.json()) as {
          user: { id: string; username: string; role: string; dailyTokenLimit: number; quotaResetMode: string };
        };
        assert.equal(acceptJson.user.username, 'guest_alice');
        assert.equal(acceptJson.user.role, 'guest');
        assert.equal(acceptJson.user.dailyTokenLimit, 500);
        assert.equal(acceptJson.user.quotaResetMode, 'rolling_24h');
        const guestId = acceptJson.user.id;

        // 5. Re-using the same single-use invitation token is rejected with 410 Gone
        const reuseRes = await app.request(
          `http://localhost/api/invitations/${encodeURIComponent(invBody.token)}/accept`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'guest_bob', password: 'bobPassword123!' }),
          },
        );
        assert.equal(reuseRes.status, 410);

        // 6. Expired invitation token is rejected with 410 Gone
        const expInvRes = await app.request('http://localhost/api/invitations', {
          method: 'POST',
          headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            dailyTokenLimit: 200,
            allowedModels: [allowedModel],
            expiresInHours: 1,
          }),
        });
        const expInvJson = (await expInvRes.json()) as { token: string };
        clockMs += 2 * 3600 * 1000; // advance 2 hours past 1h expiry

        const expiredAcceptRes = await app.request(
          `http://localhost/api/invitations/${encodeURIComponent(expInvJson.token)}/accept`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'guest_late', password: 'latePassword123!' }),
          },
        );
        assert.equal(expiredAcceptRes.status, 410);

        // 7. Guest privileges & model isolation across Catalog, /v1/*, and Playground
        const guestUsersForbidden = await app.request('http://localhost/api/users', {
          headers: { Cookie: guestCookie },
        });
        assert.equal(guestUsersForbidden.status, 403);

        const guestBackupForbidden = await app.request('http://localhost/api/backup/export', {
          method: 'POST',
          headers: { Cookie: guestCookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: 'somePassword123' }),
        });
        assert.equal(guestBackupForbidden.status, 403);

        // Guest creates own internal sk-bf-... key
        const guestKeyRes = await app.request('http://localhost/api/keys', {
          method: 'POST',
          headers: { Cookie: guestCookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Alice CLI' }),
        });
        assert.equal(guestKeyRes.status, 201);
        const { rawKey: guestApiKey } = (await guestKeyRes.json()) as { rawKey: string };

        // Catalog only returns allowedModel for guest
        const guestCatalogRes = await app.request('http://localhost/api/models', {
          headers: { Cookie: guestCookie },
        });
        assert.equal(guestCatalogRes.status, 200);
        const guestCatalog = (await guestCatalogRes.json()) as { models: Array<{ fullId: string }> };
        assert.deepEqual(
          guestCatalog.models.map((m) => m.fullId),
          [allowedModel],
        );

        // /v1/models only returns allowedModel for guest
        const guestV1ModelsRes = await app.request('http://localhost/v1/models', {
          headers: { Authorization: `Bearer ${guestApiKey}` },
        });
        assert.equal(guestV1ModelsRes.status, 200);
        const guestV1Models = (await guestV1ModelsRes.json()) as { data: Array<{ id: string }> };
        assert.deepEqual(
          guestV1Models.data.map((m) => m.id),
          [allowedModel],
        );

        // Restricted model blocked with 403 on both /v1/chat/completions and /api/playground/chat
        const blockedV1Chat = await app.request('http://localhost/v1/chat/completions', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${guestApiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: restrictedModel,
            messages: [{ role: 'user', content: 'Try restricted' }],
          }),
        });
        assert.equal(blockedV1Chat.status, 403);

        const blockedPlaygroundChat = await app.request('http://localhost/api/playground/chat', {
          method: 'POST',
          headers: { Cookie: guestCookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: restrictedModel,
            stream: false,
            messages: [{ role: 'user', content: 'Try restricted in playground' }],
          }),
        });
        assert.equal(blockedPlaygroundChat.status, 403);

        // Allowed model succeeds on /v1/chat/completions and records 35 tokens
        const okV1Chat = await app.request('http://localhost/v1/chat/completions', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${guestApiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: allowedModel,
            messages: [{ role: 'user', content: 'Hello!' }],
          }),
        });
        assert.equal(okV1Chat.status, 200);

        // 8. Admin GET /api/users shows usedTokensToday=35 without exposing password_hash, and PATCH updates quota/models
        const listUsersRes = await app.request('http://localhost/api/users', {
          headers: { Cookie: adminCookie },
        });
        assert.equal(listUsersRes.status, 200);
        const listUsersRawText = await listUsersRes.text();
        assert.ok(!listUsersRawText.includes('password_hash'), 'Must never expose password_hash');
        assert.ok(!listUsersRawText.includes('scrypt$'), 'Must never expose password scrypt hash');

        const usersList = (JSON.parse(listUsersRawText) as {
          users: Array<{
            id: string;
            username: string;
            usedTokensToday: number;
            dailyTokenLimit: number | null;
            allowedModels: string[];
          }>;
        }).users;
        const aliceSummary = usersList.find((u) => u.id === guestId);
        assert.ok(aliceSummary);
        assert.equal(aliceSummary.usedTokensToday, 35);

        const patchUserRes = await app.request(`http://localhost/api/users/${guestId}`, {
          method: 'PATCH',
          headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            dailyTokenLimit: 2000,
            quotaResetMode: 'utc_midnight',
            allowedModels: [allowedModel, restrictedModel],
          }),
        });
        assert.equal(patchUserRes.status, 200);
        const patchedJson = (await patchUserRes.json()) as {
          user: { dailyTokenLimit: number; quotaResetMode: string; allowedModels: string[] };
        };
        assert.equal(patchedJson.user.dailyTokenLimit, 2000);
        assert.equal(patchedJson.user.quotaResetMode, 'utc_midnight');
        assert.equal(patchedJson.user.allowedModels.length, 2);

        // Restricted model is now permitted for Alice!
        const nowAllowedChat = await app.request('http://localhost/v1/chat/completions', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${guestApiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: restrictedModel,
            messages: [{ role: 'user', content: 'Now allowed!' }],
          }),
        });
        assert.equal(nowAllowedChat.status, 200);

        // 9. Admin cannot delete own account (400), and deleting guest revokes session + API keys while preserving usage_logs!
        const selfDeleteRes = await app.request(`http://localhost/api/users/${adminId}`, {
          method: 'DELETE',
          headers: { Cookie: adminCookie },
        });
        assert.equal(selfDeleteRes.status, 400);

        const usageBeforeDelete = (
          db.prepare(`SELECT COUNT(*) AS cnt FROM usage_logs`).get() as { cnt: number }
        ).cnt;
        assert.equal(usageBeforeDelete, 2);

        const deleteGuestRes = await app.request(`http://localhost/api/users/${guestId}`, {
          method: 'DELETE',
          headers: { Cookie: adminCookie },
        });
        assert.equal(deleteGuestRes.status, 200);

        // Guest cookie and sk-bf-... key are immediately invalidated (401)
        const revokedSessionRes = await app.request('http://localhost/api/auth/me', {
          headers: { Cookie: guestCookie },
        });
        assert.equal(revokedSessionRes.status, 401);

        const revokedKeyRes = await app.request('http://localhost/v1/models', {
          headers: { Authorization: `Bearer ${guestApiKey}` },
        });
        assert.equal(revokedKeyRes.status, 401);

        // Historical usage_logs are 100% intact for global provider uptime telemetry!
        const usageAfterDelete = (
          db.prepare(`SELECT COUNT(*) AS cnt FROM usage_logs`).get() as { cnt: number }
        ).cnt;
        assert.equal(usageAfterDelete, 2);
      } finally {
        db.close();
      }
    });
  });

  describe('HU-25 & HU-25b: BIFROST1 encrypted .bifrost.enc backups, tamper rejection, and cross-masterKey re-encryption', () => {
    it('exports BIFROST1 .bifrost.enc, rejects tampered/corrupted/polluted payloads with 0 partial writes, and re-encrypts provider_keys & nodes.encrypted_token under a new masterKey', async () => {
      const dirA = makeTempDir('bifrost-p8-instA-');
      const dirB = makeTempDir('bifrost-p8-instB-');
      const dbA = openDatabase(path.join(dirA, 'bifrost.db'));
      const dbB = openDatabase(path.join(dirB, 'bifrost.db'));
      const masterKeyA = randomBytes(32);
      const masterKeyB = randomBytes(32);
      assert.notDeepEqual(masterKeyA, masterKeyB);

      const nowMs = Date.UTC(2026, 10, 18, 15, 30, 0);

      const mockFetch: typeof fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.endsWith('/models')) {
          return new Response(
            JSON.stringify({
              data: [
                {
                  id: 'gemma-3-27b:free',
                  name: 'Gemma 3 27B Free',
                  pricing: { prompt: '0', completion: '0' },
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (url.endsWith('/chat/completions')) {
          const headers = new Headers(init?.headers);
          assert.equal(
            headers.get('authorization'),
            'Bearer sk-or-v1-migrated-secret-9999',
            'Instance B must authenticate upstream with secret decrypted using masterKeyB',
          );
          return new Response(
            JSON.stringify({
              id: 'chatcmpl-restored-1',
              object: 'chat.completion',
              created: Math.floor(nowMs / 1000),
              model: 'gemma-3-27b:free',
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: 'Restored on Instance B!' },
                  finish_reason: 'stop',
                },
              ],
              usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response('Not found', { status: 404 });
      };

      try {
        const appA = createApp({
          db: dbA,
          masterKey: masterKeyA,
          fetchImpl: mockFetch,
          now: () => nowMs,
        });

        // Populate Instance A: admin, provider, provider_key, exit node (with encrypted_token + tls_fingerprint), model, guest + sk-bf key
        const setupARes = await appA.request('http://localhost/api/setup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'admin', password: 'sourceAdminPassword123!' }),
        });
        assert.equal(setupARes.status, 201);
        const cookieA = extractCookiePair(setupARes.headers.get('set-cookie'));

        await appA.request('http://localhost/api/marketplace/install', {
          method: 'POST',
          headers: { Cookie: cookieA, 'Content-Type': 'application/json' },
          body: JSON.stringify({ providerId: 'openrouter' }),
        });

        await appA.request('http://localhost/api/providers/openrouter/keys', {
          method: 'POST',
          headers: { Cookie: cookieA, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            label: 'Migrated Key',
            secret: 'sk-or-v1-migrated-secret-9999',
          }),
        });

        await appA.request('http://localhost/api/providers/openrouter/detect-models', {
          method: 'POST',
          headers: { Cookie: cookieA },
        });

        // Create an exit node with TLS fingerprint on Instance A
        const pinnedFp = 'AA'.repeat(32);
        const createNodeRes = await appA.request('http://localhost/api/nodes', {
          method: 'POST',
          headers: { Cookie: cookieA, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'Exit-Madrid',
            mode: 'tailscale',
            endpoint: 'https://100.90.10.20:8443',
            tlsFingerprint: pinnedFp,
          }),
        });
        assert.equal(createNodeRes.status, 201);
        const { node: createdNode, rawToken: originalNodeToken } = (await createNodeRes.json()) as {
          node: { id: string };
          rawToken: string;
        };

        // Create guest via invitation + internal sk-bf-... key on Instance A
        const invARes = await appA.request('http://localhost/api/invitations', {
          method: 'POST',
          headers: { Cookie: cookieA, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            dailyTokenLimit: 1500,
            allowedModels: ['openrouter/gemma-3-27b:free'],
          }),
        });
        const { token: inviteTokenA } = (await invARes.json()) as { token: string };

        const acceptARes = await appA.request(
          `http://localhost/api/invitations/${encodeURIComponent(inviteTokenA)}/accept`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'migrated_guest', password: 'guestPass123!' }),
          },
        );
        const guestCookieA = extractCookiePair(acceptARes.headers.get('set-cookie'));

        const guestKeyARes = await appA.request('http://localhost/api/keys', {
          method: 'POST',
          headers: { Cookie: guestCookieA, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Portable CLI Key' }),
        });
        const { rawKey: portableSkBfKey } = (await guestKeyARes.json()) as { rawKey: string };

        // Generate 1 usage_log on Instance A
        const preChatRes = await appA.request('http://localhost/v1/chat/completions', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${portableSkBfKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'openrouter/gemma-3-27b:free',
            messages: [{ role: 'user', content: 'Ping on A' }],
          }),
        });
        assert.equal(preChatRes.status, 200);

        // Export .bifrost.enc from Instance A
        const backupPassword = 'BackupVaultPassword#2026';
        const exportRes = await appA.request('http://localhost/api/backup/export', {
          method: 'POST',
          headers: { Cookie: cookieA, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            password: backupPassword,
            includeTelemetry: true,
          }),
        });
        assert.equal(exportRes.status, 200);
        assert.equal(exportRes.headers.get('content-type'), 'application/octet-stream');
        assert.match(
          exportRes.headers.get('content-disposition') ?? '',
          /bifrost-backup-2026-11-18\.bifrost\.enc/,
        );

        const backupBytes = Buffer.from(await exportRes.arrayBuffer());
        assert.equal(backupBytes.subarray(0, 8).toString('ascii'), 'BIFROST1');
        assert.equal(backupBytes[8], 1);

        // Setup fresh Instance B with DIFFERENT masterKeyB (and colliding 'admin' username + existing usage_log/invitation to verify FK-safe swap!)
        const appB = createApp({
          db: dbB,
          masterKey: masterKeyB,
          fetchImpl: mockFetch,
          maxBackupUncompressedBytes: 2 * 1024 * 1024,
          now: () => nowMs,
        });

        const setupBRes = await appB.request('http://localhost/api/setup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'admin', password: 'tempInstanceBPassword!' }),
        });
        assert.equal(setupBRes.status, 201);
        const cookieB = extractCookiePair(setupBRes.headers.get('set-cookie'));
        const adminBId = ((await setupBRes.json()) as { user: { id: string } }).user.id;

        // Seed a local invitation and usage_log tied to adminBId so username='admin' swap exercises FK re-pointing
        await appB.request('http://localhost/api/invitations', {
          method: 'POST',
          headers: { Cookie: cookieB, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            dailyTokenLimit: 100,
            allowedModels: ['*'],
          }),
        });
        dbB
          .prepare(
            `INSERT INTO usage_logs (
               user_id, provider_id, provider_key_id, model_full_id,
               prompt_tokens, completion_tokens, reasoning_tokens, cached_tokens,
               ttft_ms, duration_ms, tokens_per_sec, status, error_type, created_at
             ) VALUES (?, 'local', NULL, 'local/test', 5, 5, 0, 0, 10, 50, 100, 'ok', NULL, ?)`,
          )
          .run(adminBId, Math.floor(nowMs / 1000));

        const snapshotCountsBeforeTamper = () => ({
          users: (dbB.prepare(`SELECT COUNT(*) AS c FROM users`).get() as { c: number }).c,
          providers: (dbB.prepare(`SELECT COUNT(*) AS c FROM providers`).get() as { c: number }).c,
          keys: (dbB.prepare(`SELECT COUNT(*) AS c FROM provider_keys`).get() as { c: number }).c,
          nodes: (dbB.prepare(`SELECT COUNT(*) AS c FROM nodes`).get() as { c: number }).c,
        });
        const baselineB = snapshotCountsBeforeTamper();

        // --- Red-Team Negative / Tamper Tests (MUST return 400 and leave 0 partial changes) ---

        // (a) Wrong password
        const wrongPwRes = await appB.request('http://localhost/api/backup/import', {
          method: 'POST',
          headers: { Cookie: cookieB, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            password: 'WrongPassword12345!',
            fileBase64: backupBytes.toString('base64'),
          }),
        });
        assert.equal(wrongPwRes.status, 400);
        assert.deepEqual(snapshotCountsBeforeTamper(), baselineB);

        // (b) 1-byte flip in AES-256-GCM Auth Tag (offset 40)
        const flippedTag = Buffer.from(backupBytes);
        flippedTag[40] ^= 0xff;
        const flippedTagRes = await appB.request('http://localhost/api/backup/import', {
          method: 'POST',
          headers: { Cookie: cookieB, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            password: backupPassword,
            fileBase64: flippedTag.toString('base64'),
          }),
        });
        assert.equal(flippedTagRes.status, 400);
        assert.deepEqual(snapshotCountsBeforeTamper(), baselineB);

        // (c) 1-byte flip in Ciphertext
        const flippedCipher = Buffer.from(backupBytes);
        flippedCipher[flippedCipher.length - 1] ^= 0x01;
        const flippedCipherRes = await appB.request('http://localhost/api/backup/import', {
          method: 'POST',
          headers: { Cookie: cookieB, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            password: backupPassword,
            fileBase64: flippedCipher.toString('base64'),
          }),
        });
        assert.equal(flippedCipherRes.status, 400);
        assert.deepEqual(snapshotCountsBeforeTamper(), baselineB);

        // (d) Truncated file (< 54 bytes)
        const truncatedRes = await appB.request('http://localhost/api/backup/import', {
          method: 'POST',
          headers: { Cookie: cookieB, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            password: backupPassword,
            fileBase64: backupBytes.subarray(0, 30).toString('base64'),
          }),
        });
        assert.equal(truncatedRes.status, 400);
        assert.deepEqual(snapshotCountsBeforeTamper(), baselineB);

        // (e) Prototype pollution ("__proto__") and unknown extra key inside valid BIFROST1 envelope
        const rawExportJson = await unpackBifrostEnvelopeRaw(backupBytes, backupPassword);
        const pollutedEnvelope = await packBifrostEnvelope(
          rawExportJson.replace(
            '"format":"BIFROST1"',
            '"format":"BIFROST1","__proto__":{"polluted":true}',
          ),
          backupPassword,
        );
        const pollutedRes = await appB.request('http://localhost/api/backup/import', {
          method: 'POST',
          headers: { Cookie: cookieB, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            password: backupPassword,
            fileBase64: pollutedEnvelope.toString('base64'),
          }),
        });
        assert.equal(pollutedRes.status, 400);
        assert.equal(({} as Record<string, unknown>).polluted, undefined);
        assert.deepEqual(snapshotCountsBeforeTamper(), baselineB);

        const extraKeyObj = JSON.parse(rawExportJson) as Record<string, unknown>;
        extraKeyObj.unexpectedInjectedField = 'evil';
        const extraKeyEnvelope = await packBifrostEnvelope(extraKeyObj, backupPassword);
        const extraKeyRes = await appB.request('http://localhost/api/backup/import', {
          method: 'POST',
          headers: { Cookie: cookieB, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            password: backupPassword,
            fileBase64: extraKeyEnvelope.toString('base64'),
          }),
        });
        assert.equal(extraKeyRes.status, 400);
        assert.deepEqual(snapshotCountsBeforeTamper(), baselineB);

        // --- Valid Multipart Import onto Instance B (with masterKeyB!) ---
        const form = new FormData();
        form.append(
          'file',
          new Blob([backupBytes], { type: 'application/octet-stream' }),
          'bifrost-backup.bifrost.enc',
        );
        form.append('password', backupPassword);

        const importRes = await appB.request('http://localhost/api/backup/import', {
          method: 'POST',
          headers: { Cookie: cookieB },
          body: form,
        });
        assert.equal(importRes.status, 200);
        const importJson = (await importRes.json()) as {
          ok: boolean;
          restored: {
            users: number;
            providers: number;
            providerKeys: number;
            nodes: number;
            models: number;
          };
        };
        assert.equal(importJson.ok, true);
        assert.equal(importJson.restored.users, 2);
        assert.equal(importJson.restored.providers, 1);
        assert.equal(importJson.restored.providerKeys, 1);
        assert.equal(importJson.restored.nodes, 1);
        assert.equal(importJson.restored.models, 1);

        // Verify adminB's active browser cookie STILL works seamlessly after user ID swap!
        const meAfterImport = await appB.request('http://localhost/api/auth/me', {
          headers: { Cookie: cookieB },
        });
        assert.equal(meAfterImport.status, 200);

        // Verify BOTH provider_keys.encrypted_secret AND nodes.encrypted_token were re-encrypted with masterKeyB!
        const restoredKeyRow = dbB
          .prepare(`SELECT encrypted_secret FROM provider_keys LIMIT 1`)
          .get() as { encrypted_secret: Uint8Array };
        assert.equal(
          decryptSecret(restoredKeyRow.encrypted_secret, masterKeyB),
          'sk-or-v1-migrated-secret-9999',
        );
        assert.throws(
          () => decryptSecret(restoredKeyRow.encrypted_secret, masterKeyA),
          /Unsupported state or unable to authenticate data/,
        );

        const restoredNodeRow = dbB
          .prepare(`SELECT encrypted_token, tls_fingerprint FROM nodes WHERE id = ?`)
          .get(createdNode.id) as {
          encrypted_token: Uint8Array;
          tls_fingerprint: string | null;
        };
        assert.equal(
          decryptSecret(restoredNodeRow.encrypted_token, masterKeyB),
          originalNodeToken,
        );
        assert.equal(restoredNodeRow.tls_fingerprint, pinnedFp);
        assert.throws(
          () => decryptSecret(restoredNodeRow.encrypted_token, masterKeyA),
          /Unsupported state or unable to authenticate data/,
        );

        // Verify portable guest sk-bf-... key works immediately on Instance B against upstream!
        const liveChatOnB = await appB.request('http://localhost/v1/chat/completions', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${portableSkBfKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'openrouter/gemma-3-27b:free',
            messages: [{ role: 'user', content: 'Hello Instance B!' }],
          }),
        });
        assert.equal(liveChatOnB.status, 200);
        const liveChatJson = (await liveChatOnB.json()) as {
          choices: Array<{ message: { content: string } }>;
        };
        assert.equal(liveChatJson.choices[0]?.message.content, 'Restored on Instance B!');

        // --- Red-Team Item #3b: Node without raw_token in backup restores offline & marks assigned key no_node ---
        const parsedBackup = JSON.parse(rawExportJson) as {
          nodes: Array<Record<string, unknown>>;
          providerKeys: Array<Record<string, unknown>>;
        };
        parsedBackup.nodes[0]!.raw_token = null;
        parsedBackup.nodes[0]!.status = 'online';
        parsedBackup.providerKeys[0]!.node_id = createdNode.id;
        parsedBackup.providerKeys[0]!.status = 'active';

        const missingNodeTokenEnvelope = await packBifrostEnvelope(
          parsedBackup,
          backupPassword,
        );
        const missingTokenImportRes = await appB.request('http://localhost/api/backup/import', {
          method: 'POST',
          headers: { Cookie: cookieB, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            password: backupPassword,
            fileBase64: missingNodeTokenEnvelope.toString('base64'),
          }),
        });
        assert.equal(missingTokenImportRes.status, 200);

        const safeOfflineNode = dbB
          .prepare(`SELECT status, encrypted_token FROM nodes WHERE id = ?`)
          .get(createdNode.id) as { status: string; encrypted_token: Uint8Array | null };
        assert.equal(safeOfflineNode.status, 'offline');
        assert.equal(safeOfflineNode.encrypted_token, null);

        const safeNoNodeKey = dbB
          .prepare(`SELECT status FROM provider_keys LIMIT 1`)
          .get() as { status: string };
        assert.equal(safeNoNodeKey.status, 'no_node');
      } finally {
        dbA.close();
        dbB.close();
      }
    });
  });
});

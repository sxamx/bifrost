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
import {
  MasterKeyError,
  encryptSecret,
  hashPassword,
  resolveMasterKey,
} from '../core/src/crypto.js';
import { openDatabase } from '../core/src/db.js';
import { DrainingRegistry } from '../core/src/router.js';
import {
  checkSystemUpdate,
  getCurrentUpdatePhase,
  resetUpdatePhaseForTests,
  triggerSystemUpdate,
  waitForBackgroundUpdateForTests,
} from '../core/src/update-checker.js';

const tempDirs: string[] = [];

function makeTempDir(prefix = 'bifrost-ola5-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function extractCookiePair(setCookieHeader: string | null): string {
  assert.ok(setCookieHeader, 'Expected Set-Cookie header to be present');
  return setCookieHeader.split(';')[0]!;
}

afterEach(() => {
  resetUpdatePhaseForTests();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('Ola 5 Regression Suite — Backups V2, Master Key Secrets, Draining, Assets 404 & Autoupdater', () => {
  it('preserves provider_keys.status="disabled", models.disabled_by_admin, internal_api_keys.expires_at, invitations.used_by_*, providers.source_id/manifest_hash, usage_logs.internal_api_key_id, and avoids log ID overwrites', async () => {
    const dirA = makeTempDir('bifrost-v2-a-');
    const dirB = makeTempDir('bifrost-v2-b-');
    const dbA = openDatabase(path.join(dirA, 'bifrost.db'));
    const dbB = openDatabase(path.join(dirB, 'bifrost.db'));
    const masterKeyA = randomBytes(32);
    const masterKeyB = randomBytes(32);
    const nowMs = Date.UTC(2026, 10, 26, 12, 0, 0);
    const nowSec = Math.floor(nowMs / 1000);

    const mockFetch: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith('/models')) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: 'llama-3.3-70b:free',
                name: 'Llama 3.3 70B Free',
                pricing: { prompt: '0', completion: '0' },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('Not found', { status: 404 });
    };

    try {
      const appA = createApp({ db: dbA, masterKey: masterKeyA, fetchImpl: mockFetch, now: () => nowMs });
      const setupA = await appA.request('http://localhost/api/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'adminPassword123!' }),
      });
      assert.equal(setupA.status, 201);
      const cookieA = extractCookiePair(setupA.headers.get('set-cookie'));
      const adminAId = ((await setupA.json()) as { user: { id: string } }).user.id;

      // Install provider & set explicit source_id and manifest_hash
      const instRes = await appA.request('http://localhost/api/marketplace/install', {
        method: 'POST',
        headers: { Cookie: cookieA, 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerId: 'openrouter' }),
      });
      assert.equal(instRes.status, 201);
      dbA
        .prepare(`UPDATE providers SET source_id = ?, manifest_hash = ? WHERE id = 'openrouter'`)
        .run('official', 'deadbeef12345678');

      // Add key with status = 'disabled'
      const addKeyRes = await appA.request('http://localhost/api/providers/openrouter/keys', {
        method: 'POST',
        headers: { Cookie: cookieA, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label: 'Disabled Vault Key',
          secret: 'sk-or-disabled-secret-0001',
          status: 'disabled',
        }),
      });
      assert.equal(addKeyRes.status, 201);
      const keyAId = ((await addKeyRes.json()) as { key: { id: string; status: string } }).key.id;

      // Add a second active key temporarily so detect-models works, or insert model directly with disabled_by_admin = 1
      const syncRes = await appA.request('http://localhost/api/providers/openrouter/detect-models', {
        method: 'POST',
        headers: { Cookie: cookieA },
      });
      assert.equal(syncRes.status, 200);
      dbA
        .prepare(`UPDATE models SET disabled_by_admin = 1 WHERE full_id = 'openrouter/llama-3.3-70b:free'`)
        .run();

      // Create invitation and accept it so used_by_user_id and used_by_username are populated
      const invRes = await appA.request('http://localhost/api/invitations', {
        method: 'POST',
        headers: { Cookie: cookieA, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dailyTokenLimit: 1000,
          allowedModels: ['*'],
        }),
      });
      assert.equal(invRes.status, 201);
      const invJson = (await invRes.json()) as { token: string; invitation: { id: string } };

      const acceptRes = await appA.request(
        `http://localhost/api/invitations/${encodeURIComponent(invJson.token)}/accept`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'guest_invited', password: 'guestPassword123!' }),
        },
      );
      assert.equal(acceptRes.status, 201);
      const guestCookieA = extractCookiePair(acceptRes.headers.get('set-cookie'));
      const guestAId = ((await acceptRes.json()) as { user: { id: string } }).user.id;

      // Create internal API key with expires_at
      const expiresAt = nowSec + 86400 * 7;
      const internalKeyRes = await appA.request('http://localhost/api/keys', {
        method: 'POST',
        headers: { Cookie: guestCookieA, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Expiring CLI Key', expiresAt }),
      });
      assert.equal(internalKeyRes.status, 201);
      const internalKeyId = ((await internalKeyRes.json()) as { key: { id: string } }).key.id;
      dbA.prepare(`UPDATE internal_api_keys SET expires_at = ? WHERE id = ?`).run(expiresAt, internalKeyId);

      // Insert usage_log referencing internal_api_key_id at id = 1
      dbA
        .prepare(
          `INSERT INTO usage_logs (
             id, user_id, provider_id, provider_key_id, internal_api_key_id, model_full_id,
             prompt_tokens, completion_tokens, reasoning_tokens, cached_tokens,
             ttft_ms, duration_ms, tokens_per_sec, status, error_type, created_at
           ) VALUES (1, ?, 'openrouter', ?, ?, 'openrouter/llama-3.3-70b:free', 42, 18, 0, 0, 50, 120, 150, 'ok', NULL, ?)`,
        )
        .run(guestAId, keyAId, internalKeyId, nowSec);

      // Export from A
      const backupPw = 'StrongVaultPass#2026';
      const exportRes = await appA.request('http://localhost/api/backup/export', {
        method: 'POST',
        headers: { Cookie: cookieA, 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: backupPw, includeTelemetry: true }),
      });
      assert.equal(exportRes.status, 200);
      const backupBytes = Buffer.from(await exportRes.arrayBuffer());

      // Setup Instance B with its OWN local usage_log id = 1 and system_log id = 1
      const appB = createApp({ db: dbB, masterKey: masterKeyB, fetchImpl: mockFetch, now: () => nowMs });
      const setupB = await appB.request('http://localhost/api/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'destAdminPassword123!' }),
      });
      assert.equal(setupB.status, 201);
      const cookieB = extractCookiePair(setupB.headers.get('set-cookie'));
      const adminBId = ((await setupB.json()) as { user: { id: string } }).user.id;

      // Create a playground chat for adminB to verify it is NOT accidentally cascade-deleted
      dbB
        .prepare(
          `INSERT INTO playground_chats (id, user_id, encrypted_title, model_full_id, created_at, updated_at)
           VALUES ('chat-keep-1', ?, ?, 'openrouter/llama-3.3-70b:free', ?, ?)`,
        )
        .run(adminBId, encryptSecret('My Admin Chat', masterKeyB), nowSec, nowSec);

      // Seed local usage_log with id = 1 on B (colliding AUTOINCREMENT ID!)
      dbB
        .prepare(
          `INSERT INTO usage_logs (
             id, user_id, provider_id, provider_key_id, internal_api_key_id, model_full_id,
             prompt_tokens, completion_tokens, reasoning_tokens, cached_tokens,
             ttft_ms, duration_ms, tokens_per_sec, status, error_type, created_at
           ) VALUES (1, ?, 'local-b', NULL, NULL, 'local-b/preexisting', 99, 11, 0, 0, 20, 80, 120, 'ok', NULL, ?)`,
        )
        .run(adminBId, nowSec - 60);

      // Import onto Instance B
      const importRes = await appB.request('http://localhost/api/backup/import', {
        method: 'POST',
        headers: { Cookie: cookieB, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          password: backupPw,
          fileBase64: backupBytes.toString('base64'),
        }),
      });
      assert.equal(importRes.status, 200);

      // Verify all V2 fields preserved!
      const restoredKey = dbB
        .prepare(`SELECT status FROM provider_keys WHERE id = ?`)
        .get(keyAId) as { status: string };
      assert.equal(restoredKey.status, 'disabled');

      const restoredModel = dbB
        .prepare(`SELECT disabled_by_admin FROM models WHERE full_id = 'openrouter/llama-3.3-70b:free'`)
        .get() as { disabled_by_admin: number };
      assert.equal(restoredModel.disabled_by_admin, 1);

      const restoredInternalKey = dbB
        .prepare(`SELECT expires_at FROM internal_api_keys WHERE id = ?`)
        .get(internalKeyId) as { expires_at: number | null };
      assert.equal(restoredInternalKey.expires_at, expiresAt);

      const restoredInv = dbB
        .prepare(`SELECT used_by_user_id, used_by_username FROM invitations WHERE id = ?`)
        .get(invJson.invitation.id) as {
        used_by_user_id: string | null;
        used_by_username: string | null;
      };
      assert.equal(restoredInv.used_by_user_id, guestAId);
      assert.equal(restoredInv.used_by_username, 'guest_invited');

      const restoredProv = dbB
        .prepare(`SELECT source_id, manifest_hash FROM providers WHERE id = 'openrouter'`)
        .get() as { source_id: string | null; manifest_hash: string | null };
      assert.equal(restoredProv.source_id, 'official');
      assert.equal(restoredProv.manifest_hash, 'deadbeef12345678');

      // Verify BOTH local usage_log (id=1) AND imported usage_log (re-allocated ID, with internal_api_key_id) coexist!
      const usageLogsB = dbB
        .prepare(`SELECT id, provider_id, internal_api_key_id, model_full_id FROM usage_logs ORDER BY id ASC`)
        .all() as Array<{
        id: number;
        provider_id: string;
        internal_api_key_id: string | null;
        model_full_id: string;
      }>;
      assert.equal(usageLogsB.length, 2);
      assert.equal(usageLogsB[0]!.id, 1);
      assert.equal(usageLogsB[0]!.model_full_id, 'local-b/preexisting');
      assert.equal(usageLogsB[1]!.model_full_id, 'openrouter/llama-3.3-70b:free');
      assert.equal(usageLogsB[1]!.internal_api_key_id, internalKeyId);

      // Verify acting admin's playground_chat was preserved under the new admin ID (not cascade-deleted!)
      const preservedChat = dbB
        .prepare(`SELECT id, user_id FROM playground_chats WHERE id = 'chat-keep-1'`)
        .get() as { id: string; user_id: string } | undefined;
      assert.ok(preservedChat, 'Acting admin playground chat must not be cascade-deleted');
      assert.equal(preservedChat.user_id, adminAId);
    } finally {
      dbA.close();
      dbB.close();
    }
  });

  it('marks node-assigned provider keys as status="no_node" (never "active") when exported with includeNodes: false', async () => {
    const dir = makeTempDir('bifrost-no-nodes-');
    const db = openDatabase(path.join(dir, 'bifrost.db'));
    const masterKey = randomBytes(32);

    try {
      const app = createApp({ db, masterKey });
      const setupRes = await app.request('http://localhost/api/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'adminPassword123!' }),
      });
      const cookie = extractCookiePair(setupRes.headers.get('set-cookie'));

      await app.request('http://localhost/api/marketplace/install', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerId: 'openrouter' }),
      });

      const nodeRes = await app.request('http://localhost/api/nodes', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Exit-Safe',
          mode: 'tailscale',
          endpoint: '100.64.10.20:9443',
        }),
      });
      assert.equal(nodeRes.status, 201);
      const nodeId = ((await nodeRes.json()) as { node: { id: string } }).node.id;

      // Add key assigned to exit node (active) AND key without node (active)
      const keyWithNodeRes = await app.request('http://localhost/api/providers/openrouter/keys', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label: 'Node-Bound Key',
          secret: 'sk-or-node-bound-1234',
          nodeId,
          status: 'active',
        }),
      });
      assert.equal(keyWithNodeRes.status, 201);
      const keyWithNodeId = ((await keyWithNodeRes.json()) as { key: { id: string } }).key.id;

      const directKeyRes = await app.request('http://localhost/api/providers/openrouter/keys', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label: 'Direct Key',
          secret: 'sk-or-direct-5678',
          status: 'active',
        }),
      });
      assert.equal(directKeyRes.status, 201);
      const directKeyId = ((await directKeyRes.json()) as { key: { id: string } }).key.id;

      const pw = 'ExportNoNodesPass#1';
      const exportRes = await app.request('http://localhost/api/backup/export', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          password: pw,
          includeNodes: false,
        }),
      });
      assert.equal(exportRes.status, 200);
      const envelope = Buffer.from(await exportRes.arrayBuffer());
      const rawJson = await unpackBifrostEnvelopeRaw(envelope, pw);
      const parsed = JSON.parse(rawJson) as {
        nodes: unknown[];
        providerKeys: Array<{ id: string; node_id: string | null; status: string }>;
      };

      assert.equal(parsed.nodes.length, 0);
      const exportedBoundKey = parsed.providerKeys.find((k) => k.id === keyWithNodeId);
      const exportedDirectKey = parsed.providerKeys.find((k) => k.id === directKeyId);
      assert.ok(exportedBoundKey);
      assert.equal(exportedBoundKey.node_id, null);
      assert.equal(exportedBoundKey.status, 'no_node');
      assert.ok(exportedDirectKey);
      assert.equal(exportedDirectKey.status, 'active');
    } finally {
      db.close();
    }
  });

  it('rejects oversized uncompressed payload, invalid magic, oversized fileBase64, invalid/IMDS node endpoints, invalid tls_fingerprint, username collision session hijack, and 0-admin backups', async () => {
    const dir = makeTempDir('bifrost-limits-');
    const db = openDatabase(path.join(dir, 'bifrost.db'));
    const masterKey = randomBytes(32);
    const maxUncompressed = 64 * 1024; // 64 KiB cap for fast tests

    try {
      const app = createApp({
        db,
        masterKey,
        maxBackupUncompressedBytes: maxUncompressed,
      });

      const setupRes = await app.request('http://localhost/api/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'adminPassword123!' }),
      });
      const adminCookie = extractCookiePair(setupRes.headers.get('set-cookie'));
      const adminId = ((await setupRes.json()) as { user: { id: string } }).user.id;

      // Create a guest user with active session
      const invRes = await app.request('http://localhost/api/invitations', {
        method: 'POST',
        headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ dailyTokenLimit: 1000, allowedModels: ['*'] }),
      });
      const invToken = ((await invRes.json()) as { token: string }).token;
      const acceptRes = await app.request(
        `http://localhost/api/invitations/${encodeURIComponent(invToken)}/accept`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'alice', password: 'alicePassword123!' }),
        },
      );
      assert.equal(acceptRes.status, 201);
      const aliceCookie = extractCookiePair(acceptRes.headers.get('set-cookie'));

      const pw = 'LimitTestPass#2026';
      const validHash = await hashPassword('RestoredPass123!');

      // 1. Oversized uncompressed payload (gzip bomb exceeding maxBackupUncompressedBytes)
      const bombPayload = {
        format: 'BIFROST1',
        schemaVersion: 1,
        exportedAt: 1700000000,
        includeTelemetry: false,
        users: [],
        invitations: [],
        userModelAccess: [],
        internalApiKeys: [],
        nodes: [],
        providers: [],
        providerKeys: [],
        models: [],
        usageLogs: [],
        systemLogs: [],
        externalCache: [
          {
            cache_key: 'bomb',
            payload_json: 'A'.repeat(maxUncompressed + 16_384),
            etag: null,
            fetched_at: 1700000000,
          },
        ],
      };
      const bombEnv = await packBifrostEnvelope(bombPayload, pw);
      const bombRes = await app.request('http://localhost/api/backup/import', {
        method: 'POST',
        headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pw, fileBase64: bombEnv.toString('base64') }),
      });
      assert.equal(bombRes.status, 400);

      // 2. Invalid magic header
      const badMagicBuf = Buffer.concat([Buffer.from('NOTMAGIC', 'ascii'), randomBytes(64)]);
      const badMagicRes = await app.request('http://localhost/api/backup/import', {
        method: 'POST',
        headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pw, fileBase64: badMagicBuf.toString('base64') }),
      });
      assert.equal(badMagicRes.status, 400);

      // 3. Giant fileBase64 rejected BEFORE Buffer.from
      const hugeB64 = 'A'.repeat(Math.ceil((maxUncompressed + 4096) / 3) * 4);
      const hugeB64Res = await app.request('http://localhost/api/backup/import', {
        method: 'POST',
        headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pw, fileBase64: hugeB64 }),
      });
      assert.equal(hugeB64Res.status, 400);

      const basePayload = () => ({
        format: 'BIFROST1',
        schemaVersion: 1,
        exportedAt: 1700000000,
        includeTelemetry: false,
        users: [],
        invitations: [],
        userModelAccess: [],
        internalApiKeys: [],
        nodes: [] as Array<Record<string, unknown>>,
        providers: [],
        providerKeys: [],
        models: [],
        usageLogs: [],
        systemLogs: [],
        externalCache: [],
      });

      // 4a. IMDS node endpoint rejected (169.254.169.254)
      const imdsPayload = basePayload();
      imdsPayload.nodes.push({
        id: 'n-imds',
        name: 'IMDS',
        mode: 'public_ip',
        endpoint: '169.254.169.254:80',
        token_hash: 'a'.repeat(64),
        raw_token: null,
        tls_fingerprint: null,
        prev_token_hash: null,
        prev_token_expires_at: null,
        last_seen_at: null,
        last_rotated_at: 1700000000,
        status: 'offline',
        created_at: 1700000000,
      });
      const imdsRes = await app.request('http://localhost/api/backup/import', {
        method: 'POST',
        headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          password: pw,
          fileBase64: (await packBifrostEnvelope(imdsPayload, pw)).toString('base64'),
        }),
      });
      assert.equal(imdsRes.status, 400);

      // 4b. Invalid tls_fingerprint rejected
      const badFpPayload = basePayload();
      badFpPayload.nodes.push({
        id: 'n-badfp',
        name: 'BadFP',
        mode: 'public_ip',
        endpoint: '203.0.113.10:9443',
        token_hash: 'a'.repeat(64),
        raw_token: null,
        tls_fingerprint: 'not-a-valid-sha256',
        prev_token_hash: null,
        prev_token_expires_at: null,
        last_seen_at: null,
        last_rotated_at: 1700000000,
        status: 'offline',
        created_at: 1700000000,
      });
      const badFpRes = await app.request('http://localhost/api/backup/import', {
        method: 'POST',
        headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          password: pw,
          fileBase64: (await packBifrostEnvelope(badFpPayload, pw)).toString('base64'),
        }),
      });
      assert.equal(badFpRes.status, 400);

      // 5. Backup attempting to leave 0 admins (demoting sole admin to guest) MUST be rejected and rolled back!
      const zeroAdminPayload = basePayload();
      (zeroAdminPayload.users as Array<Record<string, unknown>>).push({
        id: adminId,
        username: 'admin',
        password_hash: validHash,
        role: 'guest',
        daily_token_limit: 100,
        quota_reset_mode: 'utc_midnight',
        enforce_strict_quota: 1,
        created_at: 1700000000,
      });
      const zeroAdminRes = await app.request('http://localhost/api/backup/import', {
        method: 'POST',
        headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          password: pw,
          fileBase64: (await packBifrostEnvelope(zeroAdminPayload, pw)).toString('base64'),
        }),
      });
      assert.equal(zeroAdminRes.status, 400);
      const statusAfterRejected = await app.request('http://localhost/api/status');
      assert.deepEqual(await statusAfterRejected.json(), { initialized: true });

      // 6. Username collision on guest 'alice' with imported admin 'alice' MUST revoke alice's old guest session!
      const collisionPayload = basePayload();
      (collisionPayload.users as Array<Record<string, unknown>>).push({
        id: 'imported-admin-alice',
        username: 'alice',
        password_hash: validHash,
        role: 'admin',
        daily_token_limit: null,
        quota_reset_mode: 'utc_midnight',
        enforce_strict_quota: 1,
        created_at: 1700000000,
      });
      const collisionRes = await app.request('http://localhost/api/backup/import', {
        method: 'POST',
        headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          password: pw,
          fileBase64: (await packBifrostEnvelope(collisionPayload, pw)).toString('base64'),
        }),
      });
      assert.equal(collisionRes.status, 200);

      // Displaced guest alice's cookie MUST now return 401 (NEVER elevated to imported admin alice!)
      const hijackedMe = await app.request('http://localhost/api/auth/me', {
        headers: { Cookie: aliceCookie },
      });
      assert.equal(hijackedMe.status, 401);

      // Acting admin's own session stayed valid because acting admin was unchanged
      const actingAdminMe = await app.request('http://localhost/api/auth/me', {
        headers: { Cookie: adminCookie },
      });
      assert.equal(actingAdminMe.status, 200);
    } finally {
      db.close();
    }
  });

  it('BF-06 & BF-07: supports BIFROST_MASTER_KEY_FILE (Docker Secrets), WAL/SHM guard, and optional adminPassword verification on /api/backup/export', async () => {
    // BF-06: BIFROST_MASTER_KEY_FILE (hex + base64 + failure cases)
    const dir = makeTempDir('bifrost-bf06-');
    const secretKey = randomBytes(32);
    const hexFile = path.join(dir, 'secret_hex.key');
    const b64File = path.join(dir, 'secret_b64.key');
    const badFile = path.join(dir, 'secret_bad.key');
    fs.writeFileSync(hexFile, `${secretKey.toString('hex')}\n`, 'utf8');
    fs.writeFileSync(b64File, `  ${secretKey.toString('base64')}  \r\n`, 'utf8');
    fs.writeFileSync(badFile, 'not-a-valid-key', 'utf8');

    const resHex = resolveMasterKey({
      dataDir: path.join(dir, 'data-hex'),
      envMasterKeyFile: hexFile,
    });
    assert.deepEqual(resHex.key, secretKey);
    assert.equal(resHex.source, 'file');

    const resB64 = resolveMasterKey({
      dataDir: path.join(dir, 'data-b64'),
      envMasterKeyFile: b64File,
    });
    assert.deepEqual(resB64.key, secretKey);

    assert.throws(
      () => resolveMasterKey({ dataDir: path.join(dir, 'data-bad'), envMasterKeyFile: badFile }),
      MasterKeyError,
    );
    assert.throws(
      () =>
        resolveMasterKey({
          dataDir: path.join(dir, 'data-missing'),
          envMasterKeyFile: path.join(dir, 'does-not-exist.key'),
        }),
      MasterKeyError,
    );

    // WAL artifact without master.key must refuse to generate a new key
    const walDir = path.join(dir, 'data-wal');
    fs.mkdirSync(walDir, { recursive: true });
    fs.writeFileSync(path.join(walDir, 'bifrost.db-wal'), Buffer.from('wal-marker'));
    assert.throws(
      () => resolveMasterKey({ dataDir: walDir, envMasterKey: undefined, envMasterKeyFile: undefined }),
      MasterKeyError,
    );

    // BF-07: optional adminPassword in POST /api/backup/export
    const db = openDatabase(':memory:');
    try {
      const app = createApp({ db, masterKey: secretKey });
      const setupRes = await app.request('http://localhost/api/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'RealAdminPassword#99' }),
      });
      const cookie = extractCookiePair(setupRes.headers.get('set-cookie'));

      // Backward-compatible: omitted adminPassword -> 200
      const omitRes = await app.request('http://localhost/api/backup/export', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'BackupPassword#1' }),
      });
      assert.equal(omitRes.status, 200);

      // Wrong adminPassword -> 401
      const wrongRes = await app.request('http://localhost/api/backup/export', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          password: 'BackupPassword#1',
          adminPassword: 'WrongAdminPassword',
        }),
      });
      assert.equal(wrongRes.status, 401);

      // Empty adminPassword -> 401
      const emptyRes = await app.request('http://localhost/api/backup/export', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          password: 'BackupPassword#1',
          adminPassword: '',
        }),
      });
      assert.equal(emptyRes.status, 401);

      // Correct adminPassword -> 200
      const okRes = await app.request('http://localhost/api/backup/export', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          password: 'BackupPassword#1',
          adminPassword: 'RealAdminPassword#99',
        }),
      });
      assert.equal(okRes.status, 200);
    } finally {
      db.close();
    }
  });

  it('returns real 404 for missing /assets/* and /icons/* (not index.html), 409 when reinstalling a draining provider, and isolates DrainingRegistry finalizer errors', async () => {
    // 1. Static asset 404 vs SPA fallback
    const distDir = makeTempDir('bifrost-dist-');
    fs.mkdirSync(path.join(distDir, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(distDir, 'index.html'), '<!doctype html><html><body>SPA</body></html>');
    fs.writeFileSync(path.join(distDir, 'assets', 'real-chunk.js'), 'console.log("ok");');

    const db = openDatabase(':memory:');
    const masterKey = randomBytes(32);
    try {
      let releaseUpstream!: () => void;
      let markUpstreamStarted!: () => void;
      const upstreamEntered = new Promise<void>((resolve) => {
        markUpstreamStarted = resolve;
      });
      const upstreamGate = new Promise<void>((resolve) => {
        releaseUpstream = resolve;
      });

      const mockFetch: typeof fetch = async (input) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.endsWith('/models')) {
          return new Response(
            JSON.stringify({
              data: [
                { id: 'test-model:free', name: 'Test Free', pricing: { prompt: '0', completion: '0' } },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (url.endsWith('/chat/completions')) {
          markUpstreamStarted();
          await upstreamGate;
          return new Response(
            JSON.stringify({
              id: 'cmpl-1',
              choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response('Not found', { status: 404 });
      };

      const app = createApp({ db, masterKey, panelDistDir: distDir, fetchImpl: mockFetch });

      // Existing asset -> 200 JS
      const existingAsset = await app.request('http://localhost/assets/real-chunk.js');
      assert.equal(existingAsset.status, 200);
      assert.match(existingAsset.headers.get('content-type') ?? '', /javascript/);

      // Missing /assets/* -> 404 (NOT index.html!)
      const missingAsset = await app.request('http://localhost/assets/nonexistent-chunk.js');
      assert.equal(missingAsset.status, 404);
      const missingAssetText = await missingAsset.text();
      assert.ok(!missingAssetText.includes('<!doctype html>'));

      // Missing /icons/* -> 404
      const missingIcon = await app.request('http://localhost/icons/missing-icon.png');
      assert.equal(missingIcon.status, 404);

      // SPA route -> 200 index.html
      const spaRoute = await app.request('http://localhost/models');
      assert.equal(spaRoute.status, 200);
      assert.match(await spaRoute.text(), /SPA/);

      // 2. Reinstalling a provider currently draining -> 409 Conflict (NOT 500 UNIQUE constraint failed!)
      const setupRes = await app.request('http://localhost/api/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'adminPassword123!' }),
      });
      const cookie = extractCookiePair(setupRes.headers.get('set-cookie'));

      await app.request('http://localhost/api/marketplace/install', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerId: 'openrouter' }),
      });
      await app.request('http://localhost/api/providers/openrouter/keys', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: 'Active Key', secret: 'sk-or-drain-test-1234', status: 'active' }),
      });
      await app.request('http://localhost/api/providers/openrouter/detect-models', {
        method: 'POST',
        headers: { Cookie: cookie },
      });
      const apiKeyRes = await app.request('http://localhost/api/keys', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Drain Test Key' }),
      });
      const rawApiKey = ((await apiKeyRes.json()) as { rawKey: string }).rawKey;

      // Start an in-flight chat request so provider has active lease
      const inFlightReq = app.request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${rawApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'openrouter/test-model:free',
          messages: [{ role: 'user', content: 'hold open' }],
        }),
      });
      await upstreamEntered;

      // Initiate provider deletion -> enters draining state
      const delRes = await app.request('http://localhost/api/providers/openrouter', {
        method: 'DELETE',
        headers: { Cookie: cookie },
      });
      assert.equal(delRes.status, 200);
      const delJson = (await delRes.json()) as { draining?: boolean };
      assert.equal(delJson.draining, true);

      // Attempt to reinstall openrouter while draining -> MUST return 409 (not 500!)
      const reinstallRes = await app.request('http://localhost/api/marketplace/install', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerId: 'openrouter' }),
      });
      assert.equal(reinstallRes.status, 409);
      const reinstallJson = (await reinstallRes.json()) as { error: string };
      assert.match(reinstallJson.error, /being removed|retry/i);

      releaseUpstream();
      const finishedChat = await inFlightReq;
      assert.equal(finishedChat.status, 200);
    } finally {
      db.close();
    }

    // 3. DrainingRegistry isolates throwing key finalizer so providerInFlight still decrements & provider finalizer runs
    const reg = new DrainingRegistry();
    const release = reg.acquireLease('prov-1', 'key-1');
    let providerFinalized = false;
    reg.drainAndRemoveKey('key-1', () => {
      throw new Error('simulated key finalizer failure');
    });
    reg.drainAndRemoveProvider('prov-1', ['key-1'], () => {
      providerFinalized = true;
    });
    assert.doesNotThrow(() => release());
    assert.equal(reg.getKeyInFlightCount('key-1'), 0);
    assert.equal(reg.getProviderInFlightCount('prov-1'), 0);
    assert.equal(providerFinalized, true);
  });

  it('hardens update-checker: https-only html_url, redacts Watchtower URL on error, differentiates TimeoutError from ECONNRESET, and runs npm ci in native mode when lockfile exists', async () => {
    const db = openDatabase(':memory:');
    try {
      // 1. Non-https html_url from GitHub API is rejected (latestCommitUrl === null)
      const unsafeStatus = await checkSystemUpdate({
        db,
        currentCommit: '1111111',
        forceRefresh: true,
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              sha: '2222222222222222222222222222222222222222',
              html_url: 'javascript:alert(1)',
              commit: { message: 'test', committer: { date: '2026-11-26T00:00:00Z' } },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
      });
      assert.equal(unsafeStatus.latestCommitUrl, null);

      // 2. Watchtower error redacts internal endpoint URL & credentials
      resetUpdatePhaseForTests();
      await triggerSystemUpdate({
        runtimeMode: 'docker',
        watchtowerUrl: 'http://user:secretpass@watchtower.secret.local:8080',
        fetchImpl: async () => {
          throw new Error('ECONNREFUSED http://user:secretpass@watchtower.secret.local:8080/v1/update');
        },
      });
      await waitForBackgroundUpdateForTests();
      const errPhase = getCurrentUpdatePhase();
      assert.equal(errPhase.phase, 'error');
      assert.ok(!errPhase.message?.includes('secretpass'), 'Must never leak credentials');
      assert.ok(!errPhase.message?.includes('watchtower.secret.local'), 'Must never leak internal URL');

      // 3. Real TimeoutError transitions phase to 'error' instead of hanging in 'restarting'
      resetUpdatePhaseForTests();
      await triggerSystemUpdate({
        runtimeMode: 'docker',
        watchtowerUrl: 'http://watchtower:8080',
        fetchImpl: async () => {
          const timeoutErr = new Error('The operation was aborted due to timeout');
          timeoutErr.name = 'TimeoutError';
          throw timeoutErr;
        },
      });
      await waitForBackgroundUpdateForTests();
      const timeoutPhase = getCurrentUpdatePhase();
      assert.equal(timeoutPhase.phase, 'error');
      assert.match(timeoutPhase.message ?? '', /timed out/i);

      // 4. Native mode runs npm ci before npm run build when package-lock.json exists
      resetUpdatePhaseForTests();
      const tmpRepo = makeTempDir('bifrost-native-lock-');
      fs.mkdirSync(path.join(tmpRepo, '.git'));
      fs.writeFileSync(path.join(tmpRepo, 'package-lock.json'), '{}');
      const commands: string[][] = [];
      await triggerSystemUpdate({
        runtimeMode: 'native',
        watchtowerUrl: '',
        repoDir: tmpRepo,
        runCommand: async (cmd, args) => {
          commands.push([cmd, ...args]);
        },
        onRestart: () => {},
      });
      await waitForBackgroundUpdateForTests();
      assert.deepEqual(commands, [
        ['git', 'pull', '--ff-only'],
        ['npm', 'ci'],
        ['npm', 'run', 'build'],
      ]);
    } finally {
      db.close();
    }
  });
});

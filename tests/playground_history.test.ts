import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { createApp } from '../core/src/app.js';
import { exportEncryptedBackup, unpackBifrostEnvelopeRaw } from '../core/src/backup.js';
import { decryptSecret } from '../core/src/crypto.js';
import { openDatabase } from '../core/src/db.js';
import { deriveUserPlaygroundKey } from '../core/src/playground-history.js';

const tempDirs: string[] = [];

function makeTempDir(prefix = 'bifrost-hu43-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function extractCookiePair(setCookieHeader: string | null): string {
  assert.ok(setCookieHeader, 'Expected Set-Cookie header to be present');
  return setCookieHeader.split(';')[0]!;
}

async function createAdminAndGuests(app: ReturnType<typeof createApp>) {
  // Setup admin
  const setupRes = await app.request('/api/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin-strong-password-123' }),
  });
  assert.equal(setupRes.status, 201);
  const adminCookie = extractCookiePair(setupRes.headers.get('set-cookie'));
  const adminBody = (await setupRes.json()) as { user: { id: string; username: string } };

  // Helper to invite and register a guest
  async function createGuest(username: string, password: string) {
    const invRes = await app.request('/api/invitations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: adminCookie,
      },
      body: JSON.stringify({
        dailyTokenLimit: 100000,
        quotaResetMode: 'utc_midnight',
        allowedModels: ['*'],
      }),
    });
    assert.equal(invRes.status, 201);
    const invBody = (await invRes.json()) as { token: string };

    const acceptRes = await app.request(`/api/invitations/${invBody.token}/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    assert.equal(acceptRes.status, 201);
    const guestCookie = extractCookiePair(acceptRes.headers.get('set-cookie'));
    const guestBody = (await acceptRes.json()) as { user: { id: string; username: string } };

    return {
      id: guestBody.user.id,
      username: guestBody.user.username,
      cookie: guestCookie,
    };
  }

  const guest1 = await createGuest('guest1', 'guest1-strong-password-123');
  const guest2 = await createGuest('guest2', 'guest2-strong-password-123');

  return {
    admin: { id: adminBody.user.id, username: adminBody.user.username, cookie: adminCookie },
    guest1,
    guest2,
  };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('HU-43: Encrypted Per-Account Playground Chat History', () => {
  it('supports full CRUD, auto-title from first user message, validation, and clear history', async () => {
    const dir = makeTempDir();
    const db = openDatabase(path.join(dir, 'bifrost.db'));
    const masterKey = randomBytes(32);
    let currentTimeMs = 1_750_000_000_000;
    const app = createApp({ db, masterKey, now: () => currentTimeMs });

    try {
      // Unauthenticated requests are rejected with 401
      const unauthRes = await app.request('/api/playground/chats');
      assert.equal(unauthRes.status, 401);

      const { admin } = await createAdminAndGuests(app);

      // Initially empty
      const emptyRes = await app.request('/api/playground/chats', {
        headers: { Cookie: admin.cookie },
      });
      assert.equal(emptyRes.status, 200);
      assert.deepEqual(await emptyRes.json(), { chats: [] });

      // Create chat with default title ("Nuevo chat")
      const create1Res = await app.request('/api/playground/chats', {
        method: 'POST',
        headers: { Cookie: admin.cookie },
      });
      assert.equal(create1Res.status, 201);
      const create1Body = (await create1Res.json()) as {
        chat: { id: string; title: string; modelFullId: string | null; messageCount: number };
      };
      assert.equal(create1Body.chat.title, 'Nuevo chat');
      assert.equal(create1Body.chat.modelFullId, null);
      assert.equal(create1Body.chat.messageCount, 0);

      // Append user + assistant messages (batch) — should auto-title from first user message
      currentTimeMs += 5000;
      const longPrompt =
        '   Explica paso a paso cómo funciona el cifrado autenticado AES-256-GCM en Node.js con claves derivadas por cuenta   ';
      const appendBatchRes = await app.request(
        `/api/playground/chats/${create1Body.chat.id}/messages`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
          body: JSON.stringify({
            messages: [
              {
                role: 'user',
                content: longPrompt,
              },
              {
                role: 'assistant',
                content: 'AES-256-GCM proporciona confidencialidad e integridad.',
                reasoningContent: 'Primero recordamos que GCM usa un IV de 12 bytes y tag de 16 bytes.',
                modelFullId: 'groq/llama-3.3-70b-versatile',
                metrics: {
                  ttftMs: 142,
                  tokensPerSec: 88.5,
                  promptTokens: 32,
                  completionTokens: 18,
                  reasoningTokens: 21,
                },
              },
            ],
          }),
        },
      );
      assert.equal(appendBatchRes.status, 201);
      const batchBody = (await appendBatchRes.json()) as {
        chat: { id: string; title: string; modelFullId: string | null; messageCount: number };
        message: { id: string; role: string; content: string };
        messages: Array<{
          id: string;
          role: string;
          content: string;
          reasoningContent: string | null;
          modelFullId: string | null;
          metrics: Record<string, number | null> | null;
        }>;
      };
      assert.notEqual(batchBody.chat.title, 'Nuevo chat');
      assert.ok(batchBody.chat.title.endsWith('...'));
      assert.ok(batchBody.chat.title.length <= 60);
      assert.equal(batchBody.chat.modelFullId, 'groq/llama-3.3-70b-versatile');
      assert.equal(batchBody.chat.messageCount, 2);
      assert.equal(batchBody.messages.length, 2);
      assert.equal(batchBody.messages[1]!.metrics?.ttftMs, 142);
      assert.equal(batchBody.messages[1]!.metrics?.tokensPerSec, 88.5);

      // Get chat detail
      const detailRes = await app.request(`/api/playground/chats/${create1Body.chat.id}`, {
        headers: { Cookie: admin.cookie },
      });
      assert.equal(detailRes.status, 200);
      const detailBody = (await detailRes.json()) as {
        chat: { id: string; title: string; messageCount: number };
        messages: Array<{ role: string; content: string; reasoningContent: string | null }>;
      };
      assert.equal(detailBody.chat.id, create1Body.chat.id);
      assert.equal(detailBody.chat.messageCount, 2);
      assert.equal(detailBody.messages.length, 2);
      assert.equal(detailBody.messages[0]!.role, 'user');
      assert.equal(detailBody.messages[0]!.content, longPrompt);
      assert.equal(detailBody.messages[1]!.role, 'assistant');
      assert.equal(
        detailBody.messages[1]!.reasoningContent,
        'Primero recordamos que GCM usa un IV de 12 bytes y tag de 16 bytes.',
      );

      // Rename chat via PATCH
      currentTimeMs += 5000;
      const patchRes = await app.request(`/api/playground/chats/${create1Body.chat.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
        body: JSON.stringify({
          title: 'Notas de AES-256-GCM',
          modelFullId: 'openrouter/deepseek-r1',
        }),
      });
      assert.equal(patchRes.status, 200);
      const patchBody = (await patchRes.json()) as {
        chat: { title: string; modelFullId: string | null };
      };
      assert.equal(patchBody.chat.title, 'Notas de AES-256-GCM');
      assert.equal(patchBody.chat.modelFullId, 'openrouter/deepseek-r1');

      // Validation errors (invalid role, empty content)
      const badRoleRes = await app.request(
        `/api/playground/chats/${create1Body.chat.id}/messages`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
          body: JSON.stringify({ role: 'tool', content: 'invalid' }),
        },
      );
      assert.equal(badRoleRes.status, 400);

      const emptyContentRes = await app.request(
        `/api/playground/chats/${create1Body.chat.id}/messages`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
          body: JSON.stringify({ role: 'user', content: '' }),
        },
      );
      assert.equal(emptyContentRes.status, 400);

      // Create a second chat with custom title and verify ordering DESC
      currentTimeMs += 5000;
      const create2Res = await app.request('/api/playground/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
        body: JSON.stringify({
          title: 'Mi segundo chat',
          modelFullId: 'nvidia/llama-3.1-8b',
        }),
      });
      assert.equal(create2Res.status, 201);
      const create2Body = (await create2Res.json()) as { chat: { id: string; title: string } };

      const listRes = await app.request('/api/playground/chats', {
        headers: { Cookie: admin.cookie },
      });
      assert.equal(listRes.status, 200);
      const listBody = (await listRes.json()) as { chats: Array<{ id: string; title: string }> };
      assert.equal(listBody.chats.length, 2);
      assert.equal(listBody.chats[0]!.id, create2Body.chat.id);
      assert.equal(listBody.chats[1]!.id, create1Body.chat.id);

      // Delete single chat
      const delOneRes = await app.request(`/api/playground/chats/${create1Body.chat.id}`, {
        method: 'DELETE',
        headers: { Cookie: admin.cookie },
      });
      assert.equal(delOneRes.status, 200);
      assert.deepEqual(await delOneRes.json(), { ok: true });

      const afterDelOneRes = await app.request(`/api/playground/chats/${create1Body.chat.id}`, {
        headers: { Cookie: admin.cookie },
      });
      assert.equal(afterDelOneRes.status, 404);

      // Clear all remaining chats
      const clearRes = await app.request('/api/playground/chats', {
        method: 'DELETE',
        headers: { Cookie: admin.cookie },
      });
      assert.equal(clearRes.status, 200);
      assert.deepEqual(await clearRes.json(), { ok: true, deletedCount: 1 });

      const finalListRes = await app.request('/api/playground/chats', {
        headers: { Cookie: admin.cookie },
      });
      assert.deepEqual(await finalListRes.json(), { chats: [] });
    } finally {
      db.close();
    }
  });

  it('enforces strict per-account privacy isolation (guest vs admin, admin vs guest, guest vs guest)', async () => {
    const dir = makeTempDir();
    const db = openDatabase(path.join(dir, 'bifrost.db'));
    const masterKey = randomBytes(32);
    const app = createApp({ db, masterKey });

    try {
      const { admin, guest1, guest2 } = await createAdminAndGuests(app);

      // Admin creates a private chat
      const adminChatRes = await app.request('/api/playground/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
        body: JSON.stringify({ title: 'Secreto del Admin' }),
      });
      assert.equal(adminChatRes.status, 201);
      const adminChatId = ((await adminChatRes.json()) as { chat: { id: string } }).chat.id;

      // Guest 1 creates a private chat
      const guest1ChatRes = await app.request('/api/playground/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: guest1.cookie },
        body: JSON.stringify({ title: 'Secreto de Guest 1' }),
      });
      assert.equal(guest1ChatRes.status, 201);
      const guest1ChatId = ((await guest1ChatRes.json()) as { chat: { id: string } }).chat.id;

      // Guest 2 creates a private chat
      const guest2ChatRes = await app.request('/api/playground/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: guest2.cookie },
        body: JSON.stringify({ title: 'Secreto de Guest 2' }),
      });
      assert.equal(guest2ChatRes.status, 201);
      const guest2ChatId = ((await guest2ChatRes.json()) as { chat: { id: string } }).chat.id;

      // Helper to verify every single operation on a foreign chatId returns 404
      async function assertForeignAccessDenied(actorCookie: string, foreignChatId: string) {
        const getRes = await app.request(`/api/playground/chats/${foreignChatId}`, {
          headers: { Cookie: actorCookie },
        });
        assert.equal(getRes.status, 404);

        const patchRes = await app.request(`/api/playground/chats/${foreignChatId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Cookie: actorCookie },
          body: JSON.stringify({ title: 'Intento de hijack' }),
        });
        assert.equal(patchRes.status, 404);

        const postMsgRes = await app.request(`/api/playground/chats/${foreignChatId}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: actorCookie },
          body: JSON.stringify({ role: 'user', content: 'Inyección de mensaje' }),
        });
        assert.equal(postMsgRes.status, 404);

        const delRes = await app.request(`/api/playground/chats/${foreignChatId}`, {
          method: 'DELETE',
          headers: { Cookie: actorCookie },
        });
        assert.equal(delRes.status, 404);
      }

      // Guest 1 cannot access Admin's or Guest 2's chats
      await assertForeignAccessDenied(guest1.cookie, adminChatId);
      await assertForeignAccessDenied(guest1.cookie, guest2ChatId);

      // Admin CANNOT access Guest 1's or Guest 2's chats (NO admin override!)
      await assertForeignAccessDenied(admin.cookie, guest1ChatId);
      await assertForeignAccessDenied(admin.cookie, guest2ChatId);

      // ?userId= query parameter must be completely ignored even for admin
      const adminSpoofListRes = await app.request(
        `/api/playground/chats?userId=${encodeURIComponent(guest1.id)}`,
        { headers: { Cookie: admin.cookie } },
      );
      assert.equal(adminSpoofListRes.status, 200);
      const adminSpoofList = (await adminSpoofListRes.json()) as {
        chats: Array<{ id: string; title: string }>;
      };
      assert.equal(adminSpoofList.chats.length, 1);
      assert.equal(adminSpoofList.chats[0]!.id, adminChatId);

      // DELETE /api/playground/chats by admin with ?userId=guest1 only clears admin's chats
      const adminClearRes = await app.request(
        `/api/playground/chats?userId=${encodeURIComponent(guest1.id)}`,
        {
          method: 'DELETE',
          headers: { Cookie: admin.cookie },
        },
      );
      assert.equal(adminClearRes.status, 200);
      assert.deepEqual(await adminClearRes.json(), { ok: true, deletedCount: 1 });

      // Guest 1's chat is completely untouched
      const guest1CheckRes = await app.request(`/api/playground/chats/${guest1ChatId}`, {
        headers: { Cookie: guest1.cookie },
      });
      assert.equal(guest1CheckRes.status, 200);
      const guest1Check = (await guest1CheckRes.json()) as { chat: { title: string } };
      assert.equal(guest1Check.chat.title, 'Secreto de Guest 1');
    } finally {
      db.close();
    }
  });

  it('encrypts title, content, and reasoning at rest in SQLite with distinct per-user AES-256-GCM keys and never leaks to system_logs', async () => {
    const dir = makeTempDir();
    const db = openDatabase(path.join(dir, 'bifrost.db'));
    const masterKey = randomBytes(32);
    const app = createApp({ db, masterKey });

    const secretTitle = 'TOP-SECRET-CHAT-TITLE-998877';
    const secretPrompt = 'CONFIDENTIAL-PROMPT-PAYLOAD-445566';
    const secretAnswer = 'PRIVATE-ASSISTANT-RESPONSE-112233';
    const secretReasoning = 'HIDDEN-CHAIN-OF-THOUGHT-776655';

    try {
      const { admin, guest1 } = await createAdminAndGuests(app);

      const chatRes = await app.request('/api/playground/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: guest1.cookie },
        body: JSON.stringify({ title: secretTitle }),
      });
      assert.equal(chatRes.status, 201);
      const chatId = ((await chatRes.json()) as { chat: { id: string } }).chat.id;

      const msgRes = await app.request(`/api/playground/chats/${chatId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: guest1.cookie },
        body: JSON.stringify({
          messages: [
            { role: 'user', content: secretPrompt },
            {
              role: 'assistant',
              content: secretAnswer,
              reasoningContent: secretReasoning,
              metrics: { ttftMs: 95, tokensPerSec: 60.2 },
            },
          ],
        }),
      });
      assert.equal(msgRes.status, 201);

      // Inspect raw SQLite bytes directly
      const rawChat = db
        .prepare(`SELECT encrypted_title FROM playground_chats WHERE id = ?`)
        .get(chatId) as { encrypted_title: Uint8Array };
      assert.ok(rawChat.encrypted_title instanceof Uint8Array);
      const rawTitleBuf = Buffer.from(rawChat.encrypted_title);
      assert.equal(rawTitleBuf.includes(Buffer.from(secretTitle, 'utf8')), false);

      // Per-user cryptographic separation: admin's derived key cannot decrypt guest1's ciphertext
      const adminSubkey = deriveUserPlaygroundKey(masterKey, admin.id);
      const guest1Subkey = deriveUserPlaygroundKey(masterKey, guest1.id);
      assert.throws(() => decryptSecret(rawTitleBuf, adminSubkey));
      assert.equal(decryptSecret(rawTitleBuf, guest1Subkey), secretTitle);

      const rawMessages = db
        .prepare(
          `SELECT role, encrypted_content, encrypted_reasoning, metrics_json
           FROM playground_messages WHERE chat_id = ? ORDER BY rowid ASC`,
        )
        .all(chatId) as Array<{
        role: string;
        encrypted_content: Uint8Array;
        encrypted_reasoning: Uint8Array | null;
        metrics_json: string | null;
      }>;
      assert.equal(rawMessages.length, 2);

      const rawPromptBuf = Buffer.from(rawMessages[0]!.encrypted_content);
      assert.equal(rawPromptBuf.includes(Buffer.from(secretPrompt, 'utf8')), false);
      assert.equal(decryptSecret(rawPromptBuf, guest1Subkey), secretPrompt);
      assert.equal(rawMessages[0]!.encrypted_reasoning, null);

      const rawAnswerBuf = Buffer.from(rawMessages[1]!.encrypted_content);
      const rawReasoningBuf = Buffer.from(rawMessages[1]!.encrypted_reasoning!);
      assert.equal(rawAnswerBuf.includes(Buffer.from(secretAnswer, 'utf8')), false);
      assert.equal(rawReasoningBuf.includes(Buffer.from(secretReasoning, 'utf8')), false);
      assert.equal(decryptSecret(rawAnswerBuf, guest1Subkey), secretAnswer);
      assert.equal(decryptSecret(rawReasoningBuf, guest1Subkey), secretReasoning);

      // Ensure system_logs contains none of the private strings
      const allLogs = db
        .prepare(`SELECT message, meta_json FROM system_logs`)
        .all() as Array<{ message: string; meta_json: string | null }>;
      const logsDump = JSON.stringify(allLogs);
      for (const needle of [secretTitle, secretPrompt, secretAnswer, secretReasoning]) {
        assert.equal(logsDump.includes(needle), false, `system_logs must never leak ${needle}`);
      }
    } finally {
      db.close();
    }
  });

  it('excludes playground chats from encrypted backups and cascades deletion when a user is deleted', async () => {
    const dir = makeTempDir();
    const db = openDatabase(path.join(dir, 'bifrost.db'));
    const masterKey = randomBytes(32);
    const app = createApp({ db, masterKey });

    const guestSecretTitle = 'GUEST-PRIVATE-BACKUP-CHECK-TITLE';
    const guestSecretPrompt = 'GUEST-PRIVATE-BACKUP-CHECK-PROMPT';

    try {
      const { admin, guest1, guest2 } = await createAdminAndGuests(app);

      // Create chats for guest1 and guest2
      const g1ChatRes = await app.request('/api/playground/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: guest1.cookie },
        body: JSON.stringify({ title: guestSecretTitle }),
      });
      assert.equal(g1ChatRes.status, 201);
      const g1ChatId = ((await g1ChatRes.json()) as { chat: { id: string } }).chat.id;

      await app.request(`/api/playground/chats/${g1ChatId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: guest1.cookie },
        body: JSON.stringify({ role: 'user', content: guestSecretPrompt }),
      });

      const g2ChatRes = await app.request('/api/playground/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: guest2.cookie },
        body: JSON.stringify({ title: 'Chat de Guest 2 que debe sobrevivir' }),
      });
      assert.equal(g2ChatRes.status, 201);

      // 1. Export full backup and verify playground tables/data are completely excluded
      const backupPassword = 'backup-super-secret-passphrase';
      const envelope = await exportEncryptedBackup({
        db,
        masterKey,
        password: backupPassword,
        actingUserId: admin.id,
        includeProvidersAndConfig: true,
        includeProviderKeys: true,
        includeUsersAndQuotas: true,
        includeNodes: true,
        includeTelemetry: true,
        includeUsageLogs: true,
        includeSystemLogs: true,
        includeCache: true,
      });

      const rawBackupJson = await unpackBifrostEnvelopeRaw(envelope, backupPassword);
      const parsedBackup = JSON.parse(rawBackupJson) as Record<string, unknown>;
      assert.equal('playgroundChats' in parsedBackup, false);
      assert.equal('playgroundMessages' in parsedBackup, false);
      assert.equal('playground_chats' in parsedBackup, false);
      assert.equal('playground_messages' in parsedBackup, false);
      assert.equal(rawBackupJson.includes(guestSecretTitle), false);
      assert.equal(rawBackupJson.includes(guestSecretPrompt), false);
      assert.equal(rawBackupJson.includes(g1ChatId), false);

      // 2. Delete guest1 via DELETE /api/users/:id and verify ON DELETE CASCADE
      const delUserRes = await app.request(`/api/users/${guest1.id}`, {
        method: 'DELETE',
        headers: { Cookie: admin.cookie },
      });
      assert.equal(delUserRes.status, 200);

      const g1ChatsCount = (
        db
          .prepare(`SELECT COUNT(*) AS cnt FROM playground_chats WHERE user_id = ?`)
          .get(guest1.id) as { cnt: number | bigint }
      ).cnt;
      const g1MsgsCount = (
        db
          .prepare(`SELECT COUNT(*) AS cnt FROM playground_messages WHERE user_id = ?`)
          .get(guest1.id) as { cnt: number | bigint }
      ).cnt;
      assert.equal(Number(g1ChatsCount), 0);
      assert.equal(Number(g1MsgsCount), 0);

      // Guest 2's chat must remain intact
      const g2ChatsCount = (
        db
          .prepare(`SELECT COUNT(*) AS cnt FROM playground_chats WHERE user_id = ?`)
          .get(guest2.id) as { cnt: number | bigint }
      ).cnt;
      assert.equal(Number(g2ChatsCount), 1);
    } finally {
      db.close();
    }
  });
});

import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterEach, describe, it } from 'node:test';

import { encryptSecret, generateInternalApiKey, hashPassword } from '../core/src/crypto.js';
import { openDatabase } from '../core/src/db.js';
import {
  handlePlaygroundChat,
  waitForPendingPlaygroundStreamsForTests,
} from '../core/src/playground.js';
import {
  MAX_PLAYGROUND_MESSAGE_CONTENT_LENGTH,
  createPlaygroundChat,
  getPlaygroundChatDetail,
  isChatGenerating,
  markChatGenerating,
  resetGeneratingChatsForTests,
} from '../core/src/playground-history.js';
import {
  DrainingRegistry,
  computeTokensPerSec,
  executeChatCompletions,
  resetInFlightQuotaReservationsForTests,
  toSafeNonNegInt,
} from '../core/src/router.js';

function createBaseManifest(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: '1.0',
    id: 'edge-prov',
    name: 'Edge Provider',
    packageType: 'official-json',
    baseUrl: 'https://edge.example.com/v1',
    auth: { type: 'bearer', header: 'Authorization', prefix: 'Bearer ' },
    modelsSource: 'static',
    reviewedAt: '2026-11-20',
    rateLimitKind: 'tokens',
    rateLimitWindows: ['day'],
    staticModels: [{ id: 'edge-model', name: 'Edge Model' }],
    ...overrides,
  };
}

async function seedRouterFixture(options: {
  db: ReturnType<typeof openDatabase>;
  masterKey: Buffer;
  nowSec: number;
  manifestOverrides?: Record<string, unknown>;
  keys?: Array<{ id?: string; label: string; secret: string; status?: string }>;
}) {
  const { db, masterKey, nowSec } = options;
  const manifest = createBaseManifest(options.manifestOverrides);
  const providerId = String(manifest.id);

  const userId = 'user-edge-1';
  const passHash = await hashPassword('TestPassword123!');
  db.prepare(
    `INSERT OR IGNORE INTO users (id, username, password_hash, role, daily_token_limit, quota_reset_mode, created_at)
     VALUES (?, 'edge_admin', ?, 'admin', NULL, 'utc_midnight', ?)`,
  ).run(userId, passHash, nowSec);

  const apiKey = generateInternalApiKey();
  const internalKeyId = 'ik-edge-1';
  db.prepare(
    `INSERT OR IGNORE INTO internal_api_keys (id, user_id, name, key_prefix, key_hash, created_at)
     VALUES (?, ?, 'Edge Key', ?, ?, ?)`,
  ).run(internalKeyId, userId, apiKey.keyPrefix, apiKey.keyHash, nowSec);

  db.prepare(
    `INSERT INTO providers (id, name, package_type, models_source, schema_json, enabled, created_at)
     VALUES (?, ?, 'official-json', 'static', ?, 1, ?)`,
  ).run(providerId, String(manifest.name), JSON.stringify(manifest), nowSec);

  const keyList = options.keys ?? [{ label: 'Primary', secret: 'custom_secret_token_9876543210' }];
  const keyIds: string[] = [];
  for (const k of keyList) {
    const id = k.id ?? randomUUID();
    keyIds.push(id);
    db.prepare(
      `INSERT INTO provider_keys (id, provider_id, label, encrypted_secret, last4, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      providerId,
      k.label,
      encryptSecret(k.secret, masterKey),
      k.secret.slice(-4),
      k.status ?? 'active',
      nowSec,
    );
  }

  const modelId = 'edge-model';
  const modelFullId = `${providerId}/${modelId}`;
  db.prepare(
    `INSERT INTO models (full_id, provider_id, model_id, name, modalities_json, capabilities_json, is_free, first_seen_at, active, disabled_by_admin)
     VALUES (?, ?, ?, 'Edge Model', '{"input":["text"],"output":["text"]}', '{"tools":true,"reasoning":true,"structuredOutput":true}', 1, ?, 1, 0)`,
  ).run(modelFullId, providerId, modelId, nowSec);

  const providerRow = db
    .prepare(`SELECT * FROM providers WHERE id = ?`)
    .get(providerId) as Record<string, unknown>;

  return {
    userId,
    internalKeyId,
    rawApiKey: apiKey.rawKey,
    providerId,
    modelId,
    modelFullId,
    providerRow,
    keyIds,
  };
}

afterEach(() => {
  resetGeneratingChatsForTests();
  resetInFlightQuotaReservationsForTests();
});

describe('Ola 3 — Streaming SSE edge cases, anti-crash Node 24, selective fallback & security', () => {
  it('1) clientAborted logs partial usage with internalApiKeyId, survives user deletion mid-stream and NaN usage without crashing Node 24', async () => {
    const db = openDatabase(':memory:');
    const masterKey = randomBytes(32);
    const registry = new DrainingRegistry();
    let clockMs = Date.UTC(2026, 10, 26, 12, 0, 0);
    const nowSec = Math.floor(clockMs / 1000);

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);

    try {
      const fix = await seedRouterFixture({ db, masterKey, nowSec });

      // Part A: Client cancels SSE mid-stream -> records partial usage + internal_api_key_id + cancels upstream
      let upstreamCancelled = false;
      let releaseChunk2!: () => void;
      const chunk2Gate = new Promise<void>((resolve) => {
        releaseChunk2 = resolve;
      });

      const mockFetchAbort: typeof fetch = async () => {
        const enc = new TextEncoder();
        const body = new ReadableStream<Uint8Array>({
          async start(ctrl) {
            clockMs += 25;
            ctrl.enqueue(
              enc.encode(
                `data: ${JSON.stringify({
                  choices: [
                    {
                      index: 0,
                      delta: { content: 'Partial content emitted before disconnect 1234567890' },
                    },
                  ],
                  // Non-numeric / NaN usage must never throw NOT NULL constraint failed
                  usage: { prompt_tokens: 'not-a-num', completion_tokens: Number.NaN },
                })}\n\n`,
              ),
            );
            await chunk2Gate;
            try {
              ctrl.close();
            } catch {
              // Already cancelled
            }
          },
          cancel() {
            upstreamCancelled = true;
            releaseChunk2();
          },
        });
        return new Response(body, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      };

      const resA = await executeChatCompletions({
        db,
        masterKey,
        registry,
        fetchImpl: mockFetchAbort,
        now: () => clockMs,
        userId: fix.userId,
        internalApiKeyId: fix.internalKeyId,
        modelFullId: fix.modelFullId,
        modelId: fix.modelId,
        providerRow: fix.providerRow,
        requestBody: {
          model: fix.modelFullId,
          stream: true,
          messages: [{ role: 'user', content: 'Tell me a long story please.' }],
        },
      });
      assert.equal(resA.status, 200);
      const reader = resA.body!.getReader();
      const firstChunk = await reader.read();
      assert.equal(firstChunk.done, false);
      assert.ok(new TextDecoder().decode(firstChunk.value).includes('Partial content'));

      // Client disconnects mid-stream
      await reader.cancel();
      await new Promise((r) => setTimeout(r, 40));

      assert.equal(upstreamCancelled, true, 'Upstream stream body must be cancelled on client abort');
      assert.equal(registry.getKeyInFlightCount(fix.keyIds[0]!), 0, 'Lease must be released');

      const abortLog = db
        .prepare(
          `SELECT internal_api_key_id, prompt_tokens, completion_tokens, status, error_type
           FROM usage_logs ORDER BY id DESC LIMIT 1`,
        )
        .get() as {
        internal_api_key_id: string | null;
        prompt_tokens: number;
        completion_tokens: number;
        status: string;
        error_type: string | null;
      };
      assert.ok(abortLog, 'Expected usage_log entry for clientAborted stream');
      assert.equal(abortLog.internal_api_key_id, fix.internalKeyId);
      assert.ok(abortLog.prompt_tokens > 0, 'Expected fallback prompt_tokens > 0');
      assert.ok(abortLog.completion_tokens > 0, 'Expected fallback completion_tokens > 0');
      assert.equal(abortLog.status, 'error');
      assert.equal(abortLog.error_type, 'client_aborted');

      // Part B: User deleted while stream is open (FK constraint violation on usage_logs) -> zero crash / zero unhandledRejection
      const ephemUserId = 'user-to-delete-midstream';
      db.prepare(
        `INSERT INTO users (id, username, password_hash, role, created_at)
         VALUES (?, 'temp_user', 'hash', 'guest', ?)`,
      ).run(ephemUserId, nowSec);

      let releaseDeleteGate!: () => void;
      const deleteGate = new Promise<void>((resolve) => {
        releaseDeleteGate = resolve;
      });

      const mockFetchUserDeleted: typeof fetch = async () => {
        const enc = new TextEncoder();
        const body = new ReadableStream<Uint8Array>({
          async start(ctrl) {
            ctrl.enqueue(
              enc.encode(
                `data: ${JSON.stringify({
                  choices: [{ index: 0, delta: { content: 'Still alive!' }, finish_reason: 'stop' }],
                  usage: { prompt_tokens: 10, completion_tokens: 5 },
                })}\n\n`,
              ),
            );
            await deleteGate;
            ctrl.enqueue(enc.encode('data: [DONE]\n\n'));
            ctrl.close();
          },
        });
        return new Response(body, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      };

      const resB = await executeChatCompletions({
        db,
        masterKey,
        registry,
        fetchImpl: mockFetchUserDeleted,
        now: () => clockMs,
        userId: ephemUserId,
        modelFullId: fix.modelFullId,
        modelId: fix.modelId,
        providerRow: fix.providerRow,
        requestBody: {
          model: fix.modelFullId,
          stream: true,
          messages: [{ role: 'user', content: 'Hello before deletion' }],
        },
      });
      assert.equal(resB.status, 200);

      // Delete the user while the SSE stream is open
      db.prepare(`DELETE FROM users WHERE id = ?`).run(ephemUserId);
      releaseDeleteGate();

      const textB = await resB.text();
      assert.ok(textB.includes('Still alive!'));
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(unhandled.length, 0, `Expected 0 unhandled rejections, got: ${String(unhandled)}`);
      assert.equal(toSafeNonNegInt(Number.NaN), 0);
      assert.equal(toSafeNonNegInt(-42), 0);
      assert.equal(toSafeNonNegInt(Infinity), 0);
      assert.equal(toSafeNonNegInt('abc'), 0);
      assert.equal(toSafeNonNegInt(17.9), 17);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      db.close();
    }
  });

  it('2) sends stream_options.include_usage with transparent 400 fallback, applies selective per-field fallback (preserving real reasoning_tokens + tool_calls), warns on 200 zero-usage, and redacts literal rawSecret (BF-04)', async () => {
    const db = openDatabase(':memory:');
    const masterKey = randomBytes(32);
    const registry = new DrainingRegistry();
    let clockMs = Date.UTC(2026, 10, 26, 13, 0, 0);
    const nowSec = Math.floor(clockMs / 1000);
    const literalSecret = 'opaque_nonregex_vendor_token_XYZ987654321';

    try {
      const fix = await seedRouterFixture({
        db,
        masterKey,
        nowSec,
        keys: [{ label: 'Vendor Key', secret: literalSecret }],
      });

      // A) stream_options 400 retry on SAME key + selective fallback (real reasoning_tokens=100, missing completion_tokens + tool_calls)
      let streamAttempt = 0;

      const mockFetch: typeof fetch = async (_input, init) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        clockMs += 50;

        if (body.stream === true) {
          streamAttempt++;
          if (streamAttempt === 1) {
            assert.deepEqual(body.stream_options, { include_usage: true });
            return new Response(
              JSON.stringify({
                error: { message: 'Unknown field: stream_options is not supported by this provider' },
              }),
              { status: 400, headers: { 'Content-Type': 'application/json' } },
            );
          }
          // Second attempt must omit stream_options on the SAME key
          assert.equal(body.stream_options, undefined);
          const enc = new TextEncoder();
          const sse = new ReadableStream<Uint8Array>({
            start(ctrl) {
              ctrl.enqueue(
                enc.encode(
                  `data: ${JSON.stringify({
                    choices: [
                      {
                        index: 0,
                        delta: {
                          content: '12345678901234567890', // 20 chars
                          tool_calls: [
                            {
                              index: 0,
                              id: 'call_1',
                              type: 'function',
                              function: { name: 'search', arguments: '{"q":"bifrost"}' }, // 6 + 15 = 21 chars
                            },
                          ],
                        },
                        finish_reason: 'tool_calls',
                      },
                    ],
                    // Real reasoning_tokens=100, completion_tokens=0 -> must keep 100 and estimate ONLY completion!
                    usage: {
                      prompt_tokens: 40,
                      completion_tokens: 0,
                      completion_tokens_details: { reasoning_tokens: 100 },
                    },
                  })}\n\n`,
                ),
              );
              ctrl.enqueue(enc.encode('data: [DONE]\n\n'));
              ctrl.close();
            },
          });
          return new Response(sse, {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
          });
        }

        return new Response('unexpected', { status: 500 });
      };

      const streamRes = await executeChatCompletions({
        db,
        masterKey,
        registry,
        fetchImpl: mockFetch,
        now: () => clockMs,
        userId: fix.userId,
        internalApiKeyId: fix.internalKeyId,
        modelFullId: fix.modelFullId,
        modelId: fix.modelId,
        providerRow: fix.providerRow,
        requestBody: {
          model: fix.modelFullId,
          stream: true,
          messages: [{ role: 'user', content: 'Search bifrost' }],
        },
      });
      assert.equal(streamRes.status, 200);
      await streamRes.text();
      assert.equal(streamAttempt, 2, 'Should retry once without stream_options on the same key');

      const keyStatus = (
        db.prepare(`SELECT status FROM provider_keys WHERE id = ?`).get(fix.keyIds[0]!) as {
          status: string;
        }
      ).status;
      assert.equal(keyStatus, 'active', 'Key must remain active after transparent stream_options fallback');

      const sseUsage = db
        .prepare(
          `SELECT prompt_tokens, completion_tokens, reasoning_tokens, internal_api_key_id
           FROM usage_logs ORDER BY id DESC LIMIT 1`,
        )
        .get() as {
        prompt_tokens: number;
        completion_tokens: number;
        reasoning_tokens: number;
        internal_api_key_id: string | null;
      };
      assert.equal(sseUsage.prompt_tokens, 40);
      assert.equal(sseUsage.reasoning_tokens, 100, 'Must preserve real reasoning_tokens=100');
      assert.equal(
        sseUsage.completion_tokens,
        Math.ceil((20 + 6 + 15) / 4),
        'Must estimate completion_tokens including toolCallChars',
      );
      assert.equal(sseUsage.internal_api_key_id, fix.internalKeyId);

      // B) Non-streaming selective fallback (real reasoning_tokens=100, missing completion_tokens, with content + tool_calls)
      const mockFetchNonStream: typeof fetch = async () => {
        clockMs += 40;
        return new Response(
          JSON.stringify({
            id: 'cmpl-ns-1',
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: 'Hello world!', // 12 chars
                  tool_calls: [
                    {
                      id: 'call_2',
                      type: 'function',
                      function: { name: 'ping', arguments: '{"ok":true}' }, // 4 + 11 = 15 chars
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
            usage: {
              prompt_tokens: 30,
              completion_tokens: 0,
              completion_tokens_details: { reasoning_tokens: 100 },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      };

      const nsRes = await executeChatCompletions({
        db,
        masterKey,
        registry,
        fetchImpl: mockFetchNonStream,
        now: () => clockMs,
        userId: fix.userId,
        internalApiKeyId: fix.internalKeyId,
        modelFullId: fix.modelFullId,
        modelId: fix.modelId,
        providerRow: fix.providerRow,
        requestBody: {
          model: fix.modelFullId,
          stream: false,
          messages: [{ role: 'user', content: 'Ping please' }],
        },
      });
      assert.equal(nsRes.status, 200);
      const nsUsage = db
        .prepare(
          `SELECT prompt_tokens, completion_tokens, reasoning_tokens
           FROM usage_logs ORDER BY id DESC LIMIT 1`,
        )
        .get() as { prompt_tokens: number; completion_tokens: number; reasoning_tokens: number };
      assert.equal(nsUsage.prompt_tokens, 30);
      assert.equal(nsUsage.reasoning_tokens, 100);
      assert.equal(nsUsage.completion_tokens, Math.ceil((12 + 4 + 11) / 4));

      // C) HTTP 200 with zero usage AND empty content -> charges estimatedPromptTokens and logs warn in system_logs
      const mockFetchZero: typeof fetch = async () => {
        clockMs += 20;
        return new Response(
          JSON.stringify({
            id: 'cmpl-zero-1',
            choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 0, completion_tokens: 0 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      };
      const zeroRes = await executeChatCompletions({
        db,
        masterKey,
        registry,
        fetchImpl: mockFetchZero,
        now: () => clockMs,
        userId: fix.userId,
        modelFullId: fix.modelFullId,
        modelId: fix.modelId,
        providerRow: fix.providerRow,
        requestBody: {
          model: fix.modelFullId,
          stream: false,
          messages: [{ role: 'user', content: 'Count these prompt tokens!' }],
        },
      });
      assert.equal(zeroRes.status, 200);
      const zeroLog = db
        .prepare(`SELECT prompt_tokens FROM usage_logs ORDER BY id DESC LIMIT 1`)
        .get() as { prompt_tokens: number };
      assert.ok(zeroLog.prompt_tokens > 0, 'Must charge estimatedPromptTokens on HTTP 200 zero usage');
      const warnRow = db
        .prepare(
          `SELECT level, message FROM system_logs WHERE level = 'warn' AND message LIKE '%zero usage%' ORDER BY id DESC LIMIT 1`,
        )
        .get() as { level: string; message: string } | undefined;
      assert.ok(warnRow, 'Expected warn log in system_logs on HTTP 200 zero usage');

      // D) BF-04 literal rawSecret redaction before truncation in client error, system_logs & last_error
      const mockFetchLeak: typeof fetch = async () => {
        return new Response(
          JSON.stringify({
            error: {
              message: `Authentication rejected for vendor key ${literalSecret} at edge gateway`,
            },
          }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        );
      };
      const leakRes = await executeChatCompletions({
        db,
        masterKey,
        registry,
        fetchImpl: mockFetchLeak,
        now: () => clockMs,
        userId: fix.userId,
        modelFullId: fix.modelFullId,
        modelId: fix.modelId,
        providerRow: fix.providerRow,
        requestBody: {
          model: fix.modelFullId,
          stream: false,
          messages: [{ role: 'user', content: 'Trigger 400 leak' }],
        },
      });
      assert.equal(leakRes.status, 400);
      const leakBodyText = await leakRes.text();
      assert.equal(leakBodyText.includes(literalSecret), false, 'Client response must not leak rawSecret');
      assert.ok(leakBodyText.includes('[REDACTED]'));
      const sysLogsDump = JSON.stringify(db.prepare(`SELECT message, meta_json FROM system_logs`).all());
      assert.equal(sysLogsDump.includes(literalSecret), false, 'system_logs must not leak rawSecret');
    } finally {
      db.close();
    }
  });

  it('3) cumulative SSE usage chunks do NOT inflate quadratically (DEEP-08), records internal_api_key_id, and unifies tokensPerSec', async () => {
    const db = openDatabase(':memory:');
    const masterKey = randomBytes(32);
    const registry = new DrainingRegistry();
    let clockMs = Date.UTC(2026, 10, 26, 14, 0, 0);
    const nowSec = Math.floor(clockMs / 1000);

    try {
      const fix = await seedRouterFixture({ db, masterKey, nowSec });

      const mockFetchCumulative: typeof fetch = async () => {
        const enc = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          start(ctrl) {
            const chunks = [
              { text: 'one ', prompt: 50, comp: 5, reas: 10 },
              { text: 'two ', prompt: 50, comp: 10, reas: 20 },
              { text: 'three ', prompt: 50, comp: 15, reas: 30 },
              { text: 'four', prompt: 50, comp: 20, reas: 40, finish: 'stop' },
            ];
            for (const c of chunks) {
              clockMs += 50; // total 200ms
              ctrl.enqueue(
                enc.encode(
                  `data: ${JSON.stringify({
                    choices: [{ index: 0, delta: { content: c.text }, finish_reason: c.finish ?? null }],
                    usage: {
                      prompt_tokens: c.prompt,
                      completion_tokens: c.comp,
                      completion_tokens_details: { reasoning_tokens: c.reas },
                    },
                  })}\n\n`,
                ),
              );
            }
            ctrl.enqueue(enc.encode('data: [DONE]\n\n'));
            ctrl.close();
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      };

      const res = await executeChatCompletions({
        db,
        masterKey,
        registry,
        fetchImpl: mockFetchCumulative,
        now: () => clockMs,
        userId: fix.userId,
        internalApiKeyId: fix.internalKeyId,
        modelFullId: fix.modelFullId,
        modelId: fix.modelId,
        providerRow: fix.providerRow,
        requestBody: {
          model: fix.modelFullId,
          stream: true,
          messages: [{ role: 'user', content: 'Count to four' }],
        },
      });
      assert.equal(res.status, 200);
      await res.text();

      const row = db
        .prepare(
          `SELECT prompt_tokens, completion_tokens, reasoning_tokens, tokens_per_sec, internal_api_key_id, status
           FROM usage_logs ORDER BY id DESC LIMIT 1`,
        )
        .get() as {
        prompt_tokens: number;
        completion_tokens: number;
        reasoning_tokens: number;
        tokens_per_sec: number | null;
        internal_api_key_id: string | null;
        status: string;
      };

      assert.equal(row.status, 'ok');
      assert.equal(row.prompt_tokens, 50, 'Must NOT inflate prompt_tokens across cumulative SSE chunks');
      assert.equal(row.completion_tokens, 20, 'Must NOT inflate completion_tokens quadratically');
      assert.equal(row.reasoning_tokens, 40, 'Must NOT inflate reasoning_tokens quadratically');
      assert.equal(row.internal_api_key_id, fix.internalKeyId);
      assert.equal(row.tokens_per_sec, computeTokensPerSec(20, 40, 200));
    } finally {
      db.close();
    }
  });

  it('4) enforces body whitelist & rejects n > 1, handles multiline SSE, discards truncated JSON at EOF, prevents duplicate tool_calls on drop, discounts max_tokens on resume, treats null body as transient, and enforces idle timeout + Playground STB-10', async () => {
    const db = openDatabase(':memory:');
    const masterKey = randomBytes(32);
    const registry = new DrainingRegistry();
    let clockMs = Date.UTC(2026, 10, 26, 15, 0, 0);
    const nowSec = Math.floor(clockMs / 1000);

    try {
      const fix = await seedRouterFixture({
        db,
        masterKey,
        nowSec,
        keys: [
          { id: 'k-edge-1', label: 'Key 1', secret: 'sk-edge-key-1111' },
          { id: 'k-edge-2', label: 'Key 2', secret: 'sk-edge-key-2222' },
        ],
      });

      // A) Reject n > 1 with HTTP 400
      const badNRes = await executeChatCompletions({
        db,
        masterKey,
        registry,
        fetchImpl: async () => {
          throw new Error('Should not reach upstream for n > 1');
        },
        now: () => clockMs,
        userId: fix.userId,
        modelFullId: fix.modelFullId,
        modelId: fix.modelId,
        providerRow: fix.providerRow,
        requestBody: {
          model: fix.modelFullId,
          n: 3,
          messages: [{ role: 'user', content: 'Hi' }],
        },
      });
      assert.equal(badNRes.status, 400);

      // B) Whitelist strips models/plugins/provider/route/transforms while preserving chat_template_kwargs
      let forwardedBody: Record<string, unknown> = {};
      const resWhitelist = await executeChatCompletions({
        db,
        masterKey,
        registry,
        fetchImpl: async (_input, init) => {
          forwardedBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
          return new Response(
            JSON.stringify({
              choices: [{ index: 0, message: { role: 'assistant', content: 'clean' }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 5, completion_tokens: 2 },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        },
        now: () => clockMs,
        userId: fix.userId,
        modelFullId: fix.modelFullId,
        modelId: fix.modelId,
        providerRow: fix.providerRow,
        requestBody: {
          model: fix.modelFullId,
          messages: [{ role: 'user', content: 'Whitelist test' }],
          temperature: 0.5,
          chat_template_kwargs: { enable_thinking: false },
          models: ['openai/gpt-4o'],
          plugins: [{ id: 'web' }],
          provider: { allow_fallbacks: true },
          route: 'fallback',
          transforms: ['middle-out'],
        },
      });
      assert.equal(resWhitelist.status, 200);
      assert.equal(forwardedBody.temperature, 0.5);
      assert.deepEqual(forwardedBody.chat_template_kwargs, { enable_thinking: false });
      for (const blocked of ['models', 'plugins', 'provider', 'route', 'transforms']) {
        assert.equal(blocked in forwardedBody, false, `Blocked field "${blocked}" must not be forwarded`);
      }

      // C) Multiline SSE event + truncated JSON at EOF discarded + stream_resume discounts max_tokens
      const resumeBodies: Array<Record<string, unknown>> = [];
      let resumeCall = 0;
      const mockFetchResume: typeof fetch = async (_input, init) => {
        resumeCall++;
        resumeBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
        const enc = new TextEncoder();
        if (resumeCall === 1) {
          const s1 = new ReadableStream<Uint8Array>({
            start(ctrl) {
              // Multiline SSE event split across two data: lines + blank line
              ctrl.enqueue(
                enc.encode(
                  'data: {"choices":[{"index":0,\n' +
                    'data: "delta":{"content":"01234567890123456789"}}]}\n\n' +
                    // Truncated JSON fragment at EOF without [DONE] -> must be DISCARDED
                    'data: {"choices":[{"index":0,"delta":{"content":"BROKEN_TRUNC',
                ),
              );
              ctrl.close();
            },
          });
          return new Response(s1, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
        }
        const s2 = new ReadableStream<Uint8Array>({
          start(ctrl) {
            ctrl.enqueue(
              enc.encode(
                `data: ${JSON.stringify({
                  choices: [{ index: 0, delta: { content: 'RESUMED_END' }, finish_reason: 'stop' }],
                  usage: { prompt_tokens: 20, completion_tokens: 5 },
                })}\n\n`,
              ),
            );
            ctrl.enqueue(enc.encode('data: [DONE]\n\n'));
            ctrl.close();
          },
        });
        return new Response(s2, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      };

      const resResume = await executeChatCompletions({
        db,
        masterKey,
        registry,
        fetchImpl: mockFetchResume,
        now: () => clockMs,
        userId: fix.userId,
        modelFullId: fix.modelFullId,
        modelId: fix.modelId,
        providerRow: fix.providerRow,
        requestBody: {
          model: fix.modelFullId,
          stream: true,
          max_tokens: 50,
          messages: [{ role: 'user', content: 'Stream and resume' }],
        },
      });
      assert.equal(resResume.status, 200);
      const resumeText = await resResume.text();
      assert.ok(resumeText.includes('01234567890123456789'), 'Multiline SSE event must be parsed');
      assert.ok(resumeText.includes('RESUMED_END'), 'Resumed continuation must be received');
      assert.equal(resumeText.includes('BROKEN_TRUNC'), false, 'Truncated JSON at EOF must NEVER be forwarded');
      assert.equal(resumeBodies.length, 2);
      assert.equal(resumeBodies[0]!.max_tokens, 50);
      assert.equal(
        resumeBodies[1]!.max_tokens,
        45,
        'Continuation max_tokens must discount already-emitted 20 chars (5 tokens)',
      );

      // Reset keys to active for next sub-checks
      db.prepare(`UPDATE provider_keys SET status = 'active', last_error = NULL`).run();

      // D) Partial tool_calls drop must NOT retry from scratch / duplicate index: 0
      let toolDropAttempts = 0;
      const resToolDrop = await executeChatCompletions({
        db,
        masterKey,
        registry,
        fetchImpl: async () => {
          toolDropAttempts++;
          const enc = new TextEncoder();
          const s = new ReadableStream<Uint8Array>({
            start(ctrl) {
              ctrl.enqueue(
                enc.encode(
                  `data: ${JSON.stringify({
                    choices: [
                      {
                        index: 0,
                        delta: {
                          tool_calls: [
                            { index: 0, id: 'call_x', function: { name: 'lookup', arguments: '{"a":' } },
                          ],
                        },
                      },
                    ],
                  })}\n\n`,
                ),
              );
              ctrl.close();
            },
          });
          return new Response(s, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
        },
        now: () => clockMs,
        userId: fix.userId,
        modelFullId: fix.modelFullId,
        modelId: fix.modelId,
        providerRow: fix.providerRow,
        requestBody: {
          model: fix.modelFullId,
          stream: true,
          messages: [{ role: 'user', content: 'Call lookup tool' }],
        },
      });
      const toolDropBody = await resToolDrop.text();
      assert.equal(toolDropAttempts, 1, 'Must NOT retry from scratch after partial tool_calls were emitted');
      assert.ok(toolDropBody.includes('stream_interrupted'));

      // Reset keys to active
      db.prepare(`UPDATE provider_keys SET status = 'active', last_error = NULL`).run();

      // E) HTTP 200 with null body marks key rate_limited (transient), NOT permanent error (STB-13)
      let nullBodyCalls = 0;
      const resNullBody = await executeChatCompletions({
        db,
        masterKey,
        registry,
        fetchImpl: async () => {
          nullBodyCalls++;
          if (nullBodyCalls === 1) {
            return new Response(null, { status: 200 });
          }
          const enc = new TextEncoder();
          return new Response(
            new ReadableStream<Uint8Array>({
              start(ctrl) {
                ctrl.enqueue(
                  enc.encode(
                    `data: ${JSON.stringify({
                      choices: [{ index: 0, delta: { content: 'fallback ok' }, finish_reason: 'stop' }],
                    })}\n\n`,
                  ),
                );
                ctrl.enqueue(enc.encode('data: [DONE]\n\n'));
                ctrl.close();
              },
            }),
            { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
          );
        },
        now: () => clockMs,
        userId: fix.userId,
        modelFullId: fix.modelFullId,
        modelId: fix.modelId,
        providerRow: fix.providerRow,
        requestBody: {
          model: fix.modelFullId,
          stream: true,
          messages: [{ role: 'user', content: 'Null body test' }],
        },
      });
      assert.equal(resNullBody.status, 200);
      await resNullBody.text();
      const key1AfterNull = db
        .prepare(`SELECT status, ratelimit_reset_at FROM provider_keys WHERE id = 'k-edge-1'`)
        .get() as { status: string; ratelimit_reset_at: number | null };
      assert.equal(
        key1AfterNull.status,
        'rate_limited',
        'HTTP 200 with null body must be transient rate_limited, not error',
      );
      assert.ok(key1AfterNull.ratelimit_reset_at && key1AfterNull.ratelimit_reset_at > nowSec);

      // Reset keys to active
      db.prepare(`UPDATE provider_keys SET status = 'active', last_error = NULL`).run();

      // F) SSE idle timeout triggers failover & releases DrainingRegistry lease
      let idleCalls = 0;
      const resIdle = await executeChatCompletions({
        db,
        masterKey,
        registry,
        fetchImpl: async () => {
          idleCalls++;
          const enc = new TextEncoder();
          if (idleCalls === 1) {
            return new Response(
              new ReadableStream<Uint8Array>({
                start() {
                  // Stalled upstream that never sends any bytes
                },
              }),
              { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
            );
          }
          return new Response(
            new ReadableStream<Uint8Array>({
              start(ctrl) {
                ctrl.enqueue(
                  enc.encode(
                    `data: ${JSON.stringify({
                      choices: [{ index: 0, delta: { content: 'recovered after idle' }, finish_reason: 'stop' }],
                    })}\n\n`,
                  ),
                );
                ctrl.enqueue(enc.encode('data: [DONE]\n\n'));
                ctrl.close();
              },
            }),
            { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
          );
        },
        now: () => clockMs,
        userId: fix.userId,
        modelFullId: fix.modelFullId,
        modelId: fix.modelId,
        providerRow: fix.providerRow,
        requestBody: {
          model: fix.modelFullId,
          stream: true,
          messages: [{ role: 'user', content: 'Idle timeout test' }],
        },
        streamIdleTimeoutMs: 40,
      });
      const idleText = await resIdle.text();
      assert.ok(idleText.includes('recovered after idle'));
      assert.equal(idleCalls, 2);
      assert.equal(registry.getKeyInFlightCount('k-edge-1'), 0);
      assert.equal(registry.getKeyInFlightCount('k-edge-2'), 0);

      // G) Playground STB-10: refcount activeGeneratingChats + >200k truncation persistence + ephemeral cancel
      markChatGenerating('chat-ref', true);
      markChatGenerating('chat-ref', true);
      assert.equal(isChatGenerating('chat-ref'), true);
      markChatGenerating('chat-ref', false);
      assert.equal(isChatGenerating('chat-ref'), true, 'Refcount must stay active until all generations finish');
      markChatGenerating('chat-ref', false);
      assert.equal(isChatGenerating('chat-ref'), false);

      db.prepare(`UPDATE provider_keys SET status = 'active', last_error = NULL`).run();
      const createdChat = createPlaygroundChat(db, masterKey, fix.userId, { title: 'Long Chat' }, nowSec);
      const hugeText = 'A'.repeat(MAX_PLAYGROUND_MESSAGE_CONTENT_LENGTH + 5000);
      const pgRes = await handlePlaygroundChat({
        db,
        masterKey,
        registry,
        user: { id: fix.userId, username: 'edge_admin', role: 'admin' },
        rawBody: {
          model: fix.modelFullId,
          chatId: createdChat.id,
          stream: false,
          messages: [{ role: 'user', content: 'Generate huge text' }],
        },
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              choices: [{ index: 0, message: { role: 'assistant', content: hugeText }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 10, completion_tokens: 1000 },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        now: () => clockMs,
        isGuestModelAllowed: () => true,
        isProviderOrAllKeysDraining: () => false,
      });
      assert.equal(pgRes.status, 200);
      await waitForPendingPlaygroundStreamsForTests();
      const detail = getPlaygroundChatDetail(db, masterKey, fix.userId, createdChat.id);
      const assistantMsg = detail.messages.find((m) => m.role === 'assistant');
      assert.ok(assistantMsg, 'Truncated >200k message must still be persisted instead of silently dropped');
      assert.ok(assistantMsg.content.length <= MAX_PLAYGROUND_MESSAGE_CONTENT_LENGTH);
      assert.ok(assistantMsg.content.includes('truncada'));
    } finally {
      db.close();
    }
  });
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createApp } from '../core/src/app.js';
import { generateInternalApiKey, hashPassword, resolveMasterKey } from '../core/src/crypto.js';
import { openDatabase, writeSystemLog } from '../core/src/db.js';
import { utcStartOfDaySec } from '../core/src/metrics/index.js';
import { createOfflineFetch } from './helpers/test-app.js';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-phase5-test-'));
}

function extractCookieHeader(res: Response): string {
  const setCookie = res.headers.get('set-cookie');
  assert.ok(setCookie, 'Expected Set-Cookie header');
  return setCookie.split(';')[0]!;
}

const OPENROUTER_MANIFEST = {
  schemaVersion: '1.0',
  id: 'openrouter',
  name: 'OpenRouter',
  packageType: 'official-json',
  category: 'aggregator',
  verified: true,
  baseUrl: 'https://openrouter.ai/api/v1',
  auth: { type: 'bearer', header: 'Authorization', prefix: 'Bearer ' },
  modelsSource: 'static',
  reviewedAt: '2026-11-01',
  staticModels: [
    {
      id: 'deepseek/deepseek-r1:free',
      name: 'DeepSeek R1 (Free)',
      contextLength: 64000,
    },
  ],
};

const GROQ_MANIFEST = {
  schemaVersion: '1.0',
  id: 'groq',
  name: 'Groq Cloud',
  packageType: 'official-json',
  category: 'official-api',
  verified: true,
  baseUrl: 'https://api.groq.com/openai/v1',
  auth: { type: 'bearer', header: 'Authorization', prefix: 'Bearer ' },
  modelsSource: 'static',
  reviewedAt: '2026-11-01',
  staticModels: [
    {
      id: 'llama-3.3-70b-versatile',
      name: 'Llama 3.3 70B',
      contextLength: 128000,
    },
  ],
};

describe('Phase 5 Backend — Telemetry, UTC Quota, Percentiles, 60d Uptime, Activity & Audit Logs', () => {
  it('HU-17, HU-18, HU-18b, HU-20: routes real /v1/chat/completions traffic (JSON, SSE, resumed, tool_error, structured_error), logs usage_logs, and enforces server-UTC daily quota', async () => {
    const tmpDir = makeTempDir();
    // Anchor clock to 2026-11-18T14:20:00.000Z
    let clockMs = Date.UTC(2026, 10, 18, 14, 20, 0);

    let db: ReturnType<typeof openDatabase> | null = null;
    try {
      const { key: masterKey } = resolveMasterKey({ dataDir: tmpDir, envMasterKey: undefined });
      db = openDatabase(path.join(tmpDir, 'bifrost.db'));

      let upstreamMode:
        | 'ok_json'
        | 'ok_sse'
        | 'drop_then_resume_sse'
        | 'bad_tool_args_json'
        | 'bad_structured_sse'
        | 'upstream_tool_400' = 'ok_json';
      let dropFirstAttempt = false;

      const mockFetch: typeof fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (!url.endsWith('/chat/completions')) {
          return new Response('Not Found', { status: 404 });
        }

        const auth = new Headers(init?.headers).get('authorization') ?? '';

        if (upstreamMode === 'ok_json') {
          clockMs += 120; // deterministic 120ms latency / TTFT
          return new Response(
            JSON.stringify({
              id: 'chatcmpl-p5-1',
              object: 'chat.completion',
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: 'Respuesta exitosa con caché y razonamiento.' },
                  finish_reason: 'stop',
                },
              ],
              usage: {
                prompt_tokens: 400,
                completion_tokens: 60,
                prompt_tokens_details: { cached_tokens: 100 },
                completion_tokens_details: { reasoning_tokens: 40 },
              },
            }),
            {
              status: 200,
              headers: {
                'Content-Type': 'application/json',
                'x-ratelimit-remaining': '950',
                'x-ratelimit-reset': String(Math.floor(clockMs / 1000) + 1800),
              },
            },
          );
        }

        if (upstreamMode === 'ok_sse') {
          const encoder = new TextEncoder();
          const sseStream = new ReadableStream<Uint8Array>({
            start(ctrl) {
              clockMs += 40; // TTFT = 40ms
              ctrl.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    id: 'chatcmpl-sse-1',
                    choices: [{ index: 0, delta: { content: 'Hola mundo ' }, finish_reason: null }],
                  })}\n\n`,
                ),
              );
              clockMs += 60; // total duration = 100ms
              ctrl.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    id: 'chatcmpl-sse-1',
                    choices: [{ index: 0, delta: { content: 'en streaming!' }, finish_reason: 'stop' }],
                    usage: {
                      prompt_tokens: 200,
                      completion_tokens: 50,
                      prompt_tokens_details: { cached_tokens: 50 },
                      completion_tokens_details: { reasoning_tokens: 25 },
                    },
                  })}\n\n`,
                ),
              );
              ctrl.enqueue(encoder.encode('data: [DONE]\n\n'));
              ctrl.close();
            },
          });
          return new Response(sseStream, {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
          });
        }

        if (upstreamMode === 'drop_then_resume_sse') {
          const encoder = new TextEncoder();
          if (dropFirstAttempt && auth.includes('sk-or-v1-keyA')) {
            dropFirstAttempt = false;
            const broken = new ReadableStream<Uint8Array>({
              start(ctrl) {
                clockMs += 30;
                ctrl.enqueue(
                  encoder.encode(
                    `data: ${JSON.stringify({
                      id: 'chatcmpl-drop',
                      choices: [{ index: 0, delta: { content: 'Mitad uno ' }, finish_reason: null }],
                    })}\n\n`,
                  ),
                );
                // Premature close without [DONE] or finish_reason
                ctrl.close();
              },
            });
            return new Response(broken, {
              status: 200,
              headers: { 'Content-Type': 'text/event-stream' },
            });
          }

          const resumed = new ReadableStream<Uint8Array>({
            start(ctrl) {
              clockMs += 50;
              ctrl.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    id: 'chatcmpl-resumed',
                    choices: [{ index: 0, delta: { content: 'mitad dos!' }, finish_reason: 'stop' }],
                    usage: { prompt_tokens: 150, completion_tokens: 30 },
                  })}\n\n`,
                ),
              );
              ctrl.enqueue(encoder.encode('data: [DONE]\n\n'));
              ctrl.close();
            },
          });
          return new Response(resumed, {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
          });
        }

        if (upstreamMode === 'bad_tool_args_json') {
          clockMs += 80;
          return new Response(
            JSON.stringify({
              id: 'chatcmpl-bad-tool',
              choices: [
                {
                  index: 0,
                  message: {
                    role: 'assistant',
                    content: null,
                    tool_calls: [
                      {
                        id: 'call_1',
                        type: 'function',
                        function: {
                          name: 'get_weather',
                          arguments: '{broken_json_arguments',
                        },
                      },
                    ],
                  },
                  finish_reason: 'tool_calls',
                },
              ],
              usage: { prompt_tokens: 100, completion_tokens: 20 },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }

        if (upstreamMode === 'upstream_tool_400') {
          clockMs += 45;
          return new Response(
            JSON.stringify({ error: { message: 'Tool schema unsupported by upstream' } }),
            { status: 400, headers: { 'Content-Type': 'application/json' } },
          );
        }

        // bad_structured_sse: returns non-JSON text when response_format: json_object was requested
        const encoder = new TextEncoder();
        const badStructStream = new ReadableStream<Uint8Array>({
          start(ctrl) {
            clockMs += 60;
            ctrl.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  id: 'chatcmpl-bad-struct',
                  choices: [
                    {
                      index: 0,
                      delta: { content: 'Sure! Here is plain text instead of valid JSON.' },
                      finish_reason: 'stop',
                    },
                  ],
                  usage: { prompt_tokens: 100, completion_tokens: 15 },
                })}\n\n`,
              ),
            );
            ctrl.enqueue(encoder.encode('data: [DONE]\n\n'));
            ctrl.close();
          },
        });
        return new Response(badStructStream, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      };

      const app = createApp({
        db,
        masterKey,
        fetchImpl: createOfflineFetch(mockFetch),
        now: () => clockMs,
      });

      // Setup admin
      const setupRes = await app.request('http://localhost/api/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'adminpassword123' }),
      });
      assert.equal(setupRes.status, 201);
      const adminCookie = extractCookieHeader(setupRes);

      // Install OpenRouter + 2 keys + detect models
      const addProvRes = await app.request('http://localhost/api/providers', {
        method: 'POST',
        headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ manifest: OPENROUTER_MANIFEST }),
      });
      assert.equal(addProvRes.status, 201);

      for (const [label, secret] of [
        ['Key A', 'sk-or-v1-keyA-secret-1111'],
        ['Key B', 'sk-or-v1-keyB-secret-2222'],
      ]) {
        const kr = await app.request('http://localhost/api/providers/openrouter/keys', {
          method: 'POST',
          headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({ label, secret, dailyQuotaLimit: 100_000 }),
        });
        assert.equal(kr.status, 201);
      }

      const detectRes = await app.request('http://localhost/api/providers/openrouter/detect-models', {
        method: 'POST',
        headers: { Cookie: adminCookie },
      });
      assert.equal(detectRes.status, 200);

      // Create internal sk-bf-... key for admin
      const keyCreateRes = await app.request('http://localhost/api/keys', {
        method: 'POST',
        headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Cursor Admin' }),
      });
      const adminApiKey = ((await keyCreateRes.json()) as { rawKey: string }).rawKey;

      // 1) Non-streaming JSON call -> records ok usage_log with prompt/completion/reasoning/cached/ttft/tps
      upstreamMode = 'ok_json';
      const r1 = await app.request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${adminApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'openrouter/deepseek/deepseek-r1:free',
          messages: [{ role: 'user', content: 'Hola!' }],
        }),
      });
      assert.equal(r1.status, 200);

      // 2) Streaming SSE call -> records ok usage_log on stream finish
      upstreamMode = 'ok_sse';
      const r2 = await app.request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${adminApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'openrouter/deepseek/deepseek-r1:free',
          stream: true,
          messages: [{ role: 'user', content: 'Stream please' }],
        }),
      });
      assert.equal(r2.status, 200);
      const sseText2 = await r2.text();
      assert.ok(sseText2.includes('Hola mundo '));
      assert.ok(sseText2.includes('en streaming!'));

      // 3) Mid-stream drop -> resumed with Key B -> records status='resumed' in usage_logs
      upstreamMode = 'drop_then_resume_sse';
      dropFirstAttempt = true;
      const r3 = await app.request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${adminApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'openrouter/deepseek/deepseek-r1:free',
          stream: true,
          messages: [{ role: 'user', content: 'Resume test' }],
        }),
      });
      assert.equal(r3.status, 200);
      const sseText3 = await r3.text();
      assert.ok(sseText3.includes('Mitad uno '));
      assert.ok(sseText3.includes('mitad dos!'));

      // Re-activate Key A so subsequent tests have healthy keys
      db.prepare(`UPDATE provider_keys SET status = 'active', last_error = NULL`).run();

      // 4) Malformed tool call JSON arguments -> classified as status='error', error_type='tool_error'
      upstreamMode = 'bad_tool_args_json';
      const r4 = await app.request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${adminApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'openrouter/deepseek/deepseek-r1:free',
          messages: [{ role: 'user', content: 'Weather in Madrid?' }],
          tools: [
            {
              type: 'function',
              function: { name: 'get_weather', parameters: { type: 'object' } },
            },
          ],
        }),
      });
      assert.equal(r4.status, 200);

      // 5) Upstream HTTP 400 when using tools -> also recorded in usage_logs with error_type='tool_error'
      upstreamMode = 'upstream_tool_400';
      const r5 = await app.request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${adminApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'openrouter/deepseek/deepseek-r1:free',
          messages: [{ role: 'user', content: 'Run tool' }],
          tools: [{ type: 'function', function: { name: 'calc', parameters: {} } }],
        }),
      });
      assert.equal(r5.status, 400);

      // 6) Streaming SSE with response_format: json_object returning plain text -> error_type='structured_error'
      upstreamMode = 'bad_structured_sse';
      const r6 = await app.request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${adminApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'openrouter/deepseek/deepseek-r1:free',
          stream: true,
          response_format: { type: 'json_object' },
          messages: [{ role: 'user', content: 'Return JSON object' }],
        }),
      });
      assert.equal(r6.status, 200);
      await r6.text();

      // Verify usage_logs rows in SQLite
      const logs = db
        .prepare(
          `SELECT prompt_tokens, completion_tokens, reasoning_tokens, cached_tokens,
                  ttft_ms, duration_ms, tokens_per_sec, status, error_type
           FROM usage_logs ORDER BY id ASC`,
        )
        .all() as Array<Record<string, unknown>>;

      assert.equal(logs.length, 6);
      assert.equal(logs[0]!.status, 'ok');
      assert.equal(logs[0]!.prompt_tokens, 400);
      assert.equal(logs[0]!.completion_tokens, 60);
      assert.equal(logs[0]!.reasoning_tokens, 40);
      assert.equal(logs[0]!.cached_tokens, 100);
      assert.ok(Number(logs[0]!.ttft_ms) > 0);
      assert.ok(Number(logs[0]!.tokens_per_sec) > 0);

      assert.equal(logs[1]!.status, 'ok');
      assert.equal(logs[2]!.status, 'resumed');
      assert.equal(logs[3]!.status, 'error');
      assert.equal(logs[3]!.error_type, 'tool_error');
      assert.equal(logs[4]!.status, 'error');
      assert.equal(logs[4]!.error_type, 'tool_error');
      assert.equal(logs[5]!.status, 'error');
      assert.equal(logs[5]!.error_type, 'structured_error');

      // 7) Create guest user with 500 daily token limit (utc_midnight) and verify UTC quota enforcement
      const guestHash = await hashPassword('guestpass123');
      const nowSec = Math.floor(clockMs / 1000);
      db.prepare(
        `INSERT INTO users (id, username, password_hash, role, daily_token_limit, quota_reset_mode, created_at)
         VALUES ('guest-utc', 'invitado_utc', ?, 'guest', 500, 'utc_midnight', ?)`,
      ).run(guestHash, nowSec);
      db.prepare(
        `INSERT INTO user_model_access (user_id, model_full_id)
         VALUES ('guest-utc', 'openrouter/deepseek/deepseek-r1:free')`,
      ).run();
      const guestKeyGen = generateInternalApiKey();
      db.prepare(
        `INSERT INTO internal_api_keys (id, user_id, name, key_prefix, key_hash, created_at)
         VALUES ('ik-guest', 'guest-utc', 'Guest Key', ?, ?, ?)`,
      ).run(guestKeyGen.keyPrefix, guestKeyGen.keyHash, nowSec);

      // First guest request uses 400+60+40 = 500 tokens -> reaches 500/500 limit!
      upstreamMode = 'ok_json';
      const gOk = await app.request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${guestKeyGen.rawKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'openrouter/deepseek/deepseek-r1:free',
          messages: [{ role: 'user', content: 'First guest call' }],
        }),
      });
      assert.equal(gOk.status, 200);

      // Second guest request attempts to spoof client Date / X-Timezone headers to next week -> STILL blocked 429!
      const gBlockedReal = await app.request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${guestKeyGen.rawKey}`,
          Date: 'Wed, 25 Nov 2026 12:00:00 GMT',
          'X-Timezone': 'Pacific/Kiritimati',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'openrouter/deepseek/deepseek-r1:free',
          messages: [{ role: 'user', content: 'Bypass attempt with real token' }],
        }),
      });
      assert.equal(gBlockedReal.status, 429);
      assert.ok(Number(gBlockedReal.headers.get('retry-after')) > 0);
      const blockedBody = (await gBlockedReal.json()) as {
        error: { code: string; type: string; reset_at: string };
      };
      assert.equal(blockedBody.error.code, 'daily_quota_exceeded');
      assert.equal(blockedBody.error.type, 'quota_exceeded');
      assert.equal(blockedBody.error.reset_at, '2026-11-19T00:00:00.000Z');

      // Advance server UTC clock past 00:00 UTC -> guest quota automatically resets!
      clockMs = Date.UTC(2026, 10, 19, 0, 0, 5);
      const gAfterMidnight = await app.request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${guestKeyGen.rawKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'openrouter/deepseek/deepseek-r1:free',
          messages: [{ role: 'user', content: 'New UTC day!' }],
        }),
      });
      assert.equal(gAfterMidnight.status, 200);

      // Verify GET /api/metrics/summary for admin
      const summaryRes = await app.request('http://localhost/api/metrics/summary', {
        headers: { Cookie: adminCookie },
      });
      assert.equal(summaryRes.status, 200);
      const summaryBody = (await summaryRes.json()) as {
        totalDailyLimit: number;
        usedTokensToday: number;
        quotaPercentageRemaining: number;
        providersCount: number;
        activeModelsCount: number;
        quotaToday: { nextResetAt: string };
      };
      assert.equal(summaryBody.totalDailyLimit, 200_000);
      assert.equal(summaryBody.usedTokensToday, 500); // Only 2026-11-19 UTC usage!
      assert.equal(summaryBody.providersCount, 1);
      assert.equal(summaryBody.activeModelsCount, 1);
      assert.equal(summaryBody.quotaToday.nextResetAt, '2026-11-20T00:00:00.000Z');
    } finally {
      db?.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('HU-18, HU-18b, HU-19, HU-20, HU-20b, HU-20c: verifies exact percentiles, null uptime on 0-traffic days, guest activity scoping, and 403 + secret scrubbing on /api/logs', async () => {
    const tmpDir = makeTempDir();
    const fixedNowMs = Date.UTC(2026, 10, 18, 15, 30, 0);
    const fixedNowSec = Math.floor(fixedNowMs / 1000);
    const todayStartSec = utcStartOfDaySec(fixedNowSec);

    let db: ReturnType<typeof openDatabase> | null = null;
    try {
      const { key: masterKey } = resolveMasterKey({ dataDir: tmpDir, envMasterKey: undefined });
      db = openDatabase(path.join(tmpDir, 'bifrost.db'));

      const app = createApp({
        db,
        masterKey,
        fetchImpl: createOfflineFetch(),
        now: () => fixedNowMs,
      });

      // Setup admin
      const setupRes = await app.request('http://localhost/api/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'adminpassword123' }),
      });
      assert.equal(setupRes.status, 201);
      const adminCookie = extractCookieHeader(setupRes);
      const adminId = ((await setupRes.json()) as { user: { id: string } }).user.id;

      // Create guest user and login to get session cookie
      const guestPassHash = await hashPassword('guestpassword123');
      db.prepare(
        `INSERT INTO users (id, username, password_hash, role, daily_token_limit, quota_reset_mode, created_at)
         VALUES ('guest-1', 'sofia', ?, 'guest', 25000, 'rolling_24h', ?)`,
      ).run(guestPassHash, todayStartSec);
      db.prepare(
        `INSERT INTO user_model_access (user_id, model_full_id)
         VALUES ('guest-1', 'openrouter/deepseek/deepseek-r1:free')`,
      ).run();

      const guestLoginRes = await app.request('http://localhost/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'sofia', password: 'guestpassword123' }),
      });
      assert.equal(guestLoginRes.status, 200);
      const guestCookie = extractCookieHeader(guestLoginRes);

      // Register OpenRouter + Groq (Groq will have 0 traffic to test null uptime & null percentiles)
      for (const manifest of [OPENROUTER_MANIFEST, GROQ_MANIFEST]) {
        const pr = await app.request('http://localhost/api/providers', {
          method: 'POST',
          headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({ manifest }),
        });
        assert.equal(pr.status, 201);
        await app.request(`http://localhost/api/providers/${manifest.id}/detect-models`, {
          method: 'POST',
          headers: { Cookie: adminCookie },
        });
      }

      db.prepare(
        `INSERT OR REPLACE INTO models (
           full_id, provider_id, model_id, name, modalities_json, capabilities_json, is_free, active, first_seen_at
         ) VALUES
           ('openrouter/deepseek/deepseek-r1:free', 'openrouter', 'deepseek/deepseek-r1:free', 'DeepSeek R1 Free', '["text"]', '["reasoning"]', 1, 1, ?),
           ('groq/llama-3.3-70b-versatile', 'groq', 'llama-3.3-70b-versatile', 'Llama 3.3 70B', '["text"]', '["tools"]', 1, 1, ?)`,
      ).run(todayStartSec, todayStartSec);

      // Insert 101 exact samples at 14:10 UTC today on openrouter/deepseek/deepseek-r1:free:
      // duration_ms = 100..200 -> P50=150, P75=175, P90=190, P95=195, P99=199
      // ttft_ms = 10..110 -> P50=60, P75=85, P90=100, P95=105, P99=109
      // tokens_per_sec = 20..120 -> P50=70, P75=95, P90=110, P95=115, P99=119
      // prompt_tokens = 100, cached_tokens = 40 (40% cache hit rate)
      const insertUsage = db.prepare(
        `INSERT INTO usage_logs (
           user_id, provider_id, model_full_id,
           prompt_tokens, completion_tokens, reasoning_tokens, cached_tokens,
           ttft_ms, duration_ms, tokens_per_sec, status, error_type, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );

      const hour14Ts = todayStartSec + 14 * 3600 + 600;
      for (let i = 0; i <= 100; i++) {
        const uid = i === 0 ? 'guest-1' : adminId;
        insertUsage.run(
          uid,
          'openrouter',
          'openrouter/deepseek/deepseek-r1:free',
          100,
          50,
          10,
          40,
          10 + i,
          100 + i,
          20 + i,
          'ok',
          null,
          hour14Ts,
        );
      }

      // Populate historical days on OpenRouter for 60d uptime + 7d error rates:
      // Day -2: 96 ok + 2 tool_error + 2 structured_error = 96/100 (96% -> 'partial')
      const dayMinus2 = todayStartSec - 2 * 86400 + 1200;
      for (let i = 0; i < 96; i++) {
        insertUsage.run(adminId, 'openrouter', 'openrouter/deepseek/deepseek-r1:free', 10, 10, 0, 0, 20, 100, 50, 'ok', null, dayMinus2);
      }
      for (let i = 0; i < 2; i++) {
        insertUsage.run(adminId, 'openrouter', 'openrouter/deepseek/deepseek-r1:free', 10, 0, 0, 0, null, 100, null, 'error', 'tool_error', dayMinus2);
      }
      for (let i = 0; i < 2; i++) {
        insertUsage.run(adminId, 'openrouter', 'openrouter/deepseek/deepseek-r1:free', 10, 0, 0, 0, null, 100, null, 'error', 'structured_error', dayMinus2);
      }

      // Day -1: 90 ok + 10 upstream error = 90/100 (90% -> 'error')
      const dayMinus1 = todayStartSec - 1 * 86400 + 1200;
      for (let i = 0; i < 90; i++) {
        insertUsage.run(adminId, 'openrouter', 'openrouter/deepseek/deepseek-r1:free', 10, 10, 0, 0, 20, 100, 50, 'ok', null, dayMinus1);
      }
      for (let i = 0; i < 10; i++) {
        insertUsage.run(adminId, 'openrouter', 'openrouter/deepseek/deepseek-r1:free', 10, 0, 0, 0, null, 100, null, 'error', 'upstream', dayMinus1);
      }

      // 1) GET /api/metrics/latency?range=today
      const latRes = await app.request('http://localhost/api/metrics/latency?range=today', {
        headers: { Cookie: adminCookie },
      });
      assert.equal(latRes.status, 200);
      const latBody = (await latRes.json()) as {
        overall: { p50: number; p75: number; p90: number; p95: number; p99: number };
        buckets: Array<{ sampleCount: number; p50: number | null; p99: number | null }>;
      };
      assert.equal(latBody.overall.p50, 150);
      assert.equal(latBody.overall.p75, 175);
      assert.equal(latBody.overall.p90, 190);
      assert.equal(latBody.overall.p95, 195);
      assert.equal(latBody.overall.p99, 199);
      // Empty hour 00:00 UTC bucket MUST preserve null (never 0)
      assert.equal(latBody.buckets[0]!.sampleCount, 0);
      assert.equal(latBody.buckets[0]!.p50, null);
      assert.equal(latBody.buckets[0]!.p99, null);

      // 2) GET /api/metrics/speed?range=today
      const speedRes = await app.request('http://localhost/api/metrics/speed?range=today', {
        headers: { Cookie: adminCookie },
      });
      assert.equal(speedRes.status, 200);
      const speedBody = (await speedRes.json()) as {
        models: Array<{
          modelFullId: string;
          ttftMs: { p50: number | null; p95: number | null };
          tokensPerSec: { p50: number | null; p99: number | null };
        }>;
        cacheByProvider: Array<{ providerId: string; cacheHitRate: number | null }>;
      };
      const orModelSpeed = speedBody.models.find(
        (m) => m.modelFullId === 'openrouter/deepseek/deepseek-r1:free',
      );
      const groqModelSpeed = speedBody.models.find(
        (m) => m.modelFullId === 'groq/llama-3.3-70b-versatile',
      );
      assert.equal(orModelSpeed?.ttftMs.p50, 60);
      assert.equal(orModelSpeed?.ttftMs.p95, 105);
      assert.equal(orModelSpeed?.tokensPerSec.p50, 70);
      assert.equal(orModelSpeed?.tokensPerSec.p99, 119);
      assert.equal(groqModelSpeed, undefined);

      const orCache = speedBody.cacheByProvider.find((p) => p.providerId === 'openrouter');
      const groqCache = speedBody.cacheByProvider.find((p) => p.providerId === 'groq');
      assert.equal(orCache?.cacheHitRate, 40);
      assert.equal(groqCache?.cacheHitRate, null);

      // 3) GET /api/metrics/uptime -> 60 days + null on 0-traffic days (NEVER 0%) + 7d error rates
      const upRes = await app.request('http://localhost/api/metrics/uptime', {
        headers: { Cookie: adminCookie },
      });
      assert.equal(upRes.status, 200);
      const upBody = (await upRes.json()) as {
        windowDays: number;
        providers: Array<{
          providerId: string;
          overallUptimePct: number | null;
          overallState: string;
          toolErrorRate: number | null;
          structuredErrorRate: number | null;
          days: Array<{ totalRequests: number; uptimePct: number | null; state: string }>;
        }>;
      };
      assert.equal(upBody.windowDays, 60);

      const orUptime = upBody.providers.find((p) => p.providerId === 'openrouter')!;
      const groqUptime = upBody.providers.find((p) => p.providerId === 'groq')!;
      assert.equal(orUptime.days.length, 60);
      // Days without traffic (e.g. index 0..56) MUST have uptimePct === null and state === 'no_data'
      assert.equal(orUptime.days[0]!.totalRequests, 0);
      assert.equal(orUptime.days[0]!.uptimePct, null);
      assert.equal(orUptime.days[0]!.state, 'no_data');
      // Day -2 (index 57): 96% -> 'partial'
      assert.equal(orUptime.days[57]!.uptimePct, 96);
      assert.equal(orUptime.days[57]!.state, 'partial');
      // Day -1 (index 58): 90% -> 'error'
      assert.equal(orUptime.days[58]!.uptimePct, 90);
      assert.equal(orUptime.days[58]!.state, 'error');
      // Today (index 59): 101/101 = 100% -> 'ok'
      assert.equal(orUptime.days[59]!.uptimePct, 100);
      assert.equal(orUptime.days[59]!.state, 'ok');
      // 7d error rates: 301 requests total, 2 tool_error (0.66%), 2 structured_error (0.66%)
      assert.equal(orUptime.toolErrorRate, 0.66);
      assert.equal(orUptime.structuredErrorRate, 0.66);

      // Groq has 0 requests across all 60 days -> overallUptimePct === null (NEVER 0!)
      assert.equal(groqUptime.overallUptimePct, null);
      assert.equal(groqUptime.overallState, 'no_data');
      assert.ok(groqUptime.days.every((d) => d.uptimePct === null));

      // 4) GET /api/metrics/activity: guest sees ONLY their own 1 request (160 tokens), admin sees all!
      const guestActRes = await app.request(
        'http://localhost/api/metrics/activity?range=today&groupBy=user',
        { headers: { Cookie: guestCookie } },
      );
      assert.equal(guestActRes.status, 200);
      const guestAct = (await guestActRes.json()) as {
        totals: { promptTokens: number; completionTokens: number; reasoningTokens: number; totalTokens: number };
        items: Array<{ id: string; label: string; totalTokens: number }>;
      };
      assert.equal(guestAct.totals.promptTokens, 100);
      assert.equal(guestAct.totals.completionTokens, 50);
      assert.equal(guestAct.totals.reasoningTokens, 10);
      assert.equal(guestAct.totals.totalTokens, 160);
      assert.equal(guestAct.items.length, 1);
      assert.equal(guestAct.items[0]!.label, 'sofia');

      const adminActRes = await app.request(
        'http://localhost/api/metrics/activity?range=today&groupBy=user',
        { headers: { Cookie: adminCookie } },
      );
      assert.equal(adminActRes.status, 200);
      const adminAct = (await adminActRes.json()) as {
        totals: { totalTokens: number };
        items: Array<{ label: string }>;
      };
      assert.equal(adminAct.totals.totalTokens, 101 * 160);
      assert.equal(adminAct.items.length, 2);

      // 5) GET /api/logs: 403 for guest, 200 with secret redaction for admin
      const guestLogsRes = await app.request('http://localhost/api/logs', {
        headers: { Cookie: guestCookie },
      });
      assert.equal(guestLogsRes.status, 403);

      // Insert raw unredacted secrets directly into SQLite to test defense-in-depth scrubbing on read
      writeSystemLog(
        db,
        'error',
        'failover',
        'Upstream failed for Bearer sk-or-v1-ultraSecret99999999 and internal sk-bf-leaktest1234567890',
        { apiKey: 'nvapi-supersecretkey987654321', providerId: 'openrouter' },
        fixedNowSec,
      );
      db.prepare(
        `INSERT INTO system_logs (level, category, message, meta_json, created_at)
         VALUES ('warn', 'node', 'Raw unredacted bfnode_rawSecretToken123456 and Bearer gsk_rawGroqSecret123456789', '{"secret":"sk-proj-rawSecretValue123456","nodeId":"n1"}', ?)`,
      ).run(fixedNowSec);

      const adminLogsRes = await app.request(
        'http://localhost/api/logs?level=warn&category=node&q=n1&limit=10&offset=0',
        { headers: { Cookie: adminCookie } },
      );
      assert.equal(adminLogsRes.status, 200);
      const adminLogsText = await adminLogsRes.text();
      assert.ok(!adminLogsText.includes('bfnode_rawSecretToken123456'));
      assert.ok(!adminLogsText.includes('gsk_rawGroqSecret123456789'));
      assert.ok(!adminLogsText.includes('sk-proj-rawSecretValue123456'));
      const adminLogsJson = JSON.parse(adminLogsText) as {
        total: number;
        items: Array<{ level: string; category: string; meta: Record<string, unknown> }>;
      };
      assert.equal(adminLogsJson.total, 1);
      assert.equal(adminLogsJson.items[0]!.meta.secret, '[REDACTED]');

      const failoverLogsRes = await app.request(
        'http://localhost/api/logs?category=failover',
        { headers: { Cookie: adminCookie } },
      );
      const failoverLogsText = await failoverLogsRes.text();
      assert.ok(!failoverLogsText.includes('sk-or-v1-ultraSecret99999999'));
      assert.ok(!failoverLogsText.includes('sk-bf-leaktest1234567890'));
      assert.ok(!failoverLogsText.includes('nvapi-supersecretkey987654321'));
    } finally {
      db?.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

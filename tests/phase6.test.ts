import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createApp } from '../core/src/app.js';
import { hashPassword, resolveMasterKey } from '../core/src/crypto.js';
import { openDatabase } from '../core/src/db.js';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-phase6-test-'));
}

function extractCookieHeader(res: Response): string {
  const raw = res.headers.get('set-cookie');
  assert.ok(raw, 'Expected Set-Cookie header');
  return raw.split(';')[0]!;
}

const OPENROUTER_REASONING_MANIFEST = {
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
      name: 'DeepSeek R1 Free',
      contextLength: 163840,
    },
    {
      id: 'meta-llama/llama-3.3-70b-instruct:free',
      name: 'Llama 3.3 70B Free',
      contextLength: 131072,
    },
  ],
};

describe('Phase 6 Backend — Integrated Playground Chat, SSE Failover, Reasoning Effort & Telemetry', () => {
  it('HU-21 & HU-22: authenticates via session cookie, validates reasoning_effort, streams SSE with failover + metrics summary, and returns JSON with ttftMs, tokensPerSec, and reasoningTokens', async () => {
    const tmpDir = makeTempDir();
    let clockMs = Date.UTC(2026, 10, 18, 16, 0, 0);

    try {
      const { key: masterKey } = resolveMasterKey({ dataDir: tmpDir, envMasterKey: undefined });
      const db = openDatabase(path.join(tmpDir, 'bifrost.db'));

      const capturedBodies: Array<Record<string, unknown>> = [];
      let dropFirstStream = false;

      const mockFetch: typeof fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (!url.endsWith('/chat/completions')) {
          return new Response('Not Found', { status: 404 });
        }

        const auth = new Headers(init?.headers).get('authorization') ?? '';
        const reqBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        capturedBodies.push(reqBody);

        if (reqBody.stream !== true) {
          clockMs += 200; // 200ms TTFT / duration
          return new Response(
            JSON.stringify({
              id: 'chatcmpl-pg-json-1',
              object: 'chat.completion',
              created: Math.floor(clockMs / 1000),
              model: reqBody.model,
              choices: [
                {
                  index: 0,
                  message: {
                    role: 'assistant',
                    reasoning_content: 'Paso 1: analizar el problema.',
                    content: 'La respuesta es 42.',
                  },
                  finish_reason: 'stop',
                },
              ],
              usage: {
                prompt_tokens: 150,
                completion_tokens: 30,
                total_tokens: 250,
                completion_tokens_details: { reasoning_tokens: 70 },
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }

        // Streaming SSE mode (with optional mid-stream drop on first key)
        if (dropFirstStream && auth.includes('sk-or-key-1')) {
          dropFirstStream = false;
          const encoder = new TextEncoder();
          let sentChunk = false;
          const failStream = new ReadableStream<Uint8Array>({
            pull(controller) {
              if (!sentChunk) {
                sentChunk = true;
                clockMs += 40;
                controller.enqueue(
                  encoder.encode(
                    `data: ${JSON.stringify({
                      id: 'chatcmpl-pg-drop',
                      choices: [{ index: 0, delta: { content: 'Inicio parcial... ' } }],
                    })}\n\n`,
                  ),
                );
                return;
              }
              controller.error(new Error('Upstream socket reset mid-stream'));
            },
          });
          return new Response(failStream, {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
          });
        }

        const encoder = new TextEncoder();
        const sseStream = new ReadableStream<Uint8Array>({
          start(controller) {
            clockMs += 50;
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  id: 'chatcmpl-pg-sse',
                  choices: [
                    {
                      index: 0,
                      delta: {
                        reasoning_content: 'Razonando paso a paso...',
                      },
                    },
                  ],
                })}\n\n`,
              ),
            );
            clockMs += 150;
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  id: 'chatcmpl-pg-sse',
                  choices: [
                    {
                      index: 0,
                      delta: { content: 'Conclusión verificada.' },
                      finish_reason: 'stop',
                    },
                  ],
                  usage: {
                    prompt_tokens: 200,
                    completion_tokens: 40,
                    completion_tokens_details: { reasoning_tokens: 60 },
                  },
                })}\n\n`,
              ),
            );
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          },
        });

        return new Response(sseStream, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      };

      const app = createApp({
        db,
        masterKey,
        fetchImpl: mockFetch,
        now: () => clockMs,
      });

      // 1) Unauthenticated request -> 401
      const unauthRes = await app.request('http://localhost/api/playground/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'openrouter/deepseek/deepseek-r1:free',
          messages: [{ role: 'user', content: 'Hola' }],
        }),
      });
      assert.equal(unauthRes.status, 401);

      // Setup admin + OpenRouter + 2 keys + detect static models
      const setupRes = await app.request('http://localhost/api/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'adminpassword123' }),
      });
      assert.equal(setupRes.status, 201);
      const adminCookie = extractCookieHeader(setupRes);

      const provRes = await app.request('http://localhost/api/providers', {
        method: 'POST',
        headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ manifest: OPENROUTER_REASONING_MANIFEST }),
      });
      assert.equal(provRes.status, 201);

      for (const [label, secret] of [
        ['OR 1', 'sk-or-key-1111'],
        ['OR 2', 'sk-or-key-2222'],
      ]) {
        const kr = await app.request('http://localhost/api/providers/openrouter/keys', {
          method: 'POST',
          headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({ label, secret }),
        });
        assert.equal(kr.status, 201);
      }

      const detectRes = await app.request('http://localhost/api/providers/openrouter/detect-models', {
        method: 'POST',
        headers: { Cookie: adminCookie },
      });
      assert.equal(detectRes.status, 200);

      // 2) Invalid reasoning_effort -> 400
      const badEffortRes = await app.request('http://localhost/api/playground/chat', {
        method: 'POST',
        headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'openrouter/deepseek/deepseek-r1:free',
          reasoning_effort: 'extreme',
          messages: [{ role: 'user', content: 'Hola' }],
        }),
      });
      assert.equal(badEffortRes.status, 400);

      // 3) Non-streaming JSON with reasoningEffort='high' + systemPrompt
      const jsonRes = await app.request('http://localhost/api/playground/chat', {
        method: 'POST',
        headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'openrouter/deepseek/deepseek-r1:free',
          systemPrompt: 'Responde siempre en español.',
          reasoningEffort: 'high',
          temperature: 0.3,
          maxTokens: 512,
          messages: [{ role: 'user', content: '¿Cuál es el sentido de la vida?' }],
        }),
      });
      assert.equal(jsonRes.status, 200);
      const jsonBody = (await jsonRes.json()) as {
        content: string;
        reasoningContent: string;
        reasoningEffort: string;
        ttftMs: number;
        tokensPerSec: number;
        usage: {
          promptTokens: number;
          completionTokens: number;
          reasoningTokens: number;
          totalTokens: number;
        };
      };

      assert.equal(jsonBody.content, 'La respuesta es 42.');
      assert.equal(jsonBody.reasoningContent, 'Paso 1: analizar el problema.');
      assert.equal(jsonBody.reasoningEffort, 'high');
      assert.equal(jsonBody.ttftMs, 200);
      // 30 completion tokens in 200ms = 150 tok/s
      assert.equal(jsonBody.tokensPerSec, 150);
      assert.equal(jsonBody.usage.promptTokens, 150);
      assert.equal(jsonBody.usage.completionTokens, 30);
      assert.equal(jsonBody.usage.reasoningTokens, 70);
      assert.equal(jsonBody.usage.totalTokens, 250);

      // Verify upstream received reasoning_effort='high' and prepended systemPrompt
      assert.equal(capturedBodies[0]!.reasoning_effort, 'high');
      assert.equal(capturedBodies[0]!.max_tokens, 512);
      const sentMsgs = capturedBodies[0]!.messages as Array<{ role: string; content: string }>;
      assert.equal(sentMsgs[0]!.role, 'system');
      assert.equal(sentMsgs[0]!.content, 'Responde siempre en español.');

      // 4) Non-streaming JSON with reasoning_effort='none' omits reasoning_effort upstream
      const noneEffortRes = await app.request('http://localhost/api/playground/chat', {
        method: 'POST',
        headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'openrouter/deepseek/deepseek-r1:free',
          reasoning_effort: 'none',
          messages: [{ role: 'user', content: 'Test none' }],
        }),
      });
      assert.equal(noneEffortRes.status, 200);
      assert.equal('reasoning_effort' in capturedBodies[1]!, false);

      // 5) Streaming SSE with mid-stream failover recovery + final bifrost.playground.metrics frame
      dropFirstStream = true;
      const sseRes = await app.request('http://localhost/api/playground/chat', {
        method: 'POST',
        headers: {
          Cookie: adminCookie,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          model: 'openrouter/deepseek/deepseek-r1:free',
          reasoning_effort: 'medium',
          messages: [{ role: 'user', content: 'Demuestra el teorema' }],
        }),
      });
      assert.equal(sseRes.status, 200);
      assert.ok((sseRes.headers.get('content-type') ?? '').includes('text/event-stream'));

      const sseText = await sseRes.text();
      assert.ok(sseText.includes('Inicio parcial... '));
      assert.ok(sseText.includes('Conclusión verificada.'));
      assert.ok(sseText.includes('data: [DONE]'));

      const frames = sseText
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.startsWith('data:') && l !== 'data: [DONE]')
        .map((l) => JSON.parse(l.slice(5).trim()) as Record<string, unknown>);

      const metricsFrame = frames.find((f) => f.object === 'bifrost.playground.metrics')!;
      assert.ok(metricsFrame, 'Expected bifrost.playground.metrics SSE summary frame');
      assert.ok(Number(metricsFrame.ttftMs) > 0);
      assert.ok(Number(metricsFrame.tokensPerSec) > 0);
      const mUsage = metricsFrame.usage as Record<string, number>;
      assert.equal(mUsage.promptTokens, 200);
      assert.equal(mUsage.completionTokens, 40);
      assert.equal(mUsage.reasoningTokens, 60);

      // Verify exact usage_logs recorded by executeChatCompletions (no duplicates: 3 calls -> 3 rows)
      const usageRows = db
        .prepare(`SELECT status, prompt_tokens, completion_tokens, reasoning_tokens FROM usage_logs ORDER BY id ASC`)
        .all() as Array<Record<string, unknown>>;
      assert.equal(usageRows.length, 3);
      assert.equal(usageRows[0]!.status, 'ok');
      assert.equal(usageRows[1]!.status, 'ok');
      assert.equal(usageRows[2]!.status, 'resumed');
      assert.equal(usageRows[2]!.reasoning_tokens, 60);

      // 6) Guest model whitelist (403 on unauthorized model) + UTC daily quota deduction (429 when exhausted)
      const guestHash = await hashPassword('guestpass123');
      const nowSec = Math.floor(clockMs / 1000);
      db.prepare(
        `INSERT INTO users (id, username, password_hash, role, daily_token_limit, quota_reset_mode, created_at)
         VALUES ('guest-pg', 'invitado_pg', ?, 'guest', 250, 'utc_midnight', ?)`,
      ).run(guestHash, nowSec);
      db.prepare(
        `INSERT INTO user_model_access (user_id, model_full_id)
         VALUES ('guest-pg', 'openrouter/deepseek/deepseek-r1:free')`,
      ).run();

      const guestLogin = await app.request('http://localhost/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'invitado_pg', password: 'guestpass123' }),
      });
      assert.equal(guestLogin.status, 200);
      const guestCookie = extractCookieHeader(guestLogin);

      // Guest attempts unauthorized model -> 403
      const forbiddenRes = await app.request('http://localhost/api/playground/chat', {
        method: 'POST',
        headers: { Cookie: guestCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'openrouter/meta-llama/llama-3.3-70b-instruct:free',
          messages: [{ role: 'user', content: 'No autorizado' }],
        }),
      });
      assert.equal(forbiddenRes.status, 403);

      // Guest uses authorized model -> 200 (uses 150+30+70 = 250 tokens -> hits 250 daily limit)
      const guestOkRes = await app.request('http://localhost/api/playground/chat', {
        method: 'POST',
        headers: { Cookie: guestCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'openrouter/deepseek/deepseek-r1:free',
          messages: [{ role: 'user', content: 'Autorizado' }],
        }),
      });
      assert.equal(guestOkRes.status, 200);

      // Next guest Playground request -> 429 daily_quota_exceeded with clean string error
      const guestQuotaRes = await app.request('http://localhost/api/playground/chat', {
        method: 'POST',
        headers: { Cookie: guestCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'openrouter/deepseek/deepseek-r1:free',
          messages: [{ role: 'user', content: 'Sin cuota' }],
        }),
      });
      assert.equal(guestQuotaRes.status, 429);
      const guestQuotaBody = (await guestQuotaRes.json()) as { error: string; code: string };
      assert.equal(typeof guestQuotaBody.error, 'string');
      assert.equal(guestQuotaBody.code, 'daily_quota_exceeded');

      db.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('Red-Team Hardening: never reflects raw HTML upstream errors, fails closed when exit node lacks credentials, scrubs query/provider secrets, and restricts ?refresh=1 to admin', async () => {
    const tmpDir = makeTempDir();
    const clockMs = Date.UTC(2026, 10, 18, 17, 0, 0);

    try {
      const { key: masterKey } = resolveMasterKey({ dataDir: tmpDir, envMasterKey: undefined });
      const db = openDatabase(path.join(tmpDir, 'bifrost.db'));

      let directUpstreamFetchCalls = 0;
      let logoUpstreamCalls = 0;

      const mockFetch: typeof fetch = async (input) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('models.dev/logos/')) {
          logoUpstreamCalls += 1;
          return new Response('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>', {
            status: 200,
            headers: { 'Content-Type': 'image/svg+xml' },
          });
        }
        if (url.endsWith('/chat/completions')) {
          directUpstreamFetchCalls += 1;
          return new Response('<html><body><h1>Internal Proxy Banner 10.0.0.5</h1><script>alert(1)</script></body></html>', {
            status: 400,
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
          });
        }
        return new Response('Not Found', { status: 404 });
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

      await app.request('http://localhost/api/providers', {
        method: 'POST',
        headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ manifest: OPENROUTER_REASONING_MANIFEST }),
      });
      const keyRes = await app.request('http://localhost/api/providers/openrouter/keys', {
        method: 'POST',
        headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: 'OR Key', secret: 'sk-or-key-9999' }),
      });
      const createdKeyId = ((await keyRes.json()) as { key: { id: string } }).key.id;

      await app.request('http://localhost/api/providers/openrouter/detect-models', {
        method: 'POST',
        headers: { Cookie: adminCookie },
      });

      // 1) Non-JSON HTML upstream 400 -> never reflects HTML/script to client
      const htmlErrRes = await app.request('http://localhost/api/playground/chat', {
        method: 'POST',
        headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'openrouter/deepseek/deepseek-r1:free',
          messages: [{ role: 'user', content: 'Test HTML error' }],
        }),
      });
      assert.equal(htmlErrRes.status, 400);
      const htmlErrText = await htmlErrRes.text();
      assert.equal(htmlErrText.includes('<html'), false);
      assert.equal(htmlErrText.includes('<script'), false);
      assert.equal(htmlErrText.includes('10.0.0.5'), false);

      // 2) Fail-closed exit node: if key is assigned to an online node whose encrypted_token is NULL,
      // router MUST NOT fall back to direct fetchImpl (no Core IP leak!)
      db.prepare(
        `INSERT INTO nodes (id, name, mode, endpoint, token_hash, encrypted_token, status, last_rotated_at, created_at)
         VALUES ('node-no-token', 'Node Without Token', 'tailscale', '100.64.0.10:8443', 'deadbeef', NULL, 'online', 1700000000, 1700000000)`,
      ).run();
      db.prepare(`UPDATE provider_keys SET node_id = 'node-no-token', status = 'active' WHERE id = ?`).run(
        createdKeyId,
      );

      const callsBefore = directUpstreamFetchCalls;
      const failClosedRes = await app.request('http://localhost/api/playground/chat', {
        method: 'POST',
        headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'openrouter/deepseek/deepseek-r1:free',
          messages: [{ role: 'user', content: 'Must fail closed' }],
        }),
      });
      assert.equal(failClosedRes.status, 502);
      assert.equal(directUpstreamFetchCalls, callsBefore, 'Must NEVER fall back to direct fetchImpl');

      // 3) Unified secret scrubbing in /api/logs (nvapi-, gsk_, AIza, bfn_, Basic, ?api_key=)
      db.prepare(
        `INSERT INTO system_logs (level, category, message, meta_json, created_at)
         VALUES ('warn', 'system', ?, ?, ?)`,
      ).run(
        'Leaked nvapi-1234567890abcdef gsk_1234567890abcdef AIzaSyA123456789012345678 bfn_secret999 Basic dXNlcjpwYXNzMTIz https://api.example/v1?api_key=supersecret123&ok=1',
        JSON.stringify({ 'x-goog-api-key': 'AIzaSyHeaderSecret123456789', 'x-api-key': 'sk-1234567890abcdef' }),
        Math.floor(clockMs / 1000),
      );
      const logsRes = await app.request('http://localhost/api/logs', {
        headers: { Cookie: adminCookie },
      });
      const logsText = await logsRes.text();
      assert.equal(logsText.includes('nvapi-1234567890abcdef'), false);
      assert.equal(logsText.includes('gsk_1234567890abcdef'), false);
      assert.equal(logsText.includes('AIzaSyA123456789012345678'), false);
      assert.equal(logsText.includes('bfn_secret999'), false);
      assert.equal(logsText.includes('dXNlcjpwYXNzMTIz'), false);
      assert.equal(logsText.includes('supersecret123'), false);
      assert.equal(logsText.includes('AIzaSyHeaderSecret123456789'), false);

      // 4) Guest ?refresh=1 on /api/logos/:slug does NOT bypass cache, whereas admin ?refresh=1 does
      const guestHash = await hashPassword('guestpass123');
      db.prepare(
        `INSERT INTO users (id, username, password_hash, role, daily_token_limit, quota_reset_mode, created_at)
         VALUES ('guest-r', 'guest_refresh', ?, 'guest', 1000, 'utc_midnight', 1700000000)`,
      ).run(guestHash);
      const gLogin = await app.request('http://localhost/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'guest_refresh', password: 'guestpass123' }),
      });
      const guestCookie = extractCookieHeader(gLogin);

      await app.request('http://localhost/api/logos/openrouter', { headers: { Cookie: adminCookie } });
      assert.equal(logoUpstreamCalls, 1);
      await app.request('http://localhost/api/logos/openrouter?refresh=1', {
        headers: { Cookie: guestCookie },
      });
      assert.equal(logoUpstreamCalls, 1, 'Guest ?refresh=1 must not force upstream fetch');
      await app.request('http://localhost/api/logos/openrouter?refresh=1', {
        headers: { Cookie: adminCookie },
      });
      assert.equal(logoUpstreamCalls, 2, 'Admin ?refresh=1 may force upstream fetch');

      db.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});


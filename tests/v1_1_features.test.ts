import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, it } from 'node:test';

import { createApp } from '../core/src/app.js';
import { encryptSecret } from '../core/src/crypto.js';
import { openDatabase } from '../core/src/db.js';

const openServers: http.Server[] = [];

function extractCookiePair(setCookieHeader: string | null): string {
  assert.ok(setCookieHeader, 'Expected Set-Cookie header');
  return setCookieHeader.split(';')[0]!;
}

async function startMockHttpServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void | Promise<void>,
): Promise<{ host: string; port: number; url: string; server: http.Server }> {
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
  return { host: '127.0.0.1', port, url: `http://127.0.0.1:${port}`, server };
}

afterEach(async () => {
  while (openServers.length > 0) {
    const srv = openServers.pop()!;
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
});

const TEST_PROVIDER_MANIFEST = {
  schemaVersion: '1.0',
  id: 'test-openrouter',
  name: 'Test OpenRouter',
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
      id: 'llama-3.3-70b:free',
      name: 'Llama 3.3 70B Free',
    },
  ],
};

async function setupAdminAndProvider(options: {
  fetchImpl?: typeof fetch;
  now?: () => number;
}) {
  const db = openDatabase(':memory:');
  const masterKey = randomBytes(32);
  const app = createApp({
    db,
    masterKey,
    fetchImpl: options.fetchImpl,
    now: options.now,
  });

  const setupRes = await app.request('http://localhost/api/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'adminPassword123!' }),
  });
  assert.equal(setupRes.status, 201);
  const adminCookie = extractCookiePair(setupRes.headers.get('set-cookie'));

  const installRes = await app.request('http://localhost/api/providers', {
    method: 'POST',
    headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify(TEST_PROVIDER_MANIFEST),
  });
  assert.equal(installRes.status, 201);

  return { db, masterKey, app, adminCookie };
}

async function createGuestSession(
  app: ReturnType<typeof createApp>,
  adminCookie: string,
  username: string,
  allowedModels: string[] = ['*'],
): Promise<string> {
  const invRes = await app.request('http://localhost/api/invitations', {
    method: 'POST',
    headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      dailyTokenLimit: 10000,
      allowedModels,
    }),
  });
  assert.equal(invRes.status, 201);
  const { token } = (await invRes.json()) as { token: string };

  const acceptRes = await app.request(
    `http://localhost/api/invitations/${encodeURIComponent(token)}/accept`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: 'guestPassword123!' }),
    },
  );
  assert.equal(acceptRes.status, 201);
  return extractCookiePair(acceptRes.headers.get('set-cookie'));
}

describe('Bifrost v1.1 Features (P0-P2)', () => {
  describe('PATCH /api/providers/:id/keys/:keyId/toggle', () => {
    it('toggles provider keys between disabled and active/no_node and blocks disabled keys in router', async () => {
      let clockMs = Date.UTC(2026, 10, 21, 10, 0, 0);
      const mockFetch: typeof fetch = async (input) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.endsWith('/chat/completions')) {
          return new Response(
            JSON.stringify({
              id: 'chatcmpl-toggle-1',
              object: 'chat.completion',
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: 'Active key ok' },
                  finish_reason: 'stop',
                },
              ],
              usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response('Not found', { status: 404 });
      };

      const { db, app, adminCookie } = await setupAdminAndProvider({
        fetchImpl: mockFetch,
        now: () => clockMs,
      });

      try {
        // Add provider key (direct egress, no node)
        const addKeyRes = await app.request('http://localhost/api/providers/test-openrouter/keys', {
          method: 'POST',
          headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({ label: 'Direct Key', secret: 'sk-test-toggle-secret-1111' }),
        });
        assert.equal(addKeyRes.status, 201);
        const { key: directKey } = (await addKeyRes.json()) as {
          key: { id: string; status: string };
        };
        assert.equal(directKey.status, 'active');

        // Sync static models
        const reloadRes = await app.request(
          'http://localhost/api/providers/test-openrouter/reload-models',
          { method: 'POST', headers: { Cookie: adminCookie } },
        );
        assert.equal(reloadRes.status, 200);

        // Create internal API key for /v1/chat/completions
        const apiKeyRes = await app.request('http://localhost/api/keys', {
          method: 'POST',
          headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Toggle Test Key' }),
        });
        assert.equal(apiKeyRes.status, 201);
        const { rawKey } = (await apiKeyRes.json()) as { rawKey: string };

        // Guest cannot toggle provider keys (403)
        const guestCookie = await createGuestSession(app, adminCookie, 'guest_toggle');
        const guestForbidden = await app.request(
          `http://localhost/api/providers/test-openrouter/keys/${directKey.id}/toggle`,
          {
            method: 'PATCH',
            headers: { Cookie: guestCookie, 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: false }),
          },
        );
        assert.equal(guestForbidden.status, 403);

        // Invalid payload -> 400
        const badBodyRes = await app.request(
          `http://localhost/api/providers/test-openrouter/keys/${directKey.id}/toggle`,
          {
            method: 'PATCH',
            headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: 'yes' }),
          },
        );
        assert.equal(badBodyRes.status, 400);

        // Disable key -> status='disabled', router rejects with 503
        const disableRes = await app.request(
          `http://localhost/api/providers/test-openrouter/keys/${directKey.id}/toggle`,
          {
            method: 'PATCH',
            headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: false }),
          },
        );
        assert.equal(disableRes.status, 200);
        const disabledBody = (await disableRes.json()) as { key: { status: string; lastError: string | null } };
        assert.equal(disabledBody.key.status, 'disabled');
        assert.equal(disabledBody.key.lastError, null);

        const chatWhileDisabled = await app.request('http://localhost/v1/chat/completions', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${rawKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'test-openrouter/llama-3.3-70b:free',
            messages: [{ role: 'user', content: 'Hello while disabled' }],
          }),
        });
        assert.equal(chatWhileDisabled.status, 503);

        // Re-enable key -> status='active', router succeeds with 200
        const enableRes = await app.request(
          `http://localhost/api/providers/test-openrouter/keys/${directKey.id}/toggle`,
          {
            method: 'PATCH',
            headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: true }),
          },
        );
        assert.equal(enableRes.status, 200);
        const enabledBody = (await enableRes.json()) as { key: { status: string } };
        assert.equal(enabledBody.key.status, 'active');

        const chatAfterEnable = await app.request('http://localhost/v1/chat/completions', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${rawKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'test-openrouter/llama-3.3-70b:free',
            messages: [{ role: 'user', content: 'Hello after enable' }],
          }),
        });
        assert.equal(chatAfterEnable.status, 200);

        // Key assigned to an offline node: disabling sets 'disabled', re-enabling transitions to 'no_node'
        const nodeRes = await app.request('http://localhost/api/nodes', {
          method: 'POST',
          headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'Offline-Exit',
            mode: 'tailscale',
            endpoint: '100.64.0.99:9443',
          }),
        });
        assert.equal(nodeRes.status, 201);
        const { node: offlineNode } = (await nodeRes.json()) as { node: { id: string } };

        const nodeKeyRes = await app.request('http://localhost/api/providers/test-openrouter/keys', {
          method: 'POST',
          headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            label: 'Node Bound Key',
            secret: 'sk-test-node-bound-2222',
            nodeId: offlineNode.id,
          }),
        });
        assert.equal(nodeKeyRes.status, 201);
        const { key: nodeBoundKey } = (await nodeKeyRes.json()) as {
          key: { id: string; status: string };
        };
        assert.equal(nodeBoundKey.status, 'no_node');

        const disableNodeKeyRes = await app.request(
          `http://localhost/api/providers/test-openrouter/keys/${nodeBoundKey.id}/toggle`,
          {
            method: 'PATCH',
            headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: false }),
          },
        );
        assert.equal(disableNodeKeyRes.status, 200);
        assert.equal(
          ((await disableNodeKeyRes.json()) as { key: { status: string } }).key.status,
          'disabled',
        );

        const enableNodeKeyRes = await app.request(
          `http://localhost/api/providers/test-openrouter/keys/${nodeBoundKey.id}/toggle`,
          {
            method: 'PATCH',
            headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: true }),
          },
        );
        assert.equal(enableNodeKeyRes.status, 200);
        const reenabledNodeKey = (await enableNodeKeyRes.json()) as {
          key: { status: string; lastError: string | null };
        };
        assert.equal(reenabledNodeKey.key.status, 'no_node');
        assert.match(reenabledNodeKey.key.lastError ?? '', /Offline-Exit.*offline/);
      } finally {
        db.close();
      }
    });
  });

  describe('POST /api/providers/:id/keys/:keyId/test', () => {
    it('verifies key connectivity via mocked fetchImpl, redacts leaked secrets on error, and enforces no_node guard', async () => {
      let clockMs = Date.UTC(2026, 10, 21, 11, 0, 0);
      let fetchCalls = 0;
      let upstreamScenario: 'ok' | 'unauthorized' | 'network_error' = 'ok';
      const secretOk = 'sk-test-valid-secret-9999';
      const secretFail = 'sk-test-bad-secret-8888';

      const mockFetch: typeof fetch = async (input, init) => {
        fetchCalls++;
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        assert.equal(url, 'https://api.example.com/v1/models');
        const authHeader = new Headers(init?.headers).get('authorization');

        clockMs += 42;
        if (upstreamScenario === 'ok') {
          assert.equal(authHeader, `Bearer ${secretOk}`);
          return new Response(JSON.stringify({ data: [] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (upstreamScenario === 'unauthorized') {
          return new Response(`Invalid API key ${secretFail} provided`, { status: 401 });
        }
        throw new Error(`Connection reset while using ${secretFail}`);
      };

      const { db, masterKey, app, adminCookie } = await setupAdminAndProvider({
        fetchImpl: mockFetch,
        now: () => clockMs,
      });

      try {
        // 1. Key that succeeds
        const k1Res = await app.request('http://localhost/api/providers/test-openrouter/keys', {
          method: 'POST',
          headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({ label: 'Good Key', secret: secretOk }),
        });
        assert.equal(k1Res.status, 201);
        const k1Id = ((await k1Res.json()) as { key: { id: string } }).key.id;

        // Guest forbidden -> 403
        const guestCookie = await createGuestSession(app, adminCookie, 'guest_keytest');
        const guestRes = await app.request(
          `http://localhost/api/providers/test-openrouter/keys/${k1Id}/test`,
          { method: 'POST', headers: { Cookie: guestCookie } },
        );
        assert.equal(guestRes.status, 403);

        // Missing key -> 404
        const missingKeyRes = await app.request(
          'http://localhost/api/providers/test-openrouter/keys/nonexistent-id/test',
          { method: 'POST', headers: { Cookie: adminCookie } },
        );
        assert.equal(missingKeyRes.status, 404);

        // Success test
        const okTestRes = await app.request(
          `http://localhost/api/providers/test-openrouter/keys/${k1Id}/test`,
          { method: 'POST', headers: { Cookie: adminCookie } },
        );
        assert.equal(okTestRes.status, 200);
        const okTestJson = (await okTestRes.json()) as {
          ok: boolean;
          httpStatus: number | null;
          latencyMs: number;
          message: string;
        };
        assert.equal(okTestJson.ok, true);
        assert.equal(okTestJson.httpStatus, 200);
        assert.equal(okTestJson.latencyMs, 42);
        assert.match(okTestJson.message, /verified successfully/i);
        assert.equal(fetchCalls, 1);

        // 2. Key with 401 & network failure -> secret must be redacted
        const k2Res = await app.request('http://localhost/api/providers/test-openrouter/keys', {
          method: 'POST',
          headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({ label: 'Bad Key', secret: secretFail }),
        });
        assert.equal(k2Res.status, 201);
        const k2Id = ((await k2Res.json()) as { key: { id: string } }).key.id;

        upstreamScenario = 'unauthorized';
        const fail401Res = await app.request(
          `http://localhost/api/providers/test-openrouter/keys/${k2Id}/test`,
          { method: 'POST', headers: { Cookie: adminCookie } },
        );
        assert.equal(fail401Res.status, 200);
        const fail401Json = (await fail401Res.json()) as {
          ok: boolean;
          httpStatus: number | null;
          latencyMs: number;
          message: string;
        };
        assert.equal(fail401Json.ok, false);
        assert.equal(fail401Json.httpStatus, 401);
        assert.ok(!fail401Json.message.includes(secretFail), 'Response must redact secret');
        assert.match(fail401Json.message, /\[REDACTED\]/);

        upstreamScenario = 'network_error';
        const failNetRes = await app.request(
          `http://localhost/api/providers/test-openrouter/keys/${k2Id}/test`,
          { method: 'POST', headers: { Cookie: adminCookie } },
        );
        assert.equal(failNetRes.status, 200);
        const failNetJson = (await failNetRes.json()) as {
          ok: boolean;
          httpStatus: number | null;
          message: string;
        };
        assert.equal(failNetJson.ok, false);
        assert.equal(failNetJson.httpStatus, null);
        assert.ok(!failNetJson.message.includes(secretFail), 'Network error must redact secret');
        assert.match(failNetJson.message, /\[REDACTED\]/);

        // 3. no_node guard: key with status='no_node' and node_id=NULL must NOT call fetchImpl
        const noNodeKeyId = randomUUID();
        db.prepare(
          `INSERT INTO provider_keys (
             id, provider_id, label, encrypted_secret, last4, node_id, forced_node,
             status, last_error, created_at
           ) VALUES (?, 'test-openrouter', 'Orphaned Key', ?, '7777', NULL, 0, 'no_node', 'Assigned exit node was removed', ?)`,
        ).run(noNodeKeyId, encryptSecret('sk-test-orphan-7777', masterKey), Math.floor(clockMs / 1000));

        const fetchCallsBeforeNoNode = fetchCalls;
        const noNodeRes = await app.request(
          `http://localhost/api/providers/test-openrouter/keys/${noNodeKeyId}/test`,
          { method: 'POST', headers: { Cookie: adminCookie } },
        );
        assert.equal(noNodeRes.status, 200);
        const noNodeJson = (await noNodeRes.json()) as {
          ok: boolean;
          httpStatus: number | null;
          latencyMs: number;
          message: string;
        };
        assert.equal(noNodeJson.ok, false);
        assert.equal(noNodeJson.httpStatus, null);
        assert.equal(noNodeJson.latencyMs, 0);
        assert.match(noNodeJson.message, /no_node/i);
        assert.equal(fetchCalls, fetchCallsBeforeNoNode, 'no_node guard must prevent upstream fetch');
      } finally {
        db.close();
      }
    });
  });

  describe('POST /api/nodes/:id/test', () => {
    it('tests node connectivity against /_bifrost/health, transitions node online & restores no_node keys, and handles failures', async () => {
      let clockMs = Date.UTC(2026, 10, 21, 12, 0, 0);
      let expectedNodeToken = '';
      let healthMode: 'healthy' | 'unhealthy_503' = 'healthy';

      const mockNodeServer = await startMockHttpServer((req, res) => {
        if (req.url === '/_bifrost/health') {
          const auth = String(req.headers['proxy-authorization'] ?? req.headers.authorization ?? '');
          assert.equal(auth, `Bearer ${expectedNodeToken}`);
          clockMs += 18;
          if (healthMode === 'healthy') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
            return;
          }
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false }));
          return;
        }
        res.writeHead(404);
        res.end();
      });

      const { db, app, adminCookie } = await setupAdminAndProvider({
        now: () => clockMs,
      });

      try {
        // Register node pointing to mockNodeServer (starts as 'offline')
        const createNodeRes = await app.request('http://localhost/api/nodes', {
          method: 'POST',
          headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'Test-Exit-Node',
            mode: 'tailscale',
            endpoint: `${mockNodeServer.host}:${mockNodeServer.port}`,
          }),
        });
        assert.equal(createNodeRes.status, 201);
        const { node, rawToken } = (await createNodeRes.json()) as {
          node: { id: string; status: string };
          rawToken: string;
        };
        assert.equal(node.status, 'offline');
        expectedNodeToken = rawToken;

        // Bind a provider key while node is still offline -> key starts as 'no_node'
        const addKeyRes = await app.request('http://localhost/api/providers/test-openrouter/keys', {
          method: 'POST',
          headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            label: 'Key Waiting For Node',
            secret: 'sk-test-wait-node-3333',
            nodeId: node.id,
          }),
        });
        assert.equal(addKeyRes.status, 201);
        const { key: waitingKey } = (await addKeyRes.json()) as {
          key: { id: string; status: string };
        };
        assert.equal(waitingKey.status, 'no_node');

        // Guest forbidden -> 403
        const guestCookie = await createGuestSession(app, adminCookie, 'guest_nodetest');
        const guestTestRes = await app.request(`http://localhost/api/nodes/${node.id}/test`, {
          method: 'POST',
          headers: { Cookie: guestCookie },
        });
        assert.equal(guestTestRes.status, 403);

        // Unknown node -> 404
        const notFoundRes = await app.request('http://localhost/api/nodes/nonexistent-node/test', {
          method: 'POST',
          headers: { Cookie: adminCookie },
        });
        assert.equal(notFoundRes.status, 404);

        // Unhealthy 503 -> ok:false, preserves offline status
        healthMode = 'unhealthy_503';
        const unhealthyRes = await app.request(`http://localhost/api/nodes/${node.id}/test`, {
          method: 'POST',
          headers: { Cookie: adminCookie },
        });
        assert.equal(unhealthyRes.status, 200);
        const unhealthyBody = (await unhealthyRes.json()) as {
          ok: boolean;
          status: string;
          latencyMs: number | null;
          error?: string;
        };
        assert.equal(unhealthyBody.ok, false);
        assert.equal(unhealthyBody.status, 'offline');
        assert.match(unhealthyBody.error ?? '', /503/);

        // Healthy 200 -> ok:true, status:'online', restores bound key from 'no_node' to 'active'
        healthMode = 'healthy';
        const healthyRes = await app.request(`http://localhost/api/nodes/${node.id}/test`, {
          method: 'POST',
          headers: { Cookie: adminCookie },
        });
        assert.equal(healthyRes.status, 200);
        const healthyBody = (await healthyRes.json()) as {
          ok: boolean;
          status: string;
          latencyMs: number | null;
        };
        assert.equal(healthyBody.ok, true);
        assert.equal(healthyBody.status, 'online');
        assert.equal(healthyBody.latencyMs, 18);

        const keyAfterTest = db
          .prepare(`SELECT status, last_error FROM provider_keys WHERE id = ?`)
          .get(waitingKey.id) as { status: string; last_error: string | null };
        assert.equal(keyAfterTest.status, 'active');
        assert.equal(keyAfterTest.last_error, null);

        // Unreachable node after server stops -> ok:false, latencyMs:null
        await new Promise<void>((resolve) => mockNodeServer.server.close(() => resolve()));
        const downRes = await app.request(`http://localhost/api/nodes/${node.id}/test`, {
          method: 'POST',
          headers: { Cookie: adminCookie },
        });
        assert.equal(downRes.status, 200);
        const downBody = (await downRes.json()) as {
          ok: boolean;
          status: string;
          latencyMs: number | null;
          error?: string;
        };
        assert.equal(downBody.ok, false);
        assert.equal(downBody.latencyMs, null);
        assert.ok(downBody.error && downBody.error.length > 0);
      } finally {
        db.close();
      }
    });
  });

  describe('Internal API Keys Expiration (HU-36)', () => {
    it('supports expiresInDays and expiresAt on POST /api/keys, exposes expiresAt, and rejects expired keys with 401 on /v1/*', async () => {
      let clockMs = Date.UTC(2026, 10, 21, 13, 0, 0);
      const mockFetch: typeof fetch = async (input) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.endsWith('/chat/completions')) {
          return new Response(
            JSON.stringify({
              id: 'chatcmpl-exp-1',
              object: 'chat.completion',
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: 'Still valid!' },
                  finish_reason: 'stop',
                },
              ],
              usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response('Not found', { status: 404 });
      };

      const { db, app, adminCookie } = await setupAdminAndProvider({
        fetchImpl: mockFetch,
        now: () => clockMs,
      });

      try {
        await app.request('http://localhost/api/providers/test-openrouter/keys', {
          method: 'POST',
          headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({ label: 'Primary', secret: 'sk-test-expiry-upstream-1234' }),
        });
        await app.request('http://localhost/api/providers/test-openrouter/reload-models', {
          method: 'POST',
          headers: { Cookie: adminCookie },
        });

        const nowSec = Math.floor(clockMs / 1000);

        // Validation: past expiresAt and invalid expiresInDays -> 400
        const pastRes = await app.request('http://localhost/api/keys', {
          method: 'POST',
          headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Past Key', expiresAt: nowSec - 10 }),
        });
        assert.equal(pastRes.status, 400);

        const badDaysRes = await app.request('http://localhost/api/keys', {
          method: 'POST',
          headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Zero Days', expiresInDays: 0 }),
        });
        assert.equal(badDaysRes.status, 400);

        // 1. Key with expiresInDays=2
        const daysKeyRes = await app.request('http://localhost/api/keys', {
          method: 'POST',
          headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Two Day Key', expiresInDays: 2 }),
        });
        assert.equal(daysKeyRes.status, 201);
        const daysKeyJson = (await daysKeyRes.json()) as {
          key: { id: string; expiresAt: number | null };
          rawKey: string;
        };
        assert.equal(daysKeyJson.key.expiresAt, nowSec + 2 * 86400);

        // 2. Key with explicit expiresAt (+1 hour)
        const explicitExpiry = nowSec + 3600;
        const explicitKeyRes = await app.request('http://localhost/api/keys', {
          method: 'POST',
          headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'One Hour Key', expiresAt: explicitExpiry }),
        });
        assert.equal(explicitKeyRes.status, 201);
        const explicitKeyJson = (await explicitKeyRes.json()) as {
          key: { id: string; expiresAt: number | null };
          rawKey: string;
        };
        assert.equal(explicitKeyJson.key.expiresAt, explicitExpiry);

        // 3. Key without expiration
        const permanentKeyRes = await app.request('http://localhost/api/keys', {
          method: 'POST',
          headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Permanent Key' }),
        });
        assert.equal(permanentKeyRes.status, 201);
        const permanentKeyJson = (await permanentKeyRes.json()) as {
          key: { id: string; expiresAt: number | null };
          rawKey: string;
        };
        assert.equal(permanentKeyJson.key.expiresAt, null);

        // GET /api/keys returns expiresAt on all keys
        const listRes = await app.request('http://localhost/api/keys', {
          headers: { Cookie: adminCookie },
        });
        assert.equal(listRes.status, 200);
        const listJson = (await listRes.json()) as {
          keys: Array<{ id: string; expiresAt: number | null }>;
        };
        assert.equal(
          listJson.keys.find((k) => k.id === daysKeyJson.key.id)?.expiresAt,
          nowSec + 2 * 86400,
        );
        assert.equal(
          listJson.keys.find((k) => k.id === explicitKeyJson.key.id)?.expiresAt,
          explicitExpiry,
        );
        assert.equal(
          listJson.keys.find((k) => k.id === permanentKeyJson.key.id)?.expiresAt,
          null,
        );

        // Before expiry: explicitKey works on /v1/models and /v1/chat/completions
        const preModelsRes = await app.request('http://localhost/v1/models', {
          headers: { Authorization: `Bearer ${explicitKeyJson.rawKey}` },
        });
        assert.equal(preModelsRes.status, 200);

        const preChatRes = await app.request('http://localhost/v1/chat/completions', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${explicitKeyJson.rawKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'test-openrouter/llama-3.3-70b:free',
            messages: [{ role: 'user', content: 'Before expiry' }],
          }),
        });
        assert.equal(preChatRes.status, 200);

        // Advance clock exactly to explicitExpiry (expiresAt <= nowSec triggers 401)
        clockMs += 3600 * 1000;

        const expiredModelsRes = await app.request('http://localhost/v1/models', {
          headers: { Authorization: `Bearer ${explicitKeyJson.rawKey}` },
        });
        assert.equal(expiredModelsRes.status, 401);
        const expiredModelsJson = (await expiredModelsRes.json()) as {
          error: { code: string; message: string };
        };
        assert.equal(expiredModelsJson.error.code, 'expired_api_key');

        const expiredChatRes = await app.request('http://localhost/v1/chat/completions', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${explicitKeyJson.rawKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'test-openrouter/llama-3.3-70b:free',
            messages: [{ role: 'user', content: 'After expiry' }],
          }),
        });
        assert.equal(expiredChatRes.status, 401);
        const expiredChatJson = (await expiredChatRes.json()) as {
          error: { code: string };
        };
        assert.equal(expiredChatJson.error.code, 'expired_api_key');

        // Two Day Key and Permanent Key still work!
        const daysStillValidRes = await app.request('http://localhost/v1/models', {
          headers: { Authorization: `Bearer ${daysKeyJson.rawKey}` },
        });
        assert.equal(daysStillValidRes.status, 200);

        // Advance past 2 days -> Two Day Key also expires (401), Permanent Key stays 200
        clockMs += 2 * 86400 * 1000;
        const daysExpiredRes = await app.request('http://localhost/v1/models', {
          headers: { Authorization: `Bearer ${daysKeyJson.rawKey}` },
        });
        assert.equal(daysExpiredRes.status, 401);

        const permanentStillValidRes = await app.request('http://localhost/v1/chat/completions', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${permanentKeyJson.rawKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'test-openrouter/llama-3.3-70b:free',
            messages: [{ role: 'user', content: 'Permanent still works' }],
          }),
        });
        assert.equal(permanentStillValidRes.status, 200);
      } finally {
        db.close();
      }
    });
  });

  describe('Models Visibility, Invitation Deletion, and Activity groupBy=apiKey (P1/P2)', () => {
    it('supports POST /api/models/visibility and PATCH /api/models/:id/visibility with admin auth and /v1 filtering', async () => {
      const { db, app, adminCookie } = await setupAdminAndProvider({});
      try {
        await app.request('http://localhost/api/providers/test-openrouter/keys', {
          method: 'POST',
          headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({ label: 'Key', secret: 'sk-test-vis-1234' }),
        });
        await app.request('http://localhost/api/providers/test-openrouter/reload-models', {
          method: 'POST',
          headers: { Cookie: adminCookie },
        });

        const guestCookie = await createGuestSession(app, adminCookie, 'guest_vis');
        const fullId = 'test-openrouter/llama-3.3-70b:free';

        // Guest forbidden -> 403
        const guestRes = await app.request('http://localhost/api/models/visibility', {
          method: 'POST',
          headers: { Cookie: guestCookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({ fullId, disabled: true }),
        });
        assert.equal(guestRes.status, 403);

        // Missing model -> 404
        const missingRes = await app.request('http://localhost/api/models/visibility', {
          method: 'POST',
          headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({ fullId: 'test-openrouter/nonexistent', disabled: true }),
        });
        assert.equal(missingRes.status, 404);

        // POST /api/models/visibility disables model
        const disableRes = await app.request('http://localhost/api/models/visibility', {
          method: 'POST',
          headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({ fullId, disabled: true }),
        });
        assert.equal(disableRes.status, 200);
        const disableBody = (await disableRes.json()) as {
          ok: boolean;
          fullId: string;
          disabledByAdmin: boolean;
          model: { fullId: string; disabledByAdmin: boolean };
        };
        assert.equal(disableBody.ok, true);
        assert.equal(disableBody.fullId, fullId);
        assert.equal(disableBody.disabledByAdmin, true);
        assert.equal(disableBody.model.disabledByAdmin, true);

        // Guest no longer sees disabled model in GET /api/models
        const guestModels = await app.request('http://localhost/api/models', {
          headers: { Cookie: guestCookie },
        });
        const guestModelsJson = (await guestModels.json()) as { models: Array<{ fullId: string }> };
        assert.equal(guestModelsJson.models.length, 0);

        // Admin still sees model with disabledByAdmin=true
        const adminModels = await app.request('http://localhost/api/models', {
          headers: { Cookie: adminCookie },
        });
        const adminModelsJson = (await adminModels.json()) as {
          models: Array<{ fullId: string; disabledByAdmin: boolean }>;
        };
        assert.equal(adminModelsJson.models.length, 1);
        assert.equal(adminModelsJson.models[0]!.disabledByAdmin, true);

        // PATCH /api/models/:id/visibility re-enables model
        const enableRes = await app.request(
          `http://localhost/api/models/${encodeURIComponent(fullId)}/visibility`,
          {
            method: 'PATCH',
            headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
            body: JSON.stringify({ disabled: false }),
          },
        );
        assert.equal(enableRes.status, 200);
        const enableBody = (await enableRes.json()) as {
          ok: boolean;
          disabledByAdmin: boolean;
          model: { disabledByAdmin: boolean };
        };
        assert.equal(enableBody.ok, true);
        assert.equal(enableBody.disabledByAdmin, false);
        assert.equal(enableBody.model.disabledByAdmin, false);
      } finally {
        db.close();
      }
    });

    it('supports DELETE /api/invitations/:id with admin check and 404/409 handling', async () => {
      const { db, app, adminCookie } = await setupAdminAndProvider({});
      try {
        const invRes = await app.request('http://localhost/api/invitations', {
          method: 'POST',
          headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({ dailyTokenLimit: 5000, allowedModels: ['*'] }),
        });
        assert.equal(invRes.status, 201);
        const invJson = (await invRes.json()) as { invitation: { id: string } };

        const guestCookie = await createGuestSession(app, adminCookie, 'guest_invdel');

        // Guest forbidden -> 403
        const guestDel = await app.request(`http://localhost/api/invitations/${invJson.invitation.id}`, {
          method: 'DELETE',
          headers: { Cookie: guestCookie },
        });
        assert.equal(guestDel.status, 403);

        // Unknown ID -> 404
        const notFoundDel = await app.request('http://localhost/api/invitations/nonexistent-id', {
          method: 'DELETE',
          headers: { Cookie: adminCookie },
        });
        assert.equal(notFoundDel.status, 404);

        // Valid delete -> 200 { ok: true }
        const okDel = await app.request(`http://localhost/api/invitations/${invJson.invitation.id}`, {
          method: 'DELETE',
          headers: { Cookie: adminCookie },
        });
        assert.equal(okDel.status, 200);
        assert.deepEqual(await okDel.json(), { ok: true });

        // Deleting again -> 404
        const secondDel = await app.request(`http://localhost/api/invitations/${invJson.invitation.id}`, {
          method: 'DELETE',
          headers: { Cookie: adminCookie },
        });
        assert.equal(secondDel.status, 404);
      } finally {
        db.close();
      }
    });

    it('supports GET /api/metrics/activity?groupBy=apiKey grouping internal keys and session traffic', async () => {
      let clockMs = Date.UTC(2026, 10, 21, 14, 0, 0);
      const mockFetch: typeof fetch = async (input) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.endsWith('/chat/completions')) {
          return new Response(
            JSON.stringify({
              id: 'chatcmpl-act-1',
              object: 'chat.completion',
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: 'ok' },
                  finish_reason: 'stop',
                },
              ],
              usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response('Not found', { status: 404 });
      };

      const { db, app, adminCookie } = await setupAdminAndProvider({
        fetchImpl: mockFetch,
        now: () => clockMs,
      });

      try {
        await app.request('http://localhost/api/providers/test-openrouter/keys', {
          method: 'POST',
          headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({ label: 'Primary', secret: 'sk-test-act-1234' }),
        });
        await app.request('http://localhost/api/providers/test-openrouter/reload-models', {
          method: 'POST',
          headers: { Cookie: adminCookie },
        });

        const kRes = await app.request('http://localhost/api/keys', {
          method: 'POST',
          headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'IDE Key' }),
        });
        assert.equal(kRes.status, 201);
        const { key: apiKeyObj, rawKey } = (await kRes.json()) as {
          key: { id: string; keyPrefix: string };
          rawKey: string;
        };

        // 1 request via /v1/chat/completions with internal API key
        const v1Res = await app.request('http://localhost/v1/chat/completions', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${rawKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'test-openrouter/llama-3.3-70b:free',
            messages: [{ role: 'user', content: 'via api key' }],
          }),
        });
        assert.equal(v1Res.status, 200);

        // 1 request via Playground (session, no internal API key)
        const pgRes = await app.request('http://localhost/api/playground/chat', {
          method: 'POST',
          headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'test-openrouter/llama-3.3-70b:free',
            messages: [{ role: 'user', content: 'via playground' }],
          }),
        });
        assert.equal(pgRes.status, 200);

        const actRes = await app.request(
          'http://localhost/api/metrics/activity?range=today&groupBy=apiKey',
          { headers: { Cookie: adminCookie } },
        );
        assert.equal(actRes.status, 200);
        const actJson = (await actRes.json()) as {
          groupBy: string;
          totals: { totalTokens: number };
          items: Array<{
            key: string;
            label: string;
            promptTokens: number;
            completionTokens: number;
            reasoningTokens: number;
            totalTokens: number;
            requestsCount: number;
          }>;
        };
        assert.equal(actJson.groupBy, 'apiKey');
        assert.equal(actJson.totals.totalTokens, 80);
        assert.equal(actJson.items.length, 2);

        const keyItem = actJson.items.find((i) => i.key === apiKeyObj.id);
        assert.ok(keyItem);
        assert.ok(keyItem.label.includes('IDE Key'));
        assert.equal(keyItem.totalTokens, 40);
        assert.equal(keyItem.requestsCount, 1);

        const sessionItem = actJson.items.find((i) => i.key === 'session');
        assert.ok(sessionItem);
        assert.equal(sessionItem.label, 'Panel / Sesión');
        assert.equal(sessionItem.totalTokens, 40);
        assert.equal(sessionItem.requestsCount, 1);
      } finally {
        db.close();
      }
    });
  });

  // =========================================================================
  // QA Audit Fixes — HU-27, HU-28, HU-29, HU-30
  // =========================================================================

  describe('QA Fixes: HU-27, HU-28, HU-29, HU-30', () => {
    it('HU-27: POST /api/providers/:id/keys honors status="disabled" and enabled=false without routing disabled keys', async () => {
      const { db, app, adminCookie } = await setupAdminAndProvider({});
      try {
        // Create with status: 'disabled'
        const res1 = await app.request('http://localhost/api/providers/test-openrouter/keys', {
          method: 'POST',
          headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            label: 'Disabled By Status',
            secret: 'sk-test-disabled-1111',
            status: 'disabled',
          }),
        });
        assert.equal(res1.status, 201);
        const body1 = (await res1.json()) as { key: { id: string; status: string } };
        assert.equal(body1.key.status, 'disabled');

        // Create with enabled: false
        const res2 = await app.request('http://localhost/api/providers/test-openrouter/keys', {
          method: 'POST',
          headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            label: 'Disabled By Flag',
            secret: 'sk-test-disabled-2222',
            enabled: false,
          }),
        });
        assert.equal(res2.status, 201);
        const body2 = (await res2.json()) as { key: { id: string; status: string } };
        assert.equal(body2.key.status, 'disabled');

        // Invalid status -> 400
        const badRes = await app.request('http://localhost/api/providers/test-openrouter/keys', {
          method: 'POST',
          headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            label: 'Bad Status',
            secret: 'sk-test-disabled-3333',
            status: 'bogus',
          }),
        });
        assert.equal(badRes.status, 400);

        // Persisted as disabled in DB
        const dbRow = db
          .prepare(`SELECT status FROM provider_keys WHERE id = ?`)
          .get(body1.key.id) as { status: string };
        assert.equal(dbRow.status, 'disabled');
      } finally {
        db.close();
      }
    });

    it('HU-28: POST /api/nodes/:id/test marks online node unresponsive on failure and logs warn entries without leaking token', async () => {
      let clockMs = Date.UTC(2026, 10, 21, 14, 0, 0);
      let healthMode: 'healthy' | 'unhealthy_503' = 'healthy';
      let expectedNodeToken = '';

      const mockNodeServer = await startMockHttpServer((req, res) => {
        if (req.url === '/_bifrost/health') {
          const auth = String(req.headers['proxy-authorization'] ?? req.headers.authorization ?? '');
          if (auth !== `Bearer ${expectedNodeToken}`) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false }));
            return;
          }
          if (healthMode === 'unhealthy_503') {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        res.writeHead(404);
        res.end();
      });

      const { db, app, adminCookie } = await setupAdminAndProvider({ now: () => clockMs });
      try {
        const createNodeRes = await app.request('http://localhost/api/nodes', {
          method: 'POST',
          headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'Node HU-28',
            mode: 'tailscale',
            endpoint: `127.0.0.1:${mockNodeServer.port}`,
          }),
        });
        assert.equal(createNodeRes.status, 201);
        const { node, rawToken } = (await createNodeRes.json()) as {
          node: { id: string; status: string };
          rawToken: string;
        };
        expectedNodeToken = rawToken;

        // Bring online first (offline -> online transition logged)
        const okRes = await app.request(`http://localhost/api/nodes/${node.id}/test`, {
          method: 'POST',
          headers: { Cookie: adminCookie },
        });
        assert.equal(okRes.status, 200);
        const okBody = (await okRes.json()) as { ok: boolean; status: string };
        assert.equal(okBody.ok, true);
        assert.equal(okBody.status, 'online');

        // Now fail with 503 -> must transition online -> unresponsive in DB and response
        healthMode = 'unhealthy_503';
        clockMs += 1000;
        const failRes = await app.request(`http://localhost/api/nodes/${node.id}/test`, {
          method: 'POST',
          headers: { Cookie: adminCookie },
        });
        assert.equal(failRes.status, 200);
        const failBody = (await failRes.json()) as { ok: boolean; status: string; error?: string };
        assert.equal(failBody.ok, false);
        assert.equal(failBody.status, 'unresponsive');

        const dbNode = db.prepare(`SELECT status FROM nodes WHERE id = ?`).get(node.id) as {
          status: string;
        };
        assert.equal(dbNode.status, 'unresponsive');

        // Verify system_logs recorded warn/node entries and never leaked rawToken
        const logs = db
          .prepare(
            `SELECT level, category, message, meta_json
             FROM system_logs
             WHERE category = 'node' AND level = 'warn'
             ORDER BY id ASC`,
          )
          .all() as Array<{
          level: string;
          category: string;
          message: string;
          meta_json: string | null;
        }>;
        assert.ok(logs.length >= 2, 'Expected warn/node logs for status transition and failure');
        assert.ok(logs.some((l) => /to "online"/.test(l.message)));
        assert.ok(logs.some((l) => /failed.*HTTP 503/i.test(l.message)));
        for (const l of logs) {
          assert.ok(!l.message.includes(rawToken), 'Log message must not leak node token');
          assert.ok(
            !(l.meta_json ?? '').includes(rawToken),
            'Log metadata must not leak node token',
          );
        }
      } finally {
        await new Promise<void>((resolve) => mockNodeServer.server.close(() => resolve()));
        db.close();
      }
    });

    it('HU-29: POST /api/providers/:id/keys/:keyId/test persists/clears last_error and never auto-activates disabled keys', async () => {
      let clockMs = Date.UTC(2026, 10, 21, 15, 0, 0);
      let mode: 'ok' | '401' | '429' = '401';
      const secretActive = 'sk-test-hu29-active-9999';
      const secretDisabled = 'sk-test-hu29-disabled-8888';

      const mockFetch: typeof fetch = async () => {
        clockMs += 15;
        if (mode === '401') {
          return new Response(JSON.stringify({ error: `Invalid key ${secretActive}` }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (mode === '429') {
          return new Response(JSON.stringify({ error: 'Rate limit exceeded' }), {
            status: 429,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };

      const { db, app, adminCookie } = await setupAdminAndProvider({
        fetchImpl: mockFetch,
        now: () => clockMs,
      });

      try {
        // 1. Active key: 401 -> status='error' + redacted last_error; 200 -> status='active' + last_error=NULL
        const kActiveRes = await app.request(
          'http://localhost/api/providers/test-openrouter/keys',
          {
            method: 'POST',
            headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
            body: JSON.stringify({ label: 'Active Key', secret: secretActive, status: 'active' }),
          },
        );
        const kActiveId = ((await kActiveRes.json()) as { key: { id: string } }).key.id;

        mode = '401';
        const fail401 = await app.request(
          `http://localhost/api/providers/test-openrouter/keys/${kActiveId}/test`,
          { method: 'POST', headers: { Cookie: adminCookie } },
        );
        const fail401Json = (await fail401.json()) as { ok: boolean; status: string };
        assert.equal(fail401Json.ok, false);
        assert.equal(fail401Json.status, 'error');

        let row = db
          .prepare(`SELECT status, last_error FROM provider_keys WHERE id = ?`)
          .get(kActiveId) as { status: string; last_error: string | null };
        assert.equal(row.status, 'error');
        assert.ok(row.last_error && !row.last_error.includes(secretActive));

        // 200 recovers error -> active and clears last_error
        mode = 'ok';
        const ok1 = await app.request(
          `http://localhost/api/providers/test-openrouter/keys/${kActiveId}/test`,
          { method: 'POST', headers: { Cookie: adminCookie } },
        );
        const ok1Json = (await ok1.json()) as { ok: boolean; status: string };
        assert.equal(ok1Json.ok, true);
        assert.equal(ok1Json.status, 'active');

        row = db
          .prepare(`SELECT status, last_error FROM provider_keys WHERE id = ?`)
          .get(kActiveId) as { status: string; last_error: string | null };
        assert.equal(row.status, 'active');
        assert.equal(row.last_error, null);

        // 429 on active -> rate_limited
        mode = '429';
        const fail429 = await app.request(
          `http://localhost/api/providers/test-openrouter/keys/${kActiveId}/test`,
          { method: 'POST', headers: { Cookie: adminCookie } },
        );
        const fail429Json = (await fail429.json()) as { ok: boolean; status: string };
        assert.equal(fail429Json.status, 'rate_limited');

        // 2. Disabled key: 401 saves last_error while keeping 'disabled'; 200 clears last_error and STILL keeps 'disabled'
        const kDisRes = await app.request('http://localhost/api/providers/test-openrouter/keys', {
          method: 'POST',
          headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            label: 'Disabled Key',
            secret: secretDisabled,
            status: 'disabled',
          }),
        });
        const kDisId = ((await kDisRes.json()) as { key: { id: string } }).key.id;

        mode = '401';
        const disFail = await app.request(
          `http://localhost/api/providers/test-openrouter/keys/${kDisId}/test`,
          { method: 'POST', headers: { Cookie: adminCookie } },
        );
        const disFailJson = (await disFail.json()) as { ok: boolean; status: string };
        assert.equal(disFailJson.ok, false);
        assert.equal(disFailJson.status, 'disabled');

        row = db
          .prepare(`SELECT status, last_error FROM provider_keys WHERE id = ?`)
          .get(kDisId) as { status: string; last_error: string | null };
        assert.equal(row.status, 'disabled');
        assert.ok(row.last_error && row.last_error.includes('401'));

        mode = 'ok';
        const disOk = await app.request(
          `http://localhost/api/providers/test-openrouter/keys/${kDisId}/test`,
          { method: 'POST', headers: { Cookie: adminCookie } },
        );
        const disOkJson = (await disOk.json()) as { ok: boolean; status: string };
        assert.equal(disOkJson.ok, true);
        assert.equal(disOkJson.status, 'disabled');

        row = db
          .prepare(`SELECT status, last_error FROM provider_keys WHERE id = ?`)
          .get(kDisId) as { status: string; last_error: string | null };
        assert.equal(row.status, 'disabled');
        assert.equal(row.last_error, null);
      } finally {
        db.close();
      }
    });

    it('HU-30: syncs free embedding models, hides admin-disabled models on GET /api/models/* for guests, and serves POST /v1/embeddings with failover & usage logging', async () => {
      let clockMs = Date.UTC(2026, 10, 21, 16, 0, 0);
      let embedCalls = 0;

      const mockFetch: typeof fetch = async (input, init) => {
        const url = String(input);
        clockMs += 10;
        if (url.endsWith('/models')) {
          return new Response(
            JSON.stringify({
              data: [
                {
                  id: 'text-embedding-3:free',
                  name: 'Free Embedding 3',
                  type: 'embedding',
                  pricing: { prompt: '0', completion: '0' },
                  architecture: { input_modalities: ['text'], output_modalities: ['embeddings'] },
                },
                {
                  id: 'whisper-audio:free',
                  name: 'Audio Model',
                  type: 'audio',
                  pricing: { prompt: '0', completion: '0' },
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (url.endsWith('/embeddings')) {
          embedCalls += 1;
          const headersObj = new Headers(init?.headers);
          const auth = headersObj.get('authorization') ?? '';
          if (auth.includes('sk-emb-key1')) {
            return new Response(JSON.stringify({ error: { message: 'rate limited' } }), {
              status: 429,
              headers: { 'Content-Type': 'application/json' },
            });
          }
          return new Response(
            JSON.stringify({
              object: 'list',
              data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2, 0.3] }],
              model: 'text-embedding-3:free',
              usage: { prompt_tokens: 12, total_tokens: 12 },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
      };

      const { db, app, adminCookie } = await setupAdminAndProvider({
        fetchImpl: mockFetch,
        now: () => clockMs,
      });

      try {
        // Install an API-sourced provider so reload-models fetches /models through matchesFreeRule
        const embProvRes = await app.request('http://localhost/api/providers', {
          method: 'POST',
          headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            schemaVersion: '1.0',
            id: 'test-embed-api',
            name: 'Test Embed API',
            packageType: 'official-json',
            baseUrl: 'https://api.embed.example.com/v1',
            auth: { type: 'bearer', header: 'Authorization', prefix: 'Bearer ' },
            modelsSource: 'api',
            modelsEndpoint: '/models',
            freeRule: { priceZeroPaths: ['pricing.prompt', 'pricing.completion'] },
          }),
        });
        assert.equal(embProvRes.status, 201);

        // Add two active keys to test failover on /v1/embeddings
        await app.request('http://localhost/api/providers/test-embed-api/keys', {
          method: 'POST',
          headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({ label: 'Emb Key 1', secret: 'sk-emb-key1-1111' }),
        });
        await app.request('http://localhost/api/providers/test-embed-api/keys', {
          method: 'POST',
          headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({ label: 'Emb Key 2', secret: 'sk-emb-key2-2222' }),
        });

        // Sync models -> embedding model is synced, audio model excluded
        const syncRes = await app.request(
          'http://localhost/api/providers/test-embed-api/reload-models',
          { method: 'POST', headers: { Cookie: adminCookie } },
        );
        assert.equal(syncRes.status, 200);
        const embModelId = 'test-embed-api/text-embedding-3:free';
        const syncedModels = db
          .prepare(`SELECT full_id FROM models WHERE provider_id = 'test-embed-api' AND active = 1`)
          .all() as Array<{ full_id: string }>;
        assert.ok(syncedModels.some((m) => m.full_id === embModelId));
        assert.ok(!syncedModels.some((m) => m.full_id.includes('whisper-audio')));

        // Create internal API key for admin and call POST /v1/embeddings
        const adminKeyRes = await app.request('http://localhost/api/keys', {
          method: 'POST',
          headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Embeddings Key' }),
        });
        const { rawKey: adminApiKey } = (await adminKeyRes.json()) as { rawKey: string };

        const embRes = await app.request('http://localhost/v1/embeddings', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${adminApiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: embModelId,
            input: 'hello bifrost embeddings',
          }),
        });
        assert.equal(embRes.status, 200);
        const embJson = (await embRes.json()) as {
          object: string;
          model: string;
          data: Array<{ embedding: number[] }>;
          usage: { prompt_tokens: number; total_tokens: number };
        };
        assert.equal(embJson.object, 'list');
        assert.equal(embJson.model, embModelId);
        assert.deepEqual(embJson.data[0]?.embedding, [0.1, 0.2, 0.3]);
        assert.equal(embedCalls, 2, 'Should fail over from 429 key1 to healthy key2');

        // Usage logged in usage_logs
        const usageRow = db
          .prepare(
            `SELECT model_full_id, prompt_tokens, status FROM usage_logs WHERE model_full_id = ?`,
          )
          .get(embModelId) as { model_full_id: string; prompt_tokens: number; status: string };
        assert.equal(usageRow.model_full_id, embModelId);
        assert.equal(usageRow.prompt_tokens, 12);
        assert.equal(usageRow.status, 'ok');

        // Guest with allowed_models = [embModelId]: once admin disables model, GET /api/models/* -> 404 and POST /v1/embeddings -> 404
        const guestCookie = await createGuestSession(app, adminCookie, 'guest_emb', [embModelId]);
        const guestKeyRes = await app.request('http://localhost/api/keys', {
          method: 'POST',
          headers: { Cookie: guestCookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Guest Emb Key' }),
        });
        const { rawKey: guestApiKey } = (await guestKeyRes.json()) as { rawKey: string };

        // Before disabling: guest can view GET /api/models/*
        const guestDetailOk = await app.request(
          `http://localhost/api/models/${encodeURIComponent(embModelId)}`,
          { headers: { Cookie: guestCookie } },
        );
        assert.equal(guestDetailOk.status, 200);

        // Disable model by admin
        const disableRes = await app.request(
          `http://localhost/api/models/${encodeURIComponent(embModelId)}/visibility`,
          {
            method: 'PATCH',
            headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
            body: JSON.stringify({ disabledByAdmin: true }),
          },
        );
        assert.equal(disableRes.status, 200);

        // Guest GET /api/models/* -> 404
        const guestDetailHidden = await app.request(
          `http://localhost/api/models/${encodeURIComponent(embModelId)}`,
          { headers: { Cookie: guestCookie } },
        );
        assert.equal(guestDetailHidden.status, 404);

        // Admin GET /api/models/* -> still 200
        const adminDetailStillOk = await app.request(
          `http://localhost/api/models/${encodeURIComponent(embModelId)}`,
          { headers: { Cookie: adminCookie } },
        );
        assert.equal(adminDetailStillOk.status, 200);

        // Guest POST /v1/embeddings on disabled model -> 404
        const guestEmbDisabled = await app.request('http://localhost/v1/embeddings', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${guestApiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ model: embModelId, input: 'blocked' }),
        });
        assert.equal(guestEmbDisabled.status, 404);
      } finally {
        db.close();
      }
    });
  });
});

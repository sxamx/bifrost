import assert from 'node:assert/strict';
import fs from 'node:fs';
import https from 'node:https';
import type net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createApp, runNodesHealthTick } from '../core/src/app.js';
import { decryptSecret, resolveMasterKey, sha256Hex } from '../core/src/crypto.js';
import { openDatabase } from '../core/src/db.js';
import {
  type BifrostNodeInstance,
  createBifrostNodeServer,
  loadOrGenerateTlsMaterial,
} from '../nodes/src/index.js';

function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `bifrost-p3-${prefix}-`));
}

function extractSessionCookie(res: Response): string {
  const setCookie = res.headers.get('set-cookie') ?? '';
  const match = /(bifrost_session=[^;]+)/.exec(setCookie);
  assert.ok(match, `Expected bifrost_session Set-Cookie header, got: ${setCookie}`);
  return match[1]!;
}

function getAvailablePort(server: https.Server): number {
  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('HTTPS server is not listening on a TCP port');
  }
  return addr.port;
}

const SILENT_NODE_LOGGER = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

describe('Phase 3 Backend — Exit Nodes, HTTP CONNECT Zero-Knowledge Routing, Rotation & Health', () => {
  let tmpDir: string;
  let upstreamTlsMaterial: ReturnType<typeof loadOrGenerateTlsMaterial>;
  let upstreamHttpsServer: https.Server;
  let upstreamPort = 0;

  const upstreamRequests: Array<{
    method: string;
    url: string;
    authHeader: string;
    bodyText: string;
  }> = [];

  const activeNodeServers: BifrostNodeInstance[] = [];

  before(async () => {
    tmpDir = createTempDir('suite');
    upstreamTlsMaterial = loadOrGenerateTlsMaterial();

    upstreamHttpsServer = https.createServer(
      {
        cert: upstreamTlsMaterial.certPem,
        key: upstreamTlsMaterial.keyPem,
      },
      (req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          const bodyText = Buffer.concat(chunks).toString('utf8');
          const authHeader = String(req.headers.authorization ?? '');
          const reqUrl = req.url ?? '/';

          upstreamRequests.push({
            method: req.method ?? 'GET',
            url: reqUrl,
            authHeader,
            bodyText,
          });

          if (req.method === 'GET' && reqUrl === '/models') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                data: [
                  {
                    id: 'meta-llama/llama-3.3-70b-instruct:free',
                    name: 'Llama 3.3 70B Free',
                    created: 1735000000,
                    context_length: 131072,
                    pricing: { prompt: '0', completion: '0' },
                    architecture: {
                      input_modalities: ['text'],
                      output_modalities: ['text'],
                    },
                    supported_parameters: ['tools'],
                  },
                ],
              }),
            );
            return;
          }

          if (req.method === 'POST' && reqUrl === '/chat/completions') {
            let parsedBody: Record<string, unknown> = {};
            try {
              parsedBody = JSON.parse(bodyText) as Record<string, unknown>;
            } catch {
              parsedBody = {};
            }

            if (parsedBody.stream === true) {
              res.writeHead(200, {
                'Content-Type': 'text/event-stream; charset=utf-8',
                'Cache-Control': 'no-cache',
                Connection: 'close',
              });
              res.write(
                `data: ${JSON.stringify({
                  id: 'chatcmpl-p3-stream',
                  object: 'chat.completion.chunk',
                  choices: [{ index: 0, delta: { content: 'Tunneled ' }, finish_reason: null }],
                })}\n\n`,
              );
              res.write(
                `data: ${JSON.stringify({
                  id: 'chatcmpl-p3-stream',
                  object: 'chat.completion.chunk',
                  choices: [{ index: 0, delta: { content: 'SSE OK' }, finish_reason: 'stop' }],
                  usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 },
                })}\n\n`,
              );
              res.end('data: [DONE]\n\n');
              return;
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                id: 'chatcmpl-p3-json',
                object: 'chat.completion',
                created: 1735000100,
                model: parsedBody.model ?? 'meta-llama/llama-3.3-70b-instruct:free',
                choices: [
                  {
                    index: 0,
                    message: {
                      role: 'assistant',
                      content: `Verified TLS response via key ${authHeader.slice(-4)}`,
                    },
                    finish_reason: 'stop',
                  },
                ],
                usage: {
                  prompt_tokens: 12,
                  completion_tokens: 7,
                  total_tokens: 19,
                },
              }),
            );
            return;
          }

          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not Found' }));
        });
      },
    );

    await new Promise<void>((resolve) => {
      upstreamHttpsServer.listen(0, '127.0.0.1', () => resolve());
    });
    upstreamPort = getAvailablePort(upstreamHttpsServer);
  });

  after(async () => {
    for (const n of activeNodeServers) {
      await n.stop().catch(() => {});
    }
    await new Promise<void>((resolve) => {
      upstreamHttpsServer.close(() => resolve());
    });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('end-to-end Phase 3 lifecycle: HU-11, HU-11b, HTTP CONNECT zero-knowledge TLS routing, HU-08, HU-11d, HU-11c, HU-12 & HU-13', async () => {
    const dataDir = path.join(tmpDir, 'data');
    const resolved = resolveMasterKey({ dataDir, env: {} });
    const db = openDatabase(resolved.dbPath);

    let fakeNowMs = 1_760_000_000_000;
    const app = createApp({
      db,
      masterKey: resolved.key,
      now: () => fakeNowMs,
      upstreamTls: {
        pinnedFingerprintSha256: upstreamTlsMaterial.fingerprintSha256,
      },
    });

    try {
      // 1. Setup admin & create internal API key sk-bf-... + non-admin guest user
      const setupRes = await app.request('http://bifrost.local/api/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'StrongAdminPassword123!' }),
      });
      assert.equal(setupRes.status, 201);
      const adminCookie = extractSessionCookie(setupRes);

      const createBfKeyRes = await app.request('http://bifrost.local/api/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({ name: 'Phase3 CLI Key' }),
      });
      assert.equal(createBfKeyRes.status, 201);
      const { rawKey: bfApiKey } = (await createBfKeyRes.json()) as { rawKey: string };

      // Verify /install-node.sh is served cleanly
      const scriptRes = await app.request('http://bifrost.local/install-node.sh');
      assert.equal(scriptRes.status, 200);
      const scriptText = await scriptRes.text();
      assert.ok(scriptText.includes('#!/usr/bin/env bash'));
      assert.ok(scriptText.includes('--token'));

      // Verify guest is denied access to /api/nodes (admin-only)
      db.prepare(
        `INSERT INTO users (id, username, password_hash, role, created_at)
         VALUES ('guest-u1', 'guest', ?, 'guest', ?)`,
      ).run('scrypt$16384$8$1$aaaa$bbbb', Math.floor(fakeNowMs / 1000));
      db.prepare(
        `INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at)
         VALUES ('guest-s1', 'guest-u1', ?, ?, ?)`,
      ).run(
        sha256Hex('guest-raw-session'),
        Math.floor(fakeNowMs / 1000) + 3600,
        Math.floor(fakeNowMs / 1000),
      );

      const guestNodesRes = await app.request('http://bifrost.local/api/nodes', {
        headers: { Cookie: 'bifrost_session=guest-raw-session' },
      });
      assert.equal(guestNodesRes.status, 403);

      // 2. Reserve ephemeral ports for two real Bifrost Egress Nodes:
      //    - Node 1: tailscale mode (HTTP control + HTTP CONNECT)
      //    - Node 2: public_ip mode (TLS control + TLS HTTP CONNECT with SHA-256 cert pinning)
      const node2Tls = loadOrGenerateTlsMaterial();
      const node1StatePath = path.join(tmpDir, 'node1-state.json');
      const node2StatePath = path.join(tmpDir, 'node2-state.json');

      // Pre-allocate ports by starting temporary listeners or starting nodes after registration:
      // Let's allocate two free ports cleanly first so we pass exact endpoints to POST /api/nodes!
      const getFreeTcpPort = async (): Promise<number> => {
        const netMod = await import('node:net');
        return new Promise((resolvePort, rejectPort) => {
          const srv = netMod.default.createServer();
          srv.listen(0, '127.0.0.1', () => {
            const addr = srv.address();
            const port = addr && typeof addr === 'object' ? addr.port : 0;
            srv.close((err) => (err ? rejectPort(err) : resolvePort(port)));
          });
        });
      };

      const node1Port = await getFreeTcpPort();
      const node2Port = await getFreeTcpPort();

      // HU-11: Register Node 1 (tailscale)
      const regNode1Res = await app.request('http://bifrost.local/api/nodes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({
          name: 'Tailscale Exit Frankfurt',
          mode: 'tailscale',
          endpoint: `127.0.0.1:${node1Port}`,
        }),
      });
      assert.equal(regNode1Res.status, 201);
      const regNode1Body = (await regNode1Res.json()) as {
        node: { id: string; status: string; mode: string; endpoint: string };
        rawToken: string;
        installCommand: string;
        publicIpWarning: string | null;
      };
      assert.equal(regNode1Body.node.mode, 'tailscale');
      assert.equal(regNode1Body.node.status, 'offline');
      assert.equal(regNode1Body.publicIpWarning, null);
      assert.ok(regNode1Body.rawToken.length >= 40);
      assert.ok(regNode1Body.installCommand.includes(regNode1Body.rawToken));
      assert.ok(
        regNode1Body.installCommand.includes('http://bifrost.local/install-node.sh'),
      );

      // HU-11b: Register Node 2 (public_ip with SHA-256 fingerprint pinning & explicit security warning)
      const regNode2Res = await app.request('http://bifrost.local/api/nodes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({
          name: 'Public VPS Tokyo',
          mode: 'public_ip',
          endpoint: `127.0.0.1:${node2Port}`,
          tlsFingerprint: node2Tls.fingerprintSha256,
        }),
      });
      assert.equal(regNode2Res.status, 201);
      const regNode2Body = (await regNode2Res.json()) as {
        node: { id: string; status: string; mode: string; tlsFingerprint: string | null };
        rawToken: string;
        installCommand: string;
        publicIpWarning: string | null;
      };
      assert.equal(regNode2Body.node.mode, 'public_ip');
      assert.ok(
        typeof regNode2Body.publicIpWarning === 'string' &&
          regNode2Body.publicIpWarning.length > 20,
        'Expected explicit security warning for public_ip node',
      );
      assert.ok(regNode2Body.installCommand.includes('--mode public_ip'));

      // Verify GET /api/nodes NEVER exposes rawToken, token_hash, or encrypted_token
      const listNodesInitialRes = await app.request('http://bifrost.local/api/nodes', {
        headers: { Cookie: adminCookie },
      });
      assert.equal(listNodesInitialRes.status, 200);
      const listNodesInitialText = await listNodesInitialRes.text();
      assert.ok(!listNodesInitialText.includes(regNode1Body.rawToken));
      assert.ok(!listNodesInitialText.includes(regNode2Body.rawToken));
      assert.ok(!listNodesInitialText.includes('token_hash'));
      assert.ok(!listNodesInitialText.includes('encrypted_token'));

      // Verify DB stores SHA-256 token_hash + AES-256-GCM encrypted_token (not plaintext)
      const rawNode1DbRow = db
        .prepare(`SELECT token_hash, encrypted_token FROM nodes WHERE id = ?`)
        .get(regNode1Body.node.id) as { token_hash: string; encrypted_token: Uint8Array };
      assert.equal(rawNode1DbRow.token_hash, sha256Hex(regNode1Body.rawToken));
      assert.ok(
        !Buffer.from(rawNode1DbRow.encrypted_token)
          .toString('utf8')
          .includes(regNode1Body.rawToken),
      );
      assert.equal(
        decryptSecret(rawNode1DbRow.encrypted_token, resolved.key),
        regNode1Body.rawToken,
      );

      // 3. Spin up REAL Bifrost Egress Node servers for Node 1 and Node 2!
      //    Attach a raw TCP byte inspector on Node 1 to prove zero-knowledge TLS tunneling.
      const node1RawWireChunks: Buffer[] = [];
      let node1ConnectCount = 0;
      let node2ConnectCount = 0;

      let node1Instance = createBifrostNodeServer({
        mode: 'tailscale',
        bindHost: '127.0.0.1',
        port: node1Port,
        token: regNode1Body.rawToken,
        stateFilePath: node1StatePath,
        allowPrivateTargets: true,
        allowedPorts: [upstreamPort],
        now: () => fakeNowMs,
        logger: SILENT_NODE_LOGGER,
      });
      node1Instance.server.on('connection', (sock: net.Socket) => {
        sock.on('data', (chunk: Buffer) => {
          node1RawWireChunks.push(Buffer.from(chunk));
        });
      });
      node1Instance.server.on('connect', () => {
        node1ConnectCount += 1;
      });
      await node1Instance.start();
      activeNodeServers.push(node1Instance);

      const node2Instance = createBifrostNodeServer({
        mode: 'public_ip',
        bindHost: '127.0.0.1',
        port: node2Port,
        token: regNode2Body.rawToken,
        stateFilePath: node2StatePath,
        tlsCertPem: node2Tls.certPem,
        tlsKeyPem: node2Tls.keyPem,
        allowPrivateTargets: true,
        allowedPorts: [upstreamPort],
        now: () => fakeNowMs,
        logger: SILENT_NODE_LOGGER,
      });
      node2Instance.server.on('connect', () => {
        node2ConnectCount += 1;
      });
      await node2Instance.start();
      activeNodeServers.push(node2Instance);

      // Run health tick -> both Node 1 (tailscale) and Node 2 (public_ip + pinned SHA-256 cert) become online!
      fakeNowMs += 5_000;
      const tick1 = await runNodesHealthTick(db, resolved.key, { now: () => fakeNowMs });
      assert.equal(tick1.checkedCount, 2);
      assert.equal(tick1.onlineCount, 2);
      assert.equal(tick1.unresponsiveCount, 0);

      // Also verify TLS pinning rejects a tampered fingerprint on public_ip node!
      const badFpPort = await getFreeTcpPort();
      const badTlsNode = createBifrostNodeServer({
        mode: 'public_ip',
        bindHost: '127.0.0.1',
        port: badFpPort,
        token: 'a'.repeat(43),
        allowPrivateTargets: true,
        allowedPorts: [upstreamPort],
        now: () => fakeNowMs,
        logger: SILENT_NODE_LOGGER,
      });
      await badTlsNode.start();
      activeNodeServers.push(badTlsNode);

      const regBadFpRes = await app.request('http://bifrost.local/api/nodes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({
          name: 'Mismatched TLS Pin Node',
          mode: 'public_ip',
          endpoint: `127.0.0.1:${badFpPort}`,
          tlsFingerprint: 'F'.repeat(64), // Wrong SHA-256 cert fingerprint
        }),
      });
      assert.equal(regBadFpRes.status, 201);
      const regBadFpBody = (await regBadFpRes.json()) as { node: { id: string } };
      const tickWithBadPin = await runNodesHealthTick(db, resolved.key, {
        now: () => fakeNowMs,
      });
      assert.equal(tickWithBadPin.onlineCount, 2, 'Mismatched TLS pin must NOT come online');
      // Clean up the mismatched pin test node so remaining tests focus on Node 1 & Node 2
      await app.request(`http://bifrost.local/api/nodes/${regBadFpBody.node.id}`, {
        method: 'DELETE',
        headers: { Cookie: adminCookie },
      });
      await badTlsNode.stop();

      // 4. Install OpenRouter pointing at our HTTPS mock provider + test HU-08 & zero-knowledge HTTP CONNECT!
      const installOrRes = await app.request('http://bifrost.local/api/providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({
          schemaVersion: '1.0',
          id: 'openrouter',
          name: 'OpenRouter HTTPS',
          category: 'aggregator',
          packageType: 'official-json',
          verified: true,
          baseUrl: `https://127.0.0.1:${upstreamPort}`,
          auth: {
            type: 'bearer',
            header: 'Authorization',
            prefix: 'Bearer ',
          },
          modelsSource: 'api',
          modelsEndpoint: '/models',
          freeRule: {
            priceZeroPaths: ['pricing.prompt', 'pricing.completion'],
            idSuffix: ':free',
          },
        }),
      });
      assert.equal(installOrRes.status, 201);

      // Add Key 1 -> auto-assigned to Node 1 (first online node with 0 keys for openrouter)
      const secretKey1 = 'sk-or-v1-supersecret-alpha-1111';
      const addKey1Res = await app.request(
        'http://bifrost.local/api/providers/openrouter/keys',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
          body: JSON.stringify({ label: 'OR Key Alpha', secret: secretKey1 }),
        },
      );
      assert.equal(addKey1Res.status, 201);
      const key1Body = (await addKey1Res.json()) as {
        key: { id: string; nodeId: string | null; forcedNode: boolean; last4: string };
      };
      assert.equal(key1Body.key.nodeId, regNode1Body.node.id);
      assert.equal(key1Body.key.forcedNode, false);

      // Detect models -> tunneled through Node 1 via HTTP CONNECT + end-to-end TLS!
      const detectRes = await app.request(
        'http://bifrost.local/api/providers/openrouter/detect-models',
        {
          method: 'POST',
          headers: { Cookie: adminCookie },
        },
      );
      assert.equal(detectRes.status, 200);
      const detectDiff = (await detectRes.json()) as { totalActive: number };
      assert.equal(detectDiff.totalActive, 1);
      assert.ok(node1ConnectCount >= 1, 'Expected detect-models to tunnel via Node 1 CONNECT');

      // Execute non-streaming AND streaming chat completions through Node 1!
      const secretPromptText = 'ULTRA_CONFIDENTIAL_PROMPT_99887766';
      const chatJsonRes = await app.request('http://bifrost.local/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${bfApiKey}`,
        },
        body: JSON.stringify({
          model: 'openrouter/meta-llama/llama-3.3-70b-instruct:free',
          stream: false,
          messages: [{ role: 'user', content: secretPromptText }],
        }),
      });
      assert.equal(chatJsonRes.status, 200);
      const chatJsonBody = (await chatJsonRes.json()) as {
        choices: Array<{ message: { content: string } }>;
      };
      assert.equal(
        chatJsonBody.choices[0]?.message.content,
        'Verified TLS response via key 1111',
      );

      const chatStreamRes = await app.request('http://bifrost.local/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${bfApiKey}`,
        },
        body: JSON.stringify({
          model: 'openrouter/meta-llama/llama-3.3-70b-instruct:free',
          stream: true,
          messages: [{ role: 'user', content: secretPromptText }],
        }),
      });
      assert.equal(chatStreamRes.status, 200);
      const sseText = await chatStreamRes.text();
      assert.ok(sseText.includes('Tunneled '));
      assert.ok(sseText.includes('SSE OK'));
      assert.ok(sseText.includes('data: [DONE]'));

      // CRITICAL ZERO-KNOWLEDGE PROOF:
      // Inspect raw wire bytes observed by Node 1 across ALL connections:
      // Node 1 MUST see `CONNECT 127.0.0.1:<upstreamPort>` and MUST NEVER see the provider API key or prompt!
      const allNode1WireLatin1 = Buffer.concat(node1RawWireChunks).toString('latin1');
      assert.ok(
        allNode1WireLatin1.includes(`CONNECT 127.0.0.1:${upstreamPort} HTTP/1.1`),
        'Expected raw HTTP CONNECT header on Node 1 wire',
      );
      assert.ok(
        !allNode1WireLatin1.includes(secretKey1),
        'Provider API key MUST NEVER appear in plaintext on the egress node wire!',
      );
      assert.ok(
        !allNode1WireLatin1.includes(secretPromptText),
        'Chat prompt MUST NEVER appear in plaintext on the egress node wire!',
      );

      // 5. HU-08 & HU-11d: Multi-Key Balancing & Same-Provider Collision Confirmation
      const secretKey2 = 'sk-or-v1-supersecret-bravo-2222';
      const addKey2Res = await app.request(
        'http://bifrost.local/api/providers/openrouter/keys',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
          body: JSON.stringify({ label: 'OR Key Bravo', secret: secretKey2 }),
        },
      );
      assert.equal(addKey2Res.status, 201);
      const key2Body = (await addKey2Res.json()) as {
        key: { id: string; nodeId: string | null; forcedNode: boolean };
      };
      assert.equal(
        key2Body.key.nodeId,
        regNode2Body.node.id,
        'Second OpenRouter key must auto-balance onto Node 2',
      );

      // Independent balancing across DIFFERENT providers:
      // Install a second provider (`groq`) and verify its first key auto-assigns to Node 1 (0 groq keys on Node 1!)
      const installGroqRes = await app.request('http://bifrost.local/api/providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({
          schemaVersion: '1.0',
          id: 'groq',
          name: 'Groq Cloud',
          category: 'official-api',
          packageType: 'official-json',
          verified: true,
          baseUrl: `https://127.0.0.1:${upstreamPort}`,
          auth: { type: 'bearer', header: 'Authorization', prefix: 'Bearer ' },
          modelsSource: 'static',
          reviewedAt: '2026-04-01',
          staticModels: [{ id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B' }],
        }),
      });
      assert.equal(installGroqRes.status, 201);

      const addGroqKeyRes = await app.request('http://bifrost.local/api/providers/groq/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({ label: 'Groq Primary', secret: 'gsk_independent_provider_3333' }),
      });
      assert.equal(addGroqKeyRes.status, 201);
      const groqKeyBody = (await addGroqKeyRes.json()) as {
        key: { id: string; nodeId: string | null; forcedNode: boolean };
      };
      assert.equal(
        groqKeyBody.key.nodeId,
        regNode1Body.node.id,
        'Different provider must balance independently and assign to Node 1 without collision',
      );
      assert.equal(groqKeyBody.key.forcedNode, false);

      // HU-11d: Attempting to move OpenRouter Key 2 onto Node 1 (which already holds OpenRouter Key 1)
      // WITHOUT confirmForce MUST return 409 NODE_PROVIDER_COLLISION!
      const collisionRes = await app.request(
        `http://bifrost.local/api/providers/openrouter/keys/${key2Body.key.id}/node`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
          body: JSON.stringify({ nodeId: regNode1Body.node.id }),
        },
      );
      assert.equal(collisionRes.status, 409);
      const collisionBody = (await collisionRes.json()) as {
        code: string;
        requiresConfirmation: boolean;
        existingKeys: Array<{ id: string; last4: string }>;
        error: {
          code: string;
          requiresConfirmation: boolean;
          existingKeys: Array<{ id: string; last4: string }>;
        };
      };
      assert.equal(collisionBody.code, 'NODE_PROVIDER_COLLISION');
      assert.equal(collisionBody.requiresConfirmation, true);
      assert.equal(collisionBody.error.code, 'NODE_PROVIDER_COLLISION');
      assert.equal(collisionBody.error.requiresConfirmation, true);
      assert.equal(collisionBody.existingKeys.length, 1);
      assert.equal(collisionBody.existingKeys[0]?.id, key1Body.key.id);
      assert.equal(collisionBody.existingKeys[0]?.last4, '1111');

      // Confirming with confirmForce: true succeeds and sets forcedNode = true!
      const forceAssignRes = await app.request(
        `http://bifrost.local/api/providers/openrouter/keys/${key2Body.key.id}/node`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
          body: JSON.stringify({ nodeId: regNode1Body.node.id, confirmForce: true }),
        },
      );
      assert.equal(forceAssignRes.status, 200);
      const forceAssignBody = (await forceAssignRes.json()) as {
        key: { nodeId: string; forcedNode: boolean };
      };
      assert.equal(forceAssignBody.key.nodeId, regNode1Body.node.id);
      assert.equal(forceAssignBody.key.forcedNode, true);

      // Move OpenRouter Key 2 back to Node 2 so each node holds 1 OpenRouter key for failover testing
      const moveBackRes = await app.request(
        `http://bifrost.local/api/providers/openrouter/keys/${key2Body.key.id}/node`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
          body: JSON.stringify({ nodeId: regNode2Body.node.id }),
        },
      );
      assert.equal(moveBackRes.status, 200);
      const moveBackBody = (await moveBackRes.json()) as {
        key: { nodeId: string; forcedNode: boolean };
      };
      assert.equal(moveBackBody.key.nodeId, regNode2Body.node.id);
      assert.equal(moveBackBody.key.forcedNode, false);

      // 6. HU-11c: Live Token Rotation with 5-Minute Grace Window + Automatic 24h Rotation
      const oldNode1Token = regNode1Body.rawToken;
      fakeNowMs += 10_000;
      const rotateRes = await app.request(
        `http://bifrost.local/api/nodes/${regNode1Body.node.id}/rotate`,
        {
          method: 'POST',
          headers: { Cookie: adminCookie },
        },
      );
      assert.equal(rotateRes.status, 200);
      const rotateBody = (await rotateRes.json()) as {
        ok: boolean;
        graceSeconds: number;
        lastRotatedAt: number;
        prevTokenExpiresAt: number;
      };
      assert.equal(rotateBody.ok, true);
      assert.equal(rotateBody.graceSeconds, 300);
      assert.equal(rotateBody.prevTokenExpiresAt - rotateBody.lastRotatedAt, 300);

      // Verify DB has updated token_hash and preserved prev_token_hash
      const rotatedDbRow = db
        .prepare(
          `SELECT token_hash, prev_token_hash, prev_token_expires_at, encrypted_token
           FROM nodes WHERE id = ?`,
        )
        .get(regNode1Body.node.id) as {
        token_hash: string;
        prev_token_hash: string;
        prev_token_expires_at: number;
        encrypted_token: Uint8Array;
      };
      assert.equal(rotatedDbRow.prev_token_hash, sha256Hex(oldNode1Token));
      assert.notEqual(rotatedDbRow.token_hash, sha256Hex(oldNode1Token));
      const newRotatedToken = decryptSecret(rotatedDbRow.encrypted_token, resolved.key);
      assert.notEqual(newRotatedToken, oldNode1Token);

      // During the 5-minute grace window (+120s < 300s), the OLD token still works on Node 1
      fakeNowMs += 120_000;
      const graceHealthRes = await fetch(`http://127.0.0.1:${node1Port}/_bifrost/health`, {
        headers: { Authorization: `Bearer ${oldNode1Token}` },
      });
      assert.equal(
        graceHealthRes.status,
        200,
        'Old token must remain valid within 5m grace window',
      );

      // And core/ seamlessly routes chat completions using the NEW token!
      const postRotateChat = await app.request('http://bifrost.local/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${bfApiKey}`,
        },
        body: JSON.stringify({
          model: 'openrouter/meta-llama/llama-3.3-70b-instruct:free',
          messages: [{ role: 'user', content: 'After rotation test' }],
        }),
      });
      assert.equal(postRotateChat.status, 200);

      // Advance clock by +25 hours (> 24h) -> runNodesHealthTick automatically rotates both nodes
      // and expires old grace tokens!
      fakeNowMs += 25 * 3600 * 1000;
      const oldTokenAfter25hRes = await fetch(`http://127.0.0.1:${node1Port}/_bifrost/health`, {
        headers: { Authorization: `Bearer ${oldNode1Token}` },
      });
      assert.equal(
        oldTokenAfter25hRes.status,
        401,
        'Old token must be rejected after 5m grace window expires',
      );

      const autoRotateTick = await runNodesHealthTick(db, resolved.key, {
        now: () => fakeNowMs,
      });
      assert.equal(
        autoRotateTick.rotatedNodeIds.length,
        2,
        'Expected automatic 24h rotation for both online nodes',
      );

      // 7. HU-12: >120s Unresponsive Detection, Automatic Key `no_node` Marking, Failover to Node 2, & Recovery
      await node1Instance.stop();

      // At +60s without heartbeat (<= 120s), Node 1 is NOT yet marked unresponsive
      fakeNowMs += 60_000;
      const tick60s = await runNodesHealthTick(db, resolved.key, {
        now: () => fakeNowMs,
        timeoutMs: 500,
      });
      assert.equal(tick60s.unresponsiveCount, 0);

      // At +130s without heartbeat (> 120s), Node 1 transitions to `unresponsive` and its keys become `no_node`!
      fakeNowMs += 70_000; // total 130s since last_seen_at
      const tick130s = await runNodesHealthTick(db, resolved.key, {
        now: () => fakeNowMs,
        timeoutMs: 500,
      });
      assert.equal(tick130s.unresponsiveCount, 1);
      assert.equal(tick130s.onlineCount, 1);

      const keysDuringOutageRes = await app.request(
        'http://bifrost.local/api/providers/openrouter/keys',
        { headers: { Cookie: adminCookie } },
      );
      const keysDuringOutage = (await keysDuringOutageRes.json()) as {
        keys: Array<{ id: string; status: string }>;
      };
      const k1Outage = keysDuringOutage.keys.find((k) => k.id === key1Body.key.id);
      const k2Outage = keysDuringOutage.keys.find((k) => k.id === key2Body.key.id);
      assert.equal(k1Outage?.status, 'no_node', 'Key 1 on unresponsive Node 1 must be no_node');
      assert.equal(k2Outage?.status, 'active', 'Key 2 on healthy Node 2 must remain active');

      // Chat completions MUST automatically route via Key 2 on Node 2 (public_ip TLS tunnel)!
      const node2ConnectsBefore = node2ConnectCount;
      const failoverChatRes = await app.request('http://bifrost.local/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${bfApiKey}`,
        },
        body: JSON.stringify({
          model: 'openrouter/meta-llama/llama-3.3-70b-instruct:free',
          messages: [{ role: 'user', content: 'Route via healthy Node 2' }],
        }),
      });
      assert.equal(failoverChatRes.status, 200);
      const failoverChatBody = (await failoverChatRes.json()) as {
        choices: Array<{ message: { content: string } }>;
      };
      assert.equal(
        failoverChatBody.choices[0]?.message.content,
        'Verified TLS response via key 2222',
      );
      assert.ok(
        node2ConnectCount > node2ConnectsBefore,
        'Expected failover chat completion to tunnel through Node 2 (public_ip TLS)',
      );

      // Restart Node 1 reading its persisted rotated token state -> runNodesHealthTick restores Node 1 & Key 1!
      node1Instance = createBifrostNodeServer({
        mode: 'tailscale',
        bindHost: '127.0.0.1',
        port: node1Port,
        stateFilePath: node1StatePath,
        allowPrivateTargets: true,
        allowedPorts: [upstreamPort],
        now: () => fakeNowMs,
        logger: SILENT_NODE_LOGGER,
      });
      await node1Instance.start();
      activeNodeServers.push(node1Instance);

      fakeNowMs += 30_000;
      const recoveryTick = await runNodesHealthTick(db, resolved.key, {
        now: () => fakeNowMs,
      });
      assert.equal(recoveryTick.onlineCount, 2);
      assert.equal(recoveryTick.unresponsiveCount, 0);

      const keysAfterRecoveryRes = await app.request(
        'http://bifrost.local/api/providers/openrouter/keys',
        { headers: { Cookie: adminCookie } },
      );
      const keysAfterRecovery = (await keysAfterRecoveryRes.json()) as {
        keys: Array<{ id: string; status: string }>;
      };
      assert.equal(
        keysAfterRecovery.keys.find((k) => k.id === key1Body.key.id)?.status,
        'active',
        'Key 1 must automatically recover to active when Node 1 returns online',
      );

      // 8. HU-13: Remove Node 2 Showing Affected Keys & Transitioning Keys to `no_node`
      const nodesBeforeDeleteRes = await app.request('http://bifrost.local/api/nodes', {
        headers: { Cookie: adminCookie },
      });
      const nodesBeforeDelete = (await nodesBeforeDeleteRes.json()) as {
        nodes: Array<{
          id: string;
          assignedKeysCount: number;
          assignedKeys: Array<{ id: string; label: string; last4: string; providerId: string }>;
          affectedKeys: Array<{ id: string; label: string; last4: string; providerId: string }>;
        }>;
      };
      const node2Summary = nodesBeforeDelete.nodes.find((n) => n.id === regNode2Body.node.id);
      assert.ok(node2Summary);
      assert.equal(node2Summary.assignedKeysCount, 1);
      assert.equal(node2Summary.assignedKeys[0]?.id, key2Body.key.id);
      assert.equal(node2Summary.affectedKeys[0]?.last4, '2222');

      const deleteNode2Res = await app.request(
        `http://bifrost.local/api/nodes/${regNode2Body.node.id}`,
        {
          method: 'DELETE',
          headers: { Cookie: adminCookie },
        },
      );
      assert.equal(deleteNode2Res.status, 200);
      const deleteNode2Body = (await deleteNode2Res.json()) as {
        ok: boolean;
        affectedKeysCount: number;
        affectedKeys: Array<{ id: string; providerId: string; label: string; last4: string }>;
      };
      assert.equal(deleteNode2Body.ok, true);
      assert.equal(deleteNode2Body.affectedKeysCount, 1);
      assert.equal(deleteNode2Body.affectedKeys[0]?.id, key2Body.key.id);
      assert.equal(deleteNode2Body.affectedKeys[0]?.last4, '2222');

      const keysAfterDeleteNode2Res = await app.request(
        'http://bifrost.local/api/providers/openrouter/keys',
        { headers: { Cookie: adminCookie } },
      );
      const keysAfterDeleteNode2 = (await keysAfterDeleteNode2Res.json()) as {
        keys: Array<{ id: string; nodeId: string | null; forcedNode: boolean; status: string }>;
      };
      const k2AfterDelete = keysAfterDeleteNode2.keys.find((k) => k.id === key2Body.key.id);
      assert.equal(k2AfterDelete?.nodeId, null);
      assert.equal(k2AfterDelete?.forcedNode, false);
      assert.equal(k2AfterDelete?.status, 'no_node');

      // Unassigning / re-enabling direct egress (`nodeId: null`) restores `no_node` key to `active`
      const restoreDirectRes = await app.request(
        `http://bifrost.local/api/providers/openrouter/keys/${key2Body.key.id}/node`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
          body: JSON.stringify({ nodeId: null }),
        },
      );
      assert.equal(restoreDirectRes.status, 200);
      const restoreDirectBody = (await restoreDirectRes.json()) as {
        key: { nodeId: string | null; status: string };
      };
      assert.equal(restoreDirectBody.key.nodeId, null);
      assert.equal(restoreDirectBody.key.status, 'active');

      // 9. Security audit of system_logs: verify node events were logged and ZERO secrets leaked
      const logRows = db
        .prepare(`SELECT level, category, message, meta_json FROM system_logs`)
        .all() as Array<Record<string, unknown>>;
      const nodeLogs = logRows.filter((r) => r.category === 'node');
      assert.ok(
        nodeLogs.length >= 6,
        `Expected >= 6 node lifecycle events in system_logs, found ${nodeLogs.length}`,
      );

      const serializedLogs = JSON.stringify(logRows);
      assert.ok(!serializedLogs.includes(regNode1Body.rawToken));
      assert.ok(!serializedLogs.includes(regNode2Body.rawToken));
      assert.ok(!serializedLogs.includes(newRotatedToken));
      assert.ok(!serializedLogs.includes(secretKey1));
      assert.ok(!serializedLogs.includes(secretKey2));
      assert.ok(!serializedLogs.includes(bfApiKey));
    } finally {
      db.close();
    }
  });

  it('validates node input constraints, duplicate endpoints, and explicit POST key collision confirmation', async () => {
    const dataDir = path.join(tmpDir, 'data-edge');
    const resolved = resolveMasterKey({ dataDir, env: {} });
    const db = openDatabase(resolved.dbPath);
    const app = createApp({ db, masterKey: resolved.key });

    try {
      const setupRes = await app.request('http://bifrost.local/api/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'StrongAdminPassword123!' }),
      });
      const adminCookie = extractSessionCookie(setupRes);

      // Invalid mode / invalid endpoint / invalid tlsFingerprint -> 400
      const badModeRes = await app.request('http://bifrost.local/api/nodes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({ name: 'Bad Mode', mode: 'wireguard', endpoint: '10.0.0.1:9443' }),
      });
      assert.equal(badModeRes.status, 400);

      const badEpRes = await app.request('http://bifrost.local/api/nodes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({
          name: 'Bad Endpoint',
          mode: 'tailscale',
          endpoint: 'not a valid host/path',
        }),
      });
      assert.equal(badEpRes.status, 400);

      const badFpRes = await app.request('http://bifrost.local/api/nodes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({
          name: 'Bad Fingerprint',
          mode: 'public_ip',
          endpoint: '203.0.113.10:9443',
          tlsFingerprint: 'not-hex-64',
        }),
      });
      assert.equal(badFpRes.status, 400);

      // Register valid node & reject duplicate endpoint with 409
      const okNodeRes = await app.request('http://bifrost.local/api/nodes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({
          name: 'Node One',
          mode: 'tailscale',
          endpoint: '100.64.0.10:9443',
        }),
      });
      assert.equal(okNodeRes.status, 201);
      const okNodeBody = (await okNodeRes.json()) as { node: { id: string } };

      const dupNodeRes = await app.request('http://bifrost.local/api/nodes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({
          name: 'Duplicate Endpoint Node',
          mode: 'tailscale',
          endpoint: '100.64.0.10:9443',
        }),
      });
      assert.equal(dupNodeRes.status, 409);

      // Explicit nodeId collision during POST /api/providers/:id/keys
      await app.request('http://bifrost.local/api/providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({
          schemaVersion: '1.0',
          id: 'cerebras',
          name: 'Cerebras',
          packageType: 'official-json',
          baseUrl: 'https://api.cerebras.ai/v1',
          auth: { type: 'bearer', header: 'Authorization', prefix: 'Bearer ' },
          modelsSource: 'static',
          reviewedAt: '2026-04-01',
          staticModels: [{ id: 'llama3.1-8b', name: 'Llama 3.1 8B' }],
        }),
      });

      const firstKeyRes = await app.request('http://bifrost.local/api/providers/cerebras/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({
          label: 'Cerebras 1',
          secret: 'csk-key-alpha-0001',
          nodeId: okNodeBody.node.id,
        }),
      });
      assert.equal(firstKeyRes.status, 201);

      const secondKeyUnconfirmedRes = await app.request(
        'http://bifrost.local/api/providers/cerebras/keys',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
          body: JSON.stringify({
            label: 'Cerebras 2',
            secret: 'csk-key-bravo-0002',
            nodeId: okNodeBody.node.id,
          }),
        },
      );
      assert.equal(secondKeyUnconfirmedRes.status, 409);

      const secondKeyConfirmedRes = await app.request(
        'http://bifrost.local/api/providers/cerebras/keys',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
          body: JSON.stringify({
            label: 'Cerebras 2',
            secret: 'csk-key-bravo-0002',
            nodeId: okNodeBody.node.id,
            confirmForce: true,
          }),
        },
      );
      assert.equal(secondKeyConfirmedRes.status, 201);
      const secondKeyConfirmed = (await secondKeyConfirmedRes.json()) as {
        key: { forcedNode: boolean; status: string };
      };
      assert.equal(secondKeyConfirmed.key.forcedNode, true);
      assert.equal(
        secondKeyConfirmed.key.status,
        'no_node',
        'Assigning to an offline node marks key no_node until node heartbeat succeeds',
      );
    } finally {
      db.close();
    }
  });
});

import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import { describe, it } from 'node:test';
import { createApp } from '../core/src/app.js';
import { exportEncryptedBackup, importEncryptedBackup } from '../core/src/backup.js';
import { encryptSecret } from '../core/src/crypto.js';
import { openDatabase } from '../core/src/db.js';
import { closeHttpServer, createOfflineFetch } from './helpers/test-app.js';

const TEST_MANIFEST = {
  schemaVersion: '1.0',
  id: 'egress-prov',
  name: 'Egress Test Provider',
  category: 'official-api',
  packageType: 'official-json',
  verified: true,
  baseUrl: 'https://api.example.com/v1',
  auth: {
    type: 'bearer',
    header: 'Authorization',
    prefix: 'Bearer ',
  },
  modelsSource: 'api',
  modelsEndpoint: '/models',
};

async function startCountingHttpServer(): Promise<{
  server: http.Server;
  host: string;
  port: number;
  getConnections: () => number;
  close: () => Promise<void>;
}> {
  let connectionCount = 0;
  const server = http.createServer((_req, res) => {
    connectionCount++;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  server.on('connect', (_req, socket) => {
    connectionCount++;
    socket.destroy();
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    await closeHttpServer(server);
    throw new Error('Failed to bind counting mock server');
  }

  return {
    server,
    host: '127.0.0.1',
    port: addr.port,
    getConnections: () => connectionCount,
    close: () => closeHttpServer(server),
  };
}

async function setupEnv(options?: {
  fetchImpl?: typeof fetch;
  now?: () => number;
  masterKey?: Buffer;
}) {
  const db = openDatabase(':memory:');
  const masterKey = options?.masterKey ?? randomBytes(32);
  const now = options?.now ?? (() => Date.UTC(2026, 10, 27, 12, 0, 0));
  const app = createApp({
    db,
    masterKey,
    fetchImpl: options?.fetchImpl ?? createOfflineFetch(),
    dnsLookup: async () => [{ address: '93.184.216.34', family: 4 }],
    now,
  });

  const setupRes = await app.request('http://localhost/api/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: 'admin',
      password: 'AdminPassword123!',
    }),
  });
  assert.equal(setupRes.status, 201);
  const adminCookie = (setupRes.headers.get('set-cookie') ?? '').split(';')[0]!;

  const provRes = await app.request('http://localhost/api/providers', {
    method: 'POST',
    headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ manifest: TEST_MANIFEST }),
  });
  assert.equal(provRes.status, 201);

  const keyRes = await app.request('http://localhost/api/keys', {
    method: 'POST',
    headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'test-internal-key' }),
  });
  assert.equal(keyRes.status, 201);
  const internalApiKey = ((await keyRes.json()) as { rawKey: string }).rawKey;

  const nowSec = Math.floor(now() / 1000);
  db.prepare(
    `INSERT INTO models (
       full_id, provider_id, model_id, canonical_model_id, name,
       context_length, max_output, modalities_json, capabilities_json,
       is_free, first_seen_at, active
     ) VALUES
       ('egress-prov/chat-free', 'egress-prov', 'chat-free', 'chat-free', 'Chat Free', 8192, 2048,
        '{"input":["text"],"output":["text"]}', '{"tools":false,"reasoning":false,"structuredOutput":false}', 1, ?, 1),
       ('egress-prov/embed-free', 'egress-prov', 'embed-free', 'embed-free', 'Embed Free', 8192, NULL,
        '{"input":["text"],"output":["embedding"]}', '{"tools":false,"reasoning":false,"structuredOutput":false}', 1, ?, 1)`,
  ).run(nowSec, nowSec);

  return { db, masterKey, app, adminCookie, internalApiKey };
}

async function createNode(
  app: ReturnType<typeof createApp>,
  db: ReturnType<typeof openDatabase>,
  adminCookie: string,
  name: string,
  endpoint: string,
  status: 'online' | 'offline' | 'unresponsive',
): Promise<string> {
  const res = await app.request('http://localhost/api/nodes', {
    method: 'POST',
    headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      mode: 'tailscale',
      endpoint,
    }),
  });
  assert.equal(res.status, 201);
  const body = (await res.json()) as { node: { id: string } };
  if (status !== 'offline') {
    db.prepare(`UPDATE nodes SET status = ? WHERE id = ?`).run(status, body.node.id);
  }
  return body.node.id;
}

describe('Provider key unified egressMode ("none" / "direct" / "node") and total block in Sin nodo', () => {
  it('creates keys in none/direct/node modes without unintended auto-assignment and computes egressMode across all states', async () => {
    const { db, app, adminCookie, masterKey } = await setupEnv();
    try {
      const onlineNodeId = await createNode(
        app,
        db,
        adminCookie,
        'Node-Online',
        '100.64.0.10:9090',
        'online',
      );
      const offlineNodeId = await createNode(
        app,
        db,
        adminCookie,
        'Node-Offline',
        '100.64.0.11:9090',
        'offline',
      );

      // 1. egressMode: 'none' MUST NOT auto-assign even when an online node exists
      const noneRes = await app.request('http://localhost/api/providers/egress-prov/keys', {
        method: 'POST',
        headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label: 'None Key',
          secret: 'sk-test-none-1111',
          egressMode: 'none',
        }),
      });
      assert.equal(noneRes.status, 201);
      const noneBody = (await noneRes.json()) as {
        key: {
          id: string;
          nodeId: string | null;
          forcedNode: boolean;
          status: string;
          egressMode: string;
          lastError: string | null;
        };
      };
      assert.equal(noneBody.key.nodeId, null);
      assert.equal(noneBody.key.forcedNode, false);
      assert.equal(noneBody.key.status, 'no_node');
      assert.equal(noneBody.key.egressMode, 'none');
      assert.equal(noneBody.key.lastError, null);

      // 2. status: 'no_node' without egressMode also MUST NOT auto-assign
      const noNodeStatusRes = await app.request('http://localhost/api/providers/egress-prov/keys', {
        method: 'POST',
        headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label: 'NoNode Status Key',
          secret: 'sk-test-nonode-2222',
          status: 'no_node',
        }),
      });
      assert.equal(noNodeStatusRes.status, 201);
      const noNodeStatusBody = (await noNodeStatusRes.json()) as {
        key: { nodeId: string | null; status: string; egressMode: string; lastError: string | null };
      };
      assert.equal(noNodeStatusBody.key.nodeId, null);
      assert.equal(noNodeStatusBody.key.status, 'no_node');
      assert.equal(noNodeStatusBody.key.egressMode, 'none');
      assert.equal(noNodeStatusBody.key.lastError, null);

      // 3. egressMode: 'direct' MUST NOT auto-assign an external node
      const directRes = await app.request('http://localhost/api/providers/egress-prov/keys', {
        method: 'POST',
        headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label: 'Direct Key',
          secret: 'sk-test-direct-3333',
          egressMode: 'direct',
        }),
      });
      assert.equal(directRes.status, 201);
      const directBody = (await directRes.json()) as {
        key: { nodeId: string | null; forcedNode: boolean; status: string; egressMode: string };
      };
      assert.equal(directBody.key.nodeId, null);
      assert.equal(directBody.key.forcedNode, false);
      assert.equal(directBody.key.status, 'active');
      assert.equal(directBody.key.egressMode, 'direct');

      // 4. egressMode: 'node' validates missing/nonexistent nodeId -> 400
      const missingNodeRes = await app.request('http://localhost/api/providers/egress-prov/keys', {
        method: 'POST',
        headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label: 'Missing Node Key',
          secret: 'sk-test-missing-node-4444',
          egressMode: 'node',
        }),
      });
      assert.equal(missingNodeRes.status, 400);

      const unknownNodeRes = await app.request('http://localhost/api/providers/egress-prov/keys', {
        method: 'POST',
        headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label: 'Unknown Node Key',
          secret: 'sk-test-unknown-node-4444',
          egressMode: 'node',
          nodeId: 'does-not-exist',
        }),
      });
      assert.equal(unknownNodeRes.status, 400);

      // Invalid egressMode -> 400
      const badEgressRes = await app.request('http://localhost/api/providers/egress-prov/keys', {
        method: 'POST',
        headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label: 'Bad Mode Key',
          secret: 'sk-test-badmode-4444',
          egressMode: 'tor',
        }),
      });
      assert.equal(badEgressRes.status, 400);

      // 5. egressMode: 'node' with online node -> active + egressMode: 'node'
      const nodeRes = await app.request('http://localhost/api/providers/egress-prov/keys', {
        method: 'POST',
        headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label: 'Node Online Key',
          secret: 'sk-test-node-5555',
          egressMode: 'node',
          nodeId: onlineNodeId,
        }),
      });
      assert.equal(nodeRes.status, 201);
      const nodeBody = (await nodeRes.json()) as {
        key: { nodeId: string | null; status: string; egressMode: string; forcedNode: boolean };
      };
      assert.equal(nodeBody.key.nodeId, onlineNodeId);
      assert.equal(nodeBody.key.status, 'active');
      assert.equal(nodeBody.key.egressMode, 'node');
      assert.equal(nodeBody.key.forcedNode, false);

      // 6. Second key on same node + provider -> 409 NODE_PROVIDER_COLLISION unless confirmForce: true
      const collisionRes = await app.request('http://localhost/api/providers/egress-prov/keys', {
        method: 'POST',
        headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label: 'Node Colliding Key',
          secret: 'sk-test-collide-6666',
          egressMode: 'node',
          nodeId: onlineNodeId,
        }),
      });
      assert.equal(collisionRes.status, 409);
      const collisionJson = (await collisionRes.json()) as { code: string };
      assert.equal(collisionJson.code, 'NODE_PROVIDER_COLLISION');

      const forcedRes = await app.request('http://localhost/api/providers/egress-prov/keys', {
        method: 'POST',
        headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label: 'Node Forced Key',
          secret: 'sk-test-collide-6666',
          egressMode: 'node',
          nodeId: onlineNodeId,
          confirmForce: true,
        }),
      });
      assert.equal(forcedRes.status, 201);
      const forcedBody = (await forcedRes.json()) as {
        key: { nodeId: string | null; forcedNode: boolean; status: string; egressMode: string };
      };
      assert.equal(forcedBody.key.nodeId, onlineNodeId);
      assert.equal(forcedBody.key.forcedNode, true);
      assert.equal(forcedBody.key.status, 'active');
      assert.equal(forcedBody.key.egressMode, 'node');

      // 7. egressMode: 'node' with offline node -> status: 'no_node', egressMode: 'node'
      const offlineKeyRes = await app.request('http://localhost/api/providers/egress-prov/keys', {
        method: 'POST',
        headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label: 'Node Offline Key',
          secret: 'sk-test-offline-7777',
          egressMode: 'node',
          nodeId: offlineNodeId,
        }),
      });
      assert.equal(offlineKeyRes.status, 201);
      const offlineKeyBody = (await offlineKeyRes.json()) as {
        key: { nodeId: string | null; status: string; egressMode: string; lastError: string | null };
      };
      assert.equal(offlineKeyBody.key.nodeId, offlineNodeId);
      assert.equal(offlineKeyBody.key.status, 'no_node');
      assert.equal(offlineKeyBody.key.egressMode, 'node');
      assert.match(offlineKeyBody.key.lastError ?? '', /offline/i);

      // 8. Legacy caller (no egressMode, no status) preserves HU-08 auto-assign to online node
      const legacyRes = await app.request('http://localhost/api/providers/egress-prov/keys', {
        method: 'POST',
        headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label: 'Legacy AutoAssign Key',
          secret: 'sk-test-legacy-8888',
        }),
      });
      assert.equal(legacyRes.status, 201);
      const legacyBody = (await legacyRes.json()) as {
        key: { nodeId: string | null; status: string; egressMode: string };
      };
      assert.equal(legacyBody.key.nodeId, onlineNodeId);
      assert.equal(legacyBody.key.status, 'active');
      assert.equal(legacyBody.key.egressMode, 'node');

      // 9. Verify formatProviderKeyRow mapping for rate_limited, error, and disabled rows (direct & node-bound)
      const nowSec = Math.floor(Date.UTC(2026, 10, 27, 12, 0, 0) / 1000);
      const insertMatrix = db.prepare(
        `INSERT INTO provider_keys (
           id, provider_id, label, encrypted_secret, last4, node_id, forced_node, status, created_at
         ) VALUES (?, 'egress-prov', ?, ?, '9999', ?, 0, ?, ?)`,
      );
      const enc = encryptSecret('sk-test-matrix-9999', masterKey);
      const kDirectRl = randomUUID();
      const kDirectErr = randomUUID();
      const kDirectDis = randomUUID();
      const kNodeDis = randomUUID();
      insertMatrix.run(kDirectRl, 'Direct RL', enc, null, 'rate_limited', nowSec);
      insertMatrix.run(kDirectErr, 'Direct Err', enc, null, 'error', nowSec);
      insertMatrix.run(kDirectDis, 'Direct Dis', enc, null, 'disabled', nowSec);
      insertMatrix.run(kNodeDis, 'Node Dis', enc, onlineNodeId, 'disabled', nowSec);

      const listRes = await app.request('http://localhost/api/providers/egress-prov/keys', {
        headers: { Cookie: adminCookie },
      });
      assert.equal(listRes.status, 200);
      const listed = ((await listRes.json()) as {
        keys: Array<{ id: string; egressMode: string; status: string; nodeId: string | null }>;
      }).keys;
      const byId = new Map(listed.map((k) => [k.id, k]));

      assert.equal(byId.get(kDirectRl)?.egressMode, 'direct');
      assert.equal(byId.get(kDirectErr)?.egressMode, 'direct');
      assert.equal(byId.get(kDirectDis)?.egressMode, 'none');
      assert.equal(byId.get(kNodeDis)?.egressMode, 'none');
    } finally {
      db.close();
    }
  });

  it('transitions cleanly across none <-> direct <-> node via PATCH .../node with 409 collision checks and legacy compatibility', async () => {
    const { db, app, adminCookie } = await setupEnv();
    try {
      const onlineNodeId = await createNode(
        app,
        db,
        adminCookie,
        'Node-A',
        '100.64.0.20:9090',
        'online',
      );
      const offlineNodeId = await createNode(
        app,
        db,
        adminCookie,
        'Node-B',
        '100.64.0.21:9090',
        'offline',
      );

      // Start key1 in 'none' and key2 on onlineNodeId
      const k1Res = await app.request('http://localhost/api/providers/egress-prov/keys', {
        method: 'POST',
        headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label: 'Transition Key 1',
          secret: 'sk-test-trans-1111',
          egressMode: 'none',
        }),
      });
      const k1Id = ((await k1Res.json()) as { key: { id: string } }).key.id;

      const k2Res = await app.request('http://localhost/api/providers/egress-prov/keys', {
        method: 'POST',
        headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label: 'Node Holder Key 2',
          secret: 'sk-test-trans-2222',
          egressMode: 'node',
          nodeId: onlineNodeId,
        }),
      });
      assert.equal(k2Res.status, 201);

      // Invalid egressMode -> 400
      const invalidModeRes = await app.request(
        `http://localhost/api/providers/egress-prov/keys/${k1Id}/node`,
        {
          method: 'PATCH',
          headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({ egressMode: 'proxy', nodeId: null }),
        },
      );
      assert.equal(invalidModeRes.status, 400);

      // egressMode: 'node' without nodeId -> 400
      const noNodeIdRes = await app.request(
        `http://localhost/api/providers/egress-prov/keys/${k1Id}/node`,
        {
          method: 'PATCH',
          headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({ egressMode: 'node', nodeId: null }),
        },
      );
      assert.equal(noNodeIdRes.status, 400);

      // none -> direct activates key
      const toDirectRes = await app.request(
        `http://localhost/api/providers/egress-prov/keys/${k1Id}/node`,
        {
          method: 'PATCH',
          headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({ egressMode: 'direct', nodeId: null }),
        },
      );
      assert.equal(toDirectRes.status, 200);
      const toDirect = ((await toDirectRes.json()) as {
        key: { nodeId: string | null; status: string; egressMode: string; lastError: string | null };
      }).key;
      assert.equal(toDirect.nodeId, null);
      assert.equal(toDirect.status, 'active');
      assert.equal(toDirect.egressMode, 'direct');
      assert.equal(toDirect.lastError, null);

      // direct -> node (collision with k2 -> 409, then confirmForce -> 200)
      const toNodeConflict = await app.request(
        `http://localhost/api/providers/egress-prov/keys/${k1Id}/node`,
        {
          method: 'PATCH',
          headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({ egressMode: 'node', nodeId: onlineNodeId }),
        },
      );
      assert.equal(toNodeConflict.status, 409);

      const toNodeForced = await app.request(
        `http://localhost/api/providers/egress-prov/keys/${k1Id}/node`,
        {
          method: 'PATCH',
          headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({ egressMode: 'node', nodeId: onlineNodeId, confirmForce: true }),
        },
      );
      assert.equal(toNodeForced.status, 200);
      const forcedKey = ((await toNodeForced.json()) as {
        key: { nodeId: string | null; forcedNode: boolean; status: string; egressMode: string };
      }).key;
      assert.equal(forcedKey.nodeId, onlineNodeId);
      assert.equal(forcedKey.forcedNode, true);
      assert.equal(forcedKey.status, 'active');
      assert.equal(forcedKey.egressMode, 'node');

      // node -> none clears node_id, forced_node, last_error and blocks key
      const toNoneRes = await app.request(
        `http://localhost/api/providers/egress-prov/keys/${k1Id}/node`,
        {
          method: 'PATCH',
          headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({ egressMode: 'none', nodeId: null }),
        },
      );
      assert.equal(toNoneRes.status, 200);
      const noneKey = ((await toNoneRes.json()) as {
        key: {
          nodeId: string | null;
          forcedNode: boolean;
          status: string;
          egressMode: string;
          lastError: string | null;
        };
      }).key;
      assert.equal(noneKey.nodeId, null);
      assert.equal(noneKey.forcedNode, false);
      assert.equal(noneKey.status, 'no_node');
      assert.equal(noneKey.egressMode, 'none');
      assert.equal(noneKey.lastError, null);

      // disabled key -> egressMode: 'direct' activates it
      const disRes = await app.request('http://localhost/api/providers/egress-prov/keys', {
        method: 'POST',
        headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label: 'Legacy Disabled Key',
          secret: 'sk-test-dis-3333',
          egressMode: 'direct',
          status: 'disabled',
        }),
      });
      const disKeyId = ((await disRes.json()) as { key: { id: string } }).key.id;

      // Legacy PATCH without egressMode preserves 'disabled'
      const legacyPatch = await app.request(
        `http://localhost/api/providers/egress-prov/keys/${disKeyId}/node`,
        {
          method: 'PATCH',
          headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({ nodeId: offlineNodeId }),
        },
      );
      assert.equal(legacyPatch.status, 200);
      assert.equal(((await legacyPatch.json()) as { key: { status: string } }).key.status, 'disabled');

      // Explicit egressMode: 'direct' activates from 'disabled'
      const explicitDirect = await app.request(
        `http://localhost/api/providers/egress-prov/keys/${disKeyId}/node`,
        {
          method: 'PATCH',
          headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({ egressMode: 'direct', nodeId: null }),
        },
      );
      assert.equal(explicitDirect.status, 200);
      const expDirectKey = ((await explicitDirect.json()) as {
        key: { status: string; egressMode: string; nodeId: string | null };
      }).key;
      assert.equal(expDirectKey.status, 'active');
      assert.equal(expDirectKey.egressMode, 'direct');
      assert.equal(expDirectKey.nodeId, null);

      // Explicit egressMode: 'node' to offline node transitions to status='no_node' with lastError
      const explicitOfflineNode = await app.request(
        `http://localhost/api/providers/egress-prov/keys/${disKeyId}/node`,
        {
          method: 'PATCH',
          headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({ egressMode: 'node', nodeId: offlineNodeId }),
        },
      );
      assert.equal(explicitOfflineNode.status, 200);
      const expOffKey = ((await explicitOfflineNode.json()) as {
        key: { status: string; egressMode: string; nodeId: string | null; lastError: string | null };
      }).key;
      assert.equal(expOffKey.nodeId, offlineNodeId);
      assert.equal(expOffKey.status, 'no_node');
      assert.equal(expOffKey.egressMode, 'node');
      assert.match(expOffKey.lastError ?? '', /offline/i);
    } finally {
      db.close();
    }
  });

  it('blocks 100% of outbound traffic (test, detect-models, chat, embeddings) in Sin nodo and on offline nodes, and unblocks in direct mode', async () => {
    let upstreamFetchCalls = 0;
    const mockFetch = createOfflineFetch(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith('https://api.example.com/v1')) {
        upstreamFetchCalls++;
        if (url.endsWith('/models')) {
          return new Response(
            JSON.stringify({ data: [{ id: 'chat-free', name: 'Chat Free' }] }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (url.endsWith('/chat/completions')) {
          return new Response(
            JSON.stringify({
              id: 'chatcmpl-1',
              object: 'chat.completion',
              created: 1764244800,
              model: 'chat-free',
              choices: [
                { index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
              ],
              usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (url.endsWith('/embeddings')) {
          return new Response(
            JSON.stringify({
              object: 'list',
              model: 'embed-free',
              data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2] }],
              usage: { prompt_tokens: 4, total_tokens: 4 },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
      }
      return undefined;
    });

    const mockOfflineNode = await startCountingHttpServer();
    const { db, app, adminCookie, internalApiKey } = await setupEnv({ fetchImpl: mockFetch });

    try {
      const offlineNodeId = await createNode(
        app,
        db,
        adminCookie,
        'Offline-Tunnel-Node',
        `${mockOfflineNode.host}:${mockOfflineNode.port}`,
        'offline',
      );

      // A) Key created in 'none' (Sin nodo) -> 0 outbound calls across all 4 endpoints
      const createRes = await app.request('http://localhost/api/providers/egress-prov/keys', {
        method: 'POST',
        headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label: 'Blocked Key',
          secret: 'sk-test-blocked-1111',
          egressMode: 'none',
        }),
      });
      assert.equal(createRes.status, 201);
      const keyId = ((await createRes.json()) as { key: { id: string } }).key.id;

      const testNoneRes = await app.request(
        `http://localhost/api/providers/egress-prov/keys/${keyId}/test`,
        { method: 'POST', headers: { Cookie: adminCookie } },
      );
      assert.equal(testNoneRes.status, 200);
      const testNoneBody = (await testNoneRes.json()) as {
        ok: boolean;
        httpStatus: number | null;
        latencyMs: number;
        status: string;
      };
      assert.equal(testNoneBody.ok, false);
      assert.equal(testNoneBody.httpStatus, null);
      assert.equal(testNoneBody.latencyMs, 0);
      assert.equal(testNoneBody.status, 'no_node');

      const detectNoneRes = await app.request(
        'http://localhost/api/providers/egress-prov/detect-models',
        { method: 'POST', headers: { Cookie: adminCookie } },
      );
      assert.equal(detectNoneRes.status, 502);

      const chatNoneRes = await app.request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${internalApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'egress-prov/chat-free',
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });
      assert.equal(chatNoneRes.status, 503);

      const embNoneRes = await app.request('http://localhost/v1/embeddings', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${internalApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'egress-prov/embed-free',
          input: 'hello',
        }),
      });
      assert.equal(embNoneRes.status, 503);

      assert.equal(upstreamFetchCalls, 0, 'Sin nodo must produce 0 upstream HTTP requests');
      assert.equal(mockOfflineNode.getConnections(), 0, 'Sin nodo must produce 0 tunnel connections');

      // B) Key assigned to an offline node -> 0 outbound calls (even if DB status were stale 'active')
      const assignOffRes = await app.request(
        `http://localhost/api/providers/egress-prov/keys/${keyId}/node`,
        {
          method: 'PATCH',
          headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({ egressMode: 'node', nodeId: offlineNodeId }),
        },
      );
      assert.equal(assignOffRes.status, 200);

      const testOffNoNode = await app.request(
        `http://localhost/api/providers/egress-prov/keys/${keyId}/test`,
        { method: 'POST', headers: { Cookie: adminCookie } },
      );
      assert.equal(testOffNoNode.status, 200);
      const testOffNoNodeBody = (await testOffNoNode.json()) as {
        ok: boolean;
        httpStatus: number | null;
        latencyMs: number;
      };
      assert.equal(testOffNoNodeBody.ok, false);
      assert.equal(testOffNoNodeBody.httpStatus, null);
      assert.equal(testOffNoNodeBody.latencyMs, 0);

      // Also simulate a stale DB row where status='active' while node is still 'offline'
      db.prepare(`UPDATE provider_keys SET status = 'active' WHERE id = ?`).run(keyId);

      const testOffStale = await app.request(
        `http://localhost/api/providers/egress-prov/keys/${keyId}/test`,
        { method: 'POST', headers: { Cookie: adminCookie } },
      );
      assert.equal(testOffStale.status, 200);
      const testOffStaleBody = (await testOffStale.json()) as {
        ok: boolean;
        httpStatus: number | null;
        latencyMs: number;
      };
      assert.equal(testOffStaleBody.ok, false);
      assert.equal(testOffStaleBody.httpStatus, null);
      assert.equal(testOffStaleBody.latencyMs, 0);

      const detectOffRes = await app.request(
        'http://localhost/api/providers/egress-prov/detect-models',
        { method: 'POST', headers: { Cookie: adminCookie } },
      );
      assert.equal(detectOffRes.status, 502);

      const chatOffRes = await app.request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${internalApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'egress-prov/chat-free',
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });
      assert.equal(chatOffRes.status, 503);

      const embOffRes = await app.request('http://localhost/v1/embeddings', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${internalApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'egress-prov/embed-free',
          input: 'hello',
        }),
      });
      assert.equal(embOffRes.status, 503);

      assert.equal(upstreamFetchCalls, 0, 'Offline node must produce 0 upstream HTTP requests');
      assert.equal(mockOfflineNode.getConnections(), 0, 'Offline node must produce 0 tunnel connections');

      // C) Switching to 'direct' unblocks all 4 operations
      const toDirectRes = await app.request(
        `http://localhost/api/providers/egress-prov/keys/${keyId}/node`,
        {
          method: 'PATCH',
          headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({ egressMode: 'direct', nodeId: null }),
        },
      );
      assert.equal(toDirectRes.status, 200);

      const testDirectRes = await app.request(
        `http://localhost/api/providers/egress-prov/keys/${keyId}/test`,
        { method: 'POST', headers: { Cookie: adminCookie } },
      );
      assert.equal(testDirectRes.status, 200);
      assert.equal(((await testDirectRes.json()) as { ok: boolean }).ok, true);

      const detectDirectRes = await app.request(
        'http://localhost/api/providers/egress-prov/detect-models',
        { method: 'POST', headers: { Cookie: adminCookie } },
      );
      assert.equal(detectDirectRes.status, 200);

      // Re-insert embed-free since detect-models replaced provider models with /models response
      const nowSec = Math.floor(Date.UTC(2026, 10, 27, 12, 0, 0) / 1000);
      db.prepare(
        `INSERT OR REPLACE INTO models (
           full_id, provider_id, model_id, canonical_model_id, name,
           context_length, max_output, modalities_json, capabilities_json,
           is_free, first_seen_at, active
         ) VALUES (
           'egress-prov/embed-free', 'egress-prov', 'embed-free', 'embed-free', 'Embed Free', 8192, NULL,
           '{"input":["text"],"output":["embedding"]}', '{"tools":false,"reasoning":false,"structuredOutput":false}', 1, ?, 1
         )`,
      ).run(nowSec);

      const chatDirectRes = await app.request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${internalApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'egress-prov/chat-free',
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });
      assert.equal(chatDirectRes.status, 200);

      const embDirectRes = await app.request('http://localhost/v1/embeddings', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${internalApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'egress-prov/embed-free',
          input: 'hello',
        }),
      });
      assert.equal(embDirectRes.status, 200);
      assert.equal(upstreamFetchCalls, 4);

      // D) Switching back to 'none' immediately blocks all outbound traffic again
      const backNoneRes = await app.request(
        `http://localhost/api/providers/egress-prov/keys/${keyId}/node`,
        {
          method: 'PATCH',
          headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({ egressMode: 'none', nodeId: null }),
        },
      );
      assert.equal(backNoneRes.status, 200);

      const testBackNone = await app.request(
        `http://localhost/api/providers/egress-prov/keys/${keyId}/test`,
        { method: 'POST', headers: { Cookie: adminCookie } },
      );
      assert.equal(((await testBackNone.json()) as { ok: boolean }).ok, false);
      assert.equal(upstreamFetchCalls, 4, 'Returning to Sin nodo must stop all outbound requests');
    } finally {
      await mockOfflineNode.close();
      db.close();
    }
  });

  it('preserves status="no_node" with node_id=NULL (egressMode="none") across encrypted backup export/import', async () => {
    const srcEnv = await setupEnv();
    const dstDb = openDatabase(':memory:');
    const dstMasterKey = randomBytes(32);

    try {
      const onlineNodeId = await createNode(
        srcEnv.app,
        srcEnv.db,
        srcEnv.adminCookie,
        'Backup-Node',
        '100.64.0.30:9090',
        'online',
      );

      const kNoneRes = await srcEnv.app.request('http://localhost/api/providers/egress-prov/keys', {
        method: 'POST',
        headers: { Cookie: srcEnv.adminCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label: 'Backup None Key',
          secret: 'sk-backup-none-1111',
          egressMode: 'none',
        }),
      });
      const kNoneId = ((await kNoneRes.json()) as { key: { id: string } }).key.id;

      const kDirectRes = await srcEnv.app.request(
        'http://localhost/api/providers/egress-prov/keys',
        {
          method: 'POST',
          headers: { Cookie: srcEnv.adminCookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            label: 'Backup Direct Key',
            secret: 'sk-backup-direct-2222',
            egressMode: 'direct',
          }),
        },
      );
      const kDirectId = ((await kDirectRes.json()) as { key: { id: string } }).key.id;

      const kNodeRes = await srcEnv.app.request('http://localhost/api/providers/egress-prov/keys', {
        method: 'POST',
        headers: { Cookie: srcEnv.adminCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label: 'Backup Node Key',
          secret: 'sk-backup-node-3333',
          egressMode: 'node',
          nodeId: onlineNodeId,
        }),
      });
      const kNodeId = ((await kNodeRes.json()) as { key: { id: string } }).key.id;

      const envelope = await exportEncryptedBackup({
        db: srcEnv.db,
        masterKey: srcEnv.masterKey,
        password: 'BackupPassword123!',
        includeProvidersAndConfig: true,
        includeProviderKeys: true,
        includeUsersAndQuotas: true,
        includeNodes: true,
      });

      const importResult = await importEncryptedBackup({
        db: dstDb,
        masterKey: dstMasterKey,
        envelope,
        password: 'BackupPassword123!',
      });
      assert.equal(importResult.ok, true);
      assert.equal(importResult.restored.providerKeys, 3);

      const dstApp = createApp({
        db: dstDb,
        masterKey: dstMasterKey,
        fetchImpl: createOfflineFetch(),
      });
      const loginRes = await dstApp.request('http://localhost/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'AdminPassword123!' }),
      });
      assert.equal(loginRes.status, 200);
      const dstCookie = (loginRes.headers.get('set-cookie') ?? '').split(';')[0]!;

      const listRes = await dstApp.request('http://localhost/api/providers/egress-prov/keys', {
        headers: { Cookie: dstCookie },
      });
      assert.equal(listRes.status, 200);
      const restoredKeys = ((await listRes.json()) as {
        keys: Array<{
          id: string;
          nodeId: string | null;
          status: string;
          egressMode: string;
          lastError: string | null;
        }>;
      }).keys;
      const byId = new Map(restoredKeys.map((k) => [k.id, k]));

      assert.deepEqual(byId.get(kNoneId), {
        ...byId.get(kNoneId),
        id: kNoneId,
        nodeId: null,
        status: 'no_node',
        egressMode: 'none',
        lastError: null,
      });
      assert.equal(byId.get(kDirectId)?.nodeId, null);
      assert.equal(byId.get(kDirectId)?.status, 'active');
      assert.equal(byId.get(kDirectId)?.egressMode, 'direct');
      assert.equal(byId.get(kNodeId)?.nodeId, onlineNodeId);
      assert.equal(byId.get(kNodeId)?.status, 'active');
      assert.equal(byId.get(kNodeId)?.egressMode, 'node');
    } finally {
      srcEnv.db.close();
      dstDb.close();
    }
  });
});

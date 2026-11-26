import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { getEventListeners } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { afterEach, describe, it } from 'node:test';
import { decryptSecret, encryptSecret, sha256Hex } from '../core/src/crypto.js';
import { initDatabase, openDatabase } from '../core/src/db.js';
import {
  NodeOperationError,
  buildNodeInstallCommand,
  callNodeControlPlane,
  fetchViaExitNode,
  normalizeHexFingerprint,
  openConnectSocketToNode,
  probeNodeTlsFingerprint,
  rotateNodeToken,
  runNodesHealthTick,
  testNodeConnectivity,
  triggerNodeUpdate,
} from '../core/src/nodes.js';
import {
  type BifrostNodeInstance,
  TokenAuthenticator,
  createBifrostNodeServer,
  loadOrGenerateTlsMaterial,
} from '../nodes/dist/index.js';

const SILENT_LOGGER = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

const cleanupCallbacks: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanupCallbacks.length > 0) {
    const fn = cleanupCallbacks.pop()!;
    await fn();
  }
});

function insertTestNode(params: {
  db: ReturnType<typeof openDatabase>;
  masterKey: Buffer;
  id?: string;
  name?: string;
  mode: 'tailscale' | 'public_ip';
  endpoint: string;
  rawToken: string;
  tlsFingerprint: string | null;
  status?: 'online' | 'unresponsive' | 'offline';
  createdAt?: number;
  lastRotatedAt?: number;
}): string {
  const id = params.id ?? randomUUID();
  const createdAt = params.createdAt ?? 1_770_000_000;
  const lastRotatedAt = params.lastRotatedAt ?? createdAt;
  params.db
    .prepare(
      `INSERT INTO nodes (
         id, name, mode, endpoint, token_hash, encrypted_token, pending_encrypted_token,
         prev_token_hash, prev_token_expires_at, tls_fingerprint,
         last_seen_at, last_rotated_at, status, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, NULL, ?, ?, ?)`,
    )
    .run(
      id,
      params.name ?? `Node-${id.slice(0, 6)}`,
      params.mode,
      params.endpoint,
      sha256Hex(params.rawToken),
      encryptSecret(params.rawToken, params.masterKey),
      params.tlsFingerprint,
      lastRotatedAt,
      params.status ?? 'offline',
      createdAt,
    );
  return id;
}

describe('Ola 4 — Nodes TLS Pinning, 2-Phase Rotation & Tunnel Resilience', () => {
  it('verifies TLS SHA-256 fingerprint BEFORE transmitting any HTTP bytes, Bearer token, or newToken', async () => {
    const serverTls = loadOrGenerateTlsMaterial();
    const receivedChunks: Buffer[] = [];

    const rawTlsServer = tls.createServer(
      { cert: serverTls.certPem, key: serverTls.keyPem },
      (sock) => {
        sock.on('data', (chunk: Buffer) => {
          receivedChunks.push(Buffer.from(chunk));
        });
        sock.on('error', () => {});
      },
    );
    await new Promise<void>((resolve) => rawTlsServer.listen(0, '127.0.0.1', resolve));
    const port = (rawTlsServer.address() as net.AddressInfo).port;
    cleanupCallbacks.push(() => new Promise<void>((r) => rawTlsServer.close(() => r())));

    const secretBearer = 'SUPER_SECRET_BEARER_TOKEN_DO_NOT_LEAK_12345';
    const secretNewToken = 'SUPER_SECRET_ROTATED_NEW_TOKEN_DO_NOT_LEAK_67890';
    const wrongPin = 'E'.repeat(64);

    // 1. callNodeControlPlane with mismatched pin must reject and transmit ZERO plaintext bytes
    await assert.rejects(
      () =>
        callNodeControlPlane({
          mode: 'public_ip',
          endpoint: `127.0.0.1:${port}`,
          rawToken: secretBearer,
          tlsFingerprint: wrongPin,
          method: 'POST',
          path: '/_bifrost/rotate',
          body: { newToken: secretNewToken },
          timeoutMs: 3000,
        }),
      /fingerprint mismatch/i,
    );

    // 2. openConnectSocketToNode with mismatched pin must also transmit ZERO plaintext bytes
    await assert.rejects(
      () =>
        openConnectSocketToNode(
          {
            id: 'node-bad-pin',
            name: 'Bad Pin Node',
            mode: 'public_ip',
            endpoint: `127.0.0.1:${port}`,
            rawToken: secretBearer,
            tlsFingerprint: wrongPin,
          },
          'example.com:443',
          3000,
        ),
      /fingerprint/i,
    );

    // Give server event loop a brief tick to surface any buffered bytes if a leak occurred
    await new Promise((r) => setTimeout(r, 50));

    const wireText = Buffer.concat(receivedChunks).toString('utf8');
    assert.equal(receivedChunks.length, 0, `Expected 0 decrypted bytes on TLS pin mismatch, saw: ${wireText}`);
    assert.ok(!wireText.includes(secretBearer), 'Bearer token leaked before TLS pin check!');
    assert.ok(!wireText.includes(secretNewToken), 'newToken leaked before TLS pin check!');
  });

  it('blocks unpinned public_ip traffic/rotation/update while allowing testNodeConnectivity to probe TLS first without leaking token', async () => {
    const db = openDatabase(':memory:');
    cleanupCallbacks.push(() => db.close());
    const masterKey = randomBytes(32);

    const token = 'public_ip_unpinned_token_0123456789abcdef';
    const nodeServer: BifrostNodeInstance = createBifrostNodeServer({
      mode: 'public_ip',
      bindHost: '127.0.0.1',
      port: 0,
      token,
      allowPrivateTargets: true,
      allowedPorts: [443],
      logger: SILENT_LOGGER,
    });
    const started = await nodeServer.start();
    cleanupCallbacks.push(() => nodeServer.stop());

    const nodeId = insertTestNode({
      db,
      masterKey,
      name: 'Unpinned Public VPS',
      mode: 'public_ip',
      endpoint: `127.0.0.1:${started.port}`,
      rawToken: token,
      tlsFingerprint: null,
    });

    // 1. Direct control plane call without tlsFingerprint is blocked
    await assert.rejects(
      () =>
        callNodeControlPlane({
          mode: 'public_ip',
          endpoint: `127.0.0.1:${started.port}`,
          rawToken: token,
          tlsFingerprint: null,
          method: 'GET',
          path: '/_bifrost/health',
        }),
      /tlsFingerprint/i,
    );

    // 2. Data plane CONNECT without tlsFingerprint is blocked
    await assert.rejects(
      () =>
        openConnectSocketToNode(
          {
            id: nodeId,
            name: 'Unpinned Public VPS',
            mode: 'public_ip',
            endpoint: `127.0.0.1:${started.port}`,
            rawToken: token,
            tlsFingerprint: null,
          },
          '1.1.1.1:443',
          3000,
        ),
      /tlsFingerprint/i,
    );

    // 3. Rotation without tlsFingerprint is blocked with 400
    await assert.rejects(
      () =>
        rotateNodeToken({
          db,
          masterKey,
          nodeId,
          nowSec: 1_770_000_100,
        }),
      (err: unknown) => err instanceof NodeOperationError && err.status === 400 && /tlsFingerprint/i.test(err.message),
    );

    // 4. Remote update without tlsFingerprint is blocked with 400
    await assert.rejects(
      () => triggerNodeUpdate(db, masterKey, nodeId),
      (err: unknown) => err instanceof NodeOperationError && err.status === 400 && /tlsFingerprint/i.test(err.message),
    );

    // 5. Health tick does NOT bring unpinned public_ip node online
    const tickUnpinned = await runNodesHealthTick(db, masterKey, {
      now: () => 1_770_000_050_000,
    });
    assert.equal(tickUnpinned.onlineCount, 0);

    // 6. probeNodeTlsFingerprint captures SHA-256 fingerprint cleanly without sending HTTP/Bearer
    const probedFp = await probeNodeTlsFingerprint(`127.0.0.1:${started.port}`, 3000);
    assert.equal(probedFp, normalizeHexFingerprint(started.tlsFingerprintSha256!));

    // 7. testNodeConnectivity probes TLS first, verifies health pinned, and persists normalized fingerprint
    const testRes = await testNodeConnectivity({
      db,
      masterKey,
      nodeId,
    });
    assert.equal(testRes.ok, true);
    assert.equal(testRes.status, 'online');

    const storedRow = db
      .prepare(`SELECT tls_fingerprint, status FROM nodes WHERE id = ?`)
      .get(nodeId) as { tls_fingerprint: string | null; status: string };
    assert.equal(storedRow.tls_fingerprint, normalizeHexFingerprint(started.tlsFingerprintSha256!));
    assert.equal(storedRow.status, 'online');

    // 8. Once pinned, rotation succeeds normally
    const rotRes = await rotateNodeToken({
      db,
      masterKey,
      nodeId,
      nowSec: 1_770_000_200,
    });
    assert.equal(rotRes.ok, true);
  });

  it('recovers from lost POST /_bifrost/rotate response immediately and on subsequent health tick without split-brain', async () => {
    const db = openDatabase(':memory:');
    cleanupCallbacks.push(() => db.close());
    const masterKey = randomBytes(32);

    const initialToken = 'two_phase_initial_token_0123456789abcd';
    const auth = new TokenAuthenticator({ initialToken });

    let mode: 'drop_after_rotate_stay_up' | 'drop_after_rotate_go_down' | 'reject_500' | 'normal' =
      'drop_after_rotate_stay_up';
    let serverOffline = false;

    const mockNode = http.createServer((req, res) => {
      if (serverOffline) {
        req.socket.destroy();
        return;
      }

      const ver = auth.verifyHeaders(req.headers);
      if (!ver.authenticated) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false }));
        return;
      }

      if (req.method === 'GET' && req.url === '/_bifrost/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, commit: 'abc1234' }));
        return;
      }

      if (req.method === 'POST' && req.url === '/_bifrost/rotate') {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          if (mode === 'reject_500') {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'disk_full' }));
            return;
          }
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { newToken: string };
          auth.rotate(body.newToken);

          if (mode === 'drop_after_rotate_stay_up') {
            // Simulate lost TCP response right after node persisted rotation
            req.socket.destroy();
            return;
          }
          if (mode === 'drop_after_rotate_go_down') {
            // Node rotated, dropped response, AND became temporarily unreachable
            serverOffline = true;
            req.socket.destroy();
            return;
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        });
        return;
      }

      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => mockNode.listen(0, '127.0.0.1', resolve));
    const port = (mockNode.address() as net.AddressInfo).port;
    cleanupCallbacks.push(() => new Promise<void>((r) => mockNode.close(() => r())));

    const nodeId = insertTestNode({
      db,
      masterKey,
      name: 'Two-Phase Node',
      mode: 'tailscale',
      endpoint: `127.0.0.1:${port}`,
      rawToken: initialToken,
      tlsFingerprint: null,
      status: 'online',
    });

    // Scenario A: Node rotates and drops TCP response while still reachable -> immediate auto-promotion!
    mode = 'drop_after_rotate_stay_up';
    const rotA = await rotateNodeToken({
      db,
      masterKey,
      nodeId,
      nowSec: 1_770_000_100,
    });
    assert.equal(rotA.ok, true);

    const rowAfterA = db
      .prepare(`SELECT encrypted_token, pending_encrypted_token, token_hash FROM nodes WHERE id = ?`)
      .get(nodeId) as {
      encrypted_token: Uint8Array;
      pending_encrypted_token: Uint8Array | null;
      token_hash: string;
    };
    assert.equal(rowAfterA.pending_encrypted_token, null);
    const tokenAfterA = decryptSecret(rowAfterA.encrypted_token, masterKey);
    assert.notEqual(tokenAfterA, initialToken);
    assert.equal(auth.verifyToken(tokenAfterA).matchedSlot, 'active');

    // Scenario B: Node rotates, drops response, AND goes offline -> pending_encrypted_token retained,
    // then next runNodesHealthTick auto-promotes when node comes back online!
    mode = 'drop_after_rotate_go_down';
    await assert.rejects(
      () =>
        rotateNodeToken({
          db,
          masterKey,
          nodeId,
          nowSec: 1_770_000_200,
          timeoutMs: 1000,
        }),
      (err: unknown) => err instanceof NodeOperationError && err.status === 502,
    );

    const rowPending = db
      .prepare(`SELECT encrypted_token, pending_encrypted_token FROM nodes WHERE id = ?`)
      .get(nodeId) as {
      encrypted_token: Uint8Array;
      pending_encrypted_token: Uint8Array | null;
    };
    assert.ok(rowPending.pending_encrypted_token, 'pending_encrypted_token must be retained while node is unreachable');
    const pendingTokenB = decryptSecret(rowPending.pending_encrypted_token, masterKey);
    assert.equal(decryptSecret(rowPending.encrypted_token, masterKey), tokenAfterA);

    // Bring node back online (it only has pendingTokenB as active!)
    serverOffline = false;
    mode = 'normal';

    const recoveryTick = await runNodesHealthTick(db, masterKey, {
      now: () => 1_770_000_260_000,
    });
    assert.equal(recoveryTick.onlineCount, 1);

    const rowAfterB = db
      .prepare(`SELECT encrypted_token, pending_encrypted_token, status, last_commit FROM nodes WHERE id = ?`)
      .get(nodeId) as {
      encrypted_token: Uint8Array;
      pending_encrypted_token: Uint8Array | null;
      status: string;
      last_commit: string | null;
    };
    assert.equal(rowAfterB.pending_encrypted_token, null);
    assert.equal(decryptSecret(rowAfterB.encrypted_token, masterKey), pendingTokenB);
    assert.equal(rowAfterB.status, 'online');
    assert.equal(rowAfterB.last_commit, 'abc1234');

    // Scenario C: Node rejects rotation with 500 without rotating -> pending_encrypted_token cleared cleanly
    mode = 'reject_500';
    await assert.rejects(
      () =>
        rotateNodeToken({
          db,
          masterKey,
          nodeId,
          nowSec: 1_770_000_300,
        }),
      (err: unknown) => err instanceof NodeOperationError && err.status === 502,
    );

    const rowAfterC = db
      .prepare(`SELECT encrypted_token, pending_encrypted_token FROM nodes WHERE id = ?`)
      .get(nodeId) as {
      encrypted_token: Uint8Array;
      pending_encrypted_token: Uint8Array | null;
    };
    assert.equal(rowAfterC.pending_encrypted_token, null, 'Unapplied pending token must be cleared when node accepts old token');
    assert.equal(decryptSecret(rowAfterC.encrypted_token, masterKey), pendingTokenB);
  });

  it('serializes concurrent rotateNodeToken calls per nodeId via mutex without split-brain', async () => {
    const db = openDatabase(':memory:');
    cleanupCallbacks.push(() => db.close());
    const masterKey = randomBytes(32);

    const initialToken = 'mutex_rotate_initial_token_0123456789';
    const auth = new TokenAuthenticator({ initialToken });
    let inFlightRotates = 0;
    let maxConcurrentRotates = 0;

    const mockNode = http.createServer((req, res) => {
      const ver = auth.verifyHeaders(req.headers);
      if (!ver.authenticated || (req.url === '/_bifrost/rotate' && ver.matchedSlot !== 'active')) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false }));
        return;
      }
      if (req.method === 'POST' && req.url === '/_bifrost/rotate') {
        inFlightRotates += 1;
        maxConcurrentRotates = Math.max(maxConcurrentRotates, inFlightRotates);
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          setTimeout(() => {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { newToken: string };
            auth.rotate(body.newToken);
            inFlightRotates -= 1;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
          }, 50);
        });
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });

    await new Promise<void>((resolve) => mockNode.listen(0, '127.0.0.1', resolve));
    const port = (mockNode.address() as net.AddressInfo).port;
    cleanupCallbacks.push(() => new Promise<void>((r) => mockNode.close(() => r())));

    const nodeId = insertTestNode({
      db,
      masterKey,
      name: 'Mutex Node',
      mode: 'tailscale',
      endpoint: `127.0.0.1:${port}`,
      rawToken: initialToken,
      tlsFingerprint: null,
    });

    const results = await Promise.all([
      rotateNodeToken({ db, masterKey, nodeId, nowSec: 1_770_000_101 }),
      rotateNodeToken({ db, masterKey, nodeId, nowSec: 1_770_000_102 }),
      rotateNodeToken({ db, masterKey, nodeId, nowSec: 1_770_000_103 }),
    ]);

    assert.equal(results.length, 3);
    assert.ok(results.every((r) => r.ok));
    assert.equal(maxConcurrentRotates, 1, 'Rotations for the same nodeId must never overlap');

    const finalRow = db
      .prepare(`SELECT encrypted_token, pending_encrypted_token FROM nodes WHERE id = ?`)
      .get(nodeId) as { encrypted_token: Uint8Array; pending_encrypted_token: Uint8Array | null };
    assert.equal(finalRow.pending_encrypted_token, null);
    const finalToken = decryptSecret(finalRow.encrypted_token, masterKey);
    assert.equal(auth.verifyToken(finalToken).matchedSlot, 'active');
  });

  it('executes runNodesHealthTick in parallel batches with bounded concurrency', async () => {
    const db = openDatabase(':memory:');
    cleanupCallbacks.push(() => db.close());
    const masterKey = randomBytes(32);

    let inFlight = 0;
    let maxInFlight = 0;

    for (let i = 0; i < 8; i += 1) {
      const tok = `parallel_node_token_${i}_0123456789abcdef`;
      const srv = http.createServer((req, res) => {
        if (req.url === '/_bifrost/health') {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          setTimeout(() => {
            inFlight -= 1;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
          }, 50);
          return;
        }
        res.writeHead(404);
        res.end();
      });
      await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
      const port = (srv.address() as net.AddressInfo).port;
      cleanupCallbacks.push(() => new Promise<void>((r) => srv.close(() => r())));

      insertTestNode({
        db,
        masterKey,
        name: `Parallel-${i}`,
        mode: 'tailscale',
        endpoint: `127.0.0.1:${port}`,
        rawToken: tok,
        tlsFingerprint: null,
        createdAt: 1_770_000_000 + i,
      });
    }

    const tickRes = await runNodesHealthTick(db, masterKey, {
      now: () => 1_770_000_100_000,
      concurrency: 5,
    });
    assert.equal(tickRes.checkedCount, 8);
    assert.equal(tickRes.onlineCount, 8);
    assert.ok(maxInFlight >= 2, `Expected parallel health probes, saw maxInFlight=${maxInFlight}`);
    assert.ok(maxInFlight <= 5, `Expected bounded concurrency <= 5, saw maxInFlight=${maxInFlight}`);
  });

  it('validates serverOrigin strictly and single-quotes scriptUrl + BIFROST_NODE_TOKEN in buildNodeInstallCommand', () => {
    const token = 'safe_node_token_0123456789abcdef';
    const cmd = buildNodeInstallCommand({
      mode: 'public_ip',
      endpoint: '203.0.113.10:9443',
      rawToken: token,
      serverOrigin: 'https://bifrost.example.com:8443',
    });

    assert.ok(cmd.includes(`'https://bifrost.example.com:8443/install-node.sh'`));
    assert.ok(cmd.includes(`BIFROST_NODE_TOKEN='${token}'`));
    assert.ok(cmd.includes('--mode public_ip --port 9443'));
    assert.ok(!cmd.includes(`--token "${token}"`), 'Token should be passed via BIFROST_NODE_TOKEN, not double-quoted argv');

    for (const badOrigin of [
      'https://evil.com/$(whoami)',
      'https://evil.com/`id`',
      'https://evil.com;rm -rf /',
      'https://evil.com|cat /etc/passwd',
      'ftp://files.example.com',
      'javascript:alert(1)',
      'https://user:pass@example.com',
      'https://example.com/?foo=bar',
      'https://example.com/../etc',
    ]) {
      assert.throws(
        () =>
          buildNodeInstallCommand({
            mode: 'tailscale',
            endpoint: '100.64.0.1:9443',
            rawToken: token,
            serverOrigin: badOrigin,
          }),
        /Invalid serverOrigin/i,
        `Expected buildNodeInstallCommand to reject "${badOrigin}"`,
      );
    }
  });

  it('keeps bridge error listener on openConnectSocketToNode, enforces fetchViaExitNode timeout, and removes AbortSignal listener', async () => {
    let hangUpstream = false;
    const upstreamServer = http.createServer((req, res) => {
      if (hangUpstream) {
        // Deliberately never send headers
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => upstreamServer.listen(0, '127.0.0.1', resolve));
    const upstreamPort = (upstreamServer.address() as net.AddressInfo).port;
    cleanupCallbacks.push(() => new Promise<void>((r) => upstreamServer.close(() => r())));

    const token = 'tunnel_stability_token_0123456789abcd';
    const node = createBifrostNodeServer({
      mode: 'tailscale',
      bindHost: '127.0.0.1',
      port: 0,
      token,
      allowPrivateTargets: true,
      allowedPorts: [upstreamPort],
      logger: SILENT_LOGGER,
    });
    const { port: nodePort } = await node.start();
    cleanupCallbacks.push(() => node.stop());

    const nodeCfg = {
      id: 'stability-node',
      name: 'Stability Node',
      mode: 'tailscale' as const,
      endpoint: `127.0.0.1:${nodePort}`,
      rawToken: token,
      tlsFingerprint: null,
    };

    // 1. openConnectSocketToNode MUST keep an error listener attached immediately on resolve
    const rawSock = await openConnectSocketToNode(nodeCfg, `127.0.0.1:${upstreamPort}`, 3000);
    assert.ok(
      rawSock.listenerCount('error') >= 1,
      'Expected bridge error listener on tunnel socket immediately after resolve',
    );
    // Emitting an error immediately must NOT throw uncaught exception
    rawSock.emit('error', new Error('simulated early ECONNRESET'));
    rawSock.destroy();

    // 2. fetchViaExitNode removes AbortSignal listener on completion and closes tunnel cleanly
    const controller = new AbortController();
    const okRes = await fetchViaExitNode(
      `http://127.0.0.1:${upstreamPort}/ping`,
      { method: 'GET', signal: controller.signal },
      nodeCfg,
      { timeoutMs: 3000 },
    );
    assert.equal(okRes.status, 200);
    const okBody = (await okRes.json()) as { ok: boolean };
    assert.equal(okBody.ok, true);
    assert.equal(
      getEventListeners(controller.signal, 'abort').length,
      0,
      'AbortSignal listener must be removed after response finishes',
    );

    // 3. fetchViaExitNode enforces request timeout and cleans up AbortSignal listener
    hangUpstream = true;
    const timeoutController = new AbortController();
    await assert.rejects(
      () =>
        fetchViaExitNode(
          `http://127.0.0.1:${upstreamPort}/hang`,
          { method: 'GET', signal: timeoutController.signal },
          nodeCfg,
          { timeoutMs: 150 },
        ),
      /timed out/i,
    );
    assert.equal(
      getEventListeners(timeoutController.signal, 'abort').length,
      0,
      'AbortSignal listener must be removed after timeout',
    );
  });

  it('migrates legacy nodes table idempotently to add pending_encrypted_token column', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(':memory:');
    cleanupCallbacks.push(() => db.close());

    db.exec(`
      CREATE TABLE nodes (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        mode TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        prev_token_hash TEXT,
        prev_token_expires_at INTEGER,
        last_seen_at INTEGER,
        last_rotated_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'offline',
        created_at INTEGER NOT NULL
      );
    `);

    initDatabase(db);
    initDatabase(db); // Second call must remain idempotent

    const cols = db.prepare(`PRAGMA table_info(nodes)`).all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    assert.ok(names.has('pending_encrypted_token'));
    assert.ok(names.has('encrypted_token'));
    assert.ok(names.has('tls_fingerprint'));
    assert.ok(names.has('last_commit'));
  });
});

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import zlib from 'node:zlib';

import { createApp } from '../core/src/app.js';
import { encryptSecret, sha256Hex } from '../core/src/crypto.js';
import { openDatabase } from '../core/src/db.js';
import { waitForPendingPlaygroundStreamsForTests } from '../core/src/playground.js';
import { resetGeneratingChatsForTests } from '../core/src/playground-history.js';
import { startBifrostHttpServer } from '../core/src/server.js';

const tempDirs: string[] = [];

function makeTempDir(prefix = 'bifrost-sse-rt-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function extractCookiePair(setCookieHeader: string | null): string {
  assert.ok(setCookieHeader, 'Expected Set-Cookie header to be present');
  return setCookieHeader.split(';')[0]!;
}

function closeHttpServer(server: {
  close: (cb?: () => void) => unknown;
  closeAllConnections?: () => void;
}): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}

interface GatedUpstreamServer {
  url: string;
  port: number;
  receivedHeaders: Array<http.IncomingHttpHeaders>;
  resetGate: () => void;
  releaseChunk2: () => void;
  close: () => Promise<void>;
}

/**
 * Starts a real local HTTP upstream SSE server with an explicit gate between chunk 1 and chunk 2.
 * If the caller requests gzip (`Accept-Encoding: gzip`), this server compresses with `zlib.createGzip()`
 * (default block-buffering) so any missing `Accept-Encoding: identity` immediately triggers buffering
 * and fails the real-time test.
 */
async function startGatedUpstreamSseServer(): Promise<GatedUpstreamServer> {
  let releaseGate!: () => void;
  let chunk2Gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  const receivedHeaders: Array<http.IncomingHttpHeaders> = [];

  const server = http.createServer(async (req, res) => {
    receivedHeaders.push({ ...req.headers });
    // Consume request body
    for await (const _chunk of req) {
      // noop
    }

    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      const acceptEnc = String(req.headers['accept-encoding'] ?? '').toLowerCase();
      const chunk1 = `data: ${JSON.stringify({
        id: 'chatcmpl-rt-1',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { role: 'assistant', content: 'ChunkOne ' }, finish_reason: null }],
      })}\n\n`;
      const chunk2 = `data: ${JSON.stringify({
        id: 'chatcmpl-rt-1',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { content: 'ChunkTwo' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
      })}\n\n`;

      if (acceptEnc.includes('gzip')) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Content-Encoding': 'gzip',
        });
        const gz = zlib.createGzip();
        gz.pipe(res);
        gz.write(chunk1);
        await chunk2Gate;
        gz.write(chunk2);
        gz.end('data: [DONE]\n\n');
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
      });
      res.flushHeaders();
      res.write(chunk1);
      await chunk2Gate;
      res.write(chunk2);
      res.end('data: [DONE]\n\n');
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as net.AddressInfo;

  return {
    url: `http://127.0.0.1:${addr.port}`,
    port: addr.port,
    receivedHeaders,
    resetGate() {
      chunk2Gate = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
    },
    releaseChunk2() {
      releaseGate();
    },
    close() {
      return closeHttpServer(server);
    },
  };
}

interface RealtimeHttpStreamClient {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  waitForText: (needle: string, timeoutMs?: number) => Promise<string>;
  waitForEnd: (timeoutMs?: number) => Promise<string>;
  destroy: () => void;
}

/**
 * Opens a real TCP HTTP/1.1 streaming POST request using `node:http` with zero client-side buffering,
 * exposing incremental data arrival events so tests can assert chunk 1 arrives while upstream is still blocked.
 */
function openRealtimeHttpPost(options: {
  port: number;
  path: string;
  headers: Record<string, string>;
  body: string;
}): Promise<RealtimeHttpStreamClient> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: options.port,
        path: options.path,
        method: 'POST',
        headers: {
          ...options.headers,
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(options.body)),
          Connection: 'close',
        },
      },
      (res) => {
        let accumulated = '';
        let ended = false;
        let streamError: Error | null = null;
        const waiters: Array<() => void> = [];

        const notify = () => {
          const copy = waiters.splice(0, waiters.length);
          for (const fn of copy) fn();
        };

        res.on('data', (chunk: Buffer) => {
          accumulated += chunk.toString('utf8');
          notify();
        });
        res.on('end', () => {
          ended = true;
          notify();
        });
        res.on('error', (err) => {
          streamError = err;
          ended = true;
          notify();
        });

        const waitForText = (needle: string, timeoutMs = 2000): Promise<string> => {
          if (accumulated.includes(needle)) {
            return Promise.resolve(accumulated);
          }
          if (streamError) {
            return Promise.reject(streamError);
          }
          if (ended) {
            return Promise.reject(
              new Error(`Stream ended before receiving ${JSON.stringify(needle)}. Got: ${accumulated}`),
            );
          }
          return new Promise<string>((resWait, rejWait) => {
            const timer = setTimeout(() => {
              rejWait(
                new Error(
                  `Timed out after ${timeoutMs}ms waiting for ${JSON.stringify(needle)} (response is likely buffered!). Received so far: ${JSON.stringify(accumulated)}`,
                ),
              );
            }, timeoutMs);

            const check = () => {
              if (accumulated.includes(needle)) {
                clearTimeout(timer);
                resWait(accumulated);
                return;
              }
              if (streamError) {
                clearTimeout(timer);
                rejWait(streamError);
                return;
              }
              if (ended) {
                clearTimeout(timer);
                rejWait(
                  new Error(
                    `Stream ended before receiving ${JSON.stringify(needle)}. Got: ${accumulated}`,
                  ),
                );
                return;
              }
              waiters.push(check);
            };
            waiters.push(check);
          });
        };

        const waitForEnd = (timeoutMs = 3000): Promise<string> => {
          if (streamError) return Promise.reject(streamError);
          if (ended) return Promise.resolve(accumulated);
          return new Promise<string>((resEnd, rejEnd) => {
            const timer = setTimeout(() => {
              rejEnd(new Error(`Timed out after ${timeoutMs}ms waiting for stream end.`));
            }, timeoutMs);

            const check = () => {
              if (streamError) {
                clearTimeout(timer);
                rejEnd(streamError);
                return;
              }
              if (ended) {
                clearTimeout(timer);
                resEnd(accumulated);
                return;
              }
              waiters.push(check);
            };
            waiters.push(check);
          });
        };

        resolve({
          statusCode: res.statusCode ?? 0,
          headers: res.headers,
          waitForText,
          waitForEnd,
          destroy: () => {
            res.destroy();
            req.destroy();
          },
        });
      },
    );

    req.on('error', reject);
    req.end(options.body);
  });
}

afterEach(() => {
  resetGeneratingChatsForTests();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('Real-Time SSE Streaming End-to-End (No Buffering)', () => {
  it('streams chunks immediately over real HTTP on /v1/chat/completions, /api/playground/chat, and exit-node tunnels while upstream is still blocked', async () => {
    const dir = makeTempDir();
    const db = openDatabase(path.join(dir, 'bifrost.db'));
    const masterKey = randomBytes(32);
    const upstream = await startGatedUpstreamSseServer();

    const app = createApp({
      db,
      masterKey,
      allowLocalhostUpstreamsForTests: true,
    });

    let bifrostPort = 0;
    const bifrostServer = await new Promise<ReturnType<typeof startBifrostHttpServer>>((resolve) => {
      const srv = startBifrostHttpServer(app, {
        hostname: '127.0.0.1',
        port: 0,
        onListening: (info) => {
          bifrostPort = info.port;
          resolve(srv);
        },
      });
    });

    let connectProxy: http.Server | null = null;

    try {
      // 1. Bootstrap admin, internal API key, provider (with Accept-Encoding: gzip in extraHeaders to verify override), key, and static model
      const setupRes = await app.request('/api/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'admin-password-123' }),
      });
      assert.equal(setupRes.status, 201);
      const adminCookie = extractCookiePair(setupRes.headers.get('set-cookie'));

      const keyRes = await app.request('/api/keys', {
        method: 'POST',
        headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'SSE Realtime Test Key' }),
      });
      assert.equal(keyRes.status, 201);
      const { rawKey: internalApiKey } = (await keyRes.json()) as { rawKey: string };

      const provRes = await app.request('/api/providers', {
        method: 'POST',
        headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          schemaVersion: '1.0',
          id: 'realtime-mock',
          name: 'Realtime Mock Provider',
          packageType: 'official-json',
          baseUrl: `${upstream.url}/v1`,
          auth: {
            type: 'bearer',
            header: 'Authorization',
            prefix: 'Bearer ',
            extraHeaders: { 'Accept-Encoding': 'gzip, br' },
          },
          modelsSource: 'static',
          staticModels: [{ id: 'stream-model', name: 'Stream Model' }],
        }),
      });
      assert.equal(provRes.status, 201);

      const provKeyRes = await app.request('/api/providers/realtime-mock/keys', {
        method: 'POST',
        headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: 'Primary', secret: 'sk-upstream-realtime-key-1234' }),
      });
      assert.equal(provKeyRes.status, 201);
      const provKeyBody = (await provKeyRes.json()) as { key: { id: string } };

      const detectRes = await app.request('/api/providers/realtime-mock/detect-models', {
        method: 'POST',
        headers: { Cookie: adminCookie },
      });
      assert.equal(detectRes.status, 200);

      // =========================================================================
      // Case 1: Real HTTP POST /v1/chat/completions (stream: true)
      // =========================================================================
      const v1Client = await openRealtimeHttpPost({
        port: bifrostPort,
        path: '/v1/chat/completions',
        headers: {
          Authorization: `Bearer ${internalApiKey}`,
          Accept: 'text/event-stream',
        },
        body: JSON.stringify({
          model: 'realtime-mock/stream-model',
          stream: true,
          messages: [{ role: 'user', content: 'Say hello in two chunks' }],
        }),
      });

      assert.equal(v1Client.statusCode, 200);
      assert.ok(
        String(v1Client.headers['content-type'] ?? '').includes('text/event-stream'),
        `Expected text/event-stream, got ${String(v1Client.headers['content-type'])}`,
      );
      assert.equal(v1Client.headers['x-accel-buffering'], 'no');
      assert.ok(
        String(v1Client.headers['cache-control'] ?? '').includes('no-cache') &&
          String(v1Client.headers['cache-control'] ?? '').includes('no-transform'),
        `Expected Cache-Control: no-cache, no-transform, got ${String(v1Client.headers['cache-control'])}`,
      );
      assert.equal(v1Client.headers['content-length'], undefined, 'SSE must NOT send Content-Length');
      assert.equal(v1Client.headers['transfer-encoding'], 'chunked');
      assert.equal(
        upstream.receivedHeaders[0]?.['accept-encoding'],
        'identity',
        'Router must force Accept-Encoding: identity on upstream SSE requests',
      );

      // CRITICAL ASSERTION: Chunk 1 MUST arrive BEFORE we release chunk2Gate on upstream!
      const v1BeforeGate = await v1Client.waitForText('ChunkOne ', 2000);
      assert.ok(!v1BeforeGate.includes('ChunkTwo'), 'ChunkTwo should still be gated on upstream');

      // Now release chunk 2 + [DONE]
      upstream.releaseChunk2();
      const v1Full = await v1Client.waitForEnd(3000);
      assert.ok(v1Full.includes('ChunkOne '));
      assert.ok(v1Full.includes('ChunkTwo'));
      assert.ok(v1Full.includes('data: [DONE]'));
      assert.ok(
        v1Full.indexOf('ChunkOne ') < v1Full.indexOf('ChunkTwo'),
        'Chunks must arrive in order',
      );

      // =========================================================================
      // Case 2: Real HTTP POST /api/playground/chat (stream: true + HU-43b chatId)
      // =========================================================================
      upstream.resetGate();

      const createChatRes = await app.request('/api/playground/chats', {
        method: 'POST',
        headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelFullId: 'realtime-mock/stream-model' }),
      });
      assert.equal(createChatRes.status, 201);
      const createdChat = (await createChatRes.json()) as { chat: { id: string } };

      const pgClient = await openRealtimeHttpPost({
        port: bifrostPort,
        path: '/api/playground/chat',
        headers: {
          Cookie: adminCookie,
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          chatId: createdChat.chat.id,
          model: 'realtime-mock/stream-model',
          stream: true,
          messages: [{ role: 'user', content: 'Playground real-time check' }],
        }),
      });

      assert.equal(pgClient.statusCode, 200);
      assert.ok(String(pgClient.headers['content-type'] ?? '').includes('text/event-stream'));
      assert.equal(pgClient.headers['x-accel-buffering'], 'no');
      assert.ok(
        String(pgClient.headers['cache-control'] ?? '').includes('no-cache') &&
          String(pgClient.headers['cache-control'] ?? '').includes('no-transform'),
      );
      assert.equal(pgClient.headers['content-length'], undefined);
      assert.equal(pgClient.headers['transfer-encoding'], 'chunked');

      // CRITICAL ASSERTION: Chunk 1 MUST arrive at Playground client while upstream is still blocked!
      const pgBeforeGate = await pgClient.waitForText('ChunkOne ', 2000);
      assert.ok(!pgBeforeGate.includes('ChunkTwo'), 'ChunkTwo should still be gated on upstream');

      upstream.releaseChunk2();
      const pgFull = await pgClient.waitForEnd(3000);
      assert.ok(pgFull.includes('ChunkOne '));
      assert.ok(pgFull.includes('ChunkTwo'));
      assert.ok(pgFull.includes('bifrost.playground.metrics'));
      assert.ok(pgFull.includes('data: [DONE]'));

      await waitForPendingPlaygroundStreamsForTests();
      const chatDetailRes = await app.request(`/api/playground/chats/${createdChat.chat.id}`, {
        headers: { Cookie: adminCookie },
      });
      assert.equal(chatDetailRes.status, 200);
      const chatDetail = (await chatDetailRes.json()) as {
        messages: Array<{ role: string; content: string }>;
      };
      const assistantMsg = chatDetail.messages.find((m) => m.role === 'assistant');
      assert.equal(assistantMsg?.content, 'ChunkOne ChunkTwo');

      // =========================================================================
      // Case 3: Real HTTP POST /v1/chat/completions via Exit Node CONNECT Tunnel
      // =========================================================================
      upstream.resetGate();
      const nodeToken = 'node-realtime-sse-test-token-123456';
      connectProxy = http.createServer();
      connectProxy.on('connect', (req, clientSock, head) => {
        const auth = String(req.headers['proxy-authorization'] ?? '');
        if (auth !== `Bearer ${nodeToken}`) {
          clientSock.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
          return;
        }
        const [host, portStr] = String(req.url ?? '').split(':');
        const upSock = net.connect(Number(portStr), host!, () => {
          upSock.setNoDelay(true);
          clientSock.setNoDelay(true);
          clientSock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          if (head && head.length > 0) upSock.write(head);
          upSock.pipe(clientSock);
          clientSock.pipe(upSock);
        });
        upSock.on('error', () => clientSock.destroy());
        clientSock.on('error', () => upSock.destroy());
      });
      await new Promise<void>((resolve) => connectProxy!.listen(0, '127.0.0.1', () => resolve()));
      const proxyPort = (connectProxy.address() as net.AddressInfo).port;

      db.prepare(
        `INSERT INTO nodes (id, name, mode, endpoint, token_hash, encrypted_token, status, created_at)
         VALUES (?, ?, 'tailscale', ?, ?, ?, 'online', ?)`,
      ).run(
        'node-rt-1',
        'Local CONNECT Node',
        `127.0.0.1:${proxyPort}`,
        sha256Hex(nodeToken),
        encryptSecret(nodeToken, masterKey),
        Math.floor(Date.now() / 1000),
      );
      db.prepare(`UPDATE provider_keys SET node_id = ? WHERE id = ?`).run(
        'node-rt-1',
        provKeyBody.key.id,
      );

      const tunnelClient = await openRealtimeHttpPost({
        port: bifrostPort,
        path: '/v1/chat/completions',
        headers: {
          Authorization: `Bearer ${internalApiKey}`,
          Accept: 'text/event-stream',
        },
        body: JSON.stringify({
          model: 'realtime-mock/stream-model',
          stream: true,
          messages: [{ role: 'user', content: 'Stream over CONNECT exit node' }],
        }),
      });

      assert.equal(tunnelClient.statusCode, 200);
      assert.equal(tunnelClient.headers['x-accel-buffering'], 'no');
      assert.equal(tunnelClient.headers['transfer-encoding'], 'chunked');

      // CRITICAL ASSERTION: Chunk 1 MUST arrive over the exit-node tunnel while upstream is still blocked!
      const tunnelBeforeGate = await tunnelClient.waitForText('ChunkOne ', 2000);
      assert.ok(!tunnelBeforeGate.includes('ChunkTwo'));

      upstream.releaseChunk2();
      const tunnelFull = await tunnelClient.waitForEnd(3000);
      assert.ok(tunnelFull.includes('ChunkOne '));
      assert.ok(tunnelFull.includes('ChunkTwo'));
      assert.ok(tunnelFull.includes('data: [DONE]'));
    } finally {
      upstream.releaseChunk2();
      await waitForPendingPlaygroundStreamsForTests();
      if (connectProxy) {
        await closeHttpServer(connectProxy);
      }
      await closeHttpServer(bifrostServer);
      await upstream.close();
      db.close();
    }
  });
});

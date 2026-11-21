import { randomBytes } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type { DatabaseSync } from 'node:sqlite';
import tls from 'node:tls';
import { decryptSecret, encryptSecret, sha256Hex } from './crypto.js';
import { redactSecretsInText, writeSystemLog } from './db.js';

export type NodeMode = 'tailscale' | 'public_ip';
export type NodeStatus = 'online' | 'unresponsive' | 'offline';

export const NODE_GRACE_SECONDS = 300; // 5 minutes (HU-11c)
export const NODE_UNRESPONSIVE_SECONDS = 120; // >120s without heartbeat -> unresponsive (HU-12)
export const NODE_ROTATION_INTERVAL_SECONDS = 24 * 60 * 60; // 24 hours (HU-11c)
export const DEFAULT_NODE_PORT = 9443;

export interface ParsedEndpoint {
  host: string;
  port: number;
  normalized: string;
}

export interface NodeTunnelConfig {
  id: string;
  name: string;
  mode: NodeMode;
  endpoint: string;
  rawToken: string;
  tlsFingerprint: string | null;
}

export interface UpstreamTlsOptions {
  ca?: string | Buffer | Array<string | Buffer>;
  rejectUnauthorized?: boolean;
  pinnedFingerprintSha256?: string;
}

export function normalizeHexFingerprint(fp: string): string {
  return fp.replace(/:/g, '').replace(/\s+/g, '').toUpperCase();
}

export function parseNodeEndpoint(rawEndpoint: string): ParsedEndpoint | null {
  let trimmed = rawEndpoint.trim();
  if (!trimmed) return null;

  // Strip optional scheme if user pasted http:// or https://
  trimmed = trimmed.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  if (!trimmed || /\s/.test(trimmed) || trimmed.includes('/')) {
    return null;
  }

  let host: string;
  let port = DEFAULT_NODE_PORT;

  if (trimmed.startsWith('[')) {
    const closeIdx = trimmed.indexOf(']');
    if (closeIdx === -1) return null;
    host = trimmed.slice(1, closeIdx);
    const rest = trimmed.slice(closeIdx + 1);
    if (rest.startsWith(':')) {
      const pStr = rest.slice(1);
      if (!/^\d+$/.test(pStr)) return null;
      port = Number(pStr);
    } else if (rest.length > 0) {
      return null;
    }
  } else {
    const colonCount = (trimmed.match(/:/g) ?? []).length;
    if (colonCount > 1) {
      return null; // Unbracketed IPv6 literal
    }
    if (colonCount === 1) {
      const idx = trimmed.indexOf(':');
      host = trimmed.slice(0, idx);
      const pStr = trimmed.slice(idx + 1);
      if (!/^\d+$/.test(pStr)) return null;
      port = Number(pStr);
    } else {
      host = trimmed;
    }
  }

  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    return null;
  }

  const normalizedHost = host.includes(':') ? `[${host.toLowerCase()}]` : host.toLowerCase();
  return {
    host: host.toLowerCase(),
    port,
    normalized: `${normalizedHost}:${port}`,
  };
}

export function generateNodeToken(): { rawToken: string; tokenHash: string } {
  const rawToken = randomBytes(32).toString('base64url');
  const tokenHash = sha256Hex(rawToken);
  return { rawToken, tokenHash };
}

export function buildNodeInstallCommand(params: {
  mode: NodeMode;
  endpoint: string;
  rawToken: string;
  serverOrigin?: string;
}): string {
  const parsed = parseNodeEndpoint(params.endpoint);
  const port = parsed?.port ?? DEFAULT_NODE_PORT;
  const origin = (params.serverOrigin ?? 'https://raw.githubusercontent.com/sxamx/bifrost/main/nodes').replace(
    /\/+$/,
    '',
  );
  const scriptUrl = origin.endsWith('/nodes')
    ? `${origin}/install-node.sh`
    : `${origin}/install-node.sh`;
  return `curl -fsSL ${scriptUrl} | sudo bash -s -- --mode ${params.mode} --port ${port} --token "${params.rawToken}"`;
}

export const PUBLIC_IP_WARNING_MESSAGE =
  'Advertencia de seguridad: el modo IP pública expone un puerto TCP fuera de Tailscale. Usa TLS con huella SHA-256 verificada y restringe el firewall únicamente a la IP del servidor Bifrost.';

/**
 * Calls a control-plane endpoint on an egress node (`/_bifrost/health` or `/_bifrost/rotate`).
 */
export function callNodeControlPlane(params: {
  mode: NodeMode;
  endpoint: string;
  rawToken: string;
  tlsFingerprint?: string | null;
  method: 'GET' | 'POST';
  path: string;
  body?: Record<string, unknown>;
  timeoutMs?: number;
}): Promise<{ status: number; data: Record<string, unknown>; peerFingerprint?: string | null }> {
  const parsedEp = parseNodeEndpoint(params.endpoint);
  if (!parsedEp) {
    return Promise.reject(new Error(`Invalid node endpoint: "${params.endpoint}"`));
  }

  const timeoutMs = params.timeoutMs ?? 5000;
  const bodyStr = params.body ? JSON.stringify(params.body) : undefined;
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Proxy-Authorization': `Bearer ${params.rawToken}`,
    Authorization: `Bearer ${params.rawToken}`,
    Connection: 'close',
  };
  if (bodyStr !== undefined) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = String(Buffer.byteLength(bodyStr));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let observedPeerFingerprint: string | null = null;
    const finishReject = (err: Error) => {
      if (settled) return;
      settled = true;
      reject(new Error(redactSecretsInText(err.message)));
    };

    const onResponse = (res: http.IncomingMessage) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        if (settled) return;
        settled = true;
        const text = Buffer.concat(chunks).toString('utf8');
        let data: Record<string, unknown> = {};
        try {
          data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
        } catch {
          data = { raw: text };
        }
        resolve({ status: res.statusCode ?? 0, data, peerFingerprint: observedPeerFingerprint });
      });
      res.on('error', finishReject);
    };

    let req: http.ClientRequest;
    if (params.mode === 'public_ip') {
      const pinnedNorm = params.tlsFingerprint
        ? normalizeHexFingerprint(params.tlsFingerprint)
        : null;
      const agent = new https.Agent({ keepAlive: false });
      agent.createConnection = () => {
        const sock = tls.connect({
          host: parsedEp.host,
          port: parsedEp.port,
          servername: net.isIP(parsedEp.host) ? undefined : parsedEp.host,
          rejectUnauthorized: false,
        });
        sock.once('secureConnect', () => {
          const peerCert = sock.getPeerCertificate();
          const actualNorm = peerCert?.fingerprint256
            ? normalizeHexFingerprint(peerCert.fingerprint256)
            : '';
          if (actualNorm) {
            observedPeerFingerprint = peerCert.fingerprint256;
          }
          if (pinnedNorm !== null && (!actualNorm || actualNorm !== pinnedNorm)) {
            sock.destroy(new Error('Node TLS certificate SHA-256 fingerprint mismatch'));
          }
        });
        return sock;
      };

      req = https.request(
        {
          hostname: parsedEp.host,
          port: parsedEp.port,
          path: params.path,
          method: params.method,
          headers,
          agent,
          rejectUnauthorized: false,
        },
        onResponse,
      );
    } else {
      req = http.request(
        {
          hostname: parsedEp.host,
          port: parsedEp.port,
          path: params.path,
          method: params.method,
          headers,
          agent: false,
        },
        onResponse,
      );
    }

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Node request timed out after ${timeoutMs}ms`));
    });
    req.on('error', finishReject);

    if (bodyStr !== undefined) {
      req.write(bodyStr);
    }
    req.end();
  });
}

function openConnectSocketToNode(
  node: NodeTunnelConfig,
  targetAuthority: string,
  timeoutMs: number,
): Promise<net.Socket | tls.TLSSocket> {
  const parsedEp = parseNodeEndpoint(node.endpoint);
  if (!parsedEp) {
    return Promise.reject(new Error(`Invalid node endpoint "${node.endpoint}"`));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const pinnedNorm = node.tlsFingerprint
      ? normalizeHexFingerprint(node.tlsFingerprint)
      : null;

    const sock: net.Socket | tls.TLSSocket =
      node.mode === 'public_ip'
        ? tls.connect({
            host: parsedEp.host,
            port: parsedEp.port,
            servername: net.isIP(parsedEp.host) ? undefined : parsedEp.host,
            rejectUnauthorized: false,
          })
        : net.connect({
            host: parsedEp.host,
            port: parsedEp.port,
          });

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        sock.destroy();
        reject(new Error(`Egress node CONNECT timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);
    timer.unref();

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      reject(new Error(redactSecretsInText(err.message)));
    };

    const sendConnectHandshake = () => {
      if (node.mode === 'public_ip' && pinnedNorm !== null && sock instanceof tls.TLSSocket) {
        const peerCert = sock.getPeerCertificate();
        const actualNorm = peerCert?.fingerprint256
          ? normalizeHexFingerprint(peerCert.fingerprint256)
          : '';
        if (!actualNorm || actualNorm !== pinnedNorm) {
          fail(new Error('Egress node TLS fingerprint verification failed'));
          return;
        }
      }

      const connectReq = [
        `CONNECT ${targetAuthority} HTTP/1.1`,
        `Host: ${targetAuthority}`,
        `Proxy-Authorization: Bearer ${node.rawToken}`,
        '',
        '',
      ].join('\r\n');

      sock.write(connectReq);
    };

    if (node.mode === 'public_ip') {
      sock.once('secureConnect', sendConnectHandshake);
    } else {
      sock.once('connect', sendConnectHandshake);
    }

    let headerBuf = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      headerBuf = Buffer.concat([headerBuf, chunk]);
      const endIdx = headerBuf.indexOf('\r\n\r\n');
      if (endIdx === -1) {
        if (headerBuf.length > 16384) {
          fail(new Error('Oversized CONNECT response headers from egress node'));
        }
        return;
      }

      sock.off('data', onData);
      sock.off('error', fail);
      clearTimeout(timer);

      const headerStr = headerBuf.subarray(0, endIdx).toString('utf8');
      const leftover = headerBuf.subarray(endIdx + 4);
      if (leftover.length > 0) {
        sock.unshift(leftover);
      }

      const statusLine = headerStr.split('\r\n')[0] ?? '';
      const match = /^HTTP\/1\.[01]\s+(\d{3})/.exec(statusLine);
      const statusCode = match ? Number(match[1]) : 0;

      if (statusCode !== 200) {
        settled = true;
        sock.destroy();
        reject(new Error(`Egress node rejected CONNECT with HTTP ${statusCode}`));
        return;
      }

      settled = true;
      resolve(sock);
    };

    sock.on('data', onData);
    sock.once('error', fail);
    sock.once('close', () => {
      if (!settled) {
        fail(new Error('Egress node closed socket before completing CONNECT'));
      }
    });
  });
}

/**
 * Performs an end-to-end HTTP or HTTPS request tunneled through a Bifrost egress node
 * using HTTP CONNECT. For HTTPS targets, TLS is negotiated directly between core/ and
 * the target provider over the raw TCP pipe so the node NEVER sees headers or payloads.
 */
export async function fetchViaExitNode(
  targetUrl: string,
  init: RequestInit | undefined,
  node: NodeTunnelConfig,
  upstreamTls?: UpstreamTlsOptions,
): Promise<Response> {
  const parsedUrl = new URL(targetUrl);
  const isHttps = parsedUrl.protocol === 'https:';
  if (!isHttps && parsedUrl.protocol !== 'http:') {
    throw new Error(`Unsupported target protocol: ${parsedUrl.protocol}`);
  }

  const rawHost = parsedUrl.hostname.replace(/^\[|\]$/g, '');
  const targetPort = parsedUrl.port ? Number(parsedUrl.port) : isHttps ? 443 : 80;
  const targetAuthority = rawHost.includes(':')
    ? `[${rawHost}]:${targetPort}`
    : `${rawHost}:${targetPort}`;

  const tunnelSocket = await openConnectSocketToNode(node, targetAuthority, 10_000);

  const method = (init?.method ?? 'GET').toUpperCase();
  const reqHeaders: Record<string, string> = {
    Connection: 'close',
  };

  if (init?.headers) {
    const h = new Headers(init.headers);
    h.forEach((value, key) => {
      reqHeaders[key] = value;
    });
  }

  let bodyBuffer: Buffer | undefined;
  if (init?.body !== undefined && init.body !== null) {
    if (typeof init.body === 'string') {
      bodyBuffer = Buffer.from(init.body, 'utf8');
    } else if (Buffer.isBuffer(init.body)) {
      bodyBuffer = init.body;
    } else if (init.body instanceof Uint8Array) {
      bodyBuffer = Buffer.from(init.body);
    } else {
      bodyBuffer = Buffer.from(String(init.body), 'utf8');
    }
    if (!Object.keys(reqHeaders).some((k) => k.toLowerCase() === 'content-length')) {
      reqHeaders['Content-Length'] = String(bodyBuffer.byteLength);
    }
  }

  const pathWithQuery = `${parsedUrl.pathname || '/'}${parsedUrl.search || ''}`;

  return new Promise<Response>((resolve, reject) => {
    let headersResolved = false;

    const onError = (err: Error) => {
      tunnelSocket.destroy();
      if (!headersResolved) {
        headersResolved = true;
        reject(new Error(redactSecretsInText(err.message)));
      }
    };

    const onIncomingResponse = (res: http.IncomingMessage) => {
      headersResolved = true;

      const responseHeaders = new Headers();
      for (const [k, v] of Object.entries(res.headers)) {
        if (v === undefined) continue;
        if (Array.isArray(v)) {
          for (const item of v) responseHeaders.append(k, item);
        } else {
          responseHeaders.set(k, v);
        }
      }

      const status = res.statusCode ?? 502;
      if (status === 204 || status === 304 || method === 'HEAD') {
        res.resume();
        resolve(new Response(null, { status, headers: responseHeaders }));
        return;
      }

      const webStream = new ReadableStream<Uint8Array>({
        start(controller) {
          res.on('data', (chunk: Buffer) => {
            controller.enqueue(new Uint8Array(chunk));
          });
          res.on('end', () => {
            controller.close();
          });
          res.on('error', (err) => {
            controller.error(err);
          });
          res.on('close', () => {
            if (!res.complete) {
              try {
                controller.error(new Error('Upstream stream closed prematurely'));
              } catch {
                // Controller already closed/errored
              }
            }
          });
        },
        cancel() {
          res.destroy();
          tunnelSocket.destroy();
        },
      });

      resolve(new Response(webStream, { status, headers: responseHeaders }));
    };

    let clientReq: http.ClientRequest;

    if (isHttps) {
      const pinnedTargetFp = upstreamTls?.pinnedFingerprintSha256
        ? normalizeHexFingerprint(upstreamTls.pinnedFingerprintSha256)
        : null;
      const shouldVerifyCa =
        pinnedTargetFp !== null ? false : (upstreamTls?.rejectUnauthorized ?? true);

      const agent = new https.Agent({ keepAlive: false });
      agent.createConnection = () => {
        const tlsSock = tls.connect({
          socket: tunnelSocket,
          servername: net.isIP(rawHost) ? undefined : rawHost,
          ca: upstreamTls?.ca,
          rejectUnauthorized: shouldVerifyCa,
        });
        if (pinnedTargetFp !== null) {
          tlsSock.once('secureConnect', () => {
            const peer = tlsSock.getPeerCertificate();
            const actualFp = peer?.fingerprint256
              ? normalizeHexFingerprint(peer.fingerprint256)
              : '';
            if (!actualFp || actualFp !== pinnedTargetFp) {
              tlsSock.destroy(new Error('Upstream TLS certificate fingerprint mismatch'));
            }
          });
        }
        return tlsSock;
      };

      clientReq = https.request(
        {
          hostname: rawHost,
          port: targetPort,
          path: pathWithQuery,
          method,
          headers: reqHeaders,
          agent,
          ca: upstreamTls?.ca,
          rejectUnauthorized: shouldVerifyCa,
        },
        onIncomingResponse,
      );
    } else {
      const agent = new http.Agent({ keepAlive: false });
      agent.createConnection = () => tunnelSocket;

      clientReq = http.request(
        {
          hostname: rawHost,
          port: targetPort,
          path: pathWithQuery,
          method,
          headers: reqHeaders,
          agent,
        },
        onIncomingResponse,
      );
    }

    if (init?.signal) {
      if (init.signal.aborted) {
        clientReq.destroy(new Error('Request aborted'));
        return;
      }
      init.signal.addEventListener(
        'abort',
        () => {
          clientReq.destroy(new Error('Request aborted'));
        },
        { once: true },
      );
    }

    clientReq.on('error', onError);
    if (bodyBuffer) {
      clientReq.write(bodyBuffer);
    }
    clientReq.end();
  });
}

export class NodeOperationError extends Error {
  public readonly status: 400 | 404 | 409 | 502;

  constructor(message: string, status: 400 | 404 | 409 | 502) {
    super(message);
    this.name = 'NodeOperationError';
    this.status = status;
  }
}

/**
 * Rotates a node's token (HU-11c): sends POST /_bifrost/rotate to the node
 * authenticated with the active token, then stores the new encrypted token and
 * preserves prev_token_hash for a 5-minute grace window.
 */
export async function rotateNodeToken(params: {
  db: DatabaseSync;
  masterKey: Buffer;
  nodeId: string;
  nowSec: number;
  timeoutMs?: number;
}): Promise<{
  ok: true;
  nodeId: string;
  lastRotatedAt: number;
  prevTokenExpiresAt: number;
  graceSeconds: number;
}> {
  const { db, masterKey, nodeId, nowSec, timeoutMs } = params;

  const nodeRow = db
    .prepare(`SELECT * FROM nodes WHERE id = ?`)
    .get(nodeId) as Record<string, unknown> | undefined;

  if (!nodeRow) {
    throw new NodeOperationError(`Node "${nodeId}" not found.`, 404);
  }

  if (!nodeRow.encrypted_token) {
    throw new NodeOperationError(
      `Node "${nodeId}" has no stored encrypted credential for rotation.`,
      400,
    );
  }

  const currentRawToken = decryptSecret(nodeRow.encrypted_token as Uint8Array, masterKey);
  const { rawToken: newRawToken, tokenHash: newTokenHash } = generateNodeToken();

  let rotateRes: { status: number; data: Record<string, unknown> };
  try {
    rotateRes = await callNodeControlPlane({
      mode: nodeRow.mode === 'public_ip' ? 'public_ip' : 'tailscale',
      endpoint: String(nodeRow.endpoint),
      rawToken: currentRawToken,
      tlsFingerprint:
        nodeRow.tls_fingerprint === null || nodeRow.tls_fingerprint === undefined
          ? null
          : String(nodeRow.tls_fingerprint),
      method: 'POST',
      path: '/_bifrost/rotate',
      body: { newToken: newRawToken },
      timeoutMs: timeoutMs ?? 5000,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    writeSystemLog(
      db,
      'error',
      'node',
      `Failed to rotate token on node "${String(nodeRow.name)}": ${msg}`,
      { nodeId },
      nowSec,
    );
    throw new NodeOperationError(
      `Unable to reach node "${String(nodeRow.name)}" for token rotation: ${msg}`,
      502,
    );
  }

  if (rotateRes.status !== 200 || rotateRes.data.ok !== true) {
    writeSystemLog(
      db,
      'error',
      'node',
      `Node "${String(nodeRow.name)}" rejected token rotation with HTTP ${rotateRes.status}`,
      { nodeId, status: rotateRes.status },
      nowSec,
    );
    throw new NodeOperationError(
      `Node "${String(nodeRow.name)}" rejected token rotation (HTTP ${rotateRes.status}).`,
      502,
    );
  }

  const prevTokenExpiresAt = nowSec + NODE_GRACE_SECONDS;
  const newEncryptedToken = encryptSecret(newRawToken, masterKey);

  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(
      `UPDATE nodes
       SET prev_token_hash = token_hash,
           prev_token_expires_at = ?,
           token_hash = ?,
           encrypted_token = ?,
           last_rotated_at = ?,
           last_seen_at = ?,
           status = 'online'
       WHERE id = ?`,
    ).run(prevTokenExpiresAt, newTokenHash, newEncryptedToken, nowSec, nowSec, nodeId);

    db.prepare(
      `UPDATE provider_keys
       SET status = 'active', last_error = NULL
       WHERE node_id = ? AND status = 'no_node'`,
    ).run(nodeId);

    writeSystemLog(
      db,
      'info',
      'node',
      `Rotated authentication token for node "${String(nodeRow.name)}" (5m grace window active)`,
      { nodeId, prevTokenExpiresAt, graceSeconds: NODE_GRACE_SECONDS },
      nowSec,
    );

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return {
    ok: true,
    nodeId,
    lastRotatedAt: nowSec,
    prevTokenExpiresAt,
    graceSeconds: NODE_GRACE_SECONDS,
  };
}

export interface NodesHealthTickResult {
  checkedCount: number;
  onlineCount: number;
  unresponsiveCount: number;
  offlineCount: number;
  rotatedNodeIds: string[];
}

/**
 * Runs a single health & automatic 24h token-rotation sweep across all registered nodes (HU-12, HU-11c).
 */
export async function runNodesHealthTick(
  db: DatabaseSync,
  masterKey: Buffer,
  options: {
    now?: () => number;
    timeoutMs?: number;
    unresponsiveAfterSec?: number;
    autoRotateAfterSec?: number;
  } = {},
): Promise<NodesHealthTickResult> {
  const nowFn = options.now ?? (() => Date.now());
  const nowSec = Math.floor(nowFn() / 1000);
  const timeoutMs = options.timeoutMs ?? 4000;
  const unresponsiveAfterSec = options.unresponsiveAfterSec ?? NODE_UNRESPONSIVE_SECONDS;
  const autoRotateAfterSec = options.autoRotateAfterSec ?? NODE_ROTATION_INTERVAL_SECONDS;

  // Prune expired grace-window tokens
  db.prepare(
    `UPDATE nodes
     SET prev_token_hash = NULL, prev_token_expires_at = NULL
     WHERE prev_token_expires_at IS NOT NULL AND prev_token_expires_at <= ?`,
  ).run(nowSec);

  const nodeRows = db
    .prepare(`SELECT * FROM nodes ORDER BY created_at ASC`)
    .all() as Array<Record<string, unknown>>;

  let onlineCount = 0;
  let unresponsiveCount = 0;
  let offlineCount = 0;
  const rotatedNodeIds: string[] = [];

  for (const row of nodeRows) {
    const nodeId = String(row.id);
    const nodeName = String(row.name);
    const prevStatus = String(row.status) as NodeStatus;

    if (!row.encrypted_token) {
      if (prevStatus === 'online') onlineCount++;
      else if (prevStatus === 'unresponsive') unresponsiveCount++;
      else offlineCount++;
      continue;
    }

    let rawToken: string;
    try {
      rawToken = decryptSecret(row.encrypted_token as Uint8Array, masterKey);
    } catch {
      offlineCount++;
      continue;
    }

    let healthy = false;
    let nodeCommit: string | null = null;
    try {
      const res = await callNodeControlPlane({
        mode: row.mode === 'public_ip' ? 'public_ip' : 'tailscale',
        endpoint: String(row.endpoint),
        rawToken,
        tlsFingerprint:
          row.tls_fingerprint === null || row.tls_fingerprint === undefined
            ? null
            : String(row.tls_fingerprint),
        method: 'GET',
        path: '/_bifrost/health',
        timeoutMs,
      });
      healthy = res.status === 200 && res.data.ok === true;
      if (healthy && typeof res.data.commit === 'string' && res.data.commit.trim().length > 0) {
        nodeCommit = res.data.commit.trim();
      }
    } catch {
      healthy = false;
    }

    if (healthy) {
      onlineCount++;
      db.exec('BEGIN IMMEDIATE');
      try {
        if (nodeCommit !== null) {
          db.prepare(
            `UPDATE nodes SET status = 'online', last_seen_at = ?, last_commit = ? WHERE id = ?`,
          ).run(nowSec, nodeCommit, nodeId);
        } else {
          db.prepare(`UPDATE nodes SET status = 'online', last_seen_at = ? WHERE id = ?`).run(
            nowSec,
            nodeId,
          );
        }

        const restored = db
          .prepare(
            `UPDATE provider_keys
             SET status = 'active', last_error = NULL
             WHERE node_id = ? AND status = 'no_node'`,
          )
          .run(nodeId);

        if (prevStatus !== 'online') {
          writeSystemLog(
            db,
            'info',
            'node',
            `Node "${nodeName}" (${String(row.endpoint)}) is online${restored.changes > 0 ? `; restored ${restored.changes} key(s) to active` : ''}`,
            { nodeId, previousStatus: prevStatus, restoredKeysCount: Number(restored.changes) },
            nowSec,
          );
        }
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }

      const lastRotatedAt = Number(row.last_rotated_at ?? row.created_at);
      if (nowSec - lastRotatedAt >= autoRotateAfterSec) {
        try {
          await rotateNodeToken({
            db,
            masterKey,
            nodeId,
            nowSec,
            timeoutMs,
          });
          rotatedNodeIds.push(nodeId);
        } catch {
          // Rotation failure is already logged in system_logs by rotateNodeToken
        }
      }
    } else {
      const anchorSec = Number(row.last_seen_at ?? row.created_at);
      const silenceSec = nowSec - anchorSec;

      if (silenceSec > unresponsiveAfterSec) {
        unresponsiveCount++;
        db.exec('BEGIN IMMEDIATE');
        try {
          db.prepare(`UPDATE nodes SET status = 'unresponsive' WHERE id = ?`).run(nodeId);
          const affected = db
            .prepare(
              `UPDATE provider_keys
               SET status = 'no_node',
                   last_error = 'Assigned exit node is unresponsive (>120s without heartbeat)'
               WHERE node_id = ? AND status NOT IN ('no_node', 'disabled')`,
            )
            .run(nodeId);

          if (prevStatus !== 'unresponsive' || affected.changes > 0) {
            writeSystemLog(
              db,
              'warn',
              'node',
              `Node "${nodeName}" (${String(row.endpoint)}) is unresponsive (${silenceSec}s without heartbeat); marked ${affected.changes} key(s) as no_node`,
              {
                nodeId,
                silenceSeconds: silenceSec,
                affectedKeysCount: Number(affected.changes),
              },
              nowSec,
            );
          }
          db.exec('COMMIT');
        } catch (err) {
          db.exec('ROLLBACK');
          throw err;
        }
      } else {
        if (prevStatus === 'online') {
          onlineCount++;
        } else if (prevStatus === 'unresponsive') {
          unresponsiveCount++;
        } else {
          offlineCount++;
        }
      }
    }
  }

  return {
    checkedCount: nodeRows.length,
    onlineCount,
    unresponsiveCount,
    offlineCount,
    rotatedNodeIds,
  };
}

export interface NodeConnectivityTestResult {
  ok: boolean;
  status: NodeStatus;
  latencyMs: number | null;
  error?: string;
}

export async function testNodeConnectivity(params: {
  db: DatabaseSync;
  masterKey: Buffer;
  nodeId: string;
  now?: () => number;
  timeoutMs?: number;
}): Promise<NodeConnectivityTestResult> {
  const { db, masterKey, nodeId } = params;
  const nowFn = params.now ?? (() => Date.now());
  const timeoutMs = params.timeoutMs ?? 5000;

  const row = db
    .prepare(
      `SELECT id, name, mode, endpoint, encrypted_token, tls_fingerprint, status
       FROM nodes
       WHERE id = ?`,
    )
    .get(nodeId) as Record<string, unknown> | undefined;

  if (!row) {
    throw new NodeOperationError(`Node "${nodeId}" not found.`, 404);
  }

  const currentStatus =
    row.status === 'online' || row.status === 'unresponsive'
      ? (String(row.status) as NodeStatus)
      : ('offline' as NodeStatus);

  if (!row.encrypted_token) {
    return {
      ok: false,
      status: currentStatus,
      latencyMs: null,
      error: 'Node credentials are missing or unreadable.',
    };
  }

  let rawToken: string;
  try {
    rawToken = decryptSecret(row.encrypted_token as Uint8Array, masterKey);
  } catch {
    return {
      ok: false,
      status: currentStatus,
      latencyMs: null,
      error: 'Failed to decrypt node credentials.',
    };
  }

  const startMs = nowFn();
  try {
    const res = await callNodeControlPlane({
      mode: row.mode === 'public_ip' ? 'public_ip' : 'tailscale',
      endpoint: String(row.endpoint),
      rawToken,
      tlsFingerprint:
        row.tls_fingerprint === null || row.tls_fingerprint === undefined
          ? null
          : String(row.tls_fingerprint),
      method: 'GET',
      path: '/_bifrost/health',
      timeoutMs,
    });

    const latencyMs = Math.max(0, nowFn() - startMs);
    const healthy = res.status === 200 && res.data?.ok === true;
    const nodeCommit =
      healthy && typeof res.data?.commit === 'string' && res.data.commit.trim().length > 0
        ? res.data.commit.trim()
        : null;
    const nowSec = Math.floor(nowFn() / 1000);

    if (healthy) {
      db.exec('BEGIN IMMEDIATE');
      try {
        if (res.peerFingerprint && !row.tls_fingerprint && row.mode === 'public_ip') {
          if (nodeCommit !== null) {
            db.prepare(
              `UPDATE nodes SET status = 'online', last_seen_at = ?, tls_fingerprint = ?, last_commit = ? WHERE id = ?`,
            ).run(nowSec, res.peerFingerprint, nodeCommit, nodeId);
          } else {
            db.prepare(
              `UPDATE nodes SET status = 'online', last_seen_at = ?, tls_fingerprint = ? WHERE id = ?`,
            ).run(nowSec, res.peerFingerprint, nodeId);
          }
        } else if (nodeCommit !== null) {
          db.prepare(
            `UPDATE nodes SET status = 'online', last_seen_at = ?, last_commit = ? WHERE id = ?`,
          ).run(nowSec, nodeCommit, nodeId);
        } else {
          db.prepare(`UPDATE nodes SET status = 'online', last_seen_at = ? WHERE id = ?`).run(
            nowSec,
            nodeId,
          );
        }
        db.prepare(
          `UPDATE provider_keys
           SET status = 'active', last_error = NULL
           WHERE node_id = ? AND status = 'no_node'`,
        ).run(nodeId);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }

      return {
        ok: true,
        status: 'online',
        latencyMs,
      };
    }

    return {
      ok: false,
      status: currentStatus,
      latencyMs,
      error: `Node health endpoint returned HTTP ${res.status}`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Node connectivity test failed.';
    return {
      ok: false,
      status: currentStatus,
      latencyMs: null,
      error: redactSecretsInText(msg),
    };
  }
}

export interface NodeUpdateTriggerResult {
  ok: true;
  upToDate?: boolean;
  message: string;
  restarting: boolean;
}

/**
 * Triggers remote 1-click auto-update on an egress node by calling POST /_bifrost/update
 * via callNodeControlPlane.
 */
export async function triggerNodeUpdate(
  db: DatabaseSync,
  masterKey: Buffer,
  nodeId: string,
  _upstreamTls?: UpstreamTlsOptions,
): Promise<NodeUpdateTriggerResult> {
  const row = db
    .prepare(
      `SELECT id, name, mode, endpoint, encrypted_token, tls_fingerprint
       FROM nodes
       WHERE id = ?`,
    )
    .get(nodeId) as Record<string, unknown> | undefined;

  if (!row) {
    throw new NodeOperationError(`Node "${nodeId}" not found.`, 404);
  }

  if (!row.encrypted_token) {
    throw new NodeOperationError(
      `Node "${nodeId}" has no stored encrypted credential for update.`,
      400,
    );
  }

  let rawToken: string;
  try {
    rawToken = decryptSecret(row.encrypted_token as Uint8Array, masterKey);
  } catch {
    throw new NodeOperationError(`Failed to decrypt credentials for node "${nodeId}".`, 400);
  }

  let res: { status: number; data: Record<string, unknown> };
  try {
    res = await callNodeControlPlane({
      mode: row.mode === 'public_ip' ? 'public_ip' : 'tailscale',
      endpoint: String(row.endpoint),
      rawToken,
      tlsFingerprint:
        row.tls_fingerprint === null || row.tls_fingerprint === undefined
          ? null
          : String(row.tls_fingerprint),
      method: 'POST',
      path: '/_bifrost/update',
      timeoutMs: 60_000,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new NodeOperationError(
      `Unable to reach node "${String(row.name)}" for auto-update: ${redactSecretsInText(msg)}`,
      502,
    );
  }

  if (res.status !== 200 || res.data?.ok !== true) {
    const remoteErr =
      typeof res.data?.error === 'string' && res.data.error.trim().length > 0
        ? res.data.error.trim()
        : `HTTP ${res.status}`;
    throw new NodeOperationError(
      `Node "${String(row.name)}" rejected auto-update: ${redactSecretsInText(remoteErr)}`,
      res.status === 409 ? 409 : 502,
    );
  }

  return {
    ok: true,
    ...(res.data.upToDate !== undefined ? { upToDate: Boolean(res.data.upToDate) } : {}),
    message:
      typeof res.data.message === 'string' && res.data.message.trim().length > 0
        ? res.data.message.trim()
        : 'Node update triggered and restarting.',
    restarting: res.data.restarting !== undefined ? Boolean(res.data.restarting) : true,
  };
}

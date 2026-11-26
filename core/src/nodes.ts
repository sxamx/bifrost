import { randomBytes, timingSafeEqual } from 'node:crypto';
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
export const DEFAULT_FETCH_TIMEOUT_MS = 60_000;
export const DEFAULT_HEALTH_TICK_CONCURRENCY = 5;

const DEFAULT_INSTALL_ORIGIN = 'https://raw.githubusercontent.com/sxamx/bifrost/main/nodes';

const nodeRotationLocks = new Map<string, Promise<unknown>>();
const socketHandoffErrors = new WeakMap<net.Socket | tls.TLSSocket, Error>();
const socketHandoffListeners = new WeakMap<net.Socket | tls.TLSSocket, (err: Error) => void>();

async function withNodeRotationLock<T>(nodeId: string, fn: () => Promise<T>): Promise<T> {
  const prev = nodeRotationLocks.get(nodeId) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = prev.then(() => next);
  nodeRotationLocks.set(nodeId, chained);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (nodeRotationLocks.get(nodeId) === chained) {
      nodeRotationLocks.delete(nodeId);
    }
  }
}

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
  timeoutMs?: number;
}

export function normalizeHexFingerprint(fp: string): string {
  return fp.replace(/:/g, '').replace(/\s+/g, '').toUpperCase();
}

export function timingSafeEqualHex(a: string, b: string): boolean {
  const normA = normalizeHexFingerprint(a);
  const normB = normalizeHexFingerprint(b);
  if (!/^[0-9A-F]{64}$/.test(normA) || !/^[0-9A-F]{64}$/.test(normB)) {
    return false;
  }
  const bufA = Buffer.from(normA, 'hex');
  const bufB = Buffer.from(normB, 'hex');
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function validateInstallOrigin(rawOrigin: string): string {
  const trimmed = rawOrigin.trim().replace(/\/+$/, '');
  if (!trimmed || /[\r\n\0\t\s'"`$\\|;&<>()]/.test(trimmed) || trimmed.includes('..')) {
    throw new Error('Invalid serverOrigin: contains forbidden characters');
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('Invalid serverOrigin: must be a valid http(s) URL');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Invalid serverOrigin: only http: and https: protocols are allowed');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('Invalid serverOrigin: credentials, query strings, and fragments are not allowed');
  }

  const host = parsed.hostname;
  const isBracketedIpv6 = /^\[[0-9a-fA-F:]+\]$/.test(host);
  const isRfcHostname =
    host.length > 0 &&
    host.length <= 253 &&
    /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/.test(
      host,
    );

  if (!isBracketedIpv6 && !isRfcHostname) {
    throw new Error(`Invalid serverOrigin hostname: "${host}"`);
  }

  const pathname = parsed.pathname.replace(/\/+$/, '');
  if (pathname && (!/^[a-zA-Z0-9/._-]+$/.test(pathname) || pathname.includes('..'))) {
    throw new Error('Invalid serverOrigin pathname');
  }

  return `${parsed.origin}${pathname}`;
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
  if (params.mode !== 'tailscale' && params.mode !== 'public_ip') {
    throw new Error(`Invalid node mode: "${String(params.mode)}"`);
  }
  if (!params.rawToken || /[\r\n\0]/.test(params.rawToken)) {
    throw new Error('Invalid rawToken for install command');
  }
  const parsed = parseNodeEndpoint(params.endpoint);
  const port = parsed?.port ?? DEFAULT_NODE_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid node port: "${String(port)}"`);
  }

  const origin =
    params.serverOrigin !== undefined
      ? validateInstallOrigin(params.serverOrigin)
      : DEFAULT_INSTALL_ORIGIN;
  const scriptUrl = `${origin}/install-node.sh`;

  return `curl -fsSL ${shellSingleQuote(scriptUrl)} | BIFROST_NODE_TOKEN=${shellSingleQuote(params.rawToken)} sudo -E bash -s -- --mode ${params.mode} --port ${port}`;
}

export const PUBLIC_IP_WARNING_MESSAGE =
  'Advertencia de seguridad: el modo IP pública expone un puerto TCP fuera de Tailscale. Usa TLS con huella SHA-256 verificada y restringe el firewall únicamente a la IP del servidor Bifrost.';

/**
 * Performs a TLS-only handshake against an egress node without transmitting any HTTP bytes
 * or Bearer credentials, returning the normalized 64-char SHA-256 peer certificate fingerprint.
 */
export function probeNodeTlsFingerprint(endpoint: string, timeoutMs = 5000): Promise<string> {
  const parsedEp = parseNodeEndpoint(endpoint);
  if (!parsedEp) {
    return Promise.reject(new Error(`Invalid node endpoint: "${endpoint}"`));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const sock = tls.connect({
      host: parsedEp.host,
      port: parsedEp.port,
      servername: net.isIP(parsedEp.host) ? undefined : parsedEp.host,
      rejectUnauthorized: false,
    });

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        sock.destroy();
        reject(new Error(`Node TLS probe timed out after ${timeoutMs}ms`));
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

    sock.once('secureConnect', () => {
      if (settled) return;
      const peerCert = sock.getPeerCertificate();
      const actualNorm = peerCert?.fingerprint256
        ? normalizeHexFingerprint(peerCert.fingerprint256)
        : '';
      if (!/^[0-9A-F]{64}$/.test(actualNorm)) {
        fail(new Error('Node did not present a valid TLS certificate SHA-256 fingerprint'));
        return;
      }
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(actualNorm);
    });

    sock.once('error', fail);
    sock.once('close', () => {
      if (!settled) {
        fail(new Error('Node closed TLS connection before completing handshake'));
      }
    });
  });
}

function connectVerifiedPublicIpTlsSocket(params: {
  host: string;
  port: number;
  pinnedFingerprint: string | null;
  allowUnpinnedTls: boolean;
  timeoutMs: number;
}): Promise<{ sock: tls.TLSSocket; peerFingerprint: string | null }> {
  const pinnedNorm = params.pinnedFingerprint
    ? normalizeHexFingerprint(params.pinnedFingerprint)
    : null;

  if (pinnedNorm === null && !params.allowUnpinnedTls) {
    return Promise.reject(
      new Error('Public IP node requires a pinned TLS SHA-256 fingerprint (tlsFingerprint)'),
    );
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const sock = tls.connect({
      host: params.host,
      port: params.port,
      servername: net.isIP(params.host) ? undefined : params.host,
      rejectUnauthorized: false,
    });
    sock.setNoDelay(true);

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        sock.destroy();
        reject(new Error(`Node TLS handshake timed out after ${params.timeoutMs}ms`));
      }
    }, params.timeoutMs);
    timer.unref();

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      reject(new Error(redactSecretsInText(err.message)));
    };

    sock.once('secureConnect', () => {
      if (settled) return;
      const peerCert = sock.getPeerCertificate();
      const actualNorm = peerCert?.fingerprint256
        ? normalizeHexFingerprint(peerCert.fingerprint256)
        : '';

      if (pinnedNorm !== null && (!actualNorm || !timingSafeEqualHex(actualNorm, pinnedNorm))) {
        fail(new Error('Node TLS certificate SHA-256 fingerprint mismatch'));
        return;
      }

      const onBridgeError = (err: Error) => {
        socketHandoffErrors.set(sock, err);
        sock.destroy();
      };
      socketHandoffListeners.set(sock, onBridgeError);
      sock.on('error', onBridgeError);
      sock.off('error', fail);

      settled = true;
      clearTimeout(timer);
      resolve({
        sock,
        peerFingerprint: /^[0-9A-F]{64}$/.test(actualNorm) ? actualNorm : null,
      });
    });

    sock.once('error', fail);
    sock.once('close', () => {
      if (!settled) {
        fail(new Error('Node closed TLS connection before completing handshake'));
      }
    });
  });
}

/**
 * Calls a control-plane endpoint on an egress node (`/_bifrost/health`, `/_bifrost/rotate`, or `/_bifrost/update`).
 * For `public_ip` mode, strictly verifies the peer certificate SHA-256 fingerprint in constant time
 * BEFORE transmitting any HTTP bytes (including Authorization headers or rotated tokens).
 */
export async function callNodeControlPlane(params: {
  mode: NodeMode;
  endpoint: string;
  rawToken: string;
  tlsFingerprint?: string | null;
  allowUnpinnedTls?: boolean;
  method: 'GET' | 'POST';
  path: string;
  body?: Record<string, unknown>;
  timeoutMs?: number;
}): Promise<{ status: number; data: Record<string, unknown>; peerFingerprint?: string | null }> {
  const parsedEp = parseNodeEndpoint(params.endpoint);
  if (!parsedEp) {
    throw new Error(`Invalid node endpoint: "${params.endpoint}"`);
  }

  const timeoutMs = params.timeoutMs ?? 5000;
  const startedAtMs = Date.now();
  let verifiedTlsSocket: tls.TLSSocket | null = null;
  let observedPeerFingerprint: string | null = null;

  if (params.mode === 'public_ip') {
    const handshake = await connectVerifiedPublicIpTlsSocket({
      host: parsedEp.host,
      port: parsedEp.port,
      pinnedFingerprint: params.tlsFingerprint ?? null,
      allowUnpinnedTls: Boolean(params.allowUnpinnedTls),
      timeoutMs,
    });
    verifiedTlsSocket = handshake.sock;
    observedPeerFingerprint = handshake.peerFingerprint;

    const earlyErr = socketHandoffErrors.get(verifiedTlsSocket);
    if (earlyErr) {
      socketHandoffErrors.delete(verifiedTlsSocket);
      socketHandoffListeners.delete(verifiedTlsSocket);
      verifiedTlsSocket.destroy();
      throw new Error(redactSecretsInText(earlyErr.message));
    }
  }

  const remainingTimeoutMs = Math.max(250, timeoutMs - (Date.now() - startedAtMs));
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
    const destroyVerifiedSocket = () => {
      if (verifiedTlsSocket && !verifiedTlsSocket.destroyed) {
        verifiedTlsSocket.destroy();
      }
    };
    const finishReject = (err: Error) => {
      if (settled) return;
      settled = true;
      destroyVerifiedSocket();
      reject(new Error(redactSecretsInText(err.message)));
    };

    const onResponse = (res: http.IncomingMessage) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        if (settled) return;
        settled = true;
        destroyVerifiedSocket();
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
    if (verifiedTlsSocket) {
      const tlsSock = verifiedTlsSocket;
      const agent = new http.Agent({ keepAlive: false });
      agent.createConnection = () => tlsSock;

      req = http.request(
        {
          hostname: parsedEp.host,
          port: parsedEp.port,
          path: params.path,
          method: params.method,
          headers,
          agent,
        },
        onResponse,
      );
      req.on('error', finishReject);
      const bridgeListener = socketHandoffListeners.get(tlsSock);
      if (bridgeListener) {
        tlsSock.off('error', bridgeListener);
        socketHandoffListeners.delete(tlsSock);
      }
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
      req.on('error', finishReject);
    }

    req.setTimeout(remainingTimeoutMs, () => {
      req.destroy(new Error(`Node request timed out after ${timeoutMs}ms`));
    });

    if (bodyStr !== undefined) {
      req.write(bodyStr);
    }
    req.end();
  });
}

export function openConnectSocketToNode(
  node: NodeTunnelConfig,
  targetAuthority: string,
  timeoutMs: number,
): Promise<net.Socket | tls.TLSSocket> {
  const parsedEp = parseNodeEndpoint(node.endpoint);
  if (!parsedEp) {
    return Promise.reject(new Error(`Invalid node endpoint "${node.endpoint}"`));
  }

  const pinnedNorm = node.tlsFingerprint
    ? normalizeHexFingerprint(node.tlsFingerprint)
    : null;

  if (node.mode === 'public_ip' && pinnedNorm === null) {
    return Promise.reject(
      new Error(
        `Egress node "${node.name}" in public_ip mode requires a pinned TLS SHA-256 fingerprint (tlsFingerprint)`,
      ),
    );
  }

  return new Promise((resolve, reject) => {
    let settled = false;

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
    sock.setNoDelay(true);

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
      if (node.mode === 'public_ip' && sock instanceof tls.TLSSocket) {
        const peerCert = sock.getPeerCertificate();
        const actualNorm = peerCert?.fingerprint256
          ? normalizeHexFingerprint(peerCert.fingerprint256)
          : '';
        if (!pinnedNorm || !actualNorm || !timingSafeEqualHex(actualNorm, pinnedNorm)) {
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
        sock.off('error', fail);
        sock.on('error', () => {
          // Swallow post-destroy socket error
        });
        sock.destroy();
        reject(new Error(`Egress node rejected CONNECT with HTTP ${statusCode}`));
        return;
      }

      // Attach a bridge error listener BEFORE detaching `fail` so `sock` never has 0 error listeners
      const onBridgeError = (err: Error) => {
        socketHandoffErrors.set(sock, err);
        sock.destroy();
      };
      socketHandoffListeners.set(sock, onBridgeError);
      sock.on('error', onBridgeError);
      sock.off('error', fail);

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
  const earlyHandoffError = socketHandoffErrors.get(tunnelSocket);
  if (earlyHandoffError || tunnelSocket.destroyed) {
    socketHandoffErrors.delete(tunnelSocket);
    socketHandoffListeners.delete(tunnelSocket);
    if (!tunnelSocket.destroyed) {
      tunnelSocket.destroy();
    }
    throw new Error(
      redactSecretsInText(earlyHandoffError?.message ?? 'Egress node tunnel closed before request'),
    );
  }
  tunnelSocket.setNoDelay(true);

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

  if (!Object.keys(reqHeaders).some((k) => k.toLowerCase() === 'accept-encoding')) {
    reqHeaders['Accept-Encoding'] = 'identity';
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
  const requestTimeoutMs = upstreamTls?.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;

  return new Promise<Response>((resolve, reject) => {
    let headersResolved = false;
    let abortHandler: (() => void) | null = null;

    const cleanupAbort = () => {
      if (init?.signal && abortHandler) {
        init.signal.removeEventListener('abort', abortHandler);
        abortHandler = null;
      }
    };

    const cleanupResources = () => {
      cleanupAbort();
      if (!tunnelSocket.destroyed) {
        tunnelSocket.destroy();
      }
    };

    const onError = (err: Error) => {
      cleanupResources();
      if (!headersResolved) {
        headersResolved = true;
        reject(new Error(redactSecretsInText(err.message)));
      }
    };

    // Attach our error listener BEFORE removing the handoff bridge listener
    tunnelSocket.on('error', onError);
    const bridgeListener = socketHandoffListeners.get(tunnelSocket);
    if (bridgeListener) {
      tunnelSocket.off('error', bridgeListener);
      socketHandoffListeners.delete(tunnelSocket);
    }

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
        res.once('end', cleanupResources);
        res.once('close', cleanupResources);
        res.once('error', cleanupResources);
        res.resume();
        resolve(new Response(null, { status, headers: responseHeaders }));
        return;
      }

      let streamClosed = false;
      const webStream = new ReadableStream<Uint8Array>({
        start(controller) {
          const onData = (chunk: Buffer) => {
            if (streamClosed) return;
            try {
              controller.enqueue(new Uint8Array(chunk));
            } catch {
              streamClosed = true;
              res.destroy();
              cleanupResources();
            }
          };
          const onEnd = () => {
            if (!streamClosed) {
              streamClosed = true;
              try {
                controller.close();
              } catch {
                // Controller already closed/errored
              }
            }
            cleanupResources();
          };
          const onErr = (err: Error) => {
            if (!streamClosed) {
              streamClosed = true;
              try {
                controller.error(err);
              } catch {
                // Controller already closed/errored
              }
            }
            cleanupResources();
          };
          const onClose = () => {
            if (!streamClosed && !res.complete) {
              streamClosed = true;
              try {
                controller.error(new Error('Upstream stream closed prematurely'));
              } catch {
                // Controller already closed/errored
              }
            }
            cleanupResources();
          };
          res.on('data', onData);
          res.once('end', onEnd);
          res.once('error', onErr);
          res.once('close', onClose);
        },
        cancel() {
          streamClosed = true;
          res.destroy();
          cleanupResources();
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
        tlsSock.setNoDelay(true);
        if (pinnedTargetFp !== null) {
          tlsSock.once('secureConnect', () => {
            const peer = tlsSock.getPeerCertificate();
            const actualFp = peer?.fingerprint256
              ? normalizeHexFingerprint(peer.fingerprint256)
              : '';
            if (!actualFp || !timingSafeEqualHex(actualFp, pinnedTargetFp)) {
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

    clientReq.on('error', onError);
    if (requestTimeoutMs > 0) {
      clientReq.setTimeout(requestTimeoutMs, () => {
        clientReq.destroy(new Error(`Upstream request timed out after ${requestTimeoutMs}ms`));
      });
    }

    if (init?.signal) {
      if (init.signal.aborted) {
        clientReq.destroy(new Error('Request aborted'));
        cleanupResources();
        return;
      }
      abortHandler = () => {
        clientReq.destroy(new Error('Request aborted'));
        cleanupResources();
      };
      init.signal.addEventListener('abort', abortHandler, { once: true });
    }

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

function promotePendingTokenTx(params: {
  db: DatabaseSync;
  nodeId: string;
  nodeName: string;
  newTokenHash: string;
  nowSec: number;
  nodeCommit?: string | null;
  recoveredFromPending?: boolean;
}): { prevTokenExpiresAt: number } {
  const { db, nodeId, nodeName, newTokenHash, nowSec, nodeCommit, recoveredFromPending } = params;
  const prevTokenExpiresAt = nowSec + NODE_GRACE_SECONDS;

  db.exec('BEGIN IMMEDIATE');
  try {
    if (nodeCommit !== undefined && nodeCommit !== null) {
      db.prepare(
        `UPDATE nodes
         SET prev_token_hash = token_hash,
             prev_token_expires_at = ?,
             token_hash = ?,
             encrypted_token = pending_encrypted_token,
             pending_encrypted_token = NULL,
             last_rotated_at = ?,
             last_seen_at = ?,
             last_commit = ?,
             status = 'online'
         WHERE id = ? AND pending_encrypted_token IS NOT NULL`,
      ).run(prevTokenExpiresAt, newTokenHash, nowSec, nowSec, nodeCommit, nodeId);
    } else {
      db.prepare(
        `UPDATE nodes
         SET prev_token_hash = token_hash,
             prev_token_expires_at = ?,
             token_hash = ?,
             encrypted_token = pending_encrypted_token,
             pending_encrypted_token = NULL,
             last_rotated_at = ?,
             last_seen_at = ?,
             status = 'online'
         WHERE id = ? AND pending_encrypted_token IS NOT NULL`,
      ).run(prevTokenExpiresAt, newTokenHash, nowSec, nowSec, nodeId);
    }

    db.prepare(
      `UPDATE provider_keys
       SET status = 'active', last_error = NULL
       WHERE node_id = ? AND status = 'no_node'`,
    ).run(nodeId);

    writeSystemLog(
      db,
      'info',
      'node',
      recoveredFromPending
        ? `Auto-promoted pending rotated token for node "${nodeName}" after verifying health with pending credential`
        : `Rotated authentication token for node "${nodeName}" (5m grace window active)`,
      {
        nodeId,
        prevTokenExpiresAt,
        graceSeconds: NODE_GRACE_SECONDS,
        ...(recoveredFromPending ? { recoveredFromPending: true } : {}),
      },
      nowSec,
    );

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return { prevTokenExpiresAt };
}

type PendingReconcileResult =
  | {
      outcome: 'promoted';
      prevTokenExpiresAt: number;
      nodeCommit: string | null;
      peerFingerprint: string | null;
    }
  | {
      outcome: 'cleared_stale';
      nodeCommit: string | null;
      peerFingerprint: string | null;
    }
  | {
      outcome: 'unreachable';
      nodeCommit: null;
      peerFingerprint: null;
    };

async function reconcilePendingNodeTokenUnlocked(params: {
  db: DatabaseSync;
  masterKey: Buffer;
  nodeRow: Record<string, unknown>;
  nowSec: number;
  timeoutMs: number;
  tlsFingerprintOverride?: string | null;
}): Promise<PendingReconcileResult> {
  const { db, masterKey, nodeRow, nowSec, timeoutMs } = params;
  const nodeId = String(nodeRow.id);
  const nodeName = String(nodeRow.name);
  const mode: NodeMode = nodeRow.mode === 'public_ip' ? 'public_ip' : 'tailscale';
  const endpoint = String(nodeRow.endpoint);
  const tlsFingerprint =
    params.tlsFingerprintOverride !== undefined
      ? params.tlsFingerprintOverride
      : nodeRow.tls_fingerprint === null || nodeRow.tls_fingerprint === undefined
        ? null
        : String(nodeRow.tls_fingerprint);

  if (!nodeRow.pending_encrypted_token) {
    return { outcome: 'cleared_stale', nodeCommit: null, peerFingerprint: null };
  }

  let pendingRawToken: string;
  try {
    pendingRawToken = decryptSecret(nodeRow.pending_encrypted_token as Uint8Array, masterKey);
  } catch {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(`UPDATE nodes SET pending_encrypted_token = NULL WHERE id = ?`).run(nodeId);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return { outcome: 'cleared_stale', nodeCommit: null, peerFingerprint: null };
  }

  // 1. Test pending token FIRST — if the node already rotated (even inside grace window), it accepts this token
  let pendingRes: { status: number; data: Record<string, unknown>; peerFingerprint?: string | null } | null =
    null;
  try {
    pendingRes = await callNodeControlPlane({
      mode,
      endpoint,
      rawToken: pendingRawToken,
      tlsFingerprint,
      method: 'GET',
      path: '/_bifrost/health',
      timeoutMs,
    });
  } catch {
    return { outcome: 'unreachable', nodeCommit: null, peerFingerprint: null };
  }

  if (pendingRes.status === 200 && pendingRes.data?.ok === true) {
    const nodeCommit =
      typeof pendingRes.data.commit === 'string' && pendingRes.data.commit.trim().length > 0
        ? pendingRes.data.commit.trim()
        : null;
    const { prevTokenExpiresAt } = promotePendingTokenTx({
      db,
      nodeId,
      nodeName,
      newTokenHash: sha256Hex(pendingRawToken),
      nowSec,
      nodeCommit,
      recoveredFromPending: true,
    });
    return {
      outcome: 'promoted',
      prevTokenExpiresAt,
      nodeCommit,
      peerFingerprint: pendingRes.peerFingerprint ?? null,
    };
  }

  // 2. Node rejected pending token (e.g. 401); check if it still accepts the old active token
  if (nodeRow.encrypted_token) {
    let activeRawToken: string;
    try {
      activeRawToken = decryptSecret(nodeRow.encrypted_token as Uint8Array, masterKey);
    } catch {
      return { outcome: 'unreachable', nodeCommit: null, peerFingerprint: null };
    }

    try {
      const oldRes = await callNodeControlPlane({
        mode,
        endpoint,
        rawToken: activeRawToken,
        tlsFingerprint,
        method: 'GET',
        path: '/_bifrost/health',
        timeoutMs,
      });

      if (oldRes.status === 200 && oldRes.data?.ok === true) {
        const nodeCommit =
          typeof oldRes.data.commit === 'string' && oldRes.data.commit.trim().length > 0
            ? oldRes.data.commit.trim()
            : null;
        db.exec('BEGIN IMMEDIATE');
        try {
          db.prepare(`UPDATE nodes SET pending_encrypted_token = NULL WHERE id = ?`).run(nodeId);
          writeSystemLog(
            db,
            'warn',
            'node',
            `Cleared unapplied pending token for node "${nodeName}"; node still accepts existing active token`,
            { nodeId },
            nowSec,
          );
          db.exec('COMMIT');
        } catch (err) {
          db.exec('ROLLBACK');
          throw err;
        }
        return {
          outcome: 'cleared_stale',
          nodeCommit,
          peerFingerprint: oldRes.peerFingerprint ?? null,
        };
      }
    } catch {
      // Keep pending_encrypted_token if the node became unreachable during old-token check
    }
  }

  return { outcome: 'unreachable', nodeCommit: null, peerFingerprint: null };
}

/**
 * Rotates a node's token in 2 phases (HU-11c, CRIT-05):
 * 1. Serialized per nodeId via an in-memory mutex.
 * 2. Persists `pending_encrypted_token` in SQLite BEFORE calling POST /_bifrost/rotate.
 * 3. Promotes `encrypted_token = pending_encrypted_token` on 200 OK in `BEGIN IMMEDIATE`.
 * 4. On network error/timeout, reconciles against `/_bifrost/health` to prevent split-brain.
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
  const effectiveTimeoutMs = timeoutMs ?? 5000;

  return withNodeRotationLock(nodeId, async () => {
    let nodeRow = db
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

    const mode: NodeMode = nodeRow.mode === 'public_ip' ? 'public_ip' : 'tailscale';
    const tlsFingerprint =
      nodeRow.tls_fingerprint === null || nodeRow.tls_fingerprint === undefined
        ? null
        : String(nodeRow.tls_fingerprint);

    if (mode === 'public_ip' && !tlsFingerprint) {
      throw new NodeOperationError(
        `Node "${String(nodeRow.name)}" in public_ip mode requires a pinned TLS SHA-256 fingerprint (tlsFingerprint) before rotating tokens.`,
        400,
      );
    }

    // Reconcile any interrupted previous 2-phase rotation before starting a new one
    if (nodeRow.pending_encrypted_token) {
      const reconciled = await reconcilePendingNodeTokenUnlocked({
        db,
        masterKey,
        nodeRow,
        nowSec,
        timeoutMs: effectiveTimeoutMs,
      });
      if (reconciled.outcome === 'unreachable') {
        throw new NodeOperationError(
          `Unable to reach node "${String(nodeRow.name)}" to reconcile pending token rotation.`,
          502,
        );
      }
      nodeRow = db
        .prepare(`SELECT * FROM nodes WHERE id = ?`)
        .get(nodeId) as Record<string, unknown> | undefined;
      if (!nodeRow || !nodeRow.encrypted_token) {
        throw new NodeOperationError(`Node "${nodeId}" not found.`, 404);
      }
    }

    const currentRawToken = decryptSecret(nodeRow.encrypted_token as Uint8Array, masterKey);
    const { rawToken: newRawToken, tokenHash: newTokenHash } = generateNodeToken();
    const newEncryptedToken = encryptSecret(newRawToken, masterKey);

    // Phase 1: persist pending_encrypted_token BEFORE transmitting to the node
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(`UPDATE nodes SET pending_encrypted_token = ? WHERE id = ?`).run(
        newEncryptedToken,
        nodeId,
      );
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }

    const rowWithPending: Record<string, unknown> = {
      ...nodeRow,
      pending_encrypted_token: newEncryptedToken,
    };

    let rotateRes: { status: number; data: Record<string, unknown> };
    try {
      rotateRes = await callNodeControlPlane({
        mode,
        endpoint: String(nodeRow.endpoint),
        rawToken: currentRawToken,
        tlsFingerprint,
        method: 'POST',
        path: '/_bifrost/rotate',
        body: { newToken: newRawToken },
        timeoutMs: effectiveTimeoutMs,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const reconciled = await reconcilePendingNodeTokenUnlocked({
        db,
        masterKey,
        nodeRow: rowWithPending,
        nowSec,
        timeoutMs: effectiveTimeoutMs,
      });
      if (reconciled.outcome === 'promoted') {
        return {
          ok: true,
          nodeId,
          lastRotatedAt: nowSec,
          prevTokenExpiresAt: reconciled.prevTokenExpiresAt,
          graceSeconds: NODE_GRACE_SECONDS,
        };
      }

      writeSystemLog(
        db,
        'error',
        'node',
        `Failed to rotate token on node "${String(nodeRow.name)}": ${msg}`,
        { nodeId, pendingRetained: reconciled.outcome === 'unreachable' },
        nowSec,
      );
      throw new NodeOperationError(
        `Unable to reach node "${String(nodeRow.name)}" for token rotation: ${msg}`,
        502,
      );
    }

    if (rotateRes.status !== 200 || rotateRes.data.ok !== true) {
      const reconciled = await reconcilePendingNodeTokenUnlocked({
        db,
        masterKey,
        nodeRow: rowWithPending,
        nowSec,
        timeoutMs: effectiveTimeoutMs,
      });
      if (reconciled.outcome === 'promoted') {
        return {
          ok: true,
          nodeId,
          lastRotatedAt: nowSec,
          prevTokenExpiresAt: reconciled.prevTokenExpiresAt,
          graceSeconds: NODE_GRACE_SECONDS,
        };
      }

      writeSystemLog(
        db,
        'error',
        'node',
        `Node "${String(nodeRow.name)}" rejected token rotation with HTTP ${rotateRes.status}`,
        { nodeId, status: rotateRes.status, pendingRetained: reconciled.outcome === 'unreachable' },
        nowSec,
      );
      throw new NodeOperationError(
        `Node "${String(nodeRow.name)}" rejected token rotation (HTTP ${rotateRes.status}).`,
        502,
      );
    }

    // Phase 2: promote pending_encrypted_token -> encrypted_token atomically
    const { prevTokenExpiresAt } = promotePendingTokenTx({
      db,
      nodeId,
      nodeName: String(nodeRow.name),
      newTokenHash,
      nowSec,
    });

    return {
      ok: true,
      nodeId,
      lastRotatedAt: nowSec,
      prevTokenExpiresAt,
      graceSeconds: NODE_GRACE_SECONDS,
    };
  });
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
 * Executes network probes in parallel with bounded concurrency while keeping SQLite writes brief.
 */
export async function runNodesHealthTick(
  db: DatabaseSync,
  masterKey: Buffer,
  options: {
    now?: () => number;
    timeoutMs?: number;
    unresponsiveAfterSec?: number;
    autoRotateAfterSec?: number;
    concurrency?: number;
  } = {},
): Promise<NodesHealthTickResult> {
  const nowFn = options.now ?? (() => Date.now());
  const nowSec = Math.floor(nowFn() / 1000);
  const timeoutMs = options.timeoutMs ?? 4000;
  const unresponsiveAfterSec = options.unresponsiveAfterSec ?? NODE_UNRESPONSIVE_SECONDS;
  const autoRotateAfterSec = options.autoRotateAfterSec ?? NODE_ROTATION_INTERVAL_SECONDS;
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? DEFAULT_HEALTH_TICK_CONCURRENCY));

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

  type SingleNodeTickOutcome = {
    bucket: NodeStatus;
    rotated: boolean;
  };

  const checkSingleNode = async (initialRow: Record<string, unknown>): Promise<SingleNodeTickOutcome> => {
    const nodeId = String(initialRow.id);
    const nodeName = String(initialRow.name);
    const prevStatus = String(initialRow.status) as NodeStatus;

    if (!initialRow.encrypted_token) {
      return {
        bucket:
          prevStatus === 'online'
            ? 'online'
            : prevStatus === 'unresponsive'
              ? 'unresponsive'
              : 'offline',
        rotated: false,
      };
    }

    let healthy = false;
    let nodeCommit: string | null = null;
    let promotedPending = false;
    let row = initialRow;

    if (row.pending_encrypted_token) {
      const reconciled = await withNodeRotationLock(nodeId, async () => {
        const freshRow = db
          .prepare(`SELECT * FROM nodes WHERE id = ?`)
          .get(nodeId) as Record<string, unknown> | undefined;
        if (!freshRow) {
          return { outcome: 'unreachable' as const, nodeCommit: null, peerFingerprint: null };
        }
        row = freshRow;
        if (!freshRow.pending_encrypted_token) {
          return null;
        }
        return reconcilePendingNodeTokenUnlocked({
          db,
          masterKey,
          nodeRow: freshRow,
          nowSec,
          timeoutMs,
        });
      });

      if (reconciled !== null) {
        if (reconciled.outcome === 'promoted') {
          healthy = true;
          promotedPending = true;
          nodeCommit = reconciled.nodeCommit;
        } else if (reconciled.outcome === 'cleared_stale') {
          healthy = true;
          nodeCommit = reconciled.nodeCommit;
        } else {
          healthy = false;
        }
      }
    }

    if (!promotedPending && !healthy) {
      let rawToken: string;
      try {
        rawToken = decryptSecret(row.encrypted_token as Uint8Array, masterKey);
      } catch {
        return { bucket: 'offline', rotated: false };
      }

      if (!row.pending_encrypted_token) {
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
      }
    }

    if (healthy) {
      if (!promotedPending) {
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
      }

      let rotated = false;
      const lastRotatedAt = Number(row.last_rotated_at ?? row.created_at);
      if (!promotedPending && nowSec - lastRotatedAt >= autoRotateAfterSec) {
        try {
          await rotateNodeToken({
            db,
            masterKey,
            nodeId,
            nowSec,
            timeoutMs,
          });
          rotated = true;
        } catch {
          // Rotation failure is already logged in system_logs by rotateNodeToken
        }
      }

      return { bucket: 'online', rotated };
    }

    const anchorSec = Number(row.last_seen_at ?? row.created_at);
    const silenceSec = nowSec - anchorSec;

    if (silenceSec > unresponsiveAfterSec) {
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
      return { bucket: 'unresponsive', rotated: false };
    }

    return {
      bucket:
        prevStatus === 'online'
          ? 'online'
          : prevStatus === 'unresponsive'
            ? 'unresponsive'
            : 'offline',
      rotated: false,
    };
  };

  for (let i = 0; i < nodeRows.length; i += concurrency) {
    const batch = nodeRows.slice(i, i + concurrency);
    const settledBatch = await Promise.allSettled(batch.map((row) => checkSingleNode(row)));
    for (let j = 0; j < settledBatch.length; j += 1) {
      const outcome = settledBatch[j];
      const row = batch[j]!;
      if (outcome && outcome.status === 'fulfilled') {
        if (outcome.value.bucket === 'online') onlineCount++;
        else if (outcome.value.bucket === 'unresponsive') unresponsiveCount++;
        else offlineCount++;
        if (outcome.value.rotated) {
          rotatedNodeIds.push(String(row.id));
        }
      } else {
        const prevStatus = String(row.status) as NodeStatus;
        if (prevStatus === 'online') onlineCount++;
        else if (prevStatus === 'unresponsive') unresponsiveCount++;
        else offlineCount++;
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
      `SELECT id, name, mode, endpoint, encrypted_token, pending_encrypted_token, tls_fingerprint, status
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

  const nodeName = String(row.name ?? nodeId);
  const mode: NodeMode = row.mode === 'public_ip' ? 'public_ip' : 'tailscale';
  const redactToken = (text: string): string =>
    redactSecretsInText(text).split(rawToken).join('[REDACTED]');

  const startMs = nowFn();
  try {
    let effectiveTlsFingerprint: string | null =
      row.tls_fingerprint === null || row.tls_fingerprint === undefined
        ? null
        : String(row.tls_fingerprint);
    let capturedPeerFingerprint: string | null = null;

    // For public_ip nodes without a pinned fingerprint yet, probe TLS handshake ONLY first
    // (zero HTTP bytes / zero Bearer token sent) to capture and verify the certificate SHA-256.
    if (mode === 'public_ip' && !effectiveTlsFingerprint) {
      const probedFp = await probeNodeTlsFingerprint(String(row.endpoint), timeoutMs);
      capturedPeerFingerprint = probedFp;
      effectiveTlsFingerprint = probedFp;
    }

    let healthy = false;
    let nodeCommit: string | null = null;
    let httpStatus = 200;
    let promotedPending = false;

    if (row.pending_encrypted_token) {
      const nowSecForReconcile = Math.floor(nowFn() / 1000);
      const reconciled = await withNodeRotationLock(nodeId, async () =>
        reconcilePendingNodeTokenUnlocked({
          db,
          masterKey,
          nodeRow: row,
          nowSec: nowSecForReconcile,
          timeoutMs,
          tlsFingerprintOverride: effectiveTlsFingerprint,
        }),
      );
      if (reconciled.outcome === 'promoted') {
        healthy = true;
        promotedPending = true;
        nodeCommit = reconciled.nodeCommit;
      } else if (reconciled.outcome === 'cleared_stale') {
        healthy = true;
        nodeCommit = reconciled.nodeCommit;
      }
    }

    if (!healthy) {
      const res = await callNodeControlPlane({
        mode,
        endpoint: String(row.endpoint),
        rawToken,
        tlsFingerprint: effectiveTlsFingerprint,
        method: 'GET',
        path: '/_bifrost/health',
        timeoutMs,
      });
      httpStatus = res.status;
      healthy = res.status === 200 && res.data?.ok === true;
      nodeCommit =
        healthy && typeof res.data?.commit === 'string' && res.data.commit.trim().length > 0
          ? res.data.commit.trim()
          : null;
      if (!capturedPeerFingerprint && res.peerFingerprint && !row.tls_fingerprint && mode === 'public_ip') {
        capturedPeerFingerprint = normalizeHexFingerprint(res.peerFingerprint);
      }
    }

    const latencyMs = Math.max(0, nowFn() - startMs);
    const nowSec = Math.floor(nowFn() / 1000);

    if (healthy) {
      db.exec('BEGIN IMMEDIATE');
      try {
        if (capturedPeerFingerprint && !row.tls_fingerprint && mode === 'public_ip') {
          if (nodeCommit !== null) {
            db.prepare(
              `UPDATE nodes SET status = 'online', last_seen_at = ?, tls_fingerprint = ?, last_commit = ? WHERE id = ?`,
            ).run(nowSec, capturedPeerFingerprint, nodeCommit, nodeId);
          } else {
            db.prepare(
              `UPDATE nodes SET status = 'online', last_seen_at = ?, tls_fingerprint = ? WHERE id = ?`,
            ).run(nowSec, capturedPeerFingerprint, nodeId);
          }
        } else if (!promotedPending) {
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

      if (currentStatus !== 'online') {
        writeSystemLog(
          db,
          'warn',
          'node',
          `Exit node "${nodeName}" connectivity test succeeded; status changed from "${currentStatus}" to "online"`,
          { nodeId, previousStatus: currentStatus, status: 'online', latencyMs },
          nowSec,
        );
      }

      return {
        ok: true,
        status: 'online',
        latencyMs,
      };
    }

    const nextStatus: NodeStatus = currentStatus === 'offline' ? 'offline' : 'unresponsive';
    if (nextStatus !== currentStatus) {
      db.prepare(`UPDATE nodes SET status = ? WHERE id = ?`).run(nextStatus, nodeId);
    }

    const errorMessage = `Node health endpoint returned HTTP ${httpStatus}`;
    writeSystemLog(
      db,
      'warn',
      'node',
      `Exit node "${nodeName}" connectivity test failed (HTTP ${httpStatus}); status is "${nextStatus}"`,
      {
        nodeId,
        previousStatus: currentStatus,
        status: nextStatus,
        httpStatus,
        latencyMs,
      },
      nowSec,
    );

    return {
      ok: false,
      status: nextStatus,
      latencyMs,
      error: errorMessage,
    };
  } catch (err) {
    const nowSec = Math.floor(nowFn() / 1000);
    const msg = err instanceof Error ? err.message : 'Node connectivity test failed.';
    const safeError = redactToken(msg);
    const nextStatus: NodeStatus = currentStatus === 'offline' ? 'offline' : 'unresponsive';
    if (nextStatus !== currentStatus) {
      db.prepare(`UPDATE nodes SET status = ? WHERE id = ?`).run(nextStatus, nodeId);
    }

    writeSystemLog(
      db,
      'warn',
      'node',
      `Exit node "${nodeName}" connectivity test failed (${safeError}); status is "${nextStatus}"`,
      {
        nodeId,
        previousStatus: currentStatus,
        status: nextStatus,
        error: safeError,
      },
      nowSec,
    );

    return {
      ok: false,
      status: nextStatus,
      latencyMs: null,
      error: safeError,
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

  const mode: NodeMode = row.mode === 'public_ip' ? 'public_ip' : 'tailscale';
  const tlsFingerprint =
    row.tls_fingerprint === null || row.tls_fingerprint === undefined
      ? null
      : String(row.tls_fingerprint);

  if (mode === 'public_ip' && !tlsFingerprint) {
    throw new NodeOperationError(
      `Node "${String(row.name)}" in public_ip mode requires a pinned TLS SHA-256 fingerprint (tlsFingerprint) before triggering auto-update.`,
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
      mode,
      endpoint: String(row.endpoint),
      rawToken,
      tlsFingerprint,
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

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import {
  DEFAULT_GRACE_WINDOW_MS,
  TokenAuthenticator
} from './auth.js';
import {
  parseConnectAuthority,
  validateAndResolveTarget
} from './ssrf.js';
import {
  type DetectTailscaleOptions,
  detectTailscaleIpv4,
  formatMissingTailscaleMessage
} from './tailscale.js';
import { loadOrGenerateTlsMaterial } from './tls.js';

export const NODE_AGENT_VERSION = '0.1.0';
export const DEFAULT_NODE_PORT = 9443;
export type NodeMode = 'tailscale' | 'public_ip';

export interface NodeLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

export interface BifrostNodeOptions {
  mode?: NodeMode;
  port?: number;
  bindHost?: string;
  token?: string;
  stateFilePath?: string;
  graceWindowMs?: number;
  allowedPorts?: number[];
  allowPrivateTargets?: boolean;
  connectTimeoutMs?: number;
  tlsCertPath?: string;
  tlsKeyPath?: string;
  tlsCertPem?: string;
  tlsKeyPem?: string;
  tlsPersistDir?: string;
  now?: () => number;
  detectTailscaleOptions?: DetectTailscaleOptions;
  logger?: NodeLogger;
}

export interface BifrostNodeInstance {
  readonly server: http.Server | https.Server;
  readonly mode: NodeMode;
  readonly host: string;
  readonly tlsFingerprintSha256?: string;
  readonly tlsCertPem?: string;
  getPort(): number;
  getActiveTunnels(): number;
  start(): Promise<{ host: string; port: number; tlsFingerprintSha256?: string }>;
  stop(): Promise<void>;
}

const defaultLogger: NodeLogger = {
  info: (msg) => console.log(msg),
  warn: (msg) => console.warn(msg),
  error: (msg) => console.error(msg)
};

function sendJson(res: http.ServerResponse, statusCode: number, body: Record<string, unknown>, extraHeaders?: Record<string, string>): void {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload).toString(),
    'Cache-Control': 'no-store',
    ...extraHeaders
  });
  res.end(payload);
}

function readRequestBody(req: http.IncomingMessage, maxBytes = 8192): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) {
        settled = true;
        reject(Object.assign(new Error('Payload too large'), { statusCode: 413 }));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });

    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

function writeRawHttpResponse(socket: Duplex, statusLine: string, headers: string[] = []): void {
  if (socket.destroyed || !socket.writable) {
    return;
  }
  const lines = [
    `HTTP/1.1 ${statusLine}`,
    ...headers,
    'Connection: close',
    'Content-Length: 0',
    '',
    ''
  ];
  socket.end(lines.join('\r\n'));
}

export function createBifrostNodeServer(options: BifrostNodeOptions): BifrostNodeInstance {
  const mode: NodeMode = options.mode ?? 'tailscale';
  const requestedPort = options.port ?? DEFAULT_NODE_PORT;
  const nowFn = options.now ?? (() => Date.now());
  const logger = options.logger ?? defaultLogger;
  const allowedPorts = new Set<number>(options.allowedPorts ?? [443]);
  const allowPrivateTargets = options.allowPrivateTargets ?? false;
  const connectTimeoutMs = options.connectTimeoutMs ?? 10_000;

  const authenticator = new TokenAuthenticator({
    initialToken: options.token,
    stateFilePath: options.stateFilePath,
    graceWindowMs: options.graceWindowMs ?? DEFAULT_GRACE_WINDOW_MS,
    now: nowFn
  });

  let bindHost: string;
  let tlsFingerprintSha256: string | undefined;
  let tlsCertPem: string | undefined;
  let server: http.Server | https.Server;

  if (mode === 'tailscale') {
    if (options.bindHost) {
      bindHost = options.bindHost;
    } else {
      const detectedIp = detectTailscaleIpv4(options.detectTailscaleOptions);
      if (!detectedIp) {
        const warning = formatMissingTailscaleMessage(requestedPort);
        logger.warn(warning);
        throw new Error(warning);
      }
      bindHost = detectedIp;
    }
    server = http.createServer();
  } else if (mode === 'public_ip') {
    bindHost = options.bindHost ?? '0.0.0.0';
    const tlsMaterial = loadOrGenerateTlsMaterial({
      tlsCertPath: options.tlsCertPath,
      tlsKeyPath: options.tlsKeyPath,
      tlsCertPem: options.tlsCertPem,
      tlsKeyPem: options.tlsKeyPem,
      persistDir: options.tlsPersistDir
    });
    tlsFingerprintSha256 = tlsMaterial.fingerprintSha256;
    tlsCertPem = tlsMaterial.certPem;
    server = https.createServer({
      cert: tlsMaterial.certPem,
      key: tlsMaterial.keyPem,
      minVersion: 'TLSv1.2'
    });
  } else {
    throw new Error(`Unsupported node mode: ${String(mode)}`);
  }

  const startedAtMs = nowFn();
  let boundPort = requestedPort;
  let activeTunnels = 0;
  const trackedSockets = new Set<Duplex>();

  server.on('connection', (socket: net.Socket) => {
    trackedSockets.add(socket);
    socket.once('close', () => trackedSockets.delete(socket));
  });
  server.on('secureConnection', (tlsSocket: Duplex) => {
    trackedSockets.add(tlsSocket);
    tlsSocket.once('close', () => trackedSockets.delete(tlsSocket));
  });

  // Control plane HTTP endpoints (/_bifrost/health, /_bifrost/rotate)
  server.on('request', async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const verification = authenticator.verifyHeaders(req.headers);
    if (!verification.authenticated) {
      sendJson(
        res,
        401,
        { ok: false, error: 'unauthorized' },
        { 'WWW-Authenticate': 'Bearer realm="bifrost-node"' }
      );
      return;
    }

    let pathname = '/';
    try {
      pathname = new URL(req.url ?? '/', 'http://bifrost.local').pathname;
    } catch {
      sendJson(res, 400, { ok: false, error: 'bad_request' });
      return;
    }

    if (req.method === 'GET' && pathname === '/_bifrost/health') {
      const uptimeSec = Math.max(0, Math.floor((nowFn() - startedAtMs) / 1000));
      sendJson(res, 200, {
        ok: true,
        uptime_sec: uptimeSec,
        version: NODE_AGENT_VERSION,
        active_tunnels: activeTunnels
      });
      return;
    }

    if (req.method === 'POST' && pathname === '/_bifrost/rotate') {
      if (verification.matchedSlot !== 'active') {
        sendJson(
          res,
          401,
          { ok: false, error: 'rotation_requires_active_token' },
          { 'WWW-Authenticate': 'Bearer realm="bifrost-node"' }
        );
        return;
      }

      try {
        const rawBody = await readRequestBody(req);
        const parsed = JSON.parse(rawBody || '{}') as { newToken?: unknown };
        if (typeof parsed.newToken !== 'string' || parsed.newToken.trim().length < 16) {
          sendJson(res, 400, {
            ok: false,
            error: 'newToken must be a string of at least 16 characters'
          });
          return;
        }

        const rotated = authenticator.rotate(parsed.newToken);
        sendJson(res, 200, {
          ok: true,
          grace_window_ms: rotated.graceWindowMs,
          prev_token_expires_at: rotated.prevTokenExpiresAtSec
        });
      } catch (err) {
        const statusCode =
          err && typeof err === 'object' && 'statusCode' in err && typeof err.statusCode === 'number'
            ? err.statusCode
            : 400;
        sendJson(res, statusCode, { ok: false, error: 'invalid_rotate_payload' });
      }
      return;
    }

    sendJson(res, 404, { ok: false, error: 'not_found' });
  });

  // Data plane: Zero-knowledge HTTP CONNECT TCP tunnel
  server.on('connect', async (req: http.IncomingMessage, clientSocket: Duplex, head: Buffer) => {
    clientSocket.on('error', () => {
      // Prevent unhandled socket error crashes on abrupt peer resets
    });

    const verification = authenticator.verifyHeaders(req.headers);
    if (!verification.authenticated) {
      writeRawHttpResponse(clientSocket, '407 Proxy Authentication Required', [
        'Proxy-Authenticate: Bearer realm="bifrost-node"'
      ]);
      return;
    }

    const parsedTarget = parseConnectAuthority(req.url);
    if (!parsedTarget) {
      writeRawHttpResponse(clientSocket, '400 Bad Request');
      return;
    }

    const resolution = await validateAndResolveTarget(parsedTarget, {
      allowedPorts,
      allowPrivateTargets
    });

    if (clientSocket.destroyed) {
      return;
    }

    if (!resolution.allowed || !resolution.resolvedIp) {
      writeRawHttpResponse(clientSocket, '403 Forbidden');
      return;
    }

    const upstreamSocket = net.connect({
      host: resolution.resolvedIp,
      port: parsedTarget.port,
      family: resolution.family
    });

    trackedSockets.add(clientSocket);
    trackedSockets.add(upstreamSocket);

    let tunnelEstablished = false;
    let tunnelReleased = false;

    const releaseTunnel = (): void => {
      trackedSockets.delete(clientSocket);
      trackedSockets.delete(upstreamSocket);
      if (tunnelEstablished && !tunnelReleased) {
        tunnelReleased = true;
        activeTunnels = Math.max(0, activeTunnels - 1);
      }
    };

    const connectTimer = setTimeout(() => {
      if (!tunnelEstablished) {
        writeRawHttpResponse(clientSocket, '504 Gateway Timeout');
        upstreamSocket.destroy();
      }
    }, connectTimeoutMs);
    connectTimer.unref();

    upstreamSocket.once('connect', () => {
      clearTimeout(connectTimer);
      if (clientSocket.destroyed) {
        upstreamSocket.destroy();
        return;
      }

      tunnelEstablished = true;
      activeTunnels += 1;

      upstreamSocket.setNoDelay(true);
      upstreamSocket.setKeepAlive(true, 30_000);
      if ('setNoDelay' in clientSocket && typeof clientSocket.setNoDelay === 'function') {
        clientSocket.setNoDelay(true);
      }
      if ('setKeepAlive' in clientSocket && typeof clientSocket.setKeepAlive === 'function') {
        clientSocket.setKeepAlive(true, 30_000);
      }

      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length > 0) {
        upstreamSocket.write(head);
      }

      // Zero-knowledge transparent TCP pipe: bytes flow encrypted end-to-end
      upstreamSocket.pipe(clientSocket);
      clientSocket.pipe(upstreamSocket);
    });

    upstreamSocket.on('error', () => {
      clearTimeout(connectTimer);
      if (!tunnelEstablished) {
        writeRawHttpResponse(clientSocket, '502 Bad Gateway');
      } else {
        clientSocket.destroy();
      }
      releaseTunnel();
    });

    upstreamSocket.once('close', () => {
      clearTimeout(connectTimer);
      if (!clientSocket.destroyed) {
        clientSocket.destroy();
      }
      releaseTunnel();
    });

    clientSocket.once('close', () => {
      clearTimeout(connectTimer);
      if (!upstreamSocket.destroyed) {
        upstreamSocket.destroy();
      }
      releaseTunnel();
    });
  });

  return {
    server,
    mode,
    host: bindHost,
    tlsFingerprintSha256,
    tlsCertPem,
    getPort: () => boundPort,
    getActiveTunnels: () => activeTunnels,
    start: () =>
      new Promise((resolve, reject) => {
        const onError = (err: Error) => {
          server.removeListener('listening', onListening);
          reject(err);
        };
        const onListening = () => {
          server.removeListener('error', onError);
          const addr = server.address();
          if (addr && typeof addr === 'object') {
            boundPort = addr.port;
          }
          if (mode === 'tailscale') {
            logger.info(
              `[bifrost-node] Escuchando en modo Tailscale (WireGuard) en ${bindHost}:${boundPort}`
            );
          } else {
            logger.warn(
              `[bifrost-node][WARN] Modo public_ip activo en ${bindHost}:${boundPort} (puerto expuesto fuera de Tailscale; usa TLS + firewall).`
            );
            logger.info(
              `[bifrost-node] TLS SHA-256 Fingerprint: ${tlsFingerprintSha256}`
            );
          }
          resolve({
            host: bindHost,
            port: boundPort,
            tlsFingerprintSha256
          });
        };

        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(requestedPort, bindHost);
      }),
    stop: () =>
      new Promise((resolve, reject) => {
        for (const sock of trackedSockets) {
          sock.destroy();
        }
        trackedSockets.clear();

        if (!server.listening) {
          resolve();
          return;
        }
        server.close((err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      })
  };
}

import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { promisify } from 'node:util';
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

const execFileAsync = promisify(execFile);

function loadNodeAgentVersion(): string {
  try {
    const pkgPath = path.resolve(import.meta.dirname, '../package.json');
    const parsed = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: unknown };
    if (typeof parsed.version === 'string' && parsed.version.trim().length > 0) {
      return parsed.version.trim();
    }
  } catch {
    // Fallback if package.json is unavailable
  }
  return '0.0.0';
}

export const NODE_AGENT_VERSION = loadNodeAgentVersion();
export const DEFAULT_NODE_PORT = 9443;
export const DEFAULT_REQUEST_BODY_TIMEOUT_MS = 10_000;
export const DEFAULT_TUNNEL_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
export const DEFAULT_MAX_ACTIVE_TUNNELS = 256;
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
  requestBodyTimeoutMs?: number;
  tunnelIdleTimeoutMs?: number;
  maxActiveTunnels?: number;
  updateDrainTimeoutMs?: number;
  tlsCertPath?: string;
  tlsKeyPath?: string;
  tlsCertPem?: string;
  tlsKeyPem?: string;
  tlsPersistDir?: string;
  now?: () => number;
  detectTailscaleOptions?: DetectTailscaleOptions;
  logger?: NodeLogger;
  repoDir?: string;
  checkHasUpdates?: (repoDir: string) => boolean | Promise<boolean>;
  runUpdateCommand?: (cmd: string, args: string[], cwd: string) => void | Promise<void>;
  onUpdateRestart?: () => void;
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

function readRequestBody(
  req: http.IncomingMessage,
  maxBytes = 8192,
  timeoutMs = DEFAULT_REQUEST_BODY_TIMEOUT_MS
): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
      req.removeListener('aborted', onAborted);
      req.removeListener('close', onClose);
    };

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const timer = setTimeout(() => {
      if (settled) return;
      req.pause();
      fail(Object.assign(new Error(`Request body timed out after ${timeoutMs}ms`), { statusCode: 408 }));
    }, timeoutMs);
    timer.unref();

    const onData = (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) {
        fail(Object.assign(new Error('Payload too large'), { statusCode: 413 }));
        req.resume();
        return;
      }
      chunks.push(chunk);
    };

    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks).toString('utf8'));
    };

    const onError = (err: Error) => {
      fail(err);
    };

    const onAborted = () => {
      fail(Object.assign(new Error('Request aborted before body completed'), { statusCode: 400 }));
    };

    const onClose = () => {
      if (!settled && !req.complete) {
        fail(Object.assign(new Error('Connection closed before body completed'), { statusCode: 400 }));
      }
    };

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAborted);
    req.on('close', onClose);
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

function detectNodeCommit(repoDir: string): string | null {
  const envCommit = (process.env.BIFROST_NODE_COMMIT ?? process.env.BIFROST_BUILD_COMMIT)?.trim();
  if (envCommit && envCommit.toLowerCase() !== 'unknown') {
    return envCommit;
  }
  try {
    if (fs.existsSync(path.join(repoDir, '.git'))) {
      const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
        cwd: repoDir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim();
      if (sha.length > 0) {
        return sha;
      }
    }
  } catch {
    // Git not available or not a git repository
  }
  return null;
}

async function defaultRunNodeUpdateCommand(cmd: string, args: string[], cwd: string): Promise<void> {
  await execFileAsync(cmd, args, { cwd, timeout: 180_000 });
}

async function defaultCheckNodeHasUpdates(repoDir: string): Promise<boolean> {
  await execFileAsync('git', ['fetch', '--depth', '1', 'origin', 'main'], {
    cwd: repoDir,
    timeout: 30_000
  });
  const [{ stdout: localSha }, { stdout: remoteSha }] = await Promise.all([
    execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, timeout: 10_000 }),
    execFileAsync('git', ['rev-parse', 'origin/main'], { cwd: repoDir, timeout: 10_000 })
  ]);
  return localSha.trim() !== remoteSha.trim();
}

export function createBifrostNodeServer(options: BifrostNodeOptions): BifrostNodeInstance {
  const mode: NodeMode = options.mode ?? 'tailscale';
  const requestedPort = options.port ?? DEFAULT_NODE_PORT;
  const nowFn = options.now ?? (() => Date.now());
  const logger = options.logger ?? defaultLogger;
  const allowedPorts = new Set<number>(options.allowedPorts ?? [443]);
  const allowPrivateTargets = options.allowPrivateTargets ?? false;
  const connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
  const requestBodyTimeoutMs = options.requestBodyTimeoutMs ?? DEFAULT_REQUEST_BODY_TIMEOUT_MS;
  const tunnelIdleTimeoutMs = options.tunnelIdleTimeoutMs ?? DEFAULT_TUNNEL_IDLE_TIMEOUT_MS;
  const maxActiveTunnels = options.maxActiveTunnels ?? DEFAULT_MAX_ACTIVE_TUNNELS;
  const updateDrainTimeoutMs = options.updateDrainTimeoutMs ?? 5_000;
  const resolvedRepoDir =
    options.repoDir ??
    (process.env.BIFROST_NODE_REPO_DIR?.trim() || path.resolve(import.meta.dirname, '../..'));
  const nodeCommit = detectNodeCommit(resolvedRepoDir);

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
  let pendingTunnels = 0;
  let updateInFlight = false;
  const trackedSockets = new Set<Duplex>();

  server.on('connection', (socket: net.Socket) => {
    trackedSockets.add(socket);
    socket.once('close', () => trackedSockets.delete(socket));
  });
  server.on('secureConnection', (tlsSocket: Duplex) => {
    trackedSockets.add(tlsSocket);
    tlsSocket.once('close', () => trackedSockets.delete(tlsSocket));
  });

  // Control plane HTTP endpoints (/_bifrost/health, /_bifrost/rotate, /_bifrost/update)
  const handleRequest = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
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
        commit: nodeCommit,
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
        const rawBody = await readRequestBody(req, 8192, requestBodyTimeoutMs);
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
        if (!res.headersSent && !res.writableEnded) {
          sendJson(
            res,
            statusCode,
            { ok: false, error: statusCode === 408 ? 'request_timeout' : 'invalid_rotate_payload' },
            statusCode === 408 ? { Connection: 'close' } : undefined
          );
          if (statusCode === 408) {
            res.once('finish', () => {
              req.socket?.destroy();
            });
          }
        }
      }
      return;
    }

    if (req.method === 'POST' && pathname === '/_bifrost/update') {
      if (verification.matchedSlot !== 'active') {
        sendJson(
          res,
          401,
          { ok: false, error: 'update_requires_active_token' },
          { 'WWW-Authenticate': 'Bearer realm="bifrost-node"' }
        );
        return;
      }

      if (updateInFlight) {
        sendJson(res, 409, {
          ok: false,
          error: 'Node update is already in progress'
        });
        return;
      }

      if (!fs.existsSync(path.join(resolvedRepoDir, '.git'))) {
        sendJson(res, 409, {
          ok: false,
          error: 'Node repository (.git) not found for auto-update'
        });
        return;
      }

      updateInFlight = true;
      let restarting = false;
      const runCmd = options.runUpdateCommand ?? defaultRunNodeUpdateCommand;
      try {
        const hasUpdates = options.checkHasUpdates
          ? await options.checkHasUpdates(resolvedRepoDir)
          : options.runUpdateCommand
            ? true
            : await defaultCheckNodeHasUpdates(resolvedRepoDir);

        if (!hasUpdates) {
          sendJson(res, 200, {
            ok: true,
            upToDate: true,
            restarting: false,
            message: 'Node is already on the latest version.'
          });
          return;
        }

        await runCmd('git', ['fetch', '--depth', '1', 'origin', 'main'], resolvedRepoDir);
        await runCmd('git', ['reset', '--hard', 'origin/main'], resolvedRepoDir);
        await runCmd('npm', ['--prefix', 'nodes', 'ci', '--include=dev', '--ignore-scripts'], resolvedRepoDir);
        await runCmd('npm', ['--prefix', 'nodes', 'run', 'build'], resolvedRepoDir);
        restarting = true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`[bifrost-node] Auto-update failed: ${msg}`);
        if (!res.headersSent && !res.writableEnded) {
          sendJson(res, 500, {
            ok: false,
            error: `Node update failed: ${msg}`
          });
        }
        return;
      } finally {
        if (!restarting) {
          updateInFlight = false;
        }
      }

      sendJson(res, 200, {
        ok: true,
        upToDate: false,
        restarting: true,
        message: 'Node updated and restarting.'
      });

      if (options.onUpdateRestart) {
        options.onUpdateRestart();
      } else {
        const timer = setTimeout(() => {
          const forceTimer = setTimeout(() => process.exit(0), updateDrainTimeoutMs);
          forceTimer.unref();
          server.close(() => {
            clearTimeout(forceTimer);
            process.exit(0);
          });
        }, 300);
        timer.unref();
      }
      return;
    }

    sendJson(res, 404, { ok: false, error: 'not_found' });
  };

  server.on('request', (req: http.IncomingMessage, res: http.ServerResponse) => {
    void handleRequest(req, res).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[bifrost-node] Unhandled request error: ${msg}`);
      if (!res.headersSent && !res.writableEnded) {
        sendJson(res, 500, { ok: false, error: 'internal_server_error' });
      } else if (!res.destroyed) {
        res.destroy();
      }
    });
  });

  // Data plane: Zero-knowledge HTTP CONNECT TCP tunnel
  const handleConnect = async (req: http.IncomingMessage, clientSocket: Duplex, head: Buffer): Promise<void> => {
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

    if (activeTunnels + pendingTunnels >= maxActiveTunnels) {
      writeRawHttpResponse(clientSocket, '503 Service Unavailable');
      return;
    }

    pendingTunnels += 1;
    let pendingReleased = false;
    const releasePending = (): void => {
      if (!pendingReleased) {
        pendingReleased = true;
        pendingTunnels = Math.max(0, pendingTunnels - 1);
      }
    };

    let resolution: Awaited<ReturnType<typeof validateAndResolveTarget>>;
    try {
      resolution = await validateAndResolveTarget(parsedTarget, {
        allowedPorts,
        allowPrivateTargets
      });
    } catch (err) {
      releasePending();
      throw err;
    }

    if (clientSocket.destroyed) {
      releasePending();
      return;
    }

    if (!resolution.allowed || !resolution.resolvedIp) {
      releasePending();
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
      releasePending();
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
        releaseTunnel();
        return;
      }

      releasePending();
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

      if (tunnelIdleTimeoutMs > 0) {
        const onTunnelIdleTimeout = () => {
          if (!upstreamSocket.destroyed) upstreamSocket.destroy();
          if (!clientSocket.destroyed) clientSocket.destroy();
        };
        upstreamSocket.setTimeout(tunnelIdleTimeoutMs, onTunnelIdleTimeout);
        if ('setTimeout' in clientSocket && typeof clientSocket.setTimeout === 'function') {
          clientSocket.setTimeout(tunnelIdleTimeoutMs, onTunnelIdleTimeout);
        }
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
  };

  server.on('connect', (req: http.IncomingMessage, clientSocket: Duplex, head: Buffer) => {
    void handleConnect(req, clientSocket, head).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[bifrost-node] Unhandled connect error: ${msg}`);
      if (!clientSocket.destroyed) {
        clientSocket.destroy();
      }
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

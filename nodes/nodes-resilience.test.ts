import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_GRACE_WINDOW_MS,
  NODE_AGENT_VERSION,
  TokenAuthenticator,
  createBifrostNodeServer
} from './dist/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const SILENT_LOGGER = {
  info: () => {},
  warn: () => {},
  error: () => {}
};

function openRawConnect(options: {
  proxyPort: number;
  targetAuthority: string;
  token: string;
}): Promise<{ statusCode: number; socket: net.Socket }> {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: '127.0.0.1', port: options.proxyPort });
    sock.once('connect', () => {
      const req = [
        `CONNECT ${options.targetAuthority} HTTP/1.1`,
        `Host: ${options.targetAuthority}`,
        `Proxy-Authorization: Bearer ${options.token}`,
        '',
        ''
      ].join('\r\n');
      sock.write(req);
    });

    let buf = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const idx = buf.indexOf('\r\n\r\n');
      if (idx === -1) return;
      sock.off('data', onData);
      const statusLine = buf.subarray(0, idx).toString('utf8').split('\r\n')[0] ?? '';
      const match = /^HTTP\/1\.[01]\s+(\d{3})/.exec(statusLine);
      resolve({ statusCode: match ? Number(match[1]) : 0, socket: sock });
    };
    sock.on('data', onData);
    sock.once('error', reject);
  });
}

describe('Bifrost Egress Node Resilience (Ola 4)', () => {
  it('reads NODE_AGENT_VERSION dynamically from nodes/package.json', async () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')) as {
      version: string;
    };
    assert.equal(NODE_AGENT_VERSION, pkg.version);

    const token = 'version_check_token_0123456789abcdef';
    const node = createBifrostNodeServer({
      mode: 'tailscale',
      bindHost: '127.0.0.1',
      port: 0,
      token,
      logger: SILENT_LOGGER
    });
    const { port } = await node.start();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/_bifrost/health`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { version: string };
      assert.equal(body.version, pkg.version);
    } finally {
      await node.stop();
    }
  });

  it('persists prevTokenHashHex and prevTokenExpiresAtMs atomically and reloads grace window across restarts', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-node-grace-persist-'));
    const stateFilePath = path.join(tmpDir, 'token-state.json');

    let fakeNowMs = 1_770_000_000_000;
    const tokenV1 = 'grace_restart_token_v1_0123456789abcdef';
    const tokenV2 = 'grace_restart_token_v2_fedcba9876543210';

    const node1 = createBifrostNodeServer({
      mode: 'tailscale',
      bindHost: '127.0.0.1',
      port: 0,
      token: tokenV1,
      stateFilePath,
      graceWindowMs: DEFAULT_GRACE_WINDOW_MS,
      now: () => fakeNowMs,
      logger: SILENT_LOGGER
    });

    const { port: port1 } = await node1.start();
    try {
      const rotateRes = await fetch(`http://127.0.0.1:${port1}/_bifrost/rotate`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tokenV1}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ newToken: tokenV2 })
      });
      assert.equal(rotateRes.status, 200);
    } finally {
      await node1.stop();
    }

    // Verify persisted state contains grace metadata and no plaintext tokens
    const rawState = fs.readFileSync(stateFilePath, 'utf8');
    assert.ok(!rawState.includes(tokenV1));
    assert.ok(!rawState.includes(tokenV2));
    const parsedState = JSON.parse(rawState) as {
      activeTokenHashHex: string;
      prevTokenHashHex: string | null;
      prevTokenExpiresAtMs: number | null;
    };
    assert.match(parsedState.activeTokenHashHex, /^[0-9a-f]{64}$/i);
    assert.match(parsedState.prevTokenHashHex ?? '', /^[0-9a-f]{64}$/i);
    assert.equal(parsedState.prevTokenExpiresAtMs, fakeNowMs + DEFAULT_GRACE_WINDOW_MS);
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(stateFilePath).mode & 0o777, 0o600);
    }

    // Restart node 120s later (still inside 300s grace window)
    fakeNowMs += 120_000;
    const node2 = createBifrostNodeServer({
      mode: 'tailscale',
      bindHost: '127.0.0.1',
      port: 0,
      stateFilePath,
      graceWindowMs: DEFAULT_GRACE_WINDOW_MS,
      now: () => fakeNowMs,
      logger: SILENT_LOGGER
    });
    const { port: port2 } = await node2.start();
    try {
      // Old token MUST still be accepted after restart while inside grace window
      const oldHealth = await fetch(`http://127.0.0.1:${port2}/_bifrost/health`, {
        headers: { Authorization: `Bearer ${tokenV1}` }
      });
      assert.equal(oldHealth.status, 200);

      // New token MUST be accepted
      const newHealth = await fetch(`http://127.0.0.1:${port2}/_bifrost/health`, {
        headers: { Authorization: `Bearer ${tokenV2}` }
      });
      assert.equal(newHealth.status, 200);

      // Old grace token MUST NOT be allowed to trigger rotation
      const oldRotate = await fetch(`http://127.0.0.1:${port2}/_bifrost/rotate`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tokenV1}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ newToken: 'hijack_attempt_token_0123456789abcdef' })
      });
      assert.equal(oldRotate.status, 401);
    } finally {
      await node2.stop();
    }

    // Restart node after grace window expires (+200s -> total +320s > 300s)
    fakeNowMs += 200_000;
    const node3 = createBifrostNodeServer({
      mode: 'tailscale',
      bindHost: '127.0.0.1',
      port: 0,
      stateFilePath,
      graceWindowMs: DEFAULT_GRACE_WINDOW_MS,
      now: () => fakeNowMs,
      logger: SILENT_LOGGER
    });
    const { port: port3 } = await node3.start();
    try {
      const expiredOld = await fetch(`http://127.0.0.1:${port3}/_bifrost/health`, {
        headers: { Authorization: `Bearer ${tokenV1}` }
      });
      assert.equal(expiredOld.status, 401);

      const stillActiveNew = await fetch(`http://127.0.0.1:${port3}/_bifrost/health`, {
        headers: { Authorization: `Bearer ${tokenV2}` }
      });
      assert.equal(stillActiveNew.status, 200);
    } finally {
      await node3.stop();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('enforces updateInFlight mutex (409 Conflict), uses shallow fetch+reset and --ignore-scripts, and recovers mutex on failure', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-node-upd-mutex-'));
    fs.mkdirSync(path.join(tmpDir, '.git'));

    const token = 'update_mutex_secret_token_0123456789';
    const ranCommands: string[][] = [];
    let releaseGate!: () => void;
    let firstCmdStarted!: () => void;
    let shouldFailFirst = false;

    const firstCmdStartedPromise = new Promise<void>((resolve) => {
      firstCmdStarted = resolve;
    });
    const gatePromise = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });

    const node = createBifrostNodeServer({
      mode: 'tailscale',
      bindHost: '127.0.0.1',
      port: 0,
      token,
      logger: SILENT_LOGGER,
      repoDir: tmpDir,
      runUpdateCommand: async (cmd, args) => {
        ranCommands.push([cmd, ...args]);
        if (ranCommands.length === 1) {
          firstCmdStarted();
          await gatePromise;
          if (shouldFailFirst) {
            throw new Error('simulated transient git failure');
          }
        }
      },
      onUpdateRestart: () => {}
    });

    const { port } = await node.start();
    try {
      // First update fails after holding mutex, second concurrent request gets 409
      shouldFailFirst = true;
      const req1Promise = fetch(`http://127.0.0.1:${port}/_bifrost/update`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      });

      await firstCmdStartedPromise;

      const concurrentRes = await fetch(`http://127.0.0.1:${port}/_bifrost/update`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      });
      assert.equal(concurrentRes.status, 409);

      releaseGate();
      const req1Res = await req1Promise;
      assert.equal(req1Res.status, 500);

      // Mutex MUST be released after error so a retry succeeds cleanly
      shouldFailFirst = false;
      const retryRes = await fetch(`http://127.0.0.1:${port}/_bifrost/update`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      });
      assert.equal(retryRes.status, 200);
      const retryBody = (await retryRes.json()) as { ok: boolean; restarting: boolean };
      assert.equal(retryBody.ok, true);
      assert.equal(retryBody.restarting, true);

      assert.deepEqual(ranCommands.slice(-4), [
        ['git', 'fetch', '--depth', '1', 'origin', 'main'],
        ['git', 'reset', '--hard', 'origin/main'],
        ['npm', '--prefix', 'nodes', 'ci', '--include=dev', '--ignore-scripts'],
        ['npm', '--prefix', 'nodes', 'run', 'build']
      ]);
    } finally {
      await node.stop();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('enforces maxActiveTunnels (503) and closes idle CONNECT tunnels after tunnelIdleTimeoutMs', async () => {
    const echoServer = net.createServer((sock) => sock.pipe(sock));
    await new Promise<void>((resolve) => echoServer.listen(0, '127.0.0.1', resolve));
    const echoPort = (echoServer.address() as net.AddressInfo).port;

    const token = 'tunnel_limits_token_0123456789abcdef';
    const node = createBifrostNodeServer({
      mode: 'tailscale',
      bindHost: '127.0.0.1',
      port: 0,
      token,
      allowedPorts: [echoPort],
      allowPrivateTargets: true,
      maxActiveTunnels: 2,
      tunnelIdleTimeoutMs: 250,
      logger: SILENT_LOGGER
    });

    const { port } = await node.start();
    try {
      const t1 = await openRawConnect({
        proxyPort: port,
        targetAuthority: `127.0.0.1:${echoPort}`,
        token
      });
      assert.equal(t1.statusCode, 200);

      const t2 = await openRawConnect({
        proxyPort: port,
        targetAuthority: `127.0.0.1:${echoPort}`,
        token
      });
      assert.equal(t2.statusCode, 200);
      assert.equal(node.getActiveTunnels(), 2);

      // 3rd tunnel exceeds maxActiveTunnels=2 -> 503 Service Unavailable
      const t3 = await openRawConnect({
        proxyPort: port,
        targetAuthority: `127.0.0.1:${echoPort}`,
        token
      });
      assert.equal(t3.statusCode, 503);
      t3.socket.destroy();

      // Wait for idle timeout (250ms) to tear down t1 and t2 automatically
      await new Promise<void>((resolve) => {
        const check = () => {
          if (node.getActiveTunnels() === 0) {
            resolve();
          } else {
            setTimeout(check, 40);
          }
        };
        setTimeout(check, 280);
      });

      assert.equal(node.getActiveTunnels(), 0);
      t1.socket.destroy();
      t2.socket.destroy();
    } finally {
      await node.stop();
      await new Promise<void>((resolve) => echoServer.close(() => resolve()));
    }
  });

  it('times out stalled POST /_bifrost/rotate request bodies with 408 without hanging', async () => {
    const token = 'body_timeout_token_0123456789abcdef';
    const node = createBifrostNodeServer({
      mode: 'tailscale',
      bindHost: '127.0.0.1',
      port: 0,
      token,
      requestBodyTimeoutMs: 150,
      logger: SILENT_LOGGER
    });
    const { port } = await node.start();
    try {
      const rawResponse = await new Promise<string>((resolve, reject) => {
        const sock = net.connect({ host: '127.0.0.1', port });
        const chunks: Buffer[] = [];
        sock.once('connect', () => {
          sock.write(
            [
              'POST /_bifrost/rotate HTTP/1.1',
              `Host: 127.0.0.1:${port}`,
              `Authorization: Bearer ${token}`,
              'Content-Type: application/json',
              'Content-Length: 200',
              'Connection: close',
              '',
              '{"newToken":"partial'
            ].join('\r\n')
          );
        });
        sock.on('data', (c: Buffer) => chunks.push(c));
        sock.once('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
        sock.once('error', () => resolve(Buffer.concat(chunks).toString('utf8')));
        setTimeout(() => reject(new Error('Stalled rotate request did not time out')), 3000).unref();
      });

      assert.match(rawResponse, /HTTP\/1\.1 408/);
    } finally {
      await node.stop();
    }
  });

  it('rolls back in-memory token state in TokenAuthenticator.rotate when persistStateFile fails', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-node-auth-rollback-'));
    const stateFilePath = path.join(tmpDir, 'token-state.json');
    const tokenV1 = 'rollback_initial_token_0123456789abcdef';
    const tokenV2 = 'rollback_failed_token_fedcba9876543210';

    try {
      const auth = new TokenAuthenticator({
        initialToken: tokenV1,
        stateFilePath
      });
      assert.equal(auth.verifyToken(tokenV1).matchedSlot, 'active');

      // Replace stateFilePath with a directory so fs.renameSync fails during rotate()
      fs.unlinkSync(stateFilePath);
      fs.mkdirSync(stateFilePath);

      assert.throws(() => auth.rotate(tokenV2));

      // In-memory state MUST be restored to tokenV1 (and tokenV2 must NOT be accepted)
      assert.equal(auth.verifyToken(tokenV1).matchedSlot, 'active');
      assert.equal(auth.verifyToken(tokenV2).authenticated, false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('validates hardened systemd service files and install-node.sh protections', () => {
    const nodeService = fs.readFileSync(path.join(__dirname, 'bifrost-node.service'), 'utf8');
    for (const directive of [
      'ProtectKernelLogs=true',
      'ProtectClock=true',
      'RestrictNamespaces=true',
      'RestrictRealtime=true',
      'RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK'
    ]) {
      assert.ok(nodeService.includes(directive), `Missing ${directive} in nodes/bifrost-node.service`);
    }

    const coreService = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'bifrost.service'), 'utf8');
    assert.ok(
      coreService.includes('ReadWritePaths=/var/lib/bifrost /opt/bifrost'),
      'scripts/bifrost.service must allow writing to /opt/bifrost for native auto-updater'
    );
    assert.ok(
      coreService.includes('Environment=NPM_CONFIG_CACHE=/var/lib/bifrost/.npm'),
      'scripts/bifrost.service must define NPM_CONFIG_CACHE under /var/lib/bifrost'
    );
    assert.ok(
      !coreService.includes('ReadOnlyPaths=/opt/bifrost'),
      'scripts/bifrost.service must not mark /opt/bifrost read-only'
    );

    const installScriptPath = path.join(__dirname, 'install-node.sh');
    const installScript = fs.readFileSync(installScriptPath, 'utf8');
    assert.ok(!installScript.includes('BIFROST_INIT_TOKEN'), 'install-node.sh must pass token via stdin, not env');
    assert.ok(installScript.includes('BIFROST_NODE_TOKEN'), 'install-node.sh must support BIFROST_NODE_TOKEN');
    assert.ok(installScript.includes('unset BIFROST_NODE_TOKEN'), 'install-node.sh must scrub BIFROST_NODE_TOKEN from env after root check');
    assert.ok(installScript.includes('[[ ! -f "$0" ]]'), 'install-node.sh must guard pipe execution without root');
    assert.ok(installScript.includes('ProtectHome=true'), 'install-node.sh must validate NODE_BIN against ProtectHome');
    assert.ok(installScript.includes('escape_sed_replacement'), 'install-node.sh must escape sed replacements');
    assert.ok(
      installScript.includes('ci --include=dev --ignore-scripts'),
      'install-node.sh must install devDeps with --include=dev --ignore-scripts'
    );

    // Validate bash syntax
    execFileSync('bash', ['-n', installScriptPath]);
  });
});

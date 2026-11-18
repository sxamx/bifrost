import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_GRACE_WINDOW_MS,
  createBifrostNodeServer,
  detectTailscaleIpv4,
  isPrivateOrReservedIp,
  isTailscaleCgnatIpv4,
  loadOrGenerateTlsMaterial,
  parseCliArgs,
  parseConnectAuthority
} from './dist/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SILENT_LOGGER = {
  info: () => {},
  warn: () => {},
  error: () => {}
};

function openHttpConnectTunnel(options: {
  proxyHost: string;
  proxyPort: number;
  targetAuthority: string;
  token?: string;
  useProxyTls?: boolean;
  proxyCaCertPem?: string;
}): Promise<{ statusCode: number; rawHeaders: string; socket: net.Socket | tls.TLSSocket }> {
  return new Promise((resolve, reject) => {
    const sock = options.useProxyTls
      ? tls.connect({
          host: options.proxyHost,
          port: options.proxyPort,
          ca: options.proxyCaCertPem,
          checkServerIdentity: () => undefined
        })
      : net.connect({
          host: options.proxyHost,
          port: options.proxyPort
        });

    const onConnect = () => {
      const lines = [
        `CONNECT ${options.targetAuthority} HTTP/1.1`,
        `Host: ${options.targetAuthority}`
      ];
      if (options.token !== undefined) {
        lines.push(`Proxy-Authorization: Bearer ${options.token}`);
      }
      lines.push('', '');
      sock.write(lines.join('\r\n'));
    };

    if (options.useProxyTls) {
      sock.once('secureConnect', onConnect);
    } else {
      sock.once('connect', onConnect);
    }

    let buffer = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;

      sock.removeListener('data', onData);
      const headerBlock = buffer.subarray(0, headerEnd).toString('utf8');
      const leftover = buffer.subarray(headerEnd + 4);
      if (leftover.length > 0) {
        sock.unshift(leftover);
      }

      const firstLine = headerBlock.split('\r\n')[0] ?? '';
      const statusMatch = /^HTTP\/1\.[01]\s+(\d{3})/.exec(firstLine);
      const statusCode = statusMatch ? Number(statusMatch[1]) : 0;

      resolve({
        statusCode,
        rawHeaders: headerBlock,
        socket: sock
      });
    };

    sock.on('data', onData);
    sock.once('error', reject);
  });
}

describe('Bifrost Phase 3 Egress Node Agent (nodes/)', () => {
  it('tunnels end-to-end HTTPS over HTTP CONNECT without decrypting upstream Authorization or payload', async () => {
    const upstreamTls = loadOrGenerateTlsMaterial();
    let seenUpstreamAuth = '';

    const upstreamServer = https.createServer(
      { cert: upstreamTls.certPem, key: upstreamTls.keyPem },
      async (req, res) => {
        seenUpstreamAuth = String(req.headers['authorization'] ?? '');
        const chunks: Buffer[] = [];
        for await (const c of req) {
          chunks.push(c as Buffer);
        }
        const reqJson = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { prompt: string };
        const payload = JSON.stringify({
          id: 'chatcmpl-test',
          echoPrompt: reqJson.prompt,
          upstreamEncrypted: true
        });
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload).toString()
        });
        res.end(payload);
      }
    );

    await new Promise<void>((resolve) => upstreamServer.listen(0, '127.0.0.1', resolve));
    const upstreamPort = (upstreamServer.address() as net.AddressInfo).port;

    const nodeToken = 'node_secret_token_32bytes_abcdef012345';
    const node = createBifrostNodeServer({
      mode: 'tailscale',
      bindHost: '127.0.0.1',
      port: 0,
      token: nodeToken,
      allowedPorts: [upstreamPort],
      allowPrivateTargets: true,
      logger: SILENT_LOGGER
    });

    const { port: proxyPort } = await node.start();

    try {
      const tunnel = await openHttpConnectTunnel({
        proxyHost: '127.0.0.1',
        proxyPort,
        targetAuthority: `127.0.0.1:${upstreamPort}`,
        token: nodeToken
      });
      assert.equal(tunnel.statusCode, 200);
      assert.equal(node.getActiveTunnels(), 1);

      // Perform end-to-end TLS handshake directly from client to upstream over raw TCP tunnel
      const tlsTunnel = tls.connect({
        socket: tunnel.socket,
        ca: upstreamTls.certPem,
        servername: 'bifrost-egress-node',
        checkServerIdentity: () => undefined
      });
      await new Promise<void>((resolve, reject) => {
        tlsTunnel.once('secureConnect', resolve);
        tlsTunnel.once('error', reject);
      });

      // Verify /_bifrost/health reports active_tunnels === 1 while tunnel is open
      const healthRes = await fetch(`http://127.0.0.1:${proxyPort}/_bifrost/health`, {
        headers: { 'Proxy-Authorization': `Bearer ${nodeToken}` }
      });
      assert.equal(healthRes.status, 200);
      const healthBody = (await healthRes.json()) as {
        ok: boolean;
        uptime_sec: number;
        version: string;
        active_tunnels: number;
      };
      assert.equal(healthBody.ok, true);
      assert.equal(healthBody.version, '0.1.0');
      assert.equal(healthBody.active_tunnels, 1);

      const postBody = JSON.stringify({ prompt: 'Zero-knowledge test message' });
      const rawHttpReq = [
        'POST /v1/chat/completions HTTP/1.1',
        `Host: 127.0.0.1:${upstreamPort}`,
        'Authorization: Bearer sk-or-v1-super-secret-provider-key',
        'Content-Type: application/json',
        `Content-Length: ${Buffer.byteLength(postBody)}`,
        'Connection: close',
        '',
        postBody
      ].join('\r\n');

      tlsTunnel.write(rawHttpReq);

      const resChunks: Buffer[] = [];
      for await (const chunk of tlsTunnel) {
        resChunks.push(chunk as Buffer);
      }
      const fullHttpResponse = Buffer.concat(resChunks).toString('utf8');
      const bodyStart = fullHttpResponse.indexOf('\r\n\r\n');
      assert.ok(bodyStart !== -1);
      const parsedBody = JSON.parse(fullHttpResponse.slice(bodyStart + 4)) as {
        echoPrompt: string;
        upstreamEncrypted: boolean;
      };

      assert.equal(seenUpstreamAuth, 'Bearer sk-or-v1-super-secret-provider-key');
      assert.equal(parsedBody.echoPrompt, 'Zero-knowledge test message');
      assert.equal(parsedBody.upstreamEncrypted, true);

      await new Promise((r) => setTimeout(r, 30));
      assert.equal(node.getActiveTunnels(), 0);
    } finally {
      await node.stop();
      await new Promise<void>((resolve) => upstreamServer.close(() => resolve()));
    }
  });

  it('rejects unauthenticated or invalid-token CONNECT with 407 and HTTP control calls with 401', async () => {
    const validToken = 'valid_node_token_0123456789abcdef0123';
    const node = createBifrostNodeServer({
      mode: 'tailscale',
      bindHost: '127.0.0.1',
      port: 0,
      token: validToken,
      logger: SILENT_LOGGER
    });
    const { port } = await node.start();

    try {
      const noTokenTunnel = await openHttpConnectTunnel({
        proxyHost: '127.0.0.1',
        proxyPort: port,
        targetAuthority: '1.1.1.1:443'
      });
      assert.equal(noTokenTunnel.statusCode, 407);
      assert.match(noTokenTunnel.rawHeaders, /Proxy-Authenticate:\s*Bearer/i);
      noTokenTunnel.socket.destroy();

      const badTokenTunnel = await openHttpConnectTunnel({
        proxyHost: '127.0.0.1',
        proxyPort: port,
        targetAuthority: '1.1.1.1:443',
        token: 'wrong_token_value_0000000000000000000'
      });
      assert.equal(badTokenTunnel.statusCode, 407);
      badTokenTunnel.socket.destroy();

      const unauthHealth = await fetch(`http://127.0.0.1:${port}/_bifrost/health`);
      assert.equal(unauthHealth.status, 401);

      const unauthRotate = await fetch(`http://127.0.0.1:${port}/_bifrost/rotate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newToken: 'another_token_value_123456789012345' })
      });
      assert.equal(unauthRotate.status, 401);
    } finally {
      await node.stop();
    }
  });

  it('enforces SSRF protection against loopback, RFC1918, link-local, CGNAT, IPv6 private/transition, and non-443 ports', async () => {
    for (const blockedIp of [
      '0.0.0.0',
      '127.0.0.1',
      '127.255.255.254',
      '10.0.0.1',
      '10.255.255.255',
      '172.16.0.1',
      '172.31.255.254',
      '192.168.0.1',
      '192.0.0.192',
      '192.88.99.1',
      '169.254.169.254',
      '100.64.0.1',
      '100.100.100.100',
      '100.100.100.200',
      '::1',
      '::',
      '::127.0.0.1',
      '::ffff:127.0.0.1',
      '::ffff:169.254.169.254',
      '::ffff:100.100.100.200',
      '::ffff:0:127.0.0.1',
      '::ffff:0:169.254.169.254',
      '::ffff:0:1.1.1.1',
      '64:ff9b::169.254.169.254',
      '64:ff9b::1.1.1.1',
      '64:ff9b:1::1',
      '2001:0000:4136:e378:8000:63bf:3fff:fdd2',
      '2001:2::1',
      '2002:a9fe:a9fe::1',
      '2002:7f00:0001::1',
      '2002:0101:0101::1',
      'fd00:ec2::254',
      'fc00::1',
      'fd12:3456:789a::1',
      'fe80::1',
      'fe80::1%eth0',
    ]) {
      assert.equal(isPrivateOrReservedIp(blockedIp), true, `Expected ${blockedIp} to be blocked`);
    }

    for (const publicIp of [
      '1.1.1.1',
      '8.8.8.8',
      '104.18.2.15',
      '100.63.255.254',
      '100.128.0.1',
      '2606:4700:4700::1111',
      '2001:4860:4860::8888',
    ]) {
      assert.equal(isPrivateOrReservedIp(publicIp), false, `Expected ${publicIp} to be allowed`);
    }

    assert.deepEqual(parseConnectAuthority('openrouter.ai:443'), {
      host: 'openrouter.ai',
      port: 443
    });
    assert.deepEqual(parseConnectAuthority('[2606:4700:4700::1111]:443'), {
      host: '2606:4700:4700::1111',
      port: 443
    });
    assert.equal(parseConnectAuthority('missing-port'), null);

    const token = 'ssrf_guard_token_0123456789abcdef0123';
    const node = createBifrostNodeServer({
      mode: 'tailscale',
      bindHost: '127.0.0.1',
      port: 0,
      token,
      logger: SILENT_LOGGER
    });
    const { port } = await node.start();

    try {
      const blockedTargets = [
        '127.0.0.1:443',
        '10.1.2.3:443',
        '192.168.1.1:443',
        '172.20.0.5:443',
        '169.254.169.254:443',
        '100.100.100.100:443',
        '100.100.100.200:443',
        '[::1]:443',
        '[::ffff:127.0.0.1]:443',
        '[::ffff:0:169.254.169.254]:443',
        '[2002:a9fe:a9fe::1]:443',
        '[2001:0000:4136:e378:8000:63bf:3fff:fdd2]:443',
        '[64:ff9b::1.1.1.1]:443',
        '[64:ff9b:1::1]:443',
        '[fd00:ec2::254]:443',
        'localhost:443',
        'metadata.google.internal:443',
        '1.1.1.1:22',
        '1.1.1.1:8080'
      ];

      for (const authority of blockedTargets) {
        const res = await openHttpConnectTunnel({
          proxyHost: '127.0.0.1',
          proxyPort: port,
          targetAuthority: authority,
          token
        });
        assert.equal(res.statusCode, 403, `Expected 403 Forbidden for ${authority}`);
        res.socket.destroy();
      }
    } finally {
      await node.stop();
    }
  });

  it('rotates tokens with zero downtime across a 5-minute grace window without dropping active tunnels', async () => {
    const echoServer = net.createServer((sock) => {
      sock.pipe(sock);
    });
    await new Promise<void>((resolve) => echoServer.listen(0, '127.0.0.1', resolve));
    const echoPort = (echoServer.address() as net.AddressInfo).port;

    const tmpStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-node-state-'));
    const stateFilePath = path.join(tmpStateDir, 'token-state.json');

    let fakeNowMs = 1_763_419_200_000;
    const initialToken = 'token_v1_initial_secret_0123456789abcd';
    const rotatedToken = 'token_v2_rotated_secret_9876543210fedc';

    const node = createBifrostNodeServer({
      mode: 'tailscale',
      bindHost: '127.0.0.1',
      port: 0,
      token: initialToken,
      stateFilePath,
      graceWindowMs: DEFAULT_GRACE_WINDOW_MS, // Full 300,000 ms (5 minutes)
      now: () => fakeNowMs,
      allowedPorts: [echoPort],
      allowPrivateTargets: true,
      logger: SILENT_LOGGER
    });
    const { port } = await node.start();

    try {
      const inFlightTunnel = await openHttpConnectTunnel({
        proxyHost: '127.0.0.1',
        proxyPort: port,
        targetAuthority: `127.0.0.1:${echoPort}`,
        token: initialToken
      });
      assert.equal(inFlightTunnel.statusCode, 200);

      const rotateRes = await fetch(`http://127.0.0.1:${port}/_bifrost/rotate`, {
        method: 'POST',
        headers: {
          'Proxy-Authorization': `Bearer ${initialToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ newToken: rotatedToken })
      });
      assert.equal(rotateRes.status, 200);
      const rotateBody = (await rotateRes.json()) as {
        ok: boolean;
        grace_window_ms: number;
      };
      assert.equal(rotateBody.ok, true);
      assert.equal(rotateBody.grace_window_ms, 300_000);

      // Advance clock 4 minutes 59 seconds (still inside 5-minute grace window)
      fakeNowMs += 299_000;

      const oldHealthDuringGrace = await fetch(`http://127.0.0.1:${port}/_bifrost/health`, {
        headers: { 'Proxy-Authorization': `Bearer ${initialToken}` }
      });
      assert.equal(oldHealthDuringGrace.status, 200);

      const newHealthDuringGrace = await fetch(`http://127.0.0.1:${port}/_bifrost/health`, {
        headers: { Authorization: `Bearer ${rotatedToken}` }
      });
      assert.equal(newHealthDuringGrace.status, 200);

      const graceTunnel = await openHttpConnectTunnel({
        proxyHost: '127.0.0.1',
        proxyPort: port,
        targetAuthority: `127.0.0.1:${echoPort}`,
        token: initialToken
      });
      assert.equal(graceTunnel.statusCode, 200);
      graceTunnel.socket.destroy();

      // Previous token MUST NOT rotate again
      const staleRotateAttempt = await fetch(`http://127.0.0.1:${port}/_bifrost/rotate`, {
        method: 'POST',
        headers: {
          'Proxy-Authorization': `Bearer ${initialToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ newToken: 'token_v3_hijack_attempt_0123456789abcd' })
      });
      assert.equal(staleRotateAttempt.status, 401);

      // Advance past the 5-minute grace window (total +301s)
      fakeNowMs += 2_000;

      const expiredHealth = await fetch(`http://127.0.0.1:${port}/_bifrost/health`, {
        headers: { 'Proxy-Authorization': `Bearer ${initialToken}` }
      });
      assert.equal(expiredHealth.status, 401);

      const expiredTunnel = await openHttpConnectTunnel({
        proxyHost: '127.0.0.1',
        proxyPort: port,
        targetAuthority: `127.0.0.1:${echoPort}`,
        token: initialToken
      });
      assert.equal(expiredTunnel.statusCode, 407);
      expiredTunnel.socket.destroy();

      const activeHealth = await fetch(`http://127.0.0.1:${port}/_bifrost/health`, {
        headers: { 'Proxy-Authorization': `Bearer ${rotatedToken}` }
      });
      assert.equal(activeHealth.status, 200);

      // In-flight tunnel opened BEFORE rotation stays uninterrupted
      const pingPayload = 'streaming-chunk-after-grace-expiry';
      inFlightTunnel.socket.write(pingPayload);
      const echoed = await new Promise<string>((resolve, reject) => {
        inFlightTunnel.socket.once('data', (chunk: Buffer) => resolve(chunk.toString('utf8')));
        inFlightTunnel.socket.once('error', reject);
      });
      assert.equal(echoed, pingPayload);
      inFlightTunnel.socket.destroy();
    } finally {
      await node.stop();
      await new Promise<void>((resolve) => echoServer.close(() => resolve()));
    }

    const rawState = fs.readFileSync(stateFilePath, 'utf8');
    assert.ok(!rawState.includes(rotatedToken), 'State file must never contain plaintext token');
    assert.equal(fs.statSync(stateFilePath).mode & 0o777, 0o600);

    const restartedNode = createBifrostNodeServer({
      mode: 'tailscale',
      bindHost: '127.0.0.1',
      port: 0,
      stateFilePath,
      logger: SILENT_LOGGER
    });
    const { port: restartedPort } = await restartedNode.start();
    try {
      const checkRestarted = await fetch(`http://127.0.0.1:${restartedPort}/_bifrost/health`, {
        headers: { 'Proxy-Authorization': `Bearer ${rotatedToken}` }
      });
      assert.equal(checkRestarted.status, 200);
    } finally {
      await restartedNode.stop();
      fs.rmSync(tmpStateDir, { recursive: true, force: true });
    }
  });

  it('handles tailscale IPv4 detection and public_ip TLS mode with SHA-256 cert fingerprint', async () => {
    assert.equal(isTailscaleCgnatIpv4('100.64.0.1'), true);
    assert.equal(isTailscaleCgnatIpv4('100.101.42.9'), true);
    assert.equal(isTailscaleCgnatIpv4('100.127.255.254'), true);
    assert.equal(isTailscaleCgnatIpv4('100.63.255.255'), false);
    assert.equal(isTailscaleCgnatIpv4('100.128.0.1'), false);

    const detected = detectTailscaleIpv4({
      interfaces: {
        eth0: [
          {
            address: '192.168.1.20',
            netmask: '255.255.255.0',
            family: 'IPv4',
            mac: '00:00:00:00:00:01',
            internal: false,
            cidr: '192.168.1.20/24'
          }
        ],
        tailscale0: [
          {
            address: '100.88.14.7',
            netmask: '255.255.255.255',
            family: 'IPv4',
            mac: '00:00:00:00:00:02',
            internal: false,
            cidr: '100.88.14.7/32'
          }
        ]
      },
      execTailscaleCli: () => null
    });
    assert.equal(detected, '100.88.14.7');

    const warnings: string[] = [];
    assert.throws(
      () =>
        createBifrostNodeServer({
          mode: 'tailscale',
          token: 'missing_ts_test_token_0123456789abcdef',
          detectTailscaleOptions: {
            interfaces: {},
            execTailscaleCli: () => null
          },
          logger: {
            info: () => {},
            warn: (m) => warnings.push(m),
            error: () => {}
          }
        }),
      /--mode=public_ip/
    );
    assert.equal(warnings.length, 1);

    const tcpEcho = net.createServer((s) => s.pipe(s));
    await new Promise<void>((resolve) => tcpEcho.listen(0, '127.0.0.1', resolve));
    const echoPort = (tcpEcho.address() as net.AddressInfo).port;

    const publicToken = 'public_ip_mode_token_0123456789abcdef';
    const publicNode = createBifrostNodeServer({
      mode: 'public_ip',
      bindHost: '127.0.0.1',
      port: 0,
      token: publicToken,
      allowedPorts: [echoPort],
      allowPrivateTargets: true,
      logger: SILENT_LOGGER
    });

    const started = await publicNode.start();
    try {
      assert.ok(started.tlsFingerprintSha256);
      assert.match(started.tlsFingerprintSha256, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);

      const tlsConnectRes = await openHttpConnectTunnel({
        proxyHost: '127.0.0.1',
        proxyPort: started.port,
        targetAuthority: `127.0.0.1:${echoPort}`,
        token: publicToken,
        useProxyTls: true,
        proxyCaCertPem: publicNode.tlsCertPem
      });
      assert.equal(tlsConnectRes.statusCode, 200);

      tlsConnectRes.socket.write('over-tls-proxy');
      const reply = await new Promise<string>((resolve, reject) => {
        tlsConnectRes.socket.once('data', (d: Buffer) => resolve(d.toString('utf8')));
        tlsConnectRes.socket.once('error', reject);
      });
      assert.equal(reply, 'over-tls-proxy');
      tlsConnectRes.socket.destroy();
    } finally {
      await publicNode.stop();
      await new Promise<void>((resolve) => tcpEcho.close(() => resolve()));
    }
  });

  it('validates CLI argument parsing and install-node.sh bash syntax', () => {
    const parsed = parseCliArgs(
      ['--token=my_secret_token_12345678', '--mode', 'public_ip', '--port=9555'],
      {}
    );
    assert.equal(parsed.token, 'my_secret_token_12345678');
    assert.equal(parsed.mode, 'public_ip');
    assert.equal(parsed.port, 9555);

    const scriptPath = path.join(__dirname, 'install-node.sh');
    execFileSync('bash', ['-n', scriptPath]);
    const helpOut = execFileSync('bash', [scriptPath, '--help'], { encoding: 'utf8' });
    assert.match(helpOut, /--token/);
    assert.match(helpOut, /--mode/);
    assert.match(helpOut, /--port/);
  });
});

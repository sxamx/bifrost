import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createApp } from '../core/src/app.js';
import { hashPassword, resolveMasterKey } from '../core/src/crypto.js';
import { openDatabase } from '../core/src/db.js';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-phase7-test-'));
}

function extractCookieHeader(res: Response): string {
  const raw = res.headers.get('set-cookie');
  assert.ok(raw, 'Expected Set-Cookie header');
  return raw.split(';')[0]!;
}

describe('Phase 7 Backend — Community Marketplace, Sidecar Adapters, Multi-Account Failover & Anti-SSRF', () => {
  it('HU-23 & HU-24: filters approved marketplace index.json manifests, blocks path traversal, falls back to bundled catalog offline, and routes multi-account experimental-adapter traffic with failover', async () => {
    const tmpDir = makeTempDir();
    const clockMs = Date.UTC(2026, 10, 18, 18, 0, 0);

    try {
      const { key: masterKey } = resolveMasterKey({ dataDir: tmpDir, envMasterKey: undefined });
      const db = openDatabase(path.join(tmpDir, 'bifrost.db'));

      let remoteMarketplaceOffline = false;
      const sidecarAuthSeen: string[] = [];

      const mockFetch: typeof fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

        // Remote marketplace index.json + manifests
        if (url === 'https://marketplace.bifrost.example/index.json') {
          if (remoteMarketplaceOffline) {
            throw new Error('ENOTFOUND marketplace.bifrost.example');
          }
          return new Response(
            JSON.stringify({
              schemaVersion: '1.0',
              repository: 'mazzapata/providers',
              providers: [
                {
                  id: 'groq',
                  name: 'Groq Cloud',
                  description: 'LPU inference with free tier.',
                  approved: true,
                  manifestPath: 'providers/groq.json',
                },
                {
                  id: 'experimental-sidecar',
                  name: 'Local Sidecar Adapter',
                  description: 'Isolated sidecar adapter on localhost.',
                  approved: true,
                  manifestPath: 'providers/experimental-sidecar.json',
                },
                {
                  id: 'shady-unapproved',
                  name: 'Unapproved Provider',
                  approved: false,
                  manifestPath: 'providers/shady-unapproved.json',
                },
                {
                  id: 'traversal-attempt',
                  name: 'Traversal Attempt',
                  approved: true,
                  manifestPath: 'providers/../../etc/passwd.json',
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json', ETag: '"mp-v1"' } },
          );
        }

        if (url === 'https://marketplace.bifrost.example/providers/groq.json') {
          return new Response(
            JSON.stringify({
              schemaVersion: '1.0',
              id: 'groq',
              name: 'Groq Cloud',
              category: 'official-api',
              packageType: 'official-json',
              verified: true,
              baseUrl: 'https://api.groq.com/openai/v1',
              auth: { type: 'bearer', header: 'Authorization', prefix: 'Bearer ' },
              modelsSource: 'api',
              modelsEndpoint: '/models',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }

        if (url === 'https://marketplace.bifrost.example/providers/experimental-sidecar.json') {
          return new Response(
            JSON.stringify({
              schemaVersion: '1.0',
              id: 'experimental-sidecar',
              name: 'Local Sidecar Adapter',
              category: 'experimental-adapter',
              packageType: 'experimental-adapter',
              verified: false,
              baseUrl: 'http://127.0.0.1:3100/v1',
              auth: { type: 'bearer', header: 'Authorization', prefix: 'Bearer ' },
              modelsSource: 'static',
              reviewedAt: '2026-11-17',
              staticModels: [
                {
                  id: 'sidecar-free-v1',
                  name: 'Sidecar Free V1',
                  contextLength: 65536,
                  maxOutput: 8192,
                },
              ],
              adapter: {
                defaultPort: 3100,
                healthPath: '/health',
                accountLabel: 'Session Token',
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }

        // Custom sidecar health check & chat completions on port 4310
        if (url === 'http://127.0.0.1:4310/health') {
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        if (url === 'http://127.0.0.1:4310/v1/chat/completions') {
          const auth = new Headers(init?.headers).get('authorization') ?? '';
          sidecarAuthSeen.push(auth);
          // Simulate account 1 rate-limited (429) -> automatic failover to account 2!
          if (auth.includes('acct-token-1111')) {
            return new Response(
              JSON.stringify({ error: { message: 'Account 1 rate limited' } }),
              { status: 429, headers: { 'Content-Type': 'application/json' } },
            );
          }
          return new Response(
            JSON.stringify({
              id: 'chatcmpl-sidecar-ok',
              object: 'chat.completion',
              created: Math.floor(clockMs / 1000),
              model: 'sidecar-free-v1',
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: 'Respuesta desde cuenta 2 del sidecar.' },
                  finish_reason: 'stop',
                },
              ],
              usage: { prompt_tokens: 25, completion_tokens: 15, total_tokens: 40 },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }

        throw new Error(`Unexpected fetch URL in phase7 test: ${url}`);
      };

      const app = createApp({
        db,
        masterKey,
        marketplaceUrl: 'https://marketplace.bifrost.example/index.json',
        fetchImpl: mockFetch,
        now: () => clockMs,
      });

      const setupRes = await app.request('http://localhost/api/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'adminpassword123' }),
      });
      assert.equal(setupRes.status, 201);
      const adminCookie = extractCookieHeader(setupRes);

      // 1) GET /api/marketplace returns ONLY approved manifests (2 items; excludes shady-unapproved & traversal-attempt)
      const mpRes = await app.request('http://localhost/api/marketplace', {
        headers: { Cookie: adminCookie },
      });
      assert.equal(mpRes.status, 200);
      const mpBody = (await mpRes.json()) as {
        online: boolean;
        providers: Array<{ id: string; description?: string; approved?: boolean }>;
      };
      assert.equal(mpBody.online, true);
      assert.deepEqual(
        mpBody.providers.map((p) => p.id),
        ['groq', 'experimental-sidecar'],
      );
      assert.equal(mpBody.providers[0]!.description, 'LPU inference with free tier.');

      // 2) Attempting to install unapproved package by ID or inline approved:false -> 403
      const unapprovedById = await app.request('http://localhost/api/marketplace/install', {
        method: 'POST',
        headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'shady-unapproved' }),
      });
      assert.equal(unapprovedById.status, 403);

      const unapprovedInline = await app.request('http://localhost/api/marketplace/install', {
        method: 'POST',
        headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          manifest: { ...mpBody.providers[0], id: 'inline-unapproved', approved: false },
        }),
      });
      assert.equal(unapprovedInline.status, 403);

      // 3) Guest cannot install marketplace packages -> 403
      const guestHash = await hashPassword('guestpass123');
      db.prepare(
        `INSERT INTO users (id, username, password_hash, role, daily_token_limit, quota_reset_mode, created_at)
         VALUES ('guest-mp', 'guest_mp', ?, 'guest', 1000, 'utc_midnight', 1700000000)`,
      ).run(guestHash);
      const gLogin = await app.request('http://localhost/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'guest_mp', password: 'guestpass123' }),
      });
      const guestCookie = extractCookieHeader(gLogin);

      const guestInstall = await app.request('http://localhost/api/marketplace/install', {
        method: 'POST',
        headers: { Cookie: guestCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'groq' }),
      });
      assert.equal(guestInstall.status, 403);

      // 4) Install official-json by catalog ID AND experimental-adapter with custom adapterUrl + health probe
      const installGroq = await app.request('http://localhost/api/marketplace/install', {
        method: 'POST',
        headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'groq' }),
      });
      assert.equal(installGroq.status, 201);

      const installSidecar = await app.request('http://localhost/api/marketplace/install', {
        method: 'POST',
        headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerId: 'experimental-sidecar',
          adapterUrl: 'http://127.0.0.1:4310/v1',
          checkAdapterHealth: true,
        }),
      });
      assert.equal(installSidecar.status, 201);
      const sidecarInstallBody = (await installSidecar.json()) as {
        provider: { id: string; packageType: string; adapterUrl: string };
        adapterHealth: { reachable: boolean; status: number };
      };
      assert.equal(sidecarInstallBody.provider.id, 'experimental-sidecar');
      assert.equal(sidecarInstallBody.provider.packageType, 'experimental-adapter');
      assert.equal(sidecarInstallBody.adapterHealth.reachable, true);
      assert.equal(sidecarInstallBody.adapterHealth.status, 200);

      // 5) Configure 2 accounts on experimental-sidecar, detect static models, and verify failover across accounts
      for (const [label, secret] of [
        ['Cuenta Sidecar A', 'acct-token-1111'],
        ['Cuenta Sidecar B', 'acct-token-2222'],
      ]) {
        const kr = await app.request('http://localhost/api/providers/experimental-sidecar/keys', {
          method: 'POST',
          headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({ label, secret }),
        });
        assert.equal(kr.status, 201);
      }

      const detectRes = await app.request(
        'http://localhost/api/providers/experimental-sidecar/detect-models',
        { method: 'POST', headers: { Cookie: adminCookie } },
      );
      assert.equal(detectRes.status, 200);

      const pgRes = await app.request('http://localhost/api/playground/chat', {
        method: 'POST',
        headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'experimental-sidecar/sidecar-free-v1',
          messages: [{ role: 'user', content: 'Hola sidecar' }],
        }),
      });
      assert.equal(pgRes.status, 200);
      const pgBody = (await pgRes.json()) as { content: string };
      assert.equal(pgBody.content, 'Respuesta desde cuenta 2 del sidecar.');
      assert.equal(sidecarAuthSeen.length, 2);

      // 6) Offline bundled fallback (clear external_cache & set remoteMarketplaceOffline=true)
      db.prepare(
        `DELETE FROM external_cache WHERE cache_key = 'marketplace:index' OR cache_key LIKE 'marketplace_source:%'`,
      ).run();
      remoteMarketplaceOffline = true;
      const offlineMpRes = await app.request('http://localhost/api/marketplace', {
        headers: { Cookie: adminCookie },
      });
      assert.equal(offlineMpRes.status, 200);
      const offlineBody = (await offlineMpRes.json()) as {
        offline: boolean;
        providers: Array<{ id: string }>;
      };
      assert.equal(offlineBody.offline, true);
      assert.ok(offlineBody.providers.some((p) => p.id === 'openrouter'));
      assert.ok(offlineBody.providers.some((p) => p.id === 'nvidia-nim'));
      assert.ok(offlineBody.providers.some((p) => p.id === 'opencode-zen'));
      assert.ok(offlineBody.providers.some((p) => p.id === 'google-ai-studio'));
      assert.ok(offlineBody.providers.some((p) => p.id === 'groq'));
      assert.ok(offlineBody.providers.some((p) => p.id === 'experimental-sidecar-template'));

      db.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('Red-Team Anti-SSRF: blocks cloud metadata (169.254.169.254, fd00:ec2::254, fe80::, 100.100.100.200), CGNAT, RFC1918, NAT64/6to4/Teredo, userinfo, and non-HTTPS official upstreams', async () => {
    const tmpDir = makeTempDir();
    try {
      const { key: masterKey } = resolveMasterKey({ dataDir: tmpDir, envMasterKey: undefined });
      const db = openDatabase(path.join(tmpDir, 'bifrost.db'));
      const app = createApp({ db, masterKey });

      const setupRes = await app.request('http://localhost/api/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'adminpassword123' }),
      });
      const adminCookie = extractCookieHeader(setupRes);

      const baseSidecarManifest = {
        schemaVersion: '1.0',
        id: 'ssrf-sidecar',
        name: 'SSRF Test Sidecar',
        category: 'experimental-adapter',
        packageType: 'experimental-adapter',
        verified: false,
        baseUrl: 'http://127.0.0.1:3100/v1',
        auth: { type: 'bearer', header: 'Authorization', prefix: 'Bearer ' },
        modelsSource: 'static',
        reviewedAt: '2026-11-17',
        staticModels: [{ id: 'm1', name: 'M1' }],
        adapter: { defaultPort: 3100, healthPath: '/health' },
      };

      const forbiddenAdapterUrls = [
        'http://169.254.169.254/latest/meta-data/',
        'http://169.254.10.20:8080/v1',
        'http://[::ffff:169.254.169.254]/v1',
        'http://[fd00:ec2::254]/latest/meta-data/',
        'http://[fe80::1]:3100/v1',
        'http://100.100.100.200/latest/meta-data/',
        'http://100.64.0.10:3100/v1',
        'http://0.0.0.0:3100/v1',
        'https://224.0.0.1/v1',
        'https://[2002:a9fe:a9fe::1]/v1',
        'https://[2001:0000::1]/v1',
        'https://[64:ff9b::169.254.169.254]/v1',
        'http://10.0.0.5:3100/v1',
        'http://172.16.0.5:3100/v1',
        'http://192.168.1.25:3100/v1',
        'http://metadata.google.internal/computeMetadata/v1/',
        'https://admin:secret@sidecar.example.com/v1',
        'http://sidecar.example.com/v1',
      ];

      for (const badUrl of forbiddenAdapterUrls) {
        const res = await app.request('http://localhost/api/marketplace/install', {
          method: 'POST',
          headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            manifest: { ...baseSidecarManifest, id: `ssrf-${Math.random().toString(36).slice(2, 8)}` },
            adapterUrl: badUrl,
          }),
        });
        assert.equal(res.status, 400, `Expected 400 for SSRF adapterUrl: ${badUrl}`);
      }

      // Also verify official-json rejects plain HTTP public upstream and loopback when BIFROST_ALLOW_LOCAL_UPSTREAMS=0
      const httpOfficial = await app.request('http://localhost/api/marketplace/install', {
        method: 'POST',
        headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          manifest: {
            schemaVersion: '1.0',
            id: 'plain-http-official',
            name: 'Plain HTTP Official',
            packageType: 'official-json',
            baseUrl: 'http://api.groq.com/openai/v1',
            auth: { type: 'bearer', header: 'Authorization', prefix: 'Bearer ' },
            modelsSource: 'api',
            modelsEndpoint: '/models',
          },
        }),
      });
      assert.equal(httpOfficial.status, 400);

      const prevAllow = process.env.BIFROST_ALLOW_LOCAL_UPSTREAMS;
      process.env.BIFROST_ALLOW_LOCAL_UPSTREAMS = '0';
      try {
        const loopbackOfficial = await app.request('http://localhost/api/marketplace/install', {
          method: 'POST',
          headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            manifest: {
              schemaVersion: '1.0',
              id: 'loopback-official',
              name: 'Loopback Official',
              packageType: 'official-json',
              baseUrl: 'http://127.0.0.1:8080/v1',
              auth: { type: 'bearer', header: 'Authorization', prefix: 'Bearer ' },
              modelsSource: 'api',
              modelsEndpoint: '/models',
            },
          }),
        });
        assert.equal(loopbackOfficial.status, 400);
      } finally {
        if (prevAllow === undefined) delete process.env.BIFROST_ALLOW_LOCAL_UPSTREAMS;
        else process.env.BIFROST_ALLOW_LOCAL_UPSTREAMS = prevAllow;
      }

      db.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

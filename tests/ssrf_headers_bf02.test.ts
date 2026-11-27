import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createApp } from '../core/src/app.js';
import { resolveMasterKey } from '../core/src/crypto.js';
import { openDatabase } from '../core/src/db.js';
import { validateMarketplaceSourceUrl } from '../core/src/marketplace.js';
import { redactSecretsInText } from '../core/src/metrics/redact.js';
import {
  buildProviderAuthHeaders,
  mergeHeadersCaseInsensitive,
  validateProviderManifest,
} from '../core/src/schema.js';
import {
  UpstreamSsrfError,
  assertSafeUpstreamUrl,
  assertSafeUpstreamUrlSync,
  createPinnedLookup,
  safeFetch,
  validateSafeUpstreamUrl,
} from '../core/src/ssrf.js';

function makeTempDir(prefix = 'bifrost-ola1-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function extractSessionCookie(res: Response): string {
  const setCookie = res.headers.get('set-cookie') ?? '';
  const match = /bifrost_session=([^;]+)/.exec(setCookie);
  assert.ok(match, `Expected bifrost_session cookie, got "${setCookie}"`);
  return `bifrost_session=${match[1]}`;
}

async function setupAdmin(app: ReturnType<typeof createApp>): Promise<string> {
  const res = await app.request('http://localhost/api/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'StrongAdminPassword123!' }),
  });
  assert.equal(res.status, 201);
  return extractSessionCookie(res);
}

describe('Ola 1 Security Hardening — SSRF DNS/IP-pinning, Endpoint/Header Sanitization, BF-02 & BF-04', () => {
  it('1. Rejects absolute/cross-origin modelsEndpoint and adapter.healthPath in schema, install, models-sync, and key test', async () => {
    const baseManifest = {
      schemaVersion: '1.0' as const,
      id: 'sec01-test',
      name: 'SEC-01 Test Provider',
      packageType: 'official-json' as const,
      baseUrl: 'https://api.valid-provider.example.com/v1',
      auth: { type: 'bearer' as const, header: 'Authorization', prefix: 'Bearer ' },
      modelsSource: 'api' as const,
      modelsEndpoint: '/models',
    };

    assert.equal(validateProviderManifest(baseManifest).valid, true);

    const maliciousModelsEndpoints = [
      'http://169.254.169.254/latest/meta-data/',
      'http://192.0.0.192/opc/v2/instance/',
      'https://evil.example/v1/models',
      '//evil.example/v1/models',
      '/\\evil.example/v1/models',
      '/models?leak=1',
      '/models#frag',
      '/models/../admin',
      'models',
    ];

    for (const badEp of maliciousModelsEndpoints) {
      const check = validateProviderManifest({ ...baseManifest, modelsEndpoint: badEp });
      assert.equal(check.valid, false, `Expected modelsEndpoint "${badEp}" to be rejected`);
    }

    const maliciousHealthPaths = [
      '//evil.example/health',
      'http://169.254.169.254/latest/meta-data/',
      'https://evil.example/health',
      '/\\evil.example/health',
      '/health/../etc/passwd',
      'health',
    ];

    for (const badHealth of maliciousHealthPaths) {
      const check = validateProviderManifest({
        ...baseManifest,
        id: 'sec01-adapter',
        packageType: 'experimental-adapter',
        baseUrl: 'http://127.0.0.1:4100/v1',
        modelsSource: 'static',
        reviewedAt: '2026-11-26',
        staticModels: [{ id: 'm1', name: 'M1' }],
        modelsEndpoint: undefined,
        adapter: { defaultPort: 4100, healthPath: badHealth },
      });
      assert.equal(check.valid, false, `Expected adapter.healthPath "${badHealth}" to be rejected`);
    }

    // Runtime defense-in-depth: legacy DB row with malicious absolute modelsEndpoint MUST NOT invoke fetchImpl or leak secret
    const tmpDir = makeTempDir();
    const { key: masterKey } = resolveMasterKey({ dataDir: tmpDir, envMasterKey: '' });
    const db = openDatabase(path.join(tmpDir, 'bifrost.db'));
    try {
      let fetchCalled = false;
      const app = createApp({
        db,
        masterKey,
        fetchImpl: async () => {
          fetchCalled = true;
          return new Response(JSON.stringify({ data: [] }), { status: 200 });
        },
      });
      const adminCookie = await setupAdmin(app);

      // Install valid provider first
      const installRes = await app.request('http://localhost/api/providers', {
        method: 'POST',
        headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify(baseManifest),
      });
      assert.equal(installRes.status, 201);

      // Add API key
      const keyRes = await app.request('http://localhost/api/providers/sec01-test/keys', {
        method: 'POST',
        headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: 'K1', secret: 'custom-secret-must-not-leak-1234' }),
      });
      assert.equal(keyRes.status, 201);
      const { key } = (await keyRes.json()) as { key: { id: string } };

      // Tamper DB schema_json directly with an absolute IMDS/evil modelsEndpoint (simulating pre-patch DB row)
      const tampered = { ...baseManifest, modelsEndpoint: 'https://evil.example/v1/models' };
      db.prepare(`UPDATE providers SET schema_json = ? WHERE id = ?`).run(
        JSON.stringify(tampered),
        'sec01-test',
      );

      const detectRes = await app.request(
        'http://localhost/api/providers/sec01-test/detect-models',
        {
          method: 'POST',
          headers: { Cookie: adminCookie },
        },
      );
      assert.equal(detectRes.status, 400);
      assert.equal(fetchCalled, false, 'models-sync must never call fetch for cross-origin modelsEndpoint');

      const testKeyRes = await app.request(
        `http://localhost/api/providers/sec01-test/keys/${key.id}/test`,
        {
          method: 'POST',
          headers: { Cookie: adminCookie },
        },
      );
      assert.equal(testKeyRes.status, 400);
      assert.equal(fetchCalled, false, 'key test must never call fetch for cross-origin modelsEndpoint');
    } finally {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('2. Blocks Oracle IMDS 192.0.0.192, single-label hostnames, DNS rebinding, unsafe BIFROST_MARKETPLACE_URL, and pins approved IPs in safeFetch', async () => {
    // 2a. Oracle Cloud IMDS 192.0.0.192/32 blocked even when allowLocalhostForTests=true
    for (const url of [
      'http://192.0.0.192/opc/v2/instance/',
      'https://192.0.0.192/opc/v2/instance/',
      'http://[::ffff:192.0.0.192]/opc/v2/instance/',
    ]) {
      assert.throws(
        () =>
          assertSafeUpstreamUrlSync(url, {
            mode: 'official-json',
            allowLocalhostForTests: true,
          }),
        UpstreamSsrfError,
      );
      await assert.rejects(
        () =>
          assertSafeUpstreamUrl(url, {
            mode: 'experimental-adapter',
            allowLocalhostForTests: true,
          }),
        UpstreamSsrfError,
      );
    }

    // 2b. Single-label hostnames (Docker internal services) blocked
    for (const singleLabelUrl of [
      'https://watchtower/v1/update',
      'http://watchtower:8080/v1/update',
      'https://redis/v1',
      'https://postgres/v1',
    ]) {
      assert.throws(
        () => assertSafeUpstreamUrlSync(singleLabelUrl, { mode: 'official-json' }),
        UpstreamSsrfError,
        `Expected single-label host ${singleLabelUrl} to be blocked`,
      );
      assert.throws(
        () => assertSafeUpstreamUrlSync(singleLabelUrl, { mode: 'experimental-adapter' }),
        UpstreamSsrfError,
        `Expected single-label host ${singleLabelUrl} to be blocked in experimental-adapter mode`,
      );
      const mpCheck = await validateMarketplaceSourceUrl(singleLabelUrl);
      assert.equal(mpCheck.ok, false);
    }

    // 2c. DNS rebinding via mocked dnsLookup (resolving to 127.0.0.1, 169.254.169.254, 192.0.0.192)
    for (const badIp of ['127.0.0.1', '169.254.169.254', '192.0.0.192', '10.0.0.1', 'fd00:ec2::254']) {
      const res = await validateSafeUpstreamUrl('https://rebind.attacker.example/v1', {
        mode: 'official-json',
        dnsLookup: async () => [{ address: badIp, family: badIp.includes(':') ? 6 : 4 }],
      });
      assert.equal(res.allowed, false, `Expected DNS resolution to ${badIp} to be blocked`);
    }

    // 2d. Startup BIFROST_MARKETPLACE_URL validation in createApp
    const tmpDir = makeTempDir();
    const { key: masterKey } = resolveMasterKey({ dataDir: tmpDir, envMasterKey: '' });
    const db = openDatabase(path.join(tmpDir, 'startup-ssrf.db'));
    try {

      for (const badMpUrl of [
        'http://169.254.169.254/latest/meta-data/',
        'http://192.0.0.192/opc/v2/instance/',
        'https://watchtower/index.json',
        'https://10.0.0.5/index.json',
        'http://127.0.0.1:8080/index.json',
      ]) {
        assert.throws(
          () =>
            createApp({
              db,
              masterKey,
              marketplaceUrl: badMpUrl,
              allowLocalhostUpstreamsForTests: false,
            }),
          UpstreamSsrfError,
          `Expected createApp to reject marketplaceUrl=${badMpUrl}`,
        );
      }

      // 2e. End-to-end DNS rebinding block inside router & models-sync via injected dnsLookup
      let mockFetchInvoked = false;
      const app = createApp({
        db,
        masterKey,
        allowLocalhostUpstreamsForTests: false,
        dnsLookup: async () => [{ address: '169.254.169.254', family: 4 }],
        fetchImpl: async () => {
          mockFetchInvoked = true;
          return new Response(JSON.stringify({ data: [] }), { status: 200 });
        },
      });
      const adminCookie = await setupAdmin(app);

      const provRes = await app.request('http://localhost/api/providers', {
        method: 'POST',
        headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          schemaVersion: '1.0',
          id: 'dns-rebind-prov',
          name: 'DNS Rebind Provider',
          packageType: 'official-json',
          baseUrl: 'https://rebind-target.example.com/v1',
          auth: { type: 'bearer', header: 'Authorization', prefix: 'Bearer ' },
          modelsSource: 'api',
          modelsEndpoint: '/models',
        }),
      });
      assert.equal(provRes.status, 201);

      const keyRes = await app.request('http://localhost/api/providers/dns-rebind-prov/keys', {
        method: 'POST',
        headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: 'Key1', secret: 'custom-secret-rebind-9999' }),
      });
      assert.equal(keyRes.status, 201);

      const detectRes = await app.request(
        'http://localhost/api/providers/dns-rebind-prov/detect-models',
        {
          method: 'POST',
          headers: { Cookie: adminCookie },
        },
      );
      assert.equal(detectRes.status, 400);
      assert.equal(mockFetchInvoked, false, 'DNS rebinding must block before calling fetchImpl');

      // Also test /v1/chat/completions blocks DNS rebinding
      db.prepare(
        `INSERT INTO models (full_id, provider_id, model_id, name, modalities_json, capabilities_json, is_free, first_seen_at, active)
         VALUES ('dns-rebind-prov/m1', 'dns-rebind-prov', 'm1', 'M1', '{"input":["text"],"output":["text"]}', '{}', 1, 1700000000, 1)`,
      ).run();
      const apiKeyRes = await app.request('http://localhost/api/keys', {
        method: 'POST',
        headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Test Internal Key' }),
      });
      const { rawKey } = (await apiKeyRes.json()) as { rawKey: string };

      const chatRes = await app.request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${rawKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'dns-rebind-prov/m1',
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });
      assert.equal(chatRes.status, 400);
      assert.equal(mockFetchInvoked, false);
    } finally {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    // 2f. Real pinned IP HTTP connection + redirect: error enforcement in safeFetch
    let observedHostHeader = '';
    const srv = http.createServer((req, res) => {
      observedHostHeader = String(req.headers.host ?? '');
      if (req.url === '/redirect') {
        res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data/' });
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()));
    const addr = srv.address() as { port: number };
    try {
      const okRes = await safeFetch(
        `http://localhost:${addr.port}/ping`,
        { method: 'GET' },
        {
          mode: 'official-json',
          allowLocalhostForTests: true,
          dnsLookup: async () => [{ address: '127.0.0.1', family: 4 }],
        },
      );
      assert.equal(okRes.status, 200);
      assert.deepEqual(await okRes.json(), { ok: true });
      assert.equal(observedHostHeader, `localhost:${addr.port}`);

      await assert.rejects(
        () =>
          safeFetch(
            `http://localhost:${addr.port}/redirect`,
            { method: 'GET' },
            {
              mode: 'official-json',
              allowLocalhostForTests: true,
              dnsLookup: async () => [{ address: '127.0.0.1', family: 4 }],
            },
          ),
        /redirect/i,
      );
    } finally {
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
  });

  it('3. Rejects forbidden auth.extraHeaders, invalid header names, and CRLF injection; builds deduplicated case-insensitive headers', () => {
    const baseManifest = {
      schemaVersion: '1.0' as const,
      id: 'header-test',
      name: 'Header Test',
      packageType: 'official-json' as const,
      baseUrl: 'https://api.example.com/v1',
      auth: { type: 'bearer' as const, header: 'Authorization', prefix: 'Bearer ' },
      modelsSource: 'static' as const,
      reviewedAt: '2026-11-26',
      staticModels: [{ id: 'm1', name: 'M1' }],
    };

    const forbiddenHeaderNames = [
      'Host',
      'host',
      'Authorization',
      'authorization',
      'Proxy-Authorization',
      'Cookie',
      'Content-Length',
      'Transfer-Encoding',
      'Connection',
      'Upgrade',
      'TE',
      'Forwarded',
      'X-Forwarded-For',
      'x-forwarded-host',
      'X-Forwarded-Proto',
    ];

    for (const badHeader of forbiddenHeaderNames) {
      const check = validateProviderManifest({
        ...baseManifest,
        auth: {
          ...baseManifest.auth,
          extraHeaders: { [badHeader]: 'evil-value' },
        },
      });
      assert.equal(check.valid, false, `Expected forbidden extraHeader "${badHeader}" to be rejected`);
    }

    // Invalid RFC 9110 header name & CRLF/NUL in values and prefix
    assert.equal(
      validateProviderManifest({
        ...baseManifest,
        auth: { ...baseManifest.auth, extraHeaders: { 'Bad Header': 'val' } },
      }).valid,
      false,
    );
    assert.equal(
      validateProviderManifest({
        ...baseManifest,
        auth: { ...baseManifest.auth, extraHeaders: { 'X-Custom': 'ok\r\nX-Injected: 1' } },
      }).valid,
      false,
    );
    assert.equal(
      validateProviderManifest({
        ...baseManifest,
        auth: { ...baseManifest.auth, extraHeaders: { 'X-Custom': 'ok\0bad' } },
      }).valid,
      false,
    );
    assert.equal(
      validateProviderManifest({
        ...baseManifest,
        auth: { ...baseManifest.auth, prefix: 'Bearer \r\nEvil: 1' },
      }).valid,
      false,
    );
    assert.equal(
      validateProviderManifest({
        ...baseManifest,
        auth: { ...baseManifest.auth, header: 'Auth Header' },
      }).valid,
      false,
    );

    // Valid custom extraHeaders pass validation
    assert.equal(
      validateProviderManifest({
        ...baseManifest,
        auth: {
          ...baseManifest.auth,
          extraHeaders: { 'HTTP-Referer': 'https://bifrost.example.com', 'X-Title': 'Bifrost' },
        },
      }).valid,
      true,
    );

    // Runtime defense-in-depth: buildProviderAuthHeaders strips forbidden/CRLF headers and never duplicates keys
    const built = buildProviderAuthHeaders(
      {
        type: 'bearer',
        header: 'Authorization',
        prefix: 'Bearer ',
        extraHeaders: {
          Host: 'evil.example',
          authorization: 'Bearer stolen',
          Cookie: 'session=abc',
          'X-Forwarded-For': '127.0.0.1',
          'X-Injected': 'line1\r\nX-Evil: 2',
          'content-type': 'text/plain',
          'accept-encoding': 'gzip',
          'X-Title': 'Bifrost',
        },
      },
      'real-secret-value',
    );

    assert.equal(built.Host, undefined);
    assert.equal(built.Cookie, undefined);
    assert.equal(built['X-Forwarded-For'], undefined);
    assert.equal(built['X-Injected'], undefined);
    assert.equal(built.Authorization, 'Bearer real-secret-value');
    assert.equal(built['X-Title'], 'Bifrost');

    // Merge overrides case-insensitively without duplicates
    const merged = mergeHeadersCaseInsensitive(built, {
      'Content-Type': 'application/json',
      'Accept-Encoding': 'identity',
    });
    const lowerKeys = Object.keys(merged).map((k) => k.toLowerCase());
    assert.equal(new Set(lowerKeys).size, lowerKeys.length, 'Merged headers must have no case-insensitive duplicates');
    assert.equal(merged['Content-Type'], 'application/json');
    assert.equal(merged['Accept-Encoding'], 'identity');
    assert.equal(merged['content-type'], undefined);
    assert.equal(merged['accept-encoding'], undefined);
  });

  it('4. POST /api/nodes blocks IMDS (169.254.169.254, 192.0.0.192, 100.100.100.200, fd00:ec2::254), 0.0.0.0/8, link-local, and enforces mode constraints', async () => {
    const tmpDir = makeTempDir();
    const { key: masterKey } = resolveMasterKey({ dataDir: tmpDir, envMasterKey: '' });
    const db = openDatabase(path.join(tmpDir, 'nodes-ssrf.db'));
    try {
      const app = createApp({
        db,
        masterKey,
        allowLoopbackNodes: false,
      });
      const adminCookie = await setupAdmin(app);

      const alwaysBlockedEndpoints = [
        '169.254.169.254:80',
        '192.0.0.192:80',
        '100.100.100.200:80',
        '[fd00:ec2::254]:80',
        '0.0.0.0:9443',
        '[fe80::1]:9443',
        'metadata.google.internal:80',
        '127.0.0.1:9443',
        'localhost:9443',
      ];

      for (const mode of ['tailscale', 'public_ip'] as const) {
        for (const ep of alwaysBlockedEndpoints) {
          const res = await app.request('http://localhost/api/nodes', {
            method: 'POST',
            headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: `Bad-${mode}`, mode, endpoint: ep }),
          });
          assert.equal(res.status, 400, `Expected 400 for mode=${mode} endpoint=${ep}`);
        }
      }

      // Tailscale mode rejects RFC1918, public IP, single-label; accepts 100.64.0.0/10 and .ts.net
      for (const badTs of ['10.0.0.5:9443', '192.168.1.20:9443', '8.8.8.8:9443', 'watchtower:9443']) {
        const res = await app.request('http://localhost/api/nodes', {
          method: 'POST',
          headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Bad TS', mode: 'tailscale', endpoint: badTs }),
        });
        assert.equal(res.status, 400, `Expected 400 for tailscale endpoint=${badTs}`);
      }

      const okTsIp = await app.request('http://localhost/api/nodes', {
        method: 'POST',
        headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Good TS IP', mode: 'tailscale', endpoint: '100.64.12.34:9443' }),
      });
      assert.equal(okTsIp.status, 201);

      const okTsDomain = await app.request('http://localhost/api/nodes', {
        method: 'POST',
        headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Good TS Domain',
          mode: 'tailscale',
          endpoint: 'exit-eu.tailnet123.ts.net:9443',
        }),
      });
      assert.equal(okTsDomain.status, 201);

      // public_ip mode rejects RFC1918, CGNAT, single-label; accepts public IP and multi-label domain
      for (const badPub of ['10.0.0.5:9443', '172.16.0.5:9443', '192.168.1.5:9443', '100.64.12.35:9443', 'watchtower:9443']) {
        const res = await app.request('http://localhost/api/nodes', {
          method: 'POST',
          headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Bad Pub', mode: 'public_ip', endpoint: badPub }),
        });
        assert.equal(res.status, 400, `Expected 400 for public_ip endpoint=${badPub}`);
      }

      const okPub = await app.request('http://localhost/api/nodes', {
        method: 'POST',
        headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Good Pub', mode: 'public_ip', endpoint: 'exit.example.com:9443' }),
      });
      assert.equal(okPub.status, 201);
    } finally {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('5. BF-02: POST /api/marketplace/update-installed returns 409 MANIFEST_SENSITIVE_CHANGE when baseUrl/auth changes with registered keys, and applies with confirmSensitiveChange: true', async () => {
    const tmpDir = makeTempDir();
    const { key: masterKey } = resolveMasterKey({ dataDir: tmpDir, envMasterKey: '' });
    const db = openDatabase(path.join(tmpDir, 'bf02.db'));
    try {

      let remoteManifest = {
        schemaVersion: '1.0' as const,
        id: 'acme-llm',
        name: 'Acme LLM v1',
        packageType: 'official-json' as const,
        baseUrl: 'https://api.acme-llm.example.com/v1',
        auth: { type: 'bearer' as const, header: 'Authorization', prefix: 'Bearer ' },
        modelsSource: 'static' as const,
        reviewedAt: '2026-11-20',
        staticModels: [{ id: 'acme-1', name: 'Acme 1' }],
      };

      const app = createApp({
        db,
        masterKey,
        marketplaceUrl: 'https://catalog.acme.example.com/index.json',
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              updatedAt: '2026-11-26T00:00:00Z',
              providers: [{ ...remoteManifest, approved: true }],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
      });
      const adminCookie = await setupAdmin(app);

      // Fetch catalog & install provider
      const mpRes = await app.request('http://localhost/api/marketplace?refresh=1', {
        headers: { Cookie: adminCookie },
      });
      assert.equal(mpRes.status, 200);

      const installRes = await app.request('http://localhost/api/marketplace/install', {
        method: 'POST',
        headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'acme-llm' }),
      });
      assert.equal(installRes.status, 201);

      // Without keys: changing baseUrl succeeds directly (no friction when no keys exist)
      remoteManifest = {
        ...remoteManifest,
        name: 'Acme LLM v1.1',
        baseUrl: 'https://v2.acme-llm.example.com/v1',
      };
      const updateNoKeysRes = await app.request('http://localhost/api/marketplace/update-installed', {
        method: 'POST',
        headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerId: 'acme-llm' }),
      });
      assert.equal(updateNoKeysRes.status, 200);

      // Register an API key
      const keyRes = await app.request('http://localhost/api/providers/acme-llm/keys', {
        method: 'POST',
        headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: 'Prod Key', secret: 'acme-secret-key-55667788' }),
      });
      assert.equal(keyRes.status, 201);

      // Metadata-only update with keys registered -> still succeeds (200) without confirmation
      remoteManifest = { ...remoteManifest, name: 'Acme LLM v1.2' };
      const updateMetaRes = await app.request('http://localhost/api/marketplace/update-installed', {
        method: 'POST',
        headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerId: 'acme-llm' }),
      });
      assert.equal(updateMetaRes.status, 200);

      // Sensitive change (baseUrl origin + auth.header) with keys registered -> 409 MANIFEST_SENSITIVE_CHANGE
      remoteManifest = {
        ...remoteManifest,
        name: 'Acme Hijacked v2',
        baseUrl: 'https://evil-exfil.example.com/v1',
        auth: { type: 'bearer', header: 'X-Custom-Auth', prefix: 'Token ' },
      };

      const blockedRes = await app.request('http://localhost/api/marketplace/update-installed', {
        method: 'POST',
        headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerId: 'acme-llm' }),
      });
      assert.equal(blockedRes.status, 409);
      const blockedBody = (await blockedRes.json()) as {
        code: string;
        requiresConfirmation: boolean;
        changes: Array<{ providerId: string; field: string }>;
        message: string;
      };
      assert.equal(blockedBody.code, 'MANIFEST_SENSITIVE_CHANGE');
      assert.equal(blockedBody.requiresConfirmation, true);
      const changedFields = blockedBody.changes.map((ch) => ch.field);
      assert.ok(changedFields.includes('baseUrl'));
      assert.ok(changedFields.includes('auth.header'));
      assert.ok(changedFields.includes('auth.prefix'));

      // Verify DB was NOT modified
      const rowBeforeConfirm = db
        .prepare(`SELECT schema_json FROM providers WHERE id = 'acme-llm'`)
        .get() as { schema_json: string };
      assert.equal(
        (JSON.parse(rowBeforeConfirm.schema_json) as { baseUrl: string }).baseUrl,
        'https://v2.acme-llm.example.com/v1',
      );

      // Re-submit with confirmSensitiveChange: true -> 200 & updated in DB
      const confirmedRes = await app.request('http://localhost/api/marketplace/update-installed', {
        method: 'POST',
        headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerId: 'acme-llm', confirmSensitiveChange: true }),
      });
      assert.equal(confirmedRes.status, 200);

      const rowAfterConfirm = db
        .prepare(`SELECT schema_json FROM providers WHERE id = 'acme-llm'`)
        .get() as { schema_json: string };
      assert.equal(
        (JSON.parse(rowAfterConfirm.schema_json) as { baseUrl: string }).baseUrl,
        'https://evil-exfil.example.com/v1',
      );
    } finally {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('6. BF-04: Literally redacts arbitrary-format API keys (and URL-encoded variants) in models-sync, router, and key test errors', async () => {
    const customSecret = 'custom-vendor-secret-99887766';
    const specialSecret = 'vendor/key+with=special&998877';

    // Unit check on redactSecretsInText
    const scrubbed = redactSecretsInText(
      `Upstream failed for ${customSecret} and encoded ${encodeURIComponent(specialSecret)}`,
      [customSecret, specialSecret, 'short'],
    );
    assert.ok(!scrubbed.includes(customSecret));
    assert.ok(!scrubbed.includes(encodeURIComponent(specialSecret)));
    assert.ok(scrubbed.includes('[REDACTED]'));

    const tmpDir = makeTempDir();
    const { key: masterKey } = resolveMasterKey({ dataDir: tmpDir, envMasterKey: '' });
    const db = openDatabase(path.join(tmpDir, 'bf04.db'));
    try {

      const app = createApp({
        db,
        masterKey,
        fetchImpl: async (input) => {
          const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
          if (url.endsWith('/models')) {
            throw new Error(
              `Connection rejected while presenting credential ${customSecret} (encoded=${encodeURIComponent(customSecret)})`,
            );
          }
          // /chat/completions and /embeddings return 401 JSON echoing the secret past offset 140
          const pad = 'x'.repeat(145);
          return new Response(
            JSON.stringify({
              error: {
                message: `Auth denied ${pad} rejected key ${customSecret} on upstream`,
              },
            }),
            { status: 401, headers: { 'Content-Type': 'application/json' } },
          );
        },
      });

      const adminCookie = await setupAdmin(app);

      const provRes = await app.request('http://localhost/api/providers', {
        method: 'POST',
        headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          schemaVersion: '1.0',
          id: 'bf04-vendor',
          name: 'BF04 Vendor',
          packageType: 'official-json',
          baseUrl: 'https://api.bf04-vendor.example.com/v1',
          auth: { type: 'header', header: 'X-Vendor-Key', prefix: '' },
          modelsSource: 'api',
          modelsEndpoint: '/models',
        }),
      });
      assert.equal(provRes.status, 201);

      const keyRes = await app.request('http://localhost/api/providers/bf04-vendor/keys', {
        method: 'POST',
        headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: 'Arbitrary Format Key', secret: customSecret }),
      });
      assert.equal(keyRes.status, 201);
      const { key } = (await keyRes.json()) as { key: { id: string } };

      // 6a. models-sync error redaction
      const detectRes = await app.request(
        'http://localhost/api/providers/bf04-vendor/detect-models',
        {
          method: 'POST',
          headers: { Cookie: adminCookie },
        },
      );
      assert.equal(detectRes.status, 502);
      const detectText = await detectRes.text();
      assert.ok(!detectText.includes(customSecret), `models-sync response leaked secret: ${detectText}`);
      assert.ok(detectText.includes('[REDACTED]'));

      // 6b. key test error redaction
      const testRes = await app.request(
        `http://localhost/api/providers/bf04-vendor/keys/${key.id}/test`,
        {
          method: 'POST',
          headers: { Cookie: adminCookie },
        },
      );
      const testText = await testRes.text();
      assert.ok(!testText.includes(customSecret), `key test response leaked secret: ${testText}`);

      // Reset key status to active for router check
      db.prepare(`UPDATE provider_keys SET status = 'active', last_error = NULL WHERE id = ?`).run(
        key.id,
      );
      db.prepare(
        `INSERT INTO models (full_id, provider_id, model_id, name, modalities_json, capabilities_json, is_free, first_seen_at, active)
         VALUES ('bf04-vendor/chat-1', 'bf04-vendor', 'chat-1', 'Chat 1', '{"input":["text"],"output":["text"]}', '{}', 1, 1700000000, 1)`,
      ).run();

      const internalKeyRes = await app.request('http://localhost/api/keys', {
        method: 'POST',
        headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'BF04 Internal Key' }),
      });
      const { rawKey } = (await internalKeyRes.json()) as { rawKey: string };

      // 6c. router (/v1/chat/completions) error redaction (including past slice boundary)
      const chatRes = await app.request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${rawKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'bf04-vendor/chat-1',
          messages: [{ role: 'user', content: 'hello' }],
        }),
      });
      const chatText = await chatRes.text();
      assert.ok(!chatText.includes(customSecret), `router response leaked secret: ${chatText}`);

      // Verify neither provider_keys.last_error nor system_logs contains the literal secret
      const keyRow = db
        .prepare(`SELECT last_error FROM provider_keys WHERE id = ?`)
        .get(key.id) as { last_error: string | null };
      assert.ok(
        !String(keyRow.last_error ?? '').includes(customSecret),
        `provider_keys.last_error leaked secret: ${String(keyRow.last_error)}`,
      );

      const allLogs = db
        .prepare(`SELECT message, meta_json FROM system_logs`)
        .all() as Array<{ message: string; meta_json: string | null }>;
      for (const row of allLogs) {
        assert.ok(!row.message.includes(customSecret), `system_logs.message leaked secret: ${row.message}`);
        assert.ok(
          !String(row.meta_json ?? '').includes(customSecret),
          `system_logs.meta_json leaked secret: ${String(row.meta_json)}`,
        );
      }
    } finally {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('7. B1: createPinnedLookup returns all validated IPs for Happy Eyeballs and safeFetch falls back from unreachable IPv6 to valid IPv4', async () => {
    // 7a. Direct unit verification that createPinnedLookup returns ALL approved records when all=true
    const lookup = createPinnedLookup(['2606:4700:4700::1111', '1.1.1.1', '1.0.0.1']);
    const allRecords = await new Promise<Array<{ address: string; family: number }>>(
      (resolve, reject) => {
        lookup('dualstack.example.com', { all: true }, (err, addresses) => {
          if (err) reject(err);
          else resolve(addresses as unknown as Array<{ address: string; family: number }>);
        });
      },
    );
    assert.deepEqual(allRecords, [
      { address: '2606:4700:4700::1111', family: 6 },
      { address: '1.1.1.1', family: 4 },
      { address: '1.0.0.1', family: 4 },
    ]);

    const singleRecord = await new Promise<{ address: string; family: number }>(
      (resolve, reject) => {
        lookup('dualstack.example.com', {}, (err, address, family) => {
          if (err) reject(err);
          else resolve({ address: String(address), family: Number(family) });
        });
      },
    );
    assert.deepEqual(singleRecord, { address: '2606:4700:4700::1111', family: 6 });

    // 7b. Live Happy Eyeballs fallback: IPv4-only server on 127.0.0.1 with dnsLookup returning [::1 (refused), 127.0.0.1 (reachable)]
    const srv = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ happyEyeballs: true }));
    });
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()));
    const addr = srv.address() as { port: number };
    try {
      const res = await safeFetch(
        `http://localhost:${addr.port}/eyeballs`,
        { method: 'GET' },
        {
          mode: 'official-json',
          allowLocalhostForTests: true,
          dnsLookup: async () => [
            { address: '::1', family: 6 },
            { address: '127.0.0.1', family: 4 },
          ],
        },
      );
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { happyEyeballs: true });
    } finally {
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
  });

  it('8. B2: POST /api/nodes (public_ip) rejects octal, hex, and short-form obfuscated IPv4 endpoints', async () => {
    const tmpDir = makeTempDir();
    const { key: masterKey } = resolveMasterKey({ dataDir: tmpDir, envMasterKey: '' });
    const db = openDatabase(path.join(tmpDir, 'nodes-obfuscated.db'));
    try {
      const app = createApp({
        db,
        masterKey,
        allowLoopbackNodes: false,
      });
      const adminCookie = await setupAdmin(app);

      const obfuscatedEndpoints = [
        '0251.0376.0251.0376:80',
        '0xa9.0xfe.0xa9.0xfe:80',
        '169.254.43518:80',
        '0300.0.0.0300:80',
        '192.0.192:80',
        '0177.0.0.1:9443',
      ];

      for (const ep of obfuscatedEndpoints) {
        const res = await app.request('http://localhost/api/nodes', {
          method: 'POST',
          headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'Obfuscated Node',
            mode: 'public_ip',
            endpoint: ep,
          }),
        });
        assert.equal(res.status, 400, `Expected 400 for obfuscated public_ip endpoint ${ep}`);
      }
    } finally {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('9. B3: safeFetch aborts cleanly when body hangs after headers AND handles HEAD/204 with Content-Encoding: gzip without crashing', async () => {
    const sockets = new Set<import('node:net').Socket>();
    const srv = http.createServer((req, res) => {
      if (req.url === '/hang-body') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.write('partial-chunk-');
        // Intentionally never call res.end() to simulate stalled upstream body
        return;
      }
      if (req.url === '/head-gzip') {
        res.writeHead(200, { 'Content-Encoding': 'gzip', 'Content-Type': 'application/json' });
        res.end();
        return;
      }
      if (req.url === '/no-content-gzip') {
        res.writeHead(204, { 'Content-Encoding': 'gzip' });
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    });
    srv.on('connection', (sock) => {
      sockets.add(sock);
      sock.once('close', () => sockets.delete(sock));
    });

    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()));
    const addr = srv.address() as { port: number };
    try {
      // B3(a): 200 OK followed by hanging body must abort cleanly via AbortSignal.timeout(150)
      const hangRes = await safeFetch(
        `http://127.0.0.1:${addr.port}/hang-body`,
        { method: 'GET', signal: AbortSignal.timeout(150) },
        { mode: 'official-json', allowLocalhostForTests: true },
      );
      assert.equal(hangRes.status, 200);
      await assert.rejects(() => hangRes.text());

      // B3(b): HEAD and 204 responses with Content-Encoding: gzip and empty body must complete cleanly without crashing Node
      const headRes = await safeFetch(
        `http://127.0.0.1:${addr.port}/head-gzip`,
        { method: 'HEAD' },
        { mode: 'official-json', allowLocalhostForTests: true },
      );
      assert.equal(headRes.status, 200);
      assert.equal(await headRes.text(), '');

      const noContentRes = await safeFetch(
        `http://127.0.0.1:${addr.port}/no-content-gzip`,
        { method: 'GET' },
        { mode: 'official-json', allowLocalhostForTests: true },
      );
      assert.equal(noContentRes.status, 204);
      assert.equal(await noContentRes.text(), '');
    } finally {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
  });

  it('10. B4 & #5 & #6: Rejects forbidden auth.header transport headers, double-dot trailing hostnames, and unsupported body types', async () => {
    // B4: auth.header forbidden transport/proxy headers rejected in schema and buildProviderAuthHeaders
    const baseManifest = {
      schemaVersion: '1.0' as const,
      id: 'b4-auth-header-test',
      name: 'B4 Auth Header Test',
      packageType: 'official-json' as const,
      baseUrl: 'https://api.example.com/v1',
      modelsSource: 'static' as const,
      reviewedAt: '2026-11-26',
      staticModels: [{ id: 'm1', name: 'M1' }],
    };

    for (const badAuthHeader of [
      'Content-Length',
      'Host',
      'Transfer-Encoding',
      'Proxy-Authorization',
      'Cookie',
      'Connection',
      'Upgrade',
      'TE',
      'Forwarded',
      'X-Forwarded-For',
      'x-forwarded-host',
    ]) {
      const check = validateProviderManifest({
        ...baseManifest,
        auth: { type: 'header', header: badAuthHeader, prefix: '' },
      });
      assert.equal(check.valid, false, `Expected auth.header="${badAuthHeader}" to be rejected`);

      const built = buildProviderAuthHeaders(
        { type: 'header', header: badAuthHeader, prefix: '' },
        'secret-123456',
      );
      assert.equal(
        Object.keys(built).some((k) => k.toLowerCase() === badAuthHeader.toLowerCase()),
        false,
        `buildProviderAuthHeaders must never emit forbidden auth.header "${badAuthHeader}"`,
      );
    }

    // Valid auth.header values ('Authorization' and 'X-Api-Key') still pass and emit properly
    assert.equal(
      validateProviderManifest({
        ...baseManifest,
        auth: { type: 'bearer', header: 'Authorization', prefix: 'Bearer ' },
      }).valid,
      true,
    );
    assert.equal(
      validateProviderManifest({
        ...baseManifest,
        auth: { type: 'header', header: 'X-Api-Key', prefix: '' },
      }).valid,
      true,
    );
    assert.equal(
      buildProviderAuthHeaders(
        { type: 'bearer', header: 'Authorization', prefix: 'Bearer ' },
        'tok-123456',
      ).Authorization,
      'Bearer tok-123456',
    );
    assert.equal(
      buildProviderAuthHeaders(
        { type: 'header', header: 'X-Api-Key', prefix: '' },
        'key-123456',
      )['X-Api-Key'],
      'key-123456',
    );

    // #5: Hostnames with empty DNS labels / multiple trailing dots blocked by SSRF
    for (const emptyLabelUrl of [
      'https://watchtower../v1',
      'https://metadata.internal../v1',
      'https://metadata.google.internal../computeMetadata/v1/',
      'https://foo..bar.example.com/v1',
    ]) {
      assert.throws(
        () => assertSafeUpstreamUrlSync(emptyLabelUrl, { mode: 'official-json' }),
        UpstreamSsrfError,
        `Expected empty-label URL ${emptyLabelUrl} to be blocked`,
      );
      await assert.rejects(
        () => assertSafeUpstreamUrl(emptyLabelUrl, { mode: 'official-json' }),
        UpstreamSsrfError,
        `Expected async empty-label URL ${emptyLabelUrl} to be blocked`,
      );
    }

    // #6: safeFetch supports Blob body and rejects unsupported body types explicitly instead of "[object ...]"
    let observedBody = '';
    const srv = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        observedBody = Buffer.concat(chunks).toString('utf8');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ len: observedBody.length }));
      });
    });
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()));
    const addr = srv.address() as { port: number };
    try {
      const blobRes = await safeFetch(
        `http://127.0.0.1:${addr.port}/blob`,
        { method: 'POST', body: new Blob(['hello-blob']) },
        { mode: 'official-json', allowLocalhostForTests: true },
      );
      assert.equal(blobRes.status, 200);
      assert.equal(observedBody, 'hello-blob');

      const unsupportedStream = new ReadableStream<Uint8Array>({
        start(c) {
          c.close();
        },
      });
      await assert.rejects(
        () =>
          safeFetch(
            `http://127.0.0.1:${addr.port}/stream`,
            { method: 'POST', body: unsupportedStream },
            { mode: 'official-json', allowLocalhostForTests: true },
          ),
        TypeError,
      );
    } finally {
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
  });
});

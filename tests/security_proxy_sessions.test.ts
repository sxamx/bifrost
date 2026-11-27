import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { createApp } from '../core/src/app.js';
import {
  DUMMY_SCRYPT_HASH,
  MAX_PASSWORD_LENGTH,
  MAX_USERNAME_LENGTH,
  hashPassword,
  resolveMasterKey,
  verifyPassword,
} from '../core/src/crypto.js';
import { openDatabase } from '../core/src/db.js';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-sec-ola2-'));
}

function extractSetCookie(res: Response): string {
  const setCookie = res.headers.get('set-cookie');
  assert.ok(setCookie, 'Expected Set-Cookie header');
  return setCookie;
}

function extractCookiePair(res: Response): string {
  return extractSetCookie(res).split(';')[0]!;
}

async function setupAdminAndGuest(
  app: ReturnType<typeof createApp>,
  db: ReturnType<typeof openDatabase>,
  nowSec = 1_700_000_000,
): Promise<{ adminCookie: string; guestCookie: string }> {
  const setupRes = await app.request('http://localhost/api/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'AdminStrongPassword123!' }),
  });
  assert.equal(setupRes.status, 201);
  const adminCookie = extractCookiePair(setupRes);

  const guestHash = await hashPassword('GuestStrongPassword123!');
  db.prepare(
    `INSERT INTO users (id, username, password_hash, role, daily_token_limit, quota_reset_mode, created_at)
     VALUES ('guest-ola2', 'guest_ola2', ?, 'guest', 5000, 'utc_midnight', ?)`,
  ).run(guestHash, nowSec);

  const guestLogin = await app.request('http://localhost/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'guest_ola2', password: 'GuestStrongPassword123!' }),
  });
  assert.equal(guestLogin.status, 200);
  const guestCookie = extractCookiePair(guestLogin);

  return { adminCookie, guestCookie };
}

describe('Ola 2 — Auth Rate-Limiting, Password/Body Limits & scrypt Hardening (SEC-04, DEEP-13, SEC-15)', () => {
  it('enforces sliding-window rate limits on login, setup, and invitation acceptance with 429 + Retry-After, and enforces password/username length & bodyLimit', async () => {
    const tmpDir = makeTempDir();
    let clockMs = Date.UTC(2026, 10, 26, 12, 0, 0);

    try {
      const { key: masterKey } = resolveMasterKey({ dataDir: tmpDir, envMasterKey: undefined });
      const db = openDatabase(path.join(tmpDir, 'bifrost.db'));
      const app = createApp({
        db,
        masterKey,
        trustProxy: true,
        now: () => clockMs,
        apiBodyLimitBytes: 16 * 1024, // 16 KiB for deterministic bodyLimit test
        authRateLimit: {
          windowMs: 60_000,
          loginMaxAttempts: 3,
          setupMaxAttempts: 2,
          inviteAcceptMaxAttempts: 2,
        },
      });

      // 1. Setup rejects password > 1024 chars and username > 64 chars
      const longSetupPw = await app.request('http://localhost/api/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.1' },
        body: JSON.stringify({ username: 'admin', password: 'A'.repeat(MAX_PASSWORD_LENGTH + 1) }),
      });
      assert.equal(longSetupPw.status, 400);

      const longSetupUser = await app.request('http://localhost/api/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.1' },
        body: JSON.stringify({ username: 'u'.repeat(MAX_USERNAME_LENGTH + 1), password: 'ValidPassword123!' }),
      });
      assert.equal(longSetupUser.status, 400);

      // 3rd setup attempt from same IP hits setupMaxAttempts=2 -> 429 + Retry-After
      const setupRateLimited = await app.request('http://localhost/api/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.1' },
        body: JSON.stringify({ username: 'admin', password: 'ValidPassword123!' }),
      });
      assert.equal(setupRateLimited.status, 429);
      const setupRetryAfter = Number(setupRateLimited.headers.get('retry-after'));
      assert.ok(Number.isInteger(setupRetryAfter) && setupRetryAfter >= 1);

      // Clean IP succeeds setup
      const setupOk = await app.request('http://localhost/api/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.2' },
        body: JSON.stringify({ username: 'admin', password: 'AdminStrongPassword123!' }),
      });
      assert.equal(setupOk.status, 201);
      const adminCookie = extractCookiePair(setupOk);

      // 2. Login rejects password.length > 1024 and username.length > 64 immediately with 400
      const oversizedLoginPw = await app.request('http://localhost/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.10' },
        body: JSON.stringify({ username: 'admin', password: 'x'.repeat(MAX_PASSWORD_LENGTH + 1) }),
      });
      assert.equal(oversizedLoginPw.status, 400);

      const oversizedLoginUser = await app.request('http://localhost/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.10' },
        body: JSON.stringify({ username: 'u'.repeat(MAX_USERNAME_LENGTH + 1), password: 'ValidPassword123!' }),
      });
      assert.equal(oversizedLoginUser.status, 400);

      // 3. Login rate-limiting (3 failed attempts -> 4th returns 429 + Retry-After)
      for (let i = 0; i < 3; i += 1) {
        const failRes = await app.request('http://localhost/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.10' },
          body: JSON.stringify({ username: 'admin', password: `wrong-password-${i}` }),
        });
        assert.equal(failRes.status, 401);
      }

      const blockedLogin = await app.request('http://localhost/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.10' },
        body: JSON.stringify({ username: 'admin', password: 'AdminStrongPassword123!' }),
      });
      assert.equal(blockedLogin.status, 429);
      const loginRetryAfter = Number(blockedLogin.headers.get('retry-after'));
      assert.ok(Number.isInteger(loginRetryAfter) && loginRetryAfter >= 1 && loginRetryAfter <= 60);

      // Per-username limit also blocks a different IP attempting the same locked username
      const blockedByUser = await app.request('http://localhost/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.99' },
        body: JSON.stringify({ username: 'admin', password: 'AdminStrongPassword123!' }),
      });
      assert.equal(blockedByUser.status, 429);

      // Non-existent user goes through dummy scrypt verification cleanly and returns 401
      const ghostLogin = await app.request('http://localhost/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.77' },
        body: JSON.stringify({ username: 'nonexistent_user', password: 'SomePassword123!' }),
      });
      assert.equal(ghostLogin.status, 401);

      // Advancing clock past sliding window lifts the rate limit
      clockMs += 61_000;
      const recoveredLogin = await app.request('http://localhost/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.10' },
        body: JSON.stringify({ username: 'admin', password: 'AdminStrongPassword123!' }),
      });
      assert.equal(recoveredLogin.status, 200);

      // 4. Invitation accept rate-limiting (inviteAcceptMaxAttempts = 2)
      for (let i = 0; i < 2; i += 1) {
        const badInvite = await app.request('http://localhost/api/invitations/bfi_fake_token/accept', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.55' },
          body: JSON.stringify({ username: 'guest_try', password: 'ValidPassword123!' }),
        });
        assert.equal(badInvite.status, 404);
      }
      const rateLimitedInvite = await app.request(
        'http://localhost/api/invitations/bfi_fake_token/accept',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.55' },
          body: JSON.stringify({ username: 'guest_try', password: 'ValidPassword123!' }),
        },
      );
      assert.equal(rateLimitedInvite.status, 429);
      assert.ok(Number(rateLimitedInvite.headers.get('retry-after')) >= 1);

      // 5. General /api/* bodyLimit rejects oversized JSON payloads with 413
      const hugePayloadRes = await app.request('http://localhost/api/keys', {
        method: 'POST',
        headers: {
          Cookie: adminCookie,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'k', padding: 'Z'.repeat(24 * 1024) }),
      });
      assert.equal(hugePayloadRes.status, 413);

      db.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('rejects out-of-range scrypt parameters (N, r, p, salt/hash lengths) in verifyPassword while validating good hashes', async () => {
    const validHash = await hashPassword('CorrectHorseBatteryStaple!');
    assert.equal(await verifyPassword('CorrectHorseBatteryStaple!', validHash), true);
    assert.equal(await verifyPassword('WrongPassword!', validHash), false);
    assert.equal(await verifyPassword('anything', DUMMY_SCRYPT_HASH), false);

    const validSalt = 'a'.repeat(32); // 16 bytes
    const validKey = 'b'.repeat(128); // 64 bytes

    const maliciousHashes: ReadonlyArray<{ label: string; hash: string }> = [
      { label: 'N too low (8192)', hash: `scrypt$8192$8$1$${validSalt}$${validKey}` },
      { label: 'N too high (131072)', hash: `scrypt$131072$8$1$${validSalt}$${validKey}` },
      { label: 'N extreme DoS (1048576)', hash: `scrypt$1048576$8$1$${validSalt}$${validKey}` },
      { label: 'N not power of 2 (20000)', hash: `scrypt$20000$8$1$${validSalt}$${validKey}` },
      { label: 'r = 0', hash: `scrypt$16384$0$1$${validSalt}$${validKey}` },
      { label: 'r > 16 (r = 32)', hash: `scrypt$16384$32$1$${validSalt}$${validKey}` },
      { label: 'p = 0', hash: `scrypt$16384$8$0$${validSalt}$${validKey}` },
      { label: 'p > 4 (p = 8)', hash: `scrypt$16384$8$8$${validSalt}$${validKey}` },
      { label: 'salt too short (8 bytes)', hash: `scrypt$16384$8$1$${'a'.repeat(16)}$${validKey}` },
      { label: 'salt too long (128 bytes)', hash: `scrypt$16384$8$1$${'a'.repeat(256)}$${validKey}` },
      { label: 'hash too short (16 bytes)', hash: `scrypt$16384$8$1$${validSalt}$${'b'.repeat(32)}` },
      { label: 'hash too long (256 bytes)', hash: `scrypt$16384$8$1$${validSalt}$${'b'.repeat(512)}` },
      { label: 'non-hex salt', hash: `scrypt$16384$8$1$${'z'.repeat(32)}$${validKey}` },
      { label: 'hex prefix N', hash: `scrypt$0x4000$8$1$${validSalt}$${validKey}` },
      { label: 'wrong prefix', hash: `argon2$16384$8$1$${validSalt}$${validKey}` },
    ];

    for (const { label, hash } of maliciousHashes) {
      const start = Date.now();
      const result = await verifyPassword('test-password', hash);
      const elapsedMs = Date.now() - start;
      assert.equal(result, false, `Expected verifyPassword to reject: ${label}`);
      assert.ok(elapsedMs < 200, `Rejection of "${label}" should be immediate, took ${elapsedMs}ms`);
    }

    // Over-length password rejected immediately
    assert.equal(await verifyPassword('x'.repeat(MAX_PASSWORD_LENGTH + 1), validHash), false);
  });
});

describe('Ola 2 — Reverse Proxy HTTPS (Caddy), Secure Cookies, CSRF & Security Headers (SEC-05, QA-12)', () => {
  it('honors BIFROST_TRUST_PROXY=true + X-Forwarded-Proto: https for Secure cookies, HSTS, and https:// node install command', async () => {
    const tmpDir = makeTempDir();
    const prevTrustProxy = process.env.BIFROST_TRUST_PROXY;
    const prevCookieSecure = process.env.BIFROST_COOKIE_SECURE;

    try {
      const { key: masterKey } = resolveMasterKey({ dataDir: tmpDir, envMasterKey: undefined });
      const db = openDatabase(path.join(tmpDir, 'bifrost.db'));
      process.env.BIFROST_TRUST_PROXY = 'true';
      delete process.env.BIFROST_COOKIE_SECURE;

      const app = createApp({ db, masterKey });

      // Setup behind Caddy HTTPS proxy
      const setupRes = await app.request('http://127.0.0.1:8080/api/setup', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Forwarded-Proto': 'https',
          'X-Forwarded-Host': 'bifrost.example.com',
        },
        body: JSON.stringify({ username: 'admin', password: 'AdminStrongPassword123!' }),
      });
      assert.equal(setupRes.status, 201);
      const setupSetCookie = extractSetCookie(setupRes);
      assert.match(setupSetCookie, /;\s*HttpOnly/i);
      assert.match(setupSetCookie, /;\s*Secure/i);
      assert.equal(
        setupRes.headers.get('strict-transport-security'),
        'max-age=31536000; includeSubDomains',
      );

      // Login behind Caddy HTTPS proxy also emits Secure cookie + HSTS
      const loginRes = await app.request('http://127.0.0.1:8080/api/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Forwarded-Proto': 'https',
          Host: 'bifrost.example.com',
        },
        body: JSON.stringify({ username: 'admin', password: 'AdminStrongPassword123!' }),
      });
      assert.equal(loginRes.status, 200);
      assert.match(extractSetCookie(loginRes), /;\s*Secure/i);
      assert.equal(
        loginRes.headers.get('strict-transport-security'),
        'max-age=31536000; includeSubDomains',
      );
      const adminCookie = extractCookiePair(loginRes);

      // POST /api/nodes generates https:// install-node.sh command using effective proxy origin
      const nodeRes = await app.request('http://127.0.0.1:8080/api/nodes', {
        method: 'POST',
        headers: {
          Cookie: adminCookie,
          'Content-Type': 'application/json',
          'X-Forwarded-Proto': 'https',
          'X-Forwarded-Host': 'bifrost.example.com',
        },
        body: JSON.stringify({
          name: 'Caddy Node 1',
          mode: 'tailscale',
          endpoint: '100.64.0.12:9443',
        }),
      });
      assert.equal(nodeRes.status, 201);
      const nodeBody = (await nodeRes.json()) as { installCommand: string };
      assert.ok(
        nodeBody.installCommand.includes('https://bifrost.example.com/install-node.sh'),
        `Expected https:// install command, got: ${nodeBody.installCommand}`,
      );

      // Logout behind HTTPS includes Secure on deletion cookie
      const logoutRes = await app.request('http://127.0.0.1:8080/api/auth/logout', {
        method: 'POST',
        headers: {
          Cookie: adminCookie,
          'X-Forwarded-Proto': 'https',
          'X-Forwarded-Host': 'bifrost.example.com',
        },
      });
      assert.equal(logoutRes.status, 200);
      assert.match(extractSetCookie(logoutRes), /;\s*Secure/i);

      // Without trustProxy, spoofed X-Forwarded-Proto: https MUST be ignored
      process.env.BIFROST_TRUST_PROXY = 'false';
      const untrustedRes = await app.request('http://localhost/api/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Forwarded-Proto': 'https',
          'X-Forwarded-Host': 'evil.example',
        },
        body: JSON.stringify({ username: 'admin', password: 'AdminStrongPassword123!' }),
      });
      assert.equal(untrustedRes.status, 200);
      assert.doesNotMatch(extractSetCookie(untrustedRes), /;\s*Secure/i);
      assert.equal(untrustedRes.headers.get('strict-transport-security'), null);

      db.close();
    } finally {
      if (prevTrustProxy === undefined) delete process.env.BIFROST_TRUST_PROXY;
      else process.env.BIFROST_TRUST_PROXY = prevTrustProxy;
      if (prevCookieSecure === undefined) delete process.env.BIFROST_COOKIE_SECURE;
      else process.env.BIFROST_COOKIE_SECURE = prevCookieSecure;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('blocks cross-origin and cross-site mutating cookie requests with 403 while allowing same-origin requests', async () => {
    const tmpDir = makeTempDir();
    try {
      const { key: masterKey } = resolveMasterKey({ dataDir: tmpDir, envMasterKey: undefined });
      const db = openDatabase(path.join(tmpDir, 'bifrost.db'));
      const app = createApp({ db, masterKey, trustProxy: true });
      const { adminCookie } = await setupAdminAndGuest(app, db);

      // Cross-origin Origin header -> 403
      const badOriginRes = await app.request('http://localhost/api/keys', {
        method: 'POST',
        headers: {
          Cookie: adminCookie,
          Origin: 'https://evil.example',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'Should fail' }),
      });
      assert.equal(badOriginRes.status, 403);

      // Sandbox / null Origin -> 403
      const nullOriginRes = await app.request('http://localhost/api/keys', {
        method: 'POST',
        headers: {
          Cookie: adminCookie,
          Origin: 'null',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'Should fail' }),
      });
      assert.equal(nullOriginRes.status, 403);

      // Cross-site Sec-Fetch-Site -> 403
      const crossSiteRes = await app.request('http://localhost/api/keys', {
        method: 'POST',
        headers: {
          Cookie: adminCookie,
          'Sec-Fetch-Site': 'cross-site',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'Should fail' }),
      });
      assert.equal(crossSiteRes.status, 403);

      // Same-origin request -> 201
      const sameOriginRes = await app.request('http://localhost/api/keys', {
        method: 'POST',
        headers: {
          Cookie: adminCookie,
          Origin: 'http://localhost',
          'Sec-Fetch-Site': 'same-origin',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'Legit Same-Origin Key' }),
      });
      assert.equal(sameOriginRes.status, 201);

      // Same-origin behind trusted HTTPS reverse proxy -> 201, scheme downgrade -> 403
      const proxySameOrigin = await app.request('http://127.0.0.1:8080/api/keys', {
        method: 'POST',
        headers: {
          Cookie: adminCookie,
          'X-Forwarded-Proto': 'https',
          'X-Forwarded-Host': 'panel.example.com',
          Origin: 'https://panel.example.com',
          'Sec-Fetch-Site': 'same-origin',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'Proxy Same-Origin Key' }),
      });
      assert.equal(proxySameOrigin.status, 201);

      const proxyWrongScheme = await app.request('http://127.0.0.1:8080/api/keys', {
        method: 'POST',
        headers: {
          Cookie: adminCookie,
          'X-Forwarded-Proto': 'https',
          'X-Forwarded-Host': 'panel.example.com',
          Origin: 'http://panel.example.com',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'Wrong Scheme Key' }),
      });
      assert.equal(proxyWrongScheme.status, 403);

      db.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('sets global HTTP security headers without overwriting stricter SVG CSP on /api/logos/:slug?format=svg', async () => {
    const tmpDir = makeTempDir();
    try {
      const { key: masterKey } = resolveMasterKey({ dataDir: tmpDir, envMasterKey: undefined });
      const db = openDatabase(path.join(tmpDir, 'bifrost.db'));
      const app = createApp({
        db,
        masterKey,
        fetchImpl: async () =>
          new Response('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h24v24z"/></svg>', {
            status: 200,
            headers: { 'content-type': 'image/svg+xml' },
          }),
      });
      const { adminCookie } = await setupAdminAndGuest(app, db);

      const healthRes = await app.request('http://localhost/api/health');
      assert.equal(healthRes.status, 200);
      assert.equal(healthRes.headers.get('x-frame-options'), 'DENY');
      assert.equal(healthRes.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(healthRes.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
      assert.equal(
        healthRes.headers.get('permissions-policy'),
        'camera=(), microphone=(), geolocation=()',
      );
      const csp = healthRes.headers.get('content-security-policy') ?? '';
      assert.match(csp, /default-src 'self'/);
      assert.match(csp, /frame-ancestors 'none'/);
      assert.match(csp, /object-src 'none'/);
      assert.match(csp, /base-uri 'self'/);
      assert.equal(healthRes.headers.get('strict-transport-security'), null);

      // Raw SVG endpoint preserves its stricter `default-src 'none'` CSP
      db.prepare(
        `INSERT INTO providers (id, name, package_type, models_source, schema_json, enabled, created_at)
         VALUES ('openrouter', 'OpenRouter', 'official-json', 'api', '{}', 1, 1700000000)`,
      ).run();
      const svgRes = await app.request('http://localhost/api/logos/openrouter?format=svg', {
        headers: { Cookie: adminCookie },
      });
      assert.equal(svgRes.status, 200);
      assert.equal(
        svgRes.headers.get('content-security-policy'),
        "default-src 'none'; style-src 'unsafe-inline'",
      );
      assert.equal(svgRes.headers.get('x-frame-options'), 'DENY');
      assert.equal(svgRes.headers.get('x-content-type-options'), 'nosniff');

      db.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('Ola 2 — RBAC on /api/marketplace, Sanitized app.onError & Bounded /api/logos/:slug (SEC-06, SEC-16, SEC-17)', () => {
  it('restricts GET /api/marketplace to admin (403 for guest, 200 for admin) while keeping /api/metrics/uptime and /api/metrics/speed accessible to guests', async () => {
    const tmpDir = makeTempDir();
    try {
      const { key: masterKey } = resolveMasterKey({ dataDir: tmpDir, envMasterKey: undefined });
      const db = openDatabase(path.join(tmpDir, 'bifrost.db'));
      const app = createApp({ db, masterKey });
      const { adminCookie, guestCookie } = await setupAdminAndGuest(app, db);

      const guestMarketplace = await app.request('http://localhost/api/marketplace', {
        headers: { Cookie: guestCookie },
      });
      assert.equal(guestMarketplace.status, 403);

      const adminMarketplace = await app.request('http://localhost/api/marketplace', {
        headers: { Cookie: adminCookie },
      });
      assert.equal(adminMarketplace.status, 200);

      // Explicit product decision: uptime & speed remain accessible to guests
      const guestUptime = await app.request('http://localhost/api/metrics/uptime', {
        headers: { Cookie: guestCookie },
      });
      assert.equal(guestUptime.status, 200);

      const guestSpeed = await app.request('http://localhost/api/metrics/speed', {
        headers: { Cookie: guestCookie },
      });
      assert.equal(guestSpeed.status, 200);

      db.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('catches unhandled errors via app.onError, redacts secrets in system_logs, and returns generic 500 JSON without leaking stack traces or DB internals', async () => {
    const tmpDir = makeTempDir();
    try {
      const { key: masterKey } = resolveMasterKey({ dataDir: tmpDir, envMasterKey: undefined });
      const db = openDatabase(path.join(tmpDir, 'bifrost.db'));
      const app = createApp({ db, masterKey });
      const { adminCookie } = await setupAdminAndGuest(app, db);

      // Trigger an unhandled exception on a real route containing a secret & DB column name
      const origPrepare = db.prepare.bind(db);
      let injectedBoom = false;
      (db as unknown as { prepare: typeof db.prepare }).prepare = ((sql: string) => {
        if (!injectedBoom && sql.includes("WHERE role = 'admin'")) {
          injectedBoom = true;
          throw new Error(
            'SQLITE_ERROR: no such column password_hash while using key sk-or-v1-supersecret1234567890abcdef',
          );
        }
        return origPrepare(sql);
      }) as typeof db.prepare;

      const boomRes = await app.request('http://localhost/api/status', {
        headers: { Cookie: adminCookie },
      });
      (db as unknown as { prepare: typeof db.prepare }).prepare = origPrepare;

      assert.equal(boomRes.status, 500);
      const boomText = await boomRes.text();
      assert.deepEqual(JSON.parse(boomText), { error: 'Internal server error.' });
      assert.equal(boomText.includes('password_hash'), false);
      assert.equal(boomText.includes('sk-or-v1-supersecret1234567890abcdef'), false);
      assert.equal(boomText.includes('SQLITE_ERROR'), false);
      assert.equal(boomRes.headers.get('x-frame-options'), 'DENY');

      // Verify system_logs recorded the error with the secret redacted
      const logRow = db
        .prepare(`SELECT message, meta_json FROM system_logs WHERE level = 'error' ORDER BY id DESC LIMIT 1`)
        .get() as { message: string; meta_json: string } | undefined;
      assert.ok(logRow, 'Expected unhandled error to be logged in system_logs');
      assert.equal(logRow.message.includes('sk-or-v1-supersecret1234567890abcdef'), false);
      assert.equal(logRow.meta_json.includes('sk-or-v1-supersecret1234567890abcdef'), false);

      // Even if SQLite itself is closed/broken, app.onError still returns clean 500 JSON without throwing
      db.close();
      const closedDbRes = await app.request('http://localhost/api/status');
      assert.equal(closedDbRes.status, 500);
      assert.deepEqual(await closedDbRes.json(), { error: 'Internal server error.' });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('prevents guests from triggering arbitrary remote fetches or external_cache bloat via unknown /api/logos/:slug slugs', async () => {
    const tmpDir = makeTempDir();
    let upstreamLogoCalls = 0;

    try {
      const { key: masterKey } = resolveMasterKey({ dataDir: tmpDir, envMasterKey: undefined });
      const db = openDatabase(path.join(tmpDir, 'bifrost.db'));
      const app = createApp({
        db,
        masterKey,
        fetchImpl: async () => {
          upstreamLogoCalls += 1;
          return new Response(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h12v12z"/></svg>',
            { status: 200, headers: { 'content-type': 'image/svg+xml' } },
          );
        },
      });
      const { guestCookie } = await setupAdminAndGuest(app, db);

      // Unknown random slugs must NOT call upstream fetch or populate external_cache
      for (const unknownSlug of ['random-attacker-slug-1', 'arbitrary-probe-999', 'x'.repeat(80)]) {
        const res = await app.request(`http://localhost/api/logos/${unknownSlug}`, {
          headers: { Cookie: guestCookie },
        });
        assert.equal(res.status, 200);
        const body = (await res.json()) as { hasLogo: boolean; svg: string | null };
        assert.equal(body.hasLogo, false);
        assert.equal(body.svg, null);
      }

      assert.equal(upstreamLogoCalls, 0, 'Unknown slugs must trigger zero remote fetches');
      const cacheCountRow = db
        .prepare(`SELECT COUNT(*) AS count FROM external_cache WHERE cache_key LIKE 'logo:%'`)
        .get() as { count: number | bigint };
      assert.equal(Number(cacheCountRow.count), 0, 'Unknown slugs must not bloat external_cache');

      // Known provider slug (installed provider) still fetches & caches properly
      db.prepare(
        `INSERT INTO providers (id, name, package_type, models_source, schema_json, enabled, created_at)
         VALUES ('groq', 'Groq', 'official-json', 'api', '{}', 1, 1700000000)`,
      ).run();
      const knownRes = await app.request('http://localhost/api/logos/groq', {
        headers: { Cookie: guestCookie },
      });
      assert.equal(knownRes.status, 200);
      const knownBody = (await knownRes.json()) as { hasLogo: boolean; svg: string | null };
      assert.equal(knownBody.hasLogo, true);
      assert.ok(knownBody.svg?.includes('<svg'));
      assert.equal(upstreamLogoCalls, 1);

      db.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, it } from 'node:test';

import { createApp } from '../core/src/app.js';
import { openDatabase } from '../core/src/db.js';
import {
  GITHUB_COMMITS_MAIN_URL,
  SystemUpdateError,
  UPDATE_CHECK_TTL_SEC,
  UPDATE_PHASE_STALE_TTL_MS,
  checkSystemUpdate,
  getCurrentUpdatePhase,
  isCommitUpToDate,
  resetUpdatePhaseForTests,
  triggerSystemUpdate,
  waitForBackgroundUpdateForTests,
  type SystemUpdatePhase,
  type SystemUpdateStatus,
} from '../core/src/update-checker.js';

function extractCookiePair(setCookieHeader: string | null): string {
  assert.ok(setCookieHeader, 'Expected Set-Cookie header');
  return setCookieHeader.split(';')[0]!;
}

function makeGitHubCommitResponse(sha: string, message = 'feat: update bifrost', date = '2026-11-21T16:00:00Z') {
  return new Response(
    JSON.stringify({
      sha,
      html_url: `https://github.com/sxamx/bifrost/commit/${sha}`,
      commit: {
        message: `${message}\n\nExtended body`,
        committer: { date },
      },
    }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    },
  );
}

describe('HU-41: System Update Checker & /api/system/update-status', () => {
  beforeEach(() => {
    resetUpdatePhaseForTests();
  });

  it('detects a new commit when latestCommit differs from currentCommit', async () => {
    const db = openDatabase(':memory:');
    let fetchCalls = 0;

    const status = await checkSystemUpdate({
      db,
      currentVersion: '1.0.0',
      currentCommit: '1111111',
      runtimeMode: 'native',
      nowMs: 1_700_000_000_000,
      fetchImpl: async (input, init) => {
        fetchCalls += 1;
        assert.equal(String(input), GITHUB_COMMITS_MAIN_URL);
        const headers = new Headers(init?.headers);
        assert.equal(headers.get('Accept'), 'application/vnd.github+json');
        assert.equal(headers.get('User-Agent'), 'Bifrost-Update-Checker');
        assert.ok(init?.signal, 'Expected AbortSignal timeout');
        return makeGitHubCommitResponse('abcdef1234567890abcdef1234567890abcdef12', 'feat: release v1.2');
      },
    });

    assert.equal(fetchCalls, 1);
    assert.equal(status.currentVersion, '1.0.0');
    assert.equal(status.currentCommit, '1111111');
    assert.equal(status.latestCommit, 'abcdef1234567890abcdef1234567890abcdef12');
    assert.equal(status.latestCommitMessage, 'feat: release v1.2');
    assert.equal(
      status.latestCommitUrl,
      'https://github.com/sxamx/bifrost/commit/abcdef1234567890abcdef1234567890abcdef12',
    );
    assert.equal(status.latestPublishedAt, '2026-11-21T16:00:00Z');
    assert.equal(status.updateAvailable, true);
    assert.equal(status.runtimeMode, 'native');
    assert.equal(status.checkedAt, 1_700_000_000_000);
    assert.equal(status.error, null);
  });

  it('handles short vs full SHA prefix matching cleanly and never false-positives when currentCommit is null', async () => {
    assert.equal(isCommitUpToDate('abcdef1', 'abcdef1234567890abcdef1234567890abcdef12'), true);
    assert.equal(isCommitUpToDate('abcdef1234567890abcdef1234567890abcdef12', 'abcdef1'), true);
    assert.equal(isCommitUpToDate('ABCDEF1', 'abcdef1234567890'), true);
    assert.equal(isCommitUpToDate('1234567', 'abcdef1234567890'), false);
    assert.equal(isCommitUpToDate(null, 'abcdef1234567890'), true);

    const db = openDatabase(':memory:');
    const upToDate = await checkSystemUpdate({
      db,
      currentCommit: 'abcdef1',
      forceRefresh: true,
      fetchImpl: async () => makeGitHubCommitResponse('abcdef1234567890abcdef1234567890abcdef12'),
    });
    assert.equal(upToDate.updateAvailable, false);
    assert.equal(upToDate.error, null);

    const unknownCommit = await checkSystemUpdate({
      db,
      currentCommit: null,
      forceRefresh: true,
      fetchImpl: async () => makeGitHubCommitResponse('9999999999999999999999999999999999999999'),
    });
    assert.equal(unknownCommit.currentCommit, null);
    assert.equal(unknownCommit.updateAvailable, false);
  });

  it('caches results in external_cache for 15 minutes (900s) and bypasses cache when forceRefresh is true', async () => {
    assert.equal(UPDATE_CHECK_TTL_SEC, 900);
    const db = openDatabase(':memory:');
    let fetchCalls = 0;
    const baseMs = 1_700_000_000_000;

    const mockFetch = async () => {
      fetchCalls += 1;
      return makeGitHubCommitResponse(`sha${fetchCalls}000000000000000000000000000000000000`);
    };

    const first = await checkSystemUpdate({
      db,
      currentCommit: '0000000',
      nowMs: baseMs,
      fetchImpl: mockFetch,
    });
    assert.equal(fetchCalls, 1);
    assert.equal(first.latestCommit, 'sha1000000000000000000000000000000000000');

    // Within 15 minutes -> cache hit
    const cached = await checkSystemUpdate({
      db,
      currentCommit: '0000000',
      nowMs: baseMs + (UPDATE_CHECK_TTL_SEC - 60) * 1000,
      fetchImpl: mockFetch,
    });
    assert.equal(fetchCalls, 1);
    assert.equal(cached.latestCommit, 'sha1000000000000000000000000000000000000');

    // forceRefresh -> bypasses cache
    const refreshed = await checkSystemUpdate({
      db,
      currentCommit: '0000000',
      nowMs: baseMs + 60_000,
      forceRefresh: true,
      fetchImpl: mockFetch,
    });
    assert.equal(fetchCalls, 2);
    assert.equal(refreshed.latestCommit, 'sha2000000000000000000000000000000000000');

    // After 15 minutes -> cache expired, fetches again
    const expired = await checkSystemUpdate({
      db,
      currentCommit: '0000000',
      nowMs: baseMs + 60_000 + UPDATE_CHECK_TTL_SEC * 1000,
      fetchImpl: mockFetch,
    });
    assert.equal(fetchCalls, 3);
    assert.equal(expired.latestCommit, 'sha3000000000000000000000000000000000000');
  });

  it('never throws on GitHub network or rate-limit errors and returns updateAvailable: false with error', async () => {
    const db = openDatabase(':memory:');

    const netErr = await checkSystemUpdate({
      db,
      currentCommit: '1111111',
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    assert.equal(netErr.updateAvailable, false);
    assert.equal(netErr.latestCommit, null);
    assert.match(netErr.error ?? '', /ECONNREFUSED/);

    const rateLimitErr = await checkSystemUpdate({
      db,
      currentCommit: '1111111',
      fetchImpl: async () => new Response('rate limit exceeded', { status: 403 }),
    });
    assert.equal(rateLimitErr.updateAvailable, false);
    assert.equal(rateLimitErr.latestCommit, null);
    assert.match(rateLimitErr.error ?? '', /403/);
  });

  it('enforces admin-only 403 for guests and 200 with ?refresh=1 support on GET /api/system/update-status', async () => {
    const db = openDatabase(':memory:');
    const masterKey = randomBytes(32);
    let githubCalls = 0;

    const app = createApp({
      db,
      masterKey,
      now: () => 1_700_000_000_000,
      fetchImpl: async (input) => {
        const url = String(input);
        if (url === GITHUB_COMMITS_MAIN_URL) {
          githubCalls += 1;
          return makeGitHubCommitResponse(`commit${githubCalls}abcdef1234567890`);
        }
        return new Response('not found', { status: 404 });
      },
    });

    // 1. Setup admin
    const setupRes = await app.request('http://localhost/api/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'adminPassword123!' }),
    });
    assert.equal(setupRes.status, 201);
    const adminCookie = extractCookiePair(setupRes.headers.get('set-cookie'));

    // 2. Create guest via invitation
    const invRes = await app.request('http://localhost/api/invitations', {
      method: 'POST',
      headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dailyTokenLimit: 10000,
        quotaResetMode: 'utc_midnight',
        allowedModels: ['*'],
      }),
    });
    assert.equal(invRes.status, 201);
    const invData = (await invRes.json()) as { token: string };

    const acceptRes = await app.request(`http://localhost/api/invitations/${invData.token}/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'guest_user', password: 'guestPassword123!' }),
    });
    assert.equal(acceptRes.status, 201);
    const guestCookie = extractCookiePair(acceptRes.headers.get('set-cookie'));

    // 3. Unauthenticated -> 401
    const unauthRes = await app.request('http://localhost/api/system/update-status');
    assert.equal(unauthRes.status, 401);

    // 4. Guest -> 403
    const guestRes = await app.request('http://localhost/api/system/update-status', {
      headers: { Cookie: guestCookie },
    });
    assert.equal(guestRes.status, 403);

    // 5. Admin -> 200 (fetches once)
    const adminRes1 = await app.request('http://localhost/api/system/update-status', {
      headers: { Cookie: adminCookie },
    });
    assert.equal(adminRes1.status, 200);
    const body1 = (await adminRes1.json()) as SystemUpdateStatus;
    assert.equal(githubCalls, 1);
    assert.equal(body1.latestCommit, 'commit1abcdef1234567890');
    assert.equal(body1.error, null);

    // 6. Admin cached -> still 1 call
    const adminRes2 = await app.request('http://localhost/api/system/update-status', {
      headers: { Cookie: adminCookie },
    });
    assert.equal(adminRes2.status, 200);
    const body2 = (await adminRes2.json()) as SystemUpdateStatus;
    assert.equal(githubCalls, 1);
    assert.equal(body2.latestCommit, 'commit1abcdef1234567890');

    // 7. Admin ?refresh=1 -> bypasses cache (2 calls)
    const adminRes3 = await app.request('http://localhost/api/system/update-status?refresh=1', {
      headers: { Cookie: adminCookie },
    });
    assert.equal(adminRes3.status, 200);
    const body3 = (await adminRes3.json()) as SystemUpdateStatus;
    assert.equal(githubCalls, 2);
    assert.equal(body3.latestCommit, 'commit2abcdef1234567890');
  });

  it('computes canAutoUpdate and executes triggerSystemUpdate in Watchtower and native modes', async () => {
    const db = openDatabase(':memory:');

    const dockerWithoutWt = await checkSystemUpdate({
      db,
      currentCommit: '1111111',
      runtimeMode: 'docker',
      watchtowerUrl: '',
      fetchImpl: async () => makeGitHubCommitResponse('2222222222222222222222222222222222222222'),
    });
    assert.equal(dockerWithoutWt.canAutoUpdate, false);

    const dockerWithWt = await checkSystemUpdate({
      db,
      currentCommit: '1111111',
      runtimeMode: 'docker',
      watchtowerUrl: 'http://watchtower:8080',
      forceRefresh: true,
      fetchImpl: async () => makeGitHubCommitResponse('2222222222222222222222222222222222222222'),
    });
    assert.equal(dockerWithWt.canAutoUpdate, true);

    // Watchtower trigger
    let wtCalledUrl = '';
    let wtAuthHeader = '';
    const wtRes = await triggerSystemUpdate({
      runtimeMode: 'docker',
      watchtowerUrl: 'http://watchtower:8080/',
      watchtowerToken: 'wt-secret-token',
      fetchImpl: async (input, init) => {
        wtCalledUrl = String(input);
        wtAuthHeader = new Headers(init?.headers).get('Authorization') ?? '';
        assert.equal(init?.method, 'POST');
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });
    assert.equal(wtRes.ok, true);
    assert.equal(wtRes.mode, 'watchtower');
    assert.equal(wtRes.restarting, true);
    await waitForBackgroundUpdateForTests();
    assert.equal(wtCalledUrl, 'http://watchtower:8080/v1/update');
    assert.equal(wtAuthHeader, 'Bearer wt-secret-token');

    // Unconfigured Docker throws 409
    resetUpdatePhaseForTests();
    await assert.rejects(
      () =>
        triggerSystemUpdate({
          runtimeMode: 'docker',
          watchtowerUrl: '',
        }),
      (err: unknown) => err instanceof SystemUpdateError && err.status === 409,
    );

    // Native mode runs git pull --ff-only && npm run build and schedules restart in background
    const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-core-update-'));
    fs.mkdirSync(path.join(tmpRepo, '.git'));
    const ran: Array<{ cmd: string; args: string[]; cwd: string }> = [];
    let restarted = false;
    try {
      const nativeRes = await triggerSystemUpdate({
        runtimeMode: 'native',
        watchtowerUrl: '',
        repoDir: tmpRepo,
        runCommand: async (cmd, args, cwd) => {
          ran.push({ cmd, args, cwd });
        },
        onRestart: () => {
          restarted = true;
        },
      });
      assert.equal(nativeRes.ok, true);
      assert.equal(nativeRes.mode, 'native');
      assert.equal(nativeRes.restarting, true);
      await waitForBackgroundUpdateForTests();
      assert.equal(restarted, true);
      assert.deepEqual(
        ran.map((r) => [r.cmd, ...r.args]),
        [
          ['git', 'pull', '--ff-only'],
          ['npm', 'run', 'build'],
        ],
      );
    } finally {
      fs.rmSync(tmpRepo, { recursive: true, force: true });
    }
  });

  it('handles POST /api/system/update (Watchtower mock, 403 for guest, 409 when unconfigured)', async () => {
    const db = openDatabase(':memory:');
    const masterKey = randomBytes(32);
    const watchtowerCalls: Array<{ url: string; auth: string | null }> = [];

    const app = createApp({
      db,
      masterKey,
      fetchImpl: async (input, init) => {
        const url = String(input);
        if (url === GITHUB_COMMITS_MAIN_URL) {
          return makeGitHubCommitResponse('ffffffffffffffffffffffffffffffffffffffff');
        }
        const auth = new Headers(init?.headers).get('Authorization');
        watchtowerCalls.push({ url, auth });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });

    // Setup admin + guest
    const setupRes = await app.request('http://localhost/api/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'adminPassword123!' }),
    });
    assert.equal(setupRes.status, 201);
    const adminCookie = extractCookiePair(setupRes.headers.get('set-cookie'));

    const invRes = await app.request('http://localhost/api/invitations', {
      method: 'POST',
      headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dailyTokenLimit: 10000,
        quotaResetMode: 'utc_midnight',
        allowedModels: ['*'],
      }),
    });
    const invData = (await invRes.json()) as { token: string };
    const acceptRes = await app.request(`http://localhost/api/invitations/${invData.token}/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'guest_user', password: 'guestPassword123!' }),
    });
    const guestCookie = extractCookiePair(acceptRes.headers.get('set-cookie'));

    // Unauthenticated -> 401
    const unauthRes = await app.request('http://localhost/api/system/update', { method: 'POST' });
    assert.equal(unauthRes.status, 401);

    // Guest -> 403
    const guestRes = await app.request('http://localhost/api/system/update', {
      method: 'POST',
      headers: { Cookie: guestCookie },
    });
    assert.equal(guestRes.status, 403);

    const prevRuntime = process.env.BIFROST_RUNTIME;
    const prevWtUrl = process.env.BIFROST_WATCHTOWER_URL;
    const prevWtToken = process.env.BIFROST_WATCHTOWER_TOKEN;

    try {
      // Docker without Watchtower -> 409
      process.env.BIFROST_RUNTIME = 'docker';
      delete process.env.BIFROST_WATCHTOWER_URL;
      delete process.env.BIFROST_WATCHTOWER_TOKEN;

      const unconfiguredRes = await app.request('http://localhost/api/system/update', {
        method: 'POST',
        headers: { Cookie: adminCookie },
      });
      assert.equal(unconfiguredRes.status, 409);

      // Docker with Watchtower -> 202 Accepted (non-blocking background update)
      process.env.BIFROST_WATCHTOWER_URL = 'http://watchtower.internal:8080';
      process.env.BIFROST_WATCHTOWER_TOKEN = 'wt-token-123';

      const okRes = await app.request('http://localhost/api/system/update', {
        method: 'POST',
        headers: { Cookie: adminCookie },
      });
      assert.equal(okRes.status, 202);
      const okJson = (await okRes.json()) as {
        ok: boolean;
        mode: string;
        message: string;
        restarting: boolean;
      };
      assert.equal(okJson.ok, true);
      assert.equal(okJson.mode, 'watchtower');
      assert.equal(okJson.restarting, true);
      await waitForBackgroundUpdateForTests();
      assert.equal(watchtowerCalls.length, 1);
      assert.equal(watchtowerCalls[0]!.url, 'http://watchtower.internal:8080/v1/update');
      assert.equal(watchtowerCalls[0]!.auth, 'Bearer wt-token-123');
    } finally {
      if (prevRuntime === undefined) delete process.env.BIFROST_RUNTIME;
      else process.env.BIFROST_RUNTIME = prevRuntime;
      if (prevWtUrl === undefined) delete process.env.BIFROST_WATCHTOWER_URL;
      else process.env.BIFROST_WATCHTOWER_URL = prevWtUrl;
      if (prevWtToken === undefined) delete process.env.BIFROST_WATCHTOWER_TOKEN;
      else process.env.BIFROST_WATCHTOWER_TOKEN = prevWtToken;
    }
  });

  it('handles POST /api/nodes/:id/update against a mock node HTTP server and enforces 403 for guests', async () => {
    const db = openDatabase(':memory:');
    const masterKey = randomBytes(32);
    const app = createApp({ db, masterKey });

    let receivedAuth = '';
    let receivedPath = '';
    const mockNodeServer = http.createServer((req, res) => {
      receivedAuth = String(req.headers.authorization ?? '');
      receivedPath = req.url ?? '';
      if (req.method === 'POST' && req.url === '/_bifrost/update') {
        const body = JSON.stringify({
          ok: true,
          restarting: true,
          message: 'Mock node updated and restarting.',
        });
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body).toString(),
        });
        res.end(body);
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => mockNodeServer.listen(0, '127.0.0.1', resolve));
    const addr = mockNodeServer.address() as { port: number };

    try {
      const setupRes = await app.request('http://localhost/api/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'adminPassword123!' }),
      });
      const adminCookie = extractCookiePair(setupRes.headers.get('set-cookie'));

      const invRes = await app.request('http://localhost/api/invitations', {
        method: 'POST',
        headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dailyTokenLimit: 10000,
          quotaResetMode: 'utc_midnight',
          allowedModels: ['*'],
        }),
      });
      const invData = (await invRes.json()) as { token: string };
      const acceptRes = await app.request(
        `http://localhost/api/invitations/${invData.token}/accept`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'guest_user', password: 'guestPassword123!' }),
        },
      );
      const guestCookie = extractCookiePair(acceptRes.headers.get('set-cookie'));

      // Register node
      const createNodeRes = await app.request('http://localhost/api/nodes', {
        method: 'POST',
        headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Update Test Node',
          mode: 'tailscale',
          endpoint: `127.0.0.1:${addr.port}`,
        }),
      });
      assert.equal(createNodeRes.status, 201);
      const createdNode = (await createNodeRes.json()) as {
        node: { id: string };
        rawToken: string;
      };

      // Guest -> 403
      const guestRes = await app.request(
        `http://localhost/api/nodes/${createdNode.node.id}/update`,
        {
          method: 'POST',
          headers: { Cookie: guestCookie },
        },
      );
      assert.equal(guestRes.status, 403);

      // Admin -> 200
      const adminRes = await app.request(
        `http://localhost/api/nodes/${createdNode.node.id}/update`,
        {
          method: 'POST',
          headers: { Cookie: adminCookie },
        },
      );
      assert.equal(adminRes.status, 200);
      const adminJson = (await adminRes.json()) as {
        ok: boolean;
        message: string;
        restarting: boolean;
      };
      assert.equal(adminJson.ok, true);
      assert.equal(adminJson.restarting, true);
      assert.equal(adminJson.message, 'Mock node updated and restarting.');
      assert.equal(receivedPath, '/_bifrost/update');
      assert.equal(receivedAuth, `Bearer ${createdNode.rawToken}`);
    } finally {
      await new Promise<void>((resolve) => mockNodeServer.close(() => resolve()));
    }
  });

  it('skips Watchtower and native rebuild when Core is already up-to-date', async () => {
    const db = openDatabase(':memory:');
    let watchtowerCalled = false;

    const wtRes = await triggerSystemUpdate({
      db,
      runtimeMode: 'docker',
      watchtowerUrl: 'http://watchtower.internal:8080',
      currentCommit: 'abc1234',
      fetchImpl: async (input) => {
        if (String(input) === GITHUB_COMMITS_MAIN_URL) {
          return makeGitHubCommitResponse('abc1234567890abcdef1234567890abcdef12345');
        }
        watchtowerCalled = true;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });
    assert.equal(wtRes.ok, true);
    assert.equal(wtRes.upToDate, true);
    assert.equal(wtRes.mode, 'watchtower');
    assert.equal(wtRes.restarting, false);
    assert.equal(wtRes.message, 'Bifrost is already on the latest version.');
    assert.equal(watchtowerCalled, false);

    const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-core-uptodate-'));
    fs.mkdirSync(path.join(tmpRepo, '.git'));
    const ran: string[] = [];
    let restarted = false;
    try {
      const nativeRes = await triggerSystemUpdate({
        db,
        runtimeMode: 'native',
        watchtowerUrl: '',
        repoDir: tmpRepo,
        currentCommit: 'abc1234',
        fetchImpl: async () => makeGitHubCommitResponse('abc1234567890abcdef1234567890abcdef12345'),
        runCommand: async (cmd) => {
          ran.push(cmd);
        },
        onRestart: () => {
          restarted = true;
        },
      });
      assert.equal(nativeRes.ok, true);
      assert.equal(nativeRes.upToDate, true);
      assert.equal(nativeRes.mode, 'native');
      assert.equal(nativeRes.restarting, false);
      assert.equal(ran.length, 0);
      assert.equal(restarted, false);
    } finally {
      fs.rmSync(tmpRepo, { recursive: true, force: true });
    }
  });

  it('persists node commit from /_bifrost/health and exposes commit + updateAvailable on GET /api/nodes', async () => {
    const db = openDatabase(':memory:');
    const masterKey = randomBytes(32);

    let nodeHealthCommit = '1111111';
    const mockNodeServer = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/_bifrost/health') {
        const body = JSON.stringify({
          ok: true,
          uptime_sec: 42,
          version: '0.1.0',
          commit: nodeHealthCommit,
          active_tunnels: 0,
        });
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body).toString(),
        });
        res.end(body);
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => mockNodeServer.listen(0, '127.0.0.1', resolve));
    const addr = mockNodeServer.address() as { port: number };

    try {
      const app = createApp({
        db,
        masterKey,
        fetchImpl: async (input) => {
          if (String(input) === GITHUB_COMMITS_MAIN_URL) {
            return makeGitHubCommitResponse('2222222222222222222222222222222222222222');
          }
          return new Response('not found', { status: 404 });
        },
      });

      const setupRes = await app.request('http://localhost/api/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'adminPassword123!' }),
      });
      const adminCookie = extractCookiePair(setupRes.headers.get('set-cookie'));

      // Populate external_cache with system_update_status (latestCommit = 2222222...)
      const statusRes = await app.request('http://localhost/api/system/update-status?refresh=1', {
        headers: { Cookie: adminCookie },
      });
      assert.equal(statusRes.status, 200);

      // Register node
      const createNodeRes = await app.request('http://localhost/api/nodes', {
        method: 'POST',
        headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Commit Check Node',
          mode: 'tailscale',
          endpoint: `127.0.0.1:${addr.port}`,
        }),
      });
      assert.equal(createNodeRes.status, 201);
      const createdNode = (await createNodeRes.json()) as { node: { id: string } };

      // Test connectivity -> persists last_commit = '1111111'
      const testRes = await app.request(
        `http://localhost/api/nodes/${createdNode.node.id}/test`,
        {
          method: 'POST',
          headers: { Cookie: adminCookie },
        },
      );
      assert.equal(testRes.status, 200);

      // GET /api/nodes -> commit='1111111', updateAvailable=true
      const listRes1 = await app.request('http://localhost/api/nodes', {
        headers: { Cookie: adminCookie },
      });
      assert.equal(listRes1.status, 200);
      const listJson1 = (await listRes1.json()) as {
        nodes: Array<{ id: string; commit: string | null; updateAvailable: boolean }>;
      };
      assert.equal(listJson1.nodes.length, 1);
      assert.equal(listJson1.nodes[0]!.commit, '1111111');
      assert.equal(listJson1.nodes[0]!.updateAvailable, true);

      // Node updates to '2222222', test connectivity again -> updateAvailable=false
      nodeHealthCommit = '2222222';
      const testRes2 = await app.request(
        `http://localhost/api/nodes/${createdNode.node.id}/test`,
        {
          method: 'POST',
          headers: { Cookie: adminCookie },
        },
      );
      assert.equal(testRes2.status, 200);

      const listRes2 = await app.request('http://localhost/api/nodes', {
        headers: { Cookie: adminCookie },
      });
      const listJson2 = (await listRes2.json()) as {
        nodes: Array<{ id: string; commit: string | null; updateAvailable: boolean }>;
      };
      assert.equal(listJson2.nodes[0]!.commit, '2222222');
      assert.equal(listJson2.nodes[0]!.updateAvailable, false);
    } finally {
      await new Promise<void>((resolve) => mockNodeServer.close(() => resolve()));
    }
  });

  it('HU-41: returns updateAvailable: null when node commit is null or latestCommit is unknown', async () => {
    const db = openDatabase(':memory:');
    const masterKey = randomBytes(32);

    const app = createApp({
      db,
      masterKey,
      currentCommit: '1111111',
      fetchImpl: async () => makeGitHubCommitResponse('2222222000000000000000000000000000000000'),
    });

    const setupRes = await app.request('http://localhost/api/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'adminPassword123!' }),
    });
    assert.equal(setupRes.status, 201);
    const adminCookie = extractCookiePair(setupRes.headers.get('set-cookie'));

    // Create a node without running /test (commit is null) and before any update check (latestCommit is null)
    const createRes = await app.request('http://localhost/api/nodes', {
      method: 'POST',
      headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Legacy Node Without Commit',
        mode: 'tailscale',
        endpoint: '100.64.0.99:9443',
      }),
    });
    assert.equal(createRes.status, 201);
    const created = (await createRes.json()) as {
      node: { id: string; commit: string | null; updateAvailable: boolean | null };
    };
    assert.equal(created.node.commit, null);
    assert.equal(created.node.updateAvailable, null);

    // GET /api/nodes before update check -> updateAvailable === null
    const listBeforeCheck = await app.request('http://localhost/api/nodes', {
      headers: { Cookie: adminCookie },
    });
    assert.equal(listBeforeCheck.status, 200);
    const listBeforeJson = (await listBeforeCheck.json()) as {
      nodes: Array<{ id: string; commit: string | null; updateAvailable: boolean | null }>;
    };
    assert.equal(listBeforeJson.nodes[0]!.commit, null);
    assert.equal(listBeforeJson.nodes[0]!.updateAvailable, null);

    // Populate latestCommit via update-status; node still has commit === null -> updateAvailable must STILL be null
    await app.request('http://localhost/api/system/update-status?refresh=1', {
      headers: { Cookie: adminCookie },
    });
    const listAfterCheck = await app.request('http://localhost/api/nodes', {
      headers: { Cookie: adminCookie },
    });
    const listAfterJson = (await listAfterCheck.json()) as {
      nodes: Array<{ id: string; commit: string | null; updateAvailable: boolean | null }>;
    };
    assert.equal(listAfterJson.nodes[0]!.commit, null);
    assert.equal(listAfterJson.nodes[0]!.updateAvailable, null);
  });

  it('exposes version and buildCommit on GET /api/health while preserving ok: true', async () => {
    const db = openDatabase(':memory:');
    const masterKey = randomBytes(32);
    const app = createApp({ db, masterKey });

    const prevCommit = process.env.BIFROST_BUILD_COMMIT;
    try {
      process.env.BIFROST_BUILD_COMMIT = 'deadbeef1234';
      const res = await app.request('http://localhost/api/health');
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        ok: boolean;
        version: string;
        buildCommit: string | null;
      };
      assert.equal(body.ok, true);
      assert.equal(typeof body.version, 'string');
      assert.ok(body.version.length > 0);
      assert.equal(body.buildCommit, 'deadbeef1234');
    } finally {
      if (prevCommit === undefined) delete process.env.BIFROST_BUILD_COMMIT;
      else process.env.BIFROST_BUILD_COMMIT = prevCommit;
    }
  });

  it('tracks live updatePhase transitions in triggerSystemUpdate (native + watchtower) and exposes them in checkSystemUpdate', async () => {
    const db = openDatabase(':memory:');

    // Starts idle
    assert.deepEqual(getCurrentUpdatePhase(), { phase: 'idle', message: null });

    const initialStatus = await checkSystemUpdate({
      db,
      currentCommit: '1111111',
      nowMs: 1_700_000_000_000,
      fetchImpl: async () => makeGitHubCommitResponse('2222222222222222222222222222222222222222'),
    });
    assert.equal(initialStatus.updatePhase, 'idle');
    assert.equal(initialStatus.updatePhaseMessage, null);

    // Native mode transitions: pulling -> building -> restarting
    const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-phase-native-'));
    fs.mkdirSync(path.join(tmpRepo, '.git'));
    const observedPhases: SystemUpdatePhase[] = [];

    try {
      const nativeStart = await triggerSystemUpdate({
        runtimeMode: 'native',
        watchtowerUrl: '',
        repoDir: tmpRepo,
        runCommand: async (cmd) => {
          observedPhases.push(getCurrentUpdatePhase().phase);
          if (cmd === 'git') {
            // Even a cached checkSystemUpdate reflects the live phase
            const cachedDuringPull = await checkSystemUpdate({
              db,
              currentCommit: '1111111',
              nowMs: 1_700_000_010_000,
              fetchImpl: async () => {
                throw new Error('should not hit network while cached');
              },
            });
            assert.equal(cachedDuringPull.updatePhase, 'pulling');
            assert.ok(cachedDuringPull.updatePhaseMessage);
          }
        },
        onRestart: () => {
          observedPhases.push(getCurrentUpdatePhase().phase);
        },
      });
      assert.equal(nativeStart.ok, true);
      assert.equal(nativeStart.restarting, true);
      await waitForBackgroundUpdateForTests();
      assert.deepEqual(observedPhases, ['pulling', 'building', 'restarting']);
      assert.equal(getCurrentUpdatePhase().phase, 'restarting');

      // Native failure in background -> transitions to error phase and releases lock
      resetUpdatePhaseForTests();
      const nativeFailStart = await triggerSystemUpdate({
        runtimeMode: 'native',
        watchtowerUrl: '',
        repoDir: tmpRepo,
        runCommand: async () => {
          throw new Error('merge conflict');
        },
      });
      assert.equal(nativeFailStart.ok, true);
      assert.equal(nativeFailStart.restarting, true);
      await waitForBackgroundUpdateForTests();
      assert.equal(getCurrentUpdatePhase().phase, 'error');
      assert.match(getCurrentUpdatePhase().message ?? '', /merge conflict/);
    } finally {
      fs.rmSync(tmpRepo, { recursive: true, force: true });
    }

    // Watchtower mode: sets restarting while triggering in background; if 200 OK returns
    // while process is still alive (no container restart), transitions to 'error' instead of sticking in 'restarting'
    resetUpdatePhaseForTests();
    let phaseDuringWtFetch: SystemUpdatePhase | null = null;
    let messageDuringWtFetch: string | null = null;
    const wtStart = await triggerSystemUpdate({
      runtimeMode: 'docker',
      watchtowerUrl: 'http://watchtower:8080',
      fetchImpl: async () => {
        const snap = getCurrentUpdatePhase();
        phaseDuringWtFetch = snap.phase;
        messageDuringWtFetch = snap.message;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });
    assert.equal(wtStart.ok, true);
    assert.equal(wtStart.restarting, true);
    await waitForBackgroundUpdateForTests();
    assert.equal(phaseDuringWtFetch, 'restarting');
    assert.equal(messageDuringWtFetch, 'Watchtower update triggered. Container is restarting…');
    assert.equal(getCurrentUpdatePhase().phase, 'error');
    assert.match(getCurrentUpdatePhase().message ?? '', /without restarting/i);

    // Watchtower connection reset (actual container restart in progress) stays 'restarting'
    // and auto-resets to 'idle' after UPDATE_PHASE_STALE_TTL_MS (180s) if the process somehow survives
    resetUpdatePhaseForTests();
    const wtInterruptStart = await triggerSystemUpdate({
      runtimeMode: 'docker',
      watchtowerUrl: 'http://watchtower:8080',
      fetchImpl: async () => {
        throw new Error('socket hang up ECONNRESET');
      },
    });
    assert.equal(wtInterruptStart.ok, true);
    await waitForBackgroundUpdateForTests();
    assert.equal(getCurrentUpdatePhase().phase, 'restarting');
    const afterTtl = getCurrentUpdatePhase(Date.now() + UPDATE_PHASE_STALE_TTL_MS + 1_000);
    assert.equal(afterTtl.phase, 'idle');
    assert.equal(afterTtl.message, null);

    // Watchtower unexpected error in background -> transitions to error phase and releases lock
    resetUpdatePhaseForTests();
    const wtFailStart = await triggerSystemUpdate({
      runtimeMode: 'docker',
      watchtowerUrl: 'http://watchtower:8080',
      fetchImpl: async () => new Response('bad gateway', { status: 502 }),
    });
    assert.equal(wtFailStart.ok, true);
    assert.equal(wtFailStart.restarting, true);
    await waitForBackgroundUpdateForTests();
    assert.equal(getCurrentUpdatePhase().phase, 'error');
    assert.match(getCurrentUpdatePhase().message ?? '', /502/);
  });

  it('returns 202 immediately without blocking, rejects concurrent triggers with 409, releases lock on background error, and returns 200 when upToDate', async () => {
    const db = openDatabase(':memory:');
    const masterKey = randomBytes(32);

    let resolveWatchtower!: (res: Response) => void;
    let rejectWatchtower!: (err: Error) => void;
    let watchtowerAttempt = 0;

    const app = createApp({
      db,
      masterKey,
      currentCommit: '1111111',
      fetchImpl: async (input) => {
        const url = String(input);
        if (url === GITHUB_COMMITS_MAIN_URL) {
          return makeGitHubCommitResponse('2222222222222222222222222222222222222222');
        }
        watchtowerAttempt += 1;
        if (watchtowerAttempt === 1) {
          return new Promise<Response>((resolve, reject) => {
            resolveWatchtower = resolve;
            rejectWatchtower = reject;
          });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });

    const setupRes = await app.request('http://localhost/api/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'adminPassword123!' }),
    });
    assert.equal(setupRes.status, 201);
    const adminCookie = extractCookiePair(setupRes.headers.get('set-cookie'));

    const prevRuntime = process.env.BIFROST_RUNTIME;
    const prevWtUrl = process.env.BIFROST_WATCHTOWER_URL;
    const prevCommit = process.env.BIFROST_BUILD_COMMIT;

    try {
      process.env.BIFROST_RUNTIME = 'docker';
      process.env.BIFROST_WATCHTOWER_URL = 'http://watchtower.internal:8080';
      process.env.BIFROST_BUILD_COMMIT = '1111111';

      // 1. First trigger returns 202 immediately even though Watchtower fetch is still pending
      const t0 = Date.now();
      const firstRes = await app.request('http://localhost/api/system/update', {
        method: 'POST',
        headers: { Cookie: adminCookie },
      });
      const elapsedMs = Date.now() - t0;
      assert.equal(firstRes.status, 202);
      assert.ok(elapsedMs < 1000, `Expected non-blocking 202 response, took ${elapsedMs}ms`);
      const firstJson = (await firstRes.json()) as {
        ok: boolean;
        upToDate: boolean;
        mode: string;
        restarting: boolean;
      };
      assert.equal(firstJson.ok, true);
      assert.equal(firstJson.upToDate, false);
      assert.equal(firstJson.mode, 'watchtower');
      assert.equal(firstJson.restarting, true);

      // 2. Concurrent second trigger while update is in flight -> 409 Conflict
      const secondRes = await app.request('http://localhost/api/system/update', {
        method: 'POST',
        headers: { Cookie: adminCookie },
      });
      assert.equal(secondRes.status, 409);

      // 3. Background Watchtower call fails with real network error -> phase becomes 'error' and lock is released
      rejectWatchtower(new Error('ENOTFOUND watchtower.internal'));
      await waitForBackgroundUpdateForTests();
      assert.equal(getCurrentUpdatePhase().phase, 'error');
      assert.match(getCurrentUpdatePhase().message ?? '', /ENOTFOUND/);

      // Because lock was released on error, a retry is now accepted with 202
      const retryRes = await app.request('http://localhost/api/system/update', {
        method: 'POST',
        headers: { Cookie: adminCookie },
      });
      assert.equal(retryRes.status, 202);
      await waitForBackgroundUpdateForTests();
      // Watchtower returned 200 OK without killing the process -> must NOT stay stuck in 'restarting'
      assert.equal(getCurrentUpdatePhase().phase, 'error');
      assert.match(getCurrentUpdatePhase().message ?? '', /GHCR|without restarting/i);

      // 4. When already up-to-date -> returns 200 OK with upToDate: true (no background restart)
      resetUpdatePhaseForTests();
      process.env.BIFROST_BUILD_COMMIT = '2222222';
      const upToDateRes = await app.request('http://localhost/api/system/update', {
        method: 'POST',
        headers: { Cookie: adminCookie },
      });
      assert.equal(upToDateRes.status, 200);
      const upToDateJson = (await upToDateRes.json()) as {
        ok: boolean;
        upToDate: boolean;
        restarting: boolean;
      };
      assert.equal(upToDateJson.ok, true);
      assert.equal(upToDateJson.upToDate, true);
      assert.equal(upToDateJson.restarting, false);

      // Silence unused variable lint if resolveWatchtower wasn't invoked
      assert.equal(typeof resolveWatchtower, 'function');
    } finally {
      if (prevRuntime === undefined) delete process.env.BIFROST_RUNTIME;
      else process.env.BIFROST_RUNTIME = prevRuntime;
      if (prevWtUrl === undefined) delete process.env.BIFROST_WATCHTOWER_URL;
      else process.env.BIFROST_WATCHTOWER_URL = prevWtUrl;
      if (prevCommit === undefined) delete process.env.BIFROST_BUILD_COMMIT;
      else process.env.BIFROST_BUILD_COMMIT = prevCommit;
    }
  });

  it('transitions phase out of restarting and releases lock after Watchtower 200 OK without restart so UI can retry', async () => {
    const db = openDatabase(':memory:');
    const masterKey = randomBytes(32);
    let wtCalls = 0;

    const app = createApp({
      db,
      masterKey,
      fetchImpl: async (input) => {
        if (String(input) === GITHUB_COMMITS_MAIN_URL) {
          return makeGitHubCommitResponse('2222222222222222222222222222222222222222');
        }
        wtCalls += 1;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });

    const setupRes = await app.request('http://localhost/api/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'adminPassword123!' }),
    });
    assert.equal(setupRes.status, 201);
    const adminCookie = extractCookiePair(setupRes.headers.get('set-cookie'));

    const prevRuntime = process.env.BIFROST_RUNTIME;
    const prevWtUrl = process.env.BIFROST_WATCHTOWER_URL;
    const prevCommit = process.env.BIFROST_BUILD_COMMIT;

    try {
      process.env.BIFROST_RUNTIME = 'docker';
      process.env.BIFROST_WATCHTOWER_URL = 'http://watchtower.internal:8080';
      process.env.BIFROST_BUILD_COMMIT = '1111111';

      // First Watchtower trigger completes with 200 OK without killing the process
      const firstRes = await app.request('http://localhost/api/system/update', {
        method: 'POST',
        headers: { Cookie: adminCookie },
      });
      assert.equal(firstRes.status, 202);
      await waitForBackgroundUpdateForTests();
      assert.equal(wtCalls, 1);

      // GET /api/system/update-status must NOT be stuck in 'restarting'
      const statusRes = await app.request('http://localhost/api/system/update-status', {
        headers: { Cookie: adminCookie },
      });
      assert.equal(statusRes.status, 200);
      const statusJson = (await statusRes.json()) as SystemUpdateStatus;
      assert.equal(statusJson.updatePhase, 'error');
      assert.match(statusJson.updatePhaseMessage ?? '', /without restarting/i);

      // Without calling resetUpdatePhaseForTests(), a subsequent POST must NOT return 409
      const secondRes = await app.request('http://localhost/api/system/update', {
        method: 'POST',
        headers: { Cookie: adminCookie },
      });
      assert.equal(secondRes.status, 202);
      await waitForBackgroundUpdateForTests();
      assert.equal(wtCalls, 2);
      assert.equal(getCurrentUpdatePhase().phase, 'error');
    } finally {
      if (prevRuntime === undefined) delete process.env.BIFROST_RUNTIME;
      else process.env.BIFROST_RUNTIME = prevRuntime;
      if (prevWtUrl === undefined) delete process.env.BIFROST_WATCHTOWER_URL;
      else process.env.BIFROST_WATCHTOWER_URL = prevWtUrl;
      if (prevCommit === undefined) delete process.env.BIFROST_BUILD_COMMIT;
      else process.env.BIFROST_BUILD_COMMIT = prevCommit;
    }
  });
});


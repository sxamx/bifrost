import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';

import { createApp } from '../core/src/app.js';
import { openDatabase } from '../core/src/db.js';
import {
  GITHUB_COMMITS_MAIN_URL,
  UPDATE_CHECK_TTL_SEC,
  checkSystemUpdate,
  isCommitUpToDate,
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

  it('caches results in external_cache for 6 hours and bypasses cache when forceRefresh is true', async () => {
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

    // Within 6 hours -> cache hit
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

    // After 6 hours -> cache expired, fetches again
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
});

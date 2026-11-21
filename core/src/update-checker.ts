import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { readExternalCache, writeExternalCache, type FetchLike } from './catalog/cache.js';

export const UPDATE_CHECK_CACHE_KEY = 'system_update_status';
export const UPDATE_CHECK_TTL_SEC = 21600; // 6 hours
export const GITHUB_COMMITS_MAIN_URL = 'https://api.github.com/repos/sxamx/bifrost/commits/main';

export interface SystemUpdateStatus {
  currentVersion: string;
  currentCommit: string | null;
  latestCommit: string | null;
  latestCommitMessage: string | null;
  latestCommitUrl: string | null;
  latestPublishedAt: string | null;
  updateAvailable: boolean;
  runtimeMode: 'docker' | 'native';
  checkedAt: number;
  error?: string | null;
}

export interface CheckSystemUpdateOptions {
  db: DatabaseSync;
  fetchImpl?: FetchLike;
  forceRefresh?: boolean;
  nowMs?: number;
  /** Optional overrides primarily for testing */
  currentCommit?: string | null;
  currentVersion?: string;
  runtimeMode?: 'docker' | 'native';
}

export function detectRuntimeMode(): 'docker' | 'native' {
  if (process.env.BIFROST_RUNTIME === 'docker') {
    return 'docker';
  }
  try {
    if (fs.existsSync('/.dockerenv')) {
      return 'docker';
    }
  } catch {
    // Ignore filesystem errors
  }
  return 'native';
}

export function detectCurrentVersion(): string {
  try {
    const pkgPath = path.resolve(import.meta.dirname, '../package.json');
    const raw = fs.readFileSync(pkgPath, 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    if (typeof parsed.version === 'string' && parsed.version.trim().length > 0) {
      return parsed.version.trim();
    }
  } catch {
    // Fallback below
  }
  return '1.0.0';
}

export function detectCurrentCommit(): string | null {
  const envCommit = process.env.BIFROST_BUILD_COMMIT?.trim();
  if (envCommit && envCommit.toLowerCase() !== 'unknown') {
    return envCommit;
  }

  try {
    const repoRoot = path.resolve(import.meta.dirname, '../..');
    if (fs.existsSync(path.join(repoRoot, '.git'))) {
      const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
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

export function isCommitUpToDate(currentCommit: string | null, latestCommit: string | null): boolean {
  if (!currentCommit || !latestCommit) {
    return true;
  }
  const current = currentCommit.trim().toLowerCase();
  const latest = latestCommit.trim().toLowerCase();
  if (!current || !latest) {
    return true;
  }
  return latest.startsWith(current) || current.startsWith(latest);
}

export async function checkSystemUpdate(
  options: CheckSystemUpdateOptions,
): Promise<SystemUpdateStatus> {
  const { db, forceRefresh = false } = options;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const nowMs = options.nowMs ?? Date.now();
  const nowSec = Math.floor(nowMs / 1000);

  const runtimeMode = options.runtimeMode ?? detectRuntimeMode();
  const currentVersion = options.currentVersion ?? detectCurrentVersion();
  const currentCommit =
    options.currentCommit !== undefined ? options.currentCommit : detectCurrentCommit();

  if (!forceRefresh) {
    try {
      const cached = readExternalCache<SystemUpdateStatus>(db, UPDATE_CHECK_CACHE_KEY);
      if (cached && nowSec - cached.fetchedAt < UPDATE_CHECK_TTL_SEC && cached.data) {
        return {
          ...cached.data,
          currentVersion,
          currentCommit,
          runtimeMode,
          updateAvailable:
            currentCommit && cached.data.latestCommit
              ? !isCommitUpToDate(currentCommit, cached.data.latestCommit)
              : false,
        };
      }
    } catch {
      // Ignore cache read/parse errors and fetch fresh
    }
  }

  try {
    const response = await fetchImpl(GITHUB_COMMITS_MAIN_URL, {
      method: 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'Bifrost-Update-Checker',
      },
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      return {
        currentVersion,
        currentCommit,
        latestCommit: null,
        latestCommitMessage: null,
        latestCommitUrl: null,
        latestPublishedAt: null,
        updateAvailable: false,
        runtimeMode,
        checkedAt: nowMs,
        error: `GitHub API returned HTTP ${response.status}`,
      };
    }

    const payload = (await response.json()) as {
      sha?: unknown;
      html_url?: unknown;
      commit?: {
        message?: unknown;
        committer?: { date?: unknown };
        author?: { date?: unknown };
      };
    };

    const latestCommit =
      typeof payload.sha === 'string' && payload.sha.trim().length > 0 ? payload.sha.trim() : null;
    const rawMsg =
      typeof payload.commit?.message === 'string' ? payload.commit.message.trim() : '';
    const latestCommitMessage = rawMsg.length > 0 ? rawMsg.split('\n')[0]!.trim() : null;
    const latestCommitUrl =
      typeof payload.html_url === 'string' && payload.html_url.trim().length > 0
        ? payload.html_url.trim()
        : null;
    const rawDate = payload.commit?.committer?.date ?? payload.commit?.author?.date;
    const latestPublishedAt =
      typeof rawDate === 'string' && rawDate.trim().length > 0 ? rawDate.trim() : null;

    const updateAvailable =
      currentCommit !== null && latestCommit !== null
        ? !isCommitUpToDate(currentCommit, latestCommit)
        : false;

    const result: SystemUpdateStatus = {
      currentVersion,
      currentCommit,
      latestCommit,
      latestCommitMessage,
      latestCommitUrl,
      latestPublishedAt,
      updateAvailable,
      runtimeMode,
      checkedAt: nowMs,
      error: null,
    };

    try {
      writeExternalCache(db, UPDATE_CHECK_CACHE_KEY, result, null, nowSec);
    } catch {
      // Non-fatal if cache write fails
    }

    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      currentVersion,
      currentCommit,
      latestCommit: null,
      latestCommitMessage: null,
      latestCommitUrl: null,
      latestPublishedAt: null,
      updateAvailable: false,
      runtimeMode,
      checkedAt: nowMs,
      error: message || 'Failed to check for updates',
    };
  }
}

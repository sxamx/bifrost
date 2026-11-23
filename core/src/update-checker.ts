import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';

import { readExternalCache, writeExternalCache, type FetchLike } from './catalog/cache.js';

const execFileAsync = promisify(execFile);

export const UPDATE_CHECK_CACHE_KEY = 'system_update_status';
export const UPDATE_CHECK_TTL_SEC = 900; // 15 minutes
export const GITHUB_COMMITS_MAIN_URL = 'https://api.github.com/repos/sxamx/bifrost/commits/main';

export type SystemUpdatePhase = 'idle' | 'pulling' | 'building' | 'restarting' | 'error';

export interface SystemUpdatePhaseState {
  phase: SystemUpdatePhase;
  message: string | null;
}

let currentUpdatePhase: SystemUpdatePhase = 'idle';
let currentUpdatePhaseMessage: string | null = null;
let updateInFlight = false;
let pendingBackgroundUpdate: Promise<void> | null = null;

function setUpdatePhase(phase: SystemUpdatePhase, message: string | null = null): void {
  currentUpdatePhase = phase;
  currentUpdatePhaseMessage = message;
}

export function getCurrentUpdatePhase(): SystemUpdatePhaseState {
  return {
    phase: currentUpdatePhase,
    message: currentUpdatePhaseMessage,
  };
}

export async function waitForBackgroundUpdateForTests(): Promise<void> {
  if (pendingBackgroundUpdate) {
    await pendingBackgroundUpdate;
  }
}

export function resetUpdatePhaseForTests(): void {
  currentUpdatePhase = 'idle';
  currentUpdatePhaseMessage = null;
  updateInFlight = false;
  pendingBackgroundUpdate = null;
}

export interface SystemUpdateStatus {
  currentVersion: string;
  currentCommit: string | null;
  latestCommit: string | null;
  latestCommitMessage: string | null;
  latestCommitUrl: string | null;
  latestPublishedAt: string | null;
  updateAvailable: boolean;
  canAutoUpdate: boolean;
  runtimeMode: 'docker' | 'native';
  checkedAt: number;
  updatePhase: SystemUpdatePhase;
  updatePhaseMessage: string | null;
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
  repoDir?: string;
  watchtowerUrl?: string;
}

export function defaultRepoDir(): string {
  return path.resolve(import.meta.dirname, '../..');
}

export function hasGitRepo(repoDir: string = defaultRepoDir()): boolean {
  try {
    return fs.existsSync(path.join(repoDir, '.git'));
  } catch {
    return false;
  }
}

export function computeCanAutoUpdate(
  runtimeMode: 'docker' | 'native',
  repoDir: string = defaultRepoDir(),
  watchtowerUrl: string | undefined = process.env.BIFROST_WATCHTOWER_URL,
): boolean {
  if (runtimeMode === 'docker') {
    return Boolean(watchtowerUrl && watchtowerUrl.trim().length > 0);
  }
  return hasGitRepo(repoDir);
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
  const repoDir = options.repoDir ?? defaultRepoDir();
  const canAutoUpdate = computeCanAutoUpdate(runtimeMode, repoDir, options.watchtowerUrl);
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
          canAutoUpdate,
          updateAvailable:
            currentCommit && cached.data.latestCommit
              ? !isCommitUpToDate(currentCommit, cached.data.latestCommit)
              : false,
          updatePhase: currentUpdatePhase,
          updatePhaseMessage: currentUpdatePhaseMessage,
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
        canAutoUpdate,
        runtimeMode,
        checkedAt: nowMs,
        updatePhase: currentUpdatePhase,
        updatePhaseMessage: currentUpdatePhaseMessage,
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
      canAutoUpdate,
      runtimeMode,
      checkedAt: nowMs,
      updatePhase: currentUpdatePhase,
      updatePhaseMessage: currentUpdatePhaseMessage,
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
      canAutoUpdate,
      runtimeMode,
      checkedAt: nowMs,
      updatePhase: currentUpdatePhase,
      updatePhaseMessage: currentUpdatePhaseMessage,
      error: message || 'Failed to check for updates',
    };
  }
}

export class SystemUpdateError extends Error {
  public readonly status: 409 | 500 | 502;

  constructor(message: string, status: 409 | 500 | 502) {
    super(message);
    this.name = 'SystemUpdateError';
    this.status = status;
  }
}

export interface TriggerSystemUpdateOptions {
  db?: DatabaseSync;
  fetchImpl?: FetchLike;
  runtimeMode?: 'docker' | 'native';
  watchtowerUrl?: string;
  watchtowerToken?: string;
  repoDir?: string;
  currentCommit?: string | null;
  runCommand?: (cmd: string, args: string[], cwd: string) => void | Promise<void>;
  onRestart?: () => void;
}

export interface TriggerSystemUpdateResult {
  ok: true;
  upToDate?: boolean;
  mode: 'watchtower' | 'native';
  message: string;
  restarting: boolean;
}

async function defaultRunCommand(cmd: string, args: string[], cwd: string): Promise<void> {
  await execFileAsync(cmd, args, { cwd, timeout: 120_000 });
}

export async function triggerSystemUpdate(
  options: TriggerSystemUpdateOptions = {},
): Promise<TriggerSystemUpdateResult> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const runtimeMode = options.runtimeMode ?? detectRuntimeMode();
  const watchtowerUrl = (options.watchtowerUrl ?? process.env.BIFROST_WATCHTOWER_URL ?? '').trim();
  const watchtowerToken = (
    options.watchtowerToken ??
    process.env.BIFROST_WATCHTOWER_TOKEN ??
    ''
  ).trim();
  const repoDir = options.repoDir ?? defaultRepoDir();

  const mode: 'watchtower' | 'native' | null =
    watchtowerUrl.length > 0
      ? 'watchtower'
      : runtimeMode === 'docker'
        ? null
        : hasGitRepo(repoDir)
          ? 'native'
          : null;

  if (!mode) {
    if (runtimeMode === 'docker') {
      throw new SystemUpdateError(
        'Watchtower is not configured. Set BIFROST_WATCHTOWER_URL (and BIFROST_WATCHTOWER_TOKEN) or enable the auto-update profile in docker-compose.yml.',
        409,
      );
    }
    throw new SystemUpdateError(
      'Auto-update is unavailable: not a git repository and Watchtower is not configured.',
      409,
    );
  }

  if (updateInFlight) {
    throw new SystemUpdateError('A system update is already in progress.', 409);
  }
  updateInFlight = true;

  if (options.db) {
    let status: SystemUpdateStatus;
    try {
      status = await checkSystemUpdate({
        db: options.db,
        fetchImpl,
        forceRefresh: true,
        runtimeMode,
        repoDir,
        watchtowerUrl,
        currentCommit: options.currentCommit,
      });
    } catch (err) {
      updateInFlight = false;
      throw err;
    }
    if (status.currentCommit && status.latestCommit && !status.updateAvailable) {
      updateInFlight = false;
      return {
        ok: true,
        upToDate: true,
        mode,
        message: 'Bifrost is already on the latest version.',
        restarting: false,
      };
    }
  }

  // Docker + Watchtower mode (or explicit BIFROST_WATCHTOWER_URL)
  if (mode === 'watchtower') {
    const endpoint = `${watchtowerUrl.replace(/\/+$/, '')}/v1/update`;
    const headers: Record<string, string> = {};
    if (watchtowerToken.length > 0) {
      headers.Authorization = `Bearer ${watchtowerToken}`;
    }

    setUpdatePhase('restarting', 'Watchtower update triggered. Container is restarting…');

    const task = (async () => {
      try {
        const response = await fetchImpl(endpoint, {
          method: 'POST',
          headers,
          signal: AbortSignal.timeout(45_000),
        });
        if (!response.ok) {
          const errMsg = `Watchtower returned HTTP ${response.status}`;
          setUpdatePhase('error', errMsg);
        }
      } catch (err) {
        const name = err instanceof Error ? err.name : '';
        const msg = err instanceof Error ? err.message : String(err);
        const isExpectedRestartInterrupt =
          name === 'TimeoutError' ||
          name === 'AbortError' ||
          /timeout|aborted|ECONNRESET|socket|closed/i.test(msg);
        if (!isExpectedRestartInterrupt) {
          const errMsg = `Failed to reach Watchtower at ${endpoint}: ${msg}`;
          setUpdatePhase('error', errMsg);
        }
      } finally {
        updateInFlight = false;
      }
    })();

    pendingBackgroundUpdate = task;
    void task.finally(() => {
      if (pendingBackgroundUpdate === task) {
        pendingBackgroundUpdate = null;
      }
    });

    return {
      ok: true,
      upToDate: false,
      mode: 'watchtower',
      message: 'Watchtower update triggered. Container is restarting with the latest image.',
      restarting: true,
    };
  }

  // Native mode: git pull --ff-only && npm run build + systemd restart (in background)
  const runCmd = options.runCommand ?? defaultRunCommand;
  setUpdatePhase('pulling', 'Pulling latest changes from GitHub…');

  const task = (async () => {
    try {
      await runCmd('git', ['pull', '--ff-only'], repoDir);
      setUpdatePhase('building', 'Building Core and Panel…');
      await runCmd('npm', ['run', 'build'], repoDir);
      setUpdatePhase('restarting', 'Updated repository and rebuilt Core. Restarting service…');

      if (options.onRestart) {
        options.onRestart();
      } else {
        const timer = setTimeout(() => process.exit(0), 500);
        timer.unref();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const errMsg = `Native update failed: ${msg}`;
      setUpdatePhase('error', errMsg);
    } finally {
      updateInFlight = false;
    }
  })();

  pendingBackgroundUpdate = task;
  void task.finally(() => {
    if (pendingBackgroundUpdate === task) {
      pendingBackgroundUpdate = null;
    }
  });

  return {
    ok: true,
    upToDate: false,
    mode: 'native',
    message: 'Update started in background. Pulling latest changes and rebuilding Core…',
    restarting: true,
  };
}

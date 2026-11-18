import { randomBytes, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { generateSessionToken, hashPassword, sha256Hex } from './crypto.js';
import { writeSystemLog } from './db.js';

export type QuotaResetMode = 'utc_midnight' | 'rolling_24h';

export class UserHttpError extends Error {
  public readonly status: 400 | 401 | 403 | 404 | 409 | 410;

  constructor(status: 400 | 401 | 403 | 404 | 409 | 410, message: string) {
    super(message);
    this.name = 'UserHttpError';
    this.status = status;
  }
}

export interface ManagedUserSummary {
  id: string;
  username: string;
  role: 'admin' | 'guest';
  dailyTokenLimit: number | null;
  quotaResetMode: QuotaResetMode;
  allowedModels: string[];
  usedTokensToday: number;
  createdAt: number;
}

export interface InvitationSummary {
  id: string;
  dailyTokenLimit: number;
  quotaResetMode: QuotaResetMode;
  allowedModels: string[];
  expiresAt: number;
  usedAt: number | null;
  createdBy: string;
  createdAt: number | null;
  status: 'pending' | 'used' | 'expired';
}

const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,64}$/;
const MODEL_ACCESS_PATTERN_RE = /^(\*|[a-zA-Z0-9._:-]+\/(\*|[a-zA-Z0-9._:@/-]+))$/;

function parseAllowedModelsJson(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
      .map((v) => v.trim());
  } catch {
    return [];
  }
}

function validateAndNormalizeAllowedModels(
  rawModels: unknown,
  requireNonEmpty: boolean,
): string[] {
  if (!Array.isArray(rawModels)) {
    throw new UserHttpError(400, '"allowedModels" must be an array of model identifiers.');
  }

  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const item of rawModels) {
    if (typeof item !== 'string') {
      throw new UserHttpError(400, 'Each entry in "allowedModels" must be a string.');
    }
    const trimmed = item.trim();
    if (!trimmed || trimmed.length > 200 || !MODEL_ACCESS_PATTERN_RE.test(trimmed)) {
      throw new UserHttpError(
        400,
        `Invalid model identifier "${trimmed}" in "allowedModels". Expected "provider/model", "provider/*", or "*".`,
      );
    }
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      deduped.push(trimmed);
    }
  }

  if (requireNonEmpty && deduped.length === 0) {
    throw new UserHttpError(
      400,
      '"allowedModels" must include at least one allowed model for guest invitations.',
    );
  }

  return deduped;
}

function computeUsedTokensForUser(
  db: DatabaseSync,
  userId: string,
  quotaResetMode: QuotaResetMode,
  nowSec: number,
): number {
  const windowStartSec =
    quotaResetMode === 'rolling_24h' ? nowSec - 86400 : Math.floor(nowSec / 86400) * 86400;

  const row = db
    .prepare(
      `SELECT COALESCE(SUM(prompt_tokens + completion_tokens + reasoning_tokens), 0) AS used_tokens
       FROM usage_logs
       WHERE user_id = ? AND created_at >= ?`,
    )
    .get(userId, windowStartSec) as { used_tokens: number | bigint } | undefined;

  return Number(row?.used_tokens ?? 0);
}

function formatManagedUser(
  db: DatabaseSync,
  row: Record<string, unknown>,
  nowSec: number,
): ManagedUserSummary {
  const id = String(row.id);
  const role: 'admin' | 'guest' = row.role === 'admin' ? 'admin' : 'guest';
  const quotaResetMode: QuotaResetMode =
    row.quota_reset_mode === 'rolling_24h' ? 'rolling_24h' : 'utc_midnight';
  const dailyTokenLimit =
    row.daily_token_limit === null || row.daily_token_limit === undefined
      ? null
      : Number(row.daily_token_limit);

  const accessRows = db
    .prepare(
      `SELECT model_full_id
       FROM user_model_access
       WHERE user_id = ?
       ORDER BY model_full_id ASC`,
    )
    .all(id) as Array<{ model_full_id: string }>;

  const allowedModels =
    role === 'admin' && accessRows.length === 0
      ? ['*']
      : accessRows.map((r) => String(r.model_full_id));

  return {
    id,
    username: String(row.username),
    role,
    dailyTokenLimit,
    quotaResetMode,
    allowedModels,
    usedTokensToday: computeUsedTokensForUser(db, id, quotaResetMode, nowSec),
    createdAt: Number(row.created_at),
  };
}

function formatInvitationRow(
  row: Record<string, unknown>,
  nowSec: number,
): InvitationSummary {
  const expiresAt = Number(row.expires_at);
  const usedAt =
    row.used_at === null || row.used_at === undefined ? null : Number(row.used_at);
  const createdAt =
    row.created_at === null || row.created_at === undefined ? null : Number(row.created_at);
  const quotaResetMode: QuotaResetMode =
    row.quota_reset_mode === 'rolling_24h' ? 'rolling_24h' : 'utc_midnight';

  const status: 'pending' | 'used' | 'expired' =
    usedAt !== null ? 'used' : expiresAt <= nowSec ? 'expired' : 'pending';

  return {
    id: String(row.id),
    dailyTokenLimit: Number(row.daily_token_limit),
    quotaResetMode,
    allowedModels: parseAllowedModelsJson(row.allowed_models_json),
    expiresAt,
    usedAt,
    createdBy: String(row.created_by),
    createdAt,
    status,
  };
}

export function listUsers(
  db: DatabaseSync,
  nowSec: number = Math.floor(Date.now() / 1000),
): ManagedUserSummary[] {
  const rows = db
    .prepare(
      `SELECT id, username, role, daily_token_limit, quota_reset_mode, created_at
       FROM users
       ORDER BY CASE WHEN role = 'admin' THEN 0 ELSE 1 END ASC, created_at ASC`,
    )
    .all() as Array<Record<string, unknown>>;

  return rows.map((row) => formatManagedUser(db, row, nowSec));
}

export function updateManagedUser(
  db: DatabaseSync,
  adminUserId: string,
  targetUserId: string,
  body: Record<string, unknown>,
  nowSec: number = Math.floor(Date.now() / 1000),
): ManagedUserSummary {
  const existing = db
    .prepare(
      `SELECT id, username, role, daily_token_limit, quota_reset_mode, created_at
       FROM users
       WHERE id = ?`,
    )
    .get(targetUserId) as Record<string, unknown> | undefined;

  if (!existing) {
    throw new UserHttpError(404, `User "${targetUserId}" not found.`);
  }

  let nextDailyTokenLimit: number | null =
    existing.daily_token_limit === null || existing.daily_token_limit === undefined
      ? null
      : Number(existing.daily_token_limit);

  if ('dailyTokenLimit' in body) {
    const rawLimit = body.dailyTokenLimit;
    if (rawLimit === null) {
      nextDailyTokenLimit = null;
    } else if (
      typeof rawLimit === 'number' &&
      Number.isInteger(rawLimit) &&
      rawLimit > 0 &&
      rawLimit <= 1_000_000_000
    ) {
      nextDailyTokenLimit = rawLimit;
    } else {
      throw new UserHttpError(
        400,
        '"dailyTokenLimit" must be null or a positive integer <= 1000000000.',
      );
    }
  }

  let nextQuotaResetMode: QuotaResetMode =
    existing.quota_reset_mode === 'rolling_24h' ? 'rolling_24h' : 'utc_midnight';

  if ('quotaResetMode' in body && body.quotaResetMode !== undefined) {
    if (body.quotaResetMode !== 'utc_midnight' && body.quotaResetMode !== 'rolling_24h') {
      throw new UserHttpError(
        400,
        '"quotaResetMode" must be either "utc_midnight" or "rolling_24h".',
      );
    }
    nextQuotaResetMode = body.quotaResetMode;
  }

  const hasAllowedModelsUpdate = 'allowedModels' in body && body.allowedModels !== undefined;
  const nextAllowedModels = hasAllowedModelsUpdate
    ? validateAndNormalizeAllowedModels(body.allowedModels, false)
    : null;

  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(
      `UPDATE users
       SET daily_token_limit = ?, quota_reset_mode = ?
       WHERE id = ?`,
    ).run(nextDailyTokenLimit, nextQuotaResetMode, targetUserId);

    if (nextAllowedModels !== null) {
      db.prepare(`DELETE FROM user_model_access WHERE user_id = ?`).run(targetUserId);
      const insertAccess = db.prepare(
        `INSERT INTO user_model_access (user_id, model_full_id) VALUES (?, ?)`,
      );
      for (const modelFullId of nextAllowedModels) {
        insertAccess.run(targetUserId, modelFullId);
      }
    }

    writeSystemLog(
      db,
      'info',
      'auth',
      `Admin updated user "${String(existing.username)}" quota and model permissions`,
      {
        updatedBy: adminUserId,
        targetUserId,
        dailyTokenLimit: nextDailyTokenLimit,
        quotaResetMode: nextQuotaResetMode,
        ...(nextAllowedModels !== null ? { allowedModels: nextAllowedModels } : {}),
      },
      nowSec,
    );

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  const updatedRow = db
    .prepare(
      `SELECT id, username, role, daily_token_limit, quota_reset_mode, created_at
       FROM users
       WHERE id = ?`,
    )
    .get(targetUserId) as Record<string, unknown>;

  return formatManagedUser(db, updatedRow, nowSec);
}

/**
 * HU-05 & Red-Team Hardening:
 * Deletes a managed user while:
 * 1) Preventing an admin from deleting their own account or deleting the last remaining admin.
 * 2) Revoking all active panel sessions and internal `sk-bf-...` API keys immediately.
 * 3) Preserving global historical `usage_logs` and `invitations.created_by` integrity without
 *    foreign-key constraint errors or altering 60-day provider uptime telemetry.
 */
export function deleteManagedUser(
  db: DatabaseSync,
  adminUserId: string,
  targetUserId: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): void {
  if (targetUserId === adminUserId) {
    throw new UserHttpError(400, 'Administrators cannot delete their own active account.');
  }

  const target = db
    .prepare(`SELECT id, username, role FROM users WHERE id = ?`)
    .get(targetUserId) as { id: string; username: string; role: string } | undefined;

  if (!target) {
    throw new UserHttpError(404, `User "${targetUserId}" not found.`);
  }

  if (target.role === 'admin') {
    const adminCountRow = db
      .prepare(`SELECT COUNT(*) AS count FROM users WHERE role = 'admin'`)
      .get() as { count: number | bigint } | undefined;
    if (Number(adminCountRow?.count ?? 0) <= 1) {
      throw new UserHttpError(400, 'Cannot delete the last administrator account.');
    }
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    // Re-point non-cascading foreign keys (`usage_logs.user_id` and `invitations.created_by`)
    // to the acting administrator so historical provider telemetry/uptime is 100% preserved.
    db.prepare(`UPDATE usage_logs SET user_id = ? WHERE user_id = ?`).run(
      adminUserId,
      targetUserId,
    );
    db.prepare(`UPDATE invitations SET created_by = ? WHERE created_by = ?`).run(
      adminUserId,
      targetUserId,
    );

    // Explicitly revoke and remove sessions, internal API keys, and model permissions.
    db.prepare(`DELETE FROM sessions WHERE user_id = ?`).run(targetUserId);
    db.prepare(`DELETE FROM internal_api_keys WHERE user_id = ?`).run(targetUserId);
    db.prepare(`DELETE FROM user_model_access WHERE user_id = ?`).run(targetUserId);
    db.prepare(`DELETE FROM users WHERE id = ?`).run(targetUserId);

    writeSystemLog(
      db,
      'info',
      'auth',
      `User "${target.username}" deleted and all credentials/sessions revoked`,
      {
        deletedBy: adminUserId,
        deletedUserId: target.id,
        deletedUsername: target.username,
        role: target.role,
      },
      nowSec,
    );

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function listInvitations(
  db: DatabaseSync,
  nowSec: number = Math.floor(Date.now() / 1000),
): InvitationSummary[] {
  const rows = db
    .prepare(
      `SELECT id, daily_token_limit, quota_reset_mode, allowed_models_json,
              expires_at, used_at, created_by, created_at
       FROM invitations
       ORDER BY COALESCE(created_at, expires_at) DESC, id DESC`,
    )
    .all() as Array<Record<string, unknown>>;

  return rows.map((row) => formatInvitationRow(row, nowSec));
}

export function createInvitation(
  db: DatabaseSync,
  adminUserId: string,
  body: Record<string, unknown>,
  requestOrigin: string | null,
  nowSec: number = Math.floor(Date.now() / 1000),
): {
  invitation: InvitationSummary;
  token: string;
  rawToken: string;
  inviteUrl: string;
  expiresAt: number;
} {
  const rawLimit = body.dailyTokenLimit;
  if (
    typeof rawLimit !== 'number' ||
    !Number.isInteger(rawLimit) ||
    rawLimit <= 0 ||
    rawLimit > 1_000_000_000
  ) {
    throw new UserHttpError(
      400,
      '"dailyTokenLimit" is required and must be a positive integer <= 1000000000.',
    );
  }

  let quotaResetMode: QuotaResetMode = 'utc_midnight';
  if (body.quotaResetMode !== undefined) {
    if (body.quotaResetMode !== 'utc_midnight' && body.quotaResetMode !== 'rolling_24h') {
      throw new UserHttpError(
        400,
        '"quotaResetMode" must be either "utc_midnight" or "rolling_24h".',
      );
    }
    quotaResetMode = body.quotaResetMode;
  }

  const allowedModels = validateAndNormalizeAllowedModels(body.allowedModels, true);

  let expiresInHours = 48;
  if (body.expiresInHours !== undefined) {
    if (
      typeof body.expiresInHours !== 'number' ||
      !Number.isFinite(body.expiresInHours) ||
      body.expiresInHours <= 0 ||
      body.expiresInHours > 720
    ) {
      throw new UserHttpError(
        400,
        '"expiresInHours" must be a positive number between 1 and 720 hours.',
      );
    }
    expiresInHours = body.expiresInHours;
  }

  const invitationId = randomUUID();
  const rawToken = `bfi_${randomBytes(32).toString('base64url')}`;
  const tokenHash = sha256Hex(rawToken);
  const expiresAt = nowSec + Math.max(1, Math.round(expiresInHours * 3600));
  const allowedModelsJson = JSON.stringify(allowedModels);

  db.prepare(
    `INSERT INTO invitations (
       id, token_hash, daily_token_limit, quota_reset_mode,
       allowed_models_json, expires_at, used_at, created_by, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
  ).run(
    invitationId,
    tokenHash,
    rawLimit,
    quotaResetMode,
    allowedModelsJson,
    expiresAt,
    adminUserId,
    nowSec,
  );

  writeSystemLog(
    db,
    'info',
    'auth',
    `Admin created single-use guest invitation (${rawLimit} tokens/day)`,
    {
      invitationId,
      createdBy: adminUserId,
      dailyTokenLimit: rawLimit,
      quotaResetMode,
      allowedModelsCount: allowedModels.length,
      expiresAt,
    },
    nowSec,
  );

  const cleanOrigin =
    requestOrigin && /^https?:\/\//i.test(requestOrigin)
      ? requestOrigin.replace(/\/+$/, '')
      : '';
  const inviteUrl = cleanOrigin
    ? `${cleanOrigin}/?invite=${encodeURIComponent(rawToken)}`
    : `/?invite=${encodeURIComponent(rawToken)}`;

  const row = db
    .prepare(
      `SELECT id, daily_token_limit, quota_reset_mode, allowed_models_json,
              expires_at, used_at, created_by, created_at
       FROM invitations
       WHERE id = ?`,
    )
    .get(invitationId) as Record<string, unknown>;

  return {
    invitation: formatInvitationRow(row, nowSec),
    token: rawToken,
    rawToken,
    inviteUrl,
    expiresAt,
  };
}

export async function acceptInvitation(
  db: DatabaseSync,
  rawTokenParam: string,
  body: Record<string, unknown>,
  sessionTtlSeconds: number,
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<{
  user: {
    id: string;
    username: string;
    role: 'guest';
    dailyTokenLimit: number;
    quotaResetMode: QuotaResetMode;
  };
  sessionToken: string;
  sessionExpiresAt: number;
}> {
  const rawToken = rawTokenParam.trim();
  if (!rawToken || rawToken.length > 256) {
    throw new UserHttpError(400, 'Invalid invitation token.');
  }

  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';

  if (!USERNAME_RE.test(username)) {
    throw new UserHttpError(
      400,
      'Username must be 3 to 64 characters and contain only letters, numbers, dots, underscores, or hyphens.',
    );
  }

  if (password.length < 8 || password.length > 1024) {
    throw new UserHttpError(
      400,
      'Password must be between 8 and 1024 characters long.',
    );
  }

  const tokenHash = sha256Hex(rawToken);

  // Fast pre-check before running expensive scrypt password hashing
  const preInvite = db
    .prepare(
      `SELECT id, daily_token_limit, quota_reset_mode, allowed_models_json, expires_at, used_at
       FROM invitations
       WHERE token_hash = ?`,
    )
    .get(tokenHash) as Record<string, unknown> | undefined;

  if (!preInvite) {
    throw new UserHttpError(404, 'Invitation not found or invalid.');
  }

  if (preInvite.used_at !== null && preInvite.used_at !== undefined) {
    throw new UserHttpError(410, 'This single-use invitation has already been used.');
  }

  if (Number(preInvite.expires_at) <= nowSec) {
    throw new UserHttpError(410, 'This invitation has expired.');
  }

  const existingUsername = db
    .prepare(`SELECT id FROM users WHERE username = ?`)
    .get(username) as { id: string } | undefined;
  if (existingUsername) {
    throw new UserHttpError(409, `Username "${username}" is already taken.`);
  }

  // Asynchronous scrypt hashing BEFORE opening the SQLite write transaction
  const passwordHash = await hashPassword(password);
  const userId = randomUUID();
  const sessionId = randomUUID();
  const { token: sessionToken, tokenHash: sessionTokenHash } = generateSessionToken();
  const sessionExpiresAt = nowSec + sessionTtlSeconds;

  let finalDailyLimit = 0;
  let finalResetMode: QuotaResetMode = 'utc_midnight';

  db.exec('BEGIN IMMEDIATE');
  try {
    const invite = db
      .prepare(
        `SELECT id, daily_token_limit, quota_reset_mode, allowed_models_json, expires_at, used_at
         FROM invitations
         WHERE token_hash = ?`,
      )
      .get(tokenHash) as Record<string, unknown> | undefined;

    if (!invite) {
      throw new UserHttpError(404, 'Invitation not found or invalid.');
    }

    if (invite.used_at !== null && invite.used_at !== undefined) {
      throw new UserHttpError(410, 'This single-use invitation has already been used.');
    }

    if (Number(invite.expires_at) <= nowSec) {
      throw new UserHttpError(410, 'This invitation has expired.');
    }

    const raceUsername = db
      .prepare(`SELECT id FROM users WHERE username = ?`)
      .get(username) as { id: string } | undefined;
    if (raceUsername) {
      throw new UserHttpError(409, `Username "${username}" is already taken.`);
    }

    const markUsed = db
      .prepare(
        `UPDATE invitations
         SET used_at = ?
         WHERE id = ? AND used_at IS NULL AND expires_at > ?`,
      )
      .run(nowSec, String(invite.id), nowSec);

    if (markUsed.changes !== 1) {
      throw new UserHttpError(410, 'This single-use invitation has already been used or expired.');
    }

    finalDailyLimit = Number(invite.daily_token_limit);
    finalResetMode =
      invite.quota_reset_mode === 'rolling_24h' ? 'rolling_24h' : 'utc_midnight';
    const allowedModels = parseAllowedModelsJson(invite.allowed_models_json);

    db.prepare(
      `INSERT INTO users (id, username, password_hash, role, daily_token_limit, quota_reset_mode, created_at)
       VALUES (?, ?, ?, 'guest', ?, ?, ?)`,
    ).run(userId, username, passwordHash, finalDailyLimit, finalResetMode, nowSec);

    const insertAccess = db.prepare(
      `INSERT OR IGNORE INTO user_model_access (user_id, model_full_id) VALUES (?, ?)`,
    );
    for (const modelFullId of allowedModels) {
      insertAccess.run(userId, modelFullId);
    }

    db.prepare(
      `INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(sessionId, userId, sessionTokenHash, sessionExpiresAt, nowSec);

    writeSystemLog(
      db,
      'info',
      'auth',
      `Guest user "${username}" registered via single-use invitation`,
      {
        userId,
        username,
        invitationId: String(invite.id),
        dailyTokenLimit: finalDailyLimit,
        quotaResetMode: finalResetMode,
      },
      nowSec,
    );

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return {
    user: {
      id: userId,
      username,
      role: 'guest',
      dailyTokenLimit: finalDailyLimit,
      quotaResetMode: finalResetMode,
    },
    sessionToken,
    sessionExpiresAt,
  };
}

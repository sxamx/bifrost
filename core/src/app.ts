import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import {
  generateInternalApiKey,
  generateSessionToken,
  hashPassword,
  sha256Hex,
  verifyPassword,
} from './crypto.js';
import { writeSystemLog } from './db.js';

const SESSION_COOKIE_NAME = 'bifrost_session';
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

export interface AuthUser {
  id: string;
  username: string;
  role: 'admin' | 'guest';
  dailyTokenLimit: number | null;
  quotaResetMode: 'utc_midnight' | 'rolling_24h';
  createdAt: number;
}

type AppEnv = {
  Variables: {
    user: AuthUser;
    sessionId: string;
    apiKeyId: string;
  };
};

export interface CreateAppOptions {
  db: DatabaseSync;
  masterKey: Buffer;
  panelDistDir?: string;
  now?: () => number;
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function openAiError(
  message: string,
  type: string,
  code: string,
  param: string | null = null,
  extra?: Record<string, unknown>,
) {
  return {
    error: {
      message,
      type,
      param,
      code,
      ...(extra ?? {}),
    },
    ...(extra ?? {}),
  };
}

function mapUserRow(row: Record<string, unknown>): AuthUser {
  return {
    id: String(row.id),
    username: String(row.username),
    role: row.role === 'admin' ? 'admin' : 'guest',
    dailyTokenLimit:
      row.daily_token_limit === null || row.daily_token_limit === undefined
        ? null
        : Number(row.daily_token_limit),
    quotaResetMode: row.quota_reset_mode === 'rolling_24h' ? 'rolling_24h' : 'utc_midnight',
    createdAt: Number(row.created_at),
  };
}

export function createApp(options: CreateAppOptions): Hono<AppEnv> {
  const { db, masterKey } = options;
  if (masterKey.length !== 32) {
    throw new Error('createApp requires a 32-byte masterKey Buffer.');
  }
  const now = options.now ?? (() => Date.now());
  const defaultPanelDistDir = path.resolve(import.meta.dirname, '../../panel/dist');
  const resolvedPanelDistDir = path.resolve(options.panelDistDir ?? defaultPanelDistDir);

  const app = new Hono<AppEnv>();

  const nowSeconds = () => Math.floor(now() / 1000);

  const isAdminInitialized = (): boolean => {
    const row = db
      .prepare(`SELECT COUNT(*) AS count FROM users WHERE role = 'admin'`)
      .get() as { count: number | bigint } | undefined;
    return Number(row?.count ?? 0) > 0;
  };

  // --- Public health & setup status routes ---

  app.get('/api/health', (c) => {
    return c.json({ ok: true });
  });

  app.get('/api/status', (c) => {
    return c.json({ initialized: isAdminInitialized() });
  });

  // --- Initial Admin Setup (HU-03) ---

  app.post('/api/setup', async (c) => {
    if (isAdminInitialized()) {
      return c.json({ error: 'Initial setup has already been completed.' }, 409);
    }

    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'Invalid JSON request body.' }, 400);
    }

    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';

    if (username.length < 3 || username.length > 64) {
      return c.json({ error: 'Username must be between 3 and 64 characters.' }, 400);
    }
    if (password.length < 8) {
      return c.json({ error: 'Password must be at least 8 characters.' }, 400);
    }

    const passwordHash = await hashPassword(password);
    const createdAt = nowSeconds();
    const userId = randomUUID();
    const sessionId = randomUUID();
    const { token, tokenHash } = generateSessionToken();
    const expiresAt = createdAt + SESSION_TTL_SECONDS;

    db.exec('BEGIN IMMEDIATE');
    try {
      if (isAdminInitialized()) {
        db.exec('ROLLBACK');
        return c.json({ error: 'Initial setup has already been completed.' }, 409);
      }

      db.prepare(
        `INSERT INTO users (id, username, password_hash, role, daily_token_limit, quota_reset_mode, created_at)
         VALUES (?, ?, ?, 'admin', NULL, 'utc_midnight', ?)`,
      ).run(userId, username, passwordHash, createdAt);

      db.prepare(
        `INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(sessionId, userId, tokenHash, expiresAt, createdAt);

      writeSystemLog(
        db,
        'info',
        'auth',
        `Initial admin account "${username}" created`,
        { userId, username },
        createdAt,
      );

      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }

    setCookie(c, SESSION_COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: 'Lax',
      path: '/',
      maxAge: SESSION_TTL_SECONDS,
    });

    return c.json(
      {
        user: {
          id: userId,
          username,
          role: 'admin' as const,
        },
      },
      201,
    );
  });

  // --- Panel Session Authentication ---

  app.post('/api/auth/login', async (c) => {
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'Invalid JSON request body.' }, 400);
    }

    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';

    if (!username || !password) {
      return c.json({ error: 'Username and password are required.' }, 400);
    }

    const row = db
      .prepare(`SELECT * FROM users WHERE username = ?`)
      .get(username) as Record<string, unknown> | undefined;

    const nowSec = nowSeconds();
    if (!row || !(await verifyPassword(password, String(row.password_hash)))) {
      writeSystemLog(
        db,
        'warn',
        'auth',
        `Failed login attempt for username "${username}"`,
        { username },
        nowSec,
      );
      return c.json({ error: 'Invalid username or password.' }, 401);
    }

    const user = mapUserRow(row);
    const sessionId = randomUUID();
    const { token, tokenHash } = generateSessionToken();
    const expiresAt = nowSec + SESSION_TTL_SECONDS;

    db.prepare(
      `INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(sessionId, user.id, tokenHash, expiresAt, nowSec);

    writeSystemLog(
      db,
      'info',
      'auth',
      `User "${user.username}" logged in`,
      { userId: user.id, username: user.username },
      nowSec,
    );

    setCookie(c, SESSION_COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: 'Lax',
      path: '/',
      maxAge: SESSION_TTL_SECONDS,
    });

    return c.json({
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        dailyTokenLimit: user.dailyTokenLimit,
        quotaResetMode: user.quotaResetMode,
      },
    });
  });

  app.post('/api/auth/logout', (c) => {
    const rawToken = getCookie(c, SESSION_COOKIE_NAME);
    const nowSec = nowSeconds();

    if (rawToken) {
      const tokenHash = sha256Hex(rawToken);
      const sessionRow = db
        .prepare(`SELECT id, user_id FROM sessions WHERE token_hash = ?`)
        .get(tokenHash) as { id: string; user_id: string } | undefined;

      if (sessionRow) {
        db.prepare(`DELETE FROM sessions WHERE id = ?`).run(sessionRow.id);
        writeSystemLog(
          db,
          'info',
          'auth',
          'User logged out',
          { userId: sessionRow.user_id },
          nowSec,
        );
      }
    }

    deleteCookie(c, SESSION_COOKIE_NAME, {
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
    });

    return c.json({ ok: true });
  });

  // --- Session Middleware for protected /api/* routes ---

  app.use('/api/*', async (c, next) => {
    const pathname = c.req.path;
    if (
      pathname === '/api/health' ||
      pathname === '/api/status' ||
      pathname === '/api/setup' ||
      pathname === '/api/auth/login' ||
      pathname === '/api/auth/logout'
    ) {
      return next();
    }

    const rawToken = getCookie(c, SESSION_COOKIE_NAME);
    if (!rawToken) {
      return c.json({ error: 'Authentication required.' }, 401);
    }

    const tokenHash = sha256Hex(rawToken);
    const nowSec = nowSeconds();

    const row = db
      .prepare(
        `SELECT s.id AS session_id, s.expires_at,
                u.id, u.username, u.role, u.daily_token_limit, u.quota_reset_mode, u.created_at
         FROM sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ?`,
      )
      .get(tokenHash) as Record<string, unknown> | undefined;

    if (!row) {
      return c.json({ error: 'Authentication required.' }, 401);
    }

    if (Number(row.expires_at) <= nowSec) {
      db.prepare(`DELETE FROM sessions WHERE id = ?`).run(String(row.session_id));
      return c.json({ error: 'Session expired.' }, 401);
    }

    c.set('user', mapUserRow(row));
    c.set('sessionId', String(row.session_id));
    return next();
  });

  app.get('/api/auth/me', (c) => {
    const user = c.get('user');

    const providersRow = db
      .prepare(`SELECT COUNT(*) AS count FROM providers`)
      .get() as { count: number | bigint } | undefined;

    const modelsRow =
      user.role === 'admin'
        ? (db
            .prepare(
              `SELECT COUNT(*) AS count
               FROM models m
               JOIN providers p ON p.id = m.provider_id
               WHERE m.active = 1 AND p.enabled = 1`,
            )
            .get() as { count: number | bigint } | undefined)
        : (db
            .prepare(
              `SELECT COUNT(DISTINCT m.full_id) AS count
               FROM models m
               JOIN providers p ON p.id = m.provider_id
               JOIN user_model_access uma
                 ON uma.user_id = ?
                AND (uma.model_full_id = m.full_id OR uma.model_full_id = '*')
               WHERE m.active = 1 AND p.enabled = 1`,
            )
            .get(user.id) as { count: number | bigint } | undefined);

    const keysRow = db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM internal_api_keys
         WHERE user_id = ? AND revoked_at IS NULL`,
      )
      .get(user.id) as { count: number | bigint } | undefined;

    return c.json({
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        dailyTokenLimit: user.dailyTokenLimit,
        quotaResetMode: user.quotaResetMode,
      },
      stats: {
        providersCount: Number(providersRow?.count ?? 0),
        modelsCount: Number(modelsRow?.count ?? 0),
        keysCount: Number(keysRow?.count ?? 0),
      },
    });
  });

  // --- Installed Providers (HU-02 empty state check) ---

  app.get('/api/providers', (c) => {
    const rows = db
      .prepare(
        `SELECT p.id, p.name, p.package_type, p.models_source, p.adapter_url,
                p.enabled, p.last_models_sync_at, p.created_at,
                (SELECT COUNT(*) FROM provider_keys pk WHERE pk.provider_id = p.id) AS keys_count,
                (SELECT COUNT(*) FROM models m WHERE m.provider_id = p.id AND m.active = 1) AS models_count
         FROM providers p
         ORDER BY p.created_at ASC`,
      )
      .all() as Array<Record<string, unknown>>;

    const providers = rows.map((r) => ({
      id: String(r.id),
      name: String(r.name),
      packageType: String(r.package_type),
      modelsSource: String(r.models_source),
      adapterUrl: r.adapter_url === null ? null : String(r.adapter_url),
      enabled: Number(r.enabled) === 1,
      lastModelsSyncAt:
        r.last_models_sync_at === null ? null : Number(r.last_models_sync_at),
      createdAt: Number(r.created_at),
      keysCount: Number(r.keys_count ?? 0),
      modelsCount: Number(r.models_count ?? 0),
    }));

    return c.json({ providers });
  });

  // --- Internal API Keys sk-bf-... (HU-03b) ---

  app.get('/api/keys', (c) => {
    const user = c.get('user');
    const rows = db
      .prepare(
        `SELECT id, name, key_prefix, created_at, last_used_at
         FROM internal_api_keys
         WHERE user_id = ? AND revoked_at IS NULL
         ORDER BY created_at DESC`,
      )
      .all(user.id) as Array<Record<string, unknown>>;

    const keys = rows.map((r) => ({
      id: String(r.id),
      name: String(r.name),
      keyPrefix: String(r.key_prefix),
      createdAt: Number(r.created_at),
      lastUsedAt: r.last_used_at === null ? null : Number(r.last_used_at),
    }));

    return c.json({ keys });
  });

  app.post('/api/keys', async (c) => {
    const user = c.get('user');

    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'Invalid JSON request body.' }, 400);
    }

    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 100) {
      return c.json({ error: 'Key name must be between 1 and 100 characters.' }, 400);
    }

    const id = randomUUID();
    const createdAt = nowSeconds();
    const { rawKey, keyPrefix, keyHash } = generateInternalApiKey();

    db.prepare(
      `INSERT INTO internal_api_keys (id, user_id, name, key_prefix, key_hash, last_used_at, revoked_at, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)`,
    ).run(id, user.id, name, keyPrefix, keyHash, createdAt);

    writeSystemLog(
      db,
      'info',
      'auth',
      `Internal API key "${name}" (${keyPrefix}...) created`,
      { userId: user.id, keyId: id, keyPrefix },
      createdAt,
    );

    return c.json(
      {
        key: {
          id,
          name,
          keyPrefix,
          createdAt,
          lastUsedAt: null,
        },
        rawKey,
      },
      201,
    );
  });

  app.delete('/api/keys/:id', (c) => {
    const user = c.get('user');
    const keyId = c.req.param('id');
    const revokedAt = nowSeconds();

    const result = db
      .prepare(
        `UPDATE internal_api_keys
         SET revoked_at = ?
         WHERE id = ? AND user_id = ? AND revoked_at IS NULL`,
      )
      .run(revokedAt, keyId, user.id);

    if (result.changes === 0) {
      return c.json({ error: 'API key not found.' }, 404);
    }

    writeSystemLog(
      db,
      'info',
      'auth',
      `Internal API key revoked`,
      { userId: user.id, keyId },
      revokedAt,
    );

    return c.json({ ok: true });
  });

  app.all('/api/*', (c) => {
    return c.json({ error: 'Not Found' }, 404);
  });

  // --- OpenAI-Compatible API /v1/* (HU-03b) ---

  app.use('/v1/*', async (c, next) => {
    const authHeader = c.req.header('authorization') ?? '';
    const match = /^Bearer\s+(sk-bf-\S+)$/i.exec(authHeader.trim());
    if (!match) {
      return c.json(
        openAiError(
          'Missing or invalid Authorization header. Expected "Bearer sk-bf-...".',
          'invalid_request_error',
          'invalid_api_key',
        ),
        401,
      );
    }

    const rawKey = match[1];
    const keyHash = sha256Hex(rawKey);

    const row = db
      .prepare(
        `SELECT k.id AS key_id,
                u.id, u.username, u.role, u.daily_token_limit, u.quota_reset_mode, u.created_at
         FROM internal_api_keys k
         JOIN users u ON u.id = k.user_id
         WHERE k.key_hash = ? AND k.revoked_at IS NULL`,
      )
      .get(keyHash) as Record<string, unknown> | undefined;

    if (!row) {
      return c.json(
        openAiError(
          'Invalid or revoked API key.',
          'invalid_request_error',
          'invalid_api_key',
        ),
        401,
      );
    }

    const nowMs = now();
    const nowSec = Math.floor(nowMs / 1000);
    const keyId = String(row.key_id);
    const user = mapUserRow(row);

    db.prepare(`UPDATE internal_api_keys SET last_used_at = ? WHERE id = ?`).run(nowSec, keyId);

    // Server-side UTC quota check (ignores any client date/time headers)
    if (user.dailyTokenLimit !== null) {
      let windowStartSec: number;
      let resetAtMs: number;

      if (user.quotaResetMode === 'rolling_24h') {
        windowStartSec = nowSec - 86400;
        const oldestRow = db
          .prepare(
            `SELECT MIN(created_at) AS oldest_created_at
             FROM usage_logs
             WHERE user_id = ? AND created_at >= ?
               AND (prompt_tokens + completion_tokens + reasoning_tokens) > 0`,
          )
          .get(user.id, windowStartSec) as { oldest_created_at: number | bigint | null } | undefined;

        const oldestSec =
          oldestRow?.oldest_created_at !== null && oldestRow?.oldest_created_at !== undefined
            ? Number(oldestRow.oldest_created_at)
            : nowSec;
        resetAtMs = (oldestSec + 86400) * 1000;
      } else {
        const utcNow = new Date(nowMs);
        const startOfUtcDayMs = Date.UTC(
          utcNow.getUTCFullYear(),
          utcNow.getUTCMonth(),
          utcNow.getUTCDate(),
          0,
          0,
          0,
          0,
        );
        const nextUtcMidnightMs = Date.UTC(
          utcNow.getUTCFullYear(),
          utcNow.getUTCMonth(),
          utcNow.getUTCDate() + 1,
          0,
          0,
          0,
          0,
        );
        windowStartSec = Math.floor(startOfUtcDayMs / 1000);
        resetAtMs = nextUtcMidnightMs;
      }

      const usageRow = db
        .prepare(
          `SELECT COALESCE(SUM(prompt_tokens + completion_tokens + reasoning_tokens), 0) AS used_tokens
           FROM usage_logs
           WHERE user_id = ? AND created_at >= ?`,
        )
        .get(user.id, windowStartSec) as { used_tokens: number | bigint } | undefined;

      const usedTokens = Number(usageRow?.used_tokens ?? 0);

      if (usedTokens >= user.dailyTokenLimit) {
        const resetAtIso = new Date(resetAtMs).toISOString();
        const retryAfterSec = Math.max(1, Math.ceil((resetAtMs - nowMs) / 1000));
        c.header('Retry-After', String(retryAfterSec));
        return c.json(
          openAiError(
            `Daily token quota exceeded (${usedTokens}/${user.dailyTokenLimit} tokens used). Quota resets at ${resetAtIso}.`,
            'quota_exceeded',
            'daily_quota_exceeded',
            null,
            { reset_at: resetAtIso },
          ),
          429,
        );
      }
    }

    c.set('user', user);
    c.set('apiKeyId', keyId);
    return next();
  });

  app.get('/v1/models', (c) => {
    const user = c.get('user');

    const rows =
      user.role === 'admin'
        ? (db
            .prepare(
              `SELECT m.full_id, m.provider_id, m.first_seen_at, m.upstream_created_at
               FROM models m
               JOIN providers p ON p.id = m.provider_id
               WHERE m.active = 1 AND p.enabled = 1
               ORDER BY m.full_id ASC`,
            )
            .all() as Array<Record<string, unknown>>)
        : (db
            .prepare(
              `SELECT DISTINCT m.full_id, m.provider_id, m.first_seen_at, m.upstream_created_at
               FROM models m
               JOIN providers p ON p.id = m.provider_id
               JOIN user_model_access uma
                 ON uma.user_id = ?
                AND (uma.model_full_id = m.full_id OR uma.model_full_id = '*')
               WHERE m.active = 1 AND p.enabled = 1
               ORDER BY m.full_id ASC`,
            )
            .all(user.id) as Array<Record<string, unknown>>);

    const data = rows.map((m) => ({
      id: String(m.full_id),
      object: 'model' as const,
      created:
        m.upstream_created_at !== null && m.upstream_created_at !== undefined
          ? Number(m.upstream_created_at)
          : Number(m.first_seen_at),
      owned_by: String(m.provider_id),
    }));

    return c.json({
      object: 'list',
      data,
    });
  });

  app.post('/v1/chat/completions', async (c) => {
    const user = c.get('user');

    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json(
        openAiError(
          'Malformed JSON request body.',
          'invalid_request_error',
          'invalid_json',
        ),
        400,
      );
    }

    const modelId = typeof body.model === 'string' ? body.model.trim() : '';
    if (!modelId) {
      return c.json(
        openAiError(
          'Missing required parameter: "model".',
          'invalid_request_error',
          'missing_model',
          'model',
        ),
        400,
      );
    }

    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return c.json(
        openAiError(
          'Missing or empty required parameter: "messages".',
          'invalid_request_error',
          'invalid_messages',
          'messages',
        ),
        400,
      );
    }

    if (user.role === 'guest') {
      const accessRow = db
        .prepare(
          `SELECT 1 AS allowed
           FROM user_model_access
           WHERE user_id = ? AND (model_full_id = ? OR model_full_id = '*')
           LIMIT 1`,
        )
        .get(user.id, modelId) as { allowed: number } | undefined;

      if (!accessRow) {
        return c.json(
          openAiError(
            `You do not have access to model "${modelId}".`,
            'permission_error',
            'model_not_allowed',
            'model',
          ),
          403,
        );
      }
    }

    const modelRow = db
      .prepare(
        `SELECT m.full_id, m.provider_id
         FROM models m
         JOIN providers p ON p.id = m.provider_id
         WHERE m.full_id = ? AND m.active = 1 AND p.enabled = 1`,
      )
      .get(modelId) as { full_id: string; provider_id: string } | undefined;

    if (!modelRow) {
      return c.json(
        openAiError(
          `No active provider or model is configured for "${modelId}" yet.`,
          'invalid_request_error',
          'model_not_found',
          'model',
        ),
        404,
      );
    }

    const activeKeyRow = db
      .prepare(
        `SELECT id
         FROM provider_keys
         WHERE provider_id = ? AND status = 'active'
         LIMIT 1`,
      )
      .get(modelRow.provider_id) as { id: string } | undefined;

    if (!activeKeyRow) {
      return c.json(
        openAiError(
          `Provider "${modelRow.provider_id}" has no active API keys configured yet.`,
          'service_unavailable',
          'no_provider_keys',
        ),
        503,
      );
    }

    return c.json(
      openAiError(
        `Upstream forwarding for provider "${modelRow.provider_id}" is not yet configured.`,
        'service_unavailable',
        'provider_unavailable',
      ),
      503,
    );
  });

  app.all('/v1/*', (c) => {
    return c.json(
      openAiError(
        `Unknown OpenAI API endpoint: ${c.req.method} ${c.req.path}`,
        'invalid_request_error',
        'unknown_endpoint',
      ),
      404,
    );
  });

  // --- Static SPA serving from panel/dist ---

  app.get('*', (c) => {
    if (!fs.existsSync(resolvedPanelDistDir)) {
      return c.json({ error: 'Not Found' }, 404);
    }

    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(c.req.path);
    } catch {
      return c.text('Bad Request', 400);
    }

    const relativeReqPath = decodedPath.replace(/^\/+/, '');
    if (relativeReqPath) {
      const candidatePath = path.resolve(resolvedPanelDistDir, relativeReqPath);
      if (
        candidatePath.startsWith(resolvedPanelDistDir + path.sep) &&
        fs.existsSync(candidatePath)
      ) {
        const stat = fs.statSync(candidatePath);
        if (stat.isFile()) {
          const ext = path.extname(candidatePath).toLowerCase();
          const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';
          const body = fs.readFileSync(candidatePath);
          return c.body(body, 200, { 'Content-Type': contentType });
        }
      }
    }

    const indexHtmlPath = path.join(resolvedPanelDistDir, 'index.html');
    if (fs.existsSync(indexHtmlPath) && fs.statSync(indexHtmlPath).isFile()) {
      const html = fs.readFileSync(indexHtmlPath);
      return c.body(html, 200, { 'Content-Type': 'text/html; charset=utf-8' });
    }

    return c.json({ error: 'Not Found' }, 404);
  });

  return app;
}

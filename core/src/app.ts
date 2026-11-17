import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import {
  encryptSecret,
  generateInternalApiKey,
  generateSessionToken,
  hashPassword,
  sha256Hex,
  verifyPassword,
} from './crypto.js';
import { redactSecretsInText, writeSystemLog } from './db.js';
import { ModelSyncHttpError, formatModelRow, syncProviderModels } from './models-sync.js';
import { DrainingRegistry, executeChatCompletions } from './router.js';
import {
  type ProviderManifest,
  isValidHttpUri,
  loadSeedManifests,
  validateProviderManifest,
} from './schema.js';

const SESSION_COOKIE_NAME = 'bifrost_session';
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
const DEFAULT_MARKETPLACE_URL =
  'https://raw.githubusercontent.com/sxamx/bifrost-providers/main/index.json';

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
  schemasDir?: string;
  marketplaceUrl?: string;
  fetchImpl?: typeof fetch;
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

function formatProviderKeyRow(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    providerId: String(row.provider_id),
    label: String(row.label),
    last4: String(row.last4),
    nodeId: row.node_id === null || row.node_id === undefined ? null : String(row.node_id),
    forcedNode: Number(row.forced_node ?? 0) === 1,
    dailyQuotaLimit:
      row.daily_quota_limit === null || row.daily_quota_limit === undefined
        ? null
        : Number(row.daily_quota_limit),
    ratelimitRemaining:
      row.ratelimit_remaining === null || row.ratelimit_remaining === undefined
        ? null
        : Number(row.ratelimit_remaining),
    ratelimitResetAt:
      row.ratelimit_reset_at === null || row.ratelimit_reset_at === undefined
        ? null
        : Number(row.ratelimit_reset_at),
    status: String(row.status),
    lastError:
      row.last_error === null || row.last_error === undefined ? null : String(row.last_error),
    createdAt: Number(row.created_at),
  };
}

function formatProviderSummaryRow(
  row: Record<string, unknown>,
  keysCount: number,
  modelsCount: number,
  isAdmin: boolean,
) {
  let manifest: ProviderManifest | undefined;
  try {
    manifest = JSON.parse(String(row.schema_json)) as ProviderManifest;
  } catch {
    manifest = undefined;
  }

  if (!isAdmin) {
    return {
      id: String(row.id),
      name: String(row.name),
      packageType: String(row.package_type),
      modelsSource: String(row.models_source),
      enabled: Number(row.enabled) === 1,
      modelsCount,
    };
  }

  return {
    id: String(row.id),
    name: String(row.name),
    packageType: String(row.package_type),
    modelsSource: String(row.models_source),
    category: manifest?.category,
    verified: Boolean(manifest?.verified ?? false),
    baseUrl: manifest?.baseUrl,
    adapterUrl:
      row.adapter_url === null || row.adapter_url === undefined ? null : String(row.adapter_url),
    enabled: Number(row.enabled) === 1,
    reviewedAt: manifest?.reviewedAt ?? null,
    lastModelsSyncAt:
      row.last_models_sync_at === null || row.last_models_sync_at === undefined
        ? null
        : Number(row.last_models_sync_at),
    createdAt: Number(row.created_at),
    manifest,
    keysCount,
    modelsCount,
  };
}

export function createApp(options: CreateAppOptions): Hono<AppEnv> {
  const { db, masterKey } = options;
  if (masterKey.length !== 32) {
    throw new Error('createApp requires a 32-byte masterKey Buffer.');
  }
  const now = options.now ?? (() => Date.now());
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const defaultPanelDistDir = path.resolve(import.meta.dirname, '../../panel/dist');
  const resolvedPanelDistDir = path.resolve(options.panelDistDir ?? defaultPanelDistDir);
  const resolvedSchemasDir = path.resolve(
    options.schemasDir ?? path.resolve(import.meta.dirname, '../../schemas'),
  );
  const marketplaceUrl =
    options.marketplaceUrl ?? process.env.BIFROST_MARKETPLACE_URL ?? DEFAULT_MARKETPLACE_URL;

  const registry = new DrainingRegistry();
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

    const allProviderRows = db
      .prepare(`SELECT id FROM providers`)
      .all() as Array<{ id: string }>;
    const providersCount = allProviderRows.filter(
      (p) => !registry.isProviderDraining(p.id),
    ).length;

    const modelRows =
      user.role === 'admin'
        ? (db
            .prepare(
              `SELECT m.full_id, m.provider_id
               FROM models m
               JOIN providers p ON p.id = m.provider_id
               WHERE m.active = 1 AND p.enabled = 1`,
            )
            .all() as Array<{ full_id: string; provider_id: string }>)
        : (db
            .prepare(
              `SELECT DISTINCT m.full_id, m.provider_id
               FROM models m
               JOIN providers p ON p.id = m.provider_id
               JOIN user_model_access uma
                 ON uma.user_id = ?
                AND (uma.model_full_id = m.full_id OR uma.model_full_id = '*')
               WHERE m.active = 1 AND p.enabled = 1`,
            )
            .all(user.id) as Array<{ full_id: string; provider_id: string }>);

    const modelsCount = modelRows.filter(
      (m) => !registry.isProviderDraining(m.provider_id),
    ).length;

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
        providersCount,
        modelsCount,
        keysCount: Number(keysRow?.count ?? 0),
      },
    });
  });

  // --- Marketplace & Provider Installation (HU-06) ---

  const loadCachedOrSeedCatalog = (): ProviderManifest[] => {
    const cachedRow = db
      .prepare(`SELECT payload_json FROM external_cache WHERE cache_key = 'marketplace:index'`)
      .get() as { payload_json: string } | undefined;

    if (cachedRow?.payload_json) {
      try {
        const parsed = JSON.parse(cachedRow.payload_json) as unknown[];
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed as ProviderManifest[];
        }
      } catch {
        // Fall through to seed manifests
      }
    }

    return loadSeedManifests(resolvedSchemasDir);
  };

  app.get('/api/marketplace', async (c) => {
    const nowSec = nowSeconds();

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4000);
      let res: Response;
      try {
        res = await fetchImpl(marketplaceUrl, {
          method: 'GET',
          headers: { Accept: 'application/json' },
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      if (!res.ok) {
        throw new Error(`Marketplace HTTP ${res.status}`);
      }

      const rawJson = (await res.json()) as unknown;
      let rawItems: unknown[] = [];
      if (Array.isArray(rawJson)) {
        rawItems = rawJson;
      } else if (rawJson && typeof rawJson === 'object') {
        const rec = rawJson as Record<string, unknown>;
        if (Array.isArray(rec.providers)) rawItems = rec.providers;
        else if (Array.isArray(rec.manifests)) rawItems = rec.manifests;
        else if (Array.isArray(rec.items)) rawItems = rec.items;
        else if (Array.isArray(rec.catalog)) rawItems = rec.catalog;
      }

      const validManifests: ProviderManifest[] = [];
      for (const item of rawItems) {
        const check = validateProviderManifest(item, resolvedSchemasDir);
        if (check.valid && check.manifest) {
          validManifests.push(check.manifest);
        }
      }

      db.prepare(
        `INSERT INTO external_cache (cache_key, payload_json, etag, fetched_at)
         VALUES ('marketplace:index', ?, ?, ?)
         ON CONFLICT(cache_key) DO UPDATE SET
           payload_json = excluded.payload_json,
           etag = excluded.etag,
           fetched_at = excluded.fetched_at`,
      ).run(JSON.stringify(validManifests), res.headers.get('etag'), nowSec);

      return c.json({
        online: true,
        offline: false,
        providers: validManifests,
        manifests: validManifests,
      });
    } catch (err) {
      const fallback = loadCachedOrSeedCatalog();
      const errMsg = redactSecretsInText(
        err instanceof Error ? err.message : 'Unable to reach remote marketplace catalog.',
      );

      return c.json({
        online: false,
        offline: true,
        providers: fallback,
        manifests: fallback,
        notice:
          'Catálogo remoto fuera de línea. Mostrando fichas locales verificadas; también puedes importar un archivo JSON local.',
        error: errMsg,
      });
    }
  });

  const handleInstallProvider = async (
    body: Record<string, unknown>,
    allowCatalogIdLookup: boolean,
  ) => {
    let candidateManifest: unknown;
    const rawAdapterUrl =
      typeof body.adapterUrl === 'string' && body.adapterUrl.trim().length > 0
        ? body.adapterUrl.trim()
        : undefined;

    if (body.manifest && typeof body.manifest === 'object' && !Array.isArray(body.manifest)) {
      candidateManifest = body.manifest;
    } else if (
      allowCatalogIdLookup &&
      typeof (body.id ?? body.providerId) === 'string' &&
      !('schemaVersion' in body) &&
      !('baseUrl' in body)
    ) {
      const targetId = String(body.id ?? body.providerId);
      const catalog = loadCachedOrSeedCatalog();
      const found = catalog.find((m) => m.id === targetId);
      if (!found) {
        return {
          status: 404 as const,
          payload: { error: `Provider "${targetId}" was not found in the marketplace catalog.` },
        };
      }
      candidateManifest = found;
    } else {
      candidateManifest = body;
    }

    const validation = validateProviderManifest(candidateManifest, resolvedSchemasDir);
    if (!validation.valid || !validation.manifest) {
      return {
        status: 400 as const,
        payload: {
          error: `Invalid provider manifest: ${validation.errors.join('; ')}`,
          details: validation.errors,
        },
      };
    }

    const manifest = validation.manifest;
    let adapterUrl: string | null = null;
    if (manifest.packageType === 'experimental-adapter') {
      if (rawAdapterUrl) {
        if (!isValidHttpUri(rawAdapterUrl)) {
          return {
            status: 400 as const,
            payload: { error: 'adapterUrl must be a valid http:// or https:// URL.' },
          };
        }
        adapterUrl = rawAdapterUrl;
      } else {
        adapterUrl = manifest.baseUrl;
      }
    }

    const existing = db
      .prepare(`SELECT id FROM providers WHERE id = ?`)
      .get(manifest.id) as { id: string } | undefined;

    if (existing && !registry.isProviderDraining(manifest.id)) {
      return {
        status: 409 as const,
        payload: { error: `Provider "${manifest.id}" is already installed.` },
      };
    }

    const createdAt = nowSeconds();
    db.prepare(
      `INSERT INTO providers (
         id, name, package_type, models_source, schema_json,
         adapter_url, enabled, last_models_sync_at, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, 1, NULL, ?)`,
    ).run(
      manifest.id,
      manifest.name,
      manifest.packageType,
      manifest.modelsSource,
      JSON.stringify(manifest),
      adapterUrl,
      createdAt,
    );

    writeSystemLog(
      db,
      'info',
      'system',
      `Provider "${manifest.name}" (${manifest.id}) installed (${manifest.packageType})`,
      {
        providerId: manifest.id,
        packageType: manifest.packageType,
        modelsSource: manifest.modelsSource,
      },
      createdAt,
    );

    const insertedRow = db
      .prepare(`SELECT * FROM providers WHERE id = ?`)
      .get(manifest.id) as Record<string, unknown>;

    return {
      status: 201 as const,
      payload: {
        provider: formatProviderSummaryRow(insertedRow, 0, 0, true),
      },
    };
  };

  app.post('/api/marketplace/install', async (c) => {
    const user = c.get('user');
    if (user.role !== 'admin') {
      return c.json({ error: 'Admin privileges required.' }, 403);
    }

    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'Invalid JSON request body.' }, 400);
    }

    const result = await handleInstallProvider(body, true);
    return c.json(result.payload, result.status);
  });

  app.post('/api/providers', async (c) => {
    const user = c.get('user');
    if (user.role !== 'admin') {
      return c.json({ error: 'Admin privileges required.' }, 403);
    }

    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'Invalid JSON request body.' }, 400);
    }

    const result = await handleInstallProvider(body, false);
    return c.json(result.payload, result.status);
  });

  // --- Installed Providers List & Graceful Deletion (HU-02, HU-06, HU-10) ---

  app.get('/api/providers', (c) => {
    const user = c.get('user');
    const isAdmin = user.role === 'admin';

    const rows = db
      .prepare(`SELECT * FROM providers ORDER BY created_at ASC`)
      .all() as Array<Record<string, unknown>>;

    const visibleProviders = rows.filter((r) => !registry.isProviderDraining(String(r.id)));

    const providers = visibleProviders.map((r) => {
      const providerId = String(r.id);
      const keyIdRows = db
        .prepare(`SELECT id FROM provider_keys WHERE provider_id = ?`)
        .all(providerId) as Array<{ id: string }>;
      const keysCount = keyIdRows.filter((k) => !registry.isKeyDraining(k.id)).length;

      const modelsRow = db
        .prepare(`SELECT COUNT(*) AS count FROM models WHERE provider_id = ? AND active = 1`)
        .get(providerId) as { count: number | bigint } | undefined;
      const modelsCount = Number(modelsRow?.count ?? 0);

      return formatProviderSummaryRow(r, keysCount, modelsCount, isAdmin);
    });

    return c.json({ providers });
  });

  app.delete('/api/providers/:id', (c) => {
    const user = c.get('user');
    if (user.role !== 'admin') {
      return c.json({ error: 'Admin privileges required.' }, 403);
    }

    const providerId = c.req.param('id');
    if (registry.isProviderDraining(providerId)) {
      return c.json({ error: `Provider "${providerId}" not found.` }, 404);
    }

    const existing = db
      .prepare(`SELECT id, name FROM providers WHERE id = ?`)
      .get(providerId) as { id: string; name: string } | undefined;

    if (!existing) {
      return c.json({ error: `Provider "${providerId}" not found.` }, 404);
    }

    const keyRows = db
      .prepare(`SELECT id FROM provider_keys WHERE provider_id = ?`)
      .all(providerId) as Array<{ id: string }>;
    const keyIds = keyRows.map((k) => k.id);

    // Prevent any new request from matching this provider immediately
    db.prepare(`UPDATE providers SET enabled = 0 WHERE id = ?`).run(providerId);

    const { draining } = registry.drainAndRemoveProvider(providerId, keyIds, () => {
      db.prepare(`DELETE FROM providers WHERE id = ?`).run(providerId);
    });

    writeSystemLog(
      db,
      'info',
      'system',
      `Provider "${existing.name}" (${providerId}) removed${draining ? ' (draining in-flight requests)' : ''}`,
      { providerId, draining },
      nowSeconds(),
    );

    return c.json({ ok: true, draining });
  });

  // --- Encrypted Provider Keys Vault & Graceful Key Removal (HU-07, HU-10) ---

  app.get('/api/providers/:id/keys', (c) => {
    const user = c.get('user');
    if (user.role !== 'admin') {
      return c.json({ error: 'Admin privileges required.' }, 403);
    }

    const providerId = c.req.param('id');
    if (registry.isProviderDraining(providerId)) {
      return c.json({ error: `Provider "${providerId}" not found.` }, 404);
    }

    const prov = db
      .prepare(`SELECT id FROM providers WHERE id = ?`)
      .get(providerId) as { id: string } | undefined;
    if (!prov) {
      return c.json({ error: `Provider "${providerId}" not found.` }, 404);
    }

    const rows = db
      .prepare(
        `SELECT id, provider_id, label, last4, node_id, forced_node,
                daily_quota_limit, ratelimit_remaining, ratelimit_reset_at,
                status, last_error, created_at
         FROM provider_keys
         WHERE provider_id = ?
         ORDER BY created_at ASC`,
      )
      .all(providerId) as Array<Record<string, unknown>>;

    const keys = rows
      .filter((r) => !registry.isKeyDraining(String(r.id)))
      .map(formatProviderKeyRow);

    return c.json({ keys });
  });

  app.post('/api/providers/:id/keys', async (c) => {
    const user = c.get('user');
    if (user.role !== 'admin') {
      return c.json({ error: 'Admin privileges required.' }, 403);
    }

    const providerId = c.req.param('id');
    if (registry.isProviderDraining(providerId)) {
      return c.json({ error: `Provider "${providerId}" not found.` }, 404);
    }

    const prov = db
      .prepare(`SELECT id, name FROM providers WHERE id = ?`)
      .get(providerId) as { id: string; name: string } | undefined;
    if (!prov) {
      return c.json({ error: `Provider "${providerId}" not found.` }, 404);
    }

    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'Invalid JSON request body.' }, 400);
    }

    const label = typeof body.label === 'string' ? body.label.trim() : '';
    const rawSecret = typeof body.secret === 'string' ? body.secret.trim() : '';

    if (!label || label.length > 100) {
      return c.json({ error: 'Key label must be between 1 and 100 characters.' }, 400);
    }
    if (rawSecret.length < 4) {
      return c.json({ error: 'API key secret must be at least 4 characters.' }, 400);
    }

    let dailyQuotaLimit: number | null = null;
    if (body.dailyQuotaLimit !== undefined && body.dailyQuotaLimit !== null) {
      const parsedLimit = Number(body.dailyQuotaLimit);
      if (!Number.isInteger(parsedLimit) || parsedLimit <= 0) {
        return c.json({ error: 'dailyQuotaLimit must be a positive integer.' }, 400);
      }
      dailyQuotaLimit = parsedLimit;
    }

    let assignedNodeId: string | null = null;
    let forcedNode = 0;

    if (typeof body.nodeId === 'string' && body.nodeId.trim().length > 0) {
      const targetNodeId = body.nodeId.trim();
      const nodeRow = db
        .prepare(`SELECT id FROM nodes WHERE id = ?`)
        .get(targetNodeId) as { id: string } | undefined;
      if (!nodeRow) {
        return c.json({ error: `Node "${targetNodeId}" not found.` }, 400);
      }
      assignedNodeId = targetNodeId;
      forcedNode = body.forcedNode ? 1 : 0;
    } else {
      // Auto-assign to online node with fewest keys for this provider
      const autoNode = db
        .prepare(
          `SELECT n.id,
                  (SELECT COUNT(*) FROM provider_keys pk WHERE pk.node_id = n.id AND pk.provider_id = ?) AS prov_keys,
                  (SELECT COUNT(*) FROM provider_keys pk WHERE pk.node_id = n.id) AS total_keys
           FROM nodes n
           WHERE n.status = 'online'
           ORDER BY prov_keys ASC, total_keys ASC, n.created_at ASC
           LIMIT 1`,
        )
        .get(providerId) as { id: string } | undefined;

      if (autoNode) {
        assignedNodeId = autoNode.id;
      }
    }

    const keyId = randomUUID();
    const last4 = rawSecret.slice(-4);
    const encryptedSecret = encryptSecret(rawSecret, masterKey);
    const createdAt = nowSeconds();

    db.prepare(
      `INSERT INTO provider_keys (
         id, provider_id, label, encrypted_secret, last4,
         node_id, forced_node, daily_quota_limit,
         ratelimit_remaining, ratelimit_reset_at,
         status, last_error, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'active', NULL, ?)`,
    ).run(
      keyId,
      providerId,
      label,
      encryptedSecret,
      last4,
      assignedNodeId,
      forcedNode,
      dailyQuotaLimit,
      createdAt,
    );

    writeSystemLog(
      db,
      'info',
      'system',
      `Key "${label}" (…${last4}) registered on provider "${providerId}"`,
      { providerId, keyId, last4, nodeId: assignedNodeId },
      createdAt,
    );

    const inserted = db
      .prepare(
        `SELECT id, provider_id, label, last4, node_id, forced_node,
                daily_quota_limit, ratelimit_remaining, ratelimit_reset_at,
                status, last_error, created_at
         FROM provider_keys
         WHERE id = ?`,
      )
      .get(keyId) as Record<string, unknown>;

    return c.json({ key: formatProviderKeyRow(inserted) }, 201);
  });

  app.delete('/api/providers/:id/keys/:keyId', (c) => {
    const user = c.get('user');
    if (user.role !== 'admin') {
      return c.json({ error: 'Admin privileges required.' }, 403);
    }

    const providerId = c.req.param('id');
    const keyId = c.req.param('keyId');

    if (registry.isKeyDraining(keyId)) {
      return c.json({ error: 'Provider key not found.' }, 404);
    }

    const existing = db
      .prepare(`SELECT id, label, last4 FROM provider_keys WHERE id = ? AND provider_id = ?`)
      .get(keyId, providerId) as { id: string; label: string; last4: string } | undefined;

    if (!existing) {
      return c.json({ error: 'Provider key not found.' }, 404);
    }

    const { draining } = registry.drainAndRemoveKey(keyId, () => {
      db.prepare(`DELETE FROM provider_keys WHERE id = ? AND provider_id = ?`).run(
        keyId,
        providerId,
      );
    });

    writeSystemLog(
      db,
      'info',
      'system',
      `Key "${existing.label}" (…${existing.last4}) removed from provider "${providerId}"${draining ? ' (draining in-flight requests)' : ''}`,
      { providerId, keyId, last4: existing.last4, draining },
      nowSeconds(),
    );

    return c.json({ ok: true, draining });
  });

  // --- Detect & Reload Provider Models (HU-06b, HU-06c) ---

  const handleModelSync = async (providerId: string) => {
    return syncProviderModels({
      db,
      masterKey,
      providerId,
      drainingKeys: registry.getDrainingKeys(),
      drainingProviders: registry.getDrainingProviders(),
      fetchImpl,
      nowSec: nowSeconds(),
    });
  };

  app.post('/api/providers/:id/detect-models', async (c) => {
    const user = c.get('user');
    if (user.role !== 'admin') {
      return c.json({ error: 'Admin privileges required.' }, 403);
    }

    try {
      const diff = await handleModelSync(c.req.param('id'));
      return c.json(diff);
    } catch (err) {
      if (err instanceof ModelSyncHttpError) {
        return c.json({ error: err.message }, err.status);
      }
      throw err;
    }
  });

  app.post('/api/providers/:id/reload-models', async (c) => {
    const user = c.get('user');
    if (user.role !== 'admin') {
      return c.json({ error: 'Admin privileges required.' }, 403);
    }

    try {
      const diff = await handleModelSync(c.req.param('id'));
      return c.json(diff);
    } catch (err) {
      if (err instanceof ModelSyncHttpError) {
        return c.json({ error: err.message }, err.status);
      }
      throw err;
    }
  });

  app.get('/api/models', (c) => {
    const user = c.get('user');

    const rows =
      user.role === 'admin'
        ? (db
            .prepare(
              `SELECT m.*
               FROM models m
               JOIN providers p ON p.id = m.provider_id
               WHERE m.active = 1 AND p.enabled = 1
               ORDER BY m.full_id ASC`,
            )
            .all() as Array<Record<string, unknown>>)
        : (db
            .prepare(
              `SELECT DISTINCT m.*
               FROM models m
               JOIN providers p ON p.id = m.provider_id
               JOIN user_model_access uma
                 ON uma.user_id = ?
                AND (uma.model_full_id = m.full_id OR uma.model_full_id = '*')
               WHERE m.active = 1 AND p.enabled = 1
               ORDER BY m.full_id ASC`,
            )
            .all(user.id) as Array<Record<string, unknown>>);

    const models = rows
      .filter((r) => !registry.isProviderDraining(String(r.provider_id)))
      .map(formatModelRow);

    return c.json({ models });
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

  // --- OpenAI-Compatible API /v1/* (HU-03b, HU-09, HU-10) ---

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

    const rawKey = match[1]!;
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

    const data = rows
      .filter((m) => !registry.isProviderDraining(String(m.provider_id)))
      .map((m) => ({
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

    const requestedModel = typeof body.model === 'string' ? body.model.trim() : '';
    if (!requestedModel) {
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
        .get(user.id, requestedModel) as { allowed: number } | undefined;

      if (!accessRow) {
        return c.json(
          openAiError(
            `You do not have access to model "${requestedModel}".`,
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
        `SELECT m.full_id, m.model_id, m.provider_id
         FROM models m
         JOIN providers p ON p.id = m.provider_id
         WHERE m.full_id = ? AND m.active = 1 AND p.enabled = 1`,
      )
      .get(requestedModel) as
      | { full_id: string; model_id: string; provider_id: string }
      | undefined;

    if (!modelRow || registry.isProviderDraining(modelRow.provider_id)) {
      return c.json(
        openAiError(
          `No active provider or model is configured for "${requestedModel}" yet.`,
          'invalid_request_error',
          'model_not_found',
          'model',
        ),
        404,
      );
    }

    const providerRow = db
      .prepare(`SELECT * FROM providers WHERE id = ? AND enabled = 1`)
      .get(modelRow.provider_id) as Record<string, unknown> | undefined;

    if (!providerRow) {
      return c.json(
        openAiError(
          `Provider "${modelRow.provider_id}" is not enabled.`,
          'service_unavailable',
          'provider_unavailable',
        ),
        503,
      );
    }

    return executeChatCompletions({
      db,
      masterKey,
      registry,
      fetchImpl,
      now,
      userId: user.id,
      modelFullId: modelRow.full_id,
      modelId: modelRow.model_id,
      providerRow,
      requestBody: body,
    });
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

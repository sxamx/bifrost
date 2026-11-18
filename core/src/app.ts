import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import {
  deriveFallbackInitial,
  getProviderLogo,
  loadModelsDevSnapshot,
  readCachedModelsDevSnapshot,
  resolveAndSyncModelBenchmarks,
} from './catalog/index.js';
import {
  encryptSecret,
  generateInternalApiKey,
  generateSessionToken,
  hashPassword,
  sha256Hex,
  verifyPassword,
} from './crypto.js';
import { redactSecretsInText, writeSystemLog } from './db.js';
import {
  type ActivityGroupBy,
  type ActivityRange,
  type MetricsRange,
  type SystemLogCategory,
  type SystemLogLevel,
  computePercentiles,
  getLatencyMetrics,
  getProviderErrorRates7d,
  getSpeedAndCacheMetrics,
  getSummaryMetrics,
  getTokenActivity,
  getUptime60Days,
  querySystemLogs,
  round2,
} from './metrics/index.js';
import {
  fetchRemoteMarketplaceCatalog,
  isKnownUnapprovedMarketplaceId,
  readCachedOrBundledMarketplaceCatalog,
  stripMarketplaceWrapperFields,
  validateProviderTargetUrl,
} from './marketplace.js';
import {
  ModelSyncHttpError,
  formatModelRow,
  runModelsAutoSyncTick,
  syncProviderModels,
} from './models-sync.js';
import { handlePlaygroundChat } from './playground.js';
import {
  NodeOperationError,
  PUBLIC_IP_WARNING_MESSAGE,
  type UpstreamTlsOptions,
  buildNodeInstallCommand,
  generateNodeToken,
  normalizeHexFingerprint,
  parseNodeEndpoint,
  rotateNodeToken,
  runNodesHealthTick,
} from './nodes.js';
import { DrainingRegistry, checkUserDailyQuotaUtc, executeChatCompletions } from './router.js';
import {
  type ProviderManifest,
  isValidHttpUri,
  loadSeedManifests,
  validateProviderManifest,
} from './schema.js';

export { runNodesHealthTick, runModelsAutoSyncTick, computePercentiles };

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
  upstreamTls?: UpstreamTlsOptions;
  now?: () => number;
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
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

  const isProviderOrAllKeysDraining = (providerId: string): boolean => {
    if (registry.isProviderDraining(providerId)) {
      return true;
    }
    const keyRows = db
      .prepare(`SELECT id FROM provider_keys WHERE provider_id = ?`)
      .all(providerId) as Array<{ id: string }>;
    if (keyRows.length > 0 && keyRows.every((k) => registry.isKeyDraining(k.id))) {
      return true;
    }
    return false;
  };

  const isGuestModelAllowed = (
    userId: string,
    modelFullId: string,
    providerId?: string,
  ): boolean => {
    const inferredProv =
      providerId ??
      (modelFullId.includes('/') ? modelFullId.slice(0, modelFullId.indexOf('/')) : '');
    const providerWildcard = inferredProv ? `${inferredProv}/*` : '';
    const accessRow = db
      .prepare(
        `SELECT 1 AS allowed
         FROM user_model_access
         WHERE user_id = ?
           AND (model_full_id = ? OR model_full_id = '*' OR (? != '' AND model_full_id = ?))
         LIMIT 1`,
      )
      .get(userId, modelFullId, providerWildcard, providerWildcard) as
      | { allowed: number }
      | undefined;
    return Boolean(accessRow);
  };

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
                AND (uma.model_full_id = m.full_id OR uma.model_full_id = '*' OR uma.model_full_id = m.provider_id || '/*')
               WHERE m.active = 1 AND p.enabled = 1`,
            )
            .all(user.id) as Array<{ full_id: string; provider_id: string }>);

    const modelsCount = modelRows.filter(
      (m) => !isProviderOrAllKeysDraining(m.provider_id),
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

  // --- Marketplace & Provider Installation (HU-06, HU-23, HU-24) ---

  const loadCachedOrSeedCatalog = () =>
    readCachedOrBundledMarketplaceCatalog(db, resolvedSchemasDir);

  app.get('/api/marketplace', async (c) => {
    const nowSec = nowSeconds();

    try {
      const { manifests: validManifests } = await fetchRemoteMarketplaceCatalog({
        db,
        marketplaceUrl,
        schemasDir: resolvedSchemasDir,
        fetchImpl,
        nowSec,
      });

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

    if (body.approved === false) {
      return {
        status: 403 as const,
        payload: { error: 'Unapproved marketplace packages cannot be installed.' },
      };
    }

    if (body.manifest && typeof body.manifest === 'object' && !Array.isArray(body.manifest)) {
      const rawM = body.manifest as Record<string, unknown>;
      if (rawM.approved === false) {
        return {
          status: 403 as const,
          payload: { error: 'Unapproved marketplace packages cannot be installed.' },
        };
      }
      if (allowCatalogIdLookup && typeof rawM.id === 'string' && isKnownUnapprovedMarketplaceId(db, rawM.id)) {
        return {
          status: 403 as const,
          payload: { error: `Provider "${rawM.id}" is not approved in the marketplace catalog.` },
        };
      }
      candidateManifest = allowCatalogIdLookup ? stripMarketplaceWrapperFields(rawM) : rawM;
    } else if (
      allowCatalogIdLookup &&
      typeof (body.id ?? body.providerId) === 'string' &&
      !('schemaVersion' in body) &&
      !('baseUrl' in body)
    ) {
      const targetId = String(body.id ?? body.providerId).trim();
      if (isKnownUnapprovedMarketplaceId(db, targetId)) {
        return {
          status: 403 as const,
          payload: { error: `Provider "${targetId}" is not approved in the marketplace catalog.` },
        };
      }
      const catalog = loadCachedOrSeedCatalog();
      const found = catalog.find((m) => m.id === targetId);
      if (!found) {
        return {
          status: 404 as const,
          payload: { error: `Provider "${targetId}" was not found in the approved marketplace catalog.` },
        };
      }
      candidateManifest = stripMarketplaceWrapperFields(found as unknown as Record<string, unknown>);
    } else {
      candidateManifest = allowCatalogIdLookup ? stripMarketplaceWrapperFields(body) : body;
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
      const targetAdapterUrl = rawAdapterUrl ?? manifest.baseUrl;
      const adapterCheck = validateProviderTargetUrl(
        targetAdapterUrl,
        'experimental-adapter',
        'adapterUrl',
      );
      if (!adapterCheck.valid || !adapterCheck.normalizedUrl) {
        return {
          status: 400 as const,
          payload: { error: adapterCheck.error ?? 'Invalid adapterUrl.' },
        };
      }
      adapterUrl = adapterCheck.normalizedUrl;
    } else if (rawAdapterUrl !== undefined) {
      return {
        status: 400 as const,
        payload: { error: 'adapterUrl is only allowed for experimental-adapter packages.' },
      };
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

    let adapterHealth: { reachable: boolean; status: number | null } | undefined;
    if (
      manifest.packageType === 'experimental-adapter' &&
      adapterUrl &&
      body.checkAdapterHealth === true &&
      manifest.adapter?.healthPath
    ) {
      try {
        const parsedAdapter = new URL(adapterUrl);
        const healthUrl = new URL(manifest.adapter.healthPath, parsedAdapter.origin).href;
        const hRes = await fetchImpl(healthUrl, { method: 'GET', redirect: 'error' });
        adapterHealth = { reachable: hRes.ok, status: hRes.status };
      } catch {
        adapterHealth = { reachable: false, status: null };
      }
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
        ...(adapterUrl ? { adapterUrl } : {}),
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
        ...(adapterHealth ? { adapterHealth } : {}),
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

    const getNodeAssignedKeys = (targetNodeId: string, excludeKeyId?: string) => {
      const rows = db
        .prepare(
          `SELECT pk.id, pk.provider_id, p.name AS provider_name, pk.label, pk.last4
           FROM provider_keys pk
           JOIN providers p ON p.id = pk.provider_id
           WHERE pk.node_id = ?
           ORDER BY pk.created_at ASC`,
        )
        .all(targetNodeId) as Array<Record<string, unknown>>;

      return rows
        .filter((r) => {
          const id = String(r.id);
          if (excludeKeyId && id === excludeKeyId) return false;
          return !registry.isKeyDraining(id) && !registry.isProviderDraining(String(r.provider_id));
        })
        .map((r) => ({
          id: String(r.id),
          providerId: String(r.provider_id),
          providerName: String(r.provider_name),
          label: String(r.label),
          last4: String(r.last4),
        }));
    };

    let assignedNodeId: string | null = null;
    let forcedNode = 0;
    let initialKeyStatus: 'active' | 'no_node' = 'active';
    let initialLastError: string | null = null;

    if (typeof body.nodeId === 'string' && body.nodeId.trim().length > 0) {
      const targetNodeId = body.nodeId.trim();
      const nodeRow = db
        .prepare(`SELECT id, name, status FROM nodes WHERE id = ?`)
        .get(targetNodeId) as { id: string; name: string; status: string } | undefined;
      if (!nodeRow) {
        return c.json({ error: `Node "${targetNodeId}" not found.` }, 400);
      }

      const sameProviderKeys = getNodeAssignedKeys(targetNodeId).filter(
        (k) => k.providerId === providerId,
      );
      const confirmForce = body.confirmForce === true || body.forcedNode === true;
      if (sameProviderKeys.length > 0 && !confirmForce) {
        const collisionMsg = `Node "${nodeRow.name}" already holds ${sameProviderKeys.length} key(s) for provider "${prov.name}". Sharing the same exit IP increases ban risk.`;
        return c.json(
          {
            message: collisionMsg,
            code: 'NODE_PROVIDER_COLLISION',
            requiresConfirmation: true,
            existingKeys: sameProviderKeys,
            error: {
              message: collisionMsg,
              code: 'NODE_PROVIDER_COLLISION',
              requiresConfirmation: true,
              existingKeys: sameProviderKeys,
            },
          },
          409,
        );
      }

      assignedNodeId = targetNodeId;
      forcedNode = sameProviderKeys.length > 0 ? 1 : 0;
      if (nodeRow.status !== 'online') {
        initialKeyStatus = 'no_node';
        initialLastError = `Assigned exit node "${nodeRow.name}" is ${nodeRow.status}`;
      }
    } else {
      // HU-08: Auto-assign to online node with fewest keys for this specific provider
      const onlineNodes = db
        .prepare(`SELECT id, created_at FROM nodes WHERE status = 'online' ORDER BY created_at ASC`)
        .all() as Array<{ id: string; created_at: number }>;

      if (onlineNodes.length > 0) {
        const scored = onlineNodes.map((n) => {
          const assigned = getNodeAssignedKeys(n.id);
          const provKeys = assigned.filter((k) => k.providerId === providerId).length;
          return {
            id: n.id,
            provKeys,
            totalKeys: assigned.length,
            createdAt: Number(n.created_at),
          };
        });
        scored.sort(
          (a, b) =>
            a.provKeys - b.provKeys ||
            a.totalKeys - b.totalKeys ||
            a.createdAt - b.createdAt,
        );
        assignedNodeId = scored[0]!.id;
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
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
    ).run(
      keyId,
      providerId,
      label,
      encryptedSecret,
      last4,
      assignedNodeId,
      forcedNode,
      dailyQuotaLimit,
      initialKeyStatus,
      initialLastError,
      createdAt,
    );

    if (forcedNode === 1 && assignedNodeId) {
      writeSystemLog(
        db,
        'warn',
        'node',
        `Key "${label}" (…${last4}) forcibly assigned to node "${assignedNodeId}" sharing IP with existing "${providerId}" key(s)`,
        { providerId, keyId, last4, nodeId: assignedNodeId, forcedNode: true },
        createdAt,
      );
    } else {
      writeSystemLog(
        db,
        'info',
        'system',
        `Key "${label}" (…${last4}) registered on provider "${providerId}"`,
        { providerId, keyId, last4, nodeId: assignedNodeId },
        createdAt,
      );
    }

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

  // --- Key-to-Node Assignment & Same-Provider Collision Confirmation (HU-08, HU-11d) ---

  app.patch('/api/providers/:id/keys/:keyId/node', async (c) => {
    const user = c.get('user');
    if (user.role !== 'admin') {
      return c.json({ error: 'Admin privileges required.' }, 403);
    }

    const providerId = c.req.param('id');
    const keyId = c.req.param('keyId');

    if (registry.isProviderDraining(providerId) || registry.isKeyDraining(keyId)) {
      return c.json({ error: 'Provider key not found.' }, 404);
    }

    const prov = db
      .prepare(`SELECT id, name FROM providers WHERE id = ?`)
      .get(providerId) as { id: string; name: string } | undefined;
    if (!prov) {
      return c.json({ error: `Provider "${providerId}" not found.` }, 404);
    }

    const existingKey = db
      .prepare(
        `SELECT id, provider_id, label, last4, node_id, forced_node, status, last_error
         FROM provider_keys
         WHERE id = ? AND provider_id = ?`,
      )
      .get(keyId, providerId) as
      | {
          id: string;
          provider_id: string;
          label: string;
          last4: string;
          node_id: string | null;
          forced_node: number;
          status: string;
          last_error: string | null;
        }
      | undefined;

    if (!existingKey) {
      return c.json({ error: 'Provider key not found.' }, 404);
    }

    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'Invalid JSON request body.' }, 400);
    }

    const rawNodeId = body.nodeId;
    const confirmForce = body.confirmForce === true;
    const nowSec = nowSeconds();

    if (rawNodeId === null || rawNodeId === '') {
      const nextStatus = existingKey.status === 'no_node' ? 'active' : existingKey.status;
      const nextLastError = existingKey.status === 'no_node' ? null : existingKey.last_error;

      db.prepare(
        `UPDATE provider_keys
         SET node_id = NULL, forced_node = 0, status = ?, last_error = ?
         WHERE id = ? AND provider_id = ?`,
      ).run(nextStatus, nextLastError, keyId, providerId);

      writeSystemLog(
        db,
        'info',
        'node',
        `Key "${existingKey.label}" (…${existingKey.last4}) unassigned from exit node (direct server egress)`,
        { providerId, keyId, previousNodeId: existingKey.node_id },
        nowSec,
      );

      const updated = db
        .prepare(
          `SELECT id, provider_id, label, last4, node_id, forced_node,
                  daily_quota_limit, ratelimit_remaining, ratelimit_reset_at,
                  status, last_error, created_at
           FROM provider_keys
           WHERE id = ?`,
        )
        .get(keyId) as Record<string, unknown>;

      return c.json({ key: formatProviderKeyRow(updated) });
    }

    if (typeof rawNodeId !== 'string' || !rawNodeId.trim()) {
      return c.json({ error: 'nodeId must be a valid node ID string or null.' }, 400);
    }

    const targetNodeId = rawNodeId.trim();
    const targetNode = db
      .prepare(`SELECT id, name, status FROM nodes WHERE id = ?`)
      .get(targetNodeId) as { id: string; name: string; status: string } | undefined;

    if (!targetNode) {
      return c.json({ error: `Node "${targetNodeId}" not found.` }, 404);
    }

    const siblingRows = db
      .prepare(
        `SELECT id, label, last4
         FROM provider_keys
         WHERE node_id = ? AND provider_id = ? AND id != ?
         ORDER BY created_at ASC`,
      )
      .all(targetNodeId, providerId, keyId) as Array<{
      id: string;
      label: string;
      last4: string;
    }>;

    const activeSiblings = siblingRows
      .filter((s) => !registry.isKeyDraining(s.id))
      .map((s) => ({
        id: s.id,
        providerId,
        providerName: prov.name,
        label: s.label,
        last4: s.last4,
      }));

    if (activeSiblings.length > 0 && !confirmForce) {
      const collisionMessage = `Node "${targetNode.name}" already holds ${activeSiblings.length} key(s) for provider "${prov.name}". Sharing the same exit IP increases ban risk.`;
      return c.json(
        {
          message: collisionMessage,
          code: 'NODE_PROVIDER_COLLISION',
          requiresConfirmation: true,
          existingKeys: activeSiblings,
          error: {
            message: collisionMessage,
            code: 'NODE_PROVIDER_COLLISION',
            requiresConfirmation: true,
            existingKeys: activeSiblings,
          },
        },
        409,
      );
    }

    const forcedFlag = activeSiblings.length > 0 ? 1 : 0;
    let nextStatus = existingKey.status;
    let nextLastError = existingKey.last_error;

    if (targetNode.status !== 'online') {
      nextStatus = 'no_node';
      nextLastError = `Assigned exit node "${targetNode.name}" is ${targetNode.status}`;
    } else if (existingKey.status === 'no_node') {
      nextStatus = 'active';
      nextLastError = null;
    }

    db.prepare(
      `UPDATE provider_keys
       SET node_id = ?, forced_node = ?, status = ?, last_error = ?
       WHERE id = ? AND provider_id = ?`,
    ).run(targetNodeId, forcedFlag, nextStatus, nextLastError, keyId, providerId);

    if (forcedFlag === 1) {
      writeSystemLog(
        db,
        'warn',
        'node',
        `Admin confirmed same-provider IP collision: key "${existingKey.label}" (…${existingKey.last4}) assigned to node "${targetNode.name}" alongside ${activeSiblings.length} existing "${prov.name}" key(s)`,
        {
          providerId,
          keyId,
          nodeId: targetNodeId,
          forcedNode: true,
          collidingKeyIds: activeSiblings.map((k) => k.id),
        },
        nowSec,
      );
    } else {
      writeSystemLog(
        db,
        'info',
        'node',
        `Key "${existingKey.label}" (…${existingKey.last4}) assigned to exit node "${targetNode.name}"`,
        { providerId, keyId, nodeId: targetNodeId, forcedNode: false },
        nowSec,
      );
    }

    const updated = db
      .prepare(
        `SELECT id, provider_id, label, last4, node_id, forced_node,
                daily_quota_limit, ratelimit_remaining, ratelimit_reset_at,
                status, last_error, created_at
         FROM provider_keys
         WHERE id = ?`,
      )
      .get(keyId) as Record<string, unknown>;

    return c.json({ key: formatProviderKeyRow(updated) });
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
      upstreamTls: options.upstreamTls,
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

  // --- Monochrome Sanitized Provider Logos & Catalog Explorer (HU-14, HU-14b, HU-14c, HU-15) ---

  app.get('/api/logos/:slug', async (c) => {
    const user = c.get('user');
    const rawSlug = c.req.param('slug') ?? '';
    const cleanedSlug = rawSlug.trim().replace(/\.svg$/i, '');
    const providerRow = db
      .prepare(`SELECT name FROM providers WHERE id = ?`)
      .get(cleanedSlug) as { name: string } | undefined;

    const result = await getProviderLogo(db, cleanedSlug, {
      displayName: providerRow?.name ?? cleanedSlug,
      fetchFn: fetchImpl,
      nowSec: nowSeconds(),
      forceRefresh: user.role === 'admin' && c.req.query('refresh') === '1',
    });

    const accept = (c.req.header('accept') ?? '').toLowerCase();
    const wantsRawSvg =
      c.req.query('format') === 'svg' ||
      (accept.includes('image/svg+xml') && !accept.includes('application/json'));

    if (wantsRawSvg) {
      if (result.hasLogo) {
        return c.body(result.svg, 200, {
          'Content-Type': 'image/svg+xml; charset=utf-8',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
        });
      }
      return c.json(
        {
          hasLogo: false,
          slug: result.slug,
          svg: null,
          initial: result.initial,
        },
        404,
      );
    }

    if (result.hasLogo) {
      return c.json({
        hasLogo: true,
        slug: result.slug,
        svg: result.svg,
        initial: deriveFallbackInitial(providerRow?.name ?? cleanedSlug),
      });
    }

    return c.json({
      hasLogo: false,
      slug: result.slug,
      svg: null,
      initial: result.initial,
    });
  });

  app.get('/api/models', (c) => {
    const user = c.get('user');
    const providerFilter = c.req.query('provider')?.trim().toLowerCase() ?? '';
    const modalityFilter = c.req.query('modality')?.trim().toLowerCase() ?? '';
    const capabilityFilter = c.req.query('capability')?.trim().toLowerCase() ?? '';
    const searchQuery = c.req.query('q')?.trim().toLowerCase() ?? '';

    const rows =
      user.role === 'admin'
        ? (db
            .prepare(
              `SELECT m.*, p.name AS provider_name
               FROM models m
               JOIN providers p ON p.id = m.provider_id
               WHERE m.active = 1 AND p.enabled = 1
               ORDER BY m.full_id ASC`,
            )
            .all() as Array<Record<string, unknown>>)
        : (db
            .prepare(
              `SELECT DISTINCT m.*, p.name AS provider_name
               FROM models m
               JOIN providers p ON p.id = m.provider_id
               JOIN user_model_access uma
                 ON uma.user_id = ?
                AND (uma.model_full_id = m.full_id OR uma.model_full_id = '*' OR uma.model_full_id = m.provider_id || '/*')
               WHERE m.active = 1 AND p.enabled = 1
               ORDER BY m.full_id ASC`,
            )
            .all(user.id) as Array<Record<string, unknown>>);

    const snapshot = readCachedModelsDevSnapshot(db);
    const hasCachedModelsDev =
      Object.keys(snapshot.api).length > 0 || Object.keys(snapshot.canonical).length > 0;

    let models = rows
      .filter((r) => !isProviderOrAllKeysDraining(String(r.provider_id)))
      .map((r) =>
        hasCachedModelsDev
          ? formatModelRow(r, {
              providerName: String(r.provider_name ?? ''),
              modelsDevSnapshot: snapshot,
            })
          : formatModelRow(r),
      );

    if (providerFilter) {
      models = models.filter((m) => m.providerId.toLowerCase() === providerFilter);
    }

    if (modalityFilter) {
      models = models.filter(
        (m) =>
          m.modalities.input.some((mod) => mod.toLowerCase() === modalityFilter) ||
          m.modalities.output.some((mod) => mod.toLowerCase() === modalityFilter),
      );
    }

    if (capabilityFilter) {
      const reqCaps = capabilityFilter
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      models = models.filter((m) =>
        reqCaps.every((cap) => {
          if (cap === 'tools' || cap === 'tool_call') return m.capabilities.tools;
          if (cap === 'reasoning') return m.capabilities.reasoning;
          if (
            cap === 'structuredoutput' ||
            cap === 'structured_output' ||
            cap === 'structured'
          ) {
            return m.capabilities.structuredOutput;
          }
          return false;
        }),
      );
    }

    if (searchQuery) {
      models = models.filter((m) => {
        const haystack = [
          m.fullId,
          m.name,
          m.modelId,
          m.canonicalModelId ?? '',
          m.providerId,
          m.providerName ?? '',
        ]
          .join(' ')
          .toLowerCase();
        return haystack.includes(searchQuery);
      });
    }

    return c.json({ models });
  });

  app.get('/api/models/*', async (c) => {
    const user = c.get('user');
    let rawPathname: string;
    try {
      rawPathname = new URL(c.req.url).pathname;
    } catch {
      rawPathname = c.req.path;
    }

    const prefix = '/api/models/';
    if (!rawPathname.startsWith(prefix)) {
      return c.json({ error: 'Not Found' }, 404);
    }

    let suffix = rawPathname.slice(prefix.length);
    let isBenchmarks = false;
    if (suffix.endsWith('/benchmarks')) {
      isBenchmarks = true;
      suffix = suffix.slice(0, -'/benchmarks'.length);
    }

    let decodedFullId: string;
    try {
      decodedFullId = decodeURIComponent(suffix).replace(/^\/+|\/+$/g, '');
    } catch {
      return c.json({ error: 'Invalid model identifier encoding.' }, 400);
    }

    if (!decodedFullId) {
      return c.json({ error: 'Model identifier is required.' }, 400);
    }

    const modelRow = db
      .prepare(
        `SELECT m.*, p.name AS provider_name
         FROM models m
         JOIN providers p ON p.id = m.provider_id
         WHERE m.full_id = ? AND m.active = 1 AND p.enabled = 1`,
      )
      .get(decodedFullId) as Record<string, unknown> | undefined;

    if (!modelRow || isProviderOrAllKeysDraining(String(modelRow.provider_id))) {
      return c.json({ error: `Model "${decodedFullId}" not found.` }, 404);
    }

    if (
      user.role === 'guest' &&
      !isGuestModelAllowed(user.id, String(modelRow.full_id), String(modelRow.provider_id))
    ) {
      return c.json(
        { error: `You do not have access to model "${decodedFullId}".` },
        403,
      );
    }

    let snapshot = readCachedModelsDevSnapshot(db);
    if (
      Object.keys(snapshot.api).length === 0 &&
      Object.keys(snapshot.canonical).length === 0
    ) {
      snapshot = await loadModelsDevSnapshot(db, {
        fetchFn: fetchImpl,
        nowSec: nowSeconds(),
      });
    }

    const formatted = formatModelRow(modelRow, {
      providerName: String(modelRow.provider_name ?? ''),
      modelsDevSnapshot: snapshot,
    });

    if (!isBenchmarks) {
      return c.json({
        model: formatted,
        ...formatted,
      });
    }

    const benchmarks = await resolveAndSyncModelBenchmarks(
      db,
      {
        fullId: formatted.fullId,
        canonicalModelId: formatted.canonicalModelId,
        modelId: formatted.modelId,
        name: formatted.name,
      },
      {
        fetchFn: fetchImpl,
        nowSec: nowSeconds(),
        forceRefresh: user.role === 'admin' && c.req.query('refresh') === '1',
      },
    );

    return c.json(benchmarks);
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

  // --- Exit Nodes Management (HU-11, HU-11b, HU-11c, HU-13) ---

  const listNodeAssignedKeys = (nodeId: string) => {
    const rows = db
      .prepare(
        `SELECT pk.id, pk.provider_id, p.name AS provider_name, pk.label, pk.last4
         FROM provider_keys pk
         JOIN providers p ON p.id = pk.provider_id
         WHERE pk.node_id = ?
         ORDER BY pk.created_at ASC`,
      )
      .all(nodeId) as Array<Record<string, unknown>>;

    return rows
      .filter(
        (r) =>
          !registry.isKeyDraining(String(r.id)) &&
          !registry.isProviderDraining(String(r.provider_id)),
      )
      .map((r) => ({
        id: String(r.id),
        providerId: String(r.provider_id),
        providerName: String(r.provider_name),
        label: String(r.label),
        last4: String(r.last4),
      }));
  };

  const formatNodeItem = (row: Record<string, unknown>) => {
    const nodeId = String(row.id);
    const assignedKeys = listNodeAssignedKeys(nodeId);
    return {
      id: nodeId,
      name: String(row.name),
      mode: row.mode === 'public_ip' ? ('public_ip' as const) : ('tailscale' as const),
      endpoint: String(row.endpoint),
      tlsFingerprint:
        row.tls_fingerprint === null || row.tls_fingerprint === undefined
          ? null
          : String(row.tls_fingerprint),
      status:
        row.status === 'online' || row.status === 'unresponsive'
          ? (String(row.status) as 'online' | 'unresponsive')
          : ('offline' as const),
      lastSeenAt:
        row.last_seen_at === null || row.last_seen_at === undefined
          ? null
          : Number(row.last_seen_at),
      lastRotatedAt:
        row.last_rotated_at === null || row.last_rotated_at === undefined
          ? null
          : Number(row.last_rotated_at),
      createdAt: Number(row.created_at),
      assignedKeysCount: assignedKeys.length,
      assignedKeys,
      affectedKeys: assignedKeys,
    };
  };

  app.get('/api/nodes', (c) => {
    const user = c.get('user');
    if (user.role !== 'admin') {
      return c.json({ error: 'Admin privileges required.' }, 403);
    }

    const rows = db
      .prepare(
        `SELECT id, name, mode, endpoint, tls_fingerprint,
                last_seen_at, last_rotated_at, status, created_at
         FROM nodes
         ORDER BY created_at ASC`,
      )
      .all() as Array<Record<string, unknown>>;

    return c.json({ nodes: rows.map(formatNodeItem) });
  });

  app.post('/api/nodes', async (c) => {
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

    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const mode = body.mode;
    const rawEndpoint = typeof body.endpoint === 'string' ? body.endpoint.trim() : '';

    if (!name || name.length > 100) {
      return c.json({ error: 'Node name must be between 1 and 100 characters.' }, 400);
    }
    if (mode !== 'tailscale' && mode !== 'public_ip') {
      return c.json({ error: 'Node mode must be "tailscale" or "public_ip".' }, 400);
    }

    const parsedEndpoint = parseNodeEndpoint(rawEndpoint);
    if (!parsedEndpoint) {
      return c.json(
        {
          error:
            'Invalid node endpoint. Expected "<host>:<port>" or "<host>" (default port 9443).',
        },
        400,
      );
    }

    let tlsFingerprint: string | null = null;
    if (typeof body.tlsFingerprint === 'string' && body.tlsFingerprint.trim().length > 0) {
      const normFp = normalizeHexFingerprint(body.tlsFingerprint);
      if (!/^[0-9A-F]{64}$/.test(normFp)) {
        return c.json(
          { error: 'tlsFingerprint must be a valid 64-character SHA-256 hex digest.' },
          400,
        );
      }
      tlsFingerprint = normFp;
    }

    const existingEndpoint = db
      .prepare(`SELECT id, name FROM nodes WHERE endpoint = ?`)
      .get(parsedEndpoint.normalized) as { id: string; name: string } | undefined;
    if (existingEndpoint) {
      return c.json(
        {
          error: `An exit node ("${existingEndpoint.name}") is already registered for endpoint "${parsedEndpoint.normalized}".`,
        },
        409,
      );
    }

    const nodeId = randomUUID();
    const createdAt = nowSeconds();
    const { rawToken, tokenHash } = generateNodeToken();
    const encryptedToken = encryptSecret(rawToken, masterKey);

    db.prepare(
      `INSERT INTO nodes (
         id, name, mode, endpoint, token_hash, encrypted_token,
         prev_token_hash, prev_token_expires_at, tls_fingerprint,
         last_seen_at, last_rotated_at, status, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL, ?, 'offline', ?)`,
    ).run(
      nodeId,
      name,
      mode,
      parsedEndpoint.normalized,
      tokenHash,
      encryptedToken,
      tlsFingerprint,
      createdAt,
      createdAt,
    );

    let serverOrigin: string | undefined;
    try {
      serverOrigin = new URL(c.req.url).origin;
    } catch {
      serverOrigin = undefined;
    }

    const installCommand = buildNodeInstallCommand({
      mode,
      endpoint: parsedEndpoint.normalized,
      rawToken,
      serverOrigin,
    });
    const publicIpWarning = mode === 'public_ip' ? PUBLIC_IP_WARNING_MESSAGE : null;

    writeSystemLog(
      db,
      mode === 'public_ip' ? 'warn' : 'info',
      'node',
      `Exit node "${name}" (${parsedEndpoint.normalized}) registered in ${mode} mode`,
      {
        nodeId,
        name,
        mode,
        endpoint: parsedEndpoint.normalized,
        hasPinnedTlsFingerprint: tlsFingerprint !== null,
      },
      createdAt,
    );

    const insertedRow = db
      .prepare(
        `SELECT id, name, mode, endpoint, tls_fingerprint,
                last_seen_at, last_rotated_at, status, created_at
         FROM nodes
         WHERE id = ?`,
      )
      .get(nodeId) as Record<string, unknown>;

    return c.json(
      {
        node: formatNodeItem(insertedRow),
        rawToken,
        installCommand,
        publicIpWarning,
      },
      201,
    );
  });

  app.post('/api/nodes/:id/rotate', async (c) => {
    const user = c.get('user');
    if (user.role !== 'admin') {
      return c.json({ error: 'Admin privileges required.' }, 403);
    }

    const nodeId = c.req.param('id');
    try {
      const result = await rotateNodeToken({
        db,
        masterKey,
        nodeId,
        nowSec: nowSeconds(),
      });
      return c.json(result);
    } catch (err) {
      if (err instanceof NodeOperationError) {
        return c.json({ error: err.message }, err.status);
      }
      throw err;
    }
  });

  app.delete('/api/nodes/:id', (c) => {
    const user = c.get('user');
    if (user.role !== 'admin') {
      return c.json({ error: 'Admin privileges required.' }, 403);
    }

    const nodeId = c.req.param('id');
    const existingNode = db
      .prepare(`SELECT id, name, endpoint FROM nodes WHERE id = ?`)
      .get(nodeId) as { id: string; name: string; endpoint: string } | undefined;

    if (!existingNode) {
      return c.json({ error: `Node "${nodeId}" not found.` }, 404);
    }

    const affectedKeys = listNodeAssignedKeys(nodeId);
    const nowSec = nowSeconds();

    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(
        `UPDATE provider_keys
         SET node_id = NULL,
             forced_node = 0,
             status = 'no_node',
             last_error = 'Assigned exit node was removed'
         WHERE node_id = ?`,
      ).run(nodeId);

      db.prepare(`DELETE FROM nodes WHERE id = ?`).run(nodeId);

      writeSystemLog(
        db,
        affectedKeys.length > 0 ? 'warn' : 'info',
        'node',
        `Exit node "${existingNode.name}" (${existingNode.endpoint}) removed${affectedKeys.length > 0 ? `; ${affectedKeys.length} key(s) marked as no_node` : ''}`,
        {
          nodeId,
          affectedKeysCount: affectedKeys.length,
          affectedKeyIds: affectedKeys.map((k) => k.id),
        },
        nowSec,
      );

      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }

    return c.json({
      ok: true,
      affectedKeysCount: affectedKeys.length,
      affectedKeys,
    });
  });

  // --- Phase 5: Telemetry, Quota Summary, Percentiles, Uptime & Audit Logs (HU-17..HU-20c) ---

  const VALID_METRICS_RANGES = new Set<string>(['today', '24h', '7d', '30d']);
  const VALID_ACTIVITY_GROUP_BY = new Set<string>(['model', 'provider', 'user']);
  const VALID_LOG_LEVELS = new Set<string>(['info', 'warn', 'error']);
  const VALID_LOG_CATEGORIES = new Set<string>([
    'failover',
    'stream_resume',
    'node',
    'sync',
    'auth',
    'backup',
    'system',
  ]);

  app.get('/api/metrics/summary', (c) => {
    const user = c.get('user');
    const summary = getSummaryMetrics(db, {
      nowSec: nowSeconds(),
      userId: user.id,
      role: user.role,
    });
    const totalDailyLimit = summary.quotaToday.configuredDailyLimit;
    const quotaPercentageRemaining =
      totalDailyLimit !== null && totalDailyLimit > 0
        ? round2(
            Math.max(
              0,
              Math.min(
                100,
                ((totalDailyLimit - summary.quotaToday.usedTokensToday) / totalDailyLimit) * 100,
              ),
            ),
          )
        : null;

    return c.json({
      ...summary,
      totalDailyLimit,
      usedTokensToday: summary.quotaToday.usedTokensToday,
      remainingTokensToday: summary.quotaToday.remainingTokensToday,
      quotaPercentageRemaining,
      nextResetAt: summary.quotaToday.nextResetAt,
      resetMode: summary.quotaToday.quotaResetMode,
    });
  });

  app.get('/api/metrics/latency', (c) => {
    const user = c.get('user');
    const rawRange = (c.req.query('range') ?? '24h').trim();
    if (!VALID_METRICS_RANGES.has(rawRange)) {
      return c.json(
        { error: 'Invalid range parameter. Expected one of: today, 24h, 7d, 30d.' },
        400,
      );
    }

    const providerId = (c.req.query('providerId') ?? c.req.query('provider') ?? '').trim();
    const modelFullId = (c.req.query('modelFullId') ?? c.req.query('model') ?? '').trim();

    const result = getLatencyMetrics(db, {
      nowSec: nowSeconds(),
      range: rawRange as MetricsRange,
      providerId: providerId || undefined,
      modelFullId: modelFullId || undefined,
      userId: user.role === 'guest' ? user.id : undefined,
    });

    return c.json(result);
  });

  app.get('/api/metrics/speed', (c) => {
    const user = c.get('user');
    const rawRange = (c.req.query('range') ?? '7d').trim();
    if (!VALID_METRICS_RANGES.has(rawRange)) {
      return c.json(
        { error: 'Invalid range parameter. Expected one of: today, 24h, 7d, 30d.' },
        400,
      );
    }

    const result = getSpeedAndCacheMetrics(db, {
      nowSec: nowSeconds(),
      range: rawRange as MetricsRange,
    });

    if (user.role === 'guest') {
      const filteredModels = result.models.filter((m) =>
        isGuestModelAllowed(user.id, m.modelFullId),
      );
      const allowedProviders = new Set(filteredModels.map((m) => m.providerId));
      const filteredProviders = result.providers.filter((p) =>
        allowedProviders.has(p.providerId),
      );
      return c.json({
        range: result.range,
        models: filteredModels,
        providers: filteredProviders,
        cacheByProvider: filteredProviders,
      });
    }

    return c.json(result);
  });

  app.get('/api/metrics/uptime', (c) => {
    const nowSec = nowSeconds();
    const uptime60d = getUptime60Days(db, { nowSec });
    const errRates7d = getProviderErrorRates7d(db, { nowSec });
    const errByProvider = new Map(errRates7d.providers.map((item) => [item.providerId, item]));

    const providers = uptime60d.providers.map((prov) => {
      const err = errByProvider.get(prov.providerId);
      const totalRequests7d = err?.totalRequests ?? 0;
      const toolErrors = err?.toolErrors ?? 0;
      const structuredErrors = err?.structuredErrors ?? 0;
      const toolErrorRate = err?.toolErrorRate ?? null;
      const structuredErrorRate = err?.structuredErrorRate ?? null;

      return {
        ...prov,
        totalRequests7d,
        toolErrors,
        structuredErrors,
        toolErrorRate,
        structuredErrorRate,
        toolErrorRate7d: toolErrorRate,
        structuredErrorRate7d: structuredErrorRate,
      };
    });

    return c.json({
      windowDays: uptime60d.windowDays,
      fromDate: uptime60d.fromDate,
      toDate: uptime60d.toDate,
      providers,
      errorRates7d: errRates7d,
    });
  });

  app.get('/api/metrics/activity', (c) => {
    const user = c.get('user');
    const rawRange = (c.req.query('range') ?? '7d').trim();
    if (!VALID_METRICS_RANGES.has(rawRange)) {
      return c.json(
        { error: 'Invalid range parameter. Expected one of: today, 24h, 7d, 30d.' },
        400,
      );
    }

    const rawGroupBy = (c.req.query('groupBy') ?? 'model').trim();
    if (!VALID_ACTIVITY_GROUP_BY.has(rawGroupBy)) {
      return c.json(
        { error: 'Invalid groupBy parameter. Expected one of: model, provider, user.' },
        400,
      );
    }

    const filterId = (c.req.query('filterId') ?? c.req.query('id') ?? '').trim();
    const result = getTokenActivity(db, {
      nowSec: nowSeconds(),
      range: rawRange as ActivityRange,
      groupBy: rawGroupBy as ActivityGroupBy,
      filterId: filterId || undefined,
      userIdScope: user.role === 'guest' ? user.id : undefined,
    });

    return c.json(result);
  });

  app.get('/api/logs', (c) => {
    const user = c.get('user');
    if (user.role !== 'admin') {
      return c.json({ error: 'Administrator privileges required.' }, 403);
    }

    const rawLevel = (c.req.query('level') ?? '').trim();
    if (rawLevel && !VALID_LOG_LEVELS.has(rawLevel)) {
      return c.json({ error: 'Invalid level parameter. Expected info, warn, or error.' }, 400);
    }

    const rawCategory = (c.req.query('category') ?? '').trim();
    if (rawCategory && !VALID_LOG_CATEGORIES.has(rawCategory)) {
      return c.json({ error: 'Invalid category parameter.' }, 400);
    }

    const q = c.req.query('q');
    const rawLimit = c.req.query('limit');
    const rawOffset = c.req.query('offset');

    const limit = rawLimit !== undefined && rawLimit !== '' ? Number(rawLimit) : 50;
    const offset = rawOffset !== undefined && rawOffset !== '' ? Number(rawOffset) : 0;

    if (!Number.isFinite(limit) || limit < 1) {
      return c.json({ error: 'Invalid limit parameter.' }, 400);
    }
    if (!Number.isFinite(offset) || offset < 0) {
      return c.json({ error: 'Invalid offset parameter.' }, 400);
    }

    const result = querySystemLogs(db, {
      level: (rawLevel || undefined) as SystemLogLevel | undefined,
      category: (rawCategory || undefined) as SystemLogCategory | undefined,
      q: q ?? undefined,
      limit,
      offset,
    });

    return c.json(result);
  });

  // --- Phase 6: Integrated Playground Chat (HU-21, HU-22) ---

  app.post('/api/playground/chat', async (c) => {
    const user = c.get('user');

    let rawBody: Record<string, unknown>;
    try {
      rawBody = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'Invalid JSON request body.', code: 'invalid_json' }, 400);
    }

    return handlePlaygroundChat({
      db,
      masterKey,
      registry,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
      },
      rawBody,
      acceptHeader: c.req.header('accept'),
      signal: c.req.raw.signal,
      fetchImpl,
      upstreamTls: options.upstreamTls,
      now,
      isGuestModelAllowed: (userId, modelFullId) => isGuestModelAllowed(userId, modelFullId),
      isProviderOrAllKeysDraining,
    });
  });

  app.all('/api/*', (c) => {
    return c.json({ error: 'Not Found' }, 404);
  });

  // --- OpenAI-Compatible API /v1/* (HU-03b, HU-09, HU-10, HU-17) ---

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

    // Server-side UTC quota check (100% anchored to server UTC clock; ignores client headers)
    const quotaCheck = checkUserDailyQuotaUtc(db, user.id, nowMs);
    if (quotaCheck.exceeded) {
      return quotaCheck.response;
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
                AND (uma.model_full_id = m.full_id OR uma.model_full_id = '*' OR uma.model_full_id = m.provider_id || '/*')
               WHERE m.active = 1 AND p.enabled = 1
               ORDER BY m.full_id ASC`,
            )
            .all(user.id) as Array<Record<string, unknown>>);

    const data = rows
      .filter((m) => !isProviderOrAllKeysDraining(String(m.provider_id)))
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

    if (user.role === 'guest' && !isGuestModelAllowed(user.id, requestedModel)) {
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

    if (!modelRow || isProviderOrAllKeysDraining(modelRow.provider_id)) {
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
      upstreamTls: options.upstreamTls,
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

  // --- Egress Node One-Command Installer Script (HU-11) ---

  app.get('/install-node.sh', (c) => {
    const candidateScript = path.resolve(import.meta.dirname, '../../nodes/install-node.sh');
    if (fs.existsSync(candidateScript) && fs.statSync(candidateScript).isFile()) {
      const script = fs.readFileSync(candidateScript, 'utf8');
      return c.body(script, 200, { 'Content-Type': 'text/x-shellscript; charset=utf-8' });
    }
    return c.json({ error: 'Node installer script not found on this server.' }, 404);
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
          const headers: Record<string, string> = { 'Content-Type': contentType };
          if (decodedPath === '/sw.js') {
            headers['Service-Worker-Allowed'] = '/';
            headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
          }
          return c.body(body, 200, headers);
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

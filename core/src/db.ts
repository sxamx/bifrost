import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type SystemLogLevel = 'info' | 'warn' | 'error';
export type SystemLogCategory =
  | 'failover'
  | 'stream_resume'
  | 'node'
  | 'sync'
  | 'auth'
  | 'backup'
  | 'system';

const SCHEMA_SQL = `
-- Usuarios, sesiones e invitaciones
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'guest')),
  daily_token_limit INTEGER,
  quota_reset_mode TEXT NOT NULL DEFAULT 'utc_midnight' CHECK (quota_reset_mode IN ('utc_midnight', 'rolling_24h')),
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT UNIQUE NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);

CREATE TABLE IF NOT EXISTS invitations (
  id TEXT PRIMARY KEY,
  token_hash TEXT UNIQUE NOT NULL,
  daily_token_limit INTEGER NOT NULL,
  quota_reset_mode TEXT NOT NULL DEFAULT 'utc_midnight' CHECK (quota_reset_mode IN ('utc_midnight', 'rolling_24h')),
  allowed_models_json TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS user_model_access (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  model_full_id TEXT NOT NULL,
  PRIMARY KEY (user_id, model_full_id)
);

CREATE TABLE IF NOT EXISTS internal_api_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  key_hash TEXT UNIQUE NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_internal_api_keys_user_id ON internal_api_keys(user_id);

-- Nodos de salida
CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('tailscale', 'public_ip')),
  endpoint TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  encrypted_token BLOB,
  tls_fingerprint TEXT,
  prev_token_hash TEXT,
  prev_token_expires_at INTEGER,
  last_seen_at INTEGER,
  last_rotated_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'offline' CHECK (status IN ('online', 'unresponsive', 'offline')),
  created_at INTEGER NOT NULL
);

-- Proveedores instalados y sus cuentas/claves
CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  package_type TEXT NOT NULL CHECK (package_type IN ('official-json', 'experimental-adapter')),
  models_source TEXT NOT NULL CHECK (models_source IN ('api', 'static')),
  schema_json TEXT NOT NULL,
  adapter_url TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_models_sync_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_keys (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  encrypted_secret BLOB NOT NULL,
  last4 TEXT NOT NULL,
  node_id TEXT REFERENCES nodes(id) ON DELETE SET NULL,
  forced_node INTEGER NOT NULL DEFAULT 0,
  daily_quota_limit INTEGER,
  ratelimit_remaining INTEGER,
  ratelimit_reset_at INTEGER,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'rate_limited', 'error', 'no_node')),
  last_error TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_provider_keys_provider_id ON provider_keys(provider_id);

-- Catálogo de modelos detectados
CREATE TABLE IF NOT EXISTS models (
  full_id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL,
  canonical_model_id TEXT,
  name TEXT NOT NULL,
  context_length INTEGER,
  max_output INTEGER,
  modalities_json TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  is_free INTEGER NOT NULL DEFAULT 1,
  first_seen_at INTEGER NOT NULL,
  upstream_created_at INTEGER,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_models_provider_id ON models(provider_id);

-- Telemetría, uso, uptime y logs
CREATE TABLE IF NOT EXISTS usage_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id),
  provider_id TEXT NOT NULL,
  provider_key_id TEXT,
  model_full_id TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  ttft_ms INTEGER,
  duration_ms INTEGER NOT NULL,
  tokens_per_sec REAL,
  status TEXT NOT NULL CHECK (status IN ('ok', 'error', 'resumed')),
  error_type TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_usage_created ON usage_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_usage_user_created ON usage_logs(user_id, created_at);

CREATE TABLE IF NOT EXISTS system_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  level TEXT NOT NULL CHECK (level IN ('info', 'warn', 'error')),
  category TEXT NOT NULL CHECK (category IN ('failover', 'stream_resume', 'node', 'sync', 'auth', 'backup', 'system')),
  message TEXT NOT NULL,
  meta_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_syslogs_created ON system_logs(created_at);

-- Caché de catálogos externos y benchmarks
CREATE TABLE IF NOT EXISTS external_cache (
  cache_key TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  etag TEXT,
  fetched_at INTEGER NOT NULL
);
`;

function ensureNodesColumns(db: DatabaseSync): void {
  const cols = db
    .prepare(`PRAGMA table_info(nodes)`)
    .all() as Array<{ name: string }>;
  const colNames = new Set(cols.map((c) => c.name));

  if (!colNames.has('encrypted_token')) {
    db.exec(`ALTER TABLE nodes ADD COLUMN encrypted_token BLOB;`);
  }
  if (!colNames.has('tls_fingerprint')) {
    db.exec(`ALTER TABLE nodes ADD COLUMN tls_fingerprint TEXT;`);
  }
}

function ensureInvitationsColumns(db: DatabaseSync): void {
  const cols = db
    .prepare(`PRAGMA table_info(invitations)`)
    .all() as Array<{ name: string }>;
  const colNames = new Set(cols.map((c) => c.name));

  if (!colNames.has('quota_reset_mode')) {
    db.exec(
      `ALTER TABLE invitations ADD COLUMN quota_reset_mode TEXT NOT NULL DEFAULT 'utc_midnight' CHECK (quota_reset_mode IN ('utc_midnight', 'rolling_24h'));`,
    );
  }
  if (!colNames.has('created_at')) {
    db.exec(`ALTER TABLE invitations ADD COLUMN created_at INTEGER;`);
  }
}

export function initDatabase(db: DatabaseSync): DatabaseSync {
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA_SQL);
  ensureNodesColumns(db);
  ensureInvitationsColumns(db);
  return db;
}

export function openDatabase(dbPath: string): DatabaseSync {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  return initDatabase(db);
}

const SENSITIVE_FIELD_RE =
  /^(password|password_hash|passwordHash|secret|encrypted_secret|encryptedSecret|rawKey|raw_key|apiKey|api_key|x-api-key|x-goog-api-key|token|token_hash|tokenHash|prev_token_hash|rawToken|raw_token|nodeToken|node_token|newToken|new_token|inviteUrl|invite_url|encrypted_token|encryptedToken|masterKey|master_key|authorization|proxy-authorization|proxy_authorization|cookie)$/i;

export function redactSecretsInText(text: string): string {
  return text
    .replace(/sk-bf-[A-Za-z0-9_-]{6,}/g, 'sk-bf-[REDACTED]')
    .replace(/bfnode_[A-Za-z0-9_-]{6,}/g, 'bfnode_[REDACTED]')
    .replace(/bfn_[A-Za-z0-9_-]{6,}/g, 'bfn_[REDACTED]')
    .replace(/bfi_[A-Za-z0-9_-]{6,}/g, 'bfi_[REDACTED]')
    .replace(/sk-[A-Za-z0-9_-]{10,}/g, 'sk-[REDACTED]')
    .replace(/nvapi-[A-Za-z0-9_-]{10,}/g, 'nvapi-[REDACTED]')
    .replace(/gsk_[A-Za-z0-9_-]{10,}/g, 'gsk_[REDACTED]')
    .replace(/AIza[A-Za-z0-9_-]{16,}/g, 'AIza[REDACTED]')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [REDACTED]')
    .replace(/([?&](?:key|api_key|apikey|token|access_token)=)[^&\s"'#]+/gi, '$1[REDACTED]');
}

function sanitizeLogValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[TRUNCATED]';
  if (typeof value === 'string') {
    return redactSecretsInText(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeLogValue(item, depth + 1));
  }
  if (value !== null && typeof value === 'object') {
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
      return '[BINARY_REDACTED]';
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_FIELD_RE.test(k)) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = sanitizeLogValue(v, depth + 1);
      }
    }
    return out;
  }
  return value;
}

export function writeSystemLog(
  db: DatabaseSync,
  level: SystemLogLevel,
  category: SystemLogCategory,
  message: string,
  meta?: Record<string, unknown>,
  nowSec: number = Math.floor(Date.now() / 1000),
): void {
  const safeMessage = redactSecretsInText(message);
  const safeMetaJson = meta !== undefined ? JSON.stringify(sanitizeLogValue(meta)) : null;

  db.prepare(
    `INSERT INTO system_logs (level, category, message, meta_json, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(level, category, safeMessage, safeMetaJson, nowSec);
}

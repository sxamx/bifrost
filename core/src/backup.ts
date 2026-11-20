import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scrypt,
} from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { gunzipSync, gzipSync } from 'node:zlib';
import { decryptSecret, encryptSecret, sha256Hex } from './crypto.js';
import { writeSystemLog } from './db.js';
import { validateProviderTargetUrl } from './marketplace.js';
import { validateProviderManifest } from './schema.js';

export const BIFROST_BACKUP_MAGIC = Buffer.from('BIFROST1', 'ascii'); // 8 bytes
export const BIFROST_BACKUP_VERSION = 1; // 1 byte
const SALT_BYTES = 16;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const AAD_LENGTH = BIFROST_BACKUP_MAGIC.length + 1 + SALT_BYTES + IV_BYTES; // 37 bytes
export const BIFROST_HEADER_BYTES = AAD_LENGTH + AUTH_TAG_BYTES; // 53 bytes

const BACKUP_SCRYPT_N = 16384;
const BACKUP_SCRYPT_R = 8;
const BACKUP_SCRYPT_P = 1;
const BACKUP_SCRYPT_KEYLEN = 32;
const BACKUP_SCRYPT_MAXMEM = 64 * 1024 * 1024;

export const DEFAULT_MAX_UNCOMPRESSED_BACKUP_BYTES = 50 * 1024 * 1024; // 50 MiB

export class BackupValidationError extends Error {
  public readonly status = 400 as const;

  constructor(message: string) {
    super(message);
    this.name = 'BackupValidationError';
  }
}

export interface ExportBackupOptions {
  db: DatabaseSync;
  masterKey: Buffer;
  password: string;
  actingUserId?: string;
  includeProvidersAndConfig?: boolean;
  includeProviderKeys?: boolean;
  includeUsersAndQuotas?: boolean;
  includeNodes?: boolean;
  includeTelemetry?: boolean;
  includeUsageLogs?: boolean;
  includeSystemLogs?: boolean;
  includeCache?: boolean;
  nowSec?: number;
}

export interface ImportBackupOptions {
  db: DatabaseSync;
  masterKey: Buffer;
  envelope: Buffer | Uint8Array;
  password: string;
  schemasDir?: string;
  actingUserId?: string;
  maxUncompressedBytes?: number;
  nowSec?: number;
}

export interface BackupRestoredCounts {
  users: number;
  invitations: number;
  userModelAccess: number;
  internalApiKeys: number;
  nodes: number;
  providers: number;
  providerKeys: number;
  models: number;
  usageLogs: number;
  systemLogs: number;
  externalCache: number;
}

export interface BackupImportResult {
  ok: true;
  message: string;
  restored: BackupRestoredCounts;
}

interface BackupUserRecord {
  id: string;
  username: string;
  password_hash: string;
  role: 'admin' | 'guest';
  daily_token_limit: number | null;
  quota_reset_mode: 'utc_midnight' | 'rolling_24h';
  enforce_strict_quota?: number;
  created_at: number;
}

interface BackupInvitationRecord {
  id: string;
  token_hash: string;
  daily_token_limit: number;
  quota_reset_mode: 'utc_midnight' | 'rolling_24h';
  enforce_strict_quota?: number;
  allowed_models_json: string;
  expires_at: number;
  used_at: number | null;
  created_by: string;
  created_at: number | null;
}

interface BackupUserModelAccessRecord {
  user_id: string;
  model_full_id: string;
}

interface BackupInternalApiKeyRecord {
  id: string;
  user_id: string;
  name: string;
  key_prefix: string;
  key_hash: string;
  last_used_at: number | null;
  revoked_at: number | null;
  created_at: number;
}

interface BackupNodeRecord {
  id: string;
  name: string;
  mode: 'tailscale' | 'public_ip';
  endpoint: string;
  token_hash: string;
  raw_token: string | null;
  tls_fingerprint: string | null;
  prev_token_hash: string | null;
  prev_token_expires_at: number | null;
  last_seen_at: number | null;
  last_rotated_at: number;
  status: 'online' | 'unresponsive' | 'offline';
  created_at: number;
}

interface BackupProviderRecord {
  id: string;
  name: string;
  package_type: 'official-json' | 'experimental-adapter';
  models_source: 'api' | 'static';
  schema_json: string;
  adapter_url: string | null;
  enabled: number;
  last_models_sync_at: number | null;
  created_at: number;
}

interface BackupProviderKeyRecord {
  id: string;
  provider_id: string;
  label: string;
  secret: string;
  last4: string;
  node_id: string | null;
  forced_node: number;
  daily_quota_limit: number | null;
  ratelimit_remaining: number | null;
  ratelimit_reset_at: number | null;
  status: 'active' | 'rate_limited' | 'error' | 'no_node';
  last_error: string | null;
  created_at: number;
}

interface BackupModelRecord {
  full_id: string;
  provider_id: string;
  model_id: string;
  canonical_model_id: string | null;
  name: string;
  context_length: number | null;
  max_output: number | null;
  modalities_json: string;
  capabilities_json: string;
  is_free: number;
  first_seen_at: number;
  upstream_created_at: number | null;
  active: number;
}

interface BackupUsageLogRecord {
  id: number;
  user_id: string;
  provider_id: string;
  provider_key_id: string | null;
  model_full_id: string;
  prompt_tokens: number;
  completion_tokens: number;
  reasoning_tokens: number;
  cached_tokens: number;
  ttft_ms: number | null;
  duration_ms: number;
  tokens_per_sec: number | null;
  status: 'ok' | 'error' | 'resumed';
  error_type: string | null;
  created_at: number;
}

interface BackupSystemLogRecord {
  id: number;
  level: 'info' | 'warn' | 'error';
  category: 'failover' | 'stream_resume' | 'node' | 'sync' | 'auth' | 'backup' | 'system';
  message: string;
  meta_json: string | null;
  created_at: number;
}

interface BackupExternalCacheRecord {
  cache_key: string;
  payload_json: string;
  etag: string | null;
  fetched_at: number;
}

interface ValidatedBackupPayload {
  format: 'BIFROST1';
  schemaVersion: 1;
  exportedAt: number;
  includeTelemetry: boolean;
  users: BackupUserRecord[];
  invitations: BackupInvitationRecord[];
  userModelAccess: BackupUserModelAccessRecord[];
  internalApiKeys: BackupInternalApiKeyRecord[];
  nodes: BackupNodeRecord[];
  providers: BackupProviderRecord[];
  providerKeys: BackupProviderKeyRecord[];
  models: BackupModelRecord[];
  usageLogs: BackupUsageLogRecord[];
  systemLogs: BackupSystemLogRecord[];
  externalCache: BackupExternalCacheRecord[];
}

const FORBIDDEN_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const ROOT_KEYS = new Set([
  'format',
  'schemaVersion',
  'exportedAt',
  'includeTelemetry',
  'users',
  'invitations',
  'userModelAccess',
  'internalApiKeys',
  'nodes',
  'providers',
  'providerKeys',
  'models',
  'usageLogs',
  'systemLogs',
  'externalCache',
]);

const USER_KEYS = new Set([
  'id',
  'username',
  'password_hash',
  'role',
  'daily_token_limit',
  'quota_reset_mode',
  'enforce_strict_quota',
  'created_at',
]);

const INVITATION_KEYS = new Set([
  'id',
  'token_hash',
  'daily_token_limit',
  'quota_reset_mode',
  'enforce_strict_quota',
  'allowed_models_json',
  'expires_at',
  'used_at',
  'created_by',
  'created_at',
]);

const ACCESS_KEYS = new Set(['user_id', 'model_full_id']);

const INTERNAL_KEY_KEYS = new Set([
  'id',
  'user_id',
  'name',
  'key_prefix',
  'key_hash',
  'last_used_at',
  'revoked_at',
  'created_at',
]);

const NODE_KEYS = new Set([
  'id',
  'name',
  'mode',
  'endpoint',
  'token_hash',
  'raw_token',
  'tls_fingerprint',
  'prev_token_hash',
  'prev_token_expires_at',
  'last_seen_at',
  'last_rotated_at',
  'status',
  'created_at',
]);

const PROVIDER_KEYS = new Set([
  'id',
  'name',
  'package_type',
  'models_source',
  'schema_json',
  'adapter_url',
  'enabled',
  'last_models_sync_at',
  'created_at',
]);

const PROVIDER_KEY_KEYS = new Set([
  'id',
  'provider_id',
  'label',
  'secret',
  'last4',
  'node_id',
  'forced_node',
  'daily_quota_limit',
  'ratelimit_remaining',
  'ratelimit_reset_at',
  'status',
  'last_error',
  'created_at',
]);

const MODEL_KEYS = new Set([
  'full_id',
  'provider_id',
  'model_id',
  'canonical_model_id',
  'name',
  'context_length',
  'max_output',
  'modalities_json',
  'capabilities_json',
  'is_free',
  'first_seen_at',
  'upstream_created_at',
  'active',
]);

const USAGE_LOG_KEYS = new Set([
  'id',
  'user_id',
  'provider_id',
  'provider_key_id',
  'model_full_id',
  'prompt_tokens',
  'completion_tokens',
  'reasoning_tokens',
  'cached_tokens',
  'ttft_ms',
  'duration_ms',
  'tokens_per_sec',
  'status',
  'error_type',
  'created_at',
]);

const SYSTEM_LOG_KEYS = new Set([
  'id',
  'level',
  'category',
  'message',
  'meta_json',
  'created_at',
]);

const CACHE_KEYS = new Set(['cache_key', 'payload_json', 'etag', 'fetched_at']);

function deriveBackupKeyAsync(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      BACKUP_SCRYPT_KEYLEN,
      {
        N: BACKUP_SCRYPT_N,
        r: BACKUP_SCRYPT_R,
        p: BACKUP_SCRYPT_P,
        maxmem: BACKUP_SCRYPT_MAXMEM,
      },
      (err, derivedKey) => {
        if (err) reject(err);
        else resolve(derivedKey);
      },
    );
  });
}

function validateBackupPassword(password: unknown): string {
  if (typeof password !== 'string' || password.length < 8 || password.length > 1024) {
    throw new BackupValidationError(
      'Invalid backup password: password must be between 8 and 1024 characters.',
    );
  }
  return password;
}

function assertNoForbiddenKeysDeep(value: unknown, pathLabel = 'root', depth = 0): void {
  if (depth > 20) {
    throw new BackupValidationError(`Corrupted BIFROST1 payload: excessive nesting at ${pathLabel}.`);
  }
  if (value === null || typeof value !== 'object') {
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      assertNoForbiddenKeysDeep(value[i], `${pathLabel}[${i}]`, depth + 1);
    }
    return;
  }

  const ownKeys = Object.getOwnPropertyNames(value);
  for (const key of ownKeys) {
    if (FORBIDDEN_OBJECT_KEYS.has(key)) {
      throw new BackupValidationError(
        `Invalid BIFROST1 payload: forbidden property "${key}" at ${pathLabel}.`,
      );
    }
    assertNoForbiddenKeysDeep(
      (value as Record<string, unknown>)[key],
      `${pathLabel}.${key}`,
      depth + 1,
    );
  }
}

function assertPlainRecordWithAllowedKeys(
  value: unknown,
  allowedKeys: ReadonlySet<string>,
  label: string,
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new BackupValidationError(`Invalid BIFROST1 payload: ${label} must be an object.`);
  }
  const ownKeys = Object.getOwnPropertyNames(value);
  for (const key of ownKeys) {
    if (FORBIDDEN_OBJECT_KEYS.has(key)) {
      throw new BackupValidationError(
        `Invalid BIFROST1 payload: forbidden property "${key}" in ${label}.`,
      );
    }
    if (!allowedKeys.has(key)) {
      throw new BackupValidationError(
        `Invalid BIFROST1 payload: unexpected property "${key}" in ${label}.`,
      );
    }
  }
  return value as Record<string, unknown>;
}

function reqString(obj: Record<string, unknown>, field: string, label: string, allowEmpty = false): string {
  const val = obj[field];
  if (typeof val !== 'string' || (!allowEmpty && val.length === 0)) {
    throw new BackupValidationError(
      `Invalid BIFROST1 payload: "${label}.${field}" must be a${allowEmpty ? '' : ' non-empty'} string.`,
    );
  }
  return val;
}

function optString(obj: Record<string, unknown>, field: string, label: string): string | null {
  const val = obj[field];
  if (val === undefined || val === null) return null;
  if (typeof val !== 'string') {
    throw new BackupValidationError(
      `Invalid BIFROST1 payload: "${label}.${field}" must be a string or null.`,
    );
  }
  return val;
}

function reqInt(obj: Record<string, unknown>, field: string, label: string): number {
  const val = obj[field];
  if (typeof val !== 'number' || !Number.isInteger(val)) {
    throw new BackupValidationError(
      `Invalid BIFROST1 payload: "${label}.${field}" must be an integer.`,
    );
  }
  return val;
}

function optInt(obj: Record<string, unknown>, field: string, label: string): number | null {
  const val = obj[field];
  if (val === undefined || val === null) return null;
  if (typeof val !== 'number' || !Number.isInteger(val)) {
    throw new BackupValidationError(
      `Invalid BIFROST1 payload: "${label}.${field}" must be an integer or null.`,
    );
  }
  return val;
}

function optNum(obj: Record<string, unknown>, field: string, label: string): number | null {
  const val = obj[field];
  if (val === undefined || val === null) return null;
  if (typeof val !== 'number' || !Number.isFinite(val)) {
    throw new BackupValidationError(
      `Invalid BIFROST1 payload: "${label}.${field}" must be a finite number or null.`,
    );
  }
  return val;
}

function reqEnum<T extends string>(
  obj: Record<string, unknown>,
  field: string,
  allowed: readonly T[],
  label: string,
): T {
  const val = obj[field];
  if (typeof val !== 'string' || !(allowed as readonly string[]).includes(val)) {
    throw new BackupValidationError(
      `Invalid BIFROST1 payload: "${label}.${field}" must be one of [${allowed.join(', ')}].`,
    );
  }
  return val as T;
}

function reqArray(obj: Record<string, unknown>, field: string): unknown[] {
  const val = obj[field];
  if (val === undefined) return [];
  if (!Array.isArray(val)) {
    throw new BackupValidationError(`Invalid BIFROST1 payload: "${field}" must be an array.`);
  }
  return val;
}

/**
 * Packs a JSON string or serializable payload into a `BIFROST1` binary envelope:
 * `8B magic ("BIFROST1") || 1B version (0x01) || 16B salt || 12B iv || 16B authTag || ciphertext(gzip(json))`
 */
export async function packBifrostEnvelope(
  payloadOrJson: unknown,
  password: string,
): Promise<Buffer> {
  const validPassword = validateBackupPassword(password);
  const jsonText =
    typeof payloadOrJson === 'string' ? payloadOrJson : JSON.stringify(payloadOrJson);
  const compressed = gzipSync(Buffer.from(jsonText, 'utf8'));

  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const versionBuf = Buffer.from([BIFROST_BACKUP_VERSION]);
  const aad = Buffer.concat([BIFROST_BACKUP_MAGIC, versionBuf, salt, iv]);

  const derivedKey = await deriveBackupKeyAsync(validPassword, salt);
  const cipher = createCipheriv('aes-256-gcm', derivedKey, iv, {
    authTagLength: AUTH_TAG_BYTES,
  });
  cipher.setAAD(aad);

  const ciphertext = Buffer.concat([cipher.update(compressed), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return Buffer.concat([aad, authTag, ciphertext]);
}

/**
 * Verifies header bounds, `BIFROST1` magic, format version, AES-256-GCM authentication tag,
 * and bounded gunzip decompression before returning the UTF-8 JSON payload.
 */
export async function unpackBifrostEnvelopeRaw(
  envelopeInput: Buffer | Uint8Array,
  password: string,
  maxUncompressedBytes: number = DEFAULT_MAX_UNCOMPRESSED_BACKUP_BYTES,
): Promise<string> {
  const validPassword = validateBackupPassword(password);
  const buf = Buffer.isBuffer(envelopeInput)
    ? envelopeInput
    : Buffer.from(envelopeInput.buffer, envelopeInput.byteOffset, envelopeInput.byteLength);

  if (buf.byteLength < BIFROST_HEADER_BYTES + 1) {
    throw new BackupValidationError(
      'Corrupted BIFROST1 backup file: envelope is truncated or smaller than minimum header size.',
    );
  }

  if (buf.byteLength > maxUncompressedBytes + 1024) {
    throw new BackupValidationError(
      `Backup file exceeds maximum allowed size (${maxUncompressedBytes} bytes).`,
    );
  }

  const magic = buf.subarray(0, BIFROST_BACKUP_MAGIC.length);
  if (!magic.equals(BIFROST_BACKUP_MAGIC)) {
    throw new BackupValidationError(
      'Invalid BIFROST1 magic header: file is not a valid .bifrost.enc backup.',
    );
  }

  const version = buf[BIFROST_BACKUP_MAGIC.length];
  if (version !== BIFROST_BACKUP_VERSION) {
    throw new BackupValidationError(
      `Unsupported BIFROST1 backup format version: ${String(version)}.`,
    );
  }

  const saltOffset = BIFROST_BACKUP_MAGIC.length + 1;
  const ivOffset = saltOffset + SALT_BYTES;
  const tagOffset = ivOffset + IV_BYTES;
  const ciphertextOffset = tagOffset + AUTH_TAG_BYTES;

  const salt = buf.subarray(saltOffset, ivOffset);
  const iv = buf.subarray(ivOffset, tagOffset);
  const authTag = buf.subarray(tagOffset, ciphertextOffset);
  const ciphertext = buf.subarray(ciphertextOffset);
  const aad = buf.subarray(0, AAD_LENGTH);

  let decryptedCompressed: Buffer;
  try {
    const derivedKey = await deriveBackupKeyAsync(validPassword, salt);
    const decipher = createDecipheriv('aes-256-gcm', derivedKey, iv, {
      authTagLength: AUTH_TAG_BYTES,
    });
    decipher.setAAD(aad);
    decipher.setAuthTag(authTag);
    decryptedCompressed = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new BackupValidationError(
      'Failed to decrypt BIFROST1 backup: invalid backup password, corrupted ciphertext, or authentication tag mismatch.',
    );
  }

  let decompressed: Buffer;
  try {
    decompressed = gunzipSync(decryptedCompressed, {
      maxOutputLength: maxUncompressedBytes,
    });
  } catch {
    throw new BackupValidationError(
      'Corrupted BIFROST1 backup payload: gzip decompression failed or exceeded maximum uncompressed size.',
    );
  }

  return decompressed.toString('utf8');
}

function validateBackupJsonPayload(
  rawJson: string,
  schemasDir?: string,
): ValidatedBackupPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson) as unknown;
  } catch {
    throw new BackupValidationError('Corrupted BIFROST1 backup payload: malformed JSON.');
  }

  assertNoForbiddenKeysDeep(parsed);
  const root = assertPlainRecordWithAllowedKeys(parsed, ROOT_KEYS, 'root');

  if (root.format !== 'BIFROST1') {
    throw new BackupValidationError('Invalid BIFROST1 payload: "format" must be "BIFROST1".');
  }
  if (root.schemaVersion !== 1) {
    throw new BackupValidationError('Invalid BIFROST1 payload: "schemaVersion" must be 1.');
  }
  const exportedAt = reqInt(root, 'exportedAt', 'root');
  if (typeof root.includeTelemetry !== 'boolean') {
    throw new BackupValidationError(
      'Invalid BIFROST1 payload: "includeTelemetry" must be a boolean.',
    );
  }

  const users: BackupUserRecord[] = reqArray(root, 'users').map((item, i) => {
    const r = assertPlainRecordWithAllowedKeys(item, USER_KEYS, `users[${i}]`);
    return {
      id: reqString(r, 'id', `users[${i}]`),
      username: reqString(r, 'username', `users[${i}]`),
      password_hash: reqString(r, 'password_hash', `users[${i}]`),
      role: reqEnum(r, 'role', ['admin', 'guest'] as const, `users[${i}]`),
      daily_token_limit: optInt(r, 'daily_token_limit', `users[${i}]`),
      quota_reset_mode: reqEnum(
        r,
        'quota_reset_mode',
        ['utc_midnight', 'rolling_24h'] as const,
        `users[${i}]`,
      ),
      enforce_strict_quota:
        r.enforce_strict_quota === undefined
          ? 1
          : reqInt(r, 'enforce_strict_quota', `users[${i}]`) === 0
            ? 0
            : 1,
      created_at: reqInt(r, 'created_at', `users[${i}]`),
    };
  });

  const invitations: BackupInvitationRecord[] = reqArray(root, 'invitations').map((item, i) => {
    const r = assertPlainRecordWithAllowedKeys(item, INVITATION_KEYS, `invitations[${i}]`);
    const allowedModelsJson = reqString(r, 'allowed_models_json', `invitations[${i}]`);
    let parsedAllowed: unknown;
    try {
      parsedAllowed = JSON.parse(allowedModelsJson) as unknown;
    } catch {
      throw new BackupValidationError(
        `Invalid BIFROST1 payload: "invitations[${i}].allowed_models_json" is not valid JSON.`,
      );
    }
    if (!Array.isArray(parsedAllowed) || !parsedAllowed.every((m) => typeof m === 'string')) {
      throw new BackupValidationError(
        `Invalid BIFROST1 payload: "invitations[${i}].allowed_models_json" must be a JSON string array.`,
      );
    }
    return {
      id: reqString(r, 'id', `invitations[${i}]`),
      token_hash: reqString(r, 'token_hash', `invitations[${i}]`),
      daily_token_limit: reqInt(r, 'daily_token_limit', `invitations[${i}]`),
      quota_reset_mode:
        r.quota_reset_mode === undefined
          ? 'utc_midnight'
          : reqEnum(
              r,
              'quota_reset_mode',
              ['utc_midnight', 'rolling_24h'] as const,
              `invitations[${i}]`,
            ),
      enforce_strict_quota:
        r.enforce_strict_quota === undefined
          ? 1
          : reqInt(r, 'enforce_strict_quota', `invitations[${i}]`) === 0
            ? 0
            : 1,
      allowed_models_json: allowedModelsJson,
      expires_at: reqInt(r, 'expires_at', `invitations[${i}]`),
      used_at: optInt(r, 'used_at', `invitations[${i}]`),
      created_by: reqString(r, 'created_by', `invitations[${i}]`),
      created_at: optInt(r, 'created_at', `invitations[${i}]`),
    };
  });

  const userModelAccess: BackupUserModelAccessRecord[] = reqArray(
    root,
    'userModelAccess',
  ).map((item, i) => {
    const r = assertPlainRecordWithAllowedKeys(item, ACCESS_KEYS, `userModelAccess[${i}]`);
    return {
      user_id: reqString(r, 'user_id', `userModelAccess[${i}]`),
      model_full_id: reqString(r, 'model_full_id', `userModelAccess[${i}]`),
    };
  });

  const internalApiKeys: BackupInternalApiKeyRecord[] = reqArray(
    root,
    'internalApiKeys',
  ).map((item, i) => {
    const r = assertPlainRecordWithAllowedKeys(
      item,
      INTERNAL_KEY_KEYS,
      `internalApiKeys[${i}]`,
    );
    return {
      id: reqString(r, 'id', `internalApiKeys[${i}]`),
      user_id: reqString(r, 'user_id', `internalApiKeys[${i}]`),
      name: reqString(r, 'name', `internalApiKeys[${i}]`),
      key_prefix: reqString(r, 'key_prefix', `internalApiKeys[${i}]`),
      key_hash: reqString(r, 'key_hash', `internalApiKeys[${i}]`),
      last_used_at: optInt(r, 'last_used_at', `internalApiKeys[${i}]`),
      revoked_at: optInt(r, 'revoked_at', `internalApiKeys[${i}]`),
      created_at: reqInt(r, 'created_at', `internalApiKeys[${i}]`),
    };
  });

  const nodes: BackupNodeRecord[] = reqArray(root, 'nodes').map((item, i) => {
    const r = assertPlainRecordWithAllowedKeys(item, NODE_KEYS, `nodes[${i}]`);
    return {
      id: reqString(r, 'id', `nodes[${i}]`),
      name: reqString(r, 'name', `nodes[${i}]`),
      mode: reqEnum(r, 'mode', ['tailscale', 'public_ip'] as const, `nodes[${i}]`),
      endpoint: reqString(r, 'endpoint', `nodes[${i}]`),
      token_hash: reqString(r, 'token_hash', `nodes[${i}]`),
      raw_token: optString(r, 'raw_token', `nodes[${i}]`),
      tls_fingerprint: optString(r, 'tls_fingerprint', `nodes[${i}]`),
      prev_token_hash: optString(r, 'prev_token_hash', `nodes[${i}]`),
      prev_token_expires_at: optInt(r, 'prev_token_expires_at', `nodes[${i}]`),
      last_seen_at: optInt(r, 'last_seen_at', `nodes[${i}]`),
      last_rotated_at: reqInt(r, 'last_rotated_at', `nodes[${i}]`),
      status: reqEnum(
        r,
        'status',
        ['online', 'unresponsive', 'offline'] as const,
        `nodes[${i}]`,
      ),
      created_at: reqInt(r, 'created_at', `nodes[${i}]`),
    };
  });

  const providers: BackupProviderRecord[] = reqArray(root, 'providers').map((item, i) => {
    const r = assertPlainRecordWithAllowedKeys(item, PROVIDER_KEYS, `providers[${i}]`);
    const id = reqString(r, 'id', `providers[${i}]`);
    const packageType = reqEnum(
      r,
      'package_type',
      ['official-json', 'experimental-adapter'] as const,
      `providers[${i}]`,
    );
    const modelsSource = reqEnum(
      r,
      'models_source',
      ['api', 'static'] as const,
      `providers[${i}]`,
    );
    const schemaJson = reqString(r, 'schema_json', `providers[${i}]`);
    const adapterUrl = optString(r, 'adapter_url', `providers[${i}]`);
    const enabled = reqInt(r, 'enabled', `providers[${i}]`);
    if (enabled !== 0 && enabled !== 1) {
      throw new BackupValidationError(
        `Invalid BIFROST1 payload: "providers[${i}].enabled" must be 0 or 1.`,
      );
    }

    let manifestObj: unknown;
    try {
      manifestObj = JSON.parse(schemaJson) as unknown;
    } catch {
      throw new BackupValidationError(
        `Invalid BIFROST1 payload: "providers[${i}].schema_json" is not valid JSON.`,
      );
    }
    assertNoForbiddenKeysDeep(manifestObj, `providers[${i}].schema_json`);

    const manifestValidation = validateProviderManifest(manifestObj, schemasDir);
    if (!manifestValidation.valid) {
      throw new BackupValidationError(
        `Invalid provider manifest in backup for "${id}": ${manifestValidation.errors.join('; ')}`,
      );
    }

    if (adapterUrl !== null) {
      const adapterCheck = validateProviderTargetUrl(
        adapterUrl,
        'experimental-adapter',
        'adapterUrl',
      );
      if (!adapterCheck.valid) {
        throw new BackupValidationError(
          `Unsafe adapterUrl in backup for "${id}": ${adapterCheck.error}`,
        );
      }
    }

    return {
      id,
      name: reqString(r, 'name', `providers[${i}]`),
      package_type: packageType,
      models_source: modelsSource,
      schema_json: schemaJson,
      adapter_url: adapterUrl,
      enabled,
      last_models_sync_at: optInt(r, 'last_models_sync_at', `providers[${i}]`),
      created_at: reqInt(r, 'created_at', `providers[${i}]`),
    };
  });

  const providerKeys: BackupProviderKeyRecord[] = reqArray(root, 'providerKeys').map(
    (item, i) => {
      const r = assertPlainRecordWithAllowedKeys(
        item,
        PROVIDER_KEY_KEYS,
        `providerKeys[${i}]`,
      );
      const forcedNode = reqInt(r, 'forced_node', `providerKeys[${i}]`);
      if (forcedNode !== 0 && forcedNode !== 1) {
        throw new BackupValidationError(
          `Invalid BIFROST1 payload: "providerKeys[${i}].forced_node" must be 0 or 1.`,
        );
      }
      return {
        id: reqString(r, 'id', `providerKeys[${i}]`),
        provider_id: reqString(r, 'provider_id', `providerKeys[${i}]`),
        label: reqString(r, 'label', `providerKeys[${i}]`),
        secret: reqString(r, 'secret', `providerKeys[${i}]`),
        last4: reqString(r, 'last4', `providerKeys[${i}]`),
        node_id: optString(r, 'node_id', `providerKeys[${i}]`),
        forced_node: forcedNode,
        daily_quota_limit: optInt(r, 'daily_quota_limit', `providerKeys[${i}]`),
        ratelimit_remaining: optInt(r, 'ratelimit_remaining', `providerKeys[${i}]`),
        ratelimit_reset_at: optInt(r, 'ratelimit_reset_at', `providerKeys[${i}]`),
        status: reqEnum(
          r,
          'status',
          ['active', 'rate_limited', 'error', 'no_node'] as const,
          `providerKeys[${i}]`,
        ),
        last_error: optString(r, 'last_error', `providerKeys[${i}]`),
        created_at: reqInt(r, 'created_at', `providerKeys[${i}]`),
      };
    },
  );

  const models: BackupModelRecord[] = reqArray(root, 'models').map((item, i) => {
    const r = assertPlainRecordWithAllowedKeys(item, MODEL_KEYS, `models[${i}]`);
    const isFree = reqInt(r, 'is_free', `models[${i}]`);
    const active = reqInt(r, 'active', `models[${i}]`);
    if ((isFree !== 0 && isFree !== 1) || (active !== 0 && active !== 1)) {
      throw new BackupValidationError(
        `Invalid BIFROST1 payload: "models[${i}]" boolean flags must be 0 or 1.`,
      );
    }
    return {
      full_id: reqString(r, 'full_id', `models[${i}]`),
      provider_id: reqString(r, 'provider_id', `models[${i}]`),
      model_id: reqString(r, 'model_id', `models[${i}]`),
      canonical_model_id: optString(r, 'canonical_model_id', `models[${i}]`),
      name: reqString(r, 'name', `models[${i}]`),
      context_length: optInt(r, 'context_length', `models[${i}]`),
      max_output: optInt(r, 'max_output', `models[${i}]`),
      modalities_json: reqString(r, 'modalities_json', `models[${i}]`),
      capabilities_json: reqString(r, 'capabilities_json', `models[${i}]`),
      is_free: isFree,
      first_seen_at: reqInt(r, 'first_seen_at', `models[${i}]`),
      upstream_created_at: optInt(r, 'upstream_created_at', `models[${i}]`),
      active,
    };
  });

  const usageLogs: BackupUsageLogRecord[] = reqArray(root, 'usageLogs').map((item, i) => {
    const r = assertPlainRecordWithAllowedKeys(item, USAGE_LOG_KEYS, `usageLogs[${i}]`);
    return {
      id: reqInt(r, 'id', `usageLogs[${i}]`),
      user_id: reqString(r, 'user_id', `usageLogs[${i}]`),
      provider_id: reqString(r, 'provider_id', `usageLogs[${i}]`),
      provider_key_id: optString(r, 'provider_key_id', `usageLogs[${i}]`),
      model_full_id: reqString(r, 'model_full_id', `usageLogs[${i}]`),
      prompt_tokens: reqInt(r, 'prompt_tokens', `usageLogs[${i}]`),
      completion_tokens: reqInt(r, 'completion_tokens', `usageLogs[${i}]`),
      reasoning_tokens: reqInt(r, 'reasoning_tokens', `usageLogs[${i}]`),
      cached_tokens: reqInt(r, 'cached_tokens', `usageLogs[${i}]`),
      ttft_ms: optInt(r, 'ttft_ms', `usageLogs[${i}]`),
      duration_ms: reqInt(r, 'duration_ms', `usageLogs[${i}]`),
      tokens_per_sec: optNum(r, 'tokens_per_sec', `usageLogs[${i}]`),
      status: reqEnum(r, 'status', ['ok', 'error', 'resumed'] as const, `usageLogs[${i}]`),
      error_type: optString(r, 'error_type', `usageLogs[${i}]`),
      created_at: reqInt(r, 'created_at', `usageLogs[${i}]`),
    };
  });

  const systemLogs: BackupSystemLogRecord[] = reqArray(root, 'systemLogs').map((item, i) => {
    const r = assertPlainRecordWithAllowedKeys(item, SYSTEM_LOG_KEYS, `systemLogs[${i}]`);
    return {
      id: reqInt(r, 'id', `systemLogs[${i}]`),
      level: reqEnum(r, 'level', ['info', 'warn', 'error'] as const, `systemLogs[${i}]`),
      category: reqEnum(
        r,
        'category',
        ['failover', 'stream_resume', 'node', 'sync', 'auth', 'backup', 'system'] as const,
        `systemLogs[${i}]`,
      ),
      message: reqString(r, 'message', `systemLogs[${i}]`, true),
      meta_json: optString(r, 'meta_json', `systemLogs[${i}]`),
      created_at: reqInt(r, 'created_at', `systemLogs[${i}]`),
    };
  });

  const externalCache: BackupExternalCacheRecord[] = reqArray(root, 'externalCache').map(
    (item, i) => {
      const r = assertPlainRecordWithAllowedKeys(item, CACHE_KEYS, `externalCache[${i}]`);
      return {
        cache_key: reqString(r, 'cache_key', `externalCache[${i}]`),
        payload_json: reqString(r, 'payload_json', `externalCache[${i}]`, true),
        etag: optString(r, 'etag', `externalCache[${i}]`),
        fetched_at: reqInt(r, 'fetched_at', `externalCache[${i}]`),
      };
    },
  );

  return {
    format: 'BIFROST1',
    schemaVersion: 1,
    exportedAt,
    includeTelemetry: root.includeTelemetry,
    users,
    invitations,
    userModelAccess,
    internalApiKeys,
    nodes,
    providers,
    providerKeys,
    models,
    usageLogs,
    systemLogs,
    externalCache,
  };
}

/**
 * HU-25: Exports an encrypted `.bifrost.enc` (`BIFROST1`) backup snapshot.
 * Decrypts `provider_keys.encrypted_secret` and `nodes.encrypted_token` with the source
 * server's `masterKey` so they can be re-encrypted with the destination `masterKey` on import.
 */
export async function exportEncryptedBackup(
  options: ExportBackupOptions,
): Promise<Buffer> {
  const {
    db,
    masterKey,
    password,
    actingUserId,
    includeProvidersAndConfig = true,
    includeProviderKeys = true,
    includeUsersAndQuotas = true,
    includeNodes = true,
    includeTelemetry = false,
    includeUsageLogs,
    includeSystemLogs,
    includeCache = false,
    nowSec = Math.floor(Date.now() / 1000),
  } = options;

  validateBackupPassword(password);

  const exportUsage = includeUsageLogs ?? includeTelemetry;
  const exportSysLogs = includeSystemLogs ?? includeTelemetry;

  const users: BackupUserRecord[] = includeUsersAndQuotas
    ? (
        db
          .prepare(
            `SELECT id, username, password_hash, role, daily_token_limit, quota_reset_mode, enforce_strict_quota, created_at
             FROM users
             ORDER BY created_at ASC`,
          )
          .all() as Array<Record<string, unknown>>
      ).map((r) => ({
        id: String(r.id),
        username: String(r.username),
        password_hash: String(r.password_hash),
        role: r.role === 'admin' ? 'admin' : 'guest',
        daily_token_limit:
          r.daily_token_limit === null || r.daily_token_limit === undefined
            ? null
            : Number(r.daily_token_limit),
        quota_reset_mode:
          r.quota_reset_mode === 'rolling_24h' ? 'rolling_24h' : 'utc_midnight',
        enforce_strict_quota:
          r.enforce_strict_quota === undefined || r.enforce_strict_quota === null
            ? 1
            : Number(r.enforce_strict_quota) === 0
              ? 0
              : 1,
        created_at: Number(r.created_at),
      }))
    : [];

  const invitations: BackupInvitationRecord[] = includeUsersAndQuotas
    ? (
        db
          .prepare(
            `SELECT id, token_hash, daily_token_limit, quota_reset_mode, enforce_strict_quota, allowed_models_json,
                    expires_at, used_at, created_by, created_at
             FROM invitations
             ORDER BY COALESCE(created_at, expires_at) ASC`,
          )
          .all() as Array<Record<string, unknown>>
      ).map((r) => ({
        id: String(r.id),
        token_hash: String(r.token_hash),
        daily_token_limit: Number(r.daily_token_limit),
        quota_reset_mode:
          r.quota_reset_mode === 'rolling_24h' ? 'rolling_24h' : 'utc_midnight',
        enforce_strict_quota:
          r.enforce_strict_quota === undefined || r.enforce_strict_quota === null
            ? 1
            : Number(r.enforce_strict_quota) === 0
              ? 0
              : 1,
        allowed_models_json: String(r.allowed_models_json),
        expires_at: Number(r.expires_at),
        used_at: r.used_at === null || r.used_at === undefined ? null : Number(r.used_at),
        created_by: String(r.created_by),
        created_at:
          r.created_at === null || r.created_at === undefined ? null : Number(r.created_at),
      }))
    : [];

  const userModelAccess: BackupUserModelAccessRecord[] = includeUsersAndQuotas
    ? (
        db
          .prepare(
            `SELECT user_id, model_full_id
             FROM user_model_access
             ORDER BY user_id ASC, model_full_id ASC`,
          )
          .all() as Array<Record<string, unknown>>
      ).map((r) => ({
        user_id: String(r.user_id),
        model_full_id: String(r.model_full_id),
      }))
    : [];

  const internalApiKeys: BackupInternalApiKeyRecord[] = includeUsersAndQuotas
    ? (
        db
          .prepare(
            `SELECT id, user_id, name, key_prefix, key_hash, last_used_at, revoked_at, created_at
             FROM internal_api_keys
             ORDER BY created_at ASC`,
          )
          .all() as Array<Record<string, unknown>>
      ).map((r) => ({
        id: String(r.id),
        user_id: String(r.user_id),
        name: String(r.name),
        key_prefix: String(r.key_prefix),
        key_hash: String(r.key_hash),
        last_used_at:
          r.last_used_at === null || r.last_used_at === undefined
            ? null
            : Number(r.last_used_at),
        revoked_at:
          r.revoked_at === null || r.revoked_at === undefined
            ? null
            : Number(r.revoked_at),
        created_at: Number(r.created_at),
      }))
    : [];

  const nodes: BackupNodeRecord[] = includeNodes
    ? (
        db
          .prepare(
            `SELECT id, name, mode, endpoint, token_hash, encrypted_token, tls_fingerprint,
                    prev_token_hash, prev_token_expires_at, last_seen_at, last_rotated_at,
                    status, created_at
             FROM nodes
             ORDER BY created_at ASC`,
          )
          .all() as Array<Record<string, unknown>>
      ).map((r) => {
        let rawToken: string | null = null;
        if (r.encrypted_token instanceof Uint8Array || Buffer.isBuffer(r.encrypted_token)) {
          rawToken = decryptSecret(r.encrypted_token, masterKey);
        }
        return {
          id: String(r.id),
          name: String(r.name),
          mode: r.mode === 'public_ip' ? 'public_ip' : 'tailscale',
          endpoint: String(r.endpoint),
          token_hash: String(r.token_hash),
          raw_token: rawToken,
          tls_fingerprint:
            r.tls_fingerprint === null || r.tls_fingerprint === undefined
              ? null
              : String(r.tls_fingerprint),
          prev_token_hash:
            r.prev_token_hash === null || r.prev_token_hash === undefined
              ? null
              : String(r.prev_token_hash),
          prev_token_expires_at:
            r.prev_token_expires_at === null || r.prev_token_expires_at === undefined
              ? null
              : Number(r.prev_token_expires_at),
          last_seen_at:
            r.last_seen_at === null || r.last_seen_at === undefined
              ? null
              : Number(r.last_seen_at),
          last_rotated_at: Number(r.last_rotated_at),
          status:
            r.status === 'online' || r.status === 'unresponsive' ? r.status : 'offline',
          created_at: Number(r.created_at),
        };
      })
    : [];

  const providers: BackupProviderRecord[] = includeProvidersAndConfig
    ? (
        db
          .prepare(
            `SELECT id, name, package_type, models_source, schema_json, adapter_url,
                    enabled, last_models_sync_at, created_at
             FROM providers
             ORDER BY created_at ASC`,
          )
          .all() as Array<Record<string, unknown>>
      ).map((r) => ({
        id: String(r.id),
        name: String(r.name),
        package_type:
          r.package_type === 'experimental-adapter'
            ? 'experimental-adapter'
            : 'official-json',
        models_source: r.models_source === 'static' ? 'static' : 'api',
        schema_json: String(r.schema_json),
        adapter_url:
          r.adapter_url === null || r.adapter_url === undefined
            ? null
            : String(r.adapter_url),
        enabled: Number(r.enabled) === 1 ? 1 : 0,
        last_models_sync_at:
          r.last_models_sync_at === null || r.last_models_sync_at === undefined
            ? null
            : Number(r.last_models_sync_at),
        created_at: Number(r.created_at),
      }))
    : [];

  const providerKeys: BackupProviderKeyRecord[] =
    includeProvidersAndConfig && includeProviderKeys
      ? (
          db
            .prepare(
              `SELECT id, provider_id, label, encrypted_secret, last4, node_id, forced_node,
                      daily_quota_limit, ratelimit_remaining, ratelimit_reset_at,
                      status, last_error, created_at
               FROM provider_keys
               ORDER BY created_at ASC`,
            )
            .all() as Array<Record<string, unknown>>
        ).map((r) => {
          const blob = r.encrypted_secret as Uint8Array | Buffer;
          const plaintextSecret = decryptSecret(blob, masterKey);
          return {
            id: String(r.id),
            provider_id: String(r.provider_id),
            label: String(r.label),
            secret: plaintextSecret,
            last4: String(r.last4),
            node_id:
              includeNodes && r.node_id !== null && r.node_id !== undefined
                ? String(r.node_id)
                : null,
            forced_node: Number(r.forced_node) === 1 ? 1 : 0,
            daily_quota_limit:
              r.daily_quota_limit === null || r.daily_quota_limit === undefined
                ? null
                : Number(r.daily_quota_limit),
            ratelimit_remaining:
              r.ratelimit_remaining === null || r.ratelimit_remaining === undefined
                ? null
                : Number(r.ratelimit_remaining),
            ratelimit_reset_at:
              r.ratelimit_reset_at === null || r.ratelimit_reset_at === undefined
                ? null
                : Number(r.ratelimit_reset_at),
            status:
              r.status === 'rate_limited' || r.status === 'error' || r.status === 'no_node'
                ? r.status
                : 'active',
            last_error:
              r.last_error === null || r.last_error === undefined
                ? null
                : String(r.last_error),
            created_at: Number(r.created_at),
          };
        })
      : [];

  const models: BackupModelRecord[] = includeProvidersAndConfig
    ? (
        db
          .prepare(
            `SELECT full_id, provider_id, model_id, canonical_model_id, name,
                    context_length, max_output, modalities_json, capabilities_json,
                    is_free, first_seen_at, upstream_created_at, active
             FROM models
             ORDER BY full_id ASC`,
          )
          .all() as Array<Record<string, unknown>>
      ).map((r) => ({
        full_id: String(r.full_id),
        provider_id: String(r.provider_id),
        model_id: String(r.model_id),
        canonical_model_id:
          r.canonical_model_id === null || r.canonical_model_id === undefined
            ? null
            : String(r.canonical_model_id),
        name: String(r.name),
        context_length:
          r.context_length === null || r.context_length === undefined
            ? null
            : Number(r.context_length),
        max_output:
          r.max_output === null || r.max_output === undefined ? null : Number(r.max_output),
        modalities_json: String(r.modalities_json),
        capabilities_json: String(r.capabilities_json),
        is_free: Number(r.is_free) === 1 ? 1 : 0,
        first_seen_at: Number(r.first_seen_at),
        upstream_created_at:
          r.upstream_created_at === null || r.upstream_created_at === undefined
            ? null
            : Number(r.upstream_created_at),
        active: Number(r.active) === 1 ? 1 : 0,
      }))
    : [];

  const usageLogs: BackupUsageLogRecord[] = exportUsage
    ? (
        db
          .prepare(
            `SELECT id, user_id, provider_id, provider_key_id, model_full_id,
                    prompt_tokens, completion_tokens, reasoning_tokens, cached_tokens,
                    ttft_ms, duration_ms, tokens_per_sec, status, error_type, created_at
             FROM usage_logs
             ORDER BY id ASC`,
          )
          .all() as Array<Record<string, unknown>>
      ).map((r) => ({
        id: Number(r.id),
        user_id: String(r.user_id),
        provider_id: String(r.provider_id),
        provider_key_id:
          r.provider_key_id === null || r.provider_key_id === undefined
            ? null
            : String(r.provider_key_id),
        model_full_id: String(r.model_full_id),
        prompt_tokens: Number(r.prompt_tokens),
        completion_tokens: Number(r.completion_tokens),
        reasoning_tokens: Number(r.reasoning_tokens),
        cached_tokens: Number(r.cached_tokens),
        ttft_ms: r.ttft_ms === null || r.ttft_ms === undefined ? null : Number(r.ttft_ms),
        duration_ms: Number(r.duration_ms),
        tokens_per_sec:
          r.tokens_per_sec === null || r.tokens_per_sec === undefined
            ? null
            : Number(r.tokens_per_sec),
        status: r.status === 'error' || r.status === 'resumed' ? r.status : 'ok',
        error_type:
          r.error_type === null || r.error_type === undefined ? null : String(r.error_type),
        created_at: Number(r.created_at),
      }))
    : [];

  const systemLogs: BackupSystemLogRecord[] = exportSysLogs
    ? (
        db
          .prepare(
            `SELECT id, level, category, message, meta_json, created_at
             FROM system_logs
             ORDER BY id ASC`,
          )
          .all() as Array<Record<string, unknown>>
      ).map((r) => ({
        id: Number(r.id),
        level: r.level === 'warn' || r.level === 'error' ? r.level : 'info',
        category: (
          ['failover', 'stream_resume', 'node', 'sync', 'auth', 'backup', 'system'] as const
        ).includes(r.category as BackupSystemLogRecord['category'])
          ? (r.category as BackupSystemLogRecord['category'])
          : 'system',
        message: String(r.message),
        meta_json:
          r.meta_json === null || r.meta_json === undefined ? null : String(r.meta_json),
        created_at: Number(r.created_at),
      }))
    : [];

  const externalCache: BackupExternalCacheRecord[] = includeCache
    ? (
        db
          .prepare(
            `SELECT cache_key, payload_json, etag, fetched_at
             FROM external_cache
             ORDER BY cache_key ASC`,
          )
          .all() as Array<Record<string, unknown>>
      ).map((r) => ({
        cache_key: String(r.cache_key),
        payload_json: String(r.payload_json),
        etag: r.etag === null || r.etag === undefined ? null : String(r.etag),
        fetched_at: Number(r.fetched_at),
      }))
    : [];

  const payload: ValidatedBackupPayload = {
    format: 'BIFROST1',
    schemaVersion: 1,
    exportedAt: nowSec,
    includeTelemetry: Boolean(exportUsage || exportSysLogs),
    users,
    invitations,
    userModelAccess,
    internalApiKeys,
    nodes,
    providers,
    providerKeys,
    models,
    usageLogs,
    systemLogs,
    externalCache,
  };

  const envelope = await packBifrostEnvelope(payload, password);

  writeSystemLog(
    db,
    'info',
    'backup',
    'Encrypted backup (.bifrost.enc) exported successfully',
    {
      exportedBy: actingUserId ?? null,
      providers: providers.length,
      providerKeys: providerKeys.length,
      users: users.length,
      nodes: nodes.length,
      includeTelemetry: payload.includeTelemetry,
      bytes: envelope.byteLength,
    },
    nowSec,
  );

  return envelope;
}

/**
 * HU-25b & Red-Team Hardening:
 * Validates and imports a `.bifrost.enc` (`BIFROST1`) backup atomically:
 * - Verifies password, AES-256-GCM auth tag, gzip bounds, prototype-pollution & schema keys.
 * - Re-encrypts `provider_keys.encrypted_secret` and `nodes.encrypted_token` with the
 *   destination server's `masterKey` BEFORE opening `BEGIN IMMEDIATE`.
 * - Restores nodes missing `raw_token` as `offline` (`encrypted_token = NULL`) and marks
 *   their assigned provider keys `no_node` (never falling back to Core IP egress!).
 * - Performs all SQLite writes in a single `BEGIN IMMEDIATE ... COMMIT` transaction.
 */
export async function importEncryptedBackup(
  options: ImportBackupOptions,
): Promise<BackupImportResult> {
  const {
    db,
    masterKey,
    envelope,
    password,
    schemasDir,
    actingUserId,
    maxUncompressedBytes = DEFAULT_MAX_UNCOMPRESSED_BACKUP_BYTES,
    nowSec = Math.floor(Date.now() / 1000),
  } = options;

  const rawJson = await unpackBifrostEnvelopeRaw(envelope, password, maxUncompressedBytes);
  const payload = validateBackupJsonPayload(rawJson, schemasDir);

  // Pre-compute all AES-256-GCM ciphertexts under the DESTINATION masterKey in memory
  const nodesMissingToken = new Set<string>();
  const preparedNodes = payload.nodes.map((node) => {
    const hasRawToken = typeof node.raw_token === 'string' && node.raw_token.length > 0;
    if (!hasRawToken) {
      nodesMissingToken.add(node.id);
      return {
        ...node,
        encryptedToken: null as Buffer | null,
        effectiveTokenHash: node.token_hash,
        effectiveStatus: 'offline' as const,
      };
    }
    return {
      ...node,
      encryptedToken: encryptSecret(node.raw_token!, masterKey),
      effectiveTokenHash: sha256Hex(node.raw_token!),
      effectiveStatus: node.status,
    };
  });

  const preparedProviderKeys = payload.providerKeys.map((pk) => {
    const encryptedSecret = encryptSecret(pk.secret, masterKey);
    const missingAssignedNodeToken =
      pk.node_id !== null && nodesMissingToken.has(pk.node_id);

    return {
      ...pk,
      encryptedSecret,
      effectiveStatus: missingAssignedNodeToken ? ('no_node' as const) : pk.status,
      effectiveLastError: missingAssignedNodeToken
        ? 'Assigned exit node token was not present in backup; rotate node token to resume.'
        : pk.last_error,
    };
  });

  db.exec('BEGIN IMMEDIATE');
  try {
    // 1. Users (4-step FK-safe swap on username collision so sessions, usage_logs & invitations never break)
    const upsertUserStmt = db.prepare(
      `INSERT INTO users (id, username, password_hash, role, daily_token_limit, quota_reset_mode, enforce_strict_quota, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         username = excluded.username,
         password_hash = excluded.password_hash,
         role = excluded.role,
         daily_token_limit = excluded.daily_token_limit,
         quota_reset_mode = excluded.quota_reset_mode,
         enforce_strict_quota = excluded.enforce_strict_quota,
         created_at = excluded.created_at`,
    );

    for (const u of payload.users) {
      const colliding = db
        .prepare(`SELECT id FROM users WHERE username = ? AND id != ?`)
        .get(u.username, u.id) as { id: string } | undefined;

      if (colliding) {
        db.prepare(`UPDATE users SET username = ? WHERE id = ?`).run(
          `__displaced_${colliding.id}`,
          colliding.id,
        );
      }

      upsertUserStmt.run(
        u.id,
        u.username,
        u.password_hash,
        u.role,
        u.daily_token_limit,
        u.quota_reset_mode,
        u.enforce_strict_quota === 0 ? 0 : 1,
        u.created_at,
      );

      if (colliding) {
        db.prepare(`UPDATE usage_logs SET user_id = ? WHERE user_id = ?`).run(
          u.id,
          colliding.id,
        );
        db.prepare(`UPDATE invitations SET created_by = ? WHERE created_by = ?`).run(
          u.id,
          colliding.id,
        );
        db.prepare(`UPDATE sessions SET user_id = ? WHERE user_id = ?`).run(
          u.id,
          colliding.id,
        );
        db.prepare(`DELETE FROM users WHERE id = ?`).run(colliding.id);
      }
    }

    // Resolve a valid fallback admin ID in case any imported invitation/usage_log references a missing user
    const fallbackAdminRow = db
      .prepare(
        `SELECT id FROM users ORDER BY CASE WHEN role = 'admin' THEN 0 ELSE 1 END ASC, created_at ASC LIMIT 1`,
      )
      .get() as { id: string } | undefined;
    const fallbackUserId = fallbackAdminRow?.id ?? actingUserId ?? null;

    const existingUserIds = new Set(
      (db.prepare(`SELECT id FROM users`).all() as Array<{ id: string }>).map((r) => r.id),
    );

    // 2. Nodes (with destination-masterKey re-encrypted tunnel tokens & pinned TLS fingerprints)
    const upsertNodeStmt = db.prepare(
      `INSERT INTO nodes (
         id, name, mode, endpoint, token_hash, encrypted_token, tls_fingerprint,
         prev_token_hash, prev_token_expires_at, last_seen_at, last_rotated_at, status, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         mode = excluded.mode,
         endpoint = excluded.endpoint,
         token_hash = excluded.token_hash,
         encrypted_token = excluded.encrypted_token,
         tls_fingerprint = excluded.tls_fingerprint,
         prev_token_hash = excluded.prev_token_hash,
         prev_token_expires_at = excluded.prev_token_expires_at,
         last_seen_at = excluded.last_seen_at,
         last_rotated_at = excluded.last_rotated_at,
         status = excluded.status,
         created_at = excluded.created_at`,
    );

    for (const node of preparedNodes) {
      upsertNodeStmt.run(
        node.id,
        node.name,
        node.mode,
        node.endpoint,
        node.effectiveTokenHash,
        node.encryptedToken,
        node.tls_fingerprint,
        node.prev_token_hash,
        node.prev_token_expires_at,
        node.last_seen_at,
        node.last_rotated_at,
        node.effectiveStatus,
        node.created_at,
      );
    }

    const existingNodeIds = new Set(
      (db.prepare(`SELECT id FROM nodes`).all() as Array<{ id: string }>).map((r) => r.id),
    );

    // 3. Providers
    const upsertProviderStmt = db.prepare(
      `INSERT INTO providers (
         id, name, package_type, models_source, schema_json, adapter_url,
         enabled, last_models_sync_at, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         package_type = excluded.package_type,
         models_source = excluded.models_source,
         schema_json = excluded.schema_json,
         adapter_url = excluded.adapter_url,
         enabled = excluded.enabled,
         last_models_sync_at = excluded.last_models_sync_at,
         created_at = excluded.created_at`,
    );

    for (const prov of payload.providers) {
      upsertProviderStmt.run(
        prov.id,
        prov.name,
        prov.package_type,
        prov.models_source,
        prov.schema_json,
        prov.adapter_url,
        prov.enabled,
        prov.last_models_sync_at,
        prov.created_at,
      );
    }

    const existingProviderIds = new Set(
      (db.prepare(`SELECT id FROM providers`).all() as Array<{ id: string }>).map(
        (r) => r.id,
      ),
    );

    // 4. Provider Keys (re-encrypted with destination masterKey)
    const upsertProviderKeyStmt = db.prepare(
      `INSERT INTO provider_keys (
         id, provider_id, label, encrypted_secret, last4, node_id, forced_node,
         daily_quota_limit, ratelimit_remaining, ratelimit_reset_at,
         status, last_error, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         provider_id = excluded.provider_id,
         label = excluded.label,
         encrypted_secret = excluded.encrypted_secret,
         last4 = excluded.last4,
         node_id = excluded.node_id,
         forced_node = excluded.forced_node,
         daily_quota_limit = excluded.daily_quota_limit,
         ratelimit_remaining = excluded.ratelimit_remaining,
         ratelimit_reset_at = excluded.ratelimit_reset_at,
         status = excluded.status,
         last_error = excluded.last_error,
         created_at = excluded.created_at`,
    );

    let restoredProviderKeysCount = 0;
    for (const pk of preparedProviderKeys) {
      if (!existingProviderIds.has(pk.provider_id)) {
        throw new BackupValidationError(
          `Invalid BIFROST1 payload: provider_key "${pk.id}" references missing provider "${pk.provider_id}".`,
        );
      }
      const hasMissingExternalNode =
        pk.node_id !== null && !existingNodeIds.has(pk.node_id);
      const resolvedNodeId = hasMissingExternalNode ? null : pk.node_id;
      const resolvedStatus = hasMissingExternalNode ? 'no_node' : pk.effectiveStatus;
      const resolvedError = hasMissingExternalNode
        ? `Assigned exit node "${pk.node_id}" was not present in backup.`
        : pk.effectiveLastError;

      upsertProviderKeyStmt.run(
        pk.id,
        pk.provider_id,
        pk.label,
        pk.encryptedSecret,
        pk.last4,
        resolvedNodeId,
        pk.forced_node,
        pk.daily_quota_limit,
        pk.ratelimit_remaining,
        pk.ratelimit_reset_at,
        resolvedStatus,
        resolvedError,
        pk.created_at,
      );
      restoredProviderKeysCount += 1;
    }

    // 5. Models
    const upsertModelStmt = db.prepare(
      `INSERT INTO models (
         full_id, provider_id, model_id, canonical_model_id, name,
         context_length, max_output, modalities_json, capabilities_json,
         is_free, first_seen_at, upstream_created_at, active
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(full_id) DO UPDATE SET
         provider_id = excluded.provider_id,
         model_id = excluded.model_id,
         canonical_model_id = excluded.canonical_model_id,
         name = excluded.name,
         context_length = excluded.context_length,
         max_output = excluded.max_output,
         modalities_json = excluded.modalities_json,
         capabilities_json = excluded.capabilities_json,
         is_free = excluded.is_free,
         first_seen_at = excluded.first_seen_at,
         upstream_created_at = excluded.upstream_created_at,
         active = excluded.active`,
    );

    let restoredModelsCount = 0;
    for (const m of payload.models) {
      if (!existingProviderIds.has(m.provider_id)) {
        throw new BackupValidationError(
          `Invalid BIFROST1 payload: model "${m.full_id}" references missing provider "${m.provider_id}".`,
        );
      }
      upsertModelStmt.run(
        m.full_id,
        m.provider_id,
        m.model_id,
        m.canonical_model_id,
        m.name,
        m.context_length,
        m.max_output,
        m.modalities_json,
        m.capabilities_json,
        m.is_free,
        m.first_seen_at,
        m.upstream_created_at,
        m.active,
      );
      restoredModelsCount += 1;
    }

    // 6. User Model Access
    for (const u of payload.users) {
      db.prepare(`DELETE FROM user_model_access WHERE user_id = ?`).run(u.id);
    }
    const insertAccessStmt = db.prepare(
      `INSERT OR IGNORE INTO user_model_access (user_id, model_full_id) VALUES (?, ?)`,
    );
    let restoredAccessCount = 0;
    for (const access of payload.userModelAccess) {
      if (!existingUserIds.has(access.user_id)) continue;
      insertAccessStmt.run(access.user_id, access.model_full_id);
      restoredAccessCount += 1;
    }

    // 7. Internal API Keys (`sk-bf-...` hashes)
    const upsertInternalKeyStmt = db.prepare(
      `INSERT INTO internal_api_keys (
         id, user_id, name, key_prefix, key_hash, last_used_at, revoked_at, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         user_id = excluded.user_id,
         name = excluded.name,
         key_prefix = excluded.key_prefix,
         key_hash = excluded.key_hash,
         last_used_at = excluded.last_used_at,
         revoked_at = excluded.revoked_at,
         created_at = excluded.created_at`,
    );
    let restoredInternalKeysCount = 0;
    for (const ik of payload.internalApiKeys) {
      if (!existingUserIds.has(ik.user_id)) continue;
      db.prepare(`DELETE FROM internal_api_keys WHERE key_hash = ? AND id != ?`).run(
        ik.key_hash,
        ik.id,
      );
      upsertInternalKeyStmt.run(
        ik.id,
        ik.user_id,
        ik.name,
        ik.key_prefix,
        ik.key_hash,
        ik.last_used_at,
        ik.revoked_at,
        ik.created_at,
      );
      restoredInternalKeysCount += 1;
    }

    // 8. Invitations
    const upsertInviteStmt = db.prepare(
      `INSERT INTO invitations (
         id, token_hash, daily_token_limit, quota_reset_mode, enforce_strict_quota, allowed_models_json,
         expires_at, used_at, created_by, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         token_hash = excluded.token_hash,
         daily_token_limit = excluded.daily_token_limit,
         quota_reset_mode = excluded.quota_reset_mode,
         enforce_strict_quota = excluded.enforce_strict_quota,
         allowed_models_json = excluded.allowed_models_json,
         expires_at = excluded.expires_at,
         used_at = excluded.used_at,
         created_by = excluded.created_by,
         created_at = excluded.created_at`,
    );
    let restoredInvitationsCount = 0;
    for (const inv of payload.invitations) {
      const creatorId = existingUserIds.has(inv.created_by)
        ? inv.created_by
        : fallbackUserId;
      if (!creatorId) continue;
      db.prepare(`DELETE FROM invitations WHERE token_hash = ? AND id != ?`).run(
        inv.token_hash,
        inv.id,
      );
      upsertInviteStmt.run(
        inv.id,
        inv.token_hash,
        inv.daily_token_limit,
        inv.quota_reset_mode,
        inv.enforce_strict_quota === 0 ? 0 : 1,
        inv.allowed_models_json,
        inv.expires_at,
        inv.used_at,
        creatorId,
        inv.created_at,
      );
      restoredInvitationsCount += 1;
    }

    // 9. Usage Logs, System Logs, and External Cache (when present)
    const upsertUsageLogStmt = db.prepare(
      `INSERT INTO usage_logs (
         id, user_id, provider_id, provider_key_id, model_full_id,
         prompt_tokens, completion_tokens, reasoning_tokens, cached_tokens,
         ttft_ms, duration_ms, tokens_per_sec, status, error_type, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         user_id = excluded.user_id,
         provider_id = excluded.provider_id,
         provider_key_id = excluded.provider_key_id,
         model_full_id = excluded.model_full_id,
         prompt_tokens = excluded.prompt_tokens,
         completion_tokens = excluded.completion_tokens,
         reasoning_tokens = excluded.reasoning_tokens,
         cached_tokens = excluded.cached_tokens,
         ttft_ms = excluded.ttft_ms,
         duration_ms = excluded.duration_ms,
         tokens_per_sec = excluded.tokens_per_sec,
         status = excluded.status,
         error_type = excluded.error_type,
         created_at = excluded.created_at`,
    );
    let restoredUsageLogsCount = 0;
    for (const ul of payload.usageLogs) {
      const resolvedUserId = existingUserIds.has(ul.user_id)
        ? ul.user_id
        : fallbackUserId;
      if (!resolvedUserId) continue;
      upsertUsageLogStmt.run(
        ul.id,
        resolvedUserId,
        ul.provider_id,
        ul.provider_key_id,
        ul.model_full_id,
        ul.prompt_tokens,
        ul.completion_tokens,
        ul.reasoning_tokens,
        ul.cached_tokens,
        ul.ttft_ms,
        ul.duration_ms,
        ul.tokens_per_sec,
        ul.status,
        ul.error_type,
        ul.created_at,
      );
      restoredUsageLogsCount += 1;
    }

    const upsertSystemLogStmt = db.prepare(
      `INSERT INTO system_logs (id, level, category, message, meta_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         level = excluded.level,
         category = excluded.category,
         message = excluded.message,
         meta_json = excluded.meta_json,
         created_at = excluded.created_at`,
    );
    for (const sl of payload.systemLogs) {
      upsertSystemLogStmt.run(
        sl.id,
        sl.level,
        sl.category,
        sl.message,
        sl.meta_json,
        sl.created_at,
      );
    }

    const upsertCacheStmt = db.prepare(
      `INSERT INTO external_cache (cache_key, payload_json, etag, fetched_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(cache_key) DO UPDATE SET
         payload_json = excluded.payload_json,
         etag = excluded.etag,
         fetched_at = excluded.fetched_at`,
    );
    for (const ec of payload.externalCache) {
      upsertCacheStmt.run(ec.cache_key, ec.payload_json, ec.etag, ec.fetched_at);
    }

    const restored: BackupRestoredCounts = {
      users: payload.users.length,
      invitations: restoredInvitationsCount,
      userModelAccess: restoredAccessCount,
      internalApiKeys: restoredInternalKeysCount,
      nodes: preparedNodes.length,
      providers: payload.providers.length,
      providerKeys: restoredProviderKeysCount,
      models: restoredModelsCount,
      usageLogs: restoredUsageLogsCount,
      systemLogs: payload.systemLogs.length,
      externalCache: payload.externalCache.length,
    };

    writeSystemLog(
      db,
      'info',
      'backup',
      'Encrypted backup (.bifrost.enc) imported and secrets re-encrypted with local master key',
      {
        restored,
        nodesMissingTokenCount: nodesMissingToken.size,
      },
      nowSec,
    );

    db.exec('COMMIT');

    return {
      ok: true,
      message: 'Encrypted backup imported and secrets re-encrypted successfully.',
      restored,
    };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

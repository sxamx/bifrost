import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const SCRYPT_MAXMEM = 32 * 1024 * 1024;
const SALT_BYTES = 16;

const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const MASTER_KEY_BYTES = 32;

export class MasterKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MasterKeyError';
  }
}

export interface ResolveMasterKeyOptions {
  dataDir?: string;
  envMasterKey?: string;
  dbFilename?: string;
  keyFilename?: string;
}

export interface ResolvedMasterKey {
  key: Buffer;
  source: 'env' | 'file' | 'generated';
  dataDir: string;
  keyPath: string;
  dbPath: string;
}

function parseEnvMasterKey(raw: string): Buffer {
  const trimmed = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, 'hex');
  }
  if (/^[A-Za-z0-9+/]{43}=$/.test(trimmed)) {
    const buf = Buffer.from(trimmed, 'base64');
    if (buf.length === MASTER_KEY_BYTES) {
      return buf;
    }
  }
  if (/^[A-Za-z0-9_-]{43}=?$/.test(trimmed)) {
    const buf = Buffer.from(trimmed, 'base64url');
    if (buf.length === MASTER_KEY_BYTES) {
      return buf;
    }
  }
  throw new MasterKeyError(
    'Invalid BIFROST_MASTER_KEY: expected 64 hex characters or base64-encoded 32 bytes.',
  );
}

/**
 * Resolves the 32-byte server master key (HU-01, HU-26).
 *
 * - Fresh install (neither bifrost.db nor master.key exists, BIFROST_MASTER_KEY unset):
 *   auto-generates a 32-byte random master.key with 0o600 permissions.
 * - Existing DB (bifrost.db already exists):
 *   NEVER regenerates master.key. Throws MasterKeyError if missing, unreadable, or not 32 bytes.
 */
export function resolveMasterKey(options: ResolveMasterKeyOptions = {}): ResolvedMasterKey {
  const dataDir = path.resolve(options.dataDir ?? process.env.DATA_DIR ?? './data');
  const dbPath = path.join(dataDir, options.dbFilename ?? 'bifrost.db');
  const keyPath = path.join(dataDir, options.keyFilename ?? 'master.key');
  const envKey =
    'envMasterKey' in options ? options.envMasterKey : process.env.BIFROST_MASTER_KEY;

  if (envKey !== undefined && envKey !== '') {
    const key = parseEnvMasterKey(envKey);
    fs.mkdirSync(dataDir, { recursive: true });
    return { key, source: 'env', dataDir, keyPath, dbPath };
  }

  const dbExists = fs.existsSync(dbPath);
  const keyExists = fs.existsSync(keyPath);

  if (!dbExists && !keyExists) {
    fs.mkdirSync(dataDir, { recursive: true });
    const key = randomBytes(MASTER_KEY_BYTES);
    fs.writeFileSync(keyPath, key, { mode: 0o600 });
    fs.chmodSync(keyPath, 0o600);
    return { key, source: 'generated', dataDir, keyPath, dbPath };
  }

  if (dbExists && !keyExists) {
    throw new MasterKeyError(
      `Database already exists at "${dbPath}", but master key is missing at "${keyPath}" (and BIFROST_MASTER_KEY is not set). Aborting startup instead of generating a new master key.`,
    );
  }

  let keyBuf: Buffer;
  try {
    keyBuf = fs.readFileSync(keyPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new MasterKeyError(`Failed to read master key at "${keyPath}": ${msg}`);
  }

  if (keyBuf.length !== MASTER_KEY_BYTES) {
    throw new MasterKeyError(
      `Invalid master key at "${keyPath}": expected exactly ${MASTER_KEY_BYTES} bytes, got ${keyBuf.length} bytes.`,
    );
  }

  return { key: keyBuf, source: 'file', dataDir, keyPath, dbPath };
}

export function loadMasterKeyOrExit(options: ResolveMasterKeyOptions = {}): ResolvedMasterKey {
  try {
    return resolveMasterKey(options);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[Bifrost FATAL] ${msg}\n`);
    process.exit(1);
  }
}

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

function scryptAsync(
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const derived = await scryptAsync(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const parts = storedHash.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') {
    return false;
  }
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const saltHex = parts[4];
  const expectedHex = parts[5];

  if (
    !Number.isInteger(N) ||
    !Number.isInteger(r) ||
    !Number.isInteger(p) ||
    N <= 1 ||
    r <= 0 ||
    p <= 0 ||
    !saltHex ||
    !expectedHex
  ) {
    return false;
  }

  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(expectedHex, 'hex');
  if (salt.length === 0 || expected.length === 0) {
    return false;
  }

  try {
    const derived = await scryptAsync(password, salt, expected.length, {
      N,
      r,
      p,
      maxmem: SCRYPT_MAXMEM,
    });
    if (derived.length !== expected.length) {
      return false;
    }
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/**
 * Encrypts a secret with AES-256-GCM using masterKey.
 * Wire layout: 12-byte IV || 16-byte auth tag || ciphertext
 */
export function encryptSecret(plaintext: string | Buffer, masterKey: Buffer): Buffer {
  if (masterKey.length !== MASTER_KEY_BYTES) {
    throw new Error(`Master key must be ${MASTER_KEY_BYTES} bytes.`);
  }
  const iv = randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', masterKey, iv, {
    authTagLength: GCM_TAG_BYTES,
  });
  const input = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext;
  const ciphertext = Buffer.concat([cipher.update(input), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]);
}

/**
 * Decrypts an AES-256-GCM blob produced by encryptSecret.
 */
export function decryptSecret(blob: Buffer | Uint8Array, masterKey: Buffer): string {
  if (masterKey.length !== MASTER_KEY_BYTES) {
    throw new Error(`Master key must be ${MASTER_KEY_BYTES} bytes.`);
  }
  const buf = Buffer.isBuffer(blob)
    ? blob
    : Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength);
  if (buf.length < GCM_IV_BYTES + GCM_TAG_BYTES) {
    throw new Error('Encrypted secret payload is too short.');
  }
  const iv = buf.subarray(0, GCM_IV_BYTES);
  const authTag = buf.subarray(GCM_IV_BYTES, GCM_IV_BYTES + GCM_TAG_BYTES);
  const ciphertext = buf.subarray(GCM_IV_BYTES + GCM_TAG_BYTES);

  const decipher = createDecipheriv('aes-256-gcm', masterKey, iv, {
    authTagLength: GCM_TAG_BYTES,
  });
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString('utf8');
}

export interface GeneratedInternalApiKey {
  rawKey: string;
  keyPrefix: string;
  keyHash: string;
}

export function generateInternalApiKey(): GeneratedInternalApiKey {
  const rawKey = `sk-bf-${randomBytes(32).toString('base64url')}`;
  const keyPrefix = rawKey.slice(0, 12);
  const keyHash = sha256Hex(rawKey);
  return { rawKey, keyPrefix, keyHash };
}

export interface GeneratedSessionToken {
  token: string;
  tokenHash: string;
}

export function generateSessionToken(): GeneratedSessionToken {
  const token = randomBytes(32).toString('base64url');
  const tokenHash = sha256Hex(token);
  return { token, tokenHash };
}

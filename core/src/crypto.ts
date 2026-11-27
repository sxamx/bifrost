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

const MIN_SCRYPT_N = 16384;
const MAX_SCRYPT_N = 65536;
const MIN_SCRYPT_R = 1;
const MAX_SCRYPT_R = 16;
const MIN_SCRYPT_P = 1;
const MAX_SCRYPT_P = 4;
const MIN_SCRYPT_SALT_BYTES = 16;
const MAX_SCRYPT_SALT_BYTES = 64;
const MIN_SCRYPT_HASH_BYTES = 32;
const MAX_SCRYPT_HASH_BYTES = 128;
const STRICT_UINT_RE = /^[0-9]+$/;
const STRICT_HEX_RE = /^[0-9a-fA-F]+$/;

export const MAX_USERNAME_LENGTH = 64;
export const MAX_PASSWORD_LENGTH = 1024;

/**
 * Valid precomputed scrypt hash (N=16384, r=8, p=1, 16-byte salt, 64-byte derived key)
 * used on unknown usernames during login to equalize verification latency and mitigate
 * user-enumeration timing oracles (SEC-15).
 */
export const DUMMY_SCRYPT_HASH =
  'scrypt$16384$8$1$0123456789abcdef0123456789abcdef$' +
  '0000000000000000000000000000000000000000000000000000000000000000' +
  '0000000000000000000000000000000000000000000000000000000000000000';

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
  envMasterKeyFile?: string;
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

function parseEnvMasterKey(raw: string, sourceName = 'BIFROST_MASTER_KEY'): Buffer {
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
    `Invalid ${sourceName}: expected 64 hex characters or base64-encoded 32 bytes.`,
  );
}

/**
 * Resolves the 32-byte server master key (HU-01, HU-26, BF-06).
 *
 * - BIFROST_MASTER_KEY_FILE (Docker Secrets): reads trimmed hex/base64 32-byte key from file.
 *   Never falls back to generating a new key if the file is unreadable or malformed.
 * - BIFROST_MASTER_KEY: parses hex/base64 32-byte key from env.
 * - Fresh install (neither bifrost.db/-wal/-shm nor master.key exists):
 *   auto-generates a 32-byte random master.key atomically with `{ flag: 'wx', mode: 0o600 }`.
 * - Existing DB (bifrost.db, -wal, or -shm already exists):
 *   NEVER regenerates master.key. Throws MasterKeyError if missing, unreadable, or not 32 bytes.
 */
export function resolveMasterKey(options: ResolveMasterKeyOptions = {}): ResolvedMasterKey {
  const dataDir = path.resolve(options.dataDir ?? process.env.DATA_DIR ?? './data');
  const dbPath = path.join(dataDir, options.dbFilename ?? 'bifrost.db');
  const keyPath = path.join(dataDir, options.keyFilename ?? 'master.key');
  const hasExplicitEnvMasterKey =
    'envMasterKey' in options &&
    options.envMasterKey !== undefined &&
    options.envMasterKey !== '';
  const envKeyFile =
    'envMasterKeyFile' in options
      ? options.envMasterKeyFile
      : hasExplicitEnvMasterKey
        ? undefined
        : process.env.BIFROST_MASTER_KEY_FILE;
  const envKey =
    'envMasterKey' in options ? options.envMasterKey : process.env.BIFROST_MASTER_KEY;

  if (envKeyFile !== undefined && envKeyFile.trim() !== '') {
    const secretFilePath = path.resolve(envKeyFile.trim());
    let rawSecretText: string;
    try {
      rawSecretText = fs.readFileSync(secretFilePath, 'utf8');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new MasterKeyError(
        `Failed to read BIFROST_MASTER_KEY_FILE at "${secretFilePath}": ${msg}`,
      );
    }
    const key = parseEnvMasterKey(rawSecretText, 'BIFROST_MASTER_KEY_FILE');
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    return { key, source: 'file', dataDir, keyPath: secretFilePath, dbPath };
  }

  if (envKey !== undefined && envKey !== '') {
    const key = parseEnvMasterKey(envKey, 'BIFROST_MASTER_KEY');
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    return { key, source: 'env', dataDir, keyPath, dbPath };
  }

  const dbExists =
    fs.existsSync(dbPath) ||
    fs.existsSync(`${dbPath}-wal`) ||
    fs.existsSync(`${dbPath}-shm`);
  const keyExists = fs.existsSync(keyPath);

  if (!dbExists && !keyExists) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const key = randomBytes(MASTER_KEY_BYTES);
    try {
      fs.writeFileSync(keyPath, key, { flag: 'wx', mode: 0o600 });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'EEXIST') {
        throw new MasterKeyError(
          `Master key already exists at "${keyPath}" (concurrent creation detected). Aborting startup instead of overwriting.`,
        );
      }
      const msg = err instanceof Error ? err.message : String(err);
      throw new MasterKeyError(`Failed to write master key at "${keyPath}": ${msg}`);
    }
    try {
      fs.chmodSync(keyPath, 0o600);
    } catch {
      // Best-effort on platforms without POSIX chmod bits
    }
    return { key, source: 'generated', dataDir, keyPath, dbPath };
  }

  if (dbExists && !keyExists) {
    throw new MasterKeyError(
      `Database already exists at "${dbPath}" (or WAL/SHM artifacts are present), but master key is missing at "${keyPath}" (and BIFROST_MASTER_KEY / BIFROST_MASTER_KEY_FILE is not set). Aborting startup instead of generating a new master key.`,
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
  if (
    typeof password !== 'string' ||
    typeof storedHash !== 'string' ||
    password.length > MAX_PASSWORD_LENGTH
  ) {
    return false;
  }

  const parts = storedHash.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') {
    return false;
  }

  const [, rawN, rawR, rawP, saltHex, expectedHex] = parts;
  if (
    !rawN ||
    !rawR ||
    !rawP ||
    !saltHex ||
    !expectedHex ||
    !STRICT_UINT_RE.test(rawN) ||
    !STRICT_UINT_RE.test(rawR) ||
    !STRICT_UINT_RE.test(rawP)
  ) {
    return false;
  }

  const N = Number(rawN);
  const r = Number(rawR);
  const p = Number(rawP);

  // Strict scrypt bounds to prevent CPU/memory DoS (SEC-04 / DEEP-13):
  // N must be a power of 2 in [16384, 65536], r in [1, 16], p in [1, 4].
  if (
    !Number.isSafeInteger(N) ||
    !Number.isSafeInteger(r) ||
    !Number.isSafeInteger(p) ||
    N < MIN_SCRYPT_N ||
    N > MAX_SCRYPT_N ||
    (N & (N - 1)) !== 0 ||
    r < MIN_SCRYPT_R ||
    r > MAX_SCRYPT_R ||
    p < MIN_SCRYPT_P ||
    p > MAX_SCRYPT_P
  ) {
    return false;
  }

  if (
    saltHex.length % 2 !== 0 ||
    expectedHex.length % 2 !== 0 ||
    !STRICT_HEX_RE.test(saltHex) ||
    !STRICT_HEX_RE.test(expectedHex)
  ) {
    return false;
  }

  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(expectedHex, 'hex');
  if (
    salt.length < MIN_SCRYPT_SALT_BYTES ||
    salt.length > MAX_SCRYPT_SALT_BYTES ||
    expected.length < MIN_SCRYPT_HASH_BYTES ||
    expected.length > MAX_SCRYPT_HASH_BYTES
  ) {
    return false;
  }

  // OpenSSL requires maxmem strictly larger than 128 * N * r.
  // Since N <= 65536 and r <= 16, this is bounded safely below 136 MiB.
  const requiredMem = 128 * N * r;
  const maxmem = Math.max(SCRYPT_MAXMEM, requiredMem + 1024 * 1024);

  try {
    const derived = await scryptAsync(password, salt, expected.length, {
      N,
      r,
      p,
      maxmem,
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
